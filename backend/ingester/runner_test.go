package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
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
	summaryMatch    model.Match
	summaryHome     *int
	summaryAway     *int
	scoreboardCall  int
	backfillCalls   []bool
	scoreboardDelay time.Duration
	scoreboardBlock bool
	statistics      []byte
	statisticsErr   error
	statisticsCalls int
	currentCalls    int
	maxCalls        int
}

func (f *fakeSource) Name() string { return "fake" }
func (f *fakeSource) Scoreboard(ctx context.Context, _ config.Competition, _ config.Season, backfill bool) ([]model.Match, error) {
	f.mu.Lock()
	f.scoreboardCall++
	f.backfillCalls = append(f.backfillCalls, backfill)
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
func (f *fakeSource) Summary(
	_ context.Context,
	_ config.Competition,
	match model.Match,
) (source.SummaryResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := f.summaryCalls
	f.summaryCalls++
	f.summaryMatch = match
	if call < len(f.summaryErrors) && f.summaryErrors[call] != nil {
		return source.SummaryResult{}, f.summaryErrors[call]
	}
	return source.SummaryResult{
		Detail: model.MatchDetail{Scorers: []model.Scorer{{Player: "Winner"}}},
		// Provider-shaped, exactly as a real source returns it: the team ids
		// here are the provider's, and the ingester is responsible for handing
		// the store canonical ones instead.
		Participation: &model.MatchParticipation{
			HomeTeamSourceID: match.Home.ID,
			AwayTeamSourceID: match.Away.ID,
			Home: []model.SquadPlayer{
				{SourceID: "a1", Name: "Winner", Starter: true},
			},
			Events: []model.PlayerEvent{
				{TeamSourceID: match.Home.ID, PlayerSourceID: "a1",
					PlayerName: "Winner", Type: model.PlayerEventGoal, Minute: "1'"},
			},
		},
		HomeScore: f.summaryHome,
		AwayScore: f.summaryAway,
	}, nil
}
func (f *fakeSource) Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error) {
	return []model.Standing{{Rank: 1, Team: model.Team{ID: "home"}}}, nil
}
func (f *fakeSource) Statistics(context.Context, config.Competition, config.Season) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statisticsCalls++
	if f.statisticsErr != nil {
		return nil, f.statisticsErr
	}
	if f.statistics != nil {
		return append([]byte(nil), f.statistics...), nil
	}
	return []byte(`{"stats":[
		{"name":"goalsLeaders","leaders":[
			{"value":1,"displayValue":"Matches: 1, Goals: 1","athlete":{"displayName":"Winner","team":{}}}
		]},
		{"name":"assistsLeaders","leaders":[
			{"value":1,"displayValue":"Matches: 1, Assists: 1","athlete":{"displayName":"Helper","team":{}}}
		]}
	]}`), nil
}
func (f *fakeSource) Bracket(context.Context, config.Competition, config.Season, bool) ([]model.BracketMatch, error) {
	return f.bracket, f.bracketErr
}

