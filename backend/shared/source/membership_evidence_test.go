package source

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestLegacyStandingsRejectConflictingTables(t *testing.T) {
	raw, err := os.ReadFile("../../../src/server/data/__fixtures__/espn-standings.json")
	if err != nil {
		t.Fatal(err)
	}
	src := recoverySource(func(*http.Request) (*http.Response, error) { return recoveryResponse(200, string(raw)), nil })
	if _, err := src.Standings(context.Background(), config.Competition{ESPNSlug: "usa.1"}, config.Season{ID: "2026"}); err == nil {
		t.Fatal("World Cup standings accepted for MLS")
	}
}

func TestLegacyStandingsCertifyOnlyAttributedRows(t *testing.T) {
	raw, err := os.ReadFile("../../../src/server/data/__fixtures__/espn-standings.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                    string
		verified, expectFailure bool
	}{
		{"table links", true, false}, {"explicit league", true, false},
		{"missing group links", false, false}, {"missing year", false, false},
		{"null table year", false, true}, {"contradictory group link", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var doc map[string]any
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatal(err)
			}
			first := doc["children"].([]any)[0].(map[string]any)["standings"].(map[string]any)
			switch tc.name {
			case "explicit league":
				doc["league"] = map[string]string{"slug": "fifa.world"}
				delete(first, "links")
			case "missing group links":
				delete(first, "links")
			case "missing year":
				delete(doc["season"].(map[string]any), "year")
			case "null table year":
				first["season"] = nil
			case "contradictory group link":
				doc["league"] = map[string]string{"slug": "fifa.world"}
				first["links"] = []any{map[string]any{"rel": []string{"standings"}, "href": "https://www.espn.com/soccer/table/_/league/usa.1"}}
			}
			body, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			src := recoverySource(func(*http.Request) (*http.Response, error) { return recoveryResponse(200, string(body)), nil })
			res, err := src.Standings(context.Background(), config.Competition{ESPNSlug: "fifa.world"}, config.Season{ID: "2026"})
			if (err != nil) != tc.expectFailure || res.EditionVerified != tc.verified || (err == nil && len(res.Rows) != 48) {
				t.Fatalf("rows=%d verified=%v err=%v", len(res.Rows), res.EditionVerified, err)
			}
		})
	}
}

func TestLeaguesCupFullDiscoveryEvidence(t *testing.T) {
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	comp, _ := registry.Get("leagues-cup")
	season := comp.Seasons["2026"]
	event := windowEvent("123", "2026-08-10T19:30Z", 2026)
	explicit := strings.Replace(event, `"competitions":[{`, `"competitions":[{"id":"123",`, 1)
	explicit = strings.Replace(explicit, `"homeAway":"home"`, `"id":"96","homeAway":"home"`, 1)
	envelope := func(events string) string {
		return fmt.Sprintf(`{"leagues":[{"slug":%q,"season":{"year":2026}}],"events":[%s]}`, comp.ESPNSlug, events)
	}
	for _, tc := range []struct {
		name, august, other string
		ok                  bool
	}{
		{"verified", envelope(explicit), envelope(""), true},
		{"no year on intersecting empty month", envelope(explicit), monthEnvelope(comp.ESPNSlug), false},
		{"truncated", strings.Replace(envelope(explicit), `"events"`, `"hasMore":true,"events"`, 1), envelope(""), false},
		{"oversized partition", strings.Replace(envelope(explicit), `"events"`, `"padding":"`+strings.Repeat("x", 4<<20)+`","events"`, 1), envelope(""), false},
		{"different competition id", envelope(strings.Replace(explicit, `"competitions":[{"id":"123"`, `"competitions":[{"id":"999"`, 1)), envelope(""), false},
		{"two competition objects", envelope(strings.Replace(explicit, `]}]}`, `]},{}]}`, 1)), envelope(""), false},
		{"different competitor id", envelope(strings.Replace(explicit, `"id":"96","homeAway"`, `"id":"95","homeAway"`, 1)), envelope(""), false},
		{"identical sides", envelope(strings.Replace(explicit, `"id":"94"`, `"id":"96"`, 1)), envelope(""), false},
		{"unusable provider ID", envelope(strings.ReplaceAll(explicit, `"123"`, `"unknown"`)), envelope(""), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				body := tc.other
				if req.URL.Query().Get("dates") == "202608" {
					body = tc.august
				}
				return recoveryResponse(200, body), nil
			})
			_, err := src.Scoreboard(context.Background(), comp, season, true)
			if (err == nil) != tc.ok {
				t.Fatalf("accepted=%t, want %t: %v", err == nil, tc.ok, err)
			}
		})
	}
}

