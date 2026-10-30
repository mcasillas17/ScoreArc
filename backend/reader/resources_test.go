package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Removing any route's metadata or trusting a legacy row as observed breaks this contract.
func TestEveryDataRouteDisclosesResourceEvidence(t *testing.T) {
	fake := &fakeReaderStore{summary: &MatchSummary{}, boxScore: &BoxScore{}, player: &PlayerProfile{}, teams: map[string]*TeamProfile{"nat-arg": {}}}
	app := newTestApp(t, fake, &fakeNewsReader{})
	paths := []string{"matches", "calendar", "standings", "bracket", "leaders", "top-scorers", "teams/nat-arg", "teams/nat-arg/squad", "players/019c0000-0000-7000-8000-000000000001"}
	for _, p := range paths {
		assertResources(t, performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/"+p).Header().Get("X-ScoreArc-Resources"))
	}
	for _, p := range []string{"/v1/matches/" + finalMatchID, "/v1/matches/" + finalMatchID + "/box-score", "/v1/competitions/world-cup/news"} {
		assertResources(t, performRequest(app.router(), "GET", p).Header().Get("X-ScoreArc-Resources"))
	}
}
func assertResources(t *testing.T, raw string) {
	t.Helper()
	var envelope struct {
		Version   int                        `json:"version"`
		Resources map[string]json.RawMessage `json:"resources"`
	}
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil || envelope.Version != 1 || len(envelope.Resources) == 0 {
		t.Fatalf("missing resource evidence: %q %v", raw, err)
	}
	if len(raw) > 8192 || len(envelope.Resources) > 8 {
		t.Fatalf("unbounded metadata: %s", raw)
	}
	for _, encoded := range envelope.Resources {
		var r map[string]any
		if err := json.Unmarshal(encoded, &r); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"status", "availability", "source", "derivation", "scope", "observedAt", "finalizedAt"} {
			if _, ok := r[key]; !ok {
				t.Fatalf("missing %s in %s", key, encoded)
			}
		}
		if r["observedAt"] != nil {
			if _, err := time.Parse(time.RFC3339Nano, r["observedAt"].(string)); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestResourceEvidenceBoundariesAndPartialCoverage(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		age  time.Duration
		rows int
		want string
	}{
		{"before", 20*time.Minute - time.Nanosecond, 2, "fresh"}, {"boundary", 20 * time.Minute, 2, "stale"}, {"empty", 0, 0, "empty"}, {"expired empty", 20 * time.Minute, 0, "stale"}, {"future", -time.Nanosecond, 1, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			at := now.Add(-tc.age)
			got := collectionResource(now, &collectionEvidence{ObservedAt: &at, RowCount: tc.rows}, 20*time.Minute, "competition-season", "direct", false)
			if got.Status != tc.want {
				t.Fatalf("got %+v", got)
			}
		})
	}
	got := aggregateResource(now, aggregateEvidence{Count: 2, Known: 1, ObservedAt: &now}, 25*time.Hour, "team-season", false)
	if got.Status != "unavailable" || got.Availability != "partial" {
		t.Fatalf("healthy one player hid missing other statistics: %+v", got)
	}
	p := participationResource(now, aggregateEvidence{Count: 1}, "match")
	if p.Availability != "unavailable" {
		t.Fatalf("no held participation invented partial capture: %+v", p)
	}
}

func TestResourcesDormancyDoesNotHideParticipationWork(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.now = func() time.Time { return now }
	observed := now.Add(-time.Hour)
	scope := resourceScope{freshnessScope: freshnessScope{Competition: "world-cup", Season: "2026"}, Route: "team"}
	snapshot := resourceSnapshot{CoreFound: true, Unresolved: true, Core: freshnessSnapshot{PollSucceededAt: &observed, PollStatus: "ok"}, Standings: &collectionEvidence{ObservedAt: &observed, RowCount: 2}}
	e, old, err := app.resourceMap(scope, snapshot)
	if err != nil || old.Status != "dormant" {
		t.Fatalf("legacy match header changed: %+v %v", old, err)
	}
	if e.Resources["standings"].Status != "stale" || e.Resources["matches"].Status == "dormant" {
		t.Fatalf("participation backlog hidden: %+v", e)
	}
	snapshot.Unresolved = false
	e, _, err = app.resourceMap(scope, snapshot)
	if err != nil || e.Resources["standings"].Status != "dormant" || e.Resources["identity"].Status != "unavailable" || e.Resources["detail"].Status != "unavailable" {
		t.Fatalf("dormancy scope: %+v %v", e, err)
	}
}

func TestResourceHeaderHardBounds(t *testing.T) {
	for _, count := range []int{0, 9} {
		w := httptest.NewRecorder()
		e := resourceEnvelope{Version: 1, Resources: map[string]resourceMetadata{}}
		for i := 0; i < count; i++ {
			e.Resources[fmt.Sprintf("r%d", i)] = unknownResource("selection", "direct")
		}
		if err := writeResources(w, e); err == nil || w.Header().Get(resourcesHeader) != "" {
			t.Fatalf("resource count %d escaped bound", count)
		}
	}
	w := httptest.NewRecorder()
	huge := unknownResource(strings.Repeat("x", 8192), "direct")
	if err := writeResources(w, resourceEnvelope{Version: 1, Resources: map[string]resourceMetadata{"matches": huge}}); err == nil || w.Header().Get(resourcesHeader) != "" {
		t.Fatal("oversized resource header escaped bound")
	}
}

func TestParticipationAggregateRejectsAnyFutureTimestamp(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	future := now.Add(time.Nanosecond)
	e := aggregateEvidence{Count: 2, Completed: 2, Held: 22, ObservedAt: &past, FinalizedAt: &past, LatestAt: &future}
	if got := participationResource(now, e, "selection"); got.Status != "unavailable" || got.Availability != "partial" {
		t.Fatalf("minimum timestamp hid future completion: %+v", got)
	}
}
