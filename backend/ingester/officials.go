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
// It is called once, after the match transitions to finalized. The crew does
// not change during a match, so fetching it on every live poll would spend a
// request every 20 seconds to re-learn the referee's name.
//
// It returns nothing on purpose. The crew is additive: the scoreline, the
// detail and the finalization are already durable by the time this runs, and a
// core-API outage must not un-finalize a match that finished. The failure is
// recorded under its own ingest_run kind so it is visible without being
// counted against the competition's cycle.
func (r *runner) captureOfficials(
	ctx context.Context,
	comp config.Competition,
	identity store.MatchIdentity,
	providerEventID string,
) {
	started := time.Now()
	crew, err := r.source.Officials(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, officialsRunKind, started, err)
		r.log.Warn("fetch match officials", "match", providerEventID, "err", err)
		return
	}
	// Plenty of competitions publish no crew at all. That is an answer, not a
	// failure, and there is nothing to write for it.
	if len(crew) == 0 {
		r.recordRun(ctx, comp.ID, officialsRunKind, started, nil)
		return
	}

	officialIDs := make(map[string]uuid.UUID, len(crew))
	for _, official := range crew {
		officialID, err := r.repo.Official(ctx, r.source.Name(), store.OfficialRef{
			SourceID: official.SourceID, FullName: official.FullName,
		})
		if err != nil {
			operationErr := fmt.Errorf(
				"resolve official %s (%q): %w", official.SourceID, official.FullName, err)
			r.recordRun(ctx, comp.ID, officialsRunKind, started, operationErr)
			r.log.Warn("resolve match official",
				"match", providerEventID, "official", official.SourceID, "err", err)
			return
		}
		officialIDs[official.SourceID] = officialID
	}

	if err := r.repo.WriteMatchOfficials(
		ctx, identity.MatchID, crew, officialIDs); err != nil {
		r.recordRun(ctx, comp.ID, officialsRunKind, started, err)
		r.log.Warn("write match officials", "match", providerEventID, "err", err)
		return
	}
	r.recordRun(ctx, comp.ID, officialsRunKind, started, nil)
	r.log.Info("match officials", "match", providerEventID, "crew", len(crew))
}
