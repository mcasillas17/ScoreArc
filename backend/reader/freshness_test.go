package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestFreshnessClockBoundaries(t *testing.T) {
	now := time.Date(2026, 7, 19, 20, 0, 0, 0, time.UTC)
	start, end := now.Add(-24*time.Hour), now.Add(24*time.Hour)
	ptr := func(v time.Time) *time.Time { return &v }
	for _, tc := range []struct {
		name, state, status string
		age, kickoffAge     time.Duration
		missing, finalized  bool
		want                string
		stale, overdue      int
	}{
		{"live before TTL", "live", "", 2*time.Minute - time.Nanosecond, time.Hour, false, false, "fresh", 0, 0},
		{"live at TTL", "live", "", 2 * time.Minute, time.Hour, false, false, "stale", 1, 0},
		{"live before overdue", "live", "", 0, 4*time.Hour - time.Nanosecond, false, false, "fresh", 0, 0},
		{"live just observed still overdue", "live", "", 0, 4 * time.Hour, false, false, "stale", 1, 1},
		{"scheduled before overdue", "scheduled", "", 0, 15*time.Minute - time.Nanosecond, false, false, "fresh", 0, 0},
		{"scheduled at overdue", "scheduled", "", 0, 15 * time.Minute, false, false, "stale", 1, 1},
		{"future at daily cadence", "scheduled", "", 24 * time.Hour, -time.Hour, false, false, "fresh", 0, 0},
		{"future before TTL", "scheduled", "", 25*time.Hour - time.Nanosecond, -time.Hour, false, false, "fresh", 0, 0},
		{"future at TTL", "scheduled", "", 25 * time.Hour, -time.Hour, false, false, "stale", 1, 0},
		{"postponed", "scheduled", "STATUS_POSTPONED", 24*time.Hour - time.Nanosecond, 100 * time.Hour, false, false, "fresh", 0, 0},
		{"postponed TTL", "scheduled", "STATUS_POSTPONED", 24 * time.Hour, 100 * time.Hour, false, false, "stale", 1, 0},
		{"suspended", "live", "STATUS_SUSPENDED", 3 * time.Hour, 100 * time.Hour, false, false, "fresh", 0, 0},
		{"suspended TTL", "live", "STATUS_SUSPENDED", 24 * time.Hour, 100 * time.Hour, false, false, "stale", 1, 0},
		{"finished unfinalized current core", "finished", "", time.Hour, 100 * time.Hour, false, false, "fresh", 0, 0},
		{"finished unfinalized expires", "finished", "", 24 * time.Hour, 100 * time.Hour, false, false, "stale", 1, 0},
		{"finished unfinalized missing", "finished", "", 0, 100 * time.Hour, true, false, "unavailable", 1, 0},
		{"final never expires", "finished", "", 10000 * time.Hour, 10000 * time.Hour, true, true, "fresh", 0, 0},
		{"missing live observation", "live", "", 0, time.Hour, true, false, "unavailable", 1, 0},
		{"overdue beats missing observation", "live", "", 0, 4 * time.Hour, true, false, "stale", 1, 1},
		{"future clock invalid", "live", "", -time.Second, time.Hour, false, false, "unavailable", 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := freshnessMatch{State: tc.state, Status: tc.status, Kickoff: now.Add(-tc.kickoffAge)}
			if !tc.missing {
				row.ObservedAt = ptr(now.Add(-tc.age))
			}
			if tc.finalized {
				row.FinalizedAt = ptr(now.Add(-time.Hour))
			}
			snapshot := freshnessSnapshot{PollStatus: "ok", PollSucceededAt: &now, HasUnfinalized: !tc.finalized, Matches: []freshnessMatch{row}}
			got := computeFreshness(now, start, end, snapshot)
			if got.Status != tc.want || got.StaleMatches != tc.stale || got.OverdueMatches != tc.overdue {
				t.Fatalf("freshness=%+v want=%s stale=%d overdue=%d", got, tc.want, tc.stale, tc.overdue)
			}
		})
	}
}

