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
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
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

// A newly completed game can change its participants' roster totals between
// daily reads. Recheck just those clubs on the next eligible slow tick;
// existing per-team retry backoff still applies.
func (r *runner) markMatchSquadsPending(competitionID, seasonID, homeID, awayID string) {
	prefix := competitionID + "/" + seasonID + "/"
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.squadsRefreshed, prefix+homeID)
	delete(r.squadsRefreshed, prefix+awayID)
}

// ESPN's roster is current. A past or future cup cannot borrow today's squad.
func (r *runner) refreshMatchSquads(ctx context.Context, comp config.Competition, season config.Season) error {
	start, end, err := source.SeasonBounds(season)
	if err != nil {
		return err
	}
	now := r.clock()
	if now.Before(start) || !now.Before(end) {
		return nil
	}
	teams, err := r.repo.MatchSquadTeams(ctx, comp.ID, season.ID)
	if err != nil {
		r.recordRun(ctx, comp.ID, "squads", now, err)
		return err
	}
	if len(teams) == 0 {
		return nil
	}
	return r.refreshSquads(ctx, comp, season, teams)
}

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
		err := fmt.Errorf("no edition teams available for squad refresh")
		r.recordRun(ctx, comp.ID, "squads", start, err)
		return err
	}
	if len(teamIDs) > store.MaxEditionTeams {
		r.recordRun(ctx, comp.ID, "squads", start, store.ErrEditionTeamsTooLarge)
		return store.ErrEditionTeamsTooLarge
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

			squad, err := r.source.Roster(ctx, comp, season, providerTeamID)
			if err != nil {
				recordError(fmt.Errorf("team %s roster: %w", providerTeamID, err))
				return
			}
			// The club's colour and location ride along on the roster
			// payload, so this costs no extra request. Written before the
			// squad so a squad write the shrink guard rejects still records
			// them; a failure here is logged for the run but does not block
			// the squad, which is the point of this refresh.
			// The store ignores empty values, so a roster without them
			// never blanks what is already held.
			if err := r.repo.SetTeamRosterIdentity(
				ctx, teamIDs[providerTeamID], squad.Color, squad.Location,
			); err != nil {
				recordError(fmt.Errorf("team %s roster identity: %w", providerTeamID, err))
			}
			if len(squad.Players) == 0 {
				err = r.repo.RecordResourceObservation(ctx, comp.ID, season.ID, sourceESPN, "squad", teamIDs[providerTeamID], 0, true)
			} else {
				err = r.repo.ReplaceSquad(ctx, comp.ID, season.ID, teamIDs[providerTeamID], sourceESPN,
					squad.Players, make(map[string]uuid.UUID), true)
			}
			if err != nil {
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
