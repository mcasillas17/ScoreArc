package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// T16.1: the cross-language half of src/server/data/contracts/reader-contract.json.
// Go reads the same recorded ESPN bytes as the TypeScript suite, maps them with
// the ingester's mappers, serializes reader DTOs and validates OpenAPI. Gaps are
// characterized exactly so fixing one fails here until the contract is updated.

const (
	readerContractPath = "../../src/server/data/contracts/reader-contract.json"
	contractFixtures   = "../../src/server/data/__fixtures__/"
)

type contractSides map[string]struct {
	ProviderID  string `json:"providerId"`
	CanonicalID string `json:"canonicalId"`
}

// syntheticTable picks recorded Group A entries into one provider table; ID is
// the provider table id (absent for an unidentified table).
type syntheticTable struct {
	ID      *string `json:"id"`
	Name    string  `json:"name"`
	Entries []int   `json:"entries"`
}

// queryVector is one matches-route query string. Without Reader, the reader
// must answer with the frontend's status and ids.
type queryVector struct {
	Query    string `json:"query"`
	Frontend struct {
		Status int      `json:"status"`
		Method string   `json:"method"`
		Args   []any    `json:"args"`
		IDs    []string `json:"ids"`
	} `json:"frontend"`
	Reader *struct {
		Status int      `json:"status"`
		IDs    []string `json:"ids"`
		Why    string   `json:"why"`
	} `json:"reader"`
}

// expected returns the reader's required status and ids for the vector.
func (v queryVector) expected() (int, []string) {
	if v.Reader != nil {
		return v.Reader.Status, v.Reader.IDs
	}
	return v.Frontend.Status, v.Frontend.IDs
}

type readerContractVectors struct {
	Gaps map[string]struct {
		Task   string   `json:"task"`
		Suites []string `json:"suites"`
	} `json:"gaps"`
	Methods map[string]struct {
		Reader *string  `json:"reader"`
		Gaps   []string `json:"gaps"`
	} `json:"methods"`
	ReaderOnly map[string]string `json:"readerOnly"`
	Summary    struct {
		Fixture       string        `json:"fixture"`
		EventID       string        `json:"eventId"`
		ReaderMatchID string        `json:"readerMatchId"`
		Competition   string        `json:"competition"`
		Season        string        `json:"season"`
		Kickoff       string        `json:"kickoff"`
		Sides         contractSides `json:"sides"`
	} `json:"summary"`
	OwnGoal struct {
		Fixture string        `json:"fixture"`
		Sides   contractSides `json:"sides"`
	} `json:"ownGoal"`
	Standings struct {
		Groups []struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Teams int    `json:"teams"`
		} `json:"groups"`
		// Indices into the recorded children[0].standings.entries.
		Synthetic struct {
			DuplicateRank struct {
				Name          string               `json:"name"`
				Entries       []int                `json:"entries"`
				RankOverrides map[int]float64      `json:"rankOverrides"`
				Expected      struct{ Reader any } `json:"expected"`
			} `json:"duplicateRank"`
			SharedTeam struct {
				Groups   []syntheticTable `json:"groups"`
				Expected any              `json:"expected"`
			} `json:"sharedTeam"`
			Conflicts struct {
				Cases []struct {
					Name     string           `json:"name"`
					Groups   []syntheticTable `json:"groups"`
					Expected string           `json:"expected"`
				} `json:"cases"`
			} `json:"conflicts"`
			MissingStat struct {
				Name      string         `json:"name"`
				Entries   []int          `json:"entries"`
				DropStats map[int]string `json:"dropStats"`
			} `json:"missingStat"`
			EmptyTable struct {
				Name string `json:"name"`
			} `json:"emptyTable"`
			EmptyTeamID struct {
				Name        string `json:"name"`
				Entries     []int  `json:"entries"`
				BlankTeamID int    `json:"blankTeamId"`
			} `json:"emptyTeamId"`
			Envelopes struct {
				Cases []struct {
					Name     string `json:"name"`
					Payload  any    `json:"payload"`
					Expected any    `json:"expected"`
				} `json:"cases"`
			} `json:"envelopes"`
		} `json:"synthetic"`
	} `json:"standings"`
	Queries struct {
		Competition string    `json:"competition"`
		Season      string    `json:"season"`
		Now         time.Time `json:"now"`
		Events      []struct {
			ID      string `json:"id"`
			Kickoff string `json:"kickoff"`
			Status  string `json:"status"`
		} `json:"events"`
		Params      []queryVector `json:"params"`
		OutOfSeason []struct {
			Competition string   `json:"competition"`
			Season      string   `json:"season"`
			Args        []string `json:"args"`
			IDs         []string `json:"ids"`
		} `json:"outOfSeason"`
	} `json:"queries"`
	Freshness struct {
		Competition string `json:"competition"`
		Season      string `json:"season"`
		Cases       []struct {
			Name     string    `json:"name"`
			Now      time.Time `json:"now"`
			Snapshot struct {
				PollSucceededAt *time.Time `json:"pollSucceededAt"`
				PollStatus      string     `json:"pollStatus"`
				HasUnfinalized  bool       `json:"hasUnfinalized"`
				Matches         []struct {
					Kickoff     time.Time  `json:"kickoff"`
					State       string     `json:"state"`
					Status      string     `json:"status"`
					ObservedAt  *time.Time `json:"observedAt"`
					FinalizedAt *time.Time `json:"finalizedAt"`
				} `json:"matches"`
			} `json:"snapshot"`
			Headers map[string]string `json:"headers"`
		} `json:"cases"`
	} `json:"freshness"`
	Transport struct {
		SuccessCache struct {
			Reader []struct {
				Path         string `json:"path"`
				OpenAPIPath  string `json:"openapiPath"`
				CacheControl string `json:"cacheControl"`
				Live         bool   `json:"live"`
			} `json:"reader"`
		} `json:"successCache"`
		Reader []struct {
			Path   string `json:"path"`
			Status int    `json:"status"`
			Error  string `json:"error"`
		} `json:"reader"`
	} `json:"transport"`
}

func loadReaderContract(t *testing.T) (readerContractVectors, map[string]any) {
	t.Helper()
	data, err := os.ReadFile(readerContractPath)
	if err != nil {
		t.Fatal(err)
	}
	var vectors readerContractVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	return vectors, raw
}

// setLive turns a decoded ESPN status live in the first half, with the given
// display clock or none when clock is nil.
func setLive(status map[string]any, clock any) {
	kind := status["type"].(map[string]any)
	kind["state"], kind["completed"], kind["name"] = "in", false, "STATUS_FIRST_HALF"
	if clock == nil {
		delete(status, "displayClock")
	} else {
		status["displayClock"] = clock
	}
}

// okGet returns the committed GET operation for path.
func okGet(t *testing.T, document *openapi3.T, path string) *openapi3.Operation {
	t.Helper()
	item := document.Paths.Value(path)
	if item == nil || item.Get == nil {
		t.Fatalf("OpenAPI no longer documents GET %s", path)
	}
	return item.Get
}

// okHeader returns the committed 200-response header for GET path, or nil
// when OpenAPI does not document it.
func okHeader(t *testing.T, document *openapi3.T, path, name string) *openapi3.HeaderRef {
	t.Helper()
	response := okGet(t, document, path).Responses.Status(http.StatusOK)
	if response == nil || response.Value == nil {
		t.Fatalf("OpenAPI no longer documents a 200 for %s", path)
	}
	return response.Value.Headers[name]
}

func contractFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(contractFixtures + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// standingsTable copies the picked recorded Group A entries into one provider
// table, overriding a rank stat or dropping one named stat per entry index, as
// the TS suite's table() does. A nil id leaves the table unidentified.
func standingsTable(t *testing.T, raw map[string]any, id *string, name string, picks []int, ranks map[int]float64, drops map[int]string) map[string]any {
	t.Helper()
	var recorded struct {
		Children []struct {
			Standings struct {
				Entries []map[string]any `json:"entries"`
			} `json:"standings"`
		} `json:"children"`
	}
	if err := json.Unmarshal(contractFixture(t, fixtureName(t, raw, "standings")), &recorded); err != nil {
		t.Fatal(err)
	}
	entries := []any{}
	for _, pick := range picks {
		entry := wire(t, recorded.Children[0].Standings.Entries[pick]).(map[string]any)
		var stats []any
		for _, stat := range entry["stats"].([]any) {
			named := stat.(map[string]any)
			if rank, ok := ranks[pick]; ok && named["name"] == "rank" {
				named["value"] = rank
			}
			if drop, ok := drops[pick]; !ok || named["name"] != drop {
				stats = append(stats, named)
			}
		}
		entry["stats"] = stats
		entries = append(entries, entry)
	}
	table := map[string]any{"name": name, "standings": map[string]any{"entries": entries}}
	if id != nil {
		table["id"] = *id
	}
	return table
}

// syntheticTables builds a standings payload from vector tables.
func syntheticTables(t *testing.T, raw map[string]any, tables []syntheticTable) []byte {
	t.Helper()
	children := []any{}
	for _, table := range tables {
		children = append(children, standingsTable(t, raw, table.ID, table.Name, table.Entries, nil, nil))
	}
	return syntheticPayload(t, children...)
}

// syntheticPayload wraps tables in a standings envelope.
func syntheticPayload(t *testing.T, children ...any) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]any{"children": children})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// vector walks the raw JSON by object keys.
func vector(t *testing.T, raw map[string]any, path ...string) any {
	t.Helper()
	var value any = raw
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("vector %v: %q is not inside an object", path, key)
		}
		if value, ok = object[key]; !ok {
			t.Fatalf("vector %v: missing %q", path, key)
		}
	}
	return value
}

