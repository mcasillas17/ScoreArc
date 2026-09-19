package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

// Ordinary runner tests have no recovery backlog.
func (f *fakeSource) RecoverMatch(context.Context, config.Competition, config.Season, model.Match) (model.Match, source.SummaryResult, error) {
	return model.Match{}, source.SummaryResult{}, errors.New("recovery not configured")
}
func (f *fakeRepository) PendingMatchRecovery(context.Context, string, string, string, time.Time, int) ([]store.RecoveryMatch, error) {
	return nil, nil
}
func (f *fakeRepository) BeginMatchRecovery(context.Context, uuid.UUID, string, time.Time, time.Time) error {
	return nil
}
func (f *fakeRepository) CompleteMatchRecovery(context.Context, uuid.UUID, string, time.Time, bool) error {
	return nil
}
func (f *fakeRepository) RecordMatchObservation(context.Context, store.MatchIdentity, model.Match, time.Time) error {
	return nil
}
func (f *fakeRepository) RecordMatchPoll(context.Context, string, string, string, time.Time, string, int) error {
	return nil
}

type recoveryRepository struct {
	*fakeRepository
	pending             []store.RecoveryMatch
	retryAt             map[uuid.UUID]time.Time
	observations        []time.Time
	observedMatches     []model.Match
	outcomes            []string
	observationBatches  int
	claimErr            error
	observeErr          error
	upsertFailures      int
	observationFailures int
}

func (f *recoveryRepository) PendingMatchRecovery(_ context.Context, _, _, _ string, now time.Time, limit int) ([]store.RecoveryMatch, error) {
	var pending []store.RecoveryMatch
	for _, item := range f.pending {
		if !f.retryAt[item.Identity.MatchID].After(now) {
			pending = append(pending, item)
		}
	}
	return pending[:min(limit, len(pending))], nil
}
func (f *recoveryRepository) BeginMatchRecovery(_ context.Context, id uuid.UUID, _ string, _, retryAt time.Time) error {
	if f.claimErr != nil {
		return f.claimErr
	}
	if f.retryAt == nil {
		f.retryAt = make(map[uuid.UUID]time.Time)
	}
	f.retryAt[id] = retryAt
	return nil
}
func (f *recoveryRepository) RecordMatchObservation(_ context.Context, _ store.MatchIdentity, match model.Match, at time.Time) error {
	if f.observationFailures > 0 {
		f.observationFailures--
		return errors.New("temporary observation write failure")
	}
	if f.observeErr == nil {
		f.observations = append(f.observations, at)
		f.observedMatches = append(f.observedMatches, match)
	}
	return f.observeErr
}
func (f *recoveryRepository) UpsertMatch(ctx context.Context, id store.MatchIdentity, match model.Match) error {
	if f.upsertFailures > 0 {
		f.upsertFailures--
		return errors.New("temporary core write failure")
	}
	return f.fakeRepository.UpsertMatch(ctx, id, match)
}
func (f *recoveryRepository) RecordMatchPoll(_ context.Context, _, _, _ string, _ time.Time, outcome string, _ int) error {
	f.outcomes = append(f.outcomes, outcome)
	return nil
}

func (f *fakeRepository) RecordMatchObservations(context.Context, []store.MatchObservation) error {
	return nil
}

func (f *recoveryRepository) RecordMatchObservations(ctx context.Context, observations []store.MatchObservation) error {
	f.observationBatches++
	for _, observation := range observations {
		if err := f.RecordMatchObservation(ctx, observation.Identity, observation.Match, observation.ObservedAt); err != nil {
			return err
		}
	}
	return nil
}

type recoverySource struct {
	*fakeSource
	fresh model.Match
	err   error
	calls int
}

func (f *recoverySource) RecoverMatch(ctx context.Context, _ config.Competition, _ config.Season, _ model.Match) (model.Match, source.SummaryResult, error) {
	f.calls++
	if _, ok := ctx.Deadline(); !ok {
		return model.Match{}, source.SummaryResult{}, errors.New("lookup has no deadline")
	}
	return f.fresh, source.SummaryResult{
		Detail:    model.MatchDetail{Scorers: []model.Scorer{{Player: "Winner"}}},
		HomeScore: f.fresh.HomeScore, AwayScore: f.fresh.AwayScore,
	}, f.err
}

