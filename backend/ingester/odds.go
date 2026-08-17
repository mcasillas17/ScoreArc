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
// Like the crew, it returns nothing: the scoreline is already durable, and a
// bookmaker outage must not cost a match its result. Both writes are attempted
// even when one fails, and the recorded run carries whatever actually went
// wrong rather than the last call's return value.
func (r *runner) captureOdds(
	ctx context.Context,
	comp config.Competition,
	identity store.MatchIdentity,
	providerEventID string,
	finalized bool,
) {
	started := time.Now()
	providers, err := r.source.Odds(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, oddsRunKind, started, err)
		r.log.Warn("fetch match odds", "match", providerEventID, "err", err)
		return
	}
	// A match no book priced is an answer, not a failure.
	if len(providers) == 0 {
		r.recordRun(ctx, comp.ID, oddsRunKind, started, nil)
		return
	}

	var writeErrors []error
	if err := r.repo.WriteOddsSnapshot(
		ctx, identity.MatchID, providers, started); err != nil {
		writeErrors = append(writeErrors, fmt.Errorf("odds snapshot: %w", err))
		r.log.Warn("write odds snapshot", "match", providerEventID, "err", err)
	}
	if finalized {
		if err := r.repo.WriteMatchOdds(ctx, identity.MatchID, providers); err != nil {
			writeErrors = append(writeErrors, fmt.Errorf("fixed odds: %w", err))
			r.log.Warn("write fixed odds", "match", providerEventID, "err", err)
		}
	}

	operationErr := errors.Join(writeErrors...)
	r.recordRun(ctx, comp.ID, oddsRunKind, started, operationErr)
	if operationErr == nil {
		r.log.Info("match odds",
			"match", providerEventID, "providers", len(providers), "finalized", finalized)
	}
}
