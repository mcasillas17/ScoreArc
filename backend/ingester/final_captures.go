package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

// finalCaptureBacklogRunKind is the ingest_run kind recorded for one sweep of
// the final-capture backlog, as distinct from the "officials"/"odds" kind
// recorded for each individual attempt the sweep dispatches.
const finalCaptureBacklogRunKind = "final_capture_backlog"

// finalCaptureRetryBatch bounds how many pending officials/fixed-odds
// captures one backlog sweep will attempt. An unhealthy crew or bookmaker
// feed costs one bounded sweep per tick, not a growing amount of work as the
// backlog grows.
const finalCaptureRetryBatch = 10

// finalCaptureRetryInterval is how long a failed capture attempt waits before
// the backlog will offer it again.
const finalCaptureRetryInterval = 30 * time.Minute

// persistFinalCaptureAttempt durably records the outcome of one officials or
// fixed-odds capture attempt, so a future restart or backlog sweep knows
// whether to retry it.
//
// A canceled context is treated as a failure even when the capture itself
// returned nil: the attempt did not actually run to completion, so marking it
// complete would durably hide work that still needs to happen. If the status
// write itself also fails, the original capture cause is never lost: it is
// joined with a contextual error describing the status failure.
func (r *runner) persistFinalCaptureAttempt(
	ctx context.Context,
	matchID uuid.UUID,
	kind store.FinalCaptureKind,
	attemptedAt time.Time,
	captureErr error,
) error {
	effectiveErr := captureErr
	if effectiveErr == nil {
		effectiveErr = ctx.Err()
	}
	if effectiveErr == nil {
		if err := r.repo.CompleteFinalCapture(ctx, matchID, kind, time.Now()); err != nil {
			return errors.Join(effectiveErr, fmt.Errorf("persist %s completion for match %s: %w", kind, matchID, err))
		}
		return effectiveErr
	}
	retryAt := time.Now().Add(finalCaptureRetryInterval)
	if err := r.repo.ScheduleFinalCaptureRetry(
		ctx, matchID, kind, attemptedAt, retryAt, effectiveErr); err != nil {
		return errors.Join(effectiveErr, fmt.Errorf("persist %s retry for match %s: %w", kind, matchID, err))
	}
	return effectiveErr
}

// retryPendingFinalCaptures sweeps the durable backlog of officials and
// fixed-odds captures that finalized without completing, so a core-API or
// bookmaker outage at full time is never permanent. It is additive: its
// failures are recorded under their own ingest_run kind and never joined into
// a match's or competition's own errors, exactly like the individual
// captureOfficials/captureOdds calls it dispatches.
func (r *runner) retryPendingFinalCaptures(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) error {
	started := time.Now()
	pending, err := r.repo.PendingFinalCaptures(
		ctx, comp.ID, season.ID, r.source.Name(), time.Now(), finalCaptureRetryBatch)
	if err != nil {
		r.recordRun(ctx, comp.ID, finalCaptureBacklogRunKind, started, err)
		return err
	}

	var retryErrors []error
	for _, capture := range pending {
		if err := ctx.Err(); err != nil {
			retryErrors = append(retryErrors, err)
			break
		}
		identity := store.MatchIdentity{MatchID: capture.MatchID}
		switch capture.Kind {
		case store.FinalCaptureOfficials:
			if err := r.captureOfficials(ctx, comp, identity, capture.SourceID); err != nil {
				retryErrors = append(retryErrors,
					fmt.Errorf("officials retry for match %s: %w", capture.SourceID, err))
			}
		case store.FinalCaptureFixedOdds:
			if err := r.captureOdds(ctx, comp, identity, capture.SourceID, oddsCaptureFixedRetry); err != nil {
				retryErrors = append(retryErrors,
					fmt.Errorf("fixed odds retry for match %s: %w", capture.SourceID, err))
			}
		default:
			unknownErr := fmt.Errorf(
				"final capture backlog: match %s has unknown kind %q", capture.SourceID, capture.Kind)
			r.log.Error("final capture backlog", "match", capture.SourceID, "kind", capture.Kind, "err", unknownErr)
			retryErrors = append(retryErrors, unknownErr)
		}
	}

	operationErr := errors.Join(retryErrors...)
	r.recordRun(ctx, comp.ID, finalCaptureBacklogRunKind, started, operationErr)
	return operationErr
}