func recoveryFixture() (config.Competition, *recoveryRepository, *recoverySource, time.Time) {
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	match := finishedMatch()
	match.Kickoff, match.State = now.Add(-96*time.Hour).Format(time.RFC3339), model.MatchStateLive
	match.StatusName = "STATUS_FIRST_HALF"
	home, away := 0, 1
	id := store.MatchIdentity{
		MatchID: fakeMatchID(match.ID), CompetitionID: "test", SeasonID: "2026", Source: sourceESPN,
		HomeTeamID: fakeTeamID(match.Home.ID), AwayTeamID: fakeTeamID(match.Away.ID),
		HomeTeamSourceID: match.Home.ID, AwayTeamSourceID: match.Away.ID,
	}
	repo := &recoveryRepository{
		fakeRepository: &fakeRepository{existing: map[string]store.MatchRow{
			match.ID: {State: model.MatchStateLive},
		}},
		pending: []store.RecoveryMatch{{Identity: id, Match: match}},
	}
	fresh := match
	fresh.State, fresh.StatusName = model.MatchStateFinished, "STATUS_FULL_TIME"
	fresh.HomeScore, fresh.AwayScore = &home, &away
	src := &recoverySource{fakeSource: &fakeSource{}, fresh: fresh}
	comp := config.Competition{ID: "test", CurrentSeasonId: "2026", Seasons: map[string]config.Season{"2026": {ID: "2026"}}}
	return comp, repo, src, now
}

func TestOverdueLiveRecoveryDuringScoreboardFailureOrOmission(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "omitted", true: "failed"}[failed], func(t *testing.T) {
			comp, repo, src, now := recoveryFixture()
			if failed {
				src.scoreboardErr = errors.New("scoreboard unavailable")
			}
			r := testRunner(src.fakeSource, repo.fakeRepository, comp)
			r.repo, r.source, r.now = repo, src, func() time.Time { return now }
			result := r.runCycle(context.Background(), true)
			if src.calls != 1 || repo.finalizeCalls != 1 || repo.lastUpsert.State != model.MatchStateFinished ||
				repo.lastUpsert.AwayScore == nil || *repo.lastUpsert.AwayScore != 1 {
				t.Fatalf("known live match not recovered: calls=%d finalized=%d match=%+v result=%+v",
					src.calls, repo.finalizeCalls, repo.lastUpsert, result)
			}
			if src.summaryCalls != 0 || len(repo.observations) != 1 {
				t.Fatalf("duplicate lookup or no fresh observation: summaries=%d observations=%v", src.summaryCalls, repo.observations)
			}
		})
	}
}

func TestRecoveryRestartRespectsPersistedBackoff(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	src.err = context.DeadlineExceeded
	for range 2 {
		r := testRunner(src.fakeSource, repo.fakeRepository, comp)
		r.repo, r.source, r.now = repo, src, func() time.Time { return now }
		r.runCycle(context.Background(), true)
	}
	if src.calls != 1 || repo.finalizeCalls != 0 || len(repo.observations) != 0 {
		t.Fatalf("restart repeated failed lookup or invented facts: calls=%d final=%d observations=%v",
			src.calls, repo.finalizeCalls, repo.observations)
	}
}

func TestRecoveryNeverFetchesBeforeDurableClaim(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.claimErr = errors.New("database unavailable")
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	result := r.runCycle(context.Background(), true)
	if src.calls != 0 || result.failures == 0 {
		t.Fatalf("unbounded unrecorded lookup: calls=%d result=%+v", src.calls, result)
	}
}

func TestRecoveryDelayIsBounded(t *testing.T) {
	for _, tc := range []struct {
		attempts int
		want     time.Duration
	}{{0, 5 * time.Minute}, {1, 10 * time.Minute}, {6, 320 * time.Minute}, {7, 6 * time.Hour}, {32, 6 * time.Hour}} {
		if got := matchRecoveryDelay(tc.attempts); got != tc.want {
			t.Fatalf("attempts=%d delay=%v want=%v", tc.attempts, got, tc.want)
		}
	}
}

func TestRecoveryBatchIsBounded(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	item := repo.pending[0]
	for i := range 12 {
		copy := item
		copy.Identity.MatchID = uuid.New()
		copy.Attempts = i
		repo.pending = append(repo.pending, copy)
	}
	src.err = errors.New("provider unavailable")
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	r.runCycle(context.Background(), true)
	if src.calls != store.MatchRecoveryBatchLimit || len(repo.retryAt) != store.MatchRecoveryBatchLimit {
		t.Fatalf("unbounded attempts: calls=%d durable=%d", src.calls, len(repo.retryAt))
	}
}

