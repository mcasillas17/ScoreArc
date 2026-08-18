package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"
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
	standings       []model.Standing
	standingsErr    error
	rosters         map[string]model.Squad
	rosterErrors    map[string]error
	rosterCalls     []string
	rosterDelay     time.Duration
	rosterCurrent   int
	rosterMax       int
	bios            map[string][]model.TeamHistoryEntry
	bioErrors       map[string]error
	bioCalls        []string
	commentary      []model.CommentaryLine
	plays           model.PlayStream
	playsRaw        []byte
	playsErr        error
	playsCalls      int
	playsEventID    string
	playsHook       func()
	officials       []model.MatchOfficial
	officialsErr    error
	officialsCalls  int
	officialsEvent  string
	officialsHook   func()
	odds            []model.ProviderOdds
	oddsErr         error
	oddsCalls       int
	oddsEvent       string
	oddsHook        func()
	currentCalls    int
	maxCalls        int
	live            bool
	winProbability  *model.WinProbability
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
		Detail: model.MatchDetail{
			Scorers:        []model.Scorer{{Player: "Winner"}},
			WinProbability: f.winProbability,
		},
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
		Commentary: f.commentary,
		HomeScore:  f.summaryHome,
		AwayScore:  f.summaryAway,
	}, nil
}
func (f *fakeSource) Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.standings != nil || f.standingsErr != nil {
		return f.standings, f.standingsErr
	}
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
func (f *fakeSource) Roster(
	ctx context.Context,
	_ config.Competition,
	teamSourceID string,
) (model.Squad, error) {
	f.mu.Lock()
	f.rosterCalls = append(f.rosterCalls, teamSourceID)
	f.rosterCurrent++
	if f.rosterCurrent > f.rosterMax {
		f.rosterMax = f.rosterCurrent
	}
	delay := f.rosterDelay
	err := f.rosterErrors[teamSourceID]
	squad, exists := f.rosters[teamSourceID]
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.rosterCurrent--
		f.mu.Unlock()
	}()

	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return model.Squad{}, ctx.Err()
		case <-timer.C:
		}
	}
	if err != nil {
		return model.Squad{}, err
	}
	if !exists {
		squad = model.Squad{
			TeamSourceID: teamSourceID,
			Players: []model.SquadMember{{
				SourceID: teamSourceID + "-player",
				FullName: teamSourceID + " Player",
			}},
		}
	}
	return squad, nil
}
func (f *fakeSource) AthleteBio(
	_ context.Context,
	_ config.Competition,
	athleteSourceID string,
) ([]model.TeamHistoryEntry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bioCalls = append(f.bioCalls, athleteSourceID)
	if err := f.bioErrors[athleteSourceID]; err != nil {
		return nil, err
	}
	if entries, ok := f.bios[athleteSourceID]; ok {
		return entries, nil
	}
	return []model.TeamHistoryEntry{{
		TeamSourceID: "team-" + athleteSourceID,
		TeamName:     "Team " + athleteSourceID,
		Seasons:      "2025-CURRENT",
	}}, nil
}
func (f *fakeSource) Plays(
	_ context.Context,
	_ config.Competition,
	eventID string,
) (model.PlayStream, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.playsCalls++
	f.playsEventID = eventID
	if f.playsHook != nil {
		f.playsHook()
	}
	return f.plays, append([]byte(nil), f.playsRaw...), f.playsErr
}
func (f *fakeSource) Officials(
	_ context.Context,
	_ config.Competition,
	eventID string,
) ([]model.MatchOfficial, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.officialsCalls++
	f.officialsEvent = eventID
	if f.officialsHook != nil {
		f.officialsHook()
	}
	if f.officialsErr != nil {
		return nil, f.officialsErr
	}
	return append([]model.MatchOfficial(nil), f.officials...), nil
}
func (f *fakeSource) Odds(
	_ context.Context,
	_ config.Competition,
	eventID string,
) ([]model.ProviderOdds, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.oddsCalls++
	f.oddsEvent = eventID
	if f.oddsHook != nil {
		f.oddsHook()
	}
	if f.oddsErr != nil {
		return nil, f.oddsErr
	}
	return append([]model.ProviderOdds(nil), f.odds...), nil
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
	mu                sync.Mutex
	existing          map[string]store.MatchRow
	existingErr       error
	existingHook      func()
	pruneErr          error
	pruneRows         []int64
	pruneCalls        int
	pruneHook         func()
	matchCalls        int
	finalizeCalls     int
	finalizeResult    *bool
	finalizeErr       error
	lastFinalized     model.Match
	lastUpsert        model.Match
	standingsCalls    int
	standingsErr      error
	leaderCategories  []string
	snapshotCalls     int
	snapshotDays      []time.Time
	snapshotErr       error
	topScorersCalls   int
	squadCalls        int
	squadTeams        []string
	squadErrors       map[string]error
	bioCandidates     map[string]uuid.UUID
	bioQueryCalls     int
	bioQueryLimits    []int
	bioStaleBefore    []time.Time
	bioIgnoreLimit    bool
	bioWriteCalls     int
	bioWriteErrors    map[uuid.UUID]error
	unfinalized       []model.Match
	unfinalizedErr    error
	logged            []loggedRun
	lastIdentity      store.MatchIdentity
	teamKinds         map[string]string
	standingTeamIDs   map[string]string
	matchAlias        map[string]string
	upserted          []string
	participation     []*model.MatchParticipation
	participationTo   []string
	participationErr  error
	winProb           []model.WinProbability
	winProbErr        error
	commentary        [][]model.CommentaryLine
	commentaryTo      []uuid.UUID
	commentaryErr     error
	resolvedPlayers   map[string]uuid.UUID
	resolvePlayersErr error
	playWrites        [][]model.Play
	playTeamIDs       []map[string]string
	playPlayerIDs     []map[string]uuid.UUID
	playWriteErr      error
	playWriteHook     func()
	playArchives      []fakePlayArchiveRecord
	playArchiveErr    error
	missingPlays      []store.MissingPlayMatch
	missingPlaysErr   error
	missingPlaysCalls int
	officialRefs      []store.OfficialRef
	officialErr       error
	crewWrites        [][]model.MatchOfficial
	crewIDs           []map[string]uuid.UUID
	crewMatches       []uuid.UUID
	crewWriteErr      error
	fixedOdds         [][]model.ProviderOdds
	fixedOddsMatches  []uuid.UUID
	fixedOddsErr      error
	oddsSnapshots     [][]model.ProviderOdds
	oddsSnapshotAt    []time.Time
	oddsSnapshotErr   error

	// finalCaptureCandidates is the fake's stand-in for the store's real,
	// SQL-driven candidate set: every match FinalizeMatch claimed that is
	// eligible for a post-finalization capture (i.e. not terminal-without-
	// summary). PendingFinalCaptures cross-joins this against both capture
	// kinds, exactly like the real query cross-joins the match table.
	finalCaptureCandidates         []finalCaptureCandidate
	finalCaptureStatus             map[finalCaptureStatusKey]finalCaptureStatusRow
	completeFinalCaptureErr        error
	completeFinalCaptureCalls      int
	scheduleFinalCaptureRetryErr   error
	scheduleFinalCaptureRetryCalls int
	pendingFinalCapturesErr        error
	pendingFinalCapturesCalls      int
	pendingFinalCapturesLimits     []int
	pendingFinalCapturesDueAt      []time.Time
	// pendingFinalCapturesOverride bypasses the candidate/status simulation
	// entirely, for constructing edge cases (like an unrecognised kind) that
	// the real store could return but the fake's own bookkeeping never would.
	pendingFinalCapturesOverride []store.PendingFinalCapture
}

// finalCaptureCandidate is one match/provider-id pair the fake's FinalizeMatch
// has claimed as finalized-with-a-summary. It is intentionally NOT a
// map[uuid.UUID]string: a slice mirrors the store's row-oriented candidate
// set, in claim order, without pretending finalization is keyed uniquely per
// match id ahead of time.
type finalCaptureCandidate struct {
	matchID  uuid.UUID
	sourceID string
}

type finalCaptureStatusKey struct {
	matchID uuid.UUID
	kind    store.FinalCaptureKind
}

// finalCaptureStatusRow is the fake's mirror of one match_final_capture_status
// row. A zero completedAt/retryAt means "unset", matching the real columns'
// NULL.
type finalCaptureStatusRow struct {
	attempts        int
	lastAttemptedAt time.Time
	retryAt         time.Time
	completedAt     time.Time
	lastError       string
}

type fakePlayArchiveRecord struct {
	matchID   uuid.UUID
	key       string
	plays     int
	bytes     int
	touchTier bool
}

func cloneStringMap(values map[string]string) map[string]string {
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}

