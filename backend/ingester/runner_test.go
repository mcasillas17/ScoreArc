package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type fakeSource struct {
	mu              sync.Mutex
	matches         []model.Match
	bracket         []model.BracketMatch
	scoreboardErr   error
	summaryErrors   []error
	summaryCalls    int
	scoreboardCall  int
	scoreboardDelay time.Duration
	currentCalls    int
	maxCalls        int
}

func (f *fakeSource) Name() string { return "fake" }
func (f *fakeSource) Scoreboard(context.Context, config.Competition, config.Season) ([]model.Match, error) {
	f.mu.Lock()
	f.scoreboardCall++
	f.currentCalls++
	if f.currentCalls > f.maxCalls {
		f.maxCalls = f.currentCalls
	}
	delay := f.scoreboardDelay
	matches := f.matches
	err := f.scoreboardErr
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	f.mu.Lock()
	f.currentCalls--
	f.mu.Unlock()
	return matches, err
}
func (f *fakeSource) Summary(context.Context, config.Competition, string) (model.MatchDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := f.summaryCalls
	f.summaryCalls++
	if call < len(f.summaryErrors) && f.summaryErrors[call] != nil {
		return model.MatchDetail{}, f.summaryErrors[call]
	}
	return model.MatchDetail{Scorers: []model.Scorer{{Player: "Winner"}}}, nil
}
func (f *fakeSource) Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error) {
	return []model.Standing{{Rank: 1, Team: model.Team{ID: "home"}}}, nil
}
func (f *fakeSource) TopScorers(context.Context, config.Competition, config.Season, int) ([]model.TopScorer, error) {
	return []model.TopScorer{{Rank: 1, Player: "Winner"}}, nil
}
func (f *fakeSource) Bracket(context.Context, config.Competition, config.Season) ([]model.BracketMatch, error) {
	return f.bracket, nil
}

type fakeRepository struct {
	mu              sync.Mutex
	existing        map[string]store.MatchRow
	finalizeCalls   int
	standingsCalls  int
	topScorersCalls int
}

func (f *fakeRepository) UpsertTeams(context.Context, []model.Team) error { return nil }
func (f *fakeRepository) SetTeamCrest(context.Context, string, string) error {
	return nil
}
func (f *fakeRepository) UpsertMatch(context.Context, string, string, model.Match) error {
	return nil
}
func (f *fakeRepository) UpsertMatchDetail(context.Context, string, model.MatchDetail) error {
	return nil
}
func (f *fakeRepository) FinalizeMatch(
	_ context.Context,
	_, _ string,
	match model.Match,
	_ model.MatchDetail,
) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finalizeCalls++
	if row, ok := f.existing[match.ID]; ok && row.FinalizedAt.Valid {
		return false, nil
	}
	return true, nil
}
func (f *fakeRepository) ExistingMatches(context.Context, string, string) (map[string]store.MatchRow, error) {
	return f.existing, nil
}
func (f *fakeRepository) ReplaceStandings(context.Context, string, string, []model.Standing) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.standingsCalls++
	return nil
}
func (f *fakeRepository) ReplaceTopScorers(context.Context, string, string, []model.TopScorer) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.topScorersCalls++
	return nil
}
func (f *fakeRepository) LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error {
	return nil
}

func testRunner(src *fakeSource, repo *fakeRepository, comp config.Competition) *runner {
	return &runner{
		competitions:  []config.Competition{comp},
		source:        src,
		repo:          repo,
		log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		active:        make(map[string]activity),
		mirrored:      make(map[string]bool),
		maxConcurrent: 3,
	}
}

func finishedMatch() model.Match {
	return model.Match{
		ID: "m1", Kickoff: "2026-06-11T18:00:00Z",
		State: model.MatchStateFinished,
		Home:  model.Team{ID: "home", Name: "Home", Abbr: "HOM"},
		Away:  model.Team{ID: "away", Name: "Away", Abbr: "AWY"},
	}
}

func TestFinishedMatchRetriesSummaryBeforeFinalizing(t *testing.T) {
	src := &fakeSource{
		matches:       []model.Match{finishedMatch()},
		summaryErrors: []error{errors.New("temporary")},
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), false)
	if repo.finalizeCalls != 0 {
		t.Fatalf("finalize calls after failed summary=%d", repo.finalizeCalls)
	}
	runner.runCycle(context.Background(), false)
	if repo.finalizeCalls != 1 {
		t.Fatalf("finalize calls after retry=%d", repo.finalizeCalls)
	}
	if repo.standingsCalls != 1 || repo.topScorersCalls != 1 {
		t.Fatalf("refreshes standings=%d scorers=%d", repo.standingsCalls, repo.topScorersCalls)
	}
}

func TestInitialCycleRunsAndPollingFailurePreservesActivity(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), false)
	if src.scoreboardCall != 1 {
		t.Fatalf("initial scoreboard calls=%d", src.scoreboardCall)
	}

	key := "test/2026"
	runner.active[key] = activity{known: true, active: true}
	src.scoreboardErr = errors.New("provider down")
	runner.runCycle(context.Background(), false)
	if !runner.active[key].active {
		t.Fatal("polling failure marked active competition dormant")
	}
}

func TestBracketUsesRetryableMatchFinalization(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{
		bracket: []model.BracketMatch{{
			ID: match.ID, Round: "final", Kickoff: match.Kickoff,
			State: match.State,
			Home:  model.BracketTeam{ID: match.Home.ID, Name: match.Home.Name, Abbr: match.Home.Abbr},
			Away:  model.BracketTeam{ID: match.Away.ID, Name: match.Away.Name, Abbr: match.Away.Abbr},
		}},
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026", HasBracket: true}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), true)
	if repo.finalizeCalls != 1 || src.summaryCalls != 1 {
		t.Fatalf("finalize=%d summaries=%d", repo.finalizeCalls, src.summaryCalls)
	}
}

func TestFinalizingOneMatchDoesNotHideOtherActiveMatches(t *testing.T) {
	scheduled := finishedMatch()
	scheduled.ID = "scheduled"
	scheduled.State = model.MatchStateScheduled
	src := &fakeSource{matches: []model.Match{scheduled, finishedMatch()}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), false)
	if !runner.active["test/2026"].active {
		t.Fatal("finalized match hid a remaining scheduled match")
	}
}

func TestCycleBoundsCompetitionConcurrency(t *testing.T) {
	src := &fakeSource{scoreboardDelay: 20 * time.Millisecond}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	competitions := make([]config.Competition, 6)
	for index := range competitions {
		id := string(rune('a' + index))
		competitions[index] = config.Competition{
			ID: id, CurrentSeasonId: "2026",
			Seasons: map[string]config.Season{"2026": {ID: "2026"}},
		}
	}
	runner := testRunner(src, repo, competitions[0])
	runner.competitions = competitions

	runner.runCycle(context.Background(), true)
	if src.maxCalls != 3 {
		t.Fatalf("max concurrent scoreboards=%d, want 3", src.maxCalls)
	}
}