func TestStoredBacklogCannotRenewObservationFromRegressingScoreboard(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	repo.unfinalized = []model.Match{src.fresh}
	src.matches = []model.Match{scheduledNoOpMatch()}
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	r.runCycle(context.Background(), true)
	if len(repo.observations) != 0 {
		t.Fatal("stored finished row was mistaken for a validated source observation")
	}
	if len(repo.outcomes) != 1 || repo.outcomes[0] != "failed" {
		t.Fatalf("contradictory provider response marked healthy: %v", repo.outcomes)
	}
}

func TestUnchangedScoreboardRenewsObservationWithoutFactRewrite(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	match := scheduledNoOpMatch()
	match.Kickoff = now.Add(7 * 24 * time.Hour).Format(time.RFC3339)
	src.matches = []model.Match{match}
	repo.existing[match.ID] = store.MatchRow{
		State: match.State, Kickoff: now.Add(7 * 24 * time.Hour),
		StatusDetail: match.StatusDetail, StatusName: match.StatusName,
		Home: model.Team{ID: fakeTeamID(match.Home.ID)}, Away: model.Team{ID: fakeTeamID(match.Away.ID)},
	}
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	for range 2 {
		r.runCycle(context.Background(), true)
		now = now.Add(5 * time.Minute)
	}
	if repo.matchCalls != 0 || len(repo.observations) != 2 {
		t.Fatalf("writes=%d observations=%v", repo.matchCalls, repo.observations)
	}
	if repo.observationBatches != 2 {
		t.Fatalf("freshness requires one metadata batch per cycle, got %d", repo.observationBatches)
	}
}

func TestRecoveryLookupBudgetDefersAncillaryProviderCalls(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	if _, _, err := r.recoverOverdueMatches(context.Background(), comp, comp.Seasons["2026"]); err != nil {
		t.Fatal(err)
	}
	if src.playsCalls != 0 || src.officialsCalls != 0 || src.oddsCalls != 0 {
		t.Fatalf("recovery escaped lookup budget: plays=%d officials=%d odds=%d",
			src.playsCalls, src.officialsCalls, src.oddsCalls)
	}
	if len(repo.finalCaptureCandidates) != 1 {
		t.Fatal("normal durable final-capture backlog lost the recovered match")
	}
}

func TestRecoveryStateGuardRejectsAllUnconfirmedWrites(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	src.fresh.State, src.fresh.StatusName = model.MatchStateScheduled, "STATUS_SCHEDULED"
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	if _, _, err := r.recoverOverdueMatches(context.Background(), comp, comp.Seasons["2026"]); err == nil {
		t.Fatal("source regression must remain an explicit failure")
	}
	if repo.matchCalls != 0 || repo.detailCalls != 0 || len(repo.participation) != 0 || len(repo.observations) != 0 {
		t.Fatalf("rejected observation mutated facts: match=%d detail=%d people=%d observations=%d",
			repo.matchCalls, repo.detailCalls, len(repo.participation), len(repo.observations))
	}
}

func TestMatchPollingEvidenceIsIndependentOfParticipationFailure(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	repo.participationErr = errors.New("separate participation failure")
	match := src.fresh
	match.State, match.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
	src.matches = []model.Match{match}
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	result := r.runCycle(context.Background(), false)
	if result.failures == 0 {
		t.Fatal("participation failure was hidden")
	}
	if len(repo.observations) != 1 || len(repo.outcomes) != 1 || repo.outcomes[0] != "ok" {
		t.Fatalf("accepted match observation misreported as polling failure: observations=%v outcomes=%v", repo.observations, repo.outcomes)
	}
}

func TestFailedRecoveryDoesNotSuppressValidScoreboardObservation(t *testing.T) {
	for _, failure := range []string{"row", "observation"} {
		for _, available := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/scoreboard=%t", failure, available), func(t *testing.T) {
				comp, repo, src, now := recoveryFixture()
				src.fresh.State, src.fresh.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
				if failure == "row" {
					repo.upsertFailures = 1
				} else {
					repo.observationFailures = 1
				}
				if available {
					src.matches = []model.Match{src.fresh}
				}
				r := testRunner(src.fakeSource, repo.fakeRepository, comp)
				r.repo, r.source, r.now = repo, src, func() time.Time { return now }
				result := r.runCycle(context.Background(), true)
				if result.failures == 0 {
					t.Fatal("initial recovery write failure was hidden")
				}
				want := "failed"
				if available {
					want = "ok"
					if len(repo.observations) != 1 || repo.lastUpsert.State != model.MatchStateLive ||
						repo.lastUpsert.AwayScore == nil || *repo.lastUpsert.AwayScore != 1 {
						t.Fatalf("valid fallback not persisted: %+v observations=%v", repo.lastUpsert, repo.observations)
					}
				}
				if len(repo.outcomes) != 1 || repo.outcomes[0] != want {
					t.Fatalf("poll outcome=%v want=%s", repo.outcomes, want)
				}
			})
		}
	}
}