func cloneUUIDMap(values map[string]uuid.UUID) map[string]uuid.UUID {
	cloned := make(map[string]uuid.UUID, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}

type loggedRun struct {
	kind    string
	ok      bool
	message string
}

func loggedRunsForKind(runs []loggedRun, kind string) []loggedRun {
	var selected []loggedRun
	for _, run := range runs {
		if run.kind == kind {
			selected = append(selected, run)
		}
	}
	return selected
}

func assertOneLoggedRun(t *testing.T, runs []loggedRun, kind string, ok bool, message string) {
	t.Helper()
	selected := loggedRunsForKind(runs, kind)
	if len(selected) != 1 {
		t.Fatalf("%s audit rows = %#v, want exactly one", kind, selected)
	}
	if selected[0].ok != ok || selected[0].message != message {
		t.Fatalf("%s audit row = %#v, want ok=%v message=%q",
			kind, selected[0], ok, message)
	}
}

func hasLoggedKind(runs []loggedRun, kind string) bool {
	for _, run := range runs {
		if run.kind == kind {
			return true
		}
	}
	return false
}

// hasLoggedFailure distinguishes "the capture was audited" from "the capture
// was audited as having failed". An additive capture that swallows its own
// error would still log a run, so presence alone proves nothing.
func hasLoggedFailure(runs []loggedRun, kind string) bool {
	for _, run := range runs {
		if run.kind == kind && !run.ok {
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
func (f *fakeRepository) WriteCommentary(
	_ context.Context,
	matchID uuid.UUID,
	lines []model.CommentaryLine,
) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commentary = append(f.commentary, lines)
	f.commentaryTo = append(f.commentaryTo, matchID)
	if f.commentaryErr != nil {
		return 0, f.commentaryErr
	}
	return len(lines), nil
}
func (f *fakeRepository) ResolveKnownPlayers(
	_ context.Context,
	_ string,
	_ []string,
) (map[string]uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resolvePlayersErr != nil {
		return nil, f.resolvePlayersErr
	}
	resolved := make(map[string]uuid.UUID, len(f.resolvedPlayers))
	for sourceID, playerID := range f.resolvedPlayers {
		resolved[sourceID] = playerID
	}
	return resolved, nil
}
func (f *fakeRepository) WritePlays(
	_ context.Context,
	_ uuid.UUID,
	plays []model.Play,
	teamIDs map[string]string,
	playerIDs map[string]uuid.UUID,
) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.playWriteHook != nil {
		f.playWriteHook()
	}
	f.playWrites = append(f.playWrites, append([]model.Play(nil), plays...))
	f.playTeamIDs = append(f.playTeamIDs, cloneStringMap(teamIDs))
	f.playPlayerIDs = append(f.playPlayerIDs, cloneUUIDMap(playerIDs))
	if f.playWriteErr != nil {
		return 0, f.playWriteErr
	}
	return len(plays), nil
}
func (f *fakeRepository) RecordPlayArchive(
	_ context.Context,
	matchID uuid.UUID,
	key string,
	plays, bytes int,
	touchTier bool,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.playArchives = append(f.playArchives, fakePlayArchiveRecord{
		matchID: matchID, key: key, plays: plays, bytes: bytes, touchTier: touchTier,
	})
	if f.playArchiveErr != nil {
		return f.playArchiveErr
	}
	for index, pending := range f.missingPlays {
		if pending.MatchID == matchID {
			f.missingPlays = append(f.missingPlays[:index], f.missingPlays[index+1:]...)
			break
		}
	}
	return nil
}
func (f *fakeRepository) MatchesMissingPlays(
	_ context.Context,
	_, _, _ string,
	_ int,
) ([]store.MissingPlayMatch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.missingPlaysCalls++
	return append([]store.MissingPlayMatch(nil), f.missingPlays...), f.missingPlaysErr
}

// fakeOfficialID is the fake resolver's official crosswalk. Like fakeTeamID it
// is deliberately NOT the identity function: a test that asserts on a provider
// id where a canonical one belongs has to fail loudly.
func fakeOfficialID(sourceID string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("official-"+sourceID))
}

func (f *fakeRepository) Official(
	_ context.Context,
	_ string,
	ref store.OfficialRef,
) (uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.officialRefs = append(f.officialRefs, ref)
	if f.officialErr != nil {
		return uuid.Nil, f.officialErr
	}
	return fakeOfficialID(ref.SourceID), nil
}

func (f *fakeRepository) WriteMatchOfficials(
	_ context.Context,
	matchID uuid.UUID,
	crew []model.MatchOfficial,
	officialIDs map[string]uuid.UUID,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.crewWrites = append(f.crewWrites, append([]model.MatchOfficial(nil), crew...))
	f.crewIDs = append(f.crewIDs, cloneUUIDMap(officialIDs))
	f.crewMatches = append(f.crewMatches, matchID)
	return f.crewWriteErr
}

func (f *fakeRepository) WriteMatchOdds(
	_ context.Context,
	matchID uuid.UUID,
	providers []model.ProviderOdds,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fixedOdds = append(f.fixedOdds, append([]model.ProviderOdds(nil), providers...))
	f.fixedOddsMatches = append(f.fixedOddsMatches, matchID)
	return f.fixedOddsErr
}

func (f *fakeRepository) WriteOddsSnapshot(
	_ context.Context,
	_ uuid.UUID,
	providers []model.ProviderOdds,
	capturedAt time.Time,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.oddsSnapshots = append(f.oddsSnapshots, append([]model.ProviderOdds(nil), providers...))
	f.oddsSnapshotAt = append(f.oddsSnapshotAt, capturedAt)
	return f.oddsSnapshotErr
}

func (f *fakeRepository) CompleteFinalCapture(
	_ context.Context,
	matchID uuid.UUID,
	kind store.FinalCaptureKind,
	completedAt time.Time,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completeFinalCaptureCalls++
	if f.completeFinalCaptureErr != nil {
		return f.completeFinalCaptureErr
	}
	if f.finalCaptureStatus == nil {
		f.finalCaptureStatus = make(map[finalCaptureStatusKey]finalCaptureStatusRow)
	}
	key := finalCaptureStatusKey{matchID: matchID, kind: kind}
	row := f.finalCaptureStatus[key]
	row.attempts++
	// Completion is monotonic: the earliest completedAt wins, matching the
	// real store's COALESCE rather than overwriting a prior completion.
	if row.completedAt.IsZero() || completedAt.Before(row.completedAt) {
		row.completedAt = completedAt
	}
	row.retryAt = time.Time{}
	row.lastError = ""
	f.finalCaptureStatus[key] = row
	return nil
}

func (f *fakeRepository) ScheduleFinalCaptureRetry(
	ctx context.Context,
	matchID uuid.UUID,
	kind store.FinalCaptureKind,
	attemptedAt, retryAt time.Time,
	cause error,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scheduleFinalCaptureRetryCalls++
	// The real store derives a bounded DB context from ctx (context.WithTimeout),
	// so an already-canceled/deadline-exceeded ctx fails the write immediately,
	// before ever reaching Postgres. Honoring ctx.Err() here first is what makes
	// this fake catch a caller that schedules a retry with a context it knows is
	// already done: it must not "persist" a row a real Store call could not.
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.scheduleFinalCaptureRetryErr != nil {
		return f.scheduleFinalCaptureRetryErr
	}
	if f.finalCaptureStatus == nil {
		f.finalCaptureStatus = make(map[finalCaptureStatusKey]finalCaptureStatusRow)
	}
	key := finalCaptureStatusKey{matchID: matchID, kind: kind}
	row := f.finalCaptureStatus[key]
	// A late retry racing a completion must lose gracefully, matching the
	// real store's `WHERE completed_at IS NULL`.
	if !row.completedAt.IsZero() {
		return nil
	}
	row.attempts++
	// Monotonic like the real GREATEST: an attempt that arrives out of order
	// can only push last_attempted_at/retry_at later, never pull them
	// earlier, and last_error only follows the newest attempt. The real
	// SQL's tie-breaker is `EXCLUDED.last_attempted_at >= ...last_attempted_at`
	// (a same-instant attempt still updates last_error), so this must be
	// !attemptedAt.Before(...), not the stricter attemptedAt.After(...).
	if !attemptedAt.Before(row.lastAttemptedAt) {
		row.lastAttemptedAt = attemptedAt
		row.lastError = cause.Error()
	}
	if retryAt.After(row.retryAt) {
		row.retryAt = retryAt
	}
	f.finalCaptureStatus[key] = row
	return nil
}

// pendingFinalCaptureDue pairs one candidate capture with the sort key
// PendingFinalCaptures orders by: a candidate with no status row at all sorts
// as due immediately (the zero time), matching the real query's oldest-due
// first ordering closely enough for these tests, which never assert an exact
// interleaving across a mix of ages.
type pendingFinalCaptureDue struct {
	capture store.PendingFinalCapture
	sortKey time.Time
}

func (f *fakeRepository) PendingFinalCaptures(
	_ context.Context,
	_, _, _ string,
	dueAt time.Time,
	limit int,
) ([]store.PendingFinalCapture, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pendingFinalCapturesCalls++
	f.pendingFinalCapturesLimits = append(f.pendingFinalCapturesLimits, limit)
	f.pendingFinalCapturesDueAt = append(f.pendingFinalCapturesDueAt, dueAt)
	if f.pendingFinalCapturesErr != nil {
		return nil, f.pendingFinalCapturesErr
	}
	if f.pendingFinalCapturesOverride != nil {
		pending := append([]store.PendingFinalCapture(nil), f.pendingFinalCapturesOverride...)
		if len(pending) > limit {
			pending = pending[:limit]
		}
		return pending, nil
	}

	var due []pendingFinalCaptureDue
	for _, candidate := range f.finalCaptureCandidates {
		for _, kind := range [...]store.FinalCaptureKind{
			store.FinalCaptureOfficials, store.FinalCaptureFixedOdds,
		} {
			key := finalCaptureStatusKey{matchID: candidate.matchID, kind: kind}
			row, hasStatus := f.finalCaptureStatus[key]
			if hasStatus && !row.completedAt.IsZero() {
				continue // already durably complete
			}
			if hasStatus && row.retryAt.After(dueAt) {
				continue // scheduled, but not due yet
			}
			due = append(due, pendingFinalCaptureDue{
				capture: store.PendingFinalCapture{
					MatchID: candidate.matchID, SourceID: candidate.sourceID, Kind: kind,
				},
				sortKey: row.retryAt,
			})
		}
	}
	sort.SliceStable(due, func(i, j int) bool {
		return due[i].sortKey.Before(due[j].sortKey)
	})
	if len(due) > limit {
		due = due[:limit]
	}
	pending := make([]store.PendingFinalCapture, len(due))
	for i, d := range due {
		pending[i] = d.capture
	}
	return pending, nil
}

func (f *fakeRepository) WriteWinProbSnapshot(
	_ context.Context,
	_ uuid.UUID,
	probability model.WinProbability,
	_ time.Time,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.winProbErr != nil {
		return f.winProbErr
	}
	f.winProb = append(f.winProb, probability)
	return nil
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
	if f.finalizeErr != nil {
		return false, f.finalizeErr
	}
	if row, ok := f.existing[match.ID]; ok && row.FinalizedAt.Valid {
		return false, nil
	}
	claimed := true
	if f.finalizeResult != nil {
		claimed = *f.finalizeResult
	}
	// A terminal match (canceled/abandoned/forfeit) finalizes with no summary
	// and never becomes owed an officials or fixed-odds capture, exactly like
	// the real backlog query's status_name exclusion.
	if claimed && !isTerminalWithoutSummary(match) {
		f.finalCaptureCandidates = append(f.finalCaptureCandidates,
			finalCaptureCandidate{matchID: identity.MatchID, sourceID: match.ID})
	}
	return claimed, nil
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
func (f *fakeRepository) ReplaceSquad(
	_ context.Context,
	_, _, teamID, _ string,
	_ []model.SquadMember,
	_ map[string]uuid.UUID,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.squadCalls++
	f.squadTeams = append(f.squadTeams, teamID)
	return f.squadErrors[teamID]
}
func (f *fakeRepository) PlayersNeedingBio(
	_ context.Context,
	_ string,
	staleBefore time.Time,
	limit int,
) (map[string]uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bioQueryCalls++
	f.bioQueryLimits = append(f.bioQueryLimits, limit)
	f.bioStaleBefore = append(f.bioStaleBefore, staleBefore)
	selected := make(map[string]uuid.UUID)
	for sourceID, playerID := range f.bioCandidates {
		if !f.bioIgnoreLimit && len(selected) == limit {
			break
		}
		selected[sourceID] = playerID
	}
	return selected, nil
}
func (f *fakeRepository) ReplaceTeamHistory(
	_ context.Context,
	playerID uuid.UUID,
	_ string,
	_ []model.TeamHistoryEntry,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bioWriteCalls++
	if err := f.bioWriteErrors[playerID]; err != nil {
		return err
	}
	for sourceID, candidateID := range f.bioCandidates {
		if candidateID == playerID {
			delete(f.bioCandidates, sourceID)
		}
	}
	return nil
}
func (f *fakeRepository) LogIngestRun(_ context.Context, _ *string, kind string, _ time.Time, _ time.Time, ok bool, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logged = append(f.logged, loggedRun{kind: kind, ok: ok, message: message})
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

type fakeArchive struct {
	mu     sync.Mutex
	err    error
	size   int
	calls  int
	keys   []string
	bodies [][]byte
}

func (f *fakeArchive) Put(
	_ context.Context,
	key string,
	body []byte,
	metadata assets.PlayArchiveMetadata,
) (assets.ArchivePutResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.keys = append(f.keys, key)
	f.bodies = append(f.bodies, append([]byte(nil), body...))
	if f.err != nil {
		return assets.ArchivePutResult{}, f.err
	}
	return assets.ArchivePutResult{
		Bytes: f.size, Metadata: metadata, Created: true,
	}, nil
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
		squadsRefreshed:   make(map[string]time.Time),
		squadAttempted:    make(map[string]time.Time),
		snapshotted:       make(map[string]time.Time),
		sampleAudit:       make(map[string]auditWindow),
		maxConcurrent:     3,
	}
}

func newTestRunnerWithSource(repo *fakeRepository, source *fakeSource) *runner {
	match := finishedMatch()
	match.State = model.MatchStateScheduled
	if source.live {
		match.State = model.MatchStateLive
	}
	source.matches = []model.Match{match}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	return testRunner(source, repo, comp)
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

func TestCommentaryIsWrittenWithTheCanonicalMatchID(t *testing.T) {
	match := finishedMatch()
	line := model.CommentaryLine{Seq: 1, PlayType: "kickoff", Text: "First Half begins."}
	src := &fakeSource{matches: []model.Match{match}, commentary: []model.CommentaryLine{line}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	runner := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	runner.runCycle(context.Background(), true)

	if len(repo.commentary) != 1 {
		t.Fatalf("expected 1 commentary write, got %d", len(repo.commentary))
	}
	if got, want := repo.commentaryTo[0], fakeMatchID(match.ID); got != want {
		t.Fatalf("commentary written for %s, want canonical match %s", got, want)
	}
	if len(repo.commentary[0]) != 1 || repo.commentary[0][0] != line {
		t.Fatalf("commentary = %#v, want %#v", repo.commentary[0], line)
	}
}

// Commentary is additive to the scoreline, but a finished match must not freeze
// before its relational rows are durable. Otherwise a transient write failure
// becomes permanent because finalized matches skip future summary fetches.
func TestCommentaryFailureLeavesTheFinishedMatchRetryable(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{
		existing:      map[string]store.MatchRow{},
		commentaryErr: errors.New("boom"),
	}
	runner := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	result := runner.runCycle(context.Background(), true)

	if repo.matchCalls != 1 {
		t.Errorf("commentary failure blocked the scoreline row: match writes=%d", repo.matchCalls)
	}
	if repo.finalizeCalls != 0 {
		t.Errorf("commentary failure froze the match before rows were durable: finalize=%d",
			repo.finalizeCalls)
	}
	if result.failures == 0 {
		t.Error("commentary failure was swallowed instead of reported")
	}

	repo.commentaryErr = nil
	result = runner.runCycle(context.Background(), true)
	if repo.finalizeCalls != 1 {
		t.Errorf("finished match did not finalize after commentary recovered: finalize=%d",
			repo.finalizeCalls)
	}
	if len(repo.commentary) != 2 {
		t.Errorf("commentary attempts=%d, want the failed write plus one retry",
			len(repo.commentary))
	}
	if result.failures != 0 {
		t.Errorf("recovery cycle failures=%d, want 0", result.failures)
	}
}

func TestCapturePlaysArchivesBeforeWritingTheAnalysableTier(t *testing.T) {
	playerID := uuid.New()
	src := &fakeSource{
		plays: model.PlayStream{Plays: []model.Play{
			{
				SourceID: "goal", TypeKey: "goal", ScoringPlay: true,
				TeamSourceID: "home", PlayerSourceID: "athlete",
			},
			{SourceID: "pass", TypeKey: "pass", TeamSourceID: "away"},
		}},
		playsRaw: []byte(`{"page":1}`),
	}
	repo := &fakeRepository{
		existing:        map[string]store.MatchRow{},
		resolvedPlayers: map[string]uuid.UUID{"athlete": playerID},
	}
	archive := &fakeArchive{size: 37}
	writeBeforeArchive := false
	repo.playWriteHook = func() {
		archive.mu.Lock()
		defer archive.mu.Unlock()
		writeBeforeArchive = archive.calls == 0
	}
	runner := testRunner(src, repo, config.Competition{ID: "test"})
	runner.archive = archive
	identity := store.MatchIdentity{
		MatchID:    fakeMatchID("m1"),
		HomeTeamID: "team-home", AwayTeamID: "team-away",
		HomeTeamSourceID: "home", AwayTeamSourceID: "away",
	}

	runner.capturePlays(
		context.Background(),
		config.Competition{ID: "test"},
		config.Season{ID: "2026"},
		identity,
		"m1",
	)

	if writeBeforeArchive {
		t.Fatal("Postgres rows were written before the irreplaceable archive")
	}
	if archive.calls != 1 || len(repo.playArchives) != 1 {
		t.Fatalf("archive calls/ledger rows = %d/%d, want 1/1",
			archive.calls, len(repo.playArchives))
	}
	if len(repo.playWrites) != 1 || len(repo.playWrites[0]) != 1 ||
		repo.playWrites[0][0].SourceID != "goal" {
		t.Fatalf("stored plays = %#v, want only the analysable goal", repo.playWrites)
	}
	if got := repo.playTeamIDs[0]; got["home"] != "team-home" || got["away"] != "team-away" {
		t.Fatalf("team crosswalk = %v", got)
	}
	if got := repo.playPlayerIDs[0]["athlete"]; got != playerID {
		t.Fatalf("player crosswalk = %s, want %s", got, playerID)
	}
	record := repo.playArchives[0]
	if record.matchID != identity.MatchID || record.plays != 2 ||
		record.bytes != 37 || !record.touchTier {
		t.Fatalf("archive record = %+v", record)
	}
}

func TestCapturePlaysArchivesAnEmptyStreamSoBackfillConverges(t *testing.T) {
	src := &fakeSource{
		plays:    model.PlayStream{Plays: []model.Play{}},
		playsRaw: []byte(`{"count":0,"items":[]}`),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	archive := &fakeArchive{size: 23}
	runner := testRunner(src, repo, config.Competition{ID: "test"})
	runner.archive = archive

	runner.capturePlays(
		context.Background(),
		config.Competition{ID: "test"},
		config.Season{ID: "2026"},
		store.MatchIdentity{MatchID: fakeMatchID("m1")},
		"m1",
	)

	if archive.calls != 1 || len(repo.playArchives) != 1 {
		t.Fatalf("empty stream archive/ledger = %d/%d, want 1/1",
			archive.calls, len(repo.playArchives))
	}
	if len(repo.playWrites) != 0 {
		t.Fatalf("empty stream wrote rows: %#v", repo.playWrites)
	}
	if repo.playArchives[0].plays != 0 || repo.playArchives[0].touchTier {
		t.Fatalf("empty archive record = %+v", repo.playArchives[0])
	}
}

func TestFinishedMatchCapturesPlaysOnlyAfterFinalization(t *testing.T) {
	match := finishedMatch()
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	capturedBeforeFinalize := false
	src := &fakeSource{
		matches:  []model.Match{match},
		playsRaw: []byte(`{"count":0,"items":[]}`),
		playsHook: func() {
			repo.mu.Lock()
			defer repo.mu.Unlock()
			capturedBeforeFinalize = repo.finalizeCalls == 0
		},
	}
	runner := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})
	runner.archive = &fakeArchive{size: 23}

	runner.runCycle(context.Background(), true)

	if capturedBeforeFinalize {
		t.Fatal("play capture ran before match finalization")
	}
	if repo.finalizeCalls != 1 || src.playsCalls != 1 || src.playsEventID != match.ID {
		t.Fatalf("finalize/plays/event = %d/%d/%q",
			repo.finalizeCalls, src.playsCalls, src.playsEventID)
	}
}

func TestCapturePlaysAuditsArchiveFailureButStillStoresRows(t *testing.T) {
	src := &fakeSource{
		plays: model.PlayStream{Plays: []model.Play{{
			SourceID: "goal", TypeKey: "goal", ScoringPlay: true,
		}}},
		playsRaw: []byte(`{"page":1}`),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	runner := testRunner(src, repo, config.Competition{ID: "test"})
	runner.archive = &fakeArchive{err: errors.New("R2 unavailable")}

	err := runner.capturePlays(
		context.Background(),
		config.Competition{ID: "test"},
		config.Season{ID: "2026"},
		store.MatchIdentity{MatchID: fakeMatchID("m1")},
		"m1",
	)

	if err == nil {
		t.Fatal("archive failure was not returned to the cycle")
	}
	if len(repo.playWrites) != 1 {
		t.Fatalf("archive failure blocked rebuildable rows: writes=%d", len(repo.playWrites))
	}
	failed := false
	for _, run := range repo.logged {
		failed = failed || (run.kind == playStreamRunKind && !run.ok)
	}
	if !failed {
		t.Fatal("archive failure was not audited as a failed play_stream run")
	}
}

func TestCapturePlaysDoesNotLedgerUntilRowsAreDurable(t *testing.T) {
	src := &fakeSource{
		plays: model.PlayStream{Plays: []model.Play{{
			SourceID: "goal", TypeKey: "goal", ScoringPlay: true,
		}}},
		playsRaw: []byte(`{"page":1}`),
	}
	repo := &fakeRepository{
		existing:     map[string]store.MatchRow{},
		playWriteErr: errors.New("database unavailable"),
	}
	runner := testRunner(src, repo, config.Competition{ID: "test"})
	runner.archive = &fakeArchive{size: 23}

	err := runner.capturePlays(
		context.Background(),
		config.Competition{ID: "test"},
		config.Season{ID: "2026"},
		store.MatchIdentity{MatchID: fakeMatchID("m1")},
		"m1",
	)

	if err == nil {
		t.Fatal("want row failure returned")
	}
	if len(repo.playArchives) != 0 {
		t.Fatalf("ledger recorded before rows were durable: %#v", repo.playArchives)
	}
}

func TestSlowTickRetriesFinalizedMatchMissingPlayArchive(t *testing.T) {
	match := finishedMatch()
	matchID := fakeMatchID(match.ID)
	src := &fakeSource{
		matches:  []model.Match{match},
		playsErr: errors.New("temporary core failure"),
		playsRaw: []byte(`{"count":0,"items":[]}`),
	}
	repo := &fakeRepository{
		existing: map[string]store.MatchRow{},
		missingPlays: []store.MissingPlayMatch{{
			MatchID: matchID, SourceID: match.ID,
			HomeTeamID: fakeTeamID(match.Home.ID), AwayTeamID: fakeTeamID(match.Away.ID),
			HomeTeamSourceID: match.Home.ID, AwayTeamSourceID: match.Away.ID,
		}},
	}
	runner := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})
	runner.archive = &fakeArchive{size: 23}

	first := runner.runCycle(context.Background(), false)
	if first.failures == 0 || repo.finalizeCalls != 1 || src.playsCalls != 1 {
		t.Fatalf("first cycle = %+v finalize/plays=%d/%d",
			first, repo.finalizeCalls, src.playsCalls)
	}

	repo.existing[match.ID] = store.MatchRow{
		State: model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{
			Time: time.Now(), Valid: true,
		},
	}
	src.playsErr = nil
	second := runner.runCycle(context.Background(), true)
	if second.failures != 0 {
		t.Fatalf("retry cycle = %+v", second)
	}
	if src.playsCalls != 2 || len(repo.playArchives) != 1 ||
		repo.missingPlaysCalls != 1 {
		t.Fatalf("plays/archives/backlog calls = %d/%d/%d",
			src.playsCalls, len(repo.playArchives), repo.missingPlaysCalls)
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

func squadTestCompetition() config.Competition {
	return config.Competition{
		ID: "test", ESPNSlug: "mex.1", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
}

func squadTestStandings(teamIDs ...string) []model.Standing {
	rows := make([]model.Standing, 0, len(teamIDs))
	for index, teamID := range teamIDs {
		rows = append(rows, model.Standing{
			Rank: index + 1,
			Team: model.Team{ID: teamID, Name: teamID, Abbr: strings.ToUpper(teamID)},
		})
	}
	return rows
}

// ~180 requests once a day is negligible; on every slow tick it is ~52,000.
func TestSquadRefreshRunsOncePerDay(t *testing.T) {
	src := &fakeSource{standings: squadTestStandings("one", "two", "three")}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	worker := testRunner(src, repo, squadTestCompetition())
	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.squadCalls != len(repo.standingTeamIDs) {
		t.Fatalf("squad refreshes = %d across two slow ticks, want one per team (%d)",
			repo.squadCalls, len(repo.standingTeamIDs))
	}
}

// One club's roster failing must not stop the other nineteen.
func TestSquadRefreshContinuesPastOneFailure(t *testing.T) {
	src := &fakeSource{
		standings:    squadTestStandings("one", "two", "three"),
		rosterErrors: map[string]error{"two": errors.New("roster unavailable")},
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	result := testRunner(src, repo, squadTestCompetition()).runCycle(context.Background(), true)

	src.mu.Lock()
	rosterCalls := len(src.rosterCalls)
	src.mu.Unlock()
	repo.mu.Lock()
	squadCalls := repo.squadCalls
	failedRun := hasLoggedKind(repo.logged, "squads") && result.failures > 0
	repo.mu.Unlock()
	if rosterCalls != 3 || squadCalls != 2 {
		t.Fatalf("roster calls = %d, squad writes = %d; want 3 and 2", rosterCalls, squadCalls)
	}
	if !failedRun {
		t.Fatal("partial squad failure was not surfaced in cycle/run telemetry")
	}
}

func TestSquadRefreshRetriesOnlyFailedTeamAfterBackoff(t *testing.T) {
	src := &fakeSource{
		standings:    squadTestStandings("one", "two"),
		rosterErrors: map[string]error{"two": errors.New("temporary")},
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	worker := testRunner(src, repo, squadTestCompetition())
	worker.runCycle(context.Background(), true)

	src.mu.Lock()
	delete(src.rosterErrors, "two")
	src.mu.Unlock()
	worker.runCycle(context.Background(), true)
	worker.squadAttempted["test/2026/two"] = time.Now().Add(-squadRetryInterval)
	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	src.mu.Lock()
	defer src.mu.Unlock()
	if len(src.rosterCalls) != 3 {
		t.Fatalf("roster calls = %d, want 3 (two initial calls, one failed-team retry)",
			len(src.rosterCalls))
	}
	var oneCalls, twoCalls int
	for _, teamID := range src.rosterCalls {
		switch teamID {
		case "one":
			oneCalls++
		case "two":
			twoCalls++
		}
	}
	if oneCalls != 1 || twoCalls != 2 {
		t.Fatalf("roster calls by team = one:%d two:%d, want 1/2", oneCalls, twoCalls)
	}
}

// A fast tick must never trigger it. The fast interval is 20s.
func TestSquadRefreshSkipsFastTicks(t *testing.T) {
	src := &fakeSource{standings: squadTestStandings("one", "two")}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	testRunner(src, repo, squadTestCompetition()).runCycle(context.Background(), false)

	src.mu.Lock()
	rosterCalls := len(src.rosterCalls)
	src.mu.Unlock()
	repo.mu.Lock()
	squadCalls := repo.squadCalls
	repo.mu.Unlock()
	if rosterCalls != 0 || squadCalls != 0 {
		t.Fatalf("fast tick made %d roster calls and %d squad writes, want 0/0",
			rosterCalls, squadCalls)
	}
}

func TestSquadRefreshBoundsConcurrencyAtFive(t *testing.T) {
	teamIDs := []string{"one", "two", "three", "four", "five", "six", "seven", "eight"}
	src := &fakeSource{
		standings:   squadTestStandings(teamIDs...),
		rosterDelay: 20 * time.Millisecond,
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	testRunner(src, repo, squadTestCompetition()).runCycle(context.Background(), true)

	src.mu.Lock()
	defer src.mu.Unlock()
	if src.rosterMax > 5 {
		t.Fatalf("concurrent roster requests = %d, want at most 5", src.rosterMax)
	}
	if src.rosterMax < 2 {
		t.Fatalf("concurrent roster requests = %d, expected bounded parallelism", src.rosterMax)
	}
}

func fakeBioCandidates(count int) map[string]uuid.UUID {
	candidates := make(map[string]uuid.UUID, count)
	for index := range count {
		sourceID := fmt.Sprintf("athlete-%02d", index)
		candidates[sourceID] = fakeMatchID(sourceID)
	}
	return candidates
}

func TestBioRefreshNeverExceedsBatchSize(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:       map[string]store.MatchRow{},
		bioCandidates:  fakeBioCandidates(bioBatchSize + 5),
		bioIgnoreLimit: true,
	}
	worker := testRunner(src, repo, squadTestCompetition())
	if err := worker.refreshBios(context.Background()); err != nil {
		t.Fatal(err)
	}

	src.mu.Lock()
	calls := len(src.bioCalls)
	src.mu.Unlock()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.bioQueryLimits) != 1 || repo.bioQueryLimits[0] != bioBatchSize {
		t.Fatalf("bio query limits = %v, want [%d]", repo.bioQueryLimits, bioBatchSize)
	}
	if calls != bioBatchSize || repo.bioWriteCalls != bioBatchSize {
		t.Fatalf("bio fetches/writes = %d/%d, want %d/%d",
			calls, repo.bioWriteCalls, bioBatchSize, bioBatchSize)
	}
}

func TestBioRefreshUsesThirtyDayCutoff(t *testing.T) {
	repo := &fakeRepository{
		existing:      map[string]store.MatchRow{},
		bioCandidates: fakeBioCandidates(1),
	}
	worker := testRunner(&fakeSource{}, repo, squadTestCompetition())
	before := time.Now().Add(-bioTTL)
	if err := worker.refreshBios(context.Background()); err != nil {
		t.Fatal(err)
	}
	after := time.Now().Add(-bioTTL)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.bioStaleBefore) != 1 ||
		repo.bioStaleBefore[0].Before(before) || repo.bioStaleBefore[0].After(after) {
		t.Fatalf("bio stale cutoff = %v, want between %v and %v",
			repo.bioStaleBefore, before, after)
	}
}

func TestBioRefreshRunsOnlyOnSlowTicksAndOnceGlobally(t *testing.T) {
	repo := &fakeRepository{
		existing:      map[string]store.MatchRow{},
		bioCandidates: fakeBioCandidates(1),
	}
	first := squadTestCompetition()
	first.ID = "first"
	second := squadTestCompetition()
	second.ID = "second"
	worker := testRunner(&fakeSource{}, repo, first)
	worker.competitions = []config.Competition{first, second}

	worker.runCycle(context.Background(), false)
	repo.mu.Lock()
	if repo.bioQueryCalls != 0 {
		repo.mu.Unlock()
		t.Fatalf("fast tick bio queries = %d, want 0", repo.bioQueryCalls)
	}
	repo.mu.Unlock()

	worker.runCycle(context.Background(), true)
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.bioQueryCalls != 1 {
		t.Fatalf("two-competition slow tick bio queries = %d, want one global query",
			repo.bioQueryCalls)
	}
}

func TestBioRefreshContinuesPastOnePlayerFailure(t *testing.T) {
	candidates := fakeBioCandidates(2)
	var failedSourceID string
	var failedPlayerID uuid.UUID
	for sourceID, playerID := range candidates {
		failedSourceID = sourceID
		failedPlayerID = playerID
		break
	}
	src := &fakeSource{bioErrors: map[string]error{
		failedSourceID: errors.New("bio unavailable"),
	}}
	repo := &fakeRepository{
		existing:      map[string]store.MatchRow{},
		bioCandidates: candidates,
	}
	worker := testRunner(src, repo, squadTestCompetition())
	if err := worker.refreshBios(context.Background()); err == nil {
		t.Fatal("expected partial bio failure")
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.bioWriteCalls != 1 {
		t.Fatalf("bio writes after one fetch failure = %d, want 1", repo.bioWriteCalls)
	}
	if _, remains := repo.bioCandidates[failedSourceID]; !remains {
		t.Fatal("failed player was incorrectly marked refreshed")
	}
	if repo.bioCandidates[failedSourceID] != failedPlayerID {
		t.Fatal("failed player's candidate identity changed")
	}
	failedRun := false
	for _, run := range repo.logged {
		failedRun = failedRun || run.kind == "player_bios" && !run.ok
	}
	if !failedRun {
		t.Fatal("partial bio failure was not recorded")
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
	if err := worker.refreshStandings(ctx, comp, season, false, true); !errors.Is(err, context.Canceled) {
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

// A live match's probability is the whole point: it is the only state in which
// the market moves fast enough for a curve to mean anything.
func TestWinProbSnapshotWrittenForALiveMatch(t *testing.T) {
	repo := &fakeRepository{}
	source := &fakeSource{live: true, winProbability: &model.WinProbability{
		Home: 52, Draw: 25, Away: 23,
	}}
	worker := newTestRunnerWithSource(repo, source)

	worker.runCycle(context.Background(), false)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.winProb) != 1 {
		t.Fatalf("win prob writes = %d, want 1", len(repo.winProb))
	}
	if repo.winProb[0].Home != 52 {
		t.Fatalf("home = %v, want 52", repo.winProb[0].Home)
	}
}

// A scheduled match is polled on slow ticks all season. Snapshotting those
// would write ~288 rows a day for every fixture on the calendar to describe a
// market nobody is watching yet. Pre-match drift is a separate feature with a
// separate cadence.
func TestWinProbSnapshotSkippedForAScheduledMatch(t *testing.T) {
	repo := &fakeRepository{}
	source := &fakeSource{winProbability: &model.WinProbability{Home: 40, Draw: 30, Away: 30}}
	worker := newTestRunnerWithSource(repo, source)

	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.winProb) != 0 {
		t.Fatalf("win prob writes = %d for a scheduled match, want 0", len(repo.winProb))
	}
}

// Not every competition has a betting market, and mapWinProbability returns
// nil when there is no usable three-way moneyline. Writing 0/0/0 for those
// would be inventing a market -- worse than an empty curve, because a reader
// cannot tell the difference.
func TestWinProbSnapshotSkippedWhenTheMarketIsAbsent(t *testing.T) {
	repo := &fakeRepository{}
	worker := newTestRunnerWithSource(repo, &fakeSource{live: true, winProbability: nil})

	worker.runCycle(context.Background(), false)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.winProb) != 0 {
		t.Fatalf("win prob writes = %d with no market, want 0", len(repo.winProb))
	}
}

// The snapshot is additive. A failure here must be recorded and must not stop
// a scoreline from ingesting -- unlike the standings snapshot, a lost minute
// of a market curve is not a lost day of league history.
func TestWinProbSnapshotFailureDoesNotStopTheMatch(t *testing.T) {
	repo := &fakeRepository{winProbErr: errors.New("boom")}
	source := &fakeSource{live: true, winProbability: &model.WinProbability{Home: 52, Draw: 25, Away: 23}}
	worker := newTestRunnerWithSource(repo, source)

	worker.runCycle(context.Background(), false)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.matchCalls == 0 {
		t.Fatal("the match was not upserted; an additive write blocked a scoreline")
	}
	if !hasLoggedKind(repo.logged, "win_prob_snapshot") {
		t.Fatal("the failure was not recorded in ingest_run")
	}
}

func crewFixture() []model.MatchOfficial {
	return []model.MatchOfficial{
		{SourceID: "9078", FullName: "Salvador Pérez Villalobos",
			Role: "Referee", RoleID: "1", Order: 1},
		{SourceID: "9079", FullName: "Michel Espinosa",
			Role: "Assistant Referee 1", RoleID: "2", Order: 2},
	}
}

func oddsFixture() []model.ProviderOdds {
	homeMoneyline := -170
	opening := model.OddsLine{HomeMoneyline: &homeMoneyline}
	current := model.OddsLine{HomeMoneyline: &homeMoneyline}
	return []model.ProviderOdds{{
		ProviderID: "100", ProviderName: "DraftKings",
		Open: &opening, Current: &current,
	}}
}

func captureIdentity() store.MatchIdentity {
	return store.MatchIdentity{
		MatchID:    fakeMatchID("m1"),
		HomeTeamID: "team-home", AwayTeamID: "team-away",
		HomeTeamSourceID: "home", AwayTeamSourceID: "away",
	}
}

// forceFinalCaptureRetryDue rewinds every tracked, not-yet-completed final
// capture's retry into the past, so the next backlog sweep treats it as due
// without a test having to wait out the real finalCaptureRetryInterval
// cadence.
func forceFinalCaptureRetryDue(repo *fakeRepository) {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	for key, row := range repo.finalCaptureStatus {
		if row.completedAt.IsZero() {
			row.retryAt = time.Now().Add(-time.Minute)
			repo.finalCaptureStatus[key] = row
		}
	}
}

// Every crew member has to be resolved to a canonical official before the crew
// is written, so "which matches did this referee take" is answerable across
// seasons rather than per match.
func TestCaptureOfficialsResolvesEveryCrewMemberAndWritesOnce(t *testing.T) {
	src := &fakeSource{officials: crewFixture()}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOfficials(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1")

	if src.officialsCalls != 1 || src.officialsEvent != "m1" {
		t.Fatalf("officials fetches=%d event=%q, want 1/m1", src.officialsCalls, src.officialsEvent)
	}
	if len(repo.officialRefs) != 2 ||
		repo.officialRefs[0].SourceID != "9078" || repo.officialRefs[0].FullName == "" ||
		repo.officialRefs[1].SourceID != "9079" {
		t.Fatalf("resolved refs = %#v, want both crew members", repo.officialRefs)
	}
	if len(repo.crewWrites) != 1 || len(repo.crewWrites[0]) != 2 {
		t.Fatalf("crew writes = %#v, want one write of two officials", repo.crewWrites)
	}
	if repo.crewMatches[0] != fakeMatchID("m1") {
		t.Fatalf("crew written against %s, want the canonical match id", repo.crewMatches[0])
	}
	if got := repo.crewIDs[0]; got["9078"] != fakeOfficialID("9078") ||
		got["9079"] != fakeOfficialID("9079") {
		t.Fatalf("official crosswalk = %v, want canonical ids", got)
	}
	if hasLoggedFailure(repo.logged, "officials") {
		t.Fatal("a successful crew capture was audited as a failure")
	}
	assertOneLoggedRun(t, repo.logged, "officials", true, "")
}

// Plenty of competitions publish no crew at all. That is not a failure, and it
// must not write an empty crew either.
func TestCaptureOfficialsEmptyCrewIsASuccessfulNoOp(t *testing.T) {
	src := &fakeSource{officials: nil}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOfficials(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1")

	if len(repo.officialRefs) != 0 || len(repo.crewWrites) != 0 {
		t.Fatalf("empty crew resolved %d refs and wrote %d crews",
			len(repo.officialRefs), len(repo.crewWrites))
	}
	if hasLoggedFailure(repo.logged, "officials") {
		t.Fatal("an empty crew was audited as a failure")
	}
	assertOneLoggedRun(t, repo.logged, "officials", true, "")
}

func TestCaptureOfficialsRecordsEveryBoundaryFailure(t *testing.T) {
	for _, test := range []struct {
		name        string
		src         *fakeSource
		repo        *fakeRepository
		wantResolve bool
		wantWrite   bool
	}{
		{
			name: "fetch",
			src:  &fakeSource{officialsErr: errors.New("core api down")},
			repo: &fakeRepository{},
		},
		{
			name:        "resolve",
			src:         &fakeSource{officials: crewFixture()},
			repo:        &fakeRepository{officialErr: errors.New("identity down")},
			wantResolve: true,
		},
		{
			name:        "write",
			src:         &fakeSource{officials: crewFixture()},
			repo:        &fakeRepository{crewWriteErr: errors.New("write down")},
			wantResolve: true,
			wantWrite:   true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			worker := testRunner(test.src, test.repo, config.Competition{ID: "test"})

			worker.captureOfficials(context.Background(),
				config.Competition{ID: "test"}, captureIdentity(), "m1")

			if !hasLoggedFailure(test.repo.logged, "officials") {
				t.Fatalf("%s failure was not recorded in ingest_run", test.name)
			}
			if gotResolve := len(test.repo.officialRefs) > 0; gotResolve != test.wantResolve {
				t.Fatalf("resolve attempted=%v, want %v", gotResolve, test.wantResolve)
			}
			if gotWrite := len(test.repo.crewWrites) > 0; gotWrite != test.wantWrite {
				t.Fatalf("crew write attempted=%v, want %v", gotWrite, test.wantWrite)
			}
		})
	}
}

// While a match is live only the CURRENT line is sampled. Opening and closing
// prices are fixed facts that are not final until the match is, so writing them
// from a live poll would keep overwriting them with an in-play price.
func TestOddsCaptureModeString(t *testing.T) {
	for _, test := range []struct {
		name string
		mode oddsCaptureMode
		want string
	}{
		{name: "live", mode: oddsCaptureLive, want: "live"},
		{name: "final", mode: oddsCaptureFinal, want: "final"},
		{name: "fixed retry", mode: oddsCaptureFixedRetry, want: "fixed_retry"},
		{name: "unknown fallback", mode: oddsCaptureMode(99), want: "unknown(99)"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := test.mode.String(); got != test.want {
				t.Fatalf("mode %d label = %q, want %q", test.mode, got, test.want)
			}
		})
	}
}

func TestCaptureOddsSamplesOnlyTheCurrentLineWhileLive(t *testing.T) {
	src := &fakeSource{odds: oddsFixture()}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, config.Competition{ID: "test"})
	before := time.Now()

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureLive)

	if src.oddsCalls != 1 || src.oddsEvent != "m1" {
		t.Fatalf("odds fetches=%d event=%q, want 1/m1", src.oddsCalls, src.oddsEvent)
	}
	if len(repo.oddsSnapshots) != 1 || len(repo.oddsSnapshots[0]) != 1 ||
		repo.oddsSnapshots[0][0].ProviderID != "100" {
		t.Fatalf("snapshots = %#v, want one sampled provider", repo.oddsSnapshots)
	}
	if len(repo.fixedOdds) != 0 {
		t.Fatalf("a live poll wrote fixed lines: %#v", repo.fixedOdds)
	}
	if repo.oddsSnapshotAt[0].Before(before) || repo.oddsSnapshotAt[0].After(time.Now()) {
		t.Fatalf("captured at %s, want the observation time of this poll",
			repo.oddsSnapshotAt[0])
	}
	if hasLoggedFailure(repo.logged, "odds") {
		t.Fatal("a successful odds capture was audited as a failure")
	}
	assertOneLoggedRun(t, repo.logged, "odds", true, "")
}

func TestCaptureOddsRecordsFixedLinesOnceFinalized(t *testing.T) {
	src := &fakeSource{odds: oddsFixture()}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if len(repo.fixedOdds) != 1 || len(repo.fixedOdds[0]) != 1 ||
		repo.fixedOdds[0][0].ProviderID != "100" {
		t.Fatalf("fixed odds = %#v, want the finalized open/close write", repo.fixedOdds)
	}
	if repo.fixedOddsMatches[0] != fakeMatchID("m1") {
		t.Fatalf("fixed odds written against %s, want the canonical match id",
			repo.fixedOddsMatches[0])
	}
	// The last sampled point of the curve is still worth keeping.
	if len(repo.oddsSnapshots) != 1 {
		t.Fatalf("snapshots = %d at finalization, want the closing sample too",
			len(repo.oddsSnapshots))
	}
	assertOneLoggedRun(t, repo.logged, "odds", true, "")
}

func TestCaptureOddsWithNoProvidersIsASuccessfulNoOp(t *testing.T) {
	src := &fakeSource{odds: nil}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if len(repo.oddsSnapshots) != 0 || len(repo.fixedOdds) != 0 {
		t.Fatalf("no providers wrote %d snapshots and %d fixed rows",
			len(repo.oddsSnapshots), len(repo.fixedOdds))
	}
	if hasLoggedFailure(repo.logged, "odds") {
		t.Fatal("a match no book priced was audited as a failure")
	}
	assertOneLoggedRun(t, repo.logged, "odds", true, "")
}

func TestCaptureOddsRecordsAFetchFailureWithoutWriting(t *testing.T) {
	src := &fakeSource{oddsErr: errors.New("core api down")}
	repo := &fakeRepository{}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if len(repo.oddsSnapshots) != 0 || len(repo.fixedOdds) != 0 {
		t.Fatal("a failed fetch still wrote odds rows")
	}
	if !hasLoggedFailure(repo.logged, "odds") {
		t.Fatal("the fetch failure was not recorded in ingest_run")
	}
}

// The two writes are independent: a failing snapshot must not cost the
// finalized match its fixed lines, and the recorded run must reflect what
// actually happened rather than the last call's return value.
func TestCaptureOddsAttemptsBothWritesAndRecordsTheCombinedFailure(t *testing.T) {
	for _, test := range []struct {
		name             string
		repo             *fakeRepository
		wantMessage      string
		wantMessageParts []string
	}{
		{
			name:        "snapshot",
			repo:        &fakeRepository{oddsSnapshotErr: errors.New("boom")},
			wantMessage: "odds snapshot: boom",
		},
		{
			name:        "fixed",
			repo:        &fakeRepository{fixedOddsErr: errors.New("boom")},
			wantMessage: "fixed odds: boom",
		},
		{name: "both", repo: &fakeRepository{
			oddsSnapshotErr: errors.New("snapshot boom"),
			fixedOddsErr:    errors.New("fixed boom"),
		}, wantMessageParts: []string{"snapshot boom", "fixed boom"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			src := &fakeSource{odds: oddsFixture()}
			worker := testRunner(src, test.repo, config.Competition{ID: "test"})

			worker.captureOdds(context.Background(),
				config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

			if len(test.repo.oddsSnapshots) != 1 || len(test.repo.fixedOdds) != 1 {
				t.Fatalf("snapshots=%d fixed=%d, want both writes attempted",
					len(test.repo.oddsSnapshots), len(test.repo.fixedOdds))
			}
			if !hasLoggedFailure(test.repo.logged, "odds") {
				t.Fatalf("the %s failure was recorded as a success", test.name)
			}
			runs := loggedRunsForKind(test.repo.logged, "odds")
			if len(runs) != 1 || runs[0].ok {
				t.Fatalf("odds audit rows = %#v, want one failed row", runs)
			}
			if test.wantMessage != "" && runs[0].message != test.wantMessage {
				t.Fatalf("odds failure message = %q, want %q",
					runs[0].message, test.wantMessage)
			}
			for _, wantMessage := range test.wantMessageParts {
				if !strings.Contains(runs[0].message, wantMessage) {
					t.Fatalf("odds failure message %q does not contain %q",
						runs[0].message, wantMessage)
				}
			}
		})
	}
}

// Raw bookmaker prices are not the same thing as the normalized win
// probability, and mapWinProbability returns nil for competitions with no
// usable three-way moneyline. Suppressing the odds sample in that case would
// lose the market for exactly the competitions whose market we cannot map.
func TestLiveMatchSamplesOddsEvenWithoutAWinProbability(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{live: true, winProbability: nil, odds: oddsFixture()}
	worker := newTestRunnerWithSource(repo, src)

	worker.runCycle(context.Background(), false)

	if src.oddsCalls != 1 || len(repo.oddsSnapshots) != 1 {
		t.Fatalf("odds fetches=%d snapshots=%d for a live match with no mapped market, want 1/1",
			src.oddsCalls, len(repo.oddsSnapshots))
	}
	if len(repo.winProb) != 0 {
		t.Fatalf("win prob writes = %d with no mapped market, want 0", len(repo.winProb))
	}
	if len(repo.fixedOdds) != 0 {
		t.Fatalf("a live match wrote fixed lines: %#v", repo.fixedOdds)
	}
	if src.officialsCalls != 0 {
		t.Fatalf("officials fetched %d times for a live match, want 0", src.officialsCalls)
	}
}

// A scheduled match is polled on slow ticks all season. Sampling those would
// write a market curve for every fixture on the calendar months in advance.
func TestScheduledMatchDoesNotSampleOdds(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{odds: oddsFixture()}
	src.matches = []model.Match{{
		ID: "m1", Kickoff: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		State: model.MatchStateScheduled,
		Home:  model.Team{ID: "home", Name: "Home", Abbr: "HOM"},
		Away:  model.Team{ID: "away", Name: "Away", Abbr: "AWY"},
	}}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	// A fast tick, because the first slow tick of a season is a backfill and a
	// backfill deliberately never polls a scheduled fixture at all.
	worker.runCycle(context.Background(), false)

	if src.summaryCalls == 0 {
		t.Fatal("the scheduled match was never polled; the test proves nothing")
	}
	if src.oddsCalls != 0 || len(repo.oddsSnapshots) != 0 {
		t.Fatalf("scheduled odds fetches=%d snapshots=%d, want 0/0",
			src.oddsCalls, len(repo.oddsSnapshots))
	}
}

// The crew and the fixed lines are full-time facts. Fetching them before the
// match is finalized would re-fetch them on every poll and record an opening
// line that is still moving.
func TestFinalizedMatchCapturesOfficialsAndFixedOddsAfterFinalization(t *testing.T) {
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	officialsBeforeFinalize, oddsBeforeFinalize := false, false
	src := &fakeSource{
		matches:   []model.Match{finishedMatch()},
		officials: crewFixture(),
		odds:      oddsFixture(),
	}
	src.officialsHook = func() {
		repo.mu.Lock()
		defer repo.mu.Unlock()
		officialsBeforeFinalize = repo.finalizeCalls == 0
	}
	src.oddsHook = func() {
		repo.mu.Lock()
		defer repo.mu.Unlock()
		oddsBeforeFinalize = repo.finalizeCalls == 0
	}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	worker.runCycle(context.Background(), true)

	if officialsBeforeFinalize || oddsBeforeFinalize {
		t.Fatal("a full-time capture ran before the match was finalized")
	}
	if repo.finalizeCalls != 1 || src.officialsCalls != 1 || src.oddsCalls != 1 {
		t.Fatalf("finalize=%d officials=%d odds=%d, want 1/1/1",
			repo.finalizeCalls, src.officialsCalls, src.oddsCalls)
	}
	if src.officialsEvent != "m1" || src.oddsEvent != "m1" {
		t.Fatalf("captured provider events %q/%q, want the provider id m1",
			src.officialsEvent, src.oddsEvent)
	}
	if len(repo.crewWrites) != 1 || len(repo.fixedOdds) != 1 ||
		len(repo.oddsSnapshots) != 1 {
		t.Fatalf("crew=%d fixed=%d snapshots=%d at full time, want 1/1/1",
			len(repo.crewWrites), len(repo.fixedOdds), len(repo.oddsSnapshots))
	}
	// The play stream is still captured; the new captures are additions to
	// that branch, not a replacement for it.
	if src.playsCalls != 1 {
		t.Fatalf("play stream fetches = %d, want the existing capture preserved",
			src.playsCalls)
	}
}

func TestFinishedMatchSkipsFinalCapturesWhenFinalizeMatchDoesNotClaimRow(t *testing.T) {
	finalized := false
	repo := &fakeRepository{
		existing:       map[string]store.MatchRow{},
		finalizeResult: &finalized,
	}
	src := &fakeSource{
		matches:   []model.Match{finishedMatch()},
		officials: crewFixture(),
		odds:      oddsFixture(),
	}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	worker.runCycle(context.Background(), true)

	if repo.finalizeCalls != 1 {
		t.Fatalf("finalizations = %d, want 1", repo.finalizeCalls)
	}
	if src.officialsCalls != 0 || src.oddsCalls != 0 || src.playsCalls != 0 {
		t.Fatalf("officials=%d odds=%d plays=%d after unclaimed finalization, want 0/0/0",
			src.officialsCalls, src.oddsCalls, src.playsCalls)
	}
	if len(repo.crewWrites) != 0 || len(repo.fixedOdds) != 0 || len(repo.oddsSnapshots) != 0 {
		t.Fatalf("crew=%d fixed=%d snapshots=%d after unclaimed finalization, want 0/0/0",
			len(repo.crewWrites), len(repo.fixedOdds), len(repo.oddsSnapshots))
	}
}

func TestFinishedMatchSkipsFinalCapturesWhenFinalizeMatchFails(t *testing.T) {
	repo := &fakeRepository{
		existing:    map[string]store.MatchRow{},
		finalizeErr: errors.New("finalize boom"),
	}
	src := &fakeSource{
		matches:   []model.Match{finishedMatch()},
		officials: crewFixture(),
		odds:      oddsFixture(),
	}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	result := worker.runCycle(context.Background(), true)

	if repo.finalizeCalls != 1 {
		t.Fatalf("finalizations = %d, want 1", repo.finalizeCalls)
	}
	if src.officialsCalls != 0 || src.oddsCalls != 0 || src.playsCalls != 0 {
		t.Fatalf("officials=%d odds=%d plays=%d after failed finalization, want 0/0/0",
			src.officialsCalls, src.oddsCalls, src.playsCalls)
	}
	if len(repo.crewWrites) != 0 || len(repo.fixedOdds) != 0 || len(repo.oddsSnapshots) != 0 {
		t.Fatalf("crew=%d fixed=%d snapshots=%d after failed finalization, want 0/0/0",
			len(repo.crewWrites), len(repo.fixedOdds), len(repo.oddsSnapshots))
	}
	if result.failures == 0 || !hasLoggedFailure(repo.logged, "matches") {
		t.Fatalf("failed finalization was not recorded through the match path: result=%+v runs=%#v",
			result, repo.logged)
	}
}

// Officials and odds are additive. Their failures are recorded in their own
// ingest_run kinds and must not join the match's operation errors, or a
// bookmaker outage would report the whole competition as failing.
func TestOfficialsAndOddsFailuresDoNotBlockFinalization(t *testing.T) {
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	src := &fakeSource{
		matches:      []model.Match{finishedMatch()},
		officialsErr: errors.New("crew down"),
		oddsErr:      errors.New("odds down"),
	}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	result := worker.runCycle(context.Background(), true)

	if repo.matchCalls != 1 || repo.finalizeCalls != 1 {
		t.Fatalf("match writes=%d finalizations=%d; an additive capture blocked the scoreline",
			repo.matchCalls, repo.finalizeCalls)
	}
	if result.failures != 0 {
		t.Fatalf("cycle failures = %d, want the additive failures kept off the scoreline path",
			result.failures)
	}
	if hasLoggedFailure(repo.logged, "matches") {
		t.Fatal("an additive capture failure was appended to the match operation errors")
	}
	if !hasLoggedFailure(repo.logged, "officials") ||
		!hasLoggedFailure(repo.logged, "odds") {
		t.Fatalf("additive failures were swallowed instead of audited: %#v", repo.logged)
	}
}

// The commentary gate still decides whether a finished match finalizes at all.
// No finalization means no full-time captures.
func TestCommentaryGateAlsoDefersOfficialsAndFixedOdds(t *testing.T) {
	repo := &fakeRepository{
		existing:      map[string]store.MatchRow{},
		commentaryErr: errors.New("boom"),
	}
	src := &fakeSource{
		matches:   []model.Match{finishedMatch()},
		officials: crewFixture(),
		odds:      oddsFixture(),
	}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	worker.runCycle(context.Background(), true)

	if repo.finalizeCalls != 0 {
		t.Fatalf("finalizations = %d; the commentary gate was bypassed", repo.finalizeCalls)
	}
	if src.officialsCalls != 0 || src.oddsCalls != 0 {
		t.Fatalf("officials=%d odds=%d captured for an unfinalized match, want 0/0",
			src.officialsCalls, src.oddsCalls)
	}
}

// A canceled match finalizes without a summary. There is no crew and no
// settled market for a match that was never played, and the branch has no
// summary to hang the captures off.
func TestCanceledMatchCapturesNoOfficialsOrOdds(t *testing.T) {
	match := finishedMatch()
	match.StatusName = "STATUS_CANCELED"
	src := &fakeSource{
		matches:   []model.Match{match},
		officials: crewFixture(),
		odds:      oddsFixture(),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{"m1": {}}}
	worker := testRunner(src, repo, config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	})

	worker.runCycle(context.Background(), false)

	if repo.finalizeCalls != 1 {
		t.Fatalf("finalizations = %d, want the terminal match finalized", repo.finalizeCalls)
	}
	if src.officialsCalls != 0 || src.oddsCalls != 0 {
		t.Fatalf("officials=%d odds=%d for a canceled match, want 0/0",
			src.officialsCalls, src.oddsCalls)
	}
}

// A finalized match's officials and fixed-odds captures are durable in their
// own right: a fetch failure at full time must survive a process restart,
// wait out the retry cadence, and then actually complete once the feed
// recovers -- all without ever blocking or failing the match itself.
func TestFinalCaptureFetchFailuresRetryAfterRestartAndCadence(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{
		matches:      []model.Match{match},
		officialsErr: errors.New("crew feed down"),
		oddsErr:      errors.New("odds feed down"),
	}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	first := worker.runCycle(context.Background(), true)

	if first.failures != 0 {
		t.Fatalf("cycle failures = %d, want the additive fetch failures kept off the cycle", first.failures)
	}
	if repo.finalizeCalls != 1 {
		t.Fatalf("finalizations = %d, want 1", repo.finalizeCalls)
	}
	if src.officialsCalls != 1 || src.oddsCalls != 1 {
		t.Fatalf("initial fetches officials=%d odds=%d, want 1/1", src.officialsCalls, src.oddsCalls)
	}
	if !hasLoggedFailure(repo.logged, "officials") || !hasLoggedFailure(repo.logged, "odds") {
		t.Fatal("the existing officials/odds failure audit was not preserved")
	}
	matchID := fakeMatchID(match.ID)
	officialsKey := finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureOfficials}
	oddsKey := finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureFixedOdds}
	if !repo.finalCaptureStatus[officialsKey].completedAt.IsZero() ||
		!repo.finalCaptureStatus[oddsKey].completedAt.IsZero() {
		t.Fatalf("a failed fetch was recorded as completed: officials=%#v odds=%#v",
			repo.finalCaptureStatus[officialsKey], repo.finalCaptureStatus[oddsKey])
	}
	if repo.finalCaptureStatus[officialsKey].retryAt.IsZero() ||
		repo.finalCaptureStatus[oddsKey].retryAt.IsZero() {
		t.Fatal("a failed fetch did not schedule a retry")
	}

	// Simulate a restart: a fresh runner over the same durable repository, on
	// a later slow tick, must not retry before the cadence is due.
	repo.existing[match.ID] = store.MatchRow{
		State: model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{
			Time: time.Now(), Valid: true,
		},
	}
	fresh := testRunner(src, repo, comp)
	fresh.runCycle(context.Background(), true)

	if src.officialsCalls != 1 || src.oddsCalls != 1 {
		t.Fatalf("fetches after a not-yet-due restart officials=%d odds=%d, want unchanged at 1/1",
			src.officialsCalls, src.oddsCalls)
	}

	// Move the retry cadence into the past and let the feed recover.
	forceFinalCaptureRetryDue(repo)
	src.officialsErr = nil
	src.oddsErr = nil

	fresh.runCycle(context.Background(), true)

	if src.officialsCalls != 2 || src.oddsCalls != 2 {
		t.Fatalf("fetches once due officials=%d odds=%d, want 2/2", src.officialsCalls, src.oddsCalls)
	}
	if repo.finalCaptureStatus[officialsKey].completedAt.IsZero() ||
		repo.finalCaptureStatus[oddsKey].completedAt.IsZero() {
		t.Fatal("the recovered retry did not complete either capture")
	}

	fresh.runCycle(context.Background(), true)

	if src.officialsCalls != 2 || src.oddsCalls != 2 {
		t.Fatalf("fetches after completion officials=%d odds=%d, want unchanged at 2/2 (never reprocessed)",
			src.officialsCalls, src.oddsCalls)
	}
}

// A write failure at full time (not a fetch failure) still leaves the crew
// and fixed odds retryable, and the retry must not re-sample a CURRENT line
// that is long since closed.
func TestFinalCaptureWriteFailuresRetryWithoutAnotherOddsSnapshot(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{
		matches:   []model.Match{match},
		officials: crewFixture(),
		odds:      oddsFixture(),
	}
	repo := &fakeRepository{
		existing:     map[string]store.MatchRow{},
		crewWriteErr: errors.New("crew write down"),
		fixedOddsErr: errors.New("fixed write down"),
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	if src.officialsCalls != 1 || src.oddsCalls != 1 {
		t.Fatalf("initial fetches officials=%d odds=%d, want 1/1", src.officialsCalls, src.oddsCalls)
	}
	if len(repo.crewWrites) != 1 || len(repo.fixedOdds) != 1 {
		t.Fatalf("initial writes crew=%d fixed=%d, want both attempted once even though both failed",
			len(repo.crewWrites), len(repo.fixedOdds))
	}
	if len(repo.oddsSnapshots) != 1 {
		t.Fatalf("initial current snapshot count = %d, want 1", len(repo.oddsSnapshots))
	}

	matchID := fakeMatchID(match.ID)
	officialsKey := finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureOfficials}
	oddsKey := finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureFixedOdds}
	if !repo.finalCaptureStatus[officialsKey].completedAt.IsZero() ||
		!repo.finalCaptureStatus[oddsKey].completedAt.IsZero() {
		t.Fatal("a failed write was recorded as completed")
	}

	repo.existing[match.ID] = store.MatchRow{
		State: model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{
			Time: time.Now(), Valid: true,
		},
	}
	forceFinalCaptureRetryDue(repo)
	repo.crewWriteErr = nil
	repo.fixedOddsErr = nil

	worker.runCycle(context.Background(), true)

	if src.officialsCalls != 2 || src.oddsCalls != 2 {
		t.Fatalf("fetches after retry officials=%d odds=%d, want 2/2", src.officialsCalls, src.oddsCalls)
	}
	if len(repo.crewWrites) != 2 || len(repo.fixedOdds) != 2 {
		t.Fatalf("writes after retry crew=%d fixed=%d, want 2/2", len(repo.crewWrites), len(repo.fixedOdds))
	}
	// The fixed retry must not sample another CURRENT line: that market
	// closed at full time and there is nothing new to observe.
	if len(repo.oddsSnapshots) != 1 {
		t.Fatalf("snapshots after the fixed retry = %d, want still 1", len(repo.oddsSnapshots))
	}
	if repo.finalCaptureStatus[officialsKey].completedAt.IsZero() ||
		repo.finalCaptureStatus[oddsKey].completedAt.IsZero() {
		t.Fatalf("not completed after recovery: officials=%#v odds=%#v",
			repo.finalCaptureStatus[officialsKey], repo.finalCaptureStatus[oddsKey])
	}
}

// An explicit empty crew or no-market answer is a real completion, not a gap
// to keep probing: a fresh runner on a later slow tick must never re-fetch
// either one.
func TestFinalCaptureEmptyResponsesCompleteAndNeverReprocess(t *testing.T) {
	match := finishedMatch()
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	if src.officialsCalls != 1 || src.oddsCalls != 1 {
		t.Fatalf("initial fetches officials=%d odds=%d, want 1/1", src.officialsCalls, src.oddsCalls)
	}
	matchID := fakeMatchID(match.ID)
	officialsKey := finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureOfficials}
	oddsKey := finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureFixedOdds}
	if repo.finalCaptureStatus[officialsKey].completedAt.IsZero() ||
		repo.finalCaptureStatus[oddsKey].completedAt.IsZero() {
		t.Fatalf("empty responses were not completed: officials=%#v odds=%#v",
			repo.finalCaptureStatus[officialsKey], repo.finalCaptureStatus[oddsKey])
	}

	repo.existing[match.ID] = store.MatchRow{
		State: model.MatchStateFinished,
		FinalizedAt: pgtype.Timestamptz{
			Time: time.Now(), Valid: true,
		},
	}
	fresh := testRunner(src, repo, comp)
	fresh.runCycle(context.Background(), true)

	if src.officialsCalls != 1 || src.oddsCalls != 1 {
		t.Fatalf("officials=%d odds=%d after a fresh runner's slow tick, want unchanged at 1/1 (never reprocessed)",
			src.officialsCalls, src.oddsCalls)
	}
}

