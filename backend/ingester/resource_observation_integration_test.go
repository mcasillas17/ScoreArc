package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestResourceObservationsWithPostgresAcrossMemoAndRestart(t *testing.T) {
	ctx := context.Background()
	repo, pool, _ := newRecoveryPostgres(t)
	comp := config.Competition{ID: "observations", Name: "Observations", ShortName: "OBS", ESPNSlug: "test.1", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026", Label: "2026"}, "2027": {ID: "2027", Label: "2027"}}}
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}
	src := &fakeSource{standings: []model.Standing{standingFixture()}}
	worker := testRunner(src, &fakeRepository{}, comp)
	worker.repo = repo
	season := comp.Seasons["2026"]
	if err := worker.refreshStandings(ctx, comp, season, false, false); err != nil {
		t.Fatal(err)
	}
	if err := worker.refreshLeaders(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	old := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	age := func() {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE resource_observation SET observed_at=$1 WHERE competition_id=$2`, old, comp.ID); err != nil {
			t.Fatal(err)
		}
	}
	observed := func(resource, subject, seasonID string) (time.Time, int) {
		t.Helper()
		var at time.Time
		var count int
		if err := pool.QueryRow(ctx, `SELECT observed_at,row_count FROM resource_observation WHERE competition_id=$1 AND season_id=$2 AND source='espn' AND resource=$3 AND subject=$4`, comp.ID, seasonID, resource, subject).Scan(&at, &count); err != nil {
			t.Fatal(err)
		}
		return at, count
	}
	factVersion := func() string {
		t.Helper()
		var version string
		if err := pool.QueryRow(ctx, `SELECT string_agg(version,',' ORDER BY version) FROM (SELECT 'standing:'||xmin::text AS version FROM standing WHERE competition_id=$1 UNION ALL SELECT category||':'||xmin::text FROM top_scorer WHERE competition_id=$1) facts`, comp.ID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		return version
	}
	age()
	before := factVersion()
	if err := worker.refreshStandings(ctx, comp, season, false, false); err != nil {
		t.Fatal(err)
	}
	if err := worker.refreshLeaders(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	for _, scope := range [][2]string{{"standings", ""}, {"leaders", "goals"}, {"leaders", "assists"}} {
		if at, count := observed(scope[0], scope[1], "2026"); !at.After(old) || count != 1 {
			t.Fatalf("memo observation %v = %v/%d", scope, at, count)
		}
	}
	if after := factVersion(); after != before {
		t.Fatalf("memo rewrote fact tuples: %s -> %s", before, after)
	}

	age()
	src.statistics = []byte(`{"stats":[{"name":"goalsLeaders","leaders":[{"value":1,"displayValue":"Matches: 1, Goals: 1","athlete":{"displayName":"Winner","team":{}}}]},{"name":"assistsLeaders","leaders":[{"value":null,"athlete":{"displayName":"Helper"}}]}]}`)
	if err := worker.refreshLeaders(ctx, comp, season); err == nil {
		t.Fatal("invalid assists accepted")
	}
	if at, _ := observed("leaders", "goals", "2026"); !at.After(old) {
		t.Fatal("valid goals did not renew")
	}
	if at, _ := observed("leaders", "assists", "2026"); !at.Equal(old) {
		t.Fatal("invalid assists renewed")
	}

	age()
	src.statistics = statisticsPayload(t, nil, nil)
	src.standings = []model.Standing{}
	if err := worker.refreshLeaders(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	if err := worker.refreshStandings(ctx, comp, season, false, false); err == nil {
		t.Fatal("empty source replaced retained standings")
	}
	for _, scope := range [][2]string{{"standings", ""}, {"leaders", "goals"}, {"leaders", "assists"}} {
		if at, count := observed(scope[0], scope[1], "2026"); !at.Equal(old) || count != 1 {
			t.Fatalf("empty source renewed retained %v", scope)
		}
	}
	if err := worker.refreshLeaders(ctx, comp, comp.Seasons["2027"]); err != nil {
		t.Fatal(err)
	}
	if err := worker.refreshStandings(ctx, comp, comp.Seasons["2027"], false, false); err != nil {
		t.Fatal(err)
	}
	for _, scope := range [][2]string{{"standings", ""}, {"leaders", "goals"}, {"leaders", "assists"}} {
		if at, count := observed(scope[0], scope[1], "2027"); !at.After(old) || count != 0 {
			t.Fatalf("empty season observation %v = %v/%d", scope, at, count)
		}
	}

	// No worker activity, restart, or failed source read may create a heartbeat.
	age()
	restarted := testRunner(src, &fakeRepository{}, comp)
	restarted.repo = repo
	src.statisticsErr = errors.New("provider unavailable")
	src.standingsErr = errors.New("provider unavailable")
	if err := restarted.refreshLeaders(ctx, comp, season); err == nil {
		t.Fatal("missing source error")
	}
	if err := restarted.refreshStandings(ctx, comp, season, false, false); err == nil {
		t.Fatal("missing source error")
	}
	for _, scope := range [][2]string{{"standings", ""}, {"leaders", "goals"}, {"leaders", "assists"}} {
		if at, _ := observed(scope[0], scope[1], "2026"); !at.Equal(old) {
			t.Fatalf("restart renewed %v without a successful source", scope)
		}
	}
}
