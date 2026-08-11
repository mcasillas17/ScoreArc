package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const ingestRunRetention = 30 * 24 * time.Hour

type activity struct {
	known  bool
	active bool
	live   bool
}

type runner struct {
	competitions  []config.Competition
	source        source.Source
	repo          repository
	mirror        crestMirror
	log           *slog.Logger
	maxConcurrent int

	mu         sync.Mutex
	active     map[string]activity
	mirrored   map[string]string
	backfilled map[string]bool
}

type cycleResult struct {
	anyLive  bool
	failures int
}

type competitionResult struct {
	live          bool
	active        bool
	stateReliable bool
	backfillDone  bool
	err           error
}

func (r *runner) runCycle(ctx context.Context, slowTick bool) cycleResult {
	limit := r.maxConcurrent
	if limit <= 0 {
		limit = 3
	}
	semaphore := make(chan struct{}, limit)
	var wg sync.WaitGroup
	var resultMu sync.Mutex
	var cycle cycleResult

	for _, comp := range r.competitions {
		season, ok := comp.Seasons[comp.CurrentSeasonId]
		if !ok {
			configErr := fmt.Errorf("current season %q missing", comp.CurrentSeasonId)
			r.log.Warn("current season missing", "comp", comp.ID, "season", comp.CurrentSeasonId)
			r.recordRun(ctx, comp.ID, "config", time.Now(), configErr)
			resultMu.Lock()
			cycle.failures++
			resultMu.Unlock()
			continue
		}
		key := comp.ID + "/" + season.ID
		r.mu.Lock()
		previous := r.active[key]
		r.mu.Unlock()
		if !slowTick && previous.known && !previous.active {
			continue
		}

		wg.Add(1)
		go func(comp config.Competition, season config.Season, key string, previous activity) {
			defer wg.Done()
			if ctx.Err() != nil {
				return
			}
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				return
			}
			if ctx.Err() != nil {
				return
			}

			r.mu.Lock()
			backfill := slowTick && !r.backfilled[key]
			r.mu.Unlock()
			result := r.ingestCompSeason(ctx, comp, season, previous, slowTick, backfill)
			if result.stateReliable {
				r.mu.Lock()
				r.active[key] = activity{
					known: true, active: result.active, live: result.live,
				}
				r.mu.Unlock()
			}
			if backfill && result.backfillDone {
				r.mu.Lock()
				r.backfilled[key] = true
				r.mu.Unlock()
			}

			resultMu.Lock()
			if result.live || (!result.stateReliable && previous.live) {
				cycle.anyLive = true
			}
			if result.err != nil {
				cycle.failures++
			}
			resultMu.Unlock()
		}(comp, season, key, previous)
	}
	wg.Wait()

	if slowTick {
		pruneCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		if err := r.repo.PruneIngestRuns(pruneCtx, time.Now().Add(-ingestRunRetention)); err != nil {
			r.log.Warn("prune ingest runs", "err", err)
			cycle.failures++
		}
		cancel()
	}
	return cycle
}

func (r *runner) ingestCompSeason(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	previous activity,
	slowTick bool,
	backfill bool,
) competitionResult {
	scoreboardStart := time.Now()
	scoreboard, err := r.source.Scoreboard(ctx, comp, season, backfill)
	if err != nil {
		r.recordRun(ctx, comp.ID, "scoreboard_fetch", scoreboardStart, err)
		return competitionResult{err: err}
	}
	r.recordRun(ctx, comp.ID, "scoreboard_fetch", scoreboardStart, nil)

	candidates := make(map[string]model.Match, len(scoreboard))
	activeCandidate := false
	liveCandidate := false
	for _, match := range scoreboard {
		candidates[match.ID] = mergeCandidate(candidates[match.ID], match)
		activeCandidate = activeCandidate ||
			match.State == model.MatchStateLive ||
			match.State == model.MatchStateScheduled
		liveCandidate = liveCandidate || match.State == model.MatchStateLive
	}

	var bracketErr error
	if season.HasBracket && (activeCandidate || previous.active || slowTick) && ctx.Err() == nil {
		start := time.Now()
		var bracket []model.BracketMatch
		bracket, bracketErr = r.source.Bracket(ctx, comp, season)
		if bracketErr == nil {
			for _, match := range bracket {
				candidate := bracketMatch(match)
				candidates[match.ID] = mergeCandidate(candidates[match.ID], candidate)
				activeCandidate = activeCandidate ||
					candidate.State == model.MatchStateLive ||
					candidate.State == model.MatchStateScheduled
				liveCandidate = liveCandidate || candidate.State == model.MatchStateLive
			}
		}
		r.recordRun(ctx, comp.ID, "bracket", start, bracketErr)
	}

	var backlogErr error
	if slowTick && ctx.Err() == nil {
		start := time.Now()
		var backlog []model.Match
		backlog, backlogErr = r.repo.UnfinalizedMatches(ctx, comp.ID, season.ID)
		if backlogErr == nil {
			for _, match := range backlog {
				candidates[match.ID] = mergeCandidate(candidates[match.ID], match)
			}
		}
		r.recordRun(ctx, comp.ID, "finalization_backlog", start, backlogErr)
	}

	ids := make([]string, 0, len(candidates))
	matches := make([]model.Match, 0, len(candidates))
	for id, match := range candidates {
		ids = append(ids, id)
		matches = append(matches, match)
	}
	existing, existingErr := r.repo.ExistingMatches(ctx, comp.ID, season.ID, ids)
	if existingErr != nil {
		r.recordRun(ctx, comp.ID, "existing_matches", scoreboardStart, existingErr)
		return competitionResult{
			live: liveCandidate, active: activeCandidate,
			stateReliable: bracketErr == nil,
			err:           errors.Join(bracketErr, backlogErr, existingErr),
		}
	}

	matchStart := time.Now()
	matchResult, processErr := r.processMatches(
		ctx, comp, season, matches, existing, slowTick, backfill,
	)
	r.recordRun(ctx, comp.ID, "matches", matchStart, processErr)

	var refreshErrors []error
	if matchResult.finalized || slowTick {
		refreshErrors = append(refreshErrors,
			r.refreshStandings(ctx, comp, season),
			r.refreshTopScorers(ctx, comp, season),
		)
	}
	return competitionResult{
		live:          matchResult.live,
		active:        matchResult.active,
		stateReliable: bracketErr == nil,
		backfillDone:  processErr == nil,
		err:           errors.Join(bracketErr, backlogErr, processErr, errors.Join(refreshErrors...)),
	}
}