// A process can crash after FinalizeMatch commits but before either capture
// is even attempted once. The backlog sweep must still find that match from
// the candidate rows alone -- there is no status row yet, only a finalized
// match with nothing captured.
func TestFinalCaptureBacklogFindsMatchWithNoStatusRows(t *testing.T) {
	matchID := fakeMatchID("m1")
	repo := &fakeRepository{
		existing: map[string]store.MatchRow{},
		finalCaptureCandidates: []finalCaptureCandidate{
			{matchID: matchID, sourceID: "m1"},
		},
	}
	src := &fakeSource{officials: crewFixture(), odds: oddsFixture()}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	if src.officialsCalls != 1 || src.officialsEvent != "m1" {
		t.Fatalf("officials backlog fetch=%d event=%q, want 1/m1", src.officialsCalls, src.officialsEvent)
	}
	if src.oddsCalls != 1 || src.oddsEvent != "m1" {
		t.Fatalf("odds backlog fetch=%d event=%q, want 1/m1", src.oddsCalls, src.oddsEvent)
	}
	officialsRow := repo.finalCaptureStatus[finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureOfficials}]
	oddsRow := repo.finalCaptureStatus[finalCaptureStatusKey{matchID: matchID, kind: store.FinalCaptureFixedOdds}]
	if officialsRow.completedAt.IsZero() || oddsRow.completedAt.IsZero() {
		t.Fatalf("backlog capture was not completed: officials=%#v odds=%#v", officialsRow, oddsRow)
	}
	if hasLoggedFailure(repo.logged, finalCaptureBacklogRunKind) {
		t.Fatalf("the backlog sweep itself was audited as a failure: %#v", repo.logged)
	}
}

