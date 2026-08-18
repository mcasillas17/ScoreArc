package main

import (
	"context"
	"errors"
	"fmt"

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

func (m oddsCaptureMode) String() string {
	switch m {
	case oddsCaptureLive:
		return "live"
	case oddsCaptureFinal:
		return "final"
	case oddsCaptureFixedRetry:
		return "fixed_retry"
	default:
		return fmt.Sprintf("unknown(%d)", m)
	}
}

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
// writes are attempted when both apply. In every non-live mode, the retry
// ledger is persisted BEFORE that ingest_run row is recorded, and the
// recorded row reflects the ledger's effective outcome (not just the
// captures' own success/failure): a caller may discard the returned error
// entirely (a full-time capture is additive), so the audit row is the only
// place a completion/retry-ledger failure at exactly this moment could ever
// be seen. Only the FIXED outcome drives the returned error: a CURRENT-only
// failure fails the audit but must never leave an already-written FIXED row
// stuck pending, and a FIXED failure always retries even when the CURRENT
// sample succeeded.
func (r *runner) captureOdds(
	ctx context.Context,
	comp config.Competition,
	identity store.MatchIdentity,
	providerEventID string,
	mode oddsCaptureMode,
) error {
	started := r.clock()
	// Final and fixed-retry captures are once-per-match operations and must
	// never be throttled; the live sample is the one that repeats every 20
	// seconds.
	record := r.recordSample
	if mode != oddsCaptureLive {
		record = r.recordRun
	}
	providers, err := r.source.Odds(ctx, comp, providerEventID)
	if err != nil {
		r.log.Warn("fetch match odds", "match", providerEventID, "err", err)
		if mode == oddsCaptureLive {
			record(ctx, comp.ID, oddsRunKind, started, err)
			return nil
		}
		effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureFixedOdds, started, err)
		record(ctx, comp.ID, oddsRunKind, started, effectiveErr)
		return effectiveErr
	}
	// A match no book priced is an answer, not a failure.
	if len(providers) == 0 {
		if mode == oddsCaptureLive {
			record(ctx, comp.ID, oddsRunKind, started, nil)
			return nil
		}
		effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureFixedOdds, started, nil)
		record(ctx, comp.ID, oddsRunKind, started, effectiveErr)
		return effectiveErr
	}

	// The bucket is a minute (WriteOddsSnapshot truncates), so two of every
	// three live polls would otherwise rewrite the row they just wrote. A
	// finalized capture always writes: it is the closing sample and the fixed
	// lines, not a point on a curve.
	liveSampleReserved := false
	if mode == oddsCaptureLive {
		if r.sampleUnchanged(identity.MatchID, oddsRunKind, started, oddsDigest(providers)) {
			return nil
		}
		liveSampleReserved = true
	}

	var snapshotErr, fixedErr error
	if mode != oddsCaptureFixedRetry {
		if err := r.repo.WriteOddsSnapshot(
			ctx, identity.MatchID, providers, started); err != nil {
			snapshotErr = fmt.Errorf("odds snapshot: %w", err)
			if liveSampleReserved {
				r.forgetSample(identity.MatchID, oddsRunKind)
			}
			r.log.Warn("write odds snapshot", "match", providerEventID, "err", err)
		}
	}
	if mode != oddsCaptureLive {
		if err := r.repo.WriteMatchOdds(ctx, identity.MatchID, providers); err != nil {
			fixedErr = fmt.Errorf("fixed odds: %w", err)
			r.log.Warn("write fixed odds", "match", providerEventID, "err", err)
		}
	}

	if mode == oddsCaptureLive {
		record(ctx, comp.ID, oddsRunKind, started, snapshotErr)
		if snapshotErr == nil {
			r.log.Info("match odds",
				"match", providerEventID, "providers", len(providers), "mode", mode.String())
		}
		return nil
	}

	// Persist the fixed outcome to the retry ledger first, so the "odds"
	// audit row below reflects whatever the ledger actually recorded --
	// including a ledger failure of its own -- rather than just this
	// capture's own write outcome.
	persistedFixedOutcome := r.persistFinalCaptureAttempt(
		ctx, identity.MatchID, store.FinalCaptureFixedOdds, started, fixedErr)
	operationErr := errors.Join(snapshotErr, persistedFixedOutcome)
	record(ctx, comp.ID, oddsRunKind, started, operationErr)
	if operationErr == nil {
		r.log.Info("match odds",
			"match", providerEventID, "providers", len(providers), "mode", mode.String())
	}
	return operationErr
}