// wire is a value's exact JSON form, so comparisons see dropped, renamed,
// retyped and null-versus-empty fields.
func wire(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func assertWire(t *testing.T, label string, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		got, _ := json.Marshal(actual)
		want, _ := json.Marshal(expected)
		t.Fatalf("%s drifted:\n got %s\nwant %s", label, got, want)
	}
}

func schemaOf(t *testing.T, document *openapi3.T, name string) *openapi3.Schema {
	t.Helper()
	reference := document.Components.Schemas[name]
	if reference == nil || reference.Value == nil {
		t.Fatalf("OpenAPI schema %s missing", name)
	}
	return reference.Value
}

func validateSchema(t *testing.T, document *openapi3.T, name string, value any) {
	t.Helper()
	if err := schemaOf(t, document, name).VisitJSON(value); err != nil {
		t.Fatalf("%s violates OpenAPI: %v", name, err)
	}
}

// Characterized gaps: absent fields stay absent in the reader object AND the
// committed schema. Implementing one fails here until the contract changes.
func assertAbsent(t *testing.T, document *openapi3.T, schema string, object map[string]any, fields ...string) {
	t.Helper()
	for _, field := range fields {
		if _, ok := object[field]; ok {
			t.Fatalf("gap changed: reader %s now emits %s; update reader-contract.json", schema, field)
		}
		if _, ok := schemaOf(t, document, schema).Properties[field]; ok {
			t.Fatalf("gap changed: OpenAPI %s now defines %s; update reader-contract.json", schema, field)
		}
	}
}

func espnToCanonical(t *testing.T) map[string]string {
	t.Helper()
	teams, err := config.LoadTeams()
	if err != nil {
		t.Fatal(err)
	}
	crosswalk := make(map[string]string, len(teams))
	for _, team := range teams {
		if ref := team.Refs["espn"]; ref != "" {
			crosswalk[ref] = team.ID
		}
	}
	return crosswalk
}