// The backlog sweep must never process more than finalCaptureRetryBatch
// pending captures per call, even when many more are outstanding -- an
// unhealthy crew or bookmaker feed should cost one bounded sweep per tick,
// not a growing amount of work as the backlog grows.
func TestFinalCaptureBacklogBatchIsBoundedAtTen(t *testing.T) {
	if finalCaptureRetryBatch != 10 {
		t.Fatalf("finalCaptureRetryBatch = %d, want 10", finalCaptureRetryBatch)
	}
	const candidateMatches = 15 // 30 pending items: officials + fixed odds each
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	for i := 0; i < candidateMatches; i++ {
		sourceID := fmt.Sprintf("m%02d", i)
		repo.finalCaptureCandidates = append(repo.finalCaptureCandidates,
			finalCaptureCandidate{matchID: fakeMatchID(sourceID), sourceID: sourceID})
	}
	src := &fakeSource{officialsErr: errors.New("still down"), oddsErr: errors.New("still down")}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	if got := len(repo.pendingFinalCapturesLimits); got == 0 {
		t.Fatal("PendingFinalCaptures was never called")
	} else if last := repo.pendingFinalCapturesLimits[got-1]; last != finalCaptureRetryBatch {
		t.Fatalf("limit passed to PendingFinalCaptures = %d, want the finalCaptureRetryBatch constant %d",
			last, finalCaptureRetryBatch)
	}
	if attempted := src.officialsCalls + src.oddsCalls; attempted != finalCaptureRetryBatch {
		t.Fatalf("attempts this tick = %d (with %d pending), want exactly the batch size %d",
			attempted, candidateMatches*2, finalCaptureRetryBatch)
	}
}

