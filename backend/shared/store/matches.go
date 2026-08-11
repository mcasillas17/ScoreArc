package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

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
}

const matchUpsertSQL = `
INSERT INTO match (
	id, comp_id, season_id, round, kickoff, state,
	home_team_id, away_team_id, home_score, away_score,
	minute, status_detail, status_name, winner_id, note,
	home_placeholder, away_placeholder, bracket_required, updated_at)
VALUES (
	$1, $2, $3, $4, $5::timestamptz, $6,
	$7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
ON CONFLICT (id) DO UPDATE SET
	comp_id = EXCLUDED.comp_id,
	season_id = EXCLUDED.season_id,
	round = CASE
		WHEN $19 AND EXCLUDED.bracket_required IS FALSE THEN NULL
		ELSE COALESCE(NULLIF(EXCLUDED.round, ''), match.round)
	END,
	kickoff = EXCLUDED.kickoff,
	state = EXCLUDED.state,
	home_team_id = EXCLUDED.home_team_id,
	away_team_id = EXCLUDED.away_team_id,
	home_score = COALESCE(EXCLUDED.home_score, match.home_score),
	away_score = COALESCE(EXCLUDED.away_score, match.away_score),
	minute = EXCLUDED.minute,
	status_detail = EXCLUDED.status_detail,
	status_name = EXCLUDED.status_name,
	winner_id = CASE
		WHEN $19 THEN EXCLUDED.winner_id
		ELSE COALESCE(EXCLUDED.winner_id, match.winner_id)
	END,
	note = COALESCE(EXCLUDED.note, match.note),
	home_placeholder = CASE
		WHEN NOT $19 AND match.home_team_id = EXCLUDED.home_team_id
		THEN match.home_placeholder
		ELSE EXCLUDED.home_placeholder
	END,
	away_placeholder = CASE
		WHEN NOT $19 AND match.away_team_id = EXCLUDED.away_team_id
		THEN match.away_placeholder
		ELSE EXCLUDED.away_placeholder
	END,
	bracket_required = CASE
		WHEN $19 THEN EXCLUDED.bracket_required
		WHEN match.bracket_required IS TRUE THEN true
		ELSE COALESCE(EXCLUDED.bracket_required, match.bracket_required)
	END,
	updated_at = now()
WHERE match.finalized_at IS NULL
	AND NOT (
		(match.state = 'live' AND EXCLUDED.state = 'scheduled'
			AND EXCLUDED.status_name NOT IN ('STATUS_POSTPONED', 'STATUS_SUSPENDED'))
		OR (match.state = 'finished' AND EXCLUDED.state <> 'finished')
	)`

func (s *Store) UpsertMatch(ctx context.Context, compID, seasonID string, match model.Match) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, matchUpsertSQL, matchArgs(compID, seasonID, match)...)
	return err
}

