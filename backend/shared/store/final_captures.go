package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// FinalCaptureKind identifies which post-finalization capture a status row
// tracks. ESPN's officials crew and fixed-odds lines are both fetched only
// after a match finalizes, in separate calls, and each can succeed or fail
// independently.
type FinalCaptureKind string

const (
	FinalCaptureOfficials FinalCaptureKind = "officials"
	FinalCaptureFixedOdds FinalCaptureKind = "fixed_odds"
)

// finalCaptureKinds is the CHECK constraint's allowed set, mirrored here so a
// bad kind is rejected before it ever reaches Postgres.
var finalCaptureKinds = map[FinalCaptureKind]bool{
	FinalCaptureOfficials: true,
	FinalCaptureFixedOdds: true,
}

// PendingFinalCapture is one match/kind pair still owed a post-finalization
// capture: the canonical match id to write the result against, and the given
// source's own id for that match, which the capture fetch addresses.
type PendingFinalCapture struct {
	MatchID  uuid.UUID
	SourceID string
	Kind     FinalCaptureKind
}

func validateFinalCaptureKind(op string, matchID uuid.UUID, kind FinalCaptureKind) error {
	if !finalCaptureKinds[kind] {
		return fmt.Errorf("%s for match %s: kind %q is not officials or fixed_odds", op, matchID, kind)
	}
	return nil
}

const completeFinalCaptureSQL = `
INSERT INTO match_final_capture_status
	(match_id, kind, attempt_count, last_attempted_at, retry_at, completed_at, last_error)
VALUES ($1, $2, 1, $3, NULL, $3, '')
ON CONFLICT (match_id, kind) DO UPDATE SET
	attempt_count     = match_final_capture_status.attempt_count + 1,
	last_attempted_at = GREATEST(match_final_capture_status.last_attempted_at, EXCLUDED.last_attempted_at),
	retry_at          = NULL,
	completed_at      = COALESCE(match_final_capture_status.completed_at, EXCLUDED.completed_at),
	last_error        = ''`

