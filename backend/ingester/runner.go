package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

type activity struct {
	known  bool
	active bool
}

type runner struct {
	competitions  []config.Competition
	source        source.Source
	repo          repository
	mirror        crestMirror
	log           *slog.Logger
	maxConcurrent int

	mu       sync.Mutex
	active   map[string]activity
	mirrored map[string]bool
}

type competitionResult struct {
	live   bool
	active bool
	err    error
}

func (r *runner) runCycle(ctx context.Context, slowTick bool) bool {
	limit := r.maxConcurrent
	if limit <= 0 {
		limit = 3
	}
	semaphore := make(chan struct{}, limit)
	var wg sync.WaitGroup
	var resultMu sync.Mutex
	anyLive := false

	for _, comp := range r.competitions {
		season, ok := comp.Seasons[comp.CurrentSeasonId]
		if !ok {
			r.log.Warn("current season missing", "comp", comp.ID, "season", comp.CurrentSeasonId)
			continue
		}
		key := comp.ID + "/" + season.ID
		r.mu.Lock()
		state := r.active[key]
		r.mu.Unlock()
		if !slowTick && state.known && !state.active {
			continue
		}

		wg.Add(1)
		go func(comp config.Competition, season config.Season, key string) {
			defer wg.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				return
			}

			result := r.ingestCompSeason(ctx, comp, season, slowTick)
			if result.err == nil {
				r.mu.Lock()
				r.active[key] = activity{known: true, active: result.active}
				r.mu.Unlock()
			}
			if result.live {
				resultMu.Lock()
				anyLive = true
				resultMu.Unlock()
			}
		}(comp, season, key)
	}
	wg.Wait()
	return anyLive
}

func (r *runner) ingestCompSeason(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	slowTick bool,
) competitionResult {
	existing, err := r.repo.ExistingMatches(ctx, comp.ID, season.ID)
	if err != nil {
		r.recordRun(ctx, comp.ID, "scoreboard", time.Now(), err)
		return competitionResult{err: err}
	}

	start := time.Now()
	matches, err := r.source.Scoreboard(ctx, comp, season)
	if err != nil {
		r.recordRun(ctx, comp.ID, "scoreboard", start, err)
		return competitionResult{err: err}
	}
	scoreboardResult, scoreboardErr := r.processMatches(
		ctx, comp, season, matches, existing, slowTick,
	)
	r.recordRun(ctx, comp.ID, "scoreboard", start, scoreboardErr)

	result := competitionResult{
		live: scoreboardResult.live, active: scoreboardResult.active,
	}
	finalized := scoreboardResult.finalized

	if season.HasBracket && (result.active || slowTick) {
		start = time.Now()
		bracket, bracketErr := r.source.Bracket(ctx, comp, season)
		if bracketErr == nil {
			bracketMatches := make([]model.Match, 0, len(bracket))
			for _, match := range bracket {
				bracketMatches = append(bracketMatches, bracketMatch(match))
			}
			bracketResult, processErr := r.processMatches(
				ctx, comp, season, bracketMatches, existing, slowTick,
			)
			bracketErr = processErr
			result.live = result.live || bracketResult.live
			result.active = result.active || bracketResult.active
			finalized = finalized || bracketResult.finalized
		}
		r.recordRun(ctx, comp.ID, "bracket", start, bracketErr)
	}

	if finalized || slowTick {
		r.refreshStandings(ctx, comp, season)
		r.refreshTopScorers(ctx, comp, season)
	}
	if scoreboardErr != nil {
		r.log.Warn("partial scoreboard ingest", "comp", comp.ID, "err", scoreboardErr)
	}
	return result
}

func (r *runner) refreshStandings(ctx context.Context, comp config.Competition, season config.Season) {
	start := time.Now()
	rows, err := r.source.Standings(ctx, comp, season)
	if err == nil {
		err = r.repo.ReplaceStandings(ctx, comp.ID, season.ID, rows)
	}
	r.recordRun(ctx, comp.ID, "standings", start, err)
}

func (r *runner) refreshTopScorers(ctx context.Context, comp config.Competition, season config.Season) {
	start := time.Now()
	rows, err := r.source.TopScorers(ctx, comp, season, topScorerLimit)
	if err == nil {
		err = r.repo.ReplaceTopScorers(ctx, comp.ID, season.ID, rows)
	}
	r.recordRun(ctx, comp.ID, "top_scorers", start, err)
}

func (r *runner) recordRun(ctx context.Context, compID, kind string, started time.Time, operationErr error) {
	ok := operationErr == nil
	var message string
	if operationErr != nil {
		message = operationErr.Error()
		r.log.Warn("ingest operation", "comp", compID, "kind", kind, "err", operationErr)
	}
	if err := r.repo.LogIngestRun(
		ctx, &compID, kind, started, time.Now(), ok, message,
	); err != nil {
		r.log.Warn("record ingest run", "comp", compID, "kind", kind, "err", err)
	}
}