func matchArgs(compID, seasonID string, match model.Match) []any {
	var round any
	if match.Round != "" {
		round = match.Round
	}
	return []any{
		match.ID, compID, seasonID, round, match.Kickoff, string(match.State),
		match.Home.ID, match.Away.ID, match.HomeScore, match.AwayScore,
		match.Minute, match.StatusDetail, match.StatusName, match.WinnerID, match.Note,
		match.HomePlaceholder, match.AwayPlaceholder, match.BracketRequired,
		match.BracketConfirmed,
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

func (s *Store) UpsertMatchDetail(ctx context.Context, matchID string, detail model.MatchDetail) error {
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

func upsertMatchDetail(ctx context.Context, db execer, matchID string, detail model.MatchDetail) error {
	values, err := detailArgs(matchID, detail)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, detailUpsertSQL, values...)
	return err
}

func detailArgs(matchID string, detail model.MatchDetail) ([]any, error) {
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

func (s *Store) FinalizeMatch(
	ctx context.Context,
	compID, seasonID string,
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
		`SELECT finalized_at FROM match
		 WHERE id=$1 AND comp_id=$2 AND season_id=$3
		 FOR UPDATE`,
		match.ID, compID, seasonID,
	).Scan(&finalizedAt); err != nil {
		return false, err
	}
	if finalizedAt.Valid {
		return false, nil
	}
	if err := upsertMatchDetail(ctx, tx, match.ID, detail); err != nil {
		return false, err
	}

	var round any
	if match.Round != "" {
		round = match.Round
	}
	args := []any{
		compID, seasonID, round, match.Kickoff, string(match.State),
		match.Home.ID, match.Away.ID, match.HomeScore, match.AwayScore,
		match.Minute, match.StatusDetail, match.StatusName, match.WinnerID,
		match.Note, match.HomePlaceholder, match.AwayPlaceholder, match.BracketRequired,
		match.ID, match.BracketConfirmed,
	}
	command, err := tx.Exec(ctx, `
UPDATE match SET
	comp_id=$1, season_id=$2, round=CASE
		WHEN $19 AND $17 IS FALSE THEN NULL
		ELSE COALESCE(NULLIF($3, ''), round)
	END,
	kickoff=$4::timestamptz, state=$5, home_team_id=$6, away_team_id=$7,
	home_score=COALESCE($8, home_score), away_score=COALESCE($9, away_score),
	minute=$10, status_detail=$11, status_name=$12,
	winner_id=CASE WHEN $19 THEN $13 ELSE COALESCE($13, winner_id) END,
	note=COALESCE($14, note),
	home_placeholder=CASE
		WHEN NOT $19 AND home_team_id=$6 THEN home_placeholder ELSE $15 END,
	away_placeholder=CASE
		WHEN NOT $19 AND away_team_id=$7 THEN away_placeholder ELSE $16 END,
	bracket_required=CASE
		WHEN $19 THEN $17
		WHEN bracket_required IS TRUE THEN true
		ELSE COALESCE($17, bracket_required)
	END,
	finalized_at=now(), updated_at=now()
WHERE id=$18 AND comp_id=$1 AND season_id=$2
	AND state='finished' AND finalized_at IS NULL`, args...)
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

func (s *Store) ExistingMatches(ctx context.Context, compID, seasonID string, ids []string) (map[string]MatchRow, error) {
	if len(ids) == 0 {
		return map[string]MatchRow{}, nil
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.state, m.finalized_at, d.match_id IS NOT NULL,
	COALESCE(m.round, ''), m.bracket_required, m.winner_id, m.note,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url,
	m.home_placeholder, m.away_placeholder
FROM match m
LEFT JOIN match_detail d ON d.match_id=m.id
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.comp_id=$1 AND m.season_id=$2 AND m.id=ANY($3)`,
		compID, seasonID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]MatchRow)
	for rows.Next() {
		var id string
		var row MatchRow
		if err := rows.Scan(
			&id, &row.State, &row.FinalizedAt, &row.HasDetail,
			&row.Round, &row.BracketRequired, &row.WinnerID, &row.Note,
			&row.Home.ID, &row.Home.Name, &row.Home.Abbr, &row.Home.CrestURL,
			&row.Away.ID, &row.Away.Name, &row.Away.Abbr, &row.Away.CrestURL,
			&row.HomePlaceholder, &row.AwayPlaceholder,
		); err != nil {
			return nil, err
		}
		result[id] = row
	}
	return result, rows.Err()
}

func (s *Store) UnfinalizedMatches(ctx context.Context, compID, seasonID string) ([]model.Match, error) {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.kickoff, m.state, COALESCE(m.round, ''), m.minute,
	m.status_detail, m.status_name, m.home_score, m.away_score, m.winner_id,
	m.note, m.home_placeholder, m.away_placeholder, m.bracket_required,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url
FROM match m
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.comp_id=$1 AND m.season_id=$2
	AND m.state='finished' AND m.finalized_at IS NULL
ORDER BY m.updated_at, m.id
LIMIT 500`,
		compID, seasonID)
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