func mergeCandidate(current, incoming model.Match) model.Match {
	if current.ID == "" {
		return incoming
	}
	if matchStateRank(current.State) >= matchStateRank(incoming.State) {
		incoming, current = current, incoming
	}
	if incoming.Round == "" {
		incoming.Round = current.Round
	}
	incoming.HomePlaceholder = (incoming.HomePlaceholder || current.HomePlaceholder) &&
		isUnresolvedTeam(incoming.Home)
	incoming.AwayPlaceholder = (incoming.AwayPlaceholder || current.AwayPlaceholder) &&
		isUnresolvedTeam(incoming.Away)
	return incoming
}

func isUnresolvedTeam(team model.Team) bool {
	if team.CrestURL != nil && *team.CrestURL != "" {
		return false
	}
	name := strings.ToLower(team.Name)
	return strings.Contains(name, "winner") ||
		strings.Contains(name, "tbd") ||
		strings.Contains(name, "to be determined")
}

func matchStateRank(state model.MatchState) int {
	switch state {
	case model.MatchStateFinished:
		return 3
	case model.MatchStateLive:
		return 2
	case model.MatchStateScheduled:
		return 1
	default:
		return 0
	}
}

func (r *runner) refreshStandings(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	start := time.Now()
	rows, err := r.source.Standings(ctx, comp, season)
	if err == nil {
		err = r.repo.ReplaceStandings(ctx, comp.ID, season.ID, rows)
	}
	if errors.Is(err, store.ErrEmptyReplacement) {
		r.log.Info("standings unavailable; preserving existing rows", "comp", comp.ID)
	}
	if err == nil {
		for _, row := range rows {
			r.mirrorCrest(ctx, row.Team)
		}
	}
	r.recordRun(ctx, comp.ID, "standings", start, err)
	return err
}

func (r *runner) refreshTopScorers(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	start := time.Now()
	rows, err := r.source.TopScorers(ctx, comp, season, topScorerLimit)
	if err == nil {
		for index := range rows {
			rows[index] = r.mirrorTopScorer(ctx, rows[index])
		}
		err = r.repo.ReplaceTopScorers(ctx, comp.ID, season.ID, rows)
	}
	if errors.Is(err, store.ErrEmptyReplacement) {
		r.log.Info("top scorers unavailable; preserving existing rows", "comp", comp.ID)
	}
	r.recordRun(ctx, comp.ID, "top_scorers", start, err)
	return err
}

func (r *runner) mirrorTopScorer(ctx context.Context, scorer model.TopScorer) model.TopScorer {
	if r.mirror == nil || scorer.TeamCrestURL == nil || *scorer.TeamCrestURL == "" {
		return scorer
	}
	if isMirroredURL(*scorer.TeamCrestURL, r.mirror.BaseURL()) {
		return scorer
	}
	assetHash := sha256.Sum256([]byte(*scorer.TeamCrestURL))
	assetID := fmt.Sprintf("scorer-%x", assetHash[:8])
	r.mu.Lock()
	cachedURL := r.mirrored[assetID]
	r.mu.Unlock()
	if cachedURL != "" {
		scorer.TeamCrestURL = &cachedURL
		return scorer
	}
	cdnURL, err := r.mirror.Mirror(ctx, "teams", assetID, *scorer.TeamCrestURL)
	if err != nil {
		r.log.Warn("mirror scorer crest", "team", scorer.TeamAbbr, "err", err)
		return scorer
	}
	r.mu.Lock()
	r.mirrored[assetID] = cdnURL
	r.mu.Unlock()
	scorer.TeamCrestURL = &cdnURL
	return scorer
}

func (r *runner) recordRun(
	ctx context.Context,
	compID, kind string,
	started time.Time,
	operationErr error,
) {
	ok := operationErr == nil
	var message string
	if operationErr != nil {
		message = operationErr.Error()
		if len(message) > 2048 {
			message = message[:2048]
		}
		r.log.Warn("ingest operation", "comp", compID, "kind", kind, "err", operationErr)
	}
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if err := r.repo.LogIngestRun(
		logCtx, &compID, kind, started, time.Now(), ok, message,
	); err != nil {
		r.log.Warn("record ingest run", "comp", compID, "kind", kind, "err", err)
	}
}
