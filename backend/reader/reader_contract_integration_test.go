package main

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

// Real SQL for the reader contract: recorded payloads go through the Go mapper
// and the ingester's own writer, then back out through the SELECT-only reader
// login and the HTTP handlers. Docker is required, as for the other reader
// integration tests; AGENTS.md documents the Colima socket environment.
func TestReaderContractStoreIntegration(t *testing.T) {
	vectors, raw := loadReaderContract(t)
	document := loadOpenAPI(t)
	crosswalk := espnToCanonical(t)
	reader, pool := newIntegrationStore(t)
	ctx := context.Background()
	writer, err := writerstore.New(ctx, pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	router := teamIntegrationApp(t, reader, &bytes.Buffer{}).router()
	// Gaps only real SQL can show are tracked in their own ledger.
	characterized := map[string]bool{}
	get := func(t *testing.T, path string, into any) http.Header {
		t.Helper()
		response := performRequest(router, http.MethodGet, path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		if err := json.Unmarshal(response.Body.Bytes(), into); err != nil {
			t.Fatal(err)
		}
		return response.Header()
	}
	// Canonical team rows carry the recorded provider metadata explicitly;
	// seed rows already present (nat-arg, nat-fra) keep their own.
	team := func(t *testing.T, providerTeam espn.Team, canonical string) {
		t.Helper()
		if canonical == "" {
			t.Fatalf("provider team %s is not in the production seed", providerTeam.ID)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO team (id, kind, name, abbr, crest_url) VALUES ($1,'national',$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
			canonical, providerTeam.Name, providerTeam.Abbr, providerTeam.CrestURL); err != nil {
			t.Fatal(err)
		}
		// The crosswalk row the seed gives the team; the reader translates
		// stored nested team references through it.
		if _, err := pool.Exec(ctx, `INSERT INTO team_external_ref (source, source_id, team_id) VALUES ('espn',$1,$2) ON CONFLICT DO NOTHING`,
			providerTeam.ID, canonical); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("recorded summary survives writer and reader SQL", func(t *testing.T) {
		detail, err := espn.MapSummary(contractFixture(t, vectors.Summary.Fixture))
		if err != nil {
			t.Fatal(err)
		}
		home, away := vectors.Summary.Sides["home"].CanonicalID, vectors.Summary.Sides["away"].CanonicalID
		team(t, espn.Team{ID: "4789", Name: "Ivory Coast", Abbr: "CIV"}, home)
		team(t, espn.Team{ID: "464", Name: "Norway", Abbr: "NOR"}, away)
		id := uuid.MustParse(vectors.Summary.ReaderMatchID)
		if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, home_score, away_score, winner_id, status_detail, status_name, source)
			VALUES ($1,$2,$3,$4,'finished',$5,$6,1,2,$6,'FT','STATUS_FULL_TIME','espn')`,
			id, vectors.Summary.Competition, vectors.Summary.Season, vectors.Summary.Kickoff, home, away); err != nil {
			t.Fatal(err)
		}
		if err := writer.UpsertMatchDetail(ctx, id, detail); err != nil {
			t.Fatal(err)
		}
		var summary map[string]any
		headers := get(t, "/v1/matches/"+id.String(), &summary)
		validateSchema(t, document, "MatchSummary", summary)
		assertWire(t, "stored MatchSummary keys", sortedKeys(summary), vector(t, raw, "summary", "readerKeys"))
		assertSharedSummary(t, "stored ", raw, summary)
		for _, key := range []string{"scorers", "cards", "stats", "lineups"} {
			assertWire(t, "stored reader "+key, summary[key], vector(t, raw, "summary", "reader", key))
		}
		// No match observation exists, so the body is served as unavailable, not fresh.
		if headers.Get("X-ScoreArc-Freshness") != "unavailable" {
			t.Fatalf("summary freshness %q", headers.Get("X-ScoreArc-Freshness"))
		}
		// The stored match sides are canonical; the nested scorer ids are not.
		var matches []Match
		get(t, "/v1/competitions/world-cup/2026/matches?range=20260630-20260630&limit=1", &matches)
		var stored *Match
		for i := range matches {
			if matches[i].ID == id.String() {
				stored = &matches[i]
			}
		}
		if stored == nil {
			t.Fatal("stored match missing from the list route")
		}
		// The exact list-route wire object: row columns plus the JSONB detail
		// the writer stored, compared field by field and against OpenAPI.
		var wireMatches []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &wireMatches)
		var listed map[string]any
		for _, match := range wireMatches {
			if match["id"] == id.String() {
				listed = match
			}
		}
		validateSchema(t, document, "Match", listed)
		side := func(id, name, abbr string) map[string]any {
			return map[string]any{"id": id, "name": name, "abbr": abbr, "crestUrl": nil}
		}
		assertWire(t, "stored list match", listed, map[string]any{
			"id": id.String(), "kickoff": vectors.Summary.Kickoff, "state": "finished", "minute": nil,
			"statusDetail": "FT", "statusName": "STATUS_FULL_TIME",
			"home": side(home, "Ivory Coast", "CIV"), "away": side(away, "Norway", "NOR"),
			"homeScore": 1.0, "awayScore": 2.0, "winnerId": away, "note": nil,
			"scorers":        vector(t, raw, "summary", "reader", "scorers"),
			"cards":          vector(t, raw, "summary", "reader", "cards"),
			"stats":          vector(t, raw, "summary", "reader", "stats"),
			"winProbability": vector(t, raw, "summary", "shared", "winProbability"),
			"shootout":       nil,
			"shootoutDetail": vector(t, raw, "summary", "shared", "shootoutDetail"),
		})
		// Translated on read: match_detail still holds the provider's team id.
		var storedTeam string
		if err := pool.QueryRow(ctx, `SELECT scorers->0->>'teamId' FROM match_detail WHERE match_id=$1`, id).Scan(&storedTeam); err != nil {
			t.Fatal(err)
		}
		if storedTeam != vectors.Summary.Sides["away"].ProviderID || crosswalk[storedTeam] != *stored.Scorers[0].TeamID {
			t.Fatalf("stored %q served as %q", storedTeam, *stored.Scorers[0].TeamID)
		}
		// T10.1 at the SQL boundary: the query string changed nothing, and the
		// competition/season scope still excludes the seeded Premier League row.
		// Same no-query response as wireMatches, decoded into the DTO.
		body, err := json.Marshal(wireMatches)
		if err != nil {
			t.Fatal(err)
		}
		var all []Match
		if err := json.Unmarshal(body, &all); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(wire(t, all), wire(t, matches)) {
			t.Fatal("gap changed: reader /matches now honors query parameters")
		}
		for i, match := range all {
			if match.ID == otherCompMatch {
				t.Fatal("matches leaked across competitions")
			}
			if i > 0 && all[i-1].Kickoff > match.Kickoff {
				t.Fatal("matches not ordered by kickoff")
			}
		}
	})

	t.Run("synthetic shootout and head-to-head survive JSONB storage", func(t *testing.T) {
		detail, err := espn.MapSummary(withSummaryOverlay(t, raw, vectors.Summary.Fixture))
		if err != nil {
			t.Fatal(err)
		}
		team(t, espn.Team{ID: "4789", Name: "Ivory Coast", Abbr: "CIV"}, vectors.Summary.Sides["home"].CanonicalID)
		team(t, espn.Team{ID: "464", Name: "Norway", Abbr: "NOR"}, vectors.Summary.Sides["away"].CanonicalID)
		id := uuid.MustParse("018f0000-0000-7000-8000-000000016003") // Synthetic test identity.
		if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, source)
			VALUES ($1,'world-cup','2026','2026-07-01T17:00:00Z','finished',$2,$3,'espn')`,
			id, vectors.Summary.Sides["home"].CanonicalID, vectors.Summary.Sides["away"].CanonicalID); err != nil {
			t.Fatal(err)
		}
		if err := writer.UpsertMatchDetail(ctx, id, detail); err != nil {
			t.Fatal(err)
		}
		var summary map[string]any
		get(t, "/v1/matches/"+id.String(), &summary)
		validateSchema(t, document, "MatchSummary", summary)
		assertOverlaySummary(t, "stored ", raw, summary)
		expected := vector(t, raw, "summary", "syntheticOverlay", "expected").(map[string]any)
		// The list row carries the stored summary-side shootout aggregate.
		var listed []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &listed)
		found := false
		for _, match := range listed {
			if match["id"] == id.String() {
				found = true
				validateSchema(t, document, "Match", match)
				assertWire(t, "stored shootout aggregate", match["shootout"], expected["readerShootout"])
			}
		}
		if !found {
			t.Fatal("overlay match missing from the list route")
		}
	})

	t.Run("recorded standings through ReplaceStandings and reader grouping", func(t *testing.T) {
		rows, err := espn.MapStandings(contractFixture(t, fixtureName(t, raw, "standings")))
		if err != nil {
			t.Fatal(err)
		}
		teamIDs := map[string]string{}
		for _, row := range rows {
			teamIDs[row.Team.ID] = crosswalk[row.Team.ID]
			team(t, row.Team, teamIDs[row.Team.ID])
		}
		if err := writer.ReplaceStandings(ctx, "world-cup", "2026", "espn", rows, teamIDs); err != nil {
			t.Fatal(err)
		}
		var groups []map[string]any
		headers := get(t, "/v1/competitions/world-cup/2026/standings", &groups)
		if len(groups) != len(vectors.Standings.Groups) {
			t.Fatalf("got %d groups", len(groups))
		}
		for i, expected := range vectors.Standings.Groups {
			validateSchema(t, document, "Group", groups[i])
			if groups[i]["id"] != expected.ID || groups[i]["name"] != expected.Name || len(groups[i]["standings"].([]any)) != expected.Teams {
				t.Fatalf("group %d = %v %v, want %+v", i, groups[i]["id"], groups[i]["name"], expected)
			}
		}
		assertWire(t, "stored group A", groups[0], vector(t, raw, "standings", "readerGroupA"))
		if headers.Get("X-ScoreArc-Freshness") != "" {
			t.Fatal("gap changed: standings now carry freshness")
		}
		// Equal rank inside one table: team id is the reader's tie-breaker. The
		// rows are synthetic and scoped to another competition season.
		tied := []model.Standing{
			{Team: model.Team{ID: "synthetic-fra"}, Rank: 1, Played: 1, Wins: 1, GoalsFor: 1, GoalDifference: 1, Points: 3},
			{Team: model.Team{ID: "synthetic-arg"}, Rank: 1, Played: 1, Wins: 1, GoalsFor: 1, GoalDifference: 1, Points: 3},
		}
		if err := writer.ReplaceStandings(ctx, "premier-league", "2026-27", "espn", tied,
			map[string]string{"synthetic-fra": "nat-fra", "synthetic-arg": "nat-arg"}); err != nil {
			t.Fatal(err)
		}
		var league []Group
		get(t, "/v1/competitions/premier-league/2026-27/standings", &league)
		unnamed := vector(t, raw, "standings", "unnamedTable", "group").(map[string]any)
		if len(league) != 1 || league[0].ID != unnamed["id"] || league[0].Name != unnamed["name"] ||
			len(league[0].Standings) != 2 || league[0].Standings[0].Team.ID != "nat-arg" || league[0].Standings[1].Team.ID != "nat-fra" {
			t.Fatalf("tie-break or scope drifted: %+v", league)
		}
		// A NULL group is labeled with the competition short name, as the frontend labels an unnamed table.
	})

	t.Run("recorded leaders: goals only, value renamed goals", func(t *testing.T) {
		for _, board := range []struct{ category, stored string }{{"goalsLeaders", "goals"}, {"assistsLeaders", "assists"}} {
			leaders, err := espn.MapLeaders(contractFixture(t, fixtureName(t, raw, "leaders")), board.category, 10)
			if err != nil {
				t.Fatal(err)
			}
			if err := writer.ReplaceLeaders(ctx, "world-cup", "2026", "espn", board.stored, leaders); err != nil {
				t.Fatal(err)
			}
		}
		var scorers []any
		get(t, "/v1/competitions/world-cup/2026/top-scorers", &scorers)
		var expected []any
		for _, row := range vector(t, raw, "leaders", "frontend", "scorers").([]any) {
			leader := row.(map[string]any)
			// Named projection: value -> goals; athleteId/teamId have no reader field (T10.2/T16.2).
			expected = append(expected, map[string]any{
				"rank": leader["rank"], "player": leader["player"], "teamAbbr": leader["teamAbbr"], "teamName": leader["teamName"],
				"teamCrestUrl": leader["teamCrestUrl"], "goals": leader["value"], "matches": leader["matches"],
			})
		}
		assertWire(t, "stored top scorers", scorers, expected)
		for _, scorer := range scorers {
			validateSchema(t, document, "TopScorer", scorer)
		}
		// Store the recorded board at full depth: the reader serves every stored
		// row, where the frontend shows only the first len(expected).
		full, err := espn.MapLeaders(contractFixture(t, fixtureName(t, raw, "leaders")), "goalsLeaders", 1000)
		if err != nil {
			t.Fatal(err)
		}
		if err := writer.ReplaceLeaders(ctx, "world-cup", "2026", "espn", "goals", full); err != nil {
			t.Fatal(err)
		}
		get(t, "/v1/competitions/world-cup/2026/top-scorers", &scorers)
		if len(scorers) != len(full) || len(full) <= len(expected) {
			t.Fatalf("gap changed: reader serves %d of %d stored leaders (frontend %d); update reader-contract.json", len(scorers), len(full), len(expected))
		}
		assertWire(t, "top of the full board", scorers[:len(expected)], expected)
		characterized["T10.2-leaders-depth"] = true
	})

	t.Run("bracket projection keeps placeholders, rounds and canonical sides", func(t *testing.T) {
		placeholder := "prov-espn-131529" // Synthetic provisional identity, not a seed row.
		if _, err := pool.Exec(ctx, `INSERT INTO team (id, kind, name, abbr, crest_url, provisional) VALUES ($1,'national','Round of 32 5 Winner','RD32',NULL,true)`, placeholder); err != nil {
			t.Fatal(err)
		}
		ids := map[string]string{"760486": "018f0000-0000-7000-8000-000000016011", "760503": "018f0000-0000-7000-8000-000000016012"}
		canonical := map[string]string{"131529": placeholder}
		for _, name := range []string{"frontendFirst", "frontendPlaceholder"} {
			frontend := vector(t, raw, "bracket", name).(map[string]any)
			sides := [2]map[string]any{frontend["home"].(map[string]any), frontend["away"].(map[string]any)}
			for _, side := range sides {
				if side["placeholder"] == false {
					crest := side["crestUrl"].(string)
					canonical[side["id"].(string)] = crosswalk[side["id"].(string)]
					team(t, espn.Team{ID: side["id"].(string), Name: side["name"].(string), Abbr: side["abbr"].(string), CrestURL: &crest}, canonical[side["id"].(string)])
				}
			}
			kickoff := espnInstant(t, frontend["kickoff"].(string))
			var winner any
			if frontend["winnerId"] != nil {
				winner = canonical[frontend["winnerId"].(string)]
			}
			if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, round, kickoff, state, home_team_id, away_team_id,
				home_score, away_score, winner_id, status_detail, status_name, home_placeholder, away_placeholder, source)
				VALUES ($1,'world-cup','2026',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'espn')`,
				ids[frontend["id"].(string)], frontend["round"], kickoff, frontend["state"],
				canonical[sides[0]["id"].(string)], canonical[sides[1]["id"].(string)], frontend["homeScore"], frontend["awayScore"],
				winner, frontend["statusDetail"], frontend["statusName"], sides[0]["placeholder"], sides[1]["placeholder"]); err != nil {
				t.Fatal(err)
			}
		}
		var rounds []map[string]any
		get(t, "/v1/competitions/world-cup/2026/bracket", &rounds)
		roundNames := vector(t, raw, "bracket", "readerRoundNames").(map[string]any)
		for _, round := range rounds {
			if round["name"] != roundNames[round["slug"].(string)] {
				t.Fatalf("round %v named %v", round["slug"], round["name"])
			}
		}
		served := map[string]map[string]any{}
		var slugs []any
		for _, round := range rounds {
			validateSchema(t, document, "BracketRound", round)
			slugs = append(slugs, round["slug"])
			for _, match := range round["matches"].([]any) {
				served[match.(map[string]any)["id"].(string)] = match.(map[string]any)
			}
		}
		// Seeded semifinal/final plus these two; canonical order puts the final before the 3rd-place match.
		assertWire(t, "round order", slugs, []any{"round-of-32", "round-of-16", "semifinals", "final"})
		for provider, readerID := range ids {
			var frontend map[string]any
			for _, name := range []string{"frontendFirst", "frontendPlaceholder"} {
				if candidate := vector(t, raw, "bracket", name).(map[string]any); candidate["id"] == provider {
					frontend = candidate
				}
			}
			// Named normalizers only: test UUID for the provider event id, seed or
			// provisional canonical ids for sides/winner, RFC3339 seconds for the
			// same kickoff instant. A placeholder's null crest is compared as is.
			expected := maps.Clone(frontend)
			expected["id"] = readerID
			kickoff := espnInstant(t, frontend["kickoff"].(string))
			expected["kickoff"] = kickoff.UTC().Format(time.RFC3339)
			if frontend["winnerId"] != nil {
				expected["winnerId"] = canonical[frontend["winnerId"].(string)]
			}
			for _, key := range []string{"home", "away"} {
				side := maps.Clone(frontend[key].(map[string]any))
				side["id"] = canonical[side["id"].(string)]
				expected[key] = side
			}
			assertWire(t, "stored bracket "+provider, served[readerID], expected)
		}
	})

	t.Run("recorded roster through ReplaceSquad and the reader squad projection", func(t *testing.T) {
		seedLigaTeam(t, pool)
		squad, err := espn.MapRoster(contractFixture(t, fixtureName(t, raw, "squad")))
		if err != nil {
			t.Fatal(err)
		}
		if err := writer.ReplaceSquad(ctx, "liga-mx", "2026-apertura", "mex-america", "espn", squad.Players, nil); err != nil {
			t.Fatal(err)
		}
		var profile map[string]any
		get(t, ligaTeamPath, &profile)
		validateSchema(t, document, "TeamProfile", profile)
		expected := map[string]map[string]any{}
		for _, entry := range vector(t, raw, "squad", "players").([]any) {
			row := entry.(map[string]any)
			expected[row["name"].(string)] = row
		}
		var order []any
		for _, player := range profile["squad"].([]any) {
			p := player.(map[string]any)
			order = append(order, p["name"])
			want := expected[p["name"].(string)]
			if want == nil {
				t.Fatalf("served unexpected player %v", p["name"])
			}
			// Measured, all-zero and absent statistics blocks plus shirt number
			// (null included), position and nationality, as the reader SQL serves them.
			for _, field := range []string{"stats", "jersey", "position", "nationality"} {
				assertWire(t, "served "+field+" of "+p["name"].(string), p[field], want[field])
			}
			if p["age"] != nil || p["headshotUrl"] != nil {
				t.Fatal("gap changed: reader SquadPlayer age/headshotUrl populated; update reader-contract.json")
			}
		}
		assertWire(t, "served squad order", order, vector(t, raw, "squad", "readerOrder"))
		providerIDs := map[string]bool{}
		for _, player := range vector(t, raw, "squad", "players").([]any) {
			providerIDs[player.(map[string]any)["id"].(string)] = true
		}
		for _, player := range profile["squad"].([]any) {
			id := player.(map[string]any)["id"].(string)
			if _, err := uuid.Parse(id); err != nil || providerIDs[id] {
				t.Fatalf("gap changed: served squad id %q is no longer a canonical UUID", id)
			}
		}
		characterized["T10.3-squad-fields"] = true
		if profile["location"] != nil {
			t.Fatal("gap changed: reader TeamProfile.location is populated; update reader-contract.json")
		}
		if profile["standingSummary"] != vector(t, raw, "team", "readerStandingSummary") {
			t.Fatalf("gap changed: reader standingSummary is %v; update reader-contract.json", profile["standingSummary"])
		}
		characterized["T10.3-standing-summary"] = true
		assertWire(t, "served team record", profile["record"], vector(t, raw, "team", "readerRecord"))
		if reflect.DeepEqual(profile["record"], vector(t, raw, "team", "frontendRecord")) {
			t.Fatal("record vectors no longer differ")
		}
		characterized["T10.3-team-record"] = true
		characterized["T10.3-team-location"] = true
	})

	t.Run("a stored clockless live minute is served as null on every projection", func(t *testing.T) {
		// Rows written before the mapper fix hold '' for a live match without
		// ESPN's display clock. Synthetic, scoped to its own kickoff date.
		id := "018f0000-0000-7000-8000-000000016021"
		if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			home_score, away_score, minute, status_detail, status_name, source)
			VALUES ($1,'world-cup','2026','final','2026-07-18T19:00:00Z','live','nat-arg','nat-fra',0,0,'','HT','STATUS_FIRST_HALF','espn')`, id); err != nil {
			t.Fatal(err)
		}
		minuteOf := func(matches []map[string]any) any {
			for _, match := range matches {
				if match["id"] == id {
					if value, ok := match["minute"]; ok {
						return value
					}
					t.Fatal("minute omitted")
				}
			}
			t.Fatal("clockless match missing")
			return nil
		}
		var listed []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &listed)
		var rounds []map[string]any
		get(t, "/v1/competitions/world-cup/2026/bracket", &rounds)
		var knockout []map[string]any
		for _, round := range rounds {
			for _, match := range round["matches"].([]any) {
				knockout = append(knockout, match.(map[string]any))
			}
		}
		var profile map[string]any
		get(t, "/v1/competitions/world-cup/2026/teams/nat-arg", &profile)
		var schedule []map[string]any
		for _, match := range profile["schedule"].([]any) {
			schedule = append(schedule, match.(map[string]any))
		}
		for label, minute := range map[string]any{"matches": minuteOf(listed), "bracket": minuteOf(knockout), "schedule": minuteOf(schedule)} {
			if minute != nil {
				t.Fatalf("%s minute %#v, want null", label, minute)
			}
		}
	})

	t.Run("provider event ids translate to served match ids through match_external_ref", func(t *testing.T) {
		home, away := vectors.Summary.Sides["home"].CanonicalID, vectors.Summary.Sides["away"].CanonicalID
		team(t, espn.Team{ID: "4789", Name: "Ivory Coast", Abbr: "CIV"}, home)
		team(t, espn.Team{ID: "464", Name: "Norway", Abbr: "NOR"}, away)
		kickoff, err := time.Parse(time.RFC3339, vectors.Summary.Kickoff)
		if err != nil {
			t.Fatal(err)
		}
		ref := func(eventID string, kickoff time.Time) writerstore.MatchRef {
			return writerstore.MatchRef{SourceID: eventID, CompetitionID: vectors.Summary.Competition, SeasonID: vectors.Summary.Season,
				HomeTeamID: home, AwayTeamID: away, Kickoff: kickoff}
		}
		crosswalk := func(eventID string) string {
			var matchID uuid.UUID
			if err := pool.QueryRow(ctx, `SELECT match_id FROM match_external_ref WHERE source='espn' AND source_id=$1`, eventID).Scan(&matchID); err != nil {
				t.Fatal(err)
			}
			return matchID.String()
		}
		// The recorded vector pair: the resolver adopts the served match on its
		// natural key, so the provider event id maps to the reader's UUID.
		if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, source)
			VALUES ($1,$2,$3,$4,'finished',$5,$6,'espn') ON CONFLICT DO NOTHING`,
			vectors.Summary.ReaderMatchID, vectors.Summary.Competition, vectors.Summary.Season, kickoff, home, away); err != nil {
			t.Fatal(err)
		}
		adopted, err := writer.Match(ctx, "espn", ref(vectors.Summary.EventID, kickoff))
		if err != nil {
			t.Fatal(err)
		}
		if adopted.String() != vectors.Summary.ReaderMatchID || crosswalk(vectors.Summary.EventID) != vectors.Summary.ReaderMatchID {
			t.Fatalf("event %s resolved to %s, crosswalk %s", vectors.Summary.EventID, adopted, crosswalk(vectors.Summary.EventID))
		}
		// A new event mints a UUIDv7 -- not derived from the provider id -- and
		// resolves to it again on every later ingest.
		minted, err := writer.Match(ctx, "espn", ref("9160001", kickoff.Add(72*time.Hour)))
		if err != nil {
			t.Fatal(err)
		}
		again, err := writer.Match(ctx, "espn", ref("9160001", kickoff.Add(72*time.Hour)))
		if err != nil {
			t.Fatal(err)
		}
		if minted.Version() != 7 || again != minted || crosswalk("9160001") != minted.String() {
			t.Fatalf("minted %s (v%d), again %s", minted, minted.Version(), again)
		}
		// The served list id addresses the summary route; the provider id does not.
		if err := writer.UpsertMatchDetail(ctx, minted, model.MatchDetail{}); err != nil {
			t.Fatal(err)
		}
		var listed []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &listed)
		found := false
		for _, match := range listed {
			found = found || match["id"] == minted.String()
		}
		if !found {
			t.Fatal("minted match missing from the list route")
		}
		var summary map[string]any
		get(t, "/v1/matches/"+minted.String(), &summary)
		if response := performRequest(router, http.MethodGet, "/v1/matches/9160001"); response.Code != http.StatusNotFound {
			t.Fatalf("provider event id addressed the reader: %d", response.Code)
		}
	})

	t.Run("a sealed legacy detail row is served with canonical sides and unknown scorer identity", func(t *testing.T) {
		// Synthetic: the shape match_detail held before T16.2 -- provider team ids,
		// no ownGoal or athleteId -- finalized, so it can never be rewritten.
		home, away := vectors.Summary.Sides["home"].CanonicalID, vectors.Summary.Sides["away"].CanonicalID
		team(t, espn.Team{ID: "4789", Name: "Ivory Coast", Abbr: "CIV"}, home)
		team(t, espn.Team{ID: "464", Name: "Norway", Abbr: "NOR"}, away)
		id := "018f0000-0000-7000-8000-000000016022"
		if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, home_score, away_score, source)
			VALUES ($1,'world-cup','2026','2026-07-02T17:00:00Z','finished',$2,$3,1,2,'espn')`, id, home, away); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO match_detail (match_id, scorers, cards) VALUES ($1, $2, $3)`, id,
			`[{"teamId":"4789","player":"Legacy Home","minute":"10'","penalty":false,"shootout":false},
			  {"teamId":"464","player":"Legacy Away","minute":"20'","penalty":true,"shootout":false},
			  {"teamId":"226","player":"Legacy Stranger","minute":"30'","penalty":false,"shootout":false}]`,
			`[{"teamId":"464","player":"Legacy Card","minute":"40'","type":"yellow"}]`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE match SET finalized_at=now() WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE match_detail SET scorers='[]' WHERE match_id=$1`, id); err == nil {
			t.Fatal("a finalized detail row accepted a rewrite")
		}
		scorer := func(team any, player, minute string, penalty bool) map[string]any {
			return map[string]any{"teamId": team, "player": player, "minute": minute, "penalty": penalty, "shootout": false, "ownGoal": nil, "athleteId": nil}
		}
		wantScorers := []any{scorer(home, "Legacy Home", "10'", false), scorer(away, "Legacy Away", "20'", true), scorer(nil, "Legacy Stranger", "30'", false)}
		wantCards := []any{map[string]any{"teamId": away, "player": "Legacy Card", "minute": "40'", "type": "yellow"}}
		var summary map[string]any
		get(t, "/v1/matches/"+id, &summary)
		validateSchema(t, document, "MatchSummary", summary)
		assertWire(t, "legacy summary scorers", summary["scorers"], wantScorers)
		assertWire(t, "legacy summary cards", summary["cards"], wantCards)
		var listed []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &listed)
		var profile map[string]any
		get(t, "/v1/competitions/world-cup/2026/teams/"+home, &profile)
		schedule := profile["schedule"].([]any)
		found := 0
		for _, rows := range [][]any{wire(t, listed).([]any), schedule} {
			for _, row := range rows {
				if match := row.(map[string]any); match["id"] == id {
					found++
					validateSchema(t, document, "Match", match)
					assertWire(t, "legacy list scorers", match["scorers"], wantScorers)
					assertWire(t, "legacy list cards", match["cards"], wantCards)
				}
			}
		}
		if found != 2 {
			t.Fatalf("legacy match on %d of 2 list projections", found)
		}
	})

	t.Run("a sealed legacy row recovers scorer identity only from aligned match events", func(t *testing.T) {
		// Synthetic: legacy detail rows whose participation was captured. Every
		// scorer pairs with the goal or own-goal event at the same ordinal on
		// side, minute, penalty and shootout, or no scorer recovers anything.
		home, away := vectors.Summary.Sides["home"].CanonicalID, vectors.Summary.Sides["away"].CanonicalID
		team(t, espn.Team{ID: "4789", Name: "Ivory Coast", Abbr: "CIV"}, home)
		team(t, espn.Team{ID: "464", Name: "Norway", Abbr: "NOR"}, away)
		player := func(id, name string, refs ...string) {
			if _, err := pool.Exec(ctx, `INSERT INTO player (id, full_name) VALUES ($1,$2)`, id, name); err != nil {
				t.Fatal(err)
			}
			for _, ref := range refs {
				if _, err := pool.Exec(ctx, `INSERT INTO player_external_ref (source, source_id, player_id) VALUES ($1,$2,$3)`, ref[:4], ref[5:], id); err != nil {
					t.Fatal(err)
				}
			}
		}
		striker, defender, twice := "018f0000-0000-7000-8000-00000016a001", "018f0000-0000-7000-8000-00000016a002", "018f0000-0000-7000-8000-00000016a003"
		player(striker, "Legacy Striker", "espn:916001")
		player(defender, "Legacy Defender", "espn:916002", "fbrf:916002")
		player(twice, "Legacy Twice", "espn:916003", "espn:916004")
		legacy := `[{"teamId":"4789","player":"Legacy Striker","minute":"10'","penalty":false,"shootout":false},
			{"teamId":"4789","player":"Legacy Defender","minute":"20'","penalty":false,"shootout":false},
			{"teamId":"464","player":"Legacy Twice","minute":"30'","penalty":true,"shootout":false},
			{"teamId":"464","player":"Legacy Unknown","minute":"120'","penalty":true,"shootout":true}]`
		type event struct {
			player            *string
			team, kind        string
			minute            string
			penalty, shootout bool
		}
		aligned := []event{
			{&striker, home, "yellow", "5'", false, false},
			{&striker, home, "goal", "10'", false, false},
			{&defender, home, "own_goal", "20'", false, false},
			{&twice, away, "goal", "30'", true, false},
			{nil, away, "goal", "120'", true, true},
		}
		misaligned := slices.Clone(aligned)
		misaligned[3].minute = "31'"
		seed := func(id, kickoff string, events []event) {
			if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, home_score, away_score, source)
				VALUES ($1,'world-cup','2026',$4,'finished',$2,$3,2,1,'espn')`, id, home, away, kickoff); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO match_detail (match_id, scorers, cards) VALUES ($1, $2, '[]')`, id, legacy); err != nil {
				t.Fatal(err)
			}
			for seq, e := range events {
				if _, err := pool.Exec(ctx, `INSERT INTO match_event (match_id, seq, player_id, team_id, type, minute, penalty, shootout, detail)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'')`, id, seq, e.player, e.team, e.kind, e.minute, e.penalty, e.shootout); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := pool.Exec(ctx, `UPDATE match SET finalized_at=now() WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
		}
		recovered, unrecovered := "018f0000-0000-7000-8000-000000016023", "018f0000-0000-7000-8000-000000016024"
		seed(recovered, "2026-07-05T17:00:00Z", aligned)
		seed(unrecovered, "2026-07-06T17:00:00Z", misaligned)

		scorer := func(team, player, minute string, penalty, shootout bool, ownGoal, athleteID any) map[string]any {
			return map[string]any{"teamId": team, "player": player, "minute": minute, "penalty": penalty, "shootout": shootout, "ownGoal": ownGoal, "athleteId": athleteID}
		}
		want := map[string][]any{
			// A player with two ids on the match's source has no single provider
			// id, and one whose other id is on another source keeps this one.
			recovered: {
				scorer(home, "Legacy Striker", "10'", false, false, false, "916001"),
				scorer(home, "Legacy Defender", "20'", false, false, true, "916002"),
				scorer(away, "Legacy Twice", "30'", true, false, false, nil),
				scorer(away, "Legacy Unknown", "120'", true, true, false, nil),
			},
			unrecovered: {
				scorer(home, "Legacy Striker", "10'", false, false, nil, nil),
				scorer(home, "Legacy Defender", "20'", false, false, nil, nil),
				scorer(away, "Legacy Twice", "30'", true, false, nil, nil),
				scorer(away, "Legacy Unknown", "120'", true, true, nil, nil),
			},
		}
		var listed []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &listed)
		var profile map[string]any
		get(t, "/v1/competitions/world-cup/2026/teams/"+home, &profile)
		for id, scorers := range want {
			var summary map[string]any
			get(t, "/v1/matches/"+id, &summary)
			validateSchema(t, document, "MatchSummary", summary)
			assertWire(t, "summary scorers "+id, summary["scorers"], scorers)
			found := 0
			for _, rows := range [][]any{wire(t, listed).([]any), profile["schedule"].([]any)} {
				for _, row := range rows {
					if match := row.(map[string]any); match["id"] == id {
						found++
						validateSchema(t, document, "Match", match)
						assertWire(t, "list scorers "+id, match["scorers"], scorers)
					}
				}
			}
			if found != 2 {
				t.Fatalf("match %s on %d of 2 list projections", id, found)
			}
		}
	})

	t.Run("a finished match's winner is the stored one, and finalization stores only final shootout evidence", func(t *testing.T) {
		// A live poll stores the summary's partial aggregate; the final write
		// must replace it with the final evidence or with nothing, through the
		// ingester's own writer and the real detail upsert. The reader serves
		// the stored winner of a finished match and none for a match that is
		// not finished. Rows sealed before T16.2 keep their stored winner even
		// where their stored aggregate names the other side: that aggregate
		// may be a live partial that finalization retained, so neither field
		// is provably final (READER_CONTRACT, historical data).
		home, away := vectors.Summary.Sides["home"].CanonicalID, vectors.Summary.Sides["away"].CanonicalID
		team(t, espn.Team{ID: "4789", Name: "Ivory Coast", Abbr: "CIV"}, home)
		team(t, espn.Team{ID: "464", Name: "Norway", Abbr: "NOR"}, away)
		partial := &model.Shootout{HomeScore: 3, AwayScore: 2}
		partialKicks := &model.ShootoutDetail{Home: []model.PenaltyKick{{Order: 1, Player: "Partial", Scored: true}}, Away: []model.PenaltyKick{}}
		row := func(id, kickoff, state string, winner *string) uuid.UUID {
			if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, round, kickoff, state, home_team_id, away_team_id, home_score, away_score, winner_id, status_name, source)
				VALUES ($1,'world-cup','2026','round-of-16',$2,$3,$4,$5,1,1,$6,'STATUS_SHOOTOUT','espn')`, id, kickoff, state, home, away, winner); err != nil {
				t.Fatal(err)
			}
			matchID := uuid.MustParse(id)
			if err := writer.UpsertMatchDetail(ctx, matchID, model.MatchDetail{Shootout: partial, ShootoutDetail: partialKicks}); err != nil {
				t.Fatal(err)
			}
			return matchID
		}
		finalize := func(matchID uuid.UUID, kickoff, status string, winner *string, detail model.MatchDetail) {
			if _, err := pool.Exec(ctx, `UPDATE match SET state='finished' WHERE id=$1`, matchID); err != nil {
				t.Fatal(err)
			}
			one := 1
			finalized, err := writer.FinalizeMatch(ctx,
				writerstore.MatchIdentity{MatchID: matchID, CompetitionID: "world-cup", SeasonID: "2026",
					HomeTeamID: home, AwayTeamID: away, WinnerTeamID: winner, Source: "espn"},
				model.Match{ID: matchID.String(), Kickoff: kickoff, State: model.MatchStateFinished, Round: "round-of-16",
					StatusName: status, HomeScore: &one, AwayScore: &one},
				detail)
			if err != nil || !finalized {
				t.Fatalf("finalize %s: %v %v", matchID, finalized, err)
			}
		}
		live := row("018f0000-0000-7000-8000-000000016026", "2026-07-08T17:00:00Z", "live", &home)
		noEvidence := row("018f0000-0000-7000-8000-000000016028", "2026-07-10T17:00:00Z", "live", nil)
		finalize(noEvidence, "2026-07-10T17:00:00Z", "STATUS_FINAL_PEN", &away, model.MatchDetail{})
		terminal := row("018f0000-0000-7000-8000-000000016029", "2026-07-11T17:00:00Z", "live", nil)
		finalize(terminal, "2026-07-11T17:00:00Z", "STATUS_ABANDONED", nil, model.MatchDetail{})
		decided := row("018f0000-0000-7000-8000-00000001602a", "2026-07-12T17:00:00Z", "live", nil)
		finalize(decided, "2026-07-12T17:00:00Z", "STATUS_FINAL_PEN", &home, model.MatchDetail{Shootout: &model.Shootout{HomeScore: 4, AwayScore: 3}})
		legacy := "018f0000-0000-7000-8000-000000016025"
		if _, err := pool.Exec(ctx, `INSERT INTO match (id, competition_id, season_id, round, kickoff, state, home_team_id, away_team_id, home_score, away_score, winner_id, source)
			VALUES ($1,'world-cup','2026','round-of-16','2026-07-07T17:00:00Z','finished',$2,$3,1,1,$3,'espn')`, legacy, home, away); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO match_detail (match_id, scorers, cards, shootout) VALUES ($1,'[]','[]','{"homeScore":4,"awayScore":3}')`, legacy); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE match SET finalized_at=now() WHERE id=$1`, legacy); err != nil {
			t.Fatal(err)
		}

		type served struct{ winner, shootout any }
		decisive := map[string]any{"homeScore": float64(4), "awayScore": float64(3)}
		want := map[string]served{
			live.String():       {nil, map[string]any{"homeScore": float64(3), "awayScore": float64(2)}},
			noEvidence.String(): {away, nil},
			terminal.String():   {nil, nil},
			decided.String():    {home, decisive},
			legacy:              {away, decisive},
		}
		var listed []map[string]any
		get(t, "/v1/competitions/world-cup/2026/matches", &listed)
		var profile map[string]any
		get(t, "/v1/competitions/world-cup/2026/teams/"+home, &profile)
		var bracket []map[string]any
		get(t, "/v1/competitions/world-cup/2026/bracket", &bracket)
		var bracketMatches []any
		for _, round := range bracket {
			bracketMatches = append(bracketMatches, round["matches"].([]any)...)
		}
		for name, rows := range map[string][]any{"matches": wire(t, listed).([]any), "team schedule": profile["schedule"].([]any), "bracket": bracketMatches} {
			found := 0
			for _, row := range rows {
				match := row.(map[string]any)
				expected, ok := want[match["id"].(string)]
				if !ok {
					continue
				}
				found++
				if match["winnerId"] != expected.winner {
					t.Fatalf("%s %s served winner %v, want %v", name, match["id"], match["winnerId"], expected.winner)
				}
				if name != "bracket" && !reflect.DeepEqual(match["shootout"], expected.shootout) {
					t.Fatalf("%s %s served shootout %v, want %v", name, match["id"], match["shootout"], expected.shootout)
				}
			}
			if found != len(want) {
				t.Fatalf("%s served %d of %d shootout matches", name, found, len(want))
			}
		}
		var stored *string
		if err := pool.QueryRow(ctx, `SELECT winner_id FROM match WHERE id=$1`, live).Scan(&stored); err != nil || stored == nil || *stored != home {
			t.Fatalf("live stored winner rewritten: %v %v", stored, err)
		}
		// The kick list follows the same rule: a live poll's partial list is
		// never sealed as the final one.
		for id, kicks := range map[uuid.UUID]bool{live: true, noEvidence: false, terminal: false} {
			var summary map[string]any
			get(t, "/v1/matches/"+id.String(), &summary)
			if (summary["shootoutDetail"] != nil) != kicks {
				t.Fatalf("match %s served shootout detail %v", id, summary["shootoutDetail"])
			}
		}
	})

	t.Run("read-time translation and recovery stay on indexed lookups", func(t *testing.T) {
		// The bound READER_CONTRACT documents: every correlated lookup the read
		// projections add -- each side's crosswalk ids, a legacy row's goal
		// events and their player ids -- has an index path keyed by the outer
		// row. With sequential scans disabled,
		// a lookup without one still plans as a Seq Scan, so none may appear.
		// match_event must be reached through its (match_id, seq) primary key,
		// never by scanning every goal of every match through its type index.
		want := map[string]string{
			"team_external_ref":   "team_external_ref_target_idx",
			"player_external_ref": "player_external_ref_target_idx",
			"match_event":         "match_event_pkey",
			"match_detail":        "match_detail_pkey",
		}
		for _, q := range []struct {
			name   string
			sql    string
			args   []any
			tables []string
		}{
			{"matches", matchesSQL, []any{"world-cup", "2026"}, []string{"team_external_ref", "player_external_ref", "match_event"}},
			{"team schedule", teamScheduleSQL, []any{"nat-civ", "world-cup", "2026"}, []string{"team_external_ref", "player_external_ref", "match_event"}},
			{"summary", summarySQL, []any{uuid.Nil}, []string{"team_external_ref", "player_external_ref", "match_event", "match_detail"}},
		} {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var plan []byte
			if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
				t.Fatal(err)
			}
			err = tx.QueryRow(ctx, `EXPLAIN (FORMAT JSON) `+q.sql, q.args...).Scan(&plan)
			_ = tx.Rollback(ctx)
			if err != nil {
				t.Fatalf("%s: %v", q.name, err)
			}
			used := map[string][]string{}
			var walk func(node map[string]any)
			walk = func(node map[string]any) {
				if relation, ok := node["Relation Name"].(string); ok {
					if _, tracked := want[relation]; tracked && node["Node Type"] == "Seq Scan" {
						t.Fatalf("%s: sequential scan of %s", q.name, relation)
					}
				}
				if index, ok := node["Index Name"].(string); ok {
					for table := range want {
						if strings.HasPrefix(index, table+"_") {
							used[table] = append(used[table], index)
						}
					}
				}
				for _, child := range asSlice(node["Plans"]) {
					walk(child.(map[string]any))
				}
			}
			var root []map[string]any
			if err := json.Unmarshal(plan, &root); err != nil {
				t.Fatal(err)
			}
			walk(root[0]["Plan"].(map[string]any))
			for _, table := range q.tables {
				if len(used[table]) == 0 {
					t.Fatalf("%s: no index lookup of %s in %s", q.name, table, plan)
				}
			}
			for table, indexes := range used {
				for _, index := range indexes {
					if index != want[table] {
						t.Fatalf("%s: %s reached through %s, want %s", q.name, table, index, want[table])
					}
				}
			}
		}
	})

	assertCharacterizedGaps(t, raw, "go-db", characterized)
}

func asSlice(value any) []any {
	slice, _ := value.([]any)
	return slice
}
