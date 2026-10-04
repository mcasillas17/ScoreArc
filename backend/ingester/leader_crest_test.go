package main

import (
	"context"
	"errors"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

// A leader crest is keyed by the leader team's canonical id, the key team
// crests use, so its mirrored URL is derivable from the team and does not move
// when the upstream logo URL does.
func TestLeaderCrestKeysFollowTheCanonicalTeam(t *testing.T) {
	comp := config.Competition{ID: "test", CurrentSeasonId: "2026", Seasons: map[string]config.Season{"2026": {ID: "2026"}}}
	leader := func(crest string) model.StatLeader {
		return model.StatLeader{Rank: 1, Player: "Scorer", TeamSourceID: "478", TeamAbbr: "FRA", TeamName: "France", TeamCrestURL: &crest, Value: 1}
	}
	var urls []string
	for _, crest := range []string{"https://a.espncdn.com/i/teamlogos/478.png", "https://a.espncdn.com/i/teamlogos/478-v2.png"} {
		// A fresh process each time: no in-memory memo carries the key over.
		worker := testRunner(&fakeSource{}, &fakeRepository{existing: map[string]store.MatchRow{}}, comp)
		mirror := &fakeMirror{}
		worker.mirror = mirror
		rows := worker.mirrorLeaders(context.Background(), comp, []model.StatLeader{leader(crest)})
		if len(mirror.callIDs) != 1 || mirror.callIDs[0] != fakeTeamID("478") {
			t.Fatalf("mirrored under %v, want the canonical team id", mirror.callIDs)
		}
		urls = append(urls, *rows[0].TeamCrestURL)
	}
	if urls[0] != "https://cdn.example/teams/"+fakeTeamID("478") || urls[1] != urls[0] {
		t.Fatalf("leader crest URLs %v, want one team-keyed URL", urls)
	}
}

// A leader whose team cannot be resolved keeps its upstream URL (which the
// frontend's host allowlist still screens) rather than a key derived from the
// URL or the team's display name.
func TestLeaderCrestWithoutAResolvableTeamIsNotMirrored(t *testing.T) {
	comp := config.Competition{ID: "test", CurrentSeasonId: "2026", Seasons: map[string]config.Season{"2026": {ID: "2026"}}}
	crest := "https://a.espncdn.com/i/teamlogos/0.png"
	for name, c := range map[string]struct {
		sourceID string
		err      error
	}{
		"no provider team id": {"", nil},
		"resolver failure":    {"478", errors.New("identity unavailable")},
	} {
		t.Run(name, func(t *testing.T) {
			worker := testRunner(&fakeSource{}, &fakeRepository{existing: map[string]store.MatchRow{}, teamErr: c.err}, comp)
			mirror := &fakeMirror{}
			worker.mirror = mirror
			rows := worker.mirrorLeaders(context.Background(), comp, []model.StatLeader{{
				Rank: 1, Player: "Scorer", TeamSourceID: c.sourceID, TeamAbbr: "FRA", TeamName: "France", TeamCrestURL: &crest, Value: 1,
			}})
			if mirror.calls != 0 || *rows[0].TeamCrestURL != crest {
				t.Fatalf("mirror calls %d, crest %q", mirror.calls, *rows[0].TeamCrestURL)
			}
		})
	}
}
