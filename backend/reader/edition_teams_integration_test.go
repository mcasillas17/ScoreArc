package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestEditionMembership(t *testing.T) {
	store, db := newIntegrationStore(t)
	ctx := context.Background()
	seedLigaTeam(t, db)
	exec := func(sql string) {
		t.Helper()
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	// Three entrants in the target season. Its other matches, including one
	// with a placeholder, share participants; the other season has its own club.
	exec(`UPDATE match SET away_placeholder=true WHERE id='018f0000-0000-7000-8000-000000000205';
	UPDATE match SET away_team_id='eng-crestless' WHERE id='018f0000-0000-7000-8000-000000000203';
	INSERT INTO match_sync_status(match_id,source,observed_at) SELECT id,'espn',now() FROM match;
	INSERT INTO match_poll_status(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count) VALUES ('liga-mx','2026-apertura','espn',now(),now(),'ok',3);
	INSERT INTO resource_observation(competition_id,season_id,source,resource,subject,observed_at,row_count) VALUES ('liga-mx','2026-apertura','espn','standings','',now(),1);`)

	app := teamIntegrationApp(t, store, &bytes.Buffer{})
	app.now = func() time.Time { return time.Now().Add(time.Minute) }
	comp, _ := app.registry.Get("liga-mx")
	season := comp.Seasons["2026-apertura"]
	path := "/v1/competitions/liga-mx/2026-apertura/teams"
	read := func(wantIDs []string, availability string) resourceMetadata {
		t.Helper()
		response := performRequest(app.router(), http.MethodGet, path)
		if response.Code != 200 {
			t.Fatalf("directory: %d %s", response.Code, response.Body.String())
		}
		var teams []model.Team
		if err := json.Unmarshal(response.Body.Bytes(), &teams); err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, team := range teams {
			ids = append(ids, team.ID)
		}
		if !slices.Equal(ids, wantIDs) {
			t.Fatalf("IDs = %v, want %v", ids, wantIDs)
		}
		r := resourceHeader(t, response.Header()).Resources["editionTeams"]
		if r.Availability != availability || r.Derivation != "derived" || r.Scope != "competition-season" {
			t.Fatalf("membership evidence %+v", r)
		}
		return r
	}
	read([]string{"mex-america"}, "complete")
	season.Resources = []string{"scores", "teams", "players", "squad"}
	comp.Seasons[season.ID] = season
	read([]string{"mex-america", "nat-arg", "nat-fra"}, "partial")
	for _, suffix := range []string{"/mex-america", "/mex-america/squad"} {
		if got := performRequest(app.router(), http.MethodGet, path+suffix); got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(`"id":"9101"`)) {
			t.Fatalf("team journey %s: %d %s", suffix, got.Code, got.Body.String())
		}
	}
	for _, suffix := range []string{"/eng-crestless", "/eng-crestless/squad"} {
		if got := performRequest(app.router(), http.MethodGet, path+suffix); got.Code != 404 {
			t.Fatalf("other edition %s: %d", suffix, got.Code)
		}
	}
	player := performRequest(app.router(), http.MethodGet, "/v1/competitions/liga-mx/2026-apertura/players/018f0000-0000-7000-8000-000000000101")
	if player.Code != 200 || !bytes.Contains(player.Body.Bytes(), []byte(`"id":"mex-america"`)) {
		t.Fatalf("scoped player journey: %d %s", player.Code, player.Body)
	}
	exec(`INSERT INTO match_poll_status(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count) VALUES ('liga-mx','2026-apertura','espn-season-scoreboard',now(),now(),'ok',3)`)
	read([]string{"mex-america", "nat-arg", "nat-fra"}, "complete")
	exec(`UPDATE match SET home_placeholder=true,away_placeholder=true WHERE competition_id='liga-mx' AND season_id='2026-apertura'`)
	read(nil, "unavailable")
	exec(`UPDATE match SET home_placeholder=false,away_placeholder=false WHERE competition_id='liga-mx' AND season_id='2026-apertura'`)
	exec(`UPDATE match_poll_status SET succeeded_at=now()-interval '26 hours' WHERE source='espn-season-scoreboard'`)
	if got := read([]string{"mex-america", "nat-arg", "nat-fra"}, "complete"); got.Status != "stale" {
		t.Fatalf("full discovery expiry: %+v", got)
	}
	exec(`UPDATE match_poll_status SET event_count=2 WHERE source='espn-season-scoreboard'`)
	read([]string{"mex-america", "nat-arg", "nat-fra"}, "partial")
	exec(`UPDATE match_poll_status SET outcome='failed' WHERE source='espn-season-scoreboard'`)
	read([]string{"mex-america", "nat-arg", "nat-fra"}, "partial")
	exec(`DELETE FROM match_sync_status`)
	read(nil, "unavailable")
	exec(`DELETE FROM match WHERE competition_id='liga-mx' AND season_id='2026-apertura';
	UPDATE match_poll_status SET outcome='ok',event_count=0,succeeded_at=now() WHERE source='espn-season-scoreboard'`)
	read(nil, "empty")
	season.Resources = []string{"teams", "standings"}
	comp.Seasons[season.ID] = season
	exec(`INSERT INTO team(id,kind,name,abbr) SELECT 'cap-'||i,'club','Cap '||i,'CAP' FROM generate_series(1,100) i;
	INSERT INTO standing(competition_id,season_id,team_id,rank,source) SELECT 'liga-mx','2026-apertura','cap-'||i,i+1,'espn' FROM generate_series(1,100) i`)
	if got := performRequest(app.router(), http.MethodGet, path); got.Code != 500 || got.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("101 entrants returned %d", got.Code)
	}
	season.Resources = []string{"scores"}
	comp.Seasons[season.ID] = season
	if got := performRequest(app.router(), http.MethodGet, path); got.Code != 404 {
		t.Fatalf("disabled teams: %d", got.Code)
	}
}