// A failed retry must not be offered again on the very next slow tick: it has
// to wait out finalCaptureRetryInterval, or an unhealthy feed would spend
// every tick re-attempting the same handful of matches.
func TestFinalCaptureBacklogReschedulesFailedRetryThirtyMinutesOut(t *testing.T) {
	const candidateMatches = finalCaptureRetryBatch / 2 // exactly one batch's worth of pending items
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	for i := 0; i < candidateMatches; i++ {
		sourceID := fmt.Sprintf("m%02d", i)
		repo.finalCaptureCandidates = append(repo.finalCaptureCandidates,
			finalCaptureCandidate{matchID: fakeMatchID(sourceID), sourceID: sourceID})
	}
	src := &fakeSource{officialsErr: errors.New("still down"), oddsErr: errors.New("still down")}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	attempted := src.officialsCalls + src.oddsCalls
	if attempted != finalCaptureRetryBatch {
		t.Fatalf("attempts this tick = %d, want exactly %d", attempted, finalCaptureRetryBatch)
	}
	if got := len(repo.finalCaptureStatus); got != finalCaptureRetryBatch {
		t.Fatalf("status rows written = %d, want one per attempted item (%d)", got, finalCaptureRetryBatch)
	}
	minRetryAt := time.Now().Add(finalCaptureRetryInterval - time.Minute)
	for key, row := range repo.finalCaptureStatus {
		if row.retryAt.Before(minRetryAt) {
			t.Fatalf("retry_at for %v = %v, want roughly %s out", key, row.retryAt, finalCaptureRetryInterval)
		}
	}

	worker.runCycle(context.Background(), true)

	if got := src.officialsCalls + src.oddsCalls; got != attempted {
		t.Fatalf("attempts after an immediate second slow tick = %d, want unchanged at %d (not yet due)",
			got, attempted)
	}
}

