package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type MatchRow struct {
	State        model.MatchState
	FinalizedAt  pgtype.Timestamptz
	HasDetail    bool
	HomeCrestURL *string
	AwayCrestURL *string
}

const matchUpsertSQL = `
INSERT INTO match (
	id, comp_id, season_id, round, kickoff, state,
	home_team_id, away_team_id, home_score, away_score,
	minute, status_detail, status_name, winner_id, note,
	home_placeholder, away_placeholder, updated_at)
VALUES (
	$1, $2, $3, $4, $5::timestamptz, $6,
	$7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
ON CONFLICT (id) DO UPDATE SET
	comp_id = EXCLUDED.comp_id,
	season_id = EXCLUDED.season_id,
	round = COALESCE(NULLIF(EXCLUDED.round, ''), match.round),
	kickoff = EXCLUDED.kickoff,
	state = EXCLUDED.state,
	home_team_id = EXCLUDED.home_team_id,
	away_team_id = EXCLUDED.away_team_id,
	home_score = EXCLUDED.home_score,
	away_score = EXCLUDED.away_score,
	minute = EXCLUDED.minute,
	status_detail = EXCLUDED.status_detail,
	status_name = EXCLUDED.status_name,
	winner_id = EXCLUDED.winner_id,
	note = EXCLUDED.note,
	home_placeholder = EXCLUDED.home_placeholder,
	away_placeholder = EXCLUDED.away_placeholder,
	updated_at = now()
WHERE match.finalized_at IS NULL`

func (s *Store) UpsertMatch(ctx context.Context, compID, seasonID string, match model.Match) error {
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
		match.HomePlaceholder, match.AwayPlaceholder,
	}
}

const detailUpsertSQL = `
INSERT INTO match_detail (
	match_id, scorers, cards, stats, win_probability, shootout,
	shootout_detail, lineups, videos, info, form, h2h, commentary, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
ON CONFLICT (match_id) DO UPDATE SET
	scorers=EXCLUDED.scorers,
	cards=EXCLUDED.cards,
	stats=EXCLUDED.stats,
	win_probability=EXCLUDED.win_probability,
	shootout=EXCLUDED.shootout,
	shootout_detail=EXCLUDED.shootout_detail,
	lineups=EXCLUDED.lineups,
	videos=EXCLUDED.videos,
	info=EXCLUDED.info,
	form=EXCLUDED.form,
	h2h=EXCLUDED.h2h,
	commentary=EXCLUDED.commentary,
	updated_at=now()`

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (s *Store) UpsertMatchDetail(ctx context.Context, matchID string, detail model.MatchDetail) error {
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
		match.Note, match.HomePlaceholder, match.AwayPlaceholder, match.ID,
	}
	command, err := tx.Exec(ctx, `
UPDATE match SET
	comp_id=$1, season_id=$2, round=COALESCE(NULLIF($3, ''), round),
	kickoff=$4::timestamptz, state=$5, home_team_id=$6, away_team_id=$7,
	home_score=$8, away_score=$9, minute=$10, status_detail=$11,
	status_name=$12, winner_id=$13, note=$14, home_placeholder=$15,
	away_placeholder=$16, finalized_at=now(), updated_at=now()
WHERE id=$17 AND comp_id=$1 AND season_id=$2
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
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.state, m.finalized_at, d.match_id IS NOT NULL,
	home.crest_url, away.crest_url
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
			&row.HomeCrestURL, &row.AwayCrestURL,
		); err != nil {
			return nil, err
		}
		result[id] = row
	}
	return result, rows.Err()
}

func (s *Store) UnfinalizedMatches(ctx context.Context, compID, seasonID string) ([]model.Match, error) {
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.kickoff::text, m.state, COALESCE(m.round, ''), m.minute,
	m.status_detail, m.status_name, m.home_score, m.away_score, m.winner_id,
	m.note, m.home_placeholder, m.away_placeholder,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url
FROM match m
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.comp_id=$1 AND m.season_id=$2
	AND m.state='finished' AND m.finalized_at IS NULL`,
		compID, seasonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var matches []model.Match
	for rows.Next() {
		var match model.Match
		if err := rows.Scan(
			&match.ID, &match.Kickoff, &match.State, &match.Round, &match.Minute,
			&match.StatusDetail, &match.StatusName, &match.HomeScore, &match.AwayScore,
			&match.WinnerID, &match.Note, &match.HomePlaceholder, &match.AwayPlaceholder,
			&match.Home.ID, &match.Home.Name, &match.Home.Abbr, &match.Home.CrestURL,
			&match.Away.ID, &match.Away.Name, &match.Away.Abbr, &match.Away.CrestURL,
		); err != nil {
			return nil, err
		}
		matches = append(matches, match)
	}
	return matches, rows.Err()
}

var _ execer = (pgx.Tx)(nil)