func TestReaderContract(t *testing.T) {
	vectors, raw := loadReaderContract(t)
	document := loadOpenAPI(t)
	crosswalk := espnToCanonical(t)
	exercised := map[string]bool{}
	exercise := func(methods ...string) {
		for _, method := range methods {
			exercised[method] = true
		}
	}
	characterized := map[string]bool{}
	// An undefined id is caught by the closing ledger, never by a subtest
	// failing its parent.
	gap := func(id string) { characterized[id] = true }

	t.Run("inventory matches OpenAPI and the router", func(t *testing.T) {
		if len(vectors.Methods) != 12 {
			t.Fatalf("DataStore inventory has %d methods, want 12", len(vectors.Methods))
		}
		routes := map[string]bool{"/healthz": true}
		for method, contract := range vectors.Methods {
			for _, id := range contract.Gaps {
				if _, ok := vectors.Gaps[id]; !ok {
					t.Fatalf("%s references undefined gap %s", method, id)
				}
			}
			if contract.Reader != nil {
				routes[*contract.Reader] = true
			}
		}
		for route := range vectors.ReaderOnly {
			routes[route] = true
		}
		if vectors.Methods["getPlayer"].Reader != nil {
			t.Fatal("getPlayer gained a reader route; update reader-contract.json")
		}
		gap("T10.4-player")
		exercise("getPlayer") // No route: absence from OpenAPI and the router is the contract.
		documented := map[string]bool{}
		for path, item := range document.Paths.Map() {
			if item.Get == nil {
				t.Fatalf("%s lacks GET", path)
			}
			documented[path] = true
			if strings.Contains(path, "player") || strings.Contains(path, "squad") || strings.Contains(path, "assist") {
				t.Fatalf("gap changed: OpenAPI now documents %s", path)
			}
		}
		if !reflect.DeepEqual(routes, documented) {
			t.Fatalf("OpenAPI paths %v do not match the contract inventory %v", documented, routes)
		}
		served := map[string]bool{}
		app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
		if err := chi.Walk(app.router().(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if method == http.MethodGet {
				served[route] = true
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(served, documented) {
			t.Fatalf("router serves %v, OpenAPI documents %v", served, documented)
		}
		// No standalone squad route: the roster exists only inside TeamProfile.
		if _, ok := schemaOf(t, document, "TeamProfile").Properties["squad"]; !ok {
			t.Fatal("TeamProfile lost its embedded squad")
		}
		gap("T10.3-squad")
		for id, g := range vectors.Gaps {
			if !strings.HasPrefix(id, g.Task+"-") {
				t.Fatalf("gap %s is not keyed by its task %s", id, g.Task)
			}
			for _, suite := range g.Suites {
				if suite != "ts" && suite != "go" && suite != "go-db" {
					t.Fatalf("gap %s names unknown suite %q", id, suite)
				}
			}
		}
	})

	t.Run("crosswalk ids used by the vectors come from the production seed", func(t *testing.T) {
		for _, sides := range []contractSides{vectors.Summary.Sides, vectors.OwnGoal.Sides} {
			for side, ids := range sides {
				if crosswalk[ids.ProviderID] != ids.CanonicalID {
					t.Fatalf("%s: seed maps %s to %q, want %q", side, ids.ProviderID, crosswalk[ids.ProviderID], ids.CanonicalID)
				}
			}
		}
		// Team identity is a tested translation, not an equality: the frontend
		// helper (teamIdentity.ts) and the ingester resolve provider ids through
		// the same curated map, entry for entry.
		data, err := os.ReadFile("../../src/server/data/teamCrosswalk.json")
		if err != nil {
			t.Fatal(err)
		}
		var frontend map[string]string
		if err := json.Unmarshal(data, &frontend); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(frontend, crosswalk) {
			t.Fatalf("frontend crosswalk (%d entries) differs from the backend seed (%d)", len(frontend), len(crosswalk))
		}
	})

	t.Run("recorded summary through the Go mapper and reader DTO", func(t *testing.T) {
		exercise("getMatchSummary")
		detail, err := espn.MapSummary(contractFixture(t, vectors.Summary.Fixture))
		if err != nil {
			t.Fatal(err)
		}
		actual := wire(t, readerSummary(detail, vectors.Summary.Sides)).(map[string]any)
		validateSchema(t, document, "MatchSummary", actual)
		assertWire(t, "MatchSummary keys", sortedKeys(actual), vector(t, raw, "summary", "readerKeys"))
		assertSharedSummary(t, "", raw, actual)
		for _, key := range []string{"scorers", "cards", "stats", "lineups"} {
			assertWire(t, "reader "+key, actual[key], vector(t, raw, "summary", "reader", key))
		}
		// playerSlug stays route-layer enrichment (withSummaryPlayerSlugs), as in the frontend store.
		for _, scorer := range actual["scorers"].([]any) {
			assertAbsent(t, document, "Scorer", scorer.(map[string]any), "playerSlug")
		}
		// The served nested ids are the production seed's translation of the
		// frontend's provider ids, row for row.
		for _, kind := range []string{"scorers", "cards"} {
			frontend := vector(t, raw, "summary", "frontend", kind).([]any)
			for i, row := range actual[kind].([]any) {
				if want := crosswalk[frontend[i].(map[string]any)["teamId"].(string)]; row.(map[string]any)["teamId"] != want {
					t.Fatalf("%s[%d] team %v, seed says %q", kind, i, row.(map[string]any)["teamId"], want)
				}
			}
		}
		stats := actual["stats"].(map[string]any)
		for _, side := range []string{"home", "away"} {
			assertAbsent(t, document, "TeamStats", stats[side].(map[string]any), "passesAccurate", "crossesAccurate", "tacklesEffective")
			frontend := vector(t, raw, "summary", "frontend", "stats", side).(map[string]any)
			if reflect.DeepEqual(stats[side].(map[string]any)["shotAccuracy"], frontend["shotAccuracy"]) {
				t.Fatal("gap changed: reader shot accuracy now matches the operand-derived frontend value")
			}
		}
		gap("T10.2-team-stats")
		lineups := actual["lineups"].(map[string]any)
		for _, side := range []string{"home", "away"} {
			players := lineups[side].(map[string]any)["players"].([]any)
			roster := vector(t, raw, "summary", "frontend", "lineups", side, "roster").([]any)
			if len(players) != 11 || len(roster) <= len(players) {
				t.Fatalf("gap changed: %s reader lineup has %d of %d players", side, len(players), len(roster))
			}
			assertAbsent(t, document, "LineupPlayer", players[0].(map[string]any), "starter", "stats", "athleteId", "playerSlug")
		}
		gap("T10.2-lineups")
	})

	t.Run("synthetic shootout and head-to-head through the Go mapper", func(t *testing.T) {
		detail, err := espn.MapSummary(withSummaryOverlay(t, raw, vectors.Summary.Fixture))
		if err != nil {
			t.Fatal(err)
		}
		actual := wire(t, readerSummary(detail, vectors.Summary.Sides)).(map[string]any)
		validateSchema(t, document, "MatchSummary", actual)
		assertOverlaySummary(t, "", raw, actual)
		expected := vector(t, raw, "summary", "syntheticOverlay", "expected").(map[string]any)
		// The header tier of the shared shootout precedence; neither summary DTO
		// carries it (readerKeys), the reader serves it on Match.
		assertWire(t, "summary shootout aggregate", wire(t, detail.Shootout), expected["readerShootout"])
	})

	t.Run("a summary header supplies the aggregate and winner only for its own match", func(t *testing.T) {
		identity := vector(t, raw, "summary", "syntheticOverlay", "headerIdentity").(map[string]any)
		eventID := identity["scoreboardEventId"].(string)
		var scoreboardMatch espn.Match
		matches, err := espn.MapScoreboard(contractFixture(t, fixtureName(t, raw, "scoreboard")))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range matches {
			if m.ID == eventID {
				scoreboardMatch = m
			}
		}
		for _, entry := range identity["cases"].([]any) {
			c := entry.(map[string]any)
			header := c["header"].(map[string]any)
			var summary map[string]any
			if err := json.Unmarshal(withSummaryOverlay(t, raw, vectors.Summary.Fixture), &summary); err != nil {
				t.Fatal(err)
			}
			summary["header"].(map[string]any)["id"] = header["eventId"]
			competition := summary["header"].(map[string]any)["competitions"].([]any)[0].(map[string]any)
			competition["id"] = header["eventId"]
			for _, competitor := range competition["competitors"].([]any) {
				side := competitor.(map[string]any)
				id := header[side["homeAway"].(string)]
				side["id"] = id
				side["team"].(map[string]any)["id"] = id
				if scores, ok := header["scores"].(map[string]any); ok {
					if score, ok := scores[side["homeAway"].(string)]; ok {
						side["score"] = score
					}
				}
			}
			if status, ok := header["status"].(map[string]any); ok {
				maps.Copy(competition["status"].(map[string]any)["type"].(map[string]any), status)
			}
			data, err := json.Marshal(summary)
			if err != nil {
				t.Fatal(err)
			}
			// The ingester's gate (shared/source mapSummary): a summary for any
			// other event or side order is rejected, so the scoreboard's evidence
			// stands; an accepted header outranks it, and its finalization
			// resolves the winner from the aggregate it serves.
			shootout, winner := scoreboardMatch.Shootout, scoreboardMatch.WinnerID
			if espn.ValidateSummary(data, eventID, scoreboardMatch.Home.ID, scoreboardMatch.Away.ID, true) == nil {
				detail, err := espn.MapSummary(data)
				if err != nil {
					t.Fatal(err)
				}
				shootout = detail.Shootout
				winner = espn.ResolveWinner(shootout, scoreboardMatch.Home.ID, scoreboardMatch.Away.ID, scoreboardMatch.WinnerFlagID)
			}
			expected := c["expected"].(map[string]any)
			assertWire(t, c["name"].(string), wire(t, shootout), expected["shootout"])
			sides := map[string]string{"home": scoreboardMatch.Home.ID, "away": scoreboardMatch.Away.ID}
			if winner == nil || *winner != sides[expected["winner"].(string)] {
				t.Fatalf("%s: winner %v", c["name"], winner)
			}
		}
	})

	t.Run("a level summary header falls back to the winner flags, not a superseded aggregate", func(t *testing.T) {
		level := vector(t, raw, "summary", "syntheticOverlay", "levelHeader").(map[string]any)
		eventID := level["scoreboardEventId"].(string)
		totals := level["shootoutScores"].(map[string]any)
		for _, entry := range level["cases"].([]any) {
			c := entry.(map[string]any)
			var recorded map[string]any
			if err := json.Unmarshal(contractFixture(t, fixtureName(t, raw, "scoreboard")), &recorded); err != nil {
				t.Fatal(err)
			}
			var event map[string]any
			for _, candidate := range recorded["events"].([]any) {
				if candidate.(map[string]any)["id"] == eventID {
					event = candidate.(map[string]any)
				}
			}
			sides := map[string]string{}
			for _, competitor := range event["competitions"].([]any)[0].(map[string]any)["competitors"].([]any) {
				side := competitor.(map[string]any)
				homeAway := side["homeAway"].(string)
				sides[homeAway] = side["team"].(map[string]any)["id"].(string)
				side["winner"] = c["winnerFlags"].(map[string]any)[homeAway]
			}
			board, err := json.Marshal(map[string]any{"leagues": recorded["leagues"], "events": []any{event}})
			if err != nil {
				t.Fatal(err)
			}
			mapped, err := espn.MapScoreboard(board)
			if err != nil || len(mapped) != 1 {
				t.Fatalf("%s: %v", c["name"], err)
			}
			match := mapped[0]
			var summary map[string]any
			if err := json.Unmarshal(withSummaryOverlay(t, raw, vectors.Summary.Fixture), &summary); err != nil {
				t.Fatal(err)
			}
			header := summary["header"].(map[string]any)
			header["id"] = eventID
			competition := header["competitions"].([]any)[0].(map[string]any)
			competition["id"] = eventID
			for _, competitor := range competition["competitors"].([]any) {
				side := competitor.(map[string]any)
				homeAway := side["homeAway"].(string)
				side["id"] = sides[homeAway]
				side["team"].(map[string]any)["id"] = sides[homeAway]
				side["shootoutScore"] = totals[homeAway]
			}
			data, err := json.Marshal(summary)
			if err != nil {
				t.Fatal(err)
			}
			if err := espn.ValidateSummary(data, eventID, match.Home.ID, match.Away.ID, true); err != nil {
				t.Fatal(err)
			}
			detail, err := espn.MapSummary(data)
			if err != nil {
				t.Fatal(err)
			}
			expected := c["expected"].(map[string]any)
			assertWire(t, c["name"].(string), wire(t, detail.Shootout), expected["shootout"])
			var want any
			if side, ok := expected["winner"].(string); ok {
				want = sides[side]
			}
			winner := espn.ResolveWinner(detail.Shootout, match.Home.ID, match.Away.ID, match.WinnerFlagID)
			assertWire(t, c["name"].(string)+" winner", wire(t, winner), want)
		}
	})

	t.Run("recorded scoreboard penalty aggregates agree", func(t *testing.T) {
		matches, err := espn.MapScoreboard(contractFixture(t, fixtureName(t, raw, "scoreboard")))
		if err != nil {
			t.Fatal(err)
		}
		var actual []any
		for _, match := range matches {
			// The scoreboard tiers of the shared precedence, resolved by the mapper;
			// shared/source lets a held summary header outrank them.
			actual = append(actual, map[string]any{"id": match.ID, "shootout": wire(t, match.Shootout)})
		}
		assertWire(t, "scoreboard shootouts", actual, vector(t, raw, "scoreboard", "shootouts"))

		// The shared precedence vectors, on the same recorded event as the TS
		// suite, through the scoreboard and the bracket mappers alike.
		precedence := vector(t, raw, "scoreboard", "shootoutPrecedence").(map[string]any)
		withCase := func(fixture string, c map[string]any) ([]byte, map[string]string) {
			var recorded map[string]any
			if err := json.Unmarshal(contractFixture(t, fixtureName(t, raw, fixture)), &recorded); err != nil {
				t.Fatal(err)
			}
			var event map[string]any
			for _, candidate := range recorded["events"].([]any) {
				if candidate.(map[string]any)["id"] == precedence["eventId"] {
					event = wire(t, candidate).(map[string]any)
				}
			}
			competition := event["competitions"].([]any)[0].(map[string]any)
			sideIDs := map[string]string{}
			for _, competitor := range competition["competitors"].([]any) {
				side := competitor.(map[string]any)
				homeAway := side["homeAway"].(string)
				sideIDs[homeAway] = side["team"].(map[string]any)["id"].(string)
				if value := c["shootoutScore"].(map[string]any)[homeAway]; value == "absent" {
					delete(side, "shootoutScore")
				} else {
					side["shootoutScore"] = value
				}
				if flags, ok := c["winnerFlags"].(map[string]any); ok {
					side["winner"] = flags[homeAway]
				}
			}
			competition["notes"] = []any{}
			if c["note"] != nil {
				competition["notes"] = []any{map[string]any{"text": c["note"]}}
			}
			if status, ok := c["status"].(map[string]any); ok {
				maps.Copy(event["status"].(map[string]any)["type"].(map[string]any), status)
			}
			data, err := json.Marshal(map[string]any{"leagues": recorded["leagues"], "events": []any{event}})
			if err != nil {
				t.Fatal(err)
			}
			return data, sideIDs
		}
		for _, entry := range precedence["cases"].([]any) {
			c := entry.(map[string]any)
			data, sideIDs := withCase("scoreboard", c)
			mapped, err := espn.MapScoreboard(data)
			var winner any
			if side, ok := c["winner"].(string); ok {
				winner = sideIDs[side]
			}
			if c["expected"] == "error" {
				if err == nil {
					t.Fatalf("%s: malformed totals accepted", c["name"])
				}
			} else {
				if err != nil || len(mapped) != 1 {
					t.Fatalf("%s: %v", c["name"], err)
				}
				assertWire(t, c["name"].(string), wire(t, mapped[0].Shootout), c["expected"])
				assertWire(t, c["name"].(string)+" winner", wire(t, mapped[0].WinnerID), winner)
				if *mapped[0].HomeScore != 1 || *mapped[0].AwayScore != 1 {
					t.Fatalf("%s: shootout replaced regulation scores", c["name"])
				}
			}

			// The bracket mapper takes every case too: the scoreboard's rule
			// rejects a malformed total, and otherwise it yields the same
			// aggregate for the ingester's candidate and the same finished winner.
			data, sideIDs = withCase("bracket", c)
			bracket, err := espn.MapBracket(data)
			if c["expected"] == "error" {
				if err == nil {
					t.Fatalf("%s: bracket accepted malformed totals", c["name"])
				}
				continue
			}
			if err != nil || len(bracket) != 1 {
				t.Fatalf("%s bracket: %v", c["name"], err)
			}
			assertWire(t, c["name"].(string)+" bracket aggregate", wire(t, bracket[0].Shootout), c["expected"])
			assertWire(t, c["name"].(string)+" bracket winner", wire(t, bracket[0].WinnerID), winner)
		}
	})

	t.Run("recorded scoreboard core fields agree with the frontend table", func(t *testing.T) {
		matches, err := espn.MapScoreboard(contractFixture(t, fixtureName(t, raw, "scoreboard")))
		if err != nil {
			t.Fatal(err)
		}
		table := vector(t, raw, "scoreboard", "matches").([]any)
		if len(table) != len(matches) {
			t.Fatalf("scoreboard table has %d rows, Go mapped %d", len(table), len(matches))
		}
		for i, m := range matches {
			row := table[i].([]any)
			// Named normalizer: the kickoff column is compared as an instant.
			goKickoff, err := time.Parse(time.RFC3339, m.Kickoff)
			if err != nil || !goKickoff.Equal(espnInstant(t, row[1].(string))) {
				t.Fatalf("%s kickoff %q != %q", m.ID, m.Kickoff, row[1])
			}
			actual := wire(t, []any{m.ID, row[1], m.State, m.StatusDetail, m.StatusName, m.Home.ID, m.Away.ID,
				m.Home.Abbr, m.Away.Abbr, m.HomeScore, m.AwayScore, m.WinnerID, m.Note})
			assertWire(t, "scoreboard row "+m.ID, actual, row)
		}
	})

	t.Run("live minute with and without ESPN's display clock", func(t *testing.T) {
		var scoreboard map[string]any
		if err := json.Unmarshal(contractFixture(t, fixtureName(t, raw, "scoreboard")), &scoreboard); err != nil {
			t.Fatal(err)
		}
		live := vector(t, raw, "queries", "liveMinute").(map[string]any)
		minuteOf := func(clock any) any {
			event := wire(t, scoreboard["events"].([]any)[0]).(map[string]any)
			status := event["status"].(map[string]any)
			setLive(status, clock)
			data, err := json.Marshal(map[string]any{"leagues": scoreboard["leagues"], "events": []any{event}})
			if err != nil {
				t.Fatal(err)
			}
			matches, err := espn.MapScoreboard(data)
			if err != nil || len(matches) != 1 {
				t.Fatalf("map live event: %v", err)
			}
			return wire(t, matches[0]).(map[string]any)["minute"]
		}
		withClock := live["withClock"].(map[string]any)
		assertWire(t, "live minute", minuteOf(withClock["displayClock"]), withClock["expected"].(map[string]any)["reader"])
		// Unknown is an explicit JSON null in both contracts, never "" or omitted.
		expected := live["withoutClock"].(map[string]any)["expected"].(map[string]any)
		if expected["reader"] != nil || expected["frontend"] != nil {
			t.Fatalf("clockless live minute vector %v, want null for both", expected)
		}
		if got := minuteOf(nil); got != nil {
			t.Fatalf("a clockless live minute is %#v, want null", got)
		}
	})

	t.Run("recorded own goal keeps its flag and benefiting side in the reader", func(t *testing.T) {
		detail, err := espn.MapSummary(contractFixture(t, vectors.OwnGoal.Fixture))
		if err != nil {
			t.Fatal(err)
		}
		// Stored as the provider credits it: the benefiting side's provider id.
		if *detail.Scorers[0].TeamID != vectors.OwnGoal.Sides["away"].ProviderID || !*detail.Scorers[0].OwnGoal {
			t.Fatal("own-goal vector no longer pins the benefiting-side credit")
		}
		actual := wire(t, readerSummary(detail, vectors.OwnGoal.Sides)).(map[string]any)
		validateSchema(t, document, "MatchSummary", actual)
		assertWire(t, "own-goal scorers", actual["scorers"], vector(t, raw, "ownGoal", "reader", "scorers"))
	})

	t.Run("recorded standings: same values and rank order", func(t *testing.T) {
		exercise("getStandings")
		rows, err := espn.MapStandings(contractFixture(t, fixtureName(t, raw, "standings")))
		if err != nil {
			t.Fatal(err)
		}
		var groupA []map[string]any
		counts := map[string]int{}
		for _, row := range rows {
			counts[*row.GroupID]++
			if *row.GroupID == "A" {
				object := wire(t, row).(map[string]any)
				delete(object, "groupId") // Projected into Group by reader SQL, not a row field.
				delete(object, "groupName")
				team := object["team"].(map[string]any)
				team["id"] = crosswalk[row.Team.ID] // Named normalizer: production seed crosswalk.
				groupA = append(groupA, object)
			}
		}
		for _, group := range vectors.Standings.Groups {
			if counts[group.ID] != group.Teams {
				t.Fatalf("group %s has %d rows, want %d", group.ID, counts[group.ID], group.Teams)
			}
		}
		// Every recorded row's values agree with the frontend table.
		goRows := map[string]any{}
		for _, row := range rows {
			goRows[*row.GroupID+"/"+row.Team.Abbr] = wire(t, []any{*row.GroupID, row.Team.Abbr, row.Played, row.Wins, row.Draws,
				row.Losses, row.GoalsFor, row.GoalsAgainst, row.GoalDifference, row.Points, row.Advanced})
		}
		table := vector(t, raw, "standings", "table").([]any)
		if len(table) != len(rows) {
			t.Fatalf("standings table has %d rows, Go mapped %d", len(table), len(rows))
		}
		for _, entry := range table {
			row := entry.([]any)
			assertWire(t, "standings row", goRows[row[0].(string)+"/"+row[1].(string)], row)
		}
		reader := vector(t, raw, "standings", "readerGroupA").(map[string]any)
		assertWire(t, "group A rows", wire(t, groupA), reader["standings"])
		frontend := vector(t, raw, "standings", "frontendGroupA", "standings").([]any)
		var readerOrder, frontendOrder []string
		for i := range frontend {
			readerOrder = append(readerOrder, groupA[i]["team"].(map[string]any)["abbr"].(string))
			frontendOrder = append(frontendOrder, frontend[i].(map[string]any)["team"].(map[string]any)["abbr"].(string))
		}
		// ESPN's complete rank stat orders the table in both mappers.
		if !reflect.DeepEqual(readerOrder, frontendOrder) {
			t.Fatalf("reader group A order %v, frontend %v", readerOrder, frontendOrder)
		}
		// The reader DTO the SQL grouping builds from these rows, not the vector itself.
		var standings []Standing
		rowsJSON, err := json.Marshal(groupA)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(rowsJSON, &standings); err != nil {
			t.Fatal(err)
		}
		group := wire(t, Group{ID: "A", Name: "Group A", Standings: standings}).(map[string]any)
		assertWire(t, "group A", group, reader)
		validateSchema(t, document, "Group", group)
		assertAbsent(t, document, "Group", group, "labelKey", "zones")
		gap("T10.10-derived-standings")

		// Synthetic tables from the recorded Group A entries: a duplicated rank
		// stat (no rank gap) and a team listed in two tables (T16.2 decision A).
		synthetic := vectors.Standings.Synthetic
		buildTable := func(name string, picks []int, ranks map[int]float64, drops map[int]string) map[string]any {
			return standingsTable(t, raw, nil, name, picks, ranks, drops)
		}
		// mapped groups Go rows as [abbr, rank] per table id, with each table's key.
		mapped := func(data []byte) (map[string][]any, map[string]string) {
			rows, err := espn.MapStandings(data)
			if err != nil {
				t.Fatal(err)
			}
			byGroup, tableKeys := map[string][]any{}, map[string]string{}
			for _, row := range rows {
				byGroup[*row.GroupID] = append(byGroup[*row.GroupID], []any{row.Team.Abbr, float64(row.Rank)})
				tableKeys[*row.GroupID] = row.TableKey
			}
			return byGroup, tableKeys
		}
		duplicate := synthetic.DuplicateRank
		groupID := strings.TrimPrefix(duplicate.Name, "Group ")
		duplicateRows, _ := mapped(syntheticPayload(t, buildTable(duplicate.Name, duplicate.Entries, duplicate.RankOverrides, nil)))
		assertWire(t, "duplicate rank stat", duplicateRows[groupID], duplicate.Expected.Reader)
		// T16.2 decision A: a team in two tables is in both, at its true rank in
		// each -- the vector the frontend suite asserts and the database suite
		// stores and serves.
		byGroup, tableKeys := mapped(syntheticTables(t, raw, synthetic.SharedTeam.Groups))
		assertWire(t, "shared team", wire(t, byGroup), synthetic.SharedTeam.Expected)
		for _, g := range synthetic.SharedTeam.Groups {
			if key := tableKeys[strings.TrimPrefix(g.Name, "Group ")]; key != *g.ID {
				t.Fatalf("table %s keyed %q, want its provider id %q", g.Name, key, *g.ID)
			}
		}
		for _, c := range synthetic.Conflicts.Cases {
			if rows, err := espn.MapStandings(syntheticTables(t, raw, c.Groups)); c.Expected != "error" || err == nil {
				t.Fatalf("%s: Go MapStandings accepted %+v", c.Name, rows)
			}
		}

		// Malformed tables: a missing stat or no entries rejects the payload in
		// both mappers (the writer then keeps the previous standings).
		missing := synthetic.MissingStat
		malformed := buildTable(missing.Name, missing.Entries, nil, missing.DropStats)
		emptyTable := buildTable(synthetic.EmptyTable.Name, nil, nil, nil)
		blank := synthetic.EmptyTeamID
		blankID := buildTable(blank.Name, blank.Entries, nil, nil)
		blankID["standings"].(map[string]any)["entries"].([]any)[slices.Index(blank.Entries, blank.BlankTeamID)].(map[string]any)["team"].(map[string]any)["id"] = ""
		for _, payload := range []map[string]any{malformed, emptyTable, blankID} {
			if _, err := espn.MapStandings(syntheticPayload(t, payload)); err == nil {
				t.Fatalf("Go MapStandings accepts malformed table %v", payload["name"])
			}
		}
		// Envelopes: a missing or null table array rejects the payload; an empty
		// one is zero rows (ReplaceStandings then refuses the empty replacement
		// and keeps the stored rows).
		for _, c := range synthetic.Envelopes.Cases {
			data, err := json.Marshal(c.Payload)
			if err != nil {
				t.Fatal(err)
			}
			rows, err := espn.MapStandings(data)
			if c.Expected == "error" {
				if err == nil {
					t.Fatalf("%s: accepted", c.Name)
				}
				continue
			}
			if err != nil || len(rows) != 0 || len(c.Expected.([]any)) != 0 {
				t.Fatalf("%s: %v %v", c.Name, rows, err)
			}
		}
	})

	t.Run("recorded bracket: instant-normalized parity and placeholder crest", func(t *testing.T) {
		exercise("getBracket")
		matches, err := espn.MapBracket(contractFixture(t, fixtureName(t, raw, "bracket")))
		if err != nil {
			t.Fatal(err)
		}
		byID := map[string]espn.BracketMatch{}
		for _, match := range matches {
			byID[match.ID] = match
		}
		// Contract decision: BracketRound.name is an additive English label for
		// API consumers. The frontend type has no name and localizes from slug;
		// the TS suite proves each name equals the frontend's English label.
		names := map[string]any{}
		for slug, name := range bracketRoundNames {
			names[slug] = name
		}
		assertWire(t, "reader round names", names, vector(t, raw, "bracket", "readerRoundNames"))
		round := wire(t, BracketRound{Slug: "final", Name: bracketRoundNames["final"], Matches: []espn.BracketMatch{}}).(map[string]any)
		validateSchema(t, document, "BracketRound", round)
		if round["name"] != "Final" {
			t.Fatalf("reader BracketRound name %v, want the English label", round["name"])
		}
		// A clockless live knockout match is null in both contracts.
		liveClockless := vector(t, raw, "bracket", "liveClockless").(map[string]any)
		var bracketRaw map[string]any
		if err := json.Unmarshal(contractFixture(t, fixtureName(t, raw, "bracket")), &bracketRaw); err != nil {
			t.Fatal(err)
		}
		for _, event := range bracketRaw["events"].([]any) {
			e := event.(map[string]any)
			if e["id"] != liveClockless["eventId"] {
				continue
			}
			setLive(e["status"].(map[string]any), nil)
		}
		liveData, err := json.Marshal(bracketRaw)
		if err != nil {
			t.Fatal(err)
		}
		liveMatches, err := espn.MapBracket(liveData)
		if err != nil {
			t.Fatal(err)
		}
		if expected := liveClockless["expected"].(map[string]any); expected["reader"] != nil || expected["frontend"] != nil {
			t.Fatalf("clockless bracket minute vector %v, want null for both", expected)
		}
		found := false
		for _, match := range liveMatches {
			if match.ID == liveClockless["eventId"] {
				found = true
				if match.State != espn.MatchStateLive || match.Minute != nil {
					t.Fatalf("clockless live bracket match %s minute %v, want null", match.State, match.Minute)
				}
				if minute, ok := wire(t, match).(map[string]any)["minute"]; !ok || minute != nil {
					t.Fatal("clockless live bracket minute must serialize as null")
				}
			}
		}
		if !found {
			t.Fatal("clockless live bracket match missing")
		}
		// A shootout names a bracket winner only once the match is finished.
		liveShootout := vector(t, raw, "bracket", "liveShootout").(map[string]any)
		// ESPN's own flag rides with the aggregate-derived winner (recorded:
		// Paraguay, flagged and the higher structured total).
		for _, match := range matches {
			if match.ID == liveShootout["eventId"] && (match.WinnerFlagID == nil || match.WinnerID == nil || *match.WinnerFlagID != *match.WinnerID) {
				t.Fatalf("recorded bracket winner flag %v, winner %v", match.WinnerFlagID, match.WinnerID)
			}
		}
		for _, live := range []bool{false, true} {
			var shootoutRaw map[string]any
			if err := json.Unmarshal(contractFixture(t, fixtureName(t, raw, "bracket")), &shootoutRaw); err != nil {
				t.Fatal(err)
			}
			sides := map[string]string{}
			for _, event := range shootoutRaw["events"].([]any) {
				e := event.(map[string]any)
				if e["id"] != liveShootout["eventId"] {
					continue
				}
				for _, competitor := range e["competitions"].([]any)[0].(map[string]any)["competitors"].([]any) {
					side := competitor.(map[string]any)
					side["winner"] = false
					sides[side["homeAway"].(string)] = side["team"].(map[string]any)["id"].(string)
				}
				if live {
					maps.Copy(e["status"].(map[string]any)["type"].(map[string]any), liveShootout["status"].(map[string]any))
				}
			}
			data, err := json.Marshal(shootoutRaw)
			if err != nil {
				t.Fatal(err)
			}
			mapped, err := espn.MapBracket(data)
			if err != nil {
				t.Fatal(err)
			}
			want := liveShootout["expected"].(map[string]any)["finished"]
			if live {
				want = liveShootout["expected"].(map[string]any)["live"]
			}
			if side, ok := want.(string); ok {
				want = sides[side]
			}
			found := false
			for _, match := range mapped {
				if match.ID == liveShootout["eventId"] {
					found = true
					assertWire(t, "bracket shootout winner (live "+strconv.FormatBool(live)+")", wire(t, match.WinnerID), want)
					// The structured aggregate rides off the wire to the ingester's
					// candidate, where the summary precedence ranks it above the note.
					assertWire(t, "bracket shootout aggregate", wire(t, match.Shootout), liveShootout["aggregate"])
					if match.WinnerFlagID != nil {
						t.Fatalf("cleared winner flags carried as %s", *match.WinnerFlagID)
					}
					if _, onWire := wire(t, match).(map[string]any)["shootout"]; onWire {
						t.Fatal("the bracket aggregate reached the wire")
					}
				}
			}
			if !found {
				t.Fatal("shootout bracket match missing")
			}
		}
		// One knockout round vocabulary: the TS KnockoutRoundSlug union (pinned by
		// the TS suite against readerRoundNames' keys), the Go mapper, the reader's
		// round order and names, and the OpenAPI enums, in bracket order.
		var slugs []any
		for _, slug := range bracketRoundOrder {
			slugs = append(slugs, slug)
		}
		assertWire(t, "reader round names", slices.Sorted(maps.Keys(bracketRoundNames)), slices.Sorted(maps.Keys(vector(t, raw, "bracket", "readerRoundNames").(map[string]any))))
		for _, field := range []struct{ schema, property string }{{"BracketMatch", "round"}, {"BracketRound", "slug"}} {
			property := schemaOf(t, document, field.schema).Properties[field.property]
			if property == nil || property.Value == nil {
				t.Fatalf("OpenAPI %s.%s missing", field.schema, field.property)
			}
			assertWire(t, "OpenAPI "+field.schema+"."+field.property+" enum", property.Value.Enum, slugs)
		}
		for _, value := range []any{"group-stage", "second-round", ""} {
			if schemaOf(t, document, "BracketRound").Properties["slug"].Value.VisitJSON(value) == nil {
				t.Fatalf("OpenAPI BracketRound.slug accepts %q", value)
			}
		}
		// All recorded matches, in the frontend's round order.
		table := vector(t, raw, "bracket", "table").([]any)
		if len(table) != len(matches) {
			t.Fatalf("bracket table has %d matches, Go mapped %d", len(table), len(matches))
		}
		for i, entry := range table {
			m := matches[i]
			assertWire(t, "bracket row", wire(t, []any{m.ID, m.Round, m.State, m.Home.ID, m.Away.ID, m.HomeScore, m.AwayScore, m.WinnerID}), entry)
		}
		for _, name := range []string{"frontendFirst", "frontendPlaceholder"} {
			frontend := vector(t, raw, "bracket", name).(map[string]any)
			match, ok := byID[frontend["id"].(string)]
			if !ok {
				t.Fatalf("%s missing from Go bracket", name)
			}
			actual := wire(t, match).(map[string]any)
			validateSchema(t, document, "BracketMatch", actual)
			// Named normalizer: compare kickoff instants, not ESPN's minute-precision lexical form.
			goKickoff, err := time.Parse(time.RFC3339, actual["kickoff"].(string))
			if err != nil || !goKickoff.Equal(espnInstant(t, frontend["kickoff"].(string))) {
				t.Fatalf("%s kickoff %v != %v", name, actual["kickoff"], frontend["kickoff"])
			}
			expected := maps.Clone(frontend)
			expected["kickoff"] = actual["kickoff"]
			if name == "frontendPlaceholder" {
				if away := actual["away"].(map[string]any); away["placeholder"] != true || away["crestUrl"] != nil {
					t.Fatalf("placeholder slot %v, want a null crest", away)
				}
				// The match list maps the same recorded events: also null.
				listed, err := espn.MapScoreboard(contractFixture(t, fixtureName(t, raw, "bracket")))
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, m := range listed {
					if m.ID == frontend["id"] {
						found = true
						if m.Away.CrestURL != nil {
							t.Fatalf("listed placeholder crest %q, want null", *m.Away.CrestURL)
						}
					}
				}
				if !found {
					t.Fatal("placeholder missing from the mapped match list")
				}
			}
			assertWire(t, name, actual, expected)
		}
	})

	t.Run("recorded leaders: same rows without identity, goals-only reader", func(t *testing.T) {
		exercise("getLeaders")
		for _, board := range []struct{ category, vectorKey string }{{"goalsLeaders", "scorers"}, {"assistsLeaders", "assists"}} {
			leaders, err := espn.MapLeaders(contractFixture(t, fixtureName(t, raw, "leaders")), board.category, 10)
			if err != nil {
				t.Fatal(err)
			}
			frontend := vector(t, raw, "leaders", "frontend", board.vectorKey).([]any)
			assertWire(t, board.category, wire(t, leaders), withoutEach(frontend, "athleteId", "teamId"))
		}
		topScorer := wire(t, espn.TopScorer{Rank: 1, Player: "x", Goals: 6}).(map[string]any)
		validateSchema(t, document, "TopScorer", topScorer)
		assertAbsent(t, document, "TopScorer", topScorer, "value", "athleteId", "teamId", "playerSlug")
		gap("T10.2-leaders") // With the inventory's no-assists-path check above.
	})

	t.Run("recorded news is identical through the real reader proxy", func(t *testing.T) {
		exercise("getNews")
		client := &fakeESPNClient{raw: contractFixture(t, fixtureName(t, raw, "news"))}
		app := newTestApp(t, &fakeReaderStore{}, nil)
		app.news = newNewsService(context.Background(), client, time.Minute)
		response := performRequest(app.router(), http.MethodGet, "/v1/competitions/world-cup/news")
		var body []any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK {
			t.Fatalf("news %d: %s", response.Code, response.Body.String())
		}
		assertWire(t, "news", body, vector(t, raw, "news", "shared"))
		for _, article := range body {
			validateSchema(t, document, "NewsArticle", article)
		}
		failing := newTestApp(t, &fakeReaderStore{}, nil)
		failing.news = newNewsService(context.Background(), &fakeESPNClient{err: errors.New("espn down")}, time.Minute)
		response = performRequest(failing.router(), http.MethodGet, "/v1/competitions/world-cup/news")
		if response.Code != http.StatusBadGateway || response.Body.String() != "{\"error\":\"upstream error\"}\n" {
			t.Fatalf("gap changed: news upstream failure is %d %s", response.Code, response.Body.String())
		}
		gap("T16.6-news")
	})

	t.Run("recorded roster order and identity agree with the frontend", func(t *testing.T) {
		exercise("getSquad")
		squad, err := espn.MapRoster(contractFixture(t, fixtureName(t, raw, "squad")))
		if err != nil {
			t.Fatal(err)
		}
		var order []string
		for _, player := range squad.Players {
			order = append(order, player.SourceID)
		}
		var expectedOrder []string
		for _, player := range vector(t, raw, "squad", "players").([]any) {
			expectedOrder = append(expectedOrder, player.(map[string]any)["id"].(string))
		}
		if !reflect.DeepEqual(order, expectedOrder) {
			t.Fatalf("roster order %v", order)
		}
		for _, pinned := range vector(t, raw, "squad", "players").([]any) {
			expected := pinned.(map[string]any)
			found := false
			for _, player := range squad.Players {
				if player.SourceID != expected["id"] {
					continue
				}
				found = true
				// Named normalizer: the writer stores '' nationality as NULL (nullIfEmpty).
				var nationality any
				if player.Nationality != "" {
					nationality = player.Nationality
				}
				if player.FullName != expected["name"] || nationality != expected["nationality"] || player.Position != expected["position"] {
					t.Fatalf("roster identity %s drifted", player.SourceID)
				}
			}
			if !found {
				t.Fatalf("pinned player %v missing", expected["id"])
			}
		}
	})

	t.Run("recorded career agrees; no reader player route", func(t *testing.T) {
		history, err := espn.MapAthleteBio(contractFixture(t, vector(t, raw, "player", "bioFixture").(string)))
		if err != nil {
			t.Fatal(err)
		}
		career := vector(t, raw, "player", "frontend", "career").([]any)
		if len(history) != len(career) {
			t.Fatalf("career length %d != %d", len(history), len(career))
		}
		for i, stint := range history {
			expected := career[i].(map[string]any)
			if stint.TeamSourceID != expected["teamId"] || stint.TeamName != expected["teamName"] || stint.Seasons != expected["seasons"] {
				t.Fatalf("career %d drifted: %+v vs %v", i, stint, expected)
			}
		}
	})

	t.Run("matches route selects the frontend's window for every query vector", func(t *testing.T) {
		exercise("getMatches", "getFixtures", "getLiveWindow", "getUpcoming") // One shared reader route.
		base := "/v1/competitions/" + vectors.Queries.Competition + "/" + vectors.Queries.Season + "/matches"
		statuses := map[int]int{}
		for _, vector := range vectors.Queries.Params {
			store := &fakeReaderStore{matches: []Match{}}
			app := newTestApp(t, store, &fakeNewsReader{})
			app.now = func() time.Time { return vectors.Queries.Now }
			response := performRequest(app.router(), http.MethodGet, base+vector.Query)
			status, _ := vector.expected()
			statuses[status]++
			if response.Code != status {
				t.Fatalf("%q: %d %s, want %d", vector.Query, response.Code, response.Body.String(), status)
			}
			if status == http.StatusBadRequest {
				var body map[string]string
				if json.Unmarshal(response.Body.Bytes(), &body) != nil || len(body) != 1 || body["error"] == "" ||
					strings.Contains(response.Body.String(), vector.Query) || store.calls != 0 ||
					response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("%q: rejection %s reached storage (%d calls) or echoed input", vector.Query, response.Body.String(), store.calls)
				}
				continue
			}
			if vector.Reader != nil {
				continue // Its rows are pinned against Postgres (TestMatchQueryVectorsAgainstPostgres).
			}
			// The frontend dispatch the reader must reproduce: getMatches is the
			// detailed window, getFixtures the lightweight one, getUpcoming the
			// scheduled forward feed with its 12-row default. The route filters
			// and caps a window after fetching it, so state and limit come from
			// the query string itself, never from the reader's own parse.
			values, err := url.ParseQuery(strings.TrimPrefix(vector.Query, "?"))
			if err != nil {
				t.Fatal(err)
			}
			want := matchQuery{ScheduledOnly: values.Get("state") == "scheduled", Detail: values.Get("detail") == "summary"}
			if raw := values.Get("limit"); raw != "" {
				if want.Limit, err = strconv.Atoi(raw); err != nil {
					t.Fatal(err)
				}
			}
			switch vector.Frontend.Method {
			case "getMatches", "getFixtures":
				window := vector.Frontend.Args[0].(string)
				want.From, want.To = day(window[:4]+"-"+window[4:6]+"-"+window[6:8]), day(window[9:13]+"-"+window[13:15]+"-"+window[15:17]).AddDate(0, 0, 1)
				if want.Detail != (vector.Frontend.Method == "getMatches") {
					t.Fatalf("%q: detail disagrees with the frontend dispatch %s", vector.Query, vector.Frontend.Method)
				}
			case "getUpcoming":
				want.From, want.To = day("2026-07-01"), day("2026-07-30")
				if len(vector.Frontend.Args) == 1 {
					want.Limit = int(vector.Frontend.Args[0].(float64))
				} else {
					want.Limit = upcomingLimit
				}
			default:
				t.Fatalf("%q: unknown frontend method %q", vector.Query, vector.Frontend.Method)
			}
			if got := store.query; got != want {
				t.Fatalf("%q: reader query %+v, frontend dispatch %+v", vector.Query, got, want)
			}
		}
		if statuses[http.StatusOK] < 10 || statuses[http.StatusBadRequest] < 10 {
			t.Fatalf("query vectors exercise %v", statuses)
		}
		parameters := map[string]bool{}
		for _, parameter := range okGet(t, document, "/v1/competitions/{comp}/{season}/matches").Parameters {
			if parameter.Value.In == "query" {
				parameters[parameter.Value.Name] = true
			}
		}
		if !reflect.DeepEqual(parameters, map[string]bool{"range": true, "state": true, "detail": true, "limit": true, "scope": true}) {
			t.Fatalf("OpenAPI documents query parameters %v", parameters)
		}
	})

	t.Run("freshness headers from frozen-clock snapshots", func(t *testing.T) {
		statuses, polls := map[string]bool{}, map[string]bool{}
		for _, c := range vectors.Freshness.Cases {
			snapshot := freshnessSnapshot{PollSucceededAt: c.Snapshot.PollSucceededAt, PollStatus: c.Snapshot.PollStatus, HasUnfinalized: c.Snapshot.HasUnfinalized}
			for _, match := range c.Snapshot.Matches {
				snapshot.Matches = append(snapshot.Matches, freshnessMatch{Kickoff: match.Kickoff, State: match.State, Status: match.Status, ObservedAt: match.ObservedAt, FinalizedAt: match.FinalizedAt})
			}
			app := newTestApp(t, &fakeReaderStore{matches: []Match{}, freshness: snapshot}, &fakeNewsReader{})
			now := c.Now
			app.now = func() time.Time { return now }
			response := performRequest(app.router(), http.MethodGet, "/v1/competitions/"+vectors.Freshness.Competition+"/"+vectors.Freshness.Season+"/matches")
			if response.Code != http.StatusOK || response.Body.String() != "[]\n" {
				t.Fatalf("%s: %d %s", c.Name, response.Code, response.Body.String())
			}
			actual := map[string]string{}
			for _, name := range freshnessHeaders {
				if value := response.Header().Get(name); value != "" {
					actual[name] = value
				}
			}
			if !reflect.DeepEqual(actual, c.Headers) {
				t.Fatalf("%s headers %v, want %v", c.Name, actual, c.Headers)
			}
			statuses[actual["X-ScoreArc-Freshness"]] = true
			polls[actual["X-ScoreArc-Poll-Status"]] = true
		}
		// Deleting a snapshot vector must not silently shrink status coverage.
		if !reflect.DeepEqual(statuses, map[string]bool{"fresh": true, "empty": true, "dormant": true, "stale": true, "unavailable": true}) ||
			!reflect.DeepEqual(polls, map[string]bool{"ok": true, "partial": true, "failed": true, "unknown": true}) {
			t.Fatalf("freshness vectors cover statuses %v and poll states %v", statuses, polls)
		}
	})

	t.Run("a failed team child query fails the whole reader request", func(t *testing.T) {
		store := &fakeReaderStore{teamErr: &teamReadError{operation: "squad", err: errors.New("relation squad_membership unavailable")}}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet,
			"/v1/competitions/liga-mx/2026-apertura/teams/mex-america")
		if response.Code != http.StatusInternalServerError || response.Body.String() != "{\"error\":\"internal error\"}\n" {
			t.Fatalf("gap changed: a failed squad query now returns %d %s; update reader-contract.json", response.Code, response.Body.String())
		}
		gap("T10.3-partial-failure") // The frontend keeps the profile with an empty squad (TS pins it).
	})

	t.Run("dependency errors and cancellation return a sanitized 500 body, never empty", func(t *testing.T) {
		for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
			app := newTestApp(t, &fakeReaderStore{matchesErr: cause}, &fakeNewsReader{})
			response := performRequest(app.router(), http.MethodGet, "/v1/competitions/world-cup/2026/matches")
			if response.Code != http.StatusInternalServerError || response.Body.String() != "{\"error\":\"internal error\"}\n" ||
				response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-ScoreArc-Freshness") != "" {
				t.Fatalf("%v: %d %s %v", cause, response.Code, response.Body.String(), response.Header())
			}
		}
		// A secret-bearing dependency error: every data route sanitizes the body,
		// but all except handleTeam and handleCalendar log the raw text (T21.4).
		// Those two log only constant metadata (safeLog names a field each must
		// carry), the reference the fix must match.
		secret := errors.New("password=secret")
		for _, route := range []struct {
			path    string
			status  int
			store   *fakeReaderStore
			news    *fakeNewsReader
			leaks   bool
			safeLog string
		}{
			{"/v1/competitions/world-cup/2026/matches", 500, &fakeReaderStore{matchesErr: secret}, &fakeNewsReader{}, true, ""},
			{"/v1/competitions/world-cup/2026/standings", 500, &fakeReaderStore{standingsErr: secret}, &fakeNewsReader{}, true, ""},
			{"/v1/competitions/world-cup/2026/bracket", 500, &fakeReaderStore{bracketErr: secret}, &fakeNewsReader{}, true, ""},
			{"/v1/competitions/world-cup/2026/top-scorers", 500, &fakeReaderStore{topScorersErr: secret}, &fakeNewsReader{}, true, ""},
			{"/v1/competitions/world-cup/news", 502, &fakeReaderStore{}, &fakeNewsReader{err: secret}, true, ""},
			{"/v1/matches/" + vectors.Summary.ReaderMatchID, 500, &fakeReaderStore{summaryErr: secret}, &fakeNewsReader{}, true, ""},
			{"/v1/competitions/liga-mx/2026-apertura/teams/mex-america", 500,
				&fakeReaderStore{teamErr: &teamReadError{operation: "squad", err: secret}}, &fakeNewsReader{}, false, `"operation":"squad"`},
			{"/v1/competitions/world-cup/2026/calendar", 500, &fakeReaderStore{calendarErr: secret}, &fakeNewsReader{}, false, `"row_bound_exceeded":false`},
		} {
			app := newTestApp(t, route.store, route.news)
			var logs bytes.Buffer
			app.logger = slog.New(slog.NewJSONHandler(&logs, nil))
			response := performRequest(app.router(), http.MethodGet, route.path)
			if response.Code != route.status || strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("%s: %d %s", route.path, response.Code, response.Body.String())
			}
			switch {
			case route.leaks && !strings.Contains(logs.String(), "password=secret"):
				t.Fatalf("gap changed: %s no longer logs raw dependency text; update reader-contract.json", route.path)
			case !route.leaks && (strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), route.safeLog)):
				t.Fatalf("%s must log only constant error metadata: %s", route.path, logs.String())
			}
		}
		gap("T21.4-dependency-error-logging")
	})

	t.Run("reader transport errors and freshness coverage", func(t *testing.T) {
		store := &fakeReaderStore{standings: []Group{}, topScorers: []espn.TopScorer{}}
		app := newTestApp(t, store, &fakeNewsReader{})
		router := app.router()
		if len(vectors.Transport.Reader) == 0 || len(vectors.Transport.SuccessCache.Reader) == 0 {
			t.Fatal("no reader transport vectors exercised")
		}
		for _, vector := range vectors.Transport.Reader {
			response := performRequest(router, http.MethodGet, vector.Path)
			if response.Code != vector.Status || response.Body.String() != "{\"error\":\""+vector.Error+"\"}\n" || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s: %d %s", vector.Path, response.Code, response.Body.String())
			}
		}
		if store.calls != 0 {
			t.Fatal("rejected requests reached storage")
		}
		// Match ids are store-scoped: /v1/matches addresses the canonical UUID
		// only, so the provider event id above is a 404 (match_external_ref
		// translation is proved against Postgres in the go-db suite).
		for _, path := range []string{"/v1/competitions/world-cup/2026/standings", "/v1/competitions/world-cup/2026/top-scorers", "/v1/competitions/world-cup/news"} {
			response := performRequest(router, http.MethodGet, path)
			if response.Code != http.StatusOK {
				t.Fatalf("%s: %d", path, response.Code)
			}
			for _, name := range freshnessHeaders {
				if response.Header().Get(name) != "" {
					t.Fatalf("gap changed: %s now sends %s", path, name)
				}
			}
		}
		for _, path := range []string{"/v1/competitions/{comp}/{season}/standings", "/v1/competitions/{comp}/{season}/top-scorers", "/v1/competitions/{comp}/news"} {
			if okHeader(t, document, path, "X-ScoreArc-Freshness") != nil {
				t.Fatalf("gap changed: OpenAPI documents freshness for %s", path)
			}
		}
		gap("T17.3-freshness-coverage")
		for _, vector := range vectors.Transport.SuccessCache.Reader {
			state := espn.MatchStateScheduled
			if vector.Live {
				state = espn.MatchStateLive
			}
			match := Match{ID: vectors.Summary.ReaderMatchID, State: state}
			bracket := []BracketRound{{Slug: "final", Name: "Final", Matches: []espn.BracketMatch{{State: state}}}}
			app := newTestApp(t, &fakeReaderStore{
				matches: []Match{match}, standings: []Group{}, topScorers: []espn.TopScorer{},
				bracket: bracket, summary: &MatchSummary{},
				teams: map[string]*TeamProfile{"mex-america": {}},
			}, &fakeNewsReader{})
			response := performRequest(app.router(), http.MethodGet, vector.Path)
			if strings.Contains(vector.Path, "/teams/") {
				exercise("getTeam") // Wire shape and SQL are pinned by team_contract_test.go.
			}
			if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != vector.CacheControl {
				t.Fatalf("%s: %d Cache-Control %q, want %q", vector.Path, response.Code, response.Header().Get("Cache-Control"), vector.CacheControl)
			}
			// The committed OpenAPI header description must name the served policy.
			header := okHeader(t, document, vector.OpenAPIPath, "Cache-Control")
			if header == nil || header.Value == nil {
				t.Fatalf("OpenAPI no longer documents Cache-Control for %s", vector.OpenAPIPath)
			}
			documented := header.Value.Description
			if strings.Contains(vector.Path, "/teams/") {
				if strings.Contains(documented, vector.CacheControl) || !strings.Contains(documented, "max-age=60") {
					t.Fatalf("gap changed: OpenAPI now documents team caching as %q; update reader-contract.json", documented)
				}
				gap("T10.3-team-cache-doc")
			} else if !strings.Contains(documented, vector.CacheControl) {
				t.Fatalf("%s serves %q but OpenAPI documents %q", vector.Path, vector.CacheControl, documented)
			}
		}
		assertAbsent(t, document, "TeamProfile", wire(t, TeamProfile{}).(map[string]any), "standing", "scheduleAvailability")
		gap("T10.3-team")
	})

	if !subtestRun() {
		methods, covered := slices.Sorted(maps.Keys(vectors.Methods)), slices.Sorted(maps.Keys(exercised))
		if !slices.Equal(covered, methods) {
			t.Fatalf("exercised methods %v, inventory %v", covered, methods)
		}
	}
	assertCharacterizedGaps(t, raw, "go", characterized)
}

