package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type fakeSource struct {
	mu              sync.Mutex
	matches         []model.Match
	bracket         []model.BracketMatch
	bracketErr      error
	scoreboardErr   error
	summaryErrors   []error
	summaryCalls    int
	scoreboardCall  int
	scoreboardDelay time.Duration
	scoreboardBlock bool
	topScorers      []model.TopScorer
	currentCalls    int
	maxCalls        int
}

func (f *fakeSource) Name() string { return "fake" }
func (f *fakeSource) Scoreboard(ctx context.Context, _ config.Competition, _ config.Season, _ bool) ([]model.Match, error) {
	f.mu.Lock()
	f.scoreboardCall++
	f.currentCalls++
	if f.currentCalls > f.maxCalls {
		f.maxCalls = f.currentCalls
	}
	delay := f.scoreboardDelay
	block := f.scoreboardBlock
	matches := f.matches
	err := f.scoreboardErr
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	if block {
		<-ctx.Done()
		err = ctx.Err()
	}
	f.mu.Lock()
	f.currentCalls--
	f.mu.Unlock()
	return matches, err
}
func (f *fakeSource) Summary(context.Context, config.Competition, model.Match) (model.MatchDetail, error) {
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
	if f.topScorers != nil {
		return f.topScorers, nil
	}
	return []model.TopScorer{{Rank: 1, Player: "Winner"}}, nil
}
func (f *fakeSource) Bracket(context.Context, config.Competition, config.Season) ([]model.BracketMatch, error) {
	return f.bracket, f.bracketErr
}

type fakeRepository struct {
	mu              sync.Mutex
	existing        map[string]store.MatchRow
	existingErr     error
	pruneErr        error
	matchCalls      int
	finalizeCalls   int
	standingsCalls  int
	topScorersCalls int
	unfinalized     []model.Match
	logged          []loggedRun
}

type loggedRun struct {
	kind string
	ok   bool
}

func (f *fakeRepository) UpsertTeams(context.Context, []model.Team) error { return nil }
func (f *fakeRepository) SetTeamCrest(context.Context, string, string) error {
	return nil
}
func (f *fakeRepository) UpsertMatch(context.Context, string, string, model.Match) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.matchCalls++
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
func (f *fakeRepository) ExistingMatches(context.Context, string, string, []string) (map[string]store.MatchRow, error) {
	return f.existing, f.existingErr
}
func (f *fakeRepository) UnfinalizedMatches(context.Context, string, string) ([]model.Match, error) {
	return f.unfinalized, nil
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
func (f *fakeRepository) LogIngestRun(_ context.Context, _ *string, kind string, _ time.Time, _ time.Time, ok bool, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logged = append(f.logged, loggedRun{kind: kind, ok: ok})
	return nil
}
func (f *fakeRepository) PruneIngestRuns(context.Context, time.Time) error {
	return f.pruneErr
}

type fakeMirror struct {
	mu    sync.Mutex
	err   error
	calls int
}

func (f *fakeMirror) BaseURL() string { return "https://cdn.example" }
func (f *fakeMirror) Mirror(context.Context, string, string, string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return "https://cdn.example/teams/team", f.err
}

func testRunner(src *fakeSource, repo *fakeRepository, comp config.Competition) *runner {
	return &runner{
		competitions:  []config.Competition{comp},
		source:        src,
		repo:          repo,
		log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		active:        make(map[string]activity),
		mirrored:      make(map[string]string),
		backfilled:    make(map[string]bool),
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
	if src.maxCalls > 3 || src.maxCalls < 2 {
		t.Fatalf("max concurrent scoreboards=%d, want 2..3", src.maxCalls)
	}
}

func TestSlowTickRetriesDurableUnfinalizedBacklog(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:    map[string]store.MatchRow{"m1": {}},
		unfinalized: []model.Match{finishedMatch()},
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), true)
	if repo.finalizeCalls != 1 || src.summaryCalls != 1 {
		t.Fatalf("finalize=%d summaries=%d", repo.finalizeCalls, src.summaryCalls)
	}
}

