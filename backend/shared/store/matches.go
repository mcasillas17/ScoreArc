package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// MatchIdentity is the canonical identity a resolver produced for one provider
// match. It travels alongside model.Match, which stays provider-shaped: the
// store never reads an id out of the model, only out of this struct.
type MatchIdentity struct {
	MatchID          uuid.UUID
	CompetitionID    string
	SeasonID         string
	HomeTeamID       string
	AwayTeamID       string
	HomeTeamSourceID string
	AwayTeamSourceID string
	WinnerTeamID     *string
	Source           string
}

// MatchRow is the stored state of a match, in canonical space: every id on it
// is a ScoreArc id, never a provider one.
type MatchRow struct {
	State           model.MatchState
	FinalizedAt     pgtype.Timestamptz
	HasDetail       bool
	Round           string
	BracketRequired *bool
	WinnerID        *string
	Note            *string
	Home            model.Team
	Away            model.Team
	HomePlaceholder bool
	AwayPlaceholder bool
	// The remaining six are the columns matchUpsertSQL writes that were not
	// already above -- added so the ingester's no-op guard (design doc §4.2)
	// can tell a genuine change from a redundant write. source is deliberately
	// absent: every write in this process carries the same sourceESPN
	// constant, so comparing it could never produce a false "unchanged".
	Kickoff      time.Time
	HomeScore    *int
	AwayScore    *int
	Minute       *string
	StatusDetail string
	StatusName   string
}

// matchUpsertSQL is an UPDATE, not an upsert: the resolver INSERTs the row when
// it mints the canonical id, so by the time facts are written the row exists.
// The WHERE clause carries the same two guards the old ON CONFLICT ... WHERE
// did — a finalized match is immutable, and state never regresses — and, as
// before, a blocked write affects zero rows rather than raising.
const matchUpsertSQL = `
UPDATE match SET
	round = CASE
		WHEN $16 AND $15 IS FALSE THEN NULL
		ELSE COALESCE(NULLIF($2, ''), match.round)
	END,
	kickoff = $3::timestamptz,
	state = $4,
	home_team_id = $5,
	away_team_id = $6,
	home_score = COALESCE($7, match.home_score),
	away_score = COALESCE($8, match.away_score),
	minute = $9,
	status_detail = $10,
	status_name = $11,
	winner_id = CASE WHEN $16 THEN $12 ELSE COALESCE($12, match.winner_id) END,
	note = COALESCE($13, match.note),
	-- A payload that is not bracket-confirmed may SET a placeholder but never
	-- CLEAR one for the same team: the scoreboard has no idea a leg is still
	-- unresolved, so its silence is not evidence. Preserving the stored value
	-- unconditionally would be wrong now that the resolver INSERTs the row
	-- first — the very first fact write is an UPDATE against a default of
	-- false, and would drop the flag permanently.
	home_placeholder = CASE
		WHEN NOT $16 AND match.home_team_id = $5 AND match.home_placeholder THEN true
		ELSE $14
	END,
	away_placeholder = CASE
		WHEN NOT $16 AND match.away_team_id = $6 AND match.away_placeholder THEN true
		ELSE $17
	END,
	bracket_required = CASE
		WHEN $16 THEN $15
		WHEN match.bracket_required IS TRUE THEN true
		ELSE COALESCE($15, match.bracket_required)
	END,
	source = $18,
	updated_at = now()
WHERE match.id = $1
	AND match.finalized_at IS NULL
	AND NOT (
		(match.state = 'live' AND $4 = 'scheduled'
			AND $11 NOT IN ('STATUS_POSTPONED', 'STATUS_SUSPENDED'))
		OR (match.state = 'finished' AND $4 <> 'finished')
	)`