// withSummaryOverlay merges the labeled synthetic shootout/head-to-head blocks
// over the recorded summary, exactly as the TypeScript suite spreads them.
func withSummaryOverlay(t *testing.T, raw map[string]any, fixture string) []byte {
	t.Helper()
	var summary map[string]any
	if err := json.Unmarshal(contractFixture(t, fixture), &summary); err != nil {
		t.Fatal(err)
	}
	overlay := vector(t, raw, "summary", "syntheticOverlay").(map[string]any)
	for key, value := range overlay["raw"].(map[string]any) {
		summary[key] = value
	}
	summary["keyEvents"] = append(summary["keyEvents"].([]any), overlay["appendKeyEvents"].([]any)...)
	scores := overlay["shootoutScores"].(map[string]any)
	competition := summary["header"].(map[string]any)["competitions"].([]any)[0].(map[string]any)
	for _, competitor := range competition["competitors"].([]any) {
		side := competitor.(map[string]any)
		side["shootoutScore"] = scores[side["homeAway"].(string)]
	}
	data, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// readerSummary is the reader DTO for an ingester-mapped detail: the same
// fields the writer stores in match_detail and Store.MatchSummary reads back,
// translated by the production read-time attribution with the crosswalk row
// the seed gives each side (go-db proves the same through team_external_ref
// and SQL).
func readerSummary(detail espn.MatchDetail, sides contractSides) MatchSummary {
	summary := MatchSummary{
		Scorers: detail.Scorers, Cards: detail.Cards, Stats: detail.Stats, WinProbability: detail.WinProbability,
		Lineups: detail.Lineups, Videos: detail.Videos, ShootoutDetail: detail.ShootoutDetail, Info: detail.Info,
		Form: detail.Form, Commentary: detail.Commentary, H2H: detail.H2H,
	}
	normalizeMatchSummary(&summary)
	side := func(name string) matchSide {
		return matchSide{id: sides[name].CanonicalID, refs: []string{sides[name].ProviderID}}
	}
	attributeDetail(summary.Scorers, summary.Cards, side("home"), side("away"))
	return summary
}

func sortedKeys(object map[string]any) []any {
	var keys []any
	for _, key := range slices.Sorted(maps.Keys(object)) {
		keys = append(keys, key)
	}
	return keys
}

// assertCharacterizedGaps requires the gaps a suite characterized to equal the
// ones reader-contract.json assigns to it, so a deleted or skipped
// characterization fails. A subtest -run filter runs a subset by design.
func assertCharacterizedGaps(t *testing.T, raw map[string]any, suite string, characterized map[string]bool) {
	t.Helper()
	if subtestRun() {
		return
	}
	var expected []string
	for id, entry := range vector(t, raw, "gaps").(map[string]any) {
		if slices.Contains(entry.(map[string]any)["suites"].([]any), any(suite)) {
			expected = append(expected, id)
		}
	}
	slices.Sort(expected)
	actual := slices.Sorted(maps.Keys(characterized))
	if !slices.Equal(actual, expected) {
		t.Fatalf("characterized gaps %v, contract assigns %s %v", actual, suite, expected)
	}
}

// recordedCommentary projects the recorded payload's commentary the way both
// mappers document it (time.displayValue or "", non-empty text), then checks
// the projection against the count/first/stoppage/last pins in the vectors.
func recordedCommentary(t *testing.T, raw map[string]any, fixture string) any {
	t.Helper()
	var payload struct {
		Commentary []struct {
			Time struct {
				DisplayValue string `json:"displayValue"`
			} `json:"time"`
			Text string `json:"text"`
		} `json:"commentary"`
	}
	if err := json.Unmarshal(contractFixture(t, fixture), &payload); err != nil {
		t.Fatal(err)
	}
	items := []any{}
	var stoppage any
	for _, item := range payload.Commentary {
		if item.Text == "" {
			continue
		}
		entry := map[string]any{"minute": item.Time.DisplayValue, "text": item.Text}
		if stoppage == nil && strings.Contains(item.Time.DisplayValue, "+") {
			stoppage = entry
		}
		items = append(items, entry)
	}
	if len(items) == 0 {
		t.Fatalf("recorded commentary in %s is empty; update reader-contract.json", fixture)
	}
	pins := vector(t, raw, "summary", "commentary").(map[string]any)
	assertWire(t, "commentary pins", []any{float64(len(items)), items[0], stoppage, items[len(items)-1]},
		[]any{pins["count"], pins["first"], pins["stoppage"], pins["last"]})
	return wire(t, items)
}

// subtestRun reports a -run filter that selects subtests, which runs a subset
// of the ledgered checks by design.
func subtestRun() bool {
	filter := flag.Lookup("test.run")
	return filter != nil && strings.Contains(filter.Value.String(), "/")
}

func fixtureName(t *testing.T, raw map[string]any, section string) string {
	t.Helper()
	return vector(t, raw, section, "fixture").(string)
}

// withoutEach copies vector rows minus fields the other DTO does not carry.
func withoutEach(rows []any, fields ...string) []any {
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		copied := maps.Clone(row.(map[string]any))
		for _, field := range fields {
			delete(copied, field)
		}
		out = append(out, copied)
	}
	return out
}

