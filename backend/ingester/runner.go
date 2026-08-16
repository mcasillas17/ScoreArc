package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	ingestRunRetention      = 30 * 24 * time.Hour
	backfillRefreshInterval = 24 * time.Hour
	backfillRetryInterval   = 30 * time.Minute
	standingSnapshotRunKind = "standings_snapshot"
	winProbSnapshotRunKind  = "win_prob_snapshot"
)

type activity struct {
	known      bool
	active     bool
	live       bool
	emptyPolls int
}

type runner struct {
	competitions  []config.Competition
	source        source.Source
	repo          repository
	mirror        crestMirror
	log           *slog.Logger
	maxConcurrent int

	mu                sync.Mutex
	active            map[string]activity
	mirrored          map[string]string
	rejectedAssets    map[string]struct{}
	backfilled        map[string]time.Time
	backfillAttempted map[string]time.Time
	// snapshotted is the UTC day each competition's standings snapshot has
	// already been written for IN THIS PROCESS. It is a cost gate, not the
	// idempotency guarantee -- that is the unique index in migration 0004. A
	// restart empties this map and the next cycle re-writes the day, which the
	// store upserts.
	snapshotted       map[string]time.Time
	mirrorUnavailable time.Time
	mirrorTimeout     time.Duration
}

func assetCacheKey(kind, id, sourceURL string) string {
	return kind + "\x00" + id + "\x00" + sourceURL
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
	empty         bool
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
			started := false
			defer func() {
				if !started {
					resultMu.Lock()
					cycle.failures++
					cycle.anyLive = cycle.anyLive || previous.live
					resultMu.Unlock()
				}
			}()
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
			lastBackfill := r.backfilled[key]
			lastAttempt := r.backfillAttempted[key]
			backfillInterval := backfillRefreshInterval
			if lastBackfill.IsZero() || lastAttempt.After(lastBackfill) {
				backfillInterval = backfillRetryInterval
			}
			backfill := slowTick &&
				(lastAttempt.IsZero() || time.Since(lastAttempt) >= backfillInterval)
			if backfill {
				r.backfillAttempted[key] = time.Now()
			}
			r.mu.Unlock()
			started = true
			result := r.ingestCompSeason(ctx, comp, season, previous, slowTick, backfill)
			if result.stateReliable {
				r.mu.Lock()
				next := activity{
					known: true, active: result.active, live: result.live,
				}
				if result.empty {
					next.emptyPolls = previous.emptyPolls + 1
					if next.emptyPolls < 2 {
						next.active = true
					}
				}
				r.active[key] = next
				r.mu.Unlock()
			} else if result.active || result.live || previous.emptyPolls > 0 {
				r.mu.Lock()
				previous.known = previous.known || result.active || result.live
				previous.active = previous.active || result.active
				previous.live = previous.live || result.live
				previous.emptyPolls = 0
				r.active[key] = previous
				r.mu.Unlock()
			}
			if backfill && result.backfillDone {
				r.mu.Lock()
				r.backfilled[key] = time.Now()
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

	if slowTick && ctx.Err() == nil {
		start := time.Now()
		var pruneErr error
		for range 10 {
			if ctx.Err() != nil {
				pruneErr = ctx.Err()
				break
			}
			pruneCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			pruned, err := r.repo.PruneIngestRuns(pruneCtx, time.Now().Add(-ingestRunRetention))
			cancel()
			if err != nil {
				r.log.Warn("prune ingest runs", "err", err)
				pruneErr = err
				break
			}
			if pruned < 10000 {
				break
			}
		}
		if pruneErr != nil {
			cycle.failures++
		}
		r.recordGlobalRun(ctx, "prune_ingest_runs", start, pruneErr)
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
	scoreboard, scoreboardErr := r.source.Scoreboard(ctx, comp, season, backfill)
	if scoreboardErr != nil {
		r.recordRun(ctx, comp.ID, "scoreboard_fetch", scoreboardStart, scoreboardErr)
		if !slowTick {
			return competitionResult{err: scoreboardErr}
		}
		scoreboard = nil
	} else {
		r.recordRun(ctx, comp.ID, "scoreboard_fetch", scoreboardStart, nil)
	}

	candidates := make(map[string]model.Match, len(scoreboard))
	activeCandidate := false
	liveCandidate := false
	for _, match := range scoreboard {
		candidates[match.ID] = mergeCandidate(candidates[match.ID], match)
		activeCandidate = activeCandidate || candidateIsActive(match, backfill, time.Now())
		liveCandidate = liveCandidate || match.State == model.MatchStateLive
	}

	var bracketErr error
	var bracketStart time.Time
	if season.HasBracket && (len(scoreboard) > 0 || previous.active || slowTick) && ctx.Err() == nil {
		bracketStart = time.Now()
		var bracket []model.BracketMatch
		bracket, bracketErr = r.source.Bracket(ctx, comp, season, backfill)
		if bracketErr == nil {
			for _, match := range bracket {
				candidate := bracketMatch(match)
				candidates[match.ID] = mergeBracketCandidate(candidates[match.ID], candidate)
				activeCandidate = activeCandidate ||
					candidateIsActive(candidate, backfill, time.Now())
				liveCandidate = liveCandidate || candidate.State == model.MatchStateLive
			}

		}
	}

	var backlogErr error
	if slowTick && ctx.Err() == nil {
		start := time.Now()
		var backlog []model.Match
		backlog, backlogErr = r.repo.UnfinalizedMatches(ctx, comp.ID, season.ID, sourceESPN)
		if backlogErr == nil {
			for _, match := range backlog {
				candidates[match.ID] = mergeCandidate(candidates[match.ID], match)
			}
		}
		r.recordRun(ctx, comp.ID, "finalization_backlog", start, backlogErr)
	}
	if season.HasBracket && backfill && bracketErr == nil {
		for _, match := range candidates {
			if requiresBracketConfirmation(match, season) && !match.BracketConfirmed {
				bracketErr = fmt.Errorf("bracket response missing knockout match %q", match.ID)
				break
			}
		}
	}
	if !bracketStart.IsZero() {
		r.recordRun(ctx, comp.ID, "bracket", bracketStart, bracketErr)
	}

	// Identity before facts: every candidate is resolved to a canonical match
	// id — minting provisional teams and adopting an existing fixture on the
	// natural key as needed — before anything is read or written about it. A
	// candidate that cannot be resolved is dropped from this cycle and reported;
	// the rest still ingest.
	//
	// Candidates arrive keyed by PROVIDER id, and two provider ids can resolve
	// to one canonical match — the crosswalk allows exactly that, and it is what
	// merging a duplicate produces. Both must not survive as separate
	// candidates: they would race for the same row, share and mutate the same
	// `existing` entry, and if the first finalized the second's write would
	// silently match zero rows. They are merged here instead, the same way two
	// payloads for one provider id already are.
	//
	// The iteration order is sorted rather than Go's randomised map order so the
	// merge is reproducible: which payload wins must not flap from cycle to
	// cycle.
	resolveStart := time.Now()
	providerIDs := make([]string, 0, len(candidates))
	for id := range candidates {
		providerIDs = append(providerIDs, id)
	}
	sort.Strings(providerIDs)

	ids := make([]uuid.UUID, 0, len(candidates))
	matches := make([]model.Match, 0, len(candidates))
	identities := make(map[string]store.MatchIdentity, len(candidates))
	positions := make(map[uuid.UUID]int, len(candidates))
	var resolveErrors []error
	for _, id := range providerIDs {
		match := candidates[id]
		identity, err := r.resolveMatch(ctx, comp, season.ID, match)
		if err != nil {
			resolveErrors = append(resolveErrors, fmt.Errorf("match %s: %w", id, err))
			continue
		}
		identities[id] = identity
		if at, duplicate := positions[identity.MatchID]; duplicate {
			merged := mergeCandidate(matches[at], match)
			r.log.Warn("two provider ids resolve to one match; merging",
				"comp", comp.ID, "season", season.ID, "match", identity.MatchID,
				"ids", matches[at].ID+","+id, "kept", merged.ID)
			matches[at] = merged
			continue
		}
		positions[identity.MatchID] = len(matches)
		ids = append(ids, identity.MatchID)
		matches = append(matches, match)
	}
	resolveErr := errors.Join(resolveErrors...)
	if len(candidates) > 0 {
		r.recordRun(ctx, comp.ID, "resolve_identity", resolveStart, resolveErr)
	}

	existingStart := time.Now()
	existing, existingErr := r.repo.ExistingMatches(ctx, comp.ID, season.ID, ids)
	r.recordRun(ctx, comp.ID, "existing_matches", existingStart, existingErr)
	if existingErr != nil {
		return competitionResult{
			live: liveCandidate, active: activeCandidate,
			stateReliable: false,
			empty:         len(scoreboard) == 0 && !activeCandidate,
			err:           errors.Join(bracketErr, backlogErr, resolveErr, existingErr),
		}
	}

	matchStart := time.Now()
	matchResult, processErr := r.processMatches(
		ctx, comp, season, matches, identities, existing, slowTick, backfill,
	)
	r.recordRun(ctx, comp.ID, "matches", matchStart, processErr)

	var refreshErrors []error
	if matchResult.finalized || slowTick {
		refreshErrors = append(refreshErrors,
			r.refreshStandings(ctx, comp, season, matchResult.finalized),
			r.refreshTopScorers(ctx, comp, season),
		)
	}
	coreErr := errors.Join(scoreboardErr, bracketErr, backlogErr, resolveErr, processErr)
	combinedErr := errors.Join(coreErr, errors.Join(refreshErrors...))
	processCanceled := errors.Is(processErr, context.Canceled) ||
		errors.Is(processErr, context.DeadlineExceeded)
	live, active := matchResult.live, matchResult.active
	if processCanceled {
		live = live || liveCandidate
		active = active || activeCandidate
	}
	return competitionResult{
		live:   live,
		active: active,
		stateReliable: scoreboardErr == nil && bracketErr == nil &&
			backlogErr == nil && resolveErr == nil && !processCanceled,
		backfillDone: coreErr == nil,
		empty:        scoreboardErr == nil && len(scoreboard) == 0 && !activeCandidate,
		err:          combinedErr,
	}
}

func mergeCandidate(current, incoming model.Match) model.Match {
	if current.ID == "" {
		return incoming
	}
	sameStateRank := matchStateRank(current.State) == matchStateRank(incoming.State)
	if matchStateRank(current.State) >= matchStateRank(incoming.State) {
		incoming, current = current, incoming
	}
	if incoming.Round == "" {
		incoming.Round = current.Round
	}
	if incoming.BracketRequired == nil {
		incoming.BracketRequired = current.BracketRequired
	}
	if incoming.Note == nil {
		incoming.Note = current.Note
	}
	if sameStateRank {
		incoming.BracketConfirmed =
			incoming.BracketConfirmed || current.BracketConfirmed
	}
	incoming.HomePlaceholder = (incoming.HomePlaceholder || current.HomePlaceholder) &&
		isUnresolvedTeam(incoming.Home)
	incoming.AwayPlaceholder = (incoming.AwayPlaceholder || current.AwayPlaceholder) &&
		isUnresolvedTeam(incoming.Away)
	return incoming
}

func mergeBracketCandidate(scoreboard, bracket model.Match) model.Match {
	merged := mergeCandidate(scoreboard, bracket)
	merged.BracketRequired = bracket.BracketRequired
	merged.BracketConfirmed =
		matchStateRank(bracket.State) >= matchStateRank(merged.State)
	if merged.BracketConfirmed {
		merged.Home = bracket.Home
		merged.Away = bracket.Away
	}
	if bracket.Round != "" {
		merged.Round = bracket.Round
	}
	if merged.BracketConfirmed {
		merged.WinnerID = bracket.WinnerID
	}
	if bracket.Note != nil {
		merged.Note = bracket.Note
	}
	merged.HomePlaceholder = bracket.HomePlaceholder && isUnresolvedTeam(merged.Home)
	merged.AwayPlaceholder = bracket.AwayPlaceholder && isUnresolvedTeam(merged.Away)
	return merged
}

func isUnresolvedTeam(team model.Team) bool {
	if team.CrestURL != nil && *team.CrestURL != "" {
		return false
	}
	name := strings.ToLower(team.Name)
	return strings.Contains(name, "winner") ||
		strings.Contains(name, "loser") ||
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

func candidateIsActive(match model.Match, backfill bool, now time.Time) bool {
	if match.State == model.MatchStateLive {
		return true
	}
	if match.State != model.MatchStateScheduled {
		return false
	}
	if match.StatusName == "STATUS_POSTPONED" {
		return false
	}
	if !backfill {
		return true
	}
	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	return err == nil && !kickoff.After(now.Add(7*24*time.Hour))
}

func (r *runner) refreshStandings(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	tableChanged bool,
) error {
	start := time.Now()
	if err := ctx.Err(); err != nil {
		if tableChanged {
			r.markStandingsSnapshotPending(comp.ID, season.ID)
			r.recordRun(ctx, comp.ID, standingSnapshotRunKind, start, err)
		}
		return err
	}
	rows, err := r.source.Standings(ctx, comp, season)
	teamIDs := make(map[string]string, len(rows))
	if err == nil {
		kind := config.TeamKind(comp)
		for _, row := range rows {
			canonical, resolveErr := r.repo.Team(ctx, sourceESPN, store.TeamRef{
				SourceID: row.Team.ID, Name: row.Team.Name,
				Abbr: row.Team.Abbr, Kind: kind,
			})
			if resolveErr != nil {
				err = fmt.Errorf("resolve standings team %s: %w", row.Team.ID, resolveErr)
				break
			}
			teamIDs[row.Team.ID] = canonical
		}
	}
	if err == nil {
		err = r.repo.ReplaceStandings(ctx, comp.ID, season.ID, sourceESPN, rows, teamIDs)
	}
	if err != nil && tableChanged {
		// Finalization is a one-cycle edge. If its refresh fails, remove the
		// completed-day marker so a later slow tick retries the settled table.
		r.markStandingsSnapshotPending(comp.ID, season.ID)
	}
	if errors.Is(err, store.ErrEmptyReplacement) || errors.Is(err, store.ErrPartialReplacement) {
		r.log.Info("standings replacement rejected; preserving existing rows",
			"comp", comp.ID, "reason", err)
		r.recordRun(ctx, comp.ID, "standings_preserved", start, err)
		return err
	}
	if err == nil {
		for _, row := range rows {
			// The mirror keys crests by canonical team id, because that is what
			// SetTeamCrest writes against.
			team := row.Team
			team.ID = teamIDs[row.Team.ID]
			r.mirrorCrest(ctx, team)
		}
	}
	r.recordRun(ctx, comp.ID, "standings", start, err)
	if err != nil {
		// Only rows the replacement accepted get snapshotted. ReplaceStandings
		// rejects an empty or shrinking table because it is probably an
		// upstream blip; recording the blip as a day of history would bake it
		// in permanently, and unlike `standing` this table is never rewritten.
		return err
	}
	return r.snapshotStandings(ctx, comp, season, rows, teamIDs, tableChanged)
}

// utcDay is the snapshot bucket: midnight UTC. Fixing the boundary in UTC for
// every competition is what lets a Liga MX series and a Premier League series
// share one x-axis. time.Truncate is deliberately not used -- it rounds
// relative to the zero time, not to a calendar day.
func utcDay(at time.Time) time.Time {
	at = at.UTC()
	return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
}

func (r *runner) markStandingsSnapshotPending(competitionID, seasonID string) {
	r.mu.Lock()
	delete(r.snapshotted, competitionID+"/"+seasonID)
	r.mu.Unlock()
}

// snapshotStandings records the day's table. It is called only after
// ReplaceStandings committed, so the snapshot and the live table always agree.
//
// The error is RETURNED rather than swallowed. Player capture is additive and
// a failure there costs a re-fetch; a snapshot not retried before day-end loses
// history no provider can give back, so it must count towards the cycle's
// failures, stay pending, and show up in ingest_run.
func (r *runner) snapshotStandings(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	rows []model.Standing,
	teamIDs map[string]string,
	tableChanged bool,
) error {
	if ctx.Err() != nil {
		if tableChanged {
			r.markStandingsSnapshotPending(comp.ID, season.ID)
		}
		return ctx.Err()
	}
	now := time.Now().UTC()
	day := utcDay(now)
	key := comp.ID + "/" + season.ID

	r.mu.Lock()
	recorded, seen := r.snapshotted[key]
	r.mu.Unlock()
	// A day already recorded is re-recorded only when a match finalized this
	// cycle, because that is the only thing that moves a table. Everything else
	// would be ~52k upserts a day to produce nine rows.
	if seen && recorded.Equal(day) && !tableChanged {
		return nil
	}

	start := time.Now()
	written, err := r.repo.WriteStandingSnapshot(
		ctx, comp.ID, season.ID, rows, teamIDs, now)
	r.recordRun(ctx, comp.ID, standingSnapshotRunKind, start, err)
	if err != nil {
		r.markStandingsSnapshotPending(comp.ID, season.ID)
		r.log.Error("standings snapshot failed; retry remains pending",
			"comp", comp.ID, "season", season.ID, "day", day.Format(time.DateOnly),
			"err", err)
		return err
	}
	r.mu.Lock()
	r.snapshotted[key] = day
	r.mu.Unlock()
	r.log.Info("standings snapshot", "comp", comp.ID, "season", season.ID,
		"day", day.Format(time.DateOnly), "rows", written)
	return nil
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
		err = r.repo.ReplaceTopScorers(ctx, comp.ID, season.ID, sourceESPN, rows)
	}
	if errors.Is(err, store.ErrEmptyReplacement) {
		r.log.Info("top scorers unavailable; preserving existing rows", "comp", comp.ID)
		r.recordRun(ctx, comp.ID, "top_scorers_preserved", start, nil)
		return nil
	}
	if err == nil {
		mirrored := r.mirrorTopScorers(ctx, rows)
		if topScorerCrestsChanged(rows, mirrored) {
			err = r.repo.ReplaceTopScorers(ctx, comp.ID, season.ID, sourceESPN, mirrored)
		}
	}
	r.recordRun(ctx, comp.ID, "top_scorers", start, err)
	return err
}

func (r *runner) mirrorTopScorers(
	ctx context.Context,
	rows []model.TopScorer,
) []model.TopScorer {
	mirrored := append([]model.TopScorer(nil), rows...)
	semaphore := make(chan struct{}, 5)
	var wg sync.WaitGroup
	for index := range mirrored {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				return
			}
			mirrored[index] = r.mirrorTopScorer(ctx, mirrored[index])
		}(index)
	}
	wg.Wait()
	return mirrored
}

