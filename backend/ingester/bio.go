package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
)

const (
	// One request per player, and ~6,300 players across nine competitions. At
	// one slow tick every five minutes this covers the whole population in
	// about 30 hours and then goes quiet, which is the point.
	bioBatchSize = 20
	// A career history changes on a transfer. Months, not minutes.
	bioTTL = 30 * 24 * time.Hour
	// Retry a temporarily unavailable history the same day, leaving capacity
	// for other players if the provider keeps omitting one player's history.
	bioRetryDelay = 6 * time.Hour
)

func (r *runner) refreshBios(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	start := time.Now()
	scopes, comp := r.workScopes("career")
	if len(scopes) == 0 {
		return nil
	}
	candidates, err := r.repo.PlayersNeedingBio(
		ctx, sourceESPN, time.Now().Add(-bioTTL), bioBatchSize, scopes,
	)
	if err != nil {
		r.recordGlobalRun(ctx, "player_bios", start, err)
		return err
	}
	if len(candidates) == 0 {
		return nil
	}

	athleteSourceIDs := make([]string, 0, len(candidates))
	for athleteSourceID := range candidates {
		athleteSourceIDs = append(athleteSourceIDs, athleteSourceID)
	}
	sort.Strings(athleteSourceIDs)
	if len(athleteSourceIDs) > bioBatchSize {
		athleteSourceIDs = athleteSourceIDs[:bioBatchSize]
	}

	// Athlete ids are provider-global; common/v3 still requires a competition
	// segment in the URL, so use one configured ESPN slug for the global sweep.

	var refreshErrors []error
	var failedPlayers []uuid.UUID
	for _, athleteSourceID := range athleteSourceIDs {
		if ctx.Err() != nil {
			refreshErrors = append(refreshErrors, ctx.Err())
			break
		}
		entries, fetchErr := r.source.AthleteBio(ctx, comp, athleteSourceID)
		if fetchErr != nil {
			failedPlayers = append(failedPlayers, candidates[athleteSourceID])
			refreshErrors = append(refreshErrors,
				fmt.Errorf("athlete %s bio: %w", athleteSourceID, fetchErr))
			continue
		}
		if writeErr := r.repo.ReplaceTeamHistory(
			ctx, candidates[athleteSourceID], sourceESPN, entries,
		); writeErr != nil {
			failedPlayers = append(failedPlayers, candidates[athleteSourceID])
			refreshErrors = append(refreshErrors,
				fmt.Errorf("athlete %s history write: %w", athleteSourceID, writeErr))
		}
	}

	if len(failedPlayers) > 0 && ctx.Err() == nil {
		if err := r.repo.DeferBioRetries(ctx, failedPlayers, r.clock().Add(bioRetryDelay)); err != nil {
			refreshErrors = append(refreshErrors, err)
		}
	}
	refreshErr := errors.Join(refreshErrors...)
	r.recordGlobalRun(ctx, "player_bios", start, refreshErr)
	return refreshErr
}
