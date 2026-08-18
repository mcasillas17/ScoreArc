package main

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const officialsRunKind = "officials"

// captureOfficials records a finished match's officiating crew.
//
// It runs at full time and, if it fails, again from the final-capture
// backlog until it succeeds. The crew does not change during a match, so
// fetching it on every live poll would spend a request every 20 seconds to
// re-learn the referee's name.
//
// The crew is additive: the scoreline, the detail and the finalization are
// already durable by the time this runs, and a core-API outage must not
// un-finalize a match that finished. Every failure is recorded under its own
// ingest_run kind so it is visible without being counted against the
// competition's cycle, and durably scheduled for retry so it survives a
// restart. The retry ledger is persisted BEFORE that ingest_run row is
// recorded, and the recorded row reflects the ledger's effective outcome
// (not just this capture's own success/failure): a full-time caller discards
// the returned error entirely, so the audit row is the only place a
// completion/retry-ledger failure at exactly this moment could ever be seen.
// The returned error carries that same effective failure (including one from
// the retry ledger itself); the full-time caller discards it, while the
// backlog retry caller uses it to decide whether the retry is over.
func (r *runner) captureOfficials(
	ctx context.Context,
	comp config.Competition,
	identity store.MatchIdentity,
	providerEventID string,
) error {
	started := time.Now()
	crew, err := r.source.Officials(ctx, comp, providerEventID)
	if err != nil {
		r.log.Warn("fetch match officials", "match", providerEventID, "err", err)
		effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureOfficials, started, err)
		r.recordRun(ctx, comp.ID, officialsRunKind, started, effectiveErr)
		return effectiveErr
	}
	// Plenty of competitions publish no crew at all. That is an answer, not a
	// failure, and there is nothing to write for it.
	if len(crew) == 0 {
		effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureOfficials, started, nil)
		r.recordRun(ctx, comp.ID, officialsRunKind, started, effectiveErr)
		return effectiveErr
	}

	officialIDs := make(map[string]uuid.UUID, len(crew))
	for _, official := range crew {
		officialID, err := r.repo.Official(ctx, r.source.Name(), store.OfficialRef{
			SourceID: official.SourceID, FullName: official.FullName,
		})
		if err != nil {
			operationErr := fmt.Errorf(
				"resolve official %s (%q): %w", official.SourceID, official.FullName, err)
			r.log.Warn("resolve match official",
				"match", providerEventID, "official", official.SourceID, "err", err)
			effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureOfficials, started, operationErr)
			r.recordRun(ctx, comp.ID, officialsRunKind, started, effectiveErr)
			return effectiveErr
		}
		officialIDs[official.SourceID] = officialID
	}

	if err := r.repo.WriteMatchOfficials(
		ctx, identity.MatchID, crew, officialIDs); err != nil {
		r.log.Warn("write match officials", "match", providerEventID, "err", err)
		effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureOfficials, started, err)
		r.recordRun(ctx, comp.ID, officialsRunKind, started, effectiveErr)
		return effectiveErr
	}
	effectiveErr := r.persistFinalCaptureAttempt(ctx, identity.MatchID, store.FinalCaptureOfficials, started, nil)
	r.recordRun(ctx, comp.ID, officialsRunKind, started, effectiveErr)
	if effectiveErr == nil {
		r.log.Info("match officials", "match", providerEventID, "crew", len(crew))
	}
	return effectiveErr
}
