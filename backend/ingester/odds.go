package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const oddsRunKind = "odds"

// oddsCaptureMode selects which of the CURRENT (moving) and FIXED (settled)
// bookmaker lines captureOdds attempts on a given call.
type oddsCaptureMode int

const (
	// oddsCaptureLive samples the CURRENT line on a live poll. There is no
	// fixed line yet and nothing durable to retry here: a missed sample is
	// superseded by the next poll roughly 20 seconds later.
	oddsCaptureLive oddsCaptureMode = iota
	// oddsCaptureFinal is the first attempt at full time: the CURRENT line is
	// sampled one last time and the FIXED opening/closing rows are written,
	// with the FIXED outcome durably tracked for retry.
	oddsCaptureFinal
	// oddsCaptureFixedRetry is a later backlog attempt at the FIXED rows
	// only. The CURRENT market closed at full time, so there is nothing left
	// to sample.
	oddsCaptureFixedRetry
)

// captureOdds records a match's raw bookmaker prices.
//
// The CURRENT line is sampled on every live poll, because market movement only
// exists if somebody writes it down: ESPN publishes the price now, not the
// price ten minutes ago. The FIXED opening and closing lines are written only
// once the match is finalized, when they are settled facts rather than values
// still moving.
//
// This is deliberately independent of the win-probability snapshot. That is a
// normalized three-way probability derived from one book; these are the books'
// own American prices, and neither is derivable from the other.
//
// The CURRENT snapshot is best-effort: a live poll happens again in roughly 20
// seconds regardless, so a live-mode failure is audited but never durably
// retried. The FIXED rows are durable: a failure is recorded under its own
// ingest_run kind so it is visible without being counted against the
// competition's cycle, and scheduled for retry so it survives a restart. Both
// writes are attempted when both apply, and the recorded run carries whatever
// actually went wrong rather than the last call's return value. Only the
// FIXED outcome drives the returned error: a CURRENT-only failure fails the
// audit but must never leave an already-written FIXED row stuck pending, and
// a FIXED failure always retries even when the CURRENT sample succeeded.
func (r *runner) captureOdds(
	ctx context.Context,
	comp config.Competition,
	identity store.MatchIdentity,
	providerEventID string,
	mode oddsCaptureMode,
) error {
	started := time.Now()
	providers, err := r.source.Odds(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, oddsRunKind, started, err)
		r.log.Warn("fetch match odds", "match", providerEventID, "err", err)
		if mode == oddsCaptureLive {
			return nil
		}
		return r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureFixedOdds, started, err)
	}
	// A match no book priced is an answer, not a failure.
	if len(providers) == 0 {
		r.recordRun(ctx, comp.ID, oddsRunKind, started, nil)
		if mode == oddsCaptureLive {
			return nil
		}
		return r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureFixedOdds, started, nil)
	}

	var snapshotErr, fixedErr error
	if mode != oddsCaptureFixedRetry {
		if err := r.repo.WriteOddsSnapshot(
			ctx, identity.MatchID, providers, started); err != nil {
			snapshotErr = fmt.Errorf("odds snapshot: %w", err)
			r.log.Warn("write odds snapshot", "match", providerEventID, "err", err)
		}
	}
	if mode != oddsCaptureLive {
		if err := r.repo.WriteMatchOdds(ctx, identity.MatchID, providers); err != nil {
			fixedErr = fmt.Errorf("fixed odds: %w", err)
			r.log.Warn("write fixed odds", "match", providerEventID, "err", err)
		}
	}

	operationErr := errors.Join(snapshotErr, fixedErr)
	r.recordRun(ctx, comp.ID, oddsRunKind, started, operationErr)
	if operationErr == nil {
		r.log.Info("match odds",
			"match", providerEventID, "providers", len(providers), "mode", mode)
	}
	if mode == oddsCaptureLive {
		return nil
	}
	return errors.Join(snapshotErr, r.persistFinalCaptureAttempt(
		ctx, identity.MatchID, store.FinalCaptureFixedOdds, started, fixedErr))
}
