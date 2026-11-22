package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

var ErrPollEvidenceBudget = errors.New("full poll exceeds match ID evidence budget")

// Commit the legacy last-poll status and like-for-like evidence together. Neither
// a rolling poll nor a failed/partial full read advances the complete ID snapshot.
func (s *Store) RecordScopedMatchPoll(ctx context.Context, comp, season, source string, at time.Time, full bool, outcome string, matches []model.Match) error {
	if comp == "" || season == "" || source == "" || at.IsZero() ||
		(outcome != "ok" && outcome != "partial" && outcome != "failed") {
		return fmt.Errorf("invalid scoped match poll")
	}
	pollSource := source + rollingPollSuffix
	ids := []string{}
	var refusal error
	if full {
		pollSource = source + fullPollSuffix
		if outcome == "ok" {
			if len(matches) > 5000 {
				refusal = ErrPollEvidenceBudget
			} else {
				for _, m := range matches {
					if len(m.ID) == 0 || len(m.ID) > 128 {
						refusal = ErrPollEvidenceBudget
						break
					}
					ids = append(ids, m.ID)
				}
			}
		}
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	write := func(result string, seen []string) error {
		return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `INSERT INTO match_poll_status AS p
 (competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count,seen_ids)
 VALUES ($1,$2,$3,$4,CASE WHEN $5='ok' THEN $4::timestamptz END,$5,$6,$7)
 ON CONFLICT (competition_id,season_id,source) DO UPDATE SET
 attempted_at=EXCLUDED.attempted_at,outcome=EXCLUDED.outcome,event_count=EXCLUDED.event_count,
 succeeded_at=coalesce(EXCLUDED.succeeded_at,p.succeeded_at),
 seen_ids=CASE WHEN $8 AND $5='ok' THEN EXCLUDED.seen_ids ELSE p.seen_ids END,
 absent_ids=CASE WHEN $8 AND $5='ok' THEN ARRAY(
   SELECT unnest(p.seen_ids || p.absent_ids) EXCEPT SELECT unnest(EXCLUDED.seen_ids)
 ) ELSE p.absent_ids END,
 missing_ids=CASE WHEN $8 AND $5='ok' THEN ARRAY(
   SELECT unnest(p.absent_ids) EXCEPT SELECT unnest(EXCLUDED.seen_ids)
 ) ELSE p.missing_ids END
 WHERE p.attempted_at < EXCLUDED.attempted_at`, comp, season, pollSource, at, result, len(matches), seen, full)
			if err != nil || tag.RowsAffected() == 0 {
				return err
			}
			_, err = tx.Exec(ctx, recordPollSQL, comp, season, source, at, result, len(matches))
			return err
		})
	}
	if refusal == nil {
		err := write(outcome, ids)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.ConstraintName != "match_poll_evidence_id_budget" {
			return err
		}
		refusal = ErrPollEvidenceBudget
	}
	// A deterministic cap is a visible partial observation, not a silently frozen
	// success. Keep the previous ID sets and the normal full-poll cadence.
	if err := write("partial", []string{}); err != nil {
		return err
	}
	return refusal
}
