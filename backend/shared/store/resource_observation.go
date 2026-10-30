package store

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Existing ingest callers log Error(), so dependency details stay behind
// Unwrap for classification instead of entering the log message.
type observationError struct{ cause error }

func (e *observationError) Error() string { return "resource observation failed" }
func (e *observationError) Unwrap() error { return e.cause }

func observationFailure(err error) error {
	if err == nil {
		return nil
	}
	return &observationError{cause: err}
}

// RecordResourceObservation renews an accepted unchanged or validated-empty
// collection. The caller validates source completeness; persisted facts must
// still match its exact scope and count before the clock can advance.
func (s *Store) RecordResourceObservation(ctx context.Context, competitionID, seasonID, source, resource, subject string, rowCount int) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return observationFailure(err)
	}
	defer rollback(ctx, tx)
	if err := lockResourceCollection(ctx, tx, competitionID, seasonID, resource, subject); err != nil {
		return err
	}
	if err := recordResourceObservation(ctx, tx, competitionID, seasonID, source, resource, subject, rowCount); err != nil {
		return err
	}
	return observationFailure(tx.Commit(ctx))
}

// Collection tables are shared across sources. Serialize replacements and
// renewals on that same scope, including scopes that have no rows to lock yet.
func lockResourceCollection(ctx context.Context, tx pgx.Tx, competitionID, seasonID, resource, subject string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(json_build_array($1::text,$2::text,$3::text,$4::text)::text,0))`,
		competitionID, seasonID, resource, subject)
	return observationFailure(err)
}

func recordResourceObservation(ctx context.Context, tx pgx.Tx, competitionID, seasonID, source, resource, subject string, rowCount int) error {
	if rowCount < 0 || strings.TrimSpace(source) == "" {
		return errors.New("invalid resource observation count or source")
	}
	var query string
	args := []any{competitionID, seasonID, source}
	switch {
	case resource == "standings" && subject == "":
		query = `SELECT count(*),count(*) FILTER (WHERE source=$3) FROM standing WHERE competition_id=$1 AND season_id=$2`
	case resource == "leaders" && (subject == "goals" || subject == "assists"):
		query = `SELECT count(*),count(*) FILTER (WHERE source=$3) FROM top_scorer WHERE competition_id=$1 AND season_id=$2 AND category=$4`
		args = append(args, subject)
	case resource == "squad" && strings.TrimSpace(subject) != "":
		query = `SELECT count(*),count(*) FILTER (WHERE source=$3) FROM squad_membership WHERE competition_id=$1 AND season_id=$2 AND team_id=$4`
		args = append(args, subject)
	default:
		return errors.New("invalid resource observation scope")
	}
	var total, sourced int
	if err := tx.QueryRow(ctx, query, args...).Scan(&total, &sourced); err != nil {
		return observationFailure(err)
	}
	if rowCount == 0 && total != 0 {
		return ErrEmptyReplacement
	}
	if total != rowCount || sourced != rowCount {
		return ErrPartialReplacement
	}
	_, err := tx.Exec(ctx, `
INSERT INTO resource_observation (competition_id,season_id,source,resource,subject,observed_at,row_count)
VALUES ($1,$2,$3,$4,$5,clock_timestamp(),$6)
ON CONFLICT (competition_id,season_id,source,resource,subject) DO UPDATE SET
 observed_at=EXCLUDED.observed_at, row_count=EXCLUDED.row_count`,
		competitionID, seasonID, source, resource, subject, rowCount)
	return observationFailure(err)
}