func TestFreshnessScheduledAcrossDailyReconciliations(t *testing.T) {
	start := time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)
	observed := start
	snapshot := freshnessSnapshot{
		PollStatus: "ok", HasUnfinalized: true,
		Matches: []freshnessMatch{{State: "scheduled", Kickoff: start.Add(14 * 24 * time.Hour), ObservedAt: &observed}},
	}
	// Two full-season reconciliations finish after daily cadence plus the
	// maximum slow-tick alignment and bounded processing allowance. Rolling
	// seven-day polling cannot refresh this distant match in between.
	for day := 0; day < 2; day++ {
		clock := observed.Add(24*time.Hour + 5*time.Minute + 4*time.Minute + 30*time.Second)
		snapshot.PollSucceededAt = &clock
		if snapshot.Matches[0].Kickoff.Sub(clock) <= 7*24*time.Hour {
			t.Fatal("row entered rolling horizon")
		}
		if got := computeFreshness(clock, start, start.Add(30*24*time.Hour), snapshot); got.Status != "fresh" {
			t.Fatalf("daily reconciliation %d produced routine staleness: %+v", day+1, got)
		}
		observed = clock // Successful reconciliation accepts unchanged facts.
	}
	for _, age := range []time.Duration{25*time.Hour - time.Nanosecond, 25 * time.Hour} {
		clock := observed.Add(age)
		snapshot.PollSucceededAt = &clock
		want := "fresh"
		if age == 25*time.Hour {
			want = "stale"
		}
		got := computeFreshness(clock, start, start.Add(30*24*time.Hour), snapshot)
		if got.Status != want || got.OverdueMatches != 0 {
			t.Fatalf("at observation age %v: %+v; want %s", age, got, want)
		}
	}
}

func TestFreshnessStoppedWorkerEmptyDormantAndPollFailures(t *testing.T) {
	now := time.Date(2026, 7, 19, 20, 0, 0, 0, time.UTC)
	start, end := now.Add(-time.Hour), now.Add(time.Hour)
	observed := now.Add(-time.Minute)
	live := freshnessMatch{State: "live", Kickoff: now.Add(-time.Hour), ObservedAt: &observed}
	snapshot := freshnessSnapshot{PollStatus: "ok", PollSucceededAt: &now, HasUnfinalized: true, Matches: []freshnessMatch{live}}
	if got := computeFreshness(now.Add(time.Minute), start, end, snapshot); got.Status != "stale" {
		t.Fatalf("stopped worker at live TTL=%+v", got)
	}
	snapshot.Matches = nil
	for _, delta := range []time.Duration{20*time.Minute - time.Nanosecond, 20 * time.Minute} {
		want := "empty"
		if delta == 20*time.Minute {
			want = "stale"
		}
		if got := computeFreshness(now.Add(delta), start, end, snapshot); got.Status != want {
			t.Fatalf("empty at %v=%+v want %s", delta, got, want)
		}
	}
	snapshot.PollSucceededAt = nil
	snapshot.PollStatus = "unknown"
	if got := computeFreshness(now, start, end, snapshot); got.Status != "unavailable" {
		t.Fatalf("missing poll=%+v", got)
	}
	snapshot.HasUnfinalized = false
	for _, clock := range []time.Time{start.Add(-time.Nanosecond), end} {
		if got := computeFreshness(clock, start, end, snapshot); got.Status != "dormant" {
			t.Fatalf("outside bounds=%+v", got)
		}
	}
	if got := computeFreshness(start, start, end, snapshot); got.Status != "unavailable" {
		t.Fatalf("start is active=%+v", got)
	}
	snapshot.HasUnfinalized = true
	if got := computeFreshness(end, start, end, snapshot); got.Status == "dormant" {
		t.Fatalf("subset cannot hide unresolved competition=%+v", got)
	}
	snapshot.Matches = []freshnessMatch{live}
	if got := computeFreshness(now, start, end, snapshot); got.Status != "unavailable" {
		t.Fatalf("observation cannot replace missing competition poll=%+v", got)
	}
	for _, outcome := range []string{"partial", "failed"} {
		snapshot.PollStatus = outcome
		snapshot.PollSucceededAt = &now
		if got := computeFreshness(now, start, end, snapshot); got.Status != "stale" || got.PollStatus != outcome {
			t.Fatalf("%s poll=%+v", outcome, got)
		}
		snapshot.PollSucceededAt = nil
		snapshot.Matches = nil
		if got := computeFreshness(now, start, end, snapshot); got.Status != "unavailable" {
			t.Fatalf("%s with no successes=%+v", outcome, got)
		}
		snapshot.Matches = []freshnessMatch{live}
	}
	live.State = "finished"
	live.FinalizedAt = &now
	snapshot.Matches = []freshnessMatch{live}
	snapshot.PollStatus = "unknown"
	snapshot.SingleMatch = true
	if got := computeFreshness(now, start, end, snapshot); got.Status != "fresh" {
		t.Fatalf("explicit single finalized match requires no poll heartbeat=%+v", got)
	}
}