func TestFreshBracketCompositionCanRenewObservation(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	comp.Seasons["2026"] = config.Season{ID: "2026", HasBracket: true}
	board := src.fresh
	board.Home.ID, board.Away.ID = "placeholder-home", "placeholder-away"
	board.StatusDetail = "FT"
	src.matches = []model.Match{board}
	src.bracket = []model.BracketMatch{{
		ID: board.ID, Kickoff: board.Kickoff, State: board.State, Round: "final",
		StatusName: board.StatusName, StatusDetail: "Full time",
		Home: model.BracketTeam{ID: "home", Name: "Home"}, Away: model.BracketTeam{ID: "away", Name: "Away"},
		HomeScore: board.HomeScore, AwayScore: board.AwayScore,
	}}
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	r.runCycle(context.Background(), true)
	if len(repo.observations) != 1 || len(repo.outcomes) != 1 || repo.outcomes[0] != "ok" {
		t.Fatalf("valid composed source observation rejected: observations=%v outcomes=%v", repo.observations, repo.outcomes)
	}
}

func TestGracefulCancellationPreservesPreviousPollingOutcome(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	src.matches = []model.Match{src.fresh}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	repo.existingHook = cancel
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	r.ingestCompSeason(ctx, comp, comp.Seasons["2026"], activity{}, false, false)
	if len(repo.outcomes) != 0 {
		t.Fatalf("graceful cancellation replaced previous outcome: %v", repo.outcomes)
	}
}

func TestCycleDeadlineStillRecordsPollingFailure(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	ctx, cancel := context.WithDeadline(context.Background(), time.Unix(0, 0))
	defer cancel()
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	r.ingestCompSeason(ctx, comp, comp.Seasons["2026"], activity{}, false, false)
	if len(repo.outcomes) != 1 || repo.outcomes[0] != "failed" {
		t.Fatalf("cycle deadline hidden: %v", repo.outcomes)
	}
}

func TestBracketObservationUsesInjectedSourceClock(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	comp.Seasons["2026"] = config.Season{ID: "2026", HasBracket: true}
	src.bracket = []model.BracketMatch{{
		ID: "m1", Kickoff: src.fresh.Kickoff, State: model.MatchStateLive, Round: "final",
		StatusName: "STATUS_SECOND_HALF",
		Home:       model.BracketTeam{ID: "home", Name: "Home"}, Away: model.BracketTeam{ID: "away", Name: "Away"},
		HomeScore: src.fresh.HomeScore, AwayScore: src.fresh.AwayScore,
	}}
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	r.runCycle(context.Background(), true)
	if len(repo.observations) != 1 || !repo.observations[0].Equal(now) {
		t.Fatalf("bracket observation escaped injected clock: %v", repo.observations)
	}
}

type summaryResponseTransport string

func (body summaryResponseTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
		Body: io.NopCloser(strings.NewReader(string(body)))}, nil
}

type validatedMatchSource struct {
	*fakeSource
	provider *source.ESPN
}

func (s validatedMatchSource) Summary(ctx context.Context, comp config.Competition, match model.Match) (source.SummaryResult, error) {
	return s.provider.Summary(ctx, comp, match)
}

func (s validatedMatchSource) Bracket(ctx context.Context, comp config.Competition, season config.Season, backfill bool) ([]model.BracketMatch, error) {
	return s.provider.Bracket(ctx, comp, season, backfill)
}

func (s validatedMatchSource) RecoverMatch(ctx context.Context, comp config.Competition, season config.Season, match model.Match) (model.Match, source.SummaryResult, error) {
	return s.provider.RecoverMatch(ctx, comp, season, match)
}