func TestFullMembershipMatchCountLimit(t *testing.T) {
	comp := config.Competition{ESPNSlug: "test.cup"}
	season := config.Season{ID: "2026", Resources: []string{"scores", "teams"}}
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		month := req.URL.Query().Get("dates")
		var events []string
		if month >= "202601" && month <= "202603" {
			for i := 1; i <= 667; i++ {
				id := fmt.Sprintf("%s%03d", month, i)
				events = append(events, windowEvent(id, "2026-"+month[4:]+"-10T19:30Z", 2026))
			}
		}
		return recoveryResponse(200, fmt.Sprintf(`{"leagues":[{"slug":"test.cup","season":{"year":2026}}],"events":[%s]}`, strings.Join(events, ","))), nil
	})
	if rows, err := src.Scoreboard(context.Background(), comp, season, true); err == nil || len(rows) != 0 || !strings.Contains(err.Error(), "2000") {
		t.Fatalf("expected full collection limit, rows=%d err=%v", len(rows), err)
	}
}

func TestRosterCompetitionEvidence(t *testing.T) {
	c := config.Competition{ID: "test", Name: "Short", ESPNRosterName: "Competition Name", ESPNSlug: "test.slug", ESPNScoreboardID: "19"}
	s := config.Season{ID: "2026"}
	for _, tc := range []struct {
		league, label string
		ok            bool
	}{
		{`"slug":"test.slug"`, "", true}, {`"id":19`, "", true}, {"", "", false},
		{"", `,"displayName":" 2026 COMPETITION NAME "`, true}, {"", `,"displayName":"2026-27 Competition Name"`, true},
		{`"id":"19"`, `,"displayName":"2026 Domestic League"`, false}, {`"slug":"other"`, `,"displayName":"2026 Competition Name"`, false},
		{`"id":"19"`, `,"displayName":null`, false}, {"", `,"displayName":"2026 Short"`, false},
	} {
		body := fmt.Sprintf(`{"league":{%s},"season":{"year":2026%s}}`, tc.league, tc.label)
		if err := validateEditionResource([]byte(body), c, s, 2026, "squad"); (err == nil) != tc.ok {
			t.Errorf("%s: %v", body, err)
		}
	}
}

func TestMembershipRosterScopeAndReadLimit(t *testing.T) {
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	comp, _ := registry.Get("leagues-cup")
	season := comp.Seasons["2026"]
	domestic, err := os.ReadFile("../../../src/server/data/__fixtures__/espn-team-roster.json")
	if err != nil {
		t.Fatal(err)
	}
	src := recoverySource(func(*http.Request) (*http.Response, error) { return recoveryResponse(200, string(domestic)), nil })
	if _, err := src.Roster(context.Background(), comp, season, "227"); err == nil {
		t.Fatal("accepted América's domestic roster for the cup")
	}

	var athletes []string
	for i := 1; i <= 101; i++ {
		row, _ := json.Marshal(map[string]string{"id": fmt.Sprint(i), "fullName": fmt.Sprintf("Player %d", i)})
		athletes = append(athletes, string(row))
	}
	body := func(n int) string {
		return fmt.Sprintf(`{"status":"success","team":{"id":"227"},"season":{"year":2026,"displayName":"2026 Leagues Cup"},"athletes":[%s]}`, strings.Join(athletes[:n], ","))
	}
	n := 101
	src = recoverySource(func(*http.Request) (*http.Response, error) { return recoveryResponse(200, body(n)), nil })
	if _, err := src.Roster(context.Background(), comp, season, "227"); err == nil {
		t.Fatal("accepted 101 players")
	}
	n = 100
	if got, err := src.Roster(context.Background(), comp, season, "227"); err != nil || len(got.Players) != 100 {
		t.Fatalf("normal retry: players=%d err=%v", len(got.Players), err)
	}
}

