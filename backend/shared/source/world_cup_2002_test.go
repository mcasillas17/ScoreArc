package source

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// The capture retains the competition, season, standings and roster identity
// fields from the 33 season-qualified requests. The two 404s have no roster.
type archiveCapture struct {
	Standings json.RawMessage
	Rosters   map[string]json.RawMessage
}

func recordedArchive(t *testing.T) archiveCapture {
	t.Helper()
	raw, err := os.ReadFile("testdata/world-cup-2002.json")
	if err != nil {
		t.Fatal(err)
	}
	var capture archiveCapture
	if err := json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err)
	}
	return capture
}

func archiveProvider(t *testing.T, capture archiveCapture, status map[string]int) (*ESPN, *[]string) {
	t.Helper()
	var requests []string
	client := espn.NewWithOptions(espn.Options{MaxAttempts: 1, HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.URL.String())
		u := req.URL
		if u.Scheme != "https" || u.Host != "site.api.espn.com" || u.RawQuery != "season=2002" || req.Method != http.MethodGet {
			t.Fatalf("unexpected archive request: %v", req)
		}
		var raw []byte
		code := http.StatusOK
		switch {
		case u.Path == "/apis/v2/sports/soccer/fifa.world/standings":
			raw = capture.Standings
		case strings.HasPrefix(u.Path, "/apis/site/v2/sports/soccer/fifa.world/teams/") && path.Base(u.Path) == "roster":
			id := path.Base(path.Dir(u.Path))
			raw = capture.Rosters[id]
			if raw == nil {
				code = http.StatusNotFound
			}
			if s, found := status[id]; found {
				code = s
			}
		default:
			t.Fatalf("unexpected archive path: %s", u)
		}
		return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(raw))}, nil
	})}})
	return NewESPN(client), &requests
}

func TestWorldCup2002Archive(t *testing.T) {
	capture := recordedArchive(t)
	provider, requests := archiveProvider(t, capture, nil)
	rows, squads, err := provider.WorldCup2002Archive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 33 || len(rows) != 32 || len(squads) != 30 {
		t.Fatalf("%d requests, %d standings, %d squads", len(*requests), len(rows), len(squads))
	}
	var croatiaCrest string
	for _, row := range rows {
		if row.Team.ID == "477" && row.Team.CrestURL != nil {
			croatiaCrest = *row.Team.CrestURL
		}
	}
	if croatiaCrest != "https://a.espncdn.com/i/teamlogos/countries/500/cro.png" {
		t.Fatalf("Croatia archive crest = %q", croatiaCrest)
	}
	total := 0
	for _, squad := range squads {
		total += len(squad.Players)
	}
	if total != 688 || len(squads["477"].Players) != 22 || squads["477"].Players[0].FullName != "Tomislav Butina" {
		t.Fatalf("players=%d, Croatia=%+v", total, squads["477"])
	}
	found := false
	for _, player := range squads["477"].Players {
		if player.SourceID == "19278" {
			found = true
			if player.Position != "-" || player.Stats == nil || player.Stats.Appearances == nil || *player.Stats.Appearances != 2 {
				t.Fatalf("Vugrinec archive fields = %+v", player)
			}
		}
	}
	if !found {
		t.Fatal("missing Vugrinec")
	}
	if _, ok := squads["658"]; ok {
		t.Fatal("China's 404 became a squad")
	}
	if _, ok := squads["654"]; ok {
		t.Fatal("Senegal's 404 became a squad")
	}
}

func TestWorldCup2002ArchivePreservesPlayerDisplayName(t *testing.T) {
	provider, _ := archiveProvider(t, recordedArchive(t), nil)
	_, squads, err := provider.WorldCup2002Archive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, player := range squads["202"].Players {
		if player.SourceID == "2674" {
			if player.FullName != "Cristian González" || player.DisplayName != "Kily González" {
				t.Fatalf("Argentina player names = %q / %q", player.FullName, player.DisplayName)
			}
			return
		}
	}
	t.Fatal("missing Argentina player 2674")
}