// UpsertMatch writes the current facts onto the canonical match the resolver
// already created. Every id it writes comes from identity; model.Match's own
// Home.ID/Away.ID/WinnerID are ignored precisely because they may be provider
// ids.
//
// Zero rows updated has two very different meanings and they must not be
// conflated. A GUARD rejection — the match is finalized, or the write would
// regress its state — is normal operation and returns nil: that is the WHERE
// clause doing its job, and the caller has nothing to fix. A MISSING row is a
// fault: the resolver inserts the match before any fact write, so an id nothing
// owns means the write went nowhere and reporting success would hide it.
func (s *Store) UpsertMatch(ctx context.Context, identity MatchIdentity, match model.Match) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	command, err := s.pool.Exec(ctx, matchUpsertSQL, matchArgs(identity, match)...)
	if err != nil {
		return err
	}
	if command.RowsAffected() > 0 {
		return nil
	}
	// Only reached when nothing was written, so the extra round trip costs
	// nothing in the normal path.
	var exists bool
	err = s.pool.QueryRow(ctx, `SELECT true FROM match WHERE id=$1`, identity.MatchID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: %s", ErrMatchMissing, identity.MatchID)
	}
	return err
}

func matchArgs(identity MatchIdentity, match model.Match) []any {
	var round any
	if match.Round != "" {
		round = match.Round
	}
	return []any{
		identity.MatchID, round, match.Kickoff, string(match.State),
		identity.HomeTeamID, identity.AwayTeamID,
		match.HomeScore, match.AwayScore, match.Minute,
		match.StatusDetail, match.StatusName, identity.WinnerTeamID, match.Note,
		match.HomePlaceholder, match.BracketRequired, match.BracketConfirmed,
		match.AwayPlaceholder, identity.Source,
	}
}

const detailUpsertSQL = `
INSERT INTO match_detail (
	match_id, scorers, cards, stats, win_probability, shootout,
	shootout_detail, lineups, videos, info, form, h2h, commentary, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
ON CONFLICT (match_id) DO UPDATE SET
	scorers=CASE WHEN EXCLUDED.scorers='[]'::jsonb THEN match_detail.scorers ELSE EXCLUDED.scorers END,
	cards=CASE WHEN EXCLUDED.cards='[]'::jsonb THEN match_detail.cards ELSE EXCLUDED.cards END,
	stats=COALESCE(EXCLUDED.stats, match_detail.stats),
	win_probability=COALESCE(EXCLUDED.win_probability, match_detail.win_probability),
	shootout=COALESCE(EXCLUDED.shootout, match_detail.shootout),
	shootout_detail=COALESCE(EXCLUDED.shootout_detail, match_detail.shootout_detail),
	lineups=COALESCE(EXCLUDED.lineups, match_detail.lineups),
	videos=CASE WHEN EXCLUDED.videos='[]'::jsonb THEN match_detail.videos ELSE EXCLUDED.videos END,
	info=COALESCE(EXCLUDED.info, match_detail.info),
	form=COALESCE(EXCLUDED.form, match_detail.form),
	h2h=CASE WHEN EXCLUDED.h2h='[]'::jsonb THEN match_detail.h2h ELSE EXCLUDED.h2h END,
	commentary=CASE WHEN EXCLUDED.commentary='[]'::jsonb THEN match_detail.commentary ELSE EXCLUDED.commentary END,
	updated_at=now()`

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (s *Store) UpsertMatchDetail(ctx context.Context, matchID uuid.UUID, detail model.MatchDetail) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var finalizedAt pgtype.Timestamptz
	if err := tx.QueryRow(ctx,
		`SELECT finalized_at FROM match WHERE id=$1 FOR UPDATE`, matchID,
	).Scan(&finalizedAt); err != nil {
		return err
	}
	if finalizedAt.Valid {
		return ErrMatchFinalized
	}
	if err := upsertMatchDetail(ctx, tx, matchID, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func upsertMatchDetail(ctx context.Context, db execer, matchID uuid.UUID, detail model.MatchDetail) error {
	values, err := detailArgs(matchID, detail)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, detailUpsertSQL, values...)
	return err
}

func detailArgs(matchID uuid.UUID, detail model.MatchDetail) ([]any, error) {
	values := []any{matchID}
	for _, value := range []struct {
		value any
		array bool
	}{
		{detail.Scorers, true},
		{detail.Cards, true},
		{detail.Stats, false},
		{detail.WinProbability, false},
		{detail.Shootout, false},
		{detail.ShootoutDetail, false},
		{detail.Lineups, false},
		{detail.Videos, true},
		{detail.Info, false},
		{detail.Form, false},
		{detail.H2H, true},
		{detail.Commentary, true},
	} {
		encoded, err := jsonValue(value.value, value.array)
		if err != nil {
			return nil, err
		}
		values = append(values, encoded)
	}
	return values, nil
}