// A capture kind the backlog does not recognise means the store and the
// ingester have drifted. That has to fail loudly rather than being silently
// skipped or crashing the sweep for every other match behind it.
func TestFinalCaptureBacklogLogsUnknownKindLoudly(t *testing.T) {
	repo := &fakeRepository{
		existing: map[string]store.MatchRow{},
		pendingFinalCapturesOverride: []store.PendingFinalCapture{
			{MatchID: fakeMatchID("m1"), SourceID: "m1", Kind: store.FinalCaptureKind("mystery")},
		},
	}
	src := &fakeSource{}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	if src.officialsCalls != 0 || src.oddsCalls != 0 {
		t.Fatalf("an unknown kind still dispatched a capture: officials=%d odds=%d",
			src.officialsCalls, src.oddsCalls)
	}
	if !hasLoggedFailure(repo.logged, finalCaptureBacklogRunKind) {
		t.Fatal("an unknown final capture kind was not audited as a backlog failure")
	}
}

// If the write itself fails AND the retry ledger write also fails, the
// original capture cause must still be visible -- losing it would leave an
// operator staring at a database error with no idea a crew write ever failed
// in the first place.
func TestCaptureOfficialsPreservesOriginalCauseWhenStatusPersistenceAlsoFails(t *testing.T) {
	repo := &fakeRepository{
		crewWriteErr:                 errors.New("write down"),
		scheduleFinalCaptureRetryErr: errors.New("ledger down"),
	}
	src := &fakeSource{officials: crewFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	err := worker.captureOfficials(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1")

	if err == nil {
		t.Fatal("want a non-nil error when both the capture and the retry ledger fail")
	}
	if !strings.Contains(err.Error(), "write down") {
		t.Fatalf("error = %q, want it to still mention the original capture cause %q", err.Error(), "write down")
	}
	if !strings.Contains(err.Error(), "ledger down") {
		t.Fatalf("error = %q, want it to also mention the status write failure %q", err.Error(), "ledger down")
	}
	// The individual "officials" ingest_run row -- not just the (often
	// discarded) returned error -- must itself carry both causes. A caller
	// that ignores the return value (like the full-time path) must still be
	// able to see the whole story from the audit row alone.
	runs := loggedRunsForKind(repo.logged, "officials")
	if len(runs) != 1 {
		t.Fatalf("officials audit rows = %#v, want exactly one", runs)
	}
	if runs[0].ok {
		t.Fatal("the combined failure was not audited under the officials ingest_run kind")
	}
	if !strings.Contains(runs[0].message, "write down") {
		t.Fatalf("officials audit message = %q, want it to still mention the original capture cause %q",
			runs[0].message, "write down")
	}
	if !strings.Contains(runs[0].message, "ledger down") {
		t.Fatalf("officials audit message = %q, want it to also mention the retry ledger cause %q",
			runs[0].message, "ledger down")
	}
}

// The odds equivalent: a fixed-odds write failure whose retry ledger write
// also fails must not swallow the original bookmaker write failure.
func TestCaptureOddsPreservesOriginalCauseWhenStatusPersistenceAlsoFails(t *testing.T) {
	repo := &fakeRepository{
		fixedOddsErr:                 errors.New("write down"),
		scheduleFinalCaptureRetryErr: errors.New("ledger down"),
	}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	err := worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if err == nil {
		t.Fatal("want a non-nil error when both the fixed write and the retry ledger fail")
	}
	if !strings.Contains(err.Error(), "write down") {
		t.Fatalf("error = %q, want it to still mention the original capture cause %q", err.Error(), "write down")
	}
	if !strings.Contains(err.Error(), "ledger down") {
		t.Fatalf("error = %q, want it to also mention the status write failure %q", err.Error(), "ledger down")
	}
	// The CURRENT-price snapshot is independent of the FIXED write/ledger
	// outcome: it must still have been attempted even though the fixed side
	// failed twice over.
	if len(repo.oddsSnapshots) != 1 {
		t.Fatalf("snapshot writes = %d, want the CURRENT sample still attempted independently",
			len(repo.oddsSnapshots))
	}
	// The individual "odds" ingest_run row -- not just the (often discarded)
	// returned error -- must itself carry both causes. A caller that ignores
	// the return value (like the full-time path) must still be able to see
	// the whole story from the audit row alone.
	runs := loggedRunsForKind(repo.logged, "odds")
	if len(runs) != 1 {
		t.Fatalf("odds audit rows = %#v, want exactly one", runs)
	}
	if runs[0].ok {
		t.Fatal("the combined failure was not audited under the odds ingest_run kind")
	}
	if !strings.Contains(runs[0].message, "write down") {
		t.Fatalf("odds audit message = %q, want it to still mention the original capture cause %q",
			runs[0].message, "write down")
	}
	if !strings.Contains(runs[0].message, "ledger down") {
		t.Fatalf("odds audit message = %q, want it to also mention the retry ledger cause %q",
			runs[0].message, "ledger down")
	}
}

// A completion write can fail even though the capture itself succeeded. That
// must still be surfaced to the caller -- otherwise a durable ledger outage
// at exactly the wrong moment would silently keep retrying a crew that was
// already written. Critically, the individual "officials" ingest_run row
// itself must also read as a failure: the full-time caller discards
// captureOfficials' returned error (crews are additive and must never block
// finalization), so the audit row is the ONLY place a ledger outage can be
// seen without following the retry ledger.
func TestCaptureOfficialsAuditsACompletionLedgerFailure(t *testing.T) {
	repo := &fakeRepository{completeFinalCaptureErr: errors.New("ledger down")}
	src := &fakeSource{officials: crewFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	err := worker.captureOfficials(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1")

	if err == nil || !strings.Contains(err.Error(), "ledger down") {
		t.Fatalf("captureOfficials error = %v, want it to surface the completion ledger failure", err)
	}
	if len(repo.crewWrites) != 1 {
		t.Fatalf("crew writes = %d, want the crew itself still durably written", len(repo.crewWrites))
	}
	runs := loggedRunsForKind(repo.logged, "officials")
	if len(runs) != 1 {
		t.Fatalf("officials audit rows = %#v, want exactly one", runs)
	}
	if runs[0].ok {
		t.Fatalf("officials audit row = %#v, want it audited as a failure: a completion-ledger "+
			"outage must not read as a successful capture", runs[0])
	}
	if !strings.Contains(runs[0].message, "ledger down") {
		t.Fatalf("officials audit message = %q, want it to contain the completion ledger cause",
			runs[0].message)
	}
}

// The odds equivalent of the completion-ledger gap above: the FIXED write
// itself succeeds, but the completion write to the retry ledger fails. The
// odds ingest_run row must audit that as a failure too, not just the
// returned error, for the same reason -- a live-mode/backlog caller's return
// value is not always inspected, but the audit row always is.
func TestCaptureOddsAuditsACompletionLedgerFailure(t *testing.T) {
	repo := &fakeRepository{completeFinalCaptureErr: errors.New("ledger down")}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	err := worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if err == nil || !strings.Contains(err.Error(), "ledger down") {
		t.Fatalf("captureOdds error = %v, want it to surface the completion ledger failure", err)
	}
	if len(repo.fixedOdds) != 1 || len(repo.oddsSnapshots) != 1 {
		t.Fatalf("fixed writes=%d snapshot writes=%d, want both still durably written",
			len(repo.fixedOdds), len(repo.oddsSnapshots))
	}
	runs := loggedRunsForKind(repo.logged, "odds")
	if len(runs) != 1 {
		t.Fatalf("odds audit rows = %#v, want exactly one", runs)
	}
	if runs[0].ok {
		t.Fatalf("odds audit row = %#v, want it audited as a failure: a completion-ledger "+
			"outage must not read as a successful capture", runs[0])
	}
	if !strings.Contains(runs[0].message, "ledger down") {
		t.Fatalf("odds audit message = %q, want it to contain the completion ledger cause",
			runs[0].message)
	}
}

// A snapshot failure and the fixed-odds outcome are independent durability
// facts: the odds ingest_run audits both writes together, as before, but a
// fixed line that was actually written must never be left pending just
// because the accompanying CURRENT-price snapshot failed.
func TestCaptureOddsSnapshotFailureDoesNotBlockFixedOddsCompletion(t *testing.T) {
	repo := &fakeRepository{oddsSnapshotErr: errors.New("snapshot boom")}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if len(repo.fixedOdds) != 1 {
		t.Fatalf("fixed odds writes = %d, want the fixed write still attempted", len(repo.fixedOdds))
	}
	if !hasLoggedFailure(repo.logged, "odds") {
		t.Fatal("a failing snapshot write should still fail the odds audit")
	}
	row := repo.finalCaptureStatus[finalCaptureStatusKey{
		matchID: fakeMatchID("m1"), kind: store.FinalCaptureFixedOdds,
	}]
	if row.completedAt.IsZero() {
		t.Fatalf("fixed odds status = %#v, want it completed despite the snapshot failure", row)
	}
}

// The reverse: a fixed-odds write failure schedules a retry even when the
// accompanying CURRENT-price snapshot succeeded.
func TestCaptureOddsFixedFailureSchedulesRetryEvenWhenSnapshotSucceeds(t *testing.T) {
	repo := &fakeRepository{fixedOddsErr: errors.New("fixed boom")}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureFinal)

	if len(repo.oddsSnapshots) != 1 {
		t.Fatalf("snapshot writes = %d, want the snapshot still attempted", len(repo.oddsSnapshots))
	}
	row := repo.finalCaptureStatus[finalCaptureStatusKey{
		matchID: fakeMatchID("m1"), kind: store.FinalCaptureFixedOdds,
	}]
	if !row.completedAt.IsZero() {
		t.Fatalf("fixed odds status = %#v, want it NOT completed after a failed write", row)
	}
	if row.retryAt.IsZero() {
		t.Fatalf("fixed odds status = %#v, want a retry scheduled", row)
	}
}

// A canceled context must not be mistaken for a successful capture just
// because the capture itself returned a nil error before the cancellation
// was observed: that would durably mark a capture "complete" that never
// actually finished.
func TestPersistFinalCaptureAttemptTreatsContextCancellationAsFailureNotCompletion(t *testing.T) {
	repo := &fakeRepository{}
	worker := testRunner(&fakeSource{}, repo, config.Competition{ID: "test"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	attemptedAt := time.Now()
	err := worker.persistFinalCaptureAttempt(
		ctx, fakeMatchID("m1"), store.FinalCaptureOfficials, attemptedAt, nil)

	if err == nil {
		t.Fatal("want a non-nil error for a canceled context, even with a nil capture error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want it to still surface the original context.Canceled cause", err)
	}
	if repo.completeFinalCaptureCalls != 0 {
		t.Fatalf("CompleteFinalCapture calls = %d, want 0: a canceled context must not complete",
			repo.completeFinalCaptureCalls)
	}
	if repo.scheduleFinalCaptureRetryCalls != 1 {
		t.Fatalf("ScheduleFinalCaptureRetry calls = %d, want 1", repo.scheduleFinalCaptureRetryCalls)
	}
	// A method call alone is not durability: the real Store derives its bounded
	// DB context from the same ctx it was handed (context.WithTimeout(ctx, ...)),
	// so a canceled parent must not silently prevent the retry row from ever
	// existing. Assert the fake's row actually landed, not merely that the
	// method was invoked with a context it could ignore.
	row, ok := repo.finalCaptureStatus[finalCaptureStatusKey{
		matchID: fakeMatchID("m1"), kind: store.FinalCaptureOfficials,
	}]
	if !ok {
		t.Fatal("want a durable pending retry row after a canceled context, not silently dropped")
	}
	if !row.completedAt.IsZero() {
		t.Fatalf("row = %#v, want it NOT completed after a canceled context", row)
	}
	if row.retryAt.IsZero() {
		t.Fatalf("row = %#v, want retry_at scheduled despite the canceled context", row)
	}
	if !row.retryAt.After(attemptedAt) {
		t.Fatalf("row.retryAt = %s, want it strictly after attemptedAt %s", row.retryAt, attemptedAt)
	}
}

// A live match is polled every 20 seconds. Writing an ingest_run row per match
// per poll for the two sampling kinds is 720 rows per match per two hours, to
// say the same thing 720 times.
func TestLiveSampleAuditIsThrottledToOneRowPerWindow(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})
	clock := time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)
	worker.now = func() time.Time { return clock }

	// Fifteen polls inside one five-minute window: 20s apart.
	for range 15 {
		worker.captureOdds(context.Background(),
			config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureLive)
		clock = clock.Add(20 * time.Second)
	}
	if runs := loggedRunsForKind(repo.logged, "odds"); len(runs) != 1 {
		t.Fatalf("odds audit rows = %d over five minutes of polling, want 1", len(runs))
	}

	// Past the window, one more row.
	clock = clock.Add(5 * time.Minute)
	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureLive)
	if runs := loggedRunsForKind(repo.logged, "odds"); len(runs) != 2 {
		t.Fatalf("odds audit rows = %d after the window elapsed, want 2", len(runs))
	}
}

// Throttling successes must never throttle failures: a bookmaker feed going
// dark is exactly what the audit trail exists to show, and it must show up on
// the poll it happens rather than up to five minutes later.
func TestLiveSampleAuditNeverSuppressesAFailure(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})
	clock := time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)
	worker.now = func() time.Time { return clock }

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureLive)
	clock = clock.Add(20 * time.Second)
	src.oddsErr = errors.New("core api down")
	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", oddsCaptureLive)

	runs := loggedRunsForKind(repo.logged, "odds")
	if len(runs) != 2 || runs[1].ok {
		t.Fatalf("odds audit rows = %#v, want the failure recorded immediately", runs)
	}
}
