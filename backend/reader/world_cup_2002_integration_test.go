package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

type recordedWorldCup2002 struct {
	Standings json.RawMessage
	Rosters   map[string]json.RawMessage
}

func (a recordedWorldCup2002) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.RawQuery != "season=2002" {
		return nil, fmt.Errorf("unexpected archive request %s", r.URL)
	}
	var body json.RawMessage
	switch path.Base(r.URL.Path) {
	case "standings":
		body = a.Standings
	case "roster":
		body = a.Rosters[path.Base(path.Dir(r.URL.Path))]
	default:
		return nil, fmt.Errorf("unexpected archive path %s", r.URL.Path)
	}
	status := http.StatusOK
	if body == nil {
		status = http.StatusNotFound
	}
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body))}, nil
}

func TestWorldCup2002ArchiveReader(t *testing.T) {
	ctx := context.Background()
	reader, owner := newIntegrationStore(t)
	app := teamIntegrationApp(t, reader, &bytes.Buffer{})
	app.now = func() time.Time { return time.Now().Add(48 * time.Hour) }
	router := app.router()

	if _, err := owner.Exec(ctx, `CREATE ROLE archive_ingester LOGIN PASSWORD 'archive_ingester'; GRANT scorearc_ingester TO archive_ingester`); err != nil {
		t.Fatal(err)
	}
	conn := owner.Config().ConnConfig
	writer, err := writerstore.New(ctx, fmt.Sprintf("postgres://archive_ingester:archive_ingester@%s:%d/%s?sslmode=disable", conn.Host, conn.Port, conn.Database))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	seed, err := config.LoadTeams()
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.ApplyTeamSeed(ctx, seed); err != nil {
		t.Fatal(err)
	}
	cup, _ := app.registry.Get("world-cup")
	if err := writer.ApplyCompetitionSeed(ctx, []config.Competition{cup}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../shared/source/testdata/world-cup-2002.json")
	if err != nil {
		t.Fatal(err)
	}
	var archive recordedWorldCup2002
	if err := json.Unmarshal(raw, &archive); err != nil {
		t.Fatal(err)
	}
	provider := source.NewESPN(espn.NewWithOptions(espn.Options{HTTP: &http.Client{Transport: archive}, MaxAttempts: 1}))
	standings, squads, err := provider.WorldCup2002Archive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.ApplyWorldCup2002Archive(ctx, standings, squads); err != nil {
		t.Fatal(err)
	}

	const base = "/v1/competitions/world-cup/2002"
	get := func(suffix string, target any) resourceEnvelope {
		t.Helper()
		r := performRequest(router, http.MethodGet, base+suffix)
		if r.Code != 200 {
			t.Fatalf("%s: HTTP %d %s", suffix, r.Code, r.Body)
		}
		if err := json.Unmarshal(r.Body.Bytes(), target); err != nil {
			t.Fatal(err)
		}
		return resourceHeader(t, r.Header())
	}
	var teams []espn.Team
	field := get("/teams", &teams).Resources["editionTeams"]
	if len(teams) != 32 || field.Availability != "complete" || field.Status != "dormant" {
		t.Fatalf("entrant count=%d evidence=%+v", len(teams), field)
	}
	for _, id := range []string{"nat-chn", "nat-sen", "nat-cro"} {
		var players []SquadPlayer
		r := get("/teams/"+id+"/squad", &players).Resources["squad"]
		if r.Source != "espn" || r.Derivation != "edition-roster" || r.Scope != "team-season" {
			t.Errorf("%s source=%+v", id, r)
		}
		if id != "nat-cro" {
			if len(players) != 0 || r.Availability != "unavailable" || r.ObservedAt != nil {
				t.Errorf("%s unobserved roster: count=%d proof=%+v", id, len(players), r)
			}
			continue
		}
		if len(players) != 22 || r.Availability != "complete" || r.ObservedAt == nil {
			t.Fatalf("Croatia roster count=%d proof=%+v", len(players), r)
		}
		var found bool
		for _, p := range players {
			if p.ID == "19278" && p.Name == "Davor Vugrinec" && p.Jersey != nil && *p.Jersey == 7 && p.Age == nil && p.Position == "-" {
				found = true
			}
		}
		if !found {
			t.Fatal("Davor missing from Croatian roster")
		}
	}
	var refs []IdentityReference
	get("/identities?kind=player&from=espn&ids=19278", &refs)
	if len(refs) != 1 || refs[0].CanonicalID == nil {
		t.Fatalf("unresolved player: %+v", refs)
	}
	id := *refs[0].CanonicalID
	// Simulate a biography observed today independently of the historical squad.
	_, err = owner.Exec(ctx, `UPDATE player SET birth_date='1975-03-24' WHERE id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO player_team_history(player_id,team_source_id,team_name,seasons,ord,source) VALUES($1,'999','Modern Club','2026',0,'espn')`, id)
	if err != nil {
		t.Fatal(err)
	}
	var p PlayerProfile
	metadata := get("/players/"+id, &p)
	if p.Team == nil || p.Team.ID != "nat-cro" || p.Team.CrestURL == nil || *p.Team.CrestURL != "https://a.espncdn.com/i/teamlogos/countries/500/cro.png" {
		t.Fatalf("archived Croatian team: %+v", p.Team)
	}
	if p.ID != id || p.Name != "Davor Vugrinec" || p.Jersey == nil || *p.Jersey != "7" || p.Age != nil || len(p.Career) != 0 {
		t.Fatalf("archive player: %+v", p)
	}
	if metadata.Resources["seasonStats"].Availability != "complete" || metadata.Resources["career"].Availability != "unavailable" {
		t.Fatalf("player observations: %+v", metadata)
	}
	values := map[string]int{}
	for _, total := range p.Totals {
		if total.Value != nil {
			values[total.Name] = *total.Value
		}
	}
	for name, want := range map[string]int{"appearances": 2, "subIns": 1, "totalGoals": 0, "goalAssists": 0} {
		if got, ok := values[name]; !ok || got != want {
			t.Errorf("%s: got %d, present=%v", name, got, ok)
		}
	}

	t.Run("website slug", func(t *testing.T) {
		vitest, err := filepath.Abs("../../node_modules/.bin/vitest")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(vitest); os.IsNotExist(err) {
			t.Skip("npm ci enables the website integration")
		}
		server := httptest.NewServer(router)
		defer server.Close()
		cmd := exec.CommandContext(t.Context(), vitest, "run", "src/server/data/archivePlayer.test.ts", "-t", "through the imported Go reader")
		cmd.Dir = "../.."
		cmd.Env = append(os.Environ(), "SCOREARC_TEST_ARCHIVE_READER="+server.URL)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("website player slug: %v\n%s", err, out)
		}
	})

	// Legacy memberships can survive a failed or missing capture. A canonical
	// address must not bypass the proof required by the slug directory.
	if _, err := owner.Exec(ctx, `DELETE FROM resource_observation WHERE competition_id='world-cup' AND season_id='2002' AND subject='nat-cro' AND resource='squad' AND source='espn-edition-verified'`); err != nil {
		t.Fatal(err)
	}
	unproven := performRequest(router, http.MethodGet, base+"/players/"+id)
	if unproven.Code != http.StatusServiceUnavailable || unproven.Header().Get("Cache-Control") != "no-store" || resourceHeader(t, unproven.Header()).Resources["squad"].Availability != "unavailable" {
		t.Fatalf("player without roster proof: HTTP %d %s", unproven.Code, unproven.Body)
	}
}