func jsonValue(value any, array bool) (any, error) {
	rv := reflect.ValueOf(value)
	if !rv.IsValid() || (rv.Kind() == reflect.Ptr && rv.IsNil()) {
		if array {
			return "[]", nil
		}
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal match detail: %w", err)
	}
	if array && string(raw) == "null" {
		return "[]", nil
	}
	return string(raw), nil
}

// FinalizeMatch freezes a finished match and its detail in one transaction.
// competition and season are NOT written here: the resolver owns them, and a
// match cannot change competition without becoming a different match.
func (s *Store) FinalizeMatch(
	ctx context.Context,
	identity MatchIdentity,
	match model.Match,
	detail model.MatchDetail,
) (bool, error) {
	if match.State != model.MatchStateFinished {
		return false, fmt.Errorf("cannot finalize match %q in state %q", match.ID, match.State)
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	var finalizedAt pgtype.Timestamptz
	if err := tx.QueryRow(ctx,
		`SELECT finalized_at FROM match WHERE id=$1 FOR UPDATE`,
		identity.MatchID,
	).Scan(&finalizedAt); err != nil {
		return false, err
	}
	if finalizedAt.Valid {
		return false, nil
	}
	if err := upsertMatchDetail(ctx, tx, identity.MatchID, detail); err != nil {
		return false, err
	}

	var round any
	if match.Round != "" {
		round = match.Round
	}
	args := []any{
		identity.MatchID, round, match.Kickoff, string(match.State),
		identity.HomeTeamID, identity.AwayTeamID, match.HomeScore, match.AwayScore,
		match.Minute, match.StatusDetail, match.StatusName, identity.WinnerTeamID,
		match.Note, match.HomePlaceholder, match.BracketRequired, match.BracketConfirmed,
		match.AwayPlaceholder, identity.Source,
	}
	command, err := tx.Exec(ctx, `
UPDATE match SET
	round=CASE
		WHEN $16 AND $15 IS FALSE THEN NULL
		ELSE COALESCE(NULLIF($2, ''), round)
	END,
	kickoff=$3::timestamptz, state=$4, home_team_id=$5, away_team_id=$6,
	home_score=COALESCE($7, home_score), away_score=COALESCE($8, away_score),
	minute=$9, status_detail=$10, status_name=$11,
	winner_id=CASE WHEN $16 THEN $12 ELSE COALESCE($12, winner_id) END,
	note=COALESCE($13, note),
	home_placeholder=CASE
		WHEN NOT $16 AND home_team_id=$5 AND home_placeholder THEN true ELSE $14 END,
	away_placeholder=CASE
		WHEN NOT $16 AND away_team_id=$6 AND away_placeholder THEN true ELSE $17 END,
	bracket_required=CASE
		WHEN $16 THEN $15
		WHEN bracket_required IS TRUE THEN true
		ELSE COALESCE($15, bracket_required)
	END,
	source=$18, finalized_at=now(), updated_at=now()
WHERE id=$1 AND state='finished' AND finalized_at IS NULL`, args...)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ExistingMatches reads the stored state of the given canonical matches. Both
// the ids passed in and the map returned are canonical.
func (s *Store) ExistingMatches(
	ctx context.Context,
	competitionID, seasonID string,
	ids []uuid.UUID,
) (map[uuid.UUID]MatchRow, error) {
	if len(ids) == 0 {
		return map[uuid.UUID]MatchRow{}, nil
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.state, m.finalized_at, d.match_id IS NOT NULL,
	COALESCE(m.round, ''), m.bracket_required, m.winner_id, m.note,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url,
	m.home_placeholder, m.away_placeholder,
	m.kickoff, m.home_score, m.away_score, m.minute, m.status_detail, m.status_name
FROM match m
LEFT JOIN match_detail d ON d.match_id=m.id
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.competition_id=$1 AND m.season_id=$2 AND m.id=ANY($3)`,
		competitionID, seasonID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[uuid.UUID]MatchRow)
	for rows.Next() {
		var id uuid.UUID
		var row MatchRow
		if err := rows.Scan(
			&id, &row.State, &row.FinalizedAt, &row.HasDetail,
			&row.Round, &row.BracketRequired, &row.WinnerID, &row.Note,
			&row.Home.ID, &row.Home.Name, &row.Home.Abbr, &row.Home.CrestURL,
			&row.Away.ID, &row.Away.Name, &row.Away.Abbr, &row.Away.CrestURL,
			&row.HomePlaceholder, &row.AwayPlaceholder,
			&row.Kickoff, &row.HomeScore, &row.AwayScore,
			&row.Minute, &row.StatusDetail, &row.StatusName,
		); err != nil {
			return nil, err
		}
		result[id] = row
	}
	return result, rows.Err()
}

// unfinalizedMatchesSQL reads the finalization backlog back out in the SHAPE A
// PROVIDER WOULD HAVE SENT IT: provider match id, provider team ids, provider
// winner id. That is deliberate. These rows re-enter the ingest pipeline beside
// live scoreboard rows — they are merged with them by id, and the summary fetch
// that finalizes them addresses the provider's API. Returning canonical ids here
// would fork every backlog match into a second candidate and then ask ESPN for a
// match id ESPN has never heard of.
//
// Each crosswalk lookup is a LATERAL ... LIMIT 1 rather than a plain join
// because (source, source_id) is the crosswalk's key: MANY source ids may point
// at one canonical entity once duplicates are merged, and a plain join would
// multiply the result set by that many.
const unfinalizedMatchesSQL = `
SELECT ref.source_id, m.kickoff, m.state, COALESCE(m.round, ''), m.minute,
	m.status_detail, m.status_name, m.home_score, m.away_score, winner_ref.source_id,
	m.note, m.home_placeholder, m.away_placeholder, m.bracket_required,
	home_ref.source_id, home.name, home.abbr, home.crest_url,
	away_ref.source_id, away.name, away.abbr, away.crest_url
FROM match m
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
JOIN LATERAL (
	SELECT r.source_id FROM match_external_ref r
	WHERE r.match_id=m.id AND r.source=$3
	ORDER BY r.first_seen_at, r.source_id LIMIT 1) ref ON true
JOIN LATERAL (
	SELECT r.source_id FROM team_external_ref r
	WHERE r.team_id=m.home_team_id AND r.source=$3
	ORDER BY r.first_seen_at, r.source_id LIMIT 1) home_ref ON true
JOIN LATERAL (
	SELECT r.source_id FROM team_external_ref r
	WHERE r.team_id=m.away_team_id AND r.source=$3
	ORDER BY r.first_seen_at, r.source_id LIMIT 1) away_ref ON true
LEFT JOIN LATERAL (
	SELECT r.source_id FROM team_external_ref r
	WHERE r.team_id=m.winner_id AND r.source=$3
	ORDER BY r.first_seen_at, r.source_id LIMIT 1) winner_ref ON true
WHERE m.competition_id=$1 AND m.season_id=$2
	AND m.state='finished' AND m.finalized_at IS NULL
ORDER BY m.updated_at, m.id
LIMIT 500`

// UnfinalizedMatches returns the given source's view of matches that finished
// but were never frozen, so a later cycle can retry the summary fetch.
func (s *Store) UnfinalizedMatches(
	ctx context.Context,
	competitionID, seasonID, source string,
) ([]model.Match, error) {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, unfinalizedMatchesSQL, competitionID, seasonID, source)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var matches []model.Match
	for rows.Next() {
		var match model.Match
		var kickoff time.Time
		if err := rows.Scan(
			&match.ID, &kickoff, &match.State, &match.Round, &match.Minute,
			&match.StatusDetail, &match.StatusName, &match.HomeScore, &match.AwayScore,
			&match.WinnerID, &match.Note, &match.HomePlaceholder, &match.AwayPlaceholder,
			&match.BracketRequired,
			&match.Home.ID, &match.Home.Name, &match.Home.Abbr, &match.Home.CrestURL,
			&match.Away.ID, &match.Away.Name, &match.Away.Abbr, &match.Away.CrestURL,
		); err != nil {
			return nil, err
		}
		match.Kickoff = kickoff.UTC().Format(time.RFC3339)
		matches = append(matches, match)
	}
	return matches, rows.Err()
}

var _ execer = (pgx.Tx)(nil)