func TestWorldCup2002ArchiveRejectsIncompleteStandingsBeforeFetchingRosters(t *testing.T) {
	capture := recordedArchive(t)
	for _, tc := range []struct{ name, from, to string }{
		{"unverified league", `s:600~l:606`, `s:600~l:999`},
		{"wrong table league", `/league/fifa.world`, `/league/fifa.wwc`},
		{"wrong edition", `"year":2002`, `"year":2026`},
		{"wrong table year", `"season":2002`, `"season":2006`},
		{"duplicate group", `"name":"Group B"`, `"name":"Group A"`},
		{"duplicate entrant across tables", `"id":"164"`, `"id":"212"`},
		{"wrong entrant", `"id":"164"`, `"id":"12345"`},
		{"partial directory", `"children":`, `"truncated":true,"children":`},
		{"missing rankings", `"name":"rank"`, `"name":"unknown"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := capture
			c.Standings = bytes.Replace(c.Standings, []byte(tc.from), []byte(tc.to), 1)
			provider, requests := archiveProvider(t, c, nil)
			rows, squads, err := provider.WorldCup2002Archive(context.Background())
			if err == nil || rows != nil || squads != nil || len(*requests) != 1 {
				t.Fatalf("rows=%d, squads=%d, requests=%d, err=%v", len(rows), len(squads), len(*requests), err)
			}
		})
	}
}

func TestWorldCup2002ArchiveRejectsUnverifiedRoster(t *testing.T) {
	for _, tc := range []struct {
		name, from, to string
		code           int
	}{
		{"HTTP failure", "", "", 503},
		{"previously available roster now 404", "", "", 404},
		{"wrong team", `"id":"477"`, `"id":"478"`, 200},
		{"wrong competition", `2002 FIFA World Cup`, `2002 FIFA Women's World Cup`, 200},
		{"wrong season", `"year":2002`, `"year":2026`, 200},
		{"mismatched team season", `"seasonSummary":"2002"`, `"seasonSummary":"2026"`, 200},
		{"club", `"isNational":true`, `"isNational":false`, 200},
		{"truncated collection", `"athletes":`, `"hasMore":true,"athletes":`, 200},
		{"grouped athletes", `"athletes":`, `"athletes":[{"items":[]}],"ignore":`, 200},
		{"wrong statistic split", `"type":"total"`, `"type":"home"`, 200},
		{"short collection", `"athletes":`, `"athletes":[],"ignore":`, 200},
		{"unverified player", `"uid":"s:600~a:19212"`, `"uid":"s:600~a:9"`, 200},
		{"player appears on two squads", `"id":"19212","uid":"s:600~a:19212"`, `"id":"2726","uid":"s:600~a:2726"`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := recordedArchive(t)
			if tc.from != "" {
				if !bytes.Contains(c.Rosters["477"], []byte(tc.from)) {
					t.Fatalf("recording missing %s", tc.from)
				}
				c.Rosters["477"] = bytes.Replace(c.Rosters["477"], []byte(tc.from), []byte(tc.to), 1)
			}
			provider, _ := archiveProvider(t, c, map[string]int{"477": tc.code})
			rows, squads, err := provider.WorldCup2002Archive(context.Background())
			if err == nil || rows != nil || squads != nil {
				t.Fatalf("accepted %s: rows=%d, squads=%d, err=%v", tc.name, len(rows), len(squads), err)
			}
		})
	}
}

func TestWorldCup2002ArchiveAcceptsRecoveredSquad(t *testing.T) {
	c := recordedArchive(t)
	var roster struct {
		Season, Team map[string]any
		Status       string
		Athletes     []map[string]any
	}
	if err := json.Unmarshal(c.Rosters["205"], &roster); err != nil {
		t.Fatal(err)
	}
	roster.Team["id"] = "658"
	roster.Team["displayName"] = "China"
	roster.Team["abbreviation"] = "CHN"
	for i, player := range roster.Athletes {
		id := fmt.Sprintf("900000%d", i)
		player["id"] = id
		player["uid"] = "s:600~a:" + id
	}
	raw, err := json.Marshal(map[string]any{"status": roster.Status, "season": roster.Season, "team": roster.Team, "athletes": roster.Athletes})
	if err != nil {
		t.Fatal(err)
	}
	c.Rosters["658"] = raw
	provider, _ := archiveProvider(t, c, nil)
	_, squads, err := provider.WorldCup2002Archive(context.Background())
	if err != nil || len(squads) != 31 || len(squads["658"].Players) != 23 {
		t.Fatalf("recovered squad length=%d: %v", len(squads["658"].Players), err)
	}
}
