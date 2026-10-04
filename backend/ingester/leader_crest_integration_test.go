package main

import (
	"context"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// The real resolver: a curated team (a synthetic seed entry, not the production
// seed) and an unseeded team that becomes provisional both key their leader
// crest under the canonical id they resolve to, and that team's own crest is the
// same object. A leader without a provider team id keeps its upstream URL.
func TestLeaderCrestsResolveCuratedAndProvisionalTeamsWithPostgres(t *testing.T) {
	ctx := context.Background()
	repo, pool, _ := newRecoveryPostgres(t)
	comp := config.Competition{ID: "leader-crests", Name: "Leader Crests", ShortName: "Leader Crests",
		ESPNSlug: "test.1", CurrentSeasonId: "2026", Seasons: map[string]config.Season{"2026": {ID: "2026", Label: "2026"}}}
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ApplyTeamSeed(ctx, []config.SeedTeam{{
		ID: "tst-curated-fc", Kind: "club", Name: "Curated FC", Abbr: "CUR", Country: "TST", Refs: map[string]string{"espn": "4101"},
	}}); err != nil {
		t.Fatal(err)
	}
	crest := func(name string) *string {
		url := "https://a.espncdn.com/i/teamlogos/soccer/500/" + name + ".png"
		return &url
	}
	src := &fakeSource{statistics: statisticsPayload(t, []model.StatLeader{
		{Rank: 1, Player: "Curated Scorer", TeamSourceID: "4101", TeamAbbr: "CUR", TeamName: "Curated FC", TeamCrestURL: crest("4101"), Value: 3},
		{Rank: 2, Player: "Unseeded Scorer", TeamSourceID: "4102", TeamAbbr: "UNS", TeamName: "Unseeded FC", TeamCrestURL: crest("4102"), Value: 2},
		{Rank: 3, Player: "Teamless Scorer", TeamCrestURL: crest("teamless"), Value: 1},
	}, nil)}
	worker := testRunner(src, &fakeRepository{}, comp)
	worker.repo = repo
	worker.mirror = &fakeMirror{}
	if err := worker.refreshLeaders(ctx, comp, comp.Seasons["2026"]); err != nil {
		t.Fatal(err)
	}

	rows, err := pool.Query(ctx, `SELECT s.player, s.team_crest_url, t.crest_url, t.provisional
		FROM top_scorer s LEFT JOIN team t ON t.crest_url = s.team_crest_url
		WHERE s.competition_id = $1 AND s.category = 'goals' ORDER BY s.rank`, comp.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type row struct {
		player, leaderCrest string
		teamCrest           *string
		provisional         *bool
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.player, &r.leaderCrest, &r.teamCrest, &r.provisional); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("stored %d leaders", len(got))
	}
	for i, want := range []struct {
		crest       string
		provisional bool
	}{
		{"https://cdn.example/teams/tst-curated-fc", false},
		{"https://cdn.example/teams/prov-espn-4102", true},
	} {
		if got[i].leaderCrest != want.crest || got[i].teamCrest == nil || *got[i].provisional != want.provisional {
			t.Fatalf("%s: leader crest %q, team crest %v, provisional %v", got[i].player, got[i].leaderCrest, got[i].teamCrest, got[i].provisional)
		}
	}
	if got[2].leaderCrest != *crest("teamless") || got[2].teamCrest != nil {
		t.Fatalf("teamless leader crest %q", got[2].leaderCrest)
	}
}