func statisticsPayload(
	t *testing.T,
	goals, assists []model.StatLeader,
) []byte {
	t.Helper()
	type fixtureTeam struct {
		Abbreviation string  `json:"abbreviation"`
		DisplayName  string  `json:"displayName"`
		Logo         *string `json:"logo,omitempty"`
	}
	type fixtureAthlete struct {
		DisplayName string      `json:"displayName"`
		Team        fixtureTeam `json:"team"`
	}
	type fixtureLeader struct {
		Value        int            `json:"value"`
		DisplayValue string         `json:"displayValue,omitempty"`
		Athlete      fixtureAthlete `json:"athlete"`
	}
	type fixtureBlock struct {
		Name    string          `json:"name"`
		Leaders []fixtureLeader `json:"leaders"`
	}

	mapRows := func(rows []model.StatLeader) []fixtureLeader {
		mapped := make([]fixtureLeader, 0, len(rows))
		for _, row := range rows {
			displayValue := ""
			if row.Matches != nil {
				displayValue = fmt.Sprintf("Matches: %d", *row.Matches)
			}
			mapped = append(mapped, fixtureLeader{
				Value:        row.Value,
				DisplayValue: displayValue,
				Athlete: fixtureAthlete{
					DisplayName: row.Player,
					Team: fixtureTeam{
						Abbreviation: row.TeamAbbr,
						DisplayName:  row.TeamName,
						Logo:         row.TeamCrestURL,
					},
				},
			})
		}
		return mapped
	}

	raw, err := json.Marshal(struct {
		Stats []fixtureBlock `json:"stats"`
	}{Stats: []fixtureBlock{
		{Name: "goalsLeaders", Leaders: mapRows(goals)},
		{Name: "assistsLeaders", Leaders: mapRows(assists)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// fakeTeamID and fakeMatchID are the fake resolver's crosswalk. They are
// deliberately NOT the identity function: a test that asserts on a provider id
// where a canonical one belongs (or the reverse) has to fail loudly, because
// the whole point of this layer is that the two are different namespaces.
func fakeTeamID(sourceID string) string { return "team-" + sourceID }

func fakeMatchID(sourceID string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(sourceID))
}

type fakeRepository struct {
	mu               sync.Mutex
	existing         map[string]store.MatchRow
	existingErr      error
	existingHook     func()
	pruneErr         error
	pruneRows        []int64
	pruneCalls       int
	pruneHook        func()
	matchCalls       int
	finalizeCalls    int
	lastFinalized    model.Match
	lastUpsert       model.Match
	standingsCalls   int
	standingsErr     error
	leaderCategories []string
	snapshotCalls    int
	snapshotDays     []time.Time
	snapshotErr      error
	unfinalized      []model.Match
	unfinalizedErr   error
	logged           []loggedRun
	lastIdentity     store.MatchIdentity
	teamKinds        map[string]string
	standingTeamIDs  map[string]string
	matchAlias       map[string]string
	upserted         []string
	participation    []*model.MatchParticipation
	participationTo  []string
	participationErr error
}

type loggedRun struct {
	kind string
	ok   bool
}

func hasLoggedKind(runs []loggedRun, kind string) bool {
	for _, run := range runs {
		if run.kind == kind {
			return true
		}
	}
	return false
}

func (f *fakeRepository) Team(_ context.Context, _ string, ref store.TeamRef) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.teamKinds == nil {
		f.teamKinds = map[string]string{}
	}
	f.teamKinds[ref.SourceID] = ref.Kind
	return fakeTeamID(ref.SourceID), nil
}
func (f *fakeRepository) Match(_ context.Context, _ string, ref store.MatchRef) (uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// matchAlias is how a test makes two provider ids resolve to ONE canonical
	// match — exactly what the crosswalk permits once duplicates are merged.
	sourceID := ref.SourceID
	if aliased, ok := f.matchAlias[sourceID]; ok {
		sourceID = aliased
	}
	return fakeMatchID(sourceID), nil
}
func (f *fakeRepository) ApplyTeamSeed(context.Context, []config.SeedTeam) error { return nil }
func (f *fakeRepository) ApplyCompetitionSeed(context.Context, []config.Competition) error {
	return nil
}
func (f *fakeRepository) SetTeamCrest(context.Context, string, string) error {
	return nil
}
func (f *fakeRepository) UpsertMatch(
	_ context.Context,
	identity store.MatchIdentity,
	match model.Match,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.matchCalls++
	f.lastUpsert = match
	f.lastIdentity = identity
	f.upserted = append(f.upserted, match.ID)
	return nil
}
func (f *fakeRepository) UpsertMatchDetail(context.Context, uuid.UUID, model.MatchDetail) error {
	return nil
}
func (f *fakeRepository) WriteParticipation(
	_ context.Context,
	_ string,
	_ uuid.UUID,
	homeTeamID, awayTeamID string,
	part *model.MatchParticipation,
) (store.ParticipationStats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.participation = append(f.participation, part)
	f.participationTo = append(f.participationTo, homeTeamID+"/"+awayTeamID)
	if f.participationErr != nil {
		return store.ParticipationStats{}, f.participationErr
	}
	return store.ParticipationStats{}, nil
}

func (f *fakeRepository) FinalizeMatch(
	_ context.Context,
	identity store.MatchIdentity,
	match model.Match,
	_ model.MatchDetail,
) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finalizeCalls++
	f.lastFinalized = match
	f.lastIdentity = identity
	if row, ok := f.existing[match.ID]; ok && row.FinalizedAt.Valid {
		return false, nil
	}
	return true, nil
}

// ExistingMatches re-keys the fixture onto canonical ids on every call, so a
// test can still write `existing: map[string]store.MatchRow{"m1": {...}}` in
// provider terms and can still swap a row in between cycles.
func (f *fakeRepository) ExistingMatches(
	_ context.Context,
	_, _ string,
	_ []uuid.UUID,
) (map[uuid.UUID]store.MatchRow, error) {
	if f.existingHook != nil {
		f.existingHook()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	byMatchID := make(map[uuid.UUID]store.MatchRow, len(f.existing))
	for sourceID, row := range f.existing {
		byMatchID[fakeMatchID(sourceID)] = row
	}
	return byMatchID, f.existingErr
}
func (f *fakeRepository) UnfinalizedMatches(context.Context, string, string, string) ([]model.Match, error) {
	return f.unfinalized, f.unfinalizedErr
}
func (f *fakeRepository) ReplaceStandings(
	_ context.Context,
	_, _, _ string,
	_ []model.Standing,
	teamIDs map[string]string,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.standingsCalls++
	f.standingTeamIDs = teamIDs
	return f.standingsErr
}
func (f *fakeRepository) WriteStandingSnapshot(
	_ context.Context,
	_, _ string,
	standings []model.Standing,
	_ map[string]string,
	capturedAt time.Time,
) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshotCalls++
	f.snapshotDays = append(f.snapshotDays, utcDay(capturedAt))
	if f.snapshotErr != nil {
		return 0, f.snapshotErr
	}
	return len(standings), nil
}
func (f *fakeRepository) ReplaceLeaders(
	_ context.Context,
	_, _, _, category string,
	rows []model.StatLeader,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(rows) == 0 {
		return store.ErrEmptyReplacement
	}
	f.leaderCategories = append(f.leaderCategories, category)
	return nil
}
func (f *fakeRepository) LogIngestRun(_ context.Context, _ *string, kind string, _ time.Time, _ time.Time, ok bool, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logged = append(f.logged, loggedRun{kind: kind, ok: ok})
	return nil
}
func (f *fakeRepository) PruneIngestRuns(context.Context, time.Time) (int64, error) {
	if f.pruneHook != nil {
		f.pruneHook()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pruneCalls++
	if len(f.pruneRows) == 0 {
		return 0, f.pruneErr
	}
	rows := f.pruneRows[0]
	f.pruneRows = f.pruneRows[1:]
	return rows, f.pruneErr
}

type fakeMirror struct {
	mu      sync.Mutex
	err     error
	errors  map[string]error
	calls   int
	callIDs []string
	block   bool
}

func (f *fakeMirror) BaseURL() string { return "https://cdn.example" }
func (f *fakeMirror) Mirror(ctx context.Context, _, id, _ string) (string, error) {
	f.mu.Lock()
	f.calls++
	f.callIDs = append(f.callIDs, id)
	block := f.block
	err := f.err
	if idErr := f.errors[id]; idErr != nil {
		err = idErr
	}
	f.mu.Unlock()
	if block {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return "https://cdn.example/teams/" + id, err
}

func testRunner(src *fakeSource, repo *fakeRepository, comp config.Competition) *runner {
	return &runner{
		competitions:      []config.Competition{comp},
		source:            src,
		repo:              repo,
		log:               slog.New(slog.NewTextHandler(io.Discard, nil)),
		active:            make(map[string]activity),
		mirrored:          make(map[string]string),
		rejectedAssets:    make(map[string]struct{}),
		backfilled:        make(map[string]time.Time),
		backfillAttempted: make(map[string]time.Time),
		snapshotted:       make(map[string]time.Time),
		maxConcurrent:     3,
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
	if repo.standingsCalls != 1 || src.statisticsCalls != 1 ||
		len(repo.leaderCategories) != 2 {
		t.Fatalf(
			"refreshes standings=%d statistics=%d leaders=%v",
			repo.standingsCalls, src.statisticsCalls, repo.leaderCategories,
		)
	}
}

// Two provider ids can resolve to ONE canonical match — the crosswalk exists to
// allow it. As separate candidates they raced for the same row, shared and
// mutated the same `existing` entry, and (Go map order being randomised) which
// payload won flapped from cycle to cycle. They must be merged into one
// candidate, deterministically.
func TestDuplicateProviderIDsForOneMatchBecomeOneCandidate(t *testing.T) {
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	round := "Matchday 1"
	for attempt := range 20 { // map order is randomised per run, so repeat
		scoreboard := finishedMatch()
		scoreboard.State = model.MatchStateScheduled
		duplicate := scoreboard
		duplicate.ID = "m1-duplicate"
		duplicate.Round = round

		src := &fakeSource{matches: []model.Match{scoreboard, duplicate}}
		repo := &fakeRepository{
			existing:   map[string]store.MatchRow{},
			matchAlias: map[string]string{"m1-duplicate": "m1"},
		}
		runner := testRunner(src, repo, comp)
		runner.runCycle(context.Background(), false)

		if repo.matchCalls != 1 {
			t.Fatalf("attempt %d: match writes=%d (%v), want exactly one per canonical match",
				attempt, repo.matchCalls, repo.upserted)
		}
		// Deterministic, not whichever the map handed over first — and the
		// merge keeps what only one of the two payloads carried.
		if repo.lastUpsert.ID != "m1" {
			t.Fatalf("attempt %d: kept candidate %q, want the stable choice m1",
				attempt, repo.lastUpsert.ID)
		}
		if repo.lastUpsert.Round != round {
			t.Fatalf("attempt %d: merged candidate lost the duplicate's round: %q",
				attempt, repo.lastUpsert.Round)
		}
		if repo.lastIdentity.MatchID != fakeMatchID("m1") {
			t.Fatalf("attempt %d: wrote against %v, want the canonical id",
				attempt, repo.lastIdentity.MatchID)
		}
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

// The store resolves players against provider ids, but appearances key on
// canonical TEAM ids. Handing it the provider's ids instead would violate the
// team foreign key — or worse, match a canonical id that happens to collide.
func TestParticipationIsWrittenWithCanonicalTeamIDs(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	runner := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	runner.runCycle(context.Background(), true)

	if len(repo.participation) != 1 {
		t.Fatalf("expected 1 participation write, got %d", len(repo.participation))
	}
	want := fakeTeamID(match.Home.ID) + "/" + fakeTeamID(match.Away.ID)
	if got := repo.participationTo[0]; got != want {
		t.Errorf("participation written for %q, want canonical %q", got, want)
	}
	// The payload itself must stay in provider shape — the store maps it.
	if got := repo.participation[0].HomeTeamSourceID; got != match.Home.ID {
		t.Errorf("participation payload home source id = %q, want %q", got, match.Home.ID)
	}
}

// Player capture is additive. A match's scoreline is already written by the
// time it runs, so a participation failure must be reported without stopping
// the match from ingesting.
func TestParticipationFailureDoesNotBlockTheMatch(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{
		existing:         map[string]store.MatchRow{},
		participationErr: errors.New("boom"),
	}
	runner := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	result := runner.runCycle(context.Background(), true)

	if repo.finalizeCalls != 1 {
		t.Errorf("participation failure blocked finalization: finalize=%d", repo.finalizeCalls)
	}
	if result.failures == 0 {
		t.Error("participation failure was swallowed instead of reported")
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

func TestSlowTickRetriesBacklogDuringScoreboardFailure(t *testing.T) {
	src := &fakeSource{scoreboardErr: errors.New("scoreboard unavailable")}
	repo := &fakeRepository{
		existing:    map[string]store.MatchRow{"m1": {}},
		unfinalized: []model.Match{finishedMatch()},
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	result := testRunner(src, repo, comp).runCycle(context.Background(), true)

	if result.failures == 0 || repo.finalizeCalls != 1 || src.summaryCalls != 1 {
		t.Fatalf(
			"result=%+v finalize=%d summaries=%d",
			result, repo.finalizeCalls, src.summaryCalls,
		)
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

func TestCrestOutageCircuitDoesNotBlockMatchPersistence(t *testing.T) {
	crest := "https://source.example/crest.png"
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	match.Home.CrestURL = &crest
	match.Away.CrestURL = &crest
	second := match
	second.ID = "m2"
	src := &fakeSource{matches: []model.Match{match, second}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	mirror := &fakeMirror{block: true}
	runner.mirror = mirror
	runner.mirrorTimeout = time.Millisecond

	result := runner.runCycle(context.Background(), false)
	if result.failures != 0 || repo.matchCalls != 2 || mirror.calls != 1 {
		t.Fatalf("result=%+v match calls=%d", result, repo.matchCalls)
	}
}

func TestRejectedCrestDoesNotOpenMirrorOutageCircuit(t *testing.T) {
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(
		&fakeSource{},
		&fakeRepository{existing: map[string]store.MatchRow{}},
		comp,
	)
	mirror := &fakeMirror{errors: map[string]error{
		"bad": fmt.Errorf("%w: unsupported content type", assets.ErrAssetRejected),
	}}
	runner.mirror = mirror
	badURL := "https://a.espncdn.com/bad.svg"
	goodURL := "https://a.espncdn.com/good.png"

	runner.mirrorCrest(context.Background(), model.Team{ID: "bad", CrestURL: &badURL})
	runner.mirrorCrest(context.Background(), model.Team{ID: "good", CrestURL: &goodURL})
	runner.mirrorCrest(context.Background(), model.Team{ID: "bad", CrestURL: &badURL})

	if mirror.calls != 2 || len(mirror.callIDs) != 2 ||
		mirror.callIDs[0] != "bad" || mirror.callIDs[1] != "good" {
		t.Fatalf("calls=%d ids=%v", mirror.calls, mirror.callIDs)
	}
	if runner.mirrored["good"] == "" || !runner.mirrorUnavailable.IsZero() {
		t.Fatalf(
			"good crest=%q mirror unavailable=%v",
			runner.mirrored["good"],
			runner.mirrorUnavailable,
		)
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

func TestCanceledPruneIsAuditedAsFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	repo := &fakeRepository{
		existing:  map[string]store.MatchRow{},
		pruneRows: []int64{10000},
		pruneHook: cancel,
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(&fakeSource{}, repo, comp)

	result := runner.runCycle(ctx, true)

	if result.failures != 1 {
		t.Fatalf("failures=%d", result.failures)
	}
	for _, run := range repo.logged {
		if run.kind == "prune_ingest_runs" {
			if run.ok {
				t.Fatal("canceled prune was audited as successful")
			}
			return
		}
	}
	t.Fatal("canceled prune was not audited")
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

func TestLeaderCrestMirrorsOnceAcrossRefreshes(t *testing.T) {
	crest := "https://a.espncdn.com/crest.png"
	src := &fakeSource{statistics: statisticsPayload(
		t,
		[]model.StatLeader{{
			Rank: 1, Player: "Winner", TeamAbbr: "WIN",
			TeamCrestURL: &crest, Value: 1,
		}},
		[]model.StatLeader{{Rank: 1, Player: "Helper", Value: 1}},
	)}
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

func TestLeaderCrestOutageUsesSharedCircuit(t *testing.T) {
	leaders := make([]model.StatLeader, 10)
	for index := range leaders {
		crest := fmt.Sprintf("https://source.example/%d.png", index)
		leaders[index] = model.StatLeader{
			Rank: index + 1, Player: fmt.Sprintf("Player %d", index),
			TeamAbbr: fmt.Sprintf("T%d", index), TeamCrestURL: &crest, Value: 1,
		}
	}
	src := &fakeSource{statistics: statisticsPayload(
		t,
		leaders,
		[]model.StatLeader{{Rank: 1, Player: "Helper", Value: 1}},
	)}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	mirror := &fakeMirror{block: true}
	runner.mirror = mirror
	runner.mirrorTimeout = time.Millisecond

	result := runner.runCycle(context.Background(), true)

	if result.failures != 0 || len(repo.leaderCategories) != 2 ||
		mirror.calls > 5 {
		t.Fatalf(
			"result=%+v categories=%v mirror calls=%d",
			result, repo.leaderCategories, mirror.calls,
		)
	}
}

// One fetch, two boards. Fetching /statistics twice would double the request
// count for a payload that already contains both.
func TestRefreshLeadersFetchesOnceAndWritesBoth(t *testing.T) {
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	src := &fakeSource{}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	result := testRunner(src, repo, comp).runCycle(context.Background(), true)
	if result.failures != 0 {
		t.Fatalf("result=%+v", result)
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if src.statisticsCalls != 1 {
		t.Fatalf("/statistics fetched %d times, want 1", src.statisticsCalls)
	}
	if len(repo.leaderCategories) != 2 {
		t.Fatalf("categories written = %v, want goals and assists", repo.leaderCategories)
	}
	seen := make(map[string]bool, len(repo.leaderCategories))
	for _, category := range repo.leaderCategories {
		seen[category] = true
	}
	if !seen["goals"] || !seen["assists"] {
		t.Fatalf("categories written = %v, want goals and assists", repo.leaderCategories)
	}
}

// An empty assists board must not take down the goals board. ErrEmptyReplacement
// is already the "preserve what we have" signal for top scorers; it stays that,
// per category.
func TestEmptyAssistsBoardDoesNotFailTheCycle(t *testing.T) {
	src := &fakeSource{statistics: statisticsPayload(
		t,
		[]model.StatLeader{{Rank: 1, Player: "Striker", Value: 1}},
		nil,
	)}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	if result := testRunner(src, repo, comp).runCycle(
		context.Background(), true,
	); result.failures != 0 {
		t.Fatalf("failures = %d, want 0 -- an absent assists board is normal", result.failures)
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

func TestEmptyLeaderBoardsPreserveRowsAndRemainRetryable(t *testing.T) {
	src := &fakeSource{statistics: statisticsPayload(t, nil, nil)}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	runner := testRunner(src, repo, comp)

	result := runner.runCycle(context.Background(), true)
	if result.failures != 0 || runner.backfilled["test/2026"].IsZero() {
		t.Fatalf("result=%+v", result)
	}
	runner.runCycle(context.Background(), true)
	if len(src.backfillCalls) < 2 || src.backfillCalls[len(src.backfillCalls)-1] {
		t.Fatalf("backfill calls=%v", src.backfillCalls)
	}
	foundPreserved := false
	for _, run := range repo.logged {
		foundPreserved = foundPreserved ||
			(run.kind == "leaders_preserved" && run.ok)
	}
	if !foundPreserved {
		t.Fatal("missing preserved audit outcome")
	}
}

func TestBracketWinnerOverridesConflictingScoreboardFlag(t *testing.T) {
	wrong := "away"
	correct := "home"
	scoreboard := finishedMatch()
	scoreboard.WinnerID = &wrong
	bracket := scoreboard
	bracket.Round = "quarterfinals"
	bracket.WinnerID = &correct

	merged := mergeBracketCandidate(scoreboard, bracket)
	if merged.WinnerID == nil || *merged.WinnerID != correct ||
		merged.Round != "quarterfinals" {
		t.Fatalf("merged=%+v", merged)
	}
}

func TestConfirmedBracketNoWinnerClearsScoreboardWinner(t *testing.T) {
	scoreboardWinner := "home"
	scoreboard := finishedMatch()
	scoreboard.WinnerID = &scoreboardWinner
	bracket := bracketMatch(model.BracketMatch{
		ID: scoreboard.ID, Round: "final", State: model.MatchStateFinished,
		Home: model.BracketTeam{ID: scoreboard.Home.ID, Name: scoreboard.Home.Name},
		Away: model.BracketTeam{ID: scoreboard.Away.ID, Name: scoreboard.Away.Name},
	})

	merged := mergeBracketCandidate(scoreboard, bracket)

	if merged.WinnerID != nil {
		t.Fatalf("winner=%v", merged.WinnerID)
	}
}

func TestLaggingBracketDoesNotClearFinishedScoreboardWinner(t *testing.T) {
	scoreboardWinner := "home"
	scoreboard := finishedMatch()
	scoreboard.WinnerID = &scoreboardWinner
	bracket := bracketMatch(model.BracketMatch{
		ID: scoreboard.ID, Round: "final", State: model.MatchStateLive,
		Home: model.BracketTeam{ID: "stale-home", Name: "Stale Home"},
		Away: model.BracketTeam{ID: "stale-away", Name: "Stale Away"},
	})

	merged := mergeBracketCandidate(scoreboard, bracket)

	if merged.WinnerID == nil || *merged.WinnerID != scoreboardWinner ||
		merged.BracketConfirmed ||
		merged.Home.ID != scoreboard.Home.ID ||
		merged.Away.ID != scoreboard.Away.ID {
		t.Fatalf("merged=%+v", merged)
	}
}

func TestLaggingBracketConfirmationDoesNotPropagateToFinishedBacklog(t *testing.T) {
	scoreboard := finishedMatch()
	scoreboard.State = model.MatchStateLive
	bracket := bracketMatch(model.BracketMatch{
		ID: scoreboard.ID, Round: "final", State: model.MatchStateLive,
		Home: model.BracketTeam{ID: scoreboard.Home.ID, Name: scoreboard.Home.Name},
		Away: model.BracketTeam{ID: scoreboard.Away.ID, Name: scoreboard.Away.Name},
	})
	provider := mergeBracketCandidate(scoreboard, bracket)
	backlog := finishedMatch()

	merged := mergeCandidate(provider, backlog)

	if merged.BracketConfirmed {
		t.Fatalf("merged=%+v", merged)
	}
}

func TestFinalizationUsesValidatedSummaryScores(t *testing.T) {
	home, away := 2, 1
	src := &fakeSource{
		matches:     []model.Match{finishedMatch()},
		summaryHome: &home,
		summaryAway: &away,
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), false)
	if repo.lastFinalized.HomeScore == nil || *repo.lastFinalized.HomeScore != home ||
		repo.lastFinalized.AwayScore == nil || *repo.lastFinalized.AwayScore != away {
		t.Fatalf("finalized=%+v", repo.lastFinalized)
	}
}

func TestStoredFinishedStateCannotRegressToScheduled(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {State: model.MatchStateFinished},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), false)
	if repo.finalizeCalls != 0 {
		t.Fatalf("finalize calls=%d", repo.finalizeCalls)
	}
}

func TestEmptyScoreboardPreservesKnownActiveStateAndCompletesBackfill(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	key := "test/2026"
	runner.active[key] = activity{known: true, active: true, live: true}

	first := runner.runCycle(context.Background(), true)

	if !runner.active[key].active {
		t.Fatal("unexpected empty feed marked active competition dormant")
	}
	if first.anyLive {
		t.Fatal("successful empty feed preserved stale live cadence")
	}
	if runner.backfilled[key].IsZero() {
		t.Fatal("successful empty feed did not complete full-season backfill")
	}

	runner.runCycle(context.Background(), false)
	if runner.active[key].active {
		t.Fatal("repeated successful empty feed did not mark competition dormant")
	}
}

func TestFutureBackfillFixtureDoesNotMarkCompetitionActive(t *testing.T) {
	now := time.Now()
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	match.Kickoff = now.Add(24 * time.Hour).Format(time.RFC3339)
	if !candidateIsActive(match, true, now) {
		t.Fatal("imminent backfill fixture did not mark competition active")
	}
	match.Kickoff = now.Add(30 * 24 * time.Hour).Format(time.RFC3339)
	if candidateIsActive(match, true, now) {
		t.Fatal("distant future backfill fixture marked competition active")
	}
}

func TestSlowCycleDrainsFullPruneBatches(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:  map[string]store.MatchRow{},
		pruneRows: []int64{10000, 10000, 3},
	}

	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), true)

	if repo.pruneCalls != 3 {
		t.Fatalf("prune calls=%d", repo.pruneCalls)
	}
	if !hasLoggedKind(repo.logged, "prune_ingest_runs") {
		t.Fatal("prune operation was not audited")
	}
}

func TestBracketFailureDoesNotAdvanceDormancy(t *testing.T) {
	src := &fakeSource{bracketErr: errors.New("provider unavailable")}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	season := comp.Seasons[comp.CurrentSeasonId]
	season.HasBracket = true
	comp.Seasons[comp.CurrentSeasonId] = season
	runner := testRunner(src, repo, comp)
	key := comp.ID + "/" + comp.CurrentSeasonId
	runner.active[key] = activity{known: true, active: true, emptyPolls: 1}

	runner.runCycle(context.Background(), true)

	state := runner.active[key]
	if !state.active || state.emptyPolls != 0 {
		t.Fatalf("activity after bracket failure=%+v", state)
	}
}

func TestFailedBackfillUsesRetryInterval(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	key := "test/2026"
	runner.backfillAttempted[key] = time.Now()

	runner.runCycle(context.Background(), true)

	if len(src.backfillCalls) != 1 || src.backfillCalls[0] {
		t.Fatalf("backfill calls=%v", src.backfillCalls)
	}
}

func TestBracketFailureDefersFinalizationUntilRecovery(t *testing.T) {
	src := &fakeSource{
		matches:    []model.Match{finishedMatch()},
		bracketErr: errors.New("bracket unavailable"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), false)
	if repo.finalizeCalls != 0 {
		t.Fatalf("finalization occurred without bracket metadata")
	}

	src.bracketErr = nil
	src.bracket = []model.BracketMatch{{
		ID: "m1", Round: "final", State: model.MatchStateFinished,
		Home: model.BracketTeam{ID: "home", Name: "Home", Abbr: "HOM"},
		Away: model.BracketTeam{ID: "away", Name: "Away", Abbr: "AWY"},
	}}
	runner.runCycle(context.Background(), false)
	if repo.finalizeCalls != 1 {
		t.Fatalf("finalizations after recovery=%d", repo.finalizeCalls)
	}
}

func TestStoredLiveStateCannotRegressToScheduled(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {State: model.MatchStateLive},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	result := testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.matchCalls != 0 {
		t.Fatal("stale scheduled payload overwrote stored live row")
	}
	if !result.anyLive {
		t.Fatal("stored live state did not preserve live cadence")
	}
	if src.summaryCalls != 1 {
		t.Fatalf("stored live match summary calls=%d", src.summaryCalls)
	}
}

func TestBracketFailureStillFinalizesNonKnockoutMatch(t *testing.T) {
	match := finishedMatch()
	bracketRequired := false
	match.BracketRequired = &bracketRequired
	src := &fakeSource{
		matches:    []model.Match{match},
		bracketErr: errors.New("bracket unavailable"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.finalizeCalls != 1 {
		t.Fatalf("non-knockout finalizations=%d", repo.finalizeCalls)
	}
}

func TestBracketFailureDefersPersistedKnockoutFinalization(t *testing.T) {
	match := finishedMatch()
	notRequired := false
	required := true
	match.Round = ""
	match.BracketRequired = &notRequired
	src := &fakeSource{
		matches:    []model.Match{match},
		bracketErr: errors.New("bracket unavailable"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {
			State:           model.MatchStateFinished,
			Round:           "final",
			BracketRequired: &required,
		},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.finalizeCalls != 0 {
		t.Fatalf("persisted knockout finalizations=%d", repo.finalizeCalls)
	}
}

func TestBracketCandidateOwnsTeamsAndClassification(t *testing.T) {
	notRequired := false
	scoreboard := finishedMatch()
	scoreboard.BracketRequired = &notRequired
	scoreboard.Home = model.Team{ID: "scoreboard-home", Name: "Scoreboard Home"}
	bracket := bracketMatch(model.BracketMatch{
		ID: scoreboard.ID, Round: "final", State: model.MatchStateFinished,
		Home: model.BracketTeam{ID: "bracket-home", Name: "Bracket Home"},
		Away: model.BracketTeam{ID: "bracket-away", Name: "Bracket Away"},
	})

	merged := mergeBracketCandidate(scoreboard, bracket)

	if merged.Home.ID != "bracket-home" || merged.Away.ID != "bracket-away" ||
		merged.BracketRequired == nil || !*merged.BracketRequired ||
		!merged.BracketConfirmed {
		t.Fatalf("merged bracket candidate=%+v", merged)
	}
}

func TestBracketOutagePreservesStoredFieldsButUsesProviderTeamsForSummary(t *testing.T) {
	required := true
	winner := "stored-home"
	match := finishedMatch()
	match.State = model.MatchStateLive
	match.Home = model.Team{ID: "scoreboard-home", Name: "Scoreboard Home"}
	match.Away = model.Team{ID: "scoreboard-away", Name: "Scoreboard Away"}
	scoreboardWinner := "scoreboard-away"
	match.WinnerID = &scoreboardWinner
	match.BracketRequired = &required
	src := &fakeSource{
		matches:    []model.Match{match},
		bracketErr: errors.New("bracket unavailable"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {
			State:           model.MatchStateLive,
			Round:           "final",
			BracketRequired: &required,
			WinnerID:        &winner,
			Home:            model.Team{ID: "stored-home", Name: "Stored Home"},
			Away:            model.Team{ID: "stored-away", Name: "Stored Away"},
			HomePlaceholder: true,
		},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.lastUpsert.Home.ID != "stored-home" ||
		repo.lastUpsert.Away.ID != "stored-away" ||
		!repo.lastUpsert.HomePlaceholder ||
		repo.lastUpsert.WinnerID == nil || *repo.lastUpsert.WinnerID != winner {
		t.Fatalf("scoreboard overwrote stored bracket fields: %+v", repo.lastUpsert)
	}
	if src.summaryMatch.Home.ID != "scoreboard-home" ||
		src.summaryMatch.Away.ID != "scoreboard-away" {
		t.Fatalf("summary used stale bracket teams: %+v", src.summaryMatch)
	}
}

func TestChangedTeamDoesNotReuseStoredTeamCrestCache(t *testing.T) {
	incomingCrest := "https://source.example/new.png"
	storedCrest := "https://cdn.example/teams/old"
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	match.Home = model.Team{ID: "new-home", Name: "New Home", CrestURL: &incomingCrest}
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {
			State: model.MatchStateScheduled,
			Home:  model.Team{ID: "old-home", CrestURL: &storedCrest},
			Away:  match.Away,
		},
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

func TestBracketFailureDoesNotHideNewLiveActivity(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateLive
	src := &fakeSource{
		matches:    []model.Match{match},
		bracketErr: errors.New("bracket unavailable"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}
	runner := testRunner(src, repo, comp)

	result := runner.runCycle(context.Background(), true)

	if !result.anyLive || !runner.active["test/2026"].active {
		t.Fatalf("result=%+v activity=%+v", result, runner.active["test/2026"])
	}
}

func TestBacklogFailureDoesNotAdvanceEmptyDormancy(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:       map[string]store.MatchRow{},
		unfinalizedErr: errors.New("backlog unavailable"),
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	key := "test/2026"
	runner.active[key] = activity{known: true, active: true, emptyPolls: 1}

	runner.runCycle(context.Background(), true)

	if !runner.active[key].active || runner.active[key].emptyPolls != 0 {
		t.Fatalf("activity after backlog failure=%+v", runner.active[key])
	}
}

func TestBackfillMissingKnockoutBracketRemainsRetryable(t *testing.T) {
	match := finishedMatch()
	required := true
	match.BracketRequired = &required
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:    map[string]store.MatchRow{"m1": {}},
		unfinalized: []model.Match{match},
	}

	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}
	runner := testRunner(src, repo, comp)

	result := runner.runCycle(context.Background(), true)

	if result.failures != 1 || !runner.backfilled["test/2026"].IsZero() {
		t.Fatalf("result=%+v backfilled=%v", result, runner.backfilled["test/2026"])
	}
}

func TestBackfillUnresolvedBracketClassificationRemainsRetryable(t *testing.T) {
	match := finishedMatch()
	match.BracketRequired = nil
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}
	runner := testRunner(src, repo, comp)

	result := runner.runCycle(context.Background(), true)

	if result.failures == 0 || !runner.backfilled["test/2026"].IsZero() {
		t.Fatalf("result=%+v backfilled=%v", result, runner.backfilled["test/2026"])
	}
}

func TestNonBracketSeasonIgnoresProviderKnockoutClassification(t *testing.T) {
	match := finishedMatch()
	required := false
	match.BracketRequired = &required
	match.BracketConfirmed = true
	storedRequired := true
	winner := match.Home.ID
	match.WinnerID = &winner
	match.Home.Name = "Fresh Home"
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {
		Round:           "final",
		BracketRequired: &storedRequired,
		Home:            model.Team{ID: match.Home.ID, Name: "Stale Home"},
		Away:            match.Away,
	}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	result := runner.runCycle(context.Background(), true)

	if result.failures != 0 || runner.backfilled["test/2026"].IsZero() {
		t.Fatalf("result=%+v backfilled=%v", result, runner.backfilled["test/2026"])
	}
	if repo.lastFinalized.WinnerID == nil ||
		*repo.lastFinalized.WinnerID != fakeTeamID(winner) ||
		repo.lastFinalized.Home.Name != "Fresh Home" ||
		repo.lastFinalized.Round != "" ||
		repo.lastFinalized.BracketRequired == nil ||
		*repo.lastFinalized.BracketRequired {
		t.Fatalf("finalized match=%+v", repo.lastFinalized)
	}
}

func TestStoredNoteIsRestoredBeforeSummary(t *testing.T) {
	match := finishedMatch()
	note := "Home advances 5-4 on penalties"
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		match.ID: {Note: &note},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), false)

	if src.summaryMatch.Note == nil || *src.summaryMatch.Note != note {
		t.Fatalf("summary match note=%v", src.summaryMatch.Note)
	}
}

func TestAuthoritativeNoWinnerClearsStoredWinner(t *testing.T) {
	match := finishedMatch()
	required := false
	match.BracketRequired = &required
	match.BracketConfirmed = true
	staleWinner := match.Home.ID
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		match.ID: {WinnerID: &staleWinner},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.lastFinalized.WinnerID != nil {
		t.Fatalf("stale winner preserved: %+v", repo.lastFinalized.WinnerID)
	}
}

func TestFailedPollResetsConsecutiveEmptyCount(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}
	runner := testRunner(src, repo, comp)
	key := "test/2026"

	runner.runCycle(context.Background(), true)
	src.scoreboardErr = errors.New("scoreboard unavailable")
	runner.runCycle(context.Background(), true)
	src.scoreboardErr = nil
	runner.runCycle(context.Background(), true)

	state := runner.active[key]
	if !state.active || state.emptyPolls != 1 {
		t.Fatalf("activity after interrupted empty sequence=%+v", state)
	}
}

func TestPartialStandingsReplacementIsPreservedAndRemainsRetryable(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:     map[string]store.MatchRow{},
		standingsErr: store.ErrPartialReplacement,
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	runner := testRunner(src, repo, comp)
	result := runner.runCycle(context.Background(), true)

	preservedFailure := false
	for _, run := range repo.logged {
		preservedFailure = preservedFailure ||
			(run.kind == "standings_preserved" && !run.ok)
	}
	if result.failures == 0 || runner.backfilled["test/2026"].IsZero() ||
		!preservedFailure {
		t.Fatalf("result=%+v logs=%+v", result, repo.logged)
	}
}

func TestCanceledMatchFinalizesWithoutSummaryAndBecomesDormant(t *testing.T) {
	match := finishedMatch()
	match.StatusName = "STATUS_CANCELED"
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	first := runner.runCycle(context.Background(), false)
	if src.summaryCalls != 0 || repo.finalizeCalls != 1 || first.anyLive {
		t.Fatalf("summaries=%d finalizations=%d result=%+v", src.summaryCalls, repo.finalizeCalls, first)
	}

	repo.existing["m1"] = store.MatchRow{
		State:       model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}
	runner.runCycle(context.Background(), true)
	if src.summaryCalls != 0 || repo.finalizeCalls != 1 {
		t.Fatalf("terminal match retried: summaries=%d finalizations=%d", src.summaryCalls, repo.finalizeCalls)
	}
}

func TestSuccessfulEmptyBracketDefersKnockoutFinalization(t *testing.T) {
	match := finishedMatch()
	bracketRequired := true
	match.BracketRequired = &bracketRequired
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.finalizeCalls != 0 {
		t.Fatal("knockout match finalized without bracket membership")
	}
}

func TestCancellationAfterScoreboardPreservesLiveCadence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	src := &fakeSource{matches: []model.Match{{
		ID: "live", Kickoff: time.Now().Format(time.RFC3339),
		State: model.MatchStateLive,
		Home:  model.Team{ID: "home", Name: "Home", Abbr: "HOM"},
		Away:  model.Team{ID: "away", Name: "Away", Abbr: "AWY"},
	}}}
	repo := &fakeRepository{
		existing:     map[string]store.MatchRow{},
		existingHook: cancel,
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	result := runner.runCycle(ctx, false)

	if !result.anyLive {
		t.Fatal("canceled match loop dropped live cadence")
	}
}

func TestBracketFailureKeepsBackfillRetryable(t *testing.T) {
	src := &fakeSource{
		matches:    []model.Match{finishedMatch()},
		bracketErr: errors.New("bracket unavailable"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{
			"2026": {ID: "2026", HasBracket: true},
		},
	}
	runner := testRunner(src, repo, comp)

	runner.runCycle(context.Background(), true)

	if !runner.backfilled["test/2026"].IsZero() {
		t.Fatal("failed bracket marked backfill complete")
	}
}

func TestLiveMatchCanTransitionToPostponed(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	match.StatusName = "STATUS_POSTPONED"
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {State: model.MatchStateLive},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	result := testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.matchCalls != 1 || repo.lastUpsert.State != model.MatchStateScheduled {
		t.Fatalf("upsert calls=%d match=%+v", repo.matchCalls, repo.lastUpsert)
	}
	if result.anyLive {
		t.Fatal("postponed match preserved live cadence")
	}
}

func TestLiveMatchCanTransitionToSuspended(t *testing.T) {
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	match.StatusName = "STATUS_SUSPENDED"
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{
		"m1": {State: model.MatchStateLive},
	}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	result := testRunner(src, repo, comp).runCycle(context.Background(), false)

	if repo.matchCalls != 1 || repo.lastUpsert.State != model.MatchStateScheduled {
		t.Fatalf("upsert calls=%d match=%+v", repo.matchCalls, repo.lastUpsert)
	}
	if result.anyLive {
		t.Fatal("suspended match preserved live cadence")
	}
}

// winnerId arrives as a PROVIDER team id inside a payload that is otherwise all
// canonical by the time it is written. Nothing catches a mistake here: a
// provider id in winner_id either fails a foreign key or, worse, names some
// other club, and the site then shows the wrong team winning.
func TestWinnerIsTranslatedToACanonicalTeamID(t *testing.T) {
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	cases := []struct {
		name   string
		winner *string
		want   *string
	}{
		{name: "home wins", winner: ptr("home"), want: ptr(fakeTeamID("home"))},
		{name: "away wins", winner: ptr("away"), want: ptr(fakeTeamID("away"))},
		{name: "no winner", winner: nil, want: nil},
		// A winner that is neither team cannot be translated, and writing it
		// through would point the row at some third club.
		{name: "winner is not a team in this match", winner: ptr("elsewhere"), want: nil},
		// Already-canonical looking input is still a provider id here, and must
		// not be smuggled through untranslated.
		{name: "canonical-looking id", winner: ptr(fakeTeamID("home")), want: nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			match := finishedMatch()
			match.StatusName = "STATUS_CANCELED" // finalize without a summary
			match.WinnerID = testCase.winner
			repo := &fakeRepository{existing: map[string]store.MatchRow{}}
			runner := testRunner(&fakeSource{matches: []model.Match{match}}, repo, comp)

			runner.runCycle(context.Background(), false)

			got := repo.lastIdentity.WinnerTeamID
			switch {
			case testCase.want == nil && got != nil:
				t.Fatalf("winner = %q, want none", *got)
			case testCase.want != nil && (got == nil || *got != *testCase.want):
				t.Fatalf("winner = %v, want %q", got, *testCase.want)
			}
			if repo.lastIdentity.HomeTeamID != fakeTeamID("home") ||
				repo.lastIdentity.AwayTeamID != fakeTeamID("away") {
				t.Fatalf("teams were not translated: %+v", repo.lastIdentity)
			}
		})
	}
}

func ptr(value string) *string { return &value }

// The World Cup fields national teams; everything else we ingest is contested
// by clubs. The kind decides which canonical team a provider id can resolve to,
// so it has to reach the resolver.
func TestCompetitionDecidesTeamKind(t *testing.T) {
	for slug, want := range map[string]string{"fifa.world": "national", "eng.1": "club"} {
		repo := &fakeRepository{existing: map[string]store.MatchRow{}}
		comp := config.Competition{
			ID: "test", ESPNSlug: slug, CurrentSeasonId: "2026",
			Seasons: map[string]config.Season{"2026": {ID: "2026"}},
		}
		runner := testRunner(&fakeSource{matches: []model.Match{finishedMatch()}}, repo, comp)

		runner.runCycle(context.Background(), false)

		if got := repo.teamKinds["home"]; got != want {
			t.Fatalf("%s resolved teams as kind %q, want %q", slug, got, want)
		}
	}
}

// Standings are written against canonical team ids the runner resolves, never
// against the provider ids the rows arrive with.
func TestStandingsAreWrittenWithResolvedTeamIDs(t *testing.T) {
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	testRunner(&fakeSource{}, repo, comp).runCycle(context.Background(), true)

	if repo.standingTeamIDs["home"] != fakeTeamID("home") {
		t.Fatalf("standings team ids = %v", repo.standingTeamIDs)
	}
}

func TestMergeCandidatePreservesStoredNote(t *testing.T) {
	note := "Home advances on penalties"
	current := finishedMatch()
	current.Note = &note
	incoming := finishedMatch()

	merged := mergeCandidate(current, incoming)

	if merged.Note == nil || *merged.Note != note {
		t.Fatalf("note=%v", merged.Note)
	}
}

func newSnapshotTestRunner(repo *fakeRepository) *runner {
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	return testRunner(&fakeSource{}, repo, comp)
}

// The cadence contract. refreshStandings runs every slow tick; snapshotting
// every one of those is ~52k upserts/day for nine rows of value. Once per UTC
// day is the floor.
func TestStandingsSnapshotWritesOncePerDay(t *testing.T) {
	repo := &fakeRepository{}
	worker := newSnapshotTestRunner(repo)

	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls != 1 {
		t.Fatalf("snapshot calls = %d across two slow ticks in one day, want 1", repo.snapshotCalls)
	}
	if !hasLoggedKind(repo.logged, "standings_snapshot") {
		t.Fatal("the snapshot was not recorded in ingest_run")
	}
}

// A finished match is the only thing that moves a table, so it is the only
// reason to re-record a day already recorded. The store's day key makes the
// rewrite an update, not a duplicate.
func TestStandingsSnapshotRewritesTheDayWhenAMatchFinalizes(t *testing.T) {
	repo := &fakeRepository{}
	worker := newSnapshotTestRunner(repo)

	worker.runCycle(context.Background(), true)
	repo.mu.Lock()
	before := repo.snapshotCalls
	repo.mu.Unlock()

	// The fake source's match finishes, so the next cycle finalizes it.
	source := worker.source.(*fakeSource)
	source.mu.Lock()
	source.matches = []model.Match{finishedMatch()}
	source.mu.Unlock()
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls <= before {
		t.Fatalf("snapshot calls = %d after a finalization, want more than %d",
			repo.snapshotCalls, before)
	}
}

// A restart empties the in-process day gate. The series must survive that --
// and it does, because the gate is an optimisation and the database holds the
// guarantee. A fresh runner re-writes today, and the store upserts it.
func TestStandingsSnapshotSurvivesARestart(t *testing.T) {
	repo := &fakeRepository{}
	newSnapshotTestRunner(repo).runCycle(context.Background(), true)
	newSnapshotTestRunner(repo).runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls != 2 {
		t.Fatalf("snapshot calls = %d across two processes, want 2", repo.snapshotCalls)
	}
	// The day the second process wrote must be the same day, so the store's
	// ON CONFLICT collapses them rather than appending a second table.
	if len(repo.snapshotDays) != 2 || !repo.snapshotDays[0].Equal(repo.snapshotDays[1]) {
		t.Fatalf("snapshot days = %v, want the same UTC day twice", repo.snapshotDays)
	}
}

// A rejected standings replacement must not be snapshotted. ReplaceStandings
// refuses an empty or shrinking table precisely because it is probably an
// upstream blip; recording that blip as a day of history would bake the blip
// in permanently.
func TestStandingsSnapshotSkipsARejectedReplacement(t *testing.T) {
	repo := &fakeRepository{standingsErr: store.ErrPartialReplacement}
	newSnapshotTestRunner(repo).runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls != 0 {
		t.Fatalf("snapshot calls = %d after a rejected replacement, want 0", repo.snapshotCalls)
	}
}

// A failed snapshot must fail the cycle and leave the day gate open so the next
// slow tick retries the irreversible write.
func TestStandingsSnapshotRetriesAfterWriteFailure(t *testing.T) {
	repo := &fakeRepository{snapshotErr: errors.New("snapshot unavailable")}
	worker := newSnapshotTestRunner(repo)

	first := worker.runCycle(context.Background(), true)
	if first.failures == 0 {
		t.Fatal("snapshot failure did not fail the cycle")
	}

	repo.mu.Lock()
	repo.snapshotErr = nil
	repo.mu.Unlock()
	second := worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if second.failures != 0 || repo.snapshotCalls != 2 {
		t.Fatalf("second cycle = %+v, snapshot calls = %d; want a successful retry",
			second, repo.snapshotCalls)
	}
}

func TestStandingsSnapshotRetriesAFailedFinalizationRewrite(t *testing.T) {
	repo := &fakeRepository{}
	worker := newSnapshotTestRunner(repo)
	worker.runCycle(context.Background(), true)

	source := worker.source.(*fakeSource)
	source.mu.Lock()
	source.matches = []model.Match{finishedMatch()}
	source.mu.Unlock()
	repo.mu.Lock()
	repo.snapshotErr = errors.New("snapshot unavailable")
	repo.mu.Unlock()
	failed := worker.runCycle(context.Background(), true)
	if failed.failures == 0 {
		t.Fatal("failed finalization snapshot did not fail the cycle")
	}

	// The finalization edge is one cycle only. The next slow tick must retry
	// without tableChanged carrying the attempt.
	source.mu.Lock()
	source.matches = nil
	source.mu.Unlock()
	repo.mu.Lock()
	repo.snapshotErr = nil
	repo.mu.Unlock()
	retried := worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if retried.failures != 0 || repo.snapshotCalls != 3 {
		t.Fatalf("retry cycle = %+v, snapshot calls = %d; want successful third write",
			retried, repo.snapshotCalls)
	}
}

func TestStandingsSnapshotRetriesAfterFinalizationReplacementIsRejected(t *testing.T) {
	repo := &fakeRepository{}
	worker := newSnapshotTestRunner(repo)
	worker.runCycle(context.Background(), true)

	source := worker.source.(*fakeSource)
	source.mu.Lock()
	source.matches = []model.Match{finishedMatch()}
	source.mu.Unlock()
	repo.mu.Lock()
	repo.standingsErr = store.ErrPartialReplacement
	repo.mu.Unlock()
	failed := worker.runCycle(context.Background(), true)
	if failed.failures == 0 {
		t.Fatal("rejected post-finalization replacement did not fail the cycle")
	}

	source.mu.Lock()
	source.matches = nil
	source.mu.Unlock()
	repo.mu.Lock()
	repo.standingsErr = nil
	repo.mu.Unlock()
	retried := worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if retried.failures != 0 || repo.snapshotCalls != 2 {
		t.Fatalf("retry cycle = %+v, snapshot calls = %d; want one successful retry",
			retried, repo.snapshotCalls)
	}
}

func TestStandingsSnapshotRetriesACanceledFinalizationRewrite(t *testing.T) {
	repo := &fakeRepository{}
	worker := newSnapshotTestRunner(repo)
	worker.runCycle(context.Background(), true)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	comp := worker.competitions[0]
	season := comp.Seasons[comp.CurrentSeasonId]
	err := worker.snapshotStandings(
		ctx,
		comp,
		season,
		[]model.Standing{{Rank: 1, Team: model.Team{ID: "home"}}},
		map[string]string{"home": fakeTeamID("home")},
		true,
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled rewrite error = %v, want context.Canceled", err)
	}

	retried := worker.runCycle(context.Background(), true)
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if retried.failures != 0 || repo.snapshotCalls != 2 {
		t.Fatalf("retry cycle = %+v, snapshot calls = %d; want one successful retry",
			retried, repo.snapshotCalls)
	}
}

func TestStandingsSnapshotRetriesWhenFinalizationRefreshStartsCanceled(t *testing.T) {
	repo := &fakeRepository{}
	worker := newSnapshotTestRunner(repo)
	worker.runCycle(context.Background(), true)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	comp := worker.competitions[0]
	season := comp.Seasons[comp.CurrentSeasonId]
	if err := worker.refreshStandings(ctx, comp, season, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled refresh error = %v, want context.Canceled", err)
	}

	retried := worker.runCycle(context.Background(), true)
	repo.mu.Lock()
	defer repo.mu.Unlock()
	failedRunLogged := false
	for _, run := range repo.logged {
		failedRunLogged = failedRunLogged ||
			(run.kind == standingSnapshotRunKind && !run.ok)
	}
	if !failedRunLogged {
		t.Fatal("canceled finalization snapshot was not audited as failed")
	}
	if retried.failures != 0 || repo.snapshotCalls != 2 {
		t.Fatalf("retry cycle = %+v, snapshot calls = %d; want one successful retry",
			retried, repo.snapshotCalls)
	}
}