func TestFreshnessFinalCollectionsNeedDiscoveryPoll(t *testing.T) {
	now := time.Date(2026, 7, 19, 20, 0, 0, 0, time.UTC)
	start, end := now.Add(-24*time.Hour), now.Add(24*time.Hour)
	finalized := now.Add(-time.Hour)
	for _, tc := range []struct {
		name, pollStatus, want string
		pollAge                time.Duration
		missing                bool
	}{
		{"before poll expiry", "ok", "fresh", 20*time.Minute - time.Nanosecond, false},
		{"at poll expiry", "ok", "stale", 20 * time.Minute, false},
		{"after poll expiry", "ok", "stale", time.Hour, false},
		{"unknown poll", "unknown", "unavailable", 0, true},
		{"partial poll", "partial", "stale", 0, false},
		{"failed poll", "failed", "stale", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := freshnessSnapshot{
				PollStatus: tc.pollStatus,
				Matches:    []freshnessMatch{{State: "finished", FinalizedAt: &finalized}},
			}
			if !tc.missing {
				success := now.Add(-tc.pollAge)
				snapshot.PollSucceededAt = &success
			}
			got := computeFreshness(now, start, end, snapshot)
			if got.Status != tc.want || got.StaleMatches != 0 || got.OverdueMatches != 0 {
				t.Fatalf("all-final collection=%+v want status=%s and zero row counts", got, tc.want)
			}
			if dormant := computeFreshness(end, start, end, snapshot); dormant.Status != "dormant" {
				t.Fatalf("out-of-season settled collection=%+v", dormant)
			}
		})
	}
}

