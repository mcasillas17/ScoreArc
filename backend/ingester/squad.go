package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
)

const (
	// Nine competitions times roughly 20 clubs is about 180 requests for a
	// complete daily refresh. Bound fan-out at five so one competition never
	// sends all 20 roster requests at once.
	squadRefreshConcurrency = 5
	// A failed club retries at most twice an hour. One permanent failure then
	// adds at most 48 logical fetches per day instead of refetching all ~180
	// squads on each of the 288 slow ticks.
	squadRetryInterval = 30 * time.Minute
)

func (r *runner) refreshSquads(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	teamIDs map[string]string,
) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	start := time.Now()
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	if len(teamIDs) == 0 {
		err := fmt.Errorf("no standings teams available for squad refresh")
		r.recordRun(ctx, comp.ID, "squads", start, err)
		return err
	}

	providerTeamIDs := make([]string, 0, len(teamIDs))
	r.mu.Lock()
	if r.squadsRefreshed == nil {
		r.squadsRefreshed = make(map[string]time.Time)
	}
	if r.squadAttempted == nil {
		r.squadAttempted = make(map[string]time.Time)
	}
	for providerTeamID := range teamIDs {
		key := comp.ID + "/" + season.ID + "/" + providerTeamID
		if r.squadsRefreshed[key].Equal(today) {
			continue
		}
		if attempted := r.squadAttempted[key]; !attempted.IsZero() &&
			now.Sub(attempted) < squadRetryInterval {
			continue
		}
		r.squadAttempted[key] = now
		providerTeamIDs = append(providerTeamIDs, providerTeamID)
	}
	r.mu.Unlock()
	sort.Strings(providerTeamIDs)
	if len(providerTeamIDs) == 0 {
		return nil
	}

	semaphore := make(chan struct{}, squadRefreshConcurrency)
	var wg sync.WaitGroup
	var errorsMu sync.Mutex
	var refreshErrors []error
	recordError := func(err error) {
		errorsMu.Lock()
		refreshErrors = append(refreshErrors, err)
		errorsMu.Unlock()
	}

	for _, providerTeamID := range providerTeamIDs {
		providerTeamID := providerTeamID
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				recordError(fmt.Errorf("team %s roster: %w", providerTeamID, ctx.Err()))
				return
			}

			squad, err := r.source.Roster(ctx, comp, providerTeamID)
			if err != nil {
				recordError(fmt.Errorf("team %s roster: %w", providerTeamID, err))
				return
			}
			if err := r.repo.ReplaceSquad(
				ctx, comp.ID, season.ID, teamIDs[providerTeamID], sourceESPN,
				squad.Players, make(map[string]uuid.UUID),
			); err != nil {
				recordError(fmt.Errorf("team %s squad write: %w", providerTeamID, err))
				return
			}
			r.mu.Lock()
			r.squadsRefreshed[comp.ID+"/"+season.ID+"/"+providerTeamID] = today
			r.mu.Unlock()
		}()
	}
	wg.Wait()

	refreshErr := errors.Join(refreshErrors...)
	r.recordRun(ctx, comp.ID, "squads", start, refreshErr)
	return refreshErr
}