// CompleteFinalCapture records that a match's officials or fixed-odds capture
// succeeded.
//
// Completion is monotonic: once a row has a completed_at, a later call keeps
// the EARLIEST one via COALESCE rather than overwriting it, and always clears
// retry_at and last_error. There is no path back from completed to pending --
// only ScheduleFinalCaptureRetry can open a row, and it refuses to touch one
// that is already completed.
func (s *Store) CompleteFinalCapture(
	ctx context.Context,
	matchID uuid.UUID,
	kind FinalCaptureKind,
	completedAt time.Time,
) error {
	const op = "complete final capture"
	if matchID == uuid.Nil {
		return fmt.Errorf("%s: match id is required", op)
	}
	if err := validateFinalCaptureKind(op, matchID, kind); err != nil {
		return err
	}
	if completedAt.IsZero() {
		return fmt.Errorf("%s for match %s kind %s: completed_at is required", op, matchID, kind)
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	if _, err := s.pool.Exec(opCtx, completeFinalCaptureSQL, matchID, string(kind), completedAt); err != nil {
		return fmt.Errorf("%s for match %s kind %s: %w", op, matchID, kind, err)
	}
	return nil
}

const scheduleFinalCaptureRetrySQL = `
INSERT INTO match_final_capture_status
	(match_id, kind, attempt_count, last_attempted_at, retry_at, completed_at, last_error)
VALUES ($1, $2, 1, $3, $4, NULL, $5)
ON CONFLICT (match_id, kind) DO UPDATE SET
	attempt_count     = match_final_capture_status.attempt_count + 1,
	last_attempted_at = GREATEST(match_final_capture_status.last_attempted_at, EXCLUDED.last_attempted_at),
	retry_at          = GREATEST(match_final_capture_status.retry_at, EXCLUDED.retry_at),
	last_error        = EXCLUDED.last_error
WHERE match_final_capture_status.completed_at IS NULL`

// ScheduleFinalCaptureRetry records a failed capture attempt and when to try
// again.
//
// The GREATEST on both last_attempted_at and retry_at means an attempt that
// arrives out of order -- a slow retry racing a newer one -- can only push
// the next attempt later or leave it alone, never pull it earlier: cadence
// must not regress just because failures did not resolve in order.
//
// The UPDATE's WHERE completed_at IS NULL guard means a failure that arrives
// after the capture already completed is a no-op that returns nil rather
// than an error: a late, stale retry racing a completion is expected, and it
// must lose gracefully rather than reopen a done capture.
func (s *Store) ScheduleFinalCaptureRetry(
	ctx context.Context,
	matchID uuid.UUID,
	kind FinalCaptureKind,
	attemptedAt, retryAt time.Time,
	cause error,
) error {
	const op = "schedule final capture retry"
	if matchID == uuid.Nil {
		return fmt.Errorf("%s: match id is required", op)
	}
	if err := validateFinalCaptureKind(op, matchID, kind); err != nil {
		return err
	}
	if attemptedAt.IsZero() {
		return fmt.Errorf("%s for match %s kind %s: attempted_at is required", op, matchID, kind)
	}
	if retryAt.IsZero() {
		return fmt.Errorf("%s for match %s kind %s: retry_at is required", op, matchID, kind)
	}
	if !retryAt.After(attemptedAt) {
		return fmt.Errorf("%s for match %s kind %s: retry_at %s must be strictly after attempted_at %s",
			op, matchID, kind, retryAt, attemptedAt)
	}
	if cause == nil {
		return fmt.Errorf("%s for match %s kind %s: cause is required", op, matchID, kind)
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	if _, err := s.pool.Exec(opCtx, scheduleFinalCaptureRetrySQL,
		matchID, string(kind), attemptedAt, retryAt, cause.Error(),
	); err != nil {
		return fmt.Errorf("%s for match %s kind %s: %w", op, matchID, kind, err)
	}
	return nil
}

// pendingFinalCapturesSQL cross joins every finalized, in-scope match against
// both capture kinds, then left joins the status row (if any) for that pair.
// A pair is due when there is no status row at all, or the status row is
// incomplete and its retry_at has arrived.
//
// The match_external_ref lookup is a LATERAL ... LIMIT 1, matching
// unfinalizedMatchesSQL and MatchesMissingPlays: (source, source_id) is the
// crosswalk's key, and MANY source ids may point at one canonical match once
// duplicates are merged, so a plain join would multiply the result set by
// that many.
//
// A canceled, abandoned, or forfeited match finalizes with no real result to
// capture, so its status_name excludes it entirely -- these never become
// "pending" no matter how long they sit unfinalized-in-appearance.
const pendingFinalCapturesSQL = `
SELECT m.id, ref.source_id, k.kind
FROM match m
CROSS JOIN (VALUES ('officials'), ('fixed_odds')) AS k(kind)
JOIN LATERAL (
	SELECT r.source_id FROM match_external_ref r
	WHERE r.match_id=m.id AND r.source=$3
	ORDER BY r.first_seen_at, r.source_id LIMIT 1) ref ON true
LEFT JOIN match_final_capture_status status
	ON status.match_id=m.id AND status.kind=k.kind
WHERE m.competition_id=$1 AND m.season_id=$2
	AND m.state='finished' AND m.finalized_at IS NOT NULL
	AND m.status_name NOT IN ('STATUS_CANCELED', 'STATUS_ABANDONED', 'STATUS_FORFEIT')
	AND (
		status.match_id IS NULL
		OR (status.completed_at IS NULL AND status.retry_at <= $4)
	)
ORDER BY COALESCE(status.retry_at, m.finalized_at), m.kickoff, m.id, k.kind
LIMIT $5`

// PendingFinalCaptures returns the given source's view of every finalized
// match in this competition/season still owed an officials or fixed-odds
// capture that is due by dueAt, oldest-due first.
func (s *Store) PendingFinalCaptures(
	ctx context.Context,
	competitionID, seasonID, source string,
	dueAt time.Time,
	limit int,
) ([]PendingFinalCapture, error) {
	const op = "list pending final captures"
	if competitionID == "" || seasonID == "" || source == "" {
		return nil, fmt.Errorf("%s: competition, season and source are required", op)
	}
	if dueAt.IsZero() {
		return nil, fmt.Errorf("%s: due_at is required", op)
	}
	if limit < 1 {
		return nil, fmt.Errorf("%s: limit must be positive", op)
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(opCtx, pendingFinalCapturesSQL, competitionID, seasonID, source, dueAt, limit)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	defer rows.Close()

	pending := make([]PendingFinalCapture, 0)
	for rows.Next() {
		var capture PendingFinalCapture
		var kind string
		if err := rows.Scan(&capture.MatchID, &capture.SourceID, &kind); err != nil {
			return nil, fmt.Errorf("scan %s: %w", op, err)
		}
		capture.Kind = FinalCaptureKind(kind)
		pending = append(pending, capture)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", op, err)
	}
	return pending, nil
}