// assertSharedSummary checks the summary fields both implementations agree on,
// for the mapper DTO and the stored route alike.
func assertSharedSummary(t *testing.T, label string, raw map[string]any, summary map[string]any) {
	t.Helper()
	for _, key := range []string{"winProbability", "shootoutDetail", "info", "form", "h2h", "videos"} {
		assertWire(t, label+"shared "+key, summary[key], vector(t, raw, "summary", "shared", key))
	}
	assertWire(t, label+"commentary", summary["commentary"], recordedCommentary(t, raw, fixtureName(t, raw, "summary")))
}

// assertOverlaySummary checks the synthetic overlay's second-state fields.
func assertOverlaySummary(t *testing.T, label string, raw map[string]any, summary map[string]any) {
	t.Helper()
	expected := vector(t, raw, "summary", "syntheticOverlay", "expected").(map[string]any)
	assertWire(t, label+"shootoutDetail", summary["shootoutDetail"], expected["shootoutDetail"])
	assertWire(t, label+"h2h", summary["h2h"], expected["h2h"])
	// Includes a goal and a card credited to a team that is neither side: null.
	assertWire(t, label+"scorers with penalty, shootout and unattributable", summary["scorers"], append(append([]any{},
		vector(t, raw, "summary", "reader", "scorers").([]any)...), expected["readerAddedScorers"].([]any)...))
	assertWire(t, label+"cards with a red and unattributable", summary["cards"], append(append([]any{},
		vector(t, raw, "summary", "reader", "cards").([]any)...), expected["readerAddedCards"].([]any)...))
}

// espnInstant parses ESPN's minute-precision kickoff form, the named
// normalizer for comparing it with the reader's RFC3339 seconds.
func espnInstant(t *testing.T, value string) time.Time {
	t.Helper()
	instant, err := time.Parse("2006-01-02T15:04Z07:00", value)
	if err != nil {
		t.Fatalf("ESPN kickoff %q: %v", value, err)
	}
	return instant
}