func TestFreshnessFailureIs500WithoutHealthyHeader(t *testing.T) {
	store := &fakeReaderStore{
		freshnessErr: errors.New("private database details"),
		summary:      &MatchSummary{},
		teams:        map[string]*TeamProfile{"arg": {}},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	for _, path := range []string{
		"/v1/competitions/world-cup/2026/matches", "/v1/competitions/world-cup/2026/bracket",
		"/v1/competitions/world-cup/2026/teams/arg", "/v1/matches/" + finalMatchID,
	} {
		response := performRequest(router, "GET", path)
		if response.Code != 500 || response.Header().Get("Cache-Control") != "no-store" ||
			response.Header().Get("X-ScoreArc-Freshness") == "fresh" ||
			response.Body.String() != "{\"error\":\"internal error\"}\n" {
			t.Fatalf("%s => %d %v %s", path, response.Code, response.Header(), response.Body.String())
		}
	}
}

func TestFreshnessRouteUsesReaderClock(t *testing.T) {
	now := time.Date(2026, 7, 19, 20, 0, 0, 0, time.UTC)
	observed := now
	store := &fakeReaderStore{
		matches: []Match{{ID: finalMatchID, State: espn.MatchStateLive}},
		freshness: freshnessSnapshot{
			PollStatus: "ok", PollSucceededAt: &observed, HasUnfinalized: true,
			Matches: []freshnessMatch{{State: "live", Kickoff: now.Add(-time.Hour), ObservedAt: &observed}},
		},
	}
	app := newTestApp(t, store, &fakeNewsReader{})
	app.now = func() time.Time { return now }
	router := app.router()
	before := performRequest(router, "GET", "/v1/competitions/world-cup/2026/matches")
	if before.Header().Get("X-ScoreArc-Freshness") != "fresh" || before.Header().Get("X-ScoreArc-Observed-At") != observed.Format(time.RFC3339) {
		t.Fatalf("before stop=%v", before.Header())
	}
	now = now.Add(2 * time.Minute)
	after := performRequest(router, "GET", "/v1/competitions/world-cup/2026/matches")
	if after.Header().Get("X-ScoreArc-Freshness") != "stale" || before.Body.String() != after.Body.String() {
		t.Fatalf("after stop=%v body=%s", after.Header(), after.Body.String())
	}
}

func TestFreshnessHeadersPreserveMatchRouteBodies(t *testing.T) {
	store := &fakeReaderStore{
		matches: []Match{},
		bracket: []BracketRound{},
		summary: &MatchSummary{},
		teams:   map[string]*TeamProfile{"arg": {Team: espn.Team{ID: "arg"}, Squad: []SquadPlayer{}, Schedule: []Match{}}},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	for _, tc := range []struct {
		path string
		body any
	}{
		{"/v1/competitions/world-cup/2026/matches", store.matches},
		{"/v1/competitions/world-cup/2026/bracket", store.bracket},
		{"/v1/matches/" + finalMatchID, store.summary},
		{"/v1/competitions/world-cup/2026/teams/arg", store.teams["arg"]},
	} {
		t.Run(tc.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.path, nil)
			request.Header.Set("Origin", "https://example.com")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			expected, _ := json.Marshal(tc.body)
			if response.Body.String() != string(expected)+"\n" {
				t.Fatalf("body changed: got %s want %s", response.Body.String(), expected)
			}
			for _, name := range []string{
				"X-ScoreArc-Freshness", "X-ScoreArc-Poll-Status",
				"X-ScoreArc-Stale-Matches", "X-ScoreArc-Overdue-Matches",
			} {
				if response.Header().Get(name) == "" {
					t.Errorf("missing %s", name)
				}
				if !strings.Contains(strings.ToLower(response.Header().Get("Access-Control-Expose-Headers")), strings.ToLower(name)) {
					t.Errorf("CORS does not expose %s", name)
				}
			}
		})
	}
}

func TestOpenAPIFreshnessHeaders(t *testing.T) {
	document := loadOpenAPI(t)
	for _, path := range []string{
		"/v1/competitions/{comp}/{season}/matches",
		"/v1/competitions/{comp}/{season}/bracket",
		"/v1/competitions/{comp}/{season}/teams/{teamId}",
		"/v1/matches/{id}",
	} {
		headers := document.Paths.Value(path).Get.Responses.Status(200).Value.Headers
		for _, name := range []string{"Freshness", "Observed-At", "Poll-Status", "Stale-Matches", "Overdue-Matches"} {
			if headers["X-ScoreArc-"+name] == nil {
				t.Errorf("%s missing header %s", path, name)
			}
		}
	}
	enum := document.Components.Schemas["Match"].Value.Properties["state"].Value.Enum
	if !reflect.DeepEqual(enum, []any{"scheduled", "live", "finished"}) {
		t.Errorf("match state enum changed: %v", enum)
	}
}