func TestKnockoutMembershipIDsStayVerifiedAfterDiscovery(t *testing.T) {
	comp := config.Competition{ID: "cup", ESPNSlug: "test.cup"}
	season := config.Season{ID: "2026", HasBracket: true, Resources: []string{"scores", "bracket", "teams"}}
	good := strings.Replace(windowEvent("123", "2026-08-10T19:30Z", 2026), `"regular-season"`, `"quarterfinals"`, 1)
	good = strings.Replace(good, `"competitions":[{`, `"competitions":[{"id":"123",`, 1)
	bad := strings.Replace(good, `"competitions":[{"id":"123"`, `"competitions":[{"id":"456"`, 1)
	for _, path := range []string{"rolling", "fallback", "bracket"} {
		t.Run(path, func(t *testing.T) {
			corrupt := false
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				selector := req.URL.Query().Get("dates")
				if corrupt && path == "fallback" && len(selector) == 6 {
					return recoveryResponse(400, "monthly unavailable"), nil
				}
				event := ""
				if strings.HasPrefix(selector, "202608") {
					event = good
					if corrupt {
						event = bad
					}
				}
				return recoveryResponse(200, fmt.Sprintf(`{"leagues":[{"slug":"test.cup","season":{"year":2026}}],"events":[%s]}`, event)), nil
			})
			src.now = func() time.Time { return time.Date(2026, 8, 10, 21, 0, 0, 0, time.UTC) }
			if matches, err := src.Scoreboard(context.Background(), comp, season, true); err != nil || len(matches) != 1 {
				t.Fatalf("full discovery: %v count=%d", err, len(matches))
			}
			corrupt = true
			if path == "bracket" {
				// This new bracket read cannot reuse the earlier poll's bytes.
				clear(src.recent)
				if rows, err := src.Bracket(context.Background(), comp, season, false); err == nil || len(rows) > 0 {
					t.Fatalf("bad bracket event accepted: %d err=%v", len(rows), err)
				}
			} else if rows, err := src.Scoreboard(context.Background(), comp, season, false); err == nil || IsPartialScoreboard(err) || len(rows) > 0 {
				t.Fatalf("conflicting event survived: %d err=%v", len(rows), err)
			}
		})
	}
}

func TestAdulteratedRosterRejectsThenRetries(t *testing.T) {
	raw, err := os.ReadFile("../../../src/server/data/__fixtures__/espn-team-roster.json")
	if err != nil {
		t.Fatal(err)
	}
	rc, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	c, _ := rc.Get("liga-mx")
	s := c.Seasons[c.CurrentSeasonId]
	for _, tc := range []string{"nonnumeric", "duplicate", "blank name", "overlong", "zero"} {
		t.Run(tc, func(t *testing.T) {
			var doc map[string]any
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatal(err)
			}
			athletes := doc["athletes"].([]any)
			a := athletes[0].(map[string]any)
			switch tc {
			case "nonnumeric":
				a["id"] = "unknown"
			case "duplicate":
				a["id"] = athletes[1].(map[string]any)["id"]
			case "blank name":
				a["fullName"], a["displayName"] = "  ", "  "
			case "overlong":
				a["id"] = strings.Repeat("9", 33)
			case "zero":
				a["id"] = 0
			}
			body, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			src := recoverySource(func(*http.Request) (*http.Response, error) { return recoveryResponse(200, string(body)), nil })
			if _, err := src.Roster(context.Background(), c, s, "227"); err == nil {
				t.Fatal("invalid roster accepted")
			}
			body = raw
			if roster, err := src.Roster(context.Background(), c, s, "227"); err != nil || len(roster.Players) != 35 {
				t.Fatalf("good retry: %d err=%v", len(roster.Players), err)
			}
		})
	}
}