func TestContradictoryOrdinarySummaryCannotReplaceScoreboardFacts(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	src.matches = []model.Match{src.fresh}
	body := `{"header":{"id":"m1","competitions":[{"id":"m1",
		"status":{"type":{"name":"STATUS_SUSPENDED","state":"in","completed":true}},
		"competitors":[
			{"homeAway":"home","team":{"id":"home"},"score":"9"},
			{"homeAway":"away","team":{"id":"away"},"score":"9"}
		]}]},"gameInfo":{"venue":{"fullName":"Test venue"}}}`
	provider := source.NewESPN(espn.NewWithOptions(espn.Options{
		HTTP: &http.Client{Transport: summaryResponseTransport(body)}, MaxAttempts: 1,
	}))
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, validatedMatchSource{src.fakeSource, provider}, func() time.Time { return now }
	result := r.runCycle(context.Background(), true)
	if result.failures == 0 || repo.finalizeCalls != 0 {
		t.Fatalf("contradictory summary finalized: result=%+v finalizations=%d", result, repo.finalizeCalls)
	}
	if len(repo.observedMatches) != 1 || repo.observedMatches[0].HomeScore == nil ||
		*repo.observedMatches[0].HomeScore != 0 || repo.observedMatches[0].AwayScore == nil ||
		*repo.observedMatches[0].AwayScore != 1 {
		t.Fatalf("valid scoreboard evidence lost/replaced: %v", repo.observedMatches)
	}
}

func TestMalformedBracketScoreCannotRenewObservation(t *testing.T) {
	comp, repo, src, now := recoveryFixture()
	repo.pending = nil
	repo.existing["m1"] = store.MatchRow{State: model.MatchStateScheduled}
	comp.Seasons["2026"] = config.Season{ID: "2026", HasBracket: true}
	body := `{"events":[{"id":"m1","date":"2026-09-20T18:00:00Z",
		"season":{"year":2026,"slug":"final"},
		"status":{"type":{"name":"STATUS_SCHEDULED","state":"pre","completed":false}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"home","displayName":"Home","abbreviation":"HOM"},"score":"-1"},
			{"homeAway":"away","team":{"id":"away","displayName":"Away","abbreviation":"AWY"},"score":"0"}
		]}]}]}`
	provider := source.NewESPN(espn.NewWithOptions(espn.Options{
		HTTP: &http.Client{Transport: summaryResponseTransport(body)}, MaxAttempts: 1,
	}))
	r := testRunner(src.fakeSource, repo.fakeRepository, comp)
	r.repo, r.source, r.now = repo, validatedMatchSource{src.fakeSource, provider}, func() time.Time { return now }
	result := r.runCycle(context.Background(), true)
	if result.failures == 0 || len(repo.observations) != 0 || repo.matchCalls != 0 ||
		len(repo.outcomes) != 1 || repo.outcomes[0] != "failed" {
		t.Fatalf("invalid bracket score counted as accepted source data: result=%+v writes=%d observations=%v poll=%v",
			result, repo.matchCalls, repo.observations, repo.outcomes)
	}
}

func TestMalformedRecoveryShootoutCannotWriteMatchFacts(t *testing.T) {
	for _, total := range []string{`-1`, `1.5`, `"not-a-score"`, `"Infinity"`, `1e100`} {
		t.Run(total, func(t *testing.T) {
			comp, repo, src, now := recoveryFixture()
			comp.ESPNSlug = "esp.1"
			body := fmt.Sprintf(`{"header":{"id":"m1","league":{"slug":"esp.1"},"season":{"year":2026},
				"competitions":[{"id":"m1","date":"2026-09-15T08:00:00Z",
				"status":{"type":{"name":"STATUS_FINAL_PEN","state":"post","completed":true}},
				"competitors":[
					{"homeAway":"home","team":{"id":"home"},"score":"1","shootoutScore":%s,"winner":true},
					{"homeAway":"away","team":{"id":"away"},"score":"1","shootoutScore":"4"}
				]}]},"gameInfo":{"venue":{"fullName":"Test venue"}}}`, total)
			provider := source.NewESPN(espn.NewWithOptions(espn.Options{
				HTTP: &http.Client{Transport: summaryResponseTransport(body)}, MaxAttempts: 1,
			}))
			r := testRunner(src.fakeSource, repo.fakeRepository, comp)
			r.repo, r.source, r.now = repo, validatedMatchSource{src.fakeSource, provider}, func() time.Time { return now }
			result := r.runCycle(context.Background(), true)
			if result.failures == 0 || repo.matchCalls != 0 || repo.detailCalls != 0 ||
				repo.finalizeCalls != 0 || len(repo.observations) != 0 {
				t.Fatalf("malformed shootout accepted: result=%+v writes=%d details=%d finalized=%d observations=%v",
					result, repo.matchCalls, repo.detailCalls, repo.finalizeCalls, repo.observations)
			}
		})
	}
}