func TestDuplicateScoreboardAndBracketMatchProcessesOnce(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{
		matches: []model.Match{match},
		bracket: []model.BracketMatch{{
			ID: match.ID, Round: "final", Kickoff: match.Kickoff,
			State: match.State,
			Home:  model.BracketTeam{ID: match.Home.ID, Name: match.Home.Name, Abbr: match.Home.Abbr},
			Away:  model.BracketTeam{ID: match.Away.ID, Name: match.Away.Name, Abbr: match.Away.Abbr},
		}},
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026", HasBracket: true}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), true)
	if src.summaryCalls != 1 || repo.finalizeCalls != 1 {
		t.Fatalf("summaries=%d finalize=%d", src.summaryCalls, repo.finalizeCalls)
	}
}

func TestPollFailureKeepsLastLiveCadenceAndRecordsFailure(t *testing.T) {
	src := &fakeSource{scoreboardErr: errors.New("down")}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	runner.active["test/2026"] = activity{known: true, active: true, live: true}

	result := runner.runCycle(context.Background(), false)
	if !result.anyLive || result.failures == 0 {
		t.Fatalf("result=%+v", result)
	}
	foundFailure := false
	for _, run := range repo.logged {
		if run.kind == "scoreboard_fetch" && !run.ok {
			foundFailure = true
		}
	}
	if !foundFailure {
		t.Fatal("scoreboard failure logged as success")
	}
}

func TestFastTickSkipsKnownDormantCompetition(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	runner.active["test/2026"] = activity{known: true}

	runner.runCycle(context.Background(), false)
	if src.scoreboardCall != 0 {
		t.Fatalf("scoreboard calls=%d", src.scoreboardCall)
	}
}

func TestCanceledCycleDoesNotStartProviderWork(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	runner.runCycle(ctx, false)
	if src.scoreboardCall != 0 || repo.matchCalls != 0 {
		t.Fatalf("scoreboards=%d matches=%d", src.scoreboardCall, repo.matchCalls)
	}
}

func TestCrestFailureDoesNotBlockMatchPersistence(t *testing.T) {
	crest := "https://source.example/crest.png"
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	match.Home.CrestURL = &crest
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	runner.mirror = &fakeMirror{err: errors.New("r2 unavailable")}

	result := runner.runCycle(context.Background(), false)
	if result.failures != 0 || repo.matchCalls != 1 {
		t.Fatalf("result=%+v match calls=%d", result, repo.matchCalls)
	}
}

func TestBracketFailurePreservesPreviousActivity(t *testing.T) {
	src := &fakeSource{bracketErr: errors.New("bracket unavailable")}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026", HasBracket: true}},
	}
	runner := testRunner(src, repo, comp)
	key := "test/2026"
	runner.active[key] = activity{known: true, active: true}

	result := runner.runCycle(context.Background(), true)
	if result.failures != 1 || !runner.active[key].active {
		t.Fatalf("result=%+v activity=%+v", result, runner.active[key])
	}
}

func TestExistingReadFailureKeepsObservedLiveCadence(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateLive
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{
		existing:    map[string]store.MatchRow{},
		existingErr: errors.New("database unavailable"),
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	result := runner.runCycle(context.Background(), false)
	if !result.anyLive || result.failures != 1 {
		t.Fatalf("result=%+v", result)
	}
}

func TestFinishedBacklogWinsOverScheduledProviderRegression(t *testing.T) {
	scheduled := finishedMatch()
	scheduled.State = model.MatchStateScheduled
	src := &fakeSource{matches: []model.Match{scheduled}}
	repo := &fakeRepository{
		existing:    map[string]store.MatchRow{"m1": {}},
		unfinalized: []model.Match{finishedMatch()},
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), true)
	if src.summaryCalls != 1 || repo.finalizeCalls != 1 {
		t.Fatalf("summaries=%d finalizations=%d", src.summaryCalls, repo.finalizeCalls)
	}
}

func TestPruneFailureFailsSlowCycle(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing: map[string]store.MatchRow{},
		pruneErr: errors.New("permission denied"),
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	if result := runner.runCycle(context.Background(), true); result.failures == 0 {
		t.Fatalf("result=%+v", result)
	}
}

func TestFinalizedMatchRetriesUnmirroredCrest(t *testing.T) {
	crest := "https://a.espncdn.com/crest.png"
	match := finishedMatch()
	match.Home.CrestURL = &crest
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {FinalizedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	mirror := &fakeMirror{}
	runner.mirror = mirror

	runner.runCycle(context.Background(), false)
	if mirror.calls != 1 {
		t.Fatalf("mirror calls=%d", mirror.calls)
	}
}

func TestMixedValidAndInvalidConfigurationCountsFailuresSafely(t *testing.T) {
	src := &fakeSource{scoreboardDelay: 10 * time.Millisecond}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	valid := config.Competition{
		ID: "valid", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	invalid := config.Competition{
		ID: "invalid", CurrentSeasonId: "missing",
		Seasons: map[string]config.Season{},
	}
	runner := testRunner(src, repo, valid)
	runner.competitions = []config.Competition{valid, invalid}

	if result := runner.runCycle(context.Background(), false); result.failures != 1 {
		t.Fatalf("result=%+v", result)
	}
}

func TestCycleHonorsContextDeadline(t *testing.T) {
	src := &fakeSource{scoreboardBlock: true}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	started := time.Now()
	result := runner.runCycle(ctx, false)
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("cycle elapsed=%v", elapsed)
	}
	if result.failures != 1 {
		t.Fatalf("result=%+v", result)
	}
}

func TestTopScorerCrestMirrorsOnceAcrossRefreshes(t *testing.T) {
	crest := "https://a.espncdn.com/crest.png"
	src := &fakeSource{topScorers: []model.TopScorer{{
		Rank: 1, Player: "Winner", TeamAbbr: "WIN", TeamCrestURL: &crest,
	}}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	mirror := &fakeMirror{}
	runner.mirror = mirror

	runner.runCycle(context.Background(), true)
	runner.runCycle(context.Background(), true)
	if mirror.calls != 1 {
		t.Fatalf("mirror calls=%d", mirror.calls)
	}
}

func TestSeasonBackfillSkipsScheduledSummaries(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), true)
	if src.summaryCalls != 0 {
		t.Fatalf("summary calls=%d", src.summaryCalls)
	}
}