func topScorerCrestsChanged(before, after []model.TopScorer) bool {
	for index := range before {
		if index >= len(after) || stringValue(before[index].TeamCrestURL) !=
			stringValue(after[index].TeamCrestURL) {
			return true
		}
	}
	return len(before) != len(after)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
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
	cdnURL, err := r.mirrorAsset(ctx, "teams", assetID, *scorer.TeamCrestURL)
	if errors.Is(err, errMirrorUnavailable) {
		return scorer
	}
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
	r.recordRunFor(ctx, &compID, kind, started, operationErr)
}

func (r *runner) recordGlobalRun(
	ctx context.Context,
	kind string,
	started time.Time,
	operationErr error,
) {
	r.recordRunFor(ctx, nil, kind, started, operationErr)
}

func (r *runner) recordRunFor(
	ctx context.Context,
	compID *string,
	kind string,
	started time.Time,
	operationErr error,
) {
	ok := operationErr == nil
	var message string
	if operationErr != nil {
		message = operationErr.Error()
		if len(message) > 2048 {
			message = message[:2048]
			for !utf8.ValidString(message) {
				message = message[:len(message)-1]
			}
		}
		r.log.Warn("ingest operation", "comp", compID, "kind", kind, "err", operationErr)
	}
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if err := r.repo.LogIngestRun(
		logCtx, compID, kind, started, time.Now(), ok, message,
	); err != nil {
		r.log.Warn("record ingest run", "comp", compID, "kind", kind, "err", err)
	}
}
