package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

// T10.10 option B: the frontend derives the MLS overall and Leagues Cup phase
// tables from reader responses. This pins those responses -- the derivation's
// only inputs -- to derived-standings.json, which the TypeScript suite feeds to
// deriveReaderStandings and compares with today's ESPN-backed store.
//
// Set SCOREARC_UPDATE_DERIVED_STANDINGS=1 to rewrite the vector from the
// reader's actual output (then review the diff).
const derivedStandingsPath = "../../src/server/data/contracts/derived-standings.json"

type derivedStandingsVector struct {
	About      string                   `json:"about"`
	Evidence   map[string]string        `json:"evidence"`
	PhaseRoute string                   `json:"phaseRoute"`
	PhaseMatch []any                    `json:"phaseMatches"`
	Membership map[string]derivedTables `json:"membership"`
}

type derivedTables struct {
	Route  string `json:"route"`
	Groups []any  `json:"groups"`
}

// countingStore counts every statement the reader runs, in or out of a snapshot.
type countingStore struct{ countingPool }

func (s countingStore) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	s.queries.Add(1)
	return s.Pool.Query(ctx, sql, args...)
}

func (s countingStore) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	s.queries.Add(1)
	return s.Pool.QueryRow(ctx, sql, args...)
}

func TestDerivedStandingsInputsAgainstPostgres(t *testing.T) {
	reader, admin := newIntegrationStore(t)
	ctx := context.Background()
	crosswalk := espnToCanonical(t)
	writer, err := writerstore.New(ctx, admin.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := admin.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
	}
	exec(`INSERT INTO competition (id, name, short_name, kind) VALUES
		('mls','MLS','MLS','league'), ('liga-mx','Liga MX','Liga MX','league'), ('leagues-cup','Leagues Cup','Leagues Cup','cup')`)
	exec(`INSERT INTO season (competition_id, id, label, has_bracket) VALUES
		('mls','2026','2026',false), ('liga-mx','2026-apertura','Apertura 2026',false),
		('liga-mx','2026-clausura','Clausura 2026',false), ('leagues-cup','2026','2026',true)`)
	// Canonical club rows with the provider metadata, and the seed's crosswalk.
	team := func(provider espn.Team) string {
		t.Helper()
		canonical := crosswalk[provider.ID]
		if canonical == "" {
			t.Fatalf("provider team %s is not in the production seed", provider.ID)
		}
		exec(`INSERT INTO team (id, kind, name, abbr, crest_url) VALUES ($1,'club',$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
			canonical, provider.Name, provider.Abbr, provider.CrestURL)
		exec(`INSERT INTO team_external_ref (source, source_id, team_id) VALUES ('espn',$1,$2) ON CONFLICT DO NOTHING`, provider.ID, canonical)
		return canonical
	}

	// The recorded 54-match phase through the Go mapper and the writer.
	phase, err := espn.MapScoreboard(contractFixture(t, "leagues-cup-phase-2026.json"))
	if err != nil || len(phase) != 54 {
		t.Fatalf("recorded phase: %d matches, %v", len(phase), err)
	}
	providerTeams := map[string]espn.Team{}
	for i, m := range phase {
		home, away := team(m.Home), team(m.Away)
		providerTeams[m.Home.ID], providerTeams[m.Away.ID] = m.Home, m.Away
		var winner *string
		if m.WinnerID != nil {
			id := crosswalk[*m.WinnerID]
			winner = &id
		}
		// A fixed test UUID in place of the resolver's minted one, so the
		// vector is stable; the writer then stores the mapped match over it.
		id := uuid.MustParse(fmt.Sprintf("018f0000-0000-7000-8000-%012x", 0x1010000+i))
		exec(`INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, status_detail, status_name, source)
			VALUES ($1,'leagues-cup','2026',$2,'scheduled',$3,$4,'','','espn')`, id, m.Kickoff, home, away)
		if err := writer.UpsertMatch(ctx, writerstore.MatchIdentity{
			MatchID: id, CompetitionID: "leagues-cup", SeasonID: "2026",
			HomeTeamID: home, AwayTeamID: away, HomeTeamSourceID: m.Home.ID, AwayTeamSourceID: m.Away.ID,
			WinnerTeamID: winner, Source: "espn",
		}, m); err != nil {
			t.Fatal(err)
		}
		if err := writer.UpsertMatchDetail(ctx, id, model.MatchDetail{Scorers: []model.Scorer{}, Cards: []model.Card{}, Shootout: m.Shootout}); err != nil {
			t.Fatal(err)
		}
	}

	// MLS membership: the recorded conference tables through the writer.
	mls, err := espn.MapStandings(contractFixture(t, "espn-standings-mls-2026.json"))
	if err != nil {
		t.Fatal(err)
	}
	teamIDs := map[string]string{}
	for _, row := range mls {
		teamIDs[row.Team.ID] = team(row.Team)
	}
	if err := writer.ReplaceStandings(ctx, "mls", "2026", "espn", mls, teamIDs); err != nil {
		t.Fatal(err)
	}
	// Liga MX membership (synthetic, labeled): the recorded Apertura club ids in
	// one table, plus a second table repeating two of them (T16.2 decision A).
	var ligaIDs []string
	if err := json.Unmarshal(contractFixture(t, "liga-mx-team-ids-2026.json"), &ligaIDs); err != nil {
		t.Fatal(err)
	}
	var liga []model.Standing
	str := func(s string) *string { return &s }
	for i, id := range ligaIDs {
		liga = append(liga, model.Standing{Team: providerTeams[id], TableKey: "1", GroupID: str("1"), GroupName: str("Liga MX"), Rank: i + 1})
		teamIDs[id] = crosswalk[id]
	}
	for i, id := range ligaIDs[:2] {
		liga = append(liga, model.Standing{Team: providerTeams[id], TableKey: "2", GroupID: str("2"), GroupName: str("Liga MX second table"), Rank: i + 1})
	}
	if err := writer.ReplaceStandings(ctx, "liga-mx", "2026-apertura", "espn", liga, teamIDs); err != nil {
		t.Fatal(err)
	}

	// Rows the inputs must not see: kickoffs on each side of the UTC window, a
	// knockout match, another competition in the window, and another Liga MX
	// season listing an MLS club.
	vancouver, columbus := teamIDs[mls[0].Team.ID], teamIDs[mls[1].Team.ID]
	toluca := teamIDs[ligaIDs[0]]
	exec(`INSERT INTO match (id, competition_id, season_id, round, kickoff, state, home_team_id, away_team_id, home_score, away_score, status_detail, status_name, source) VALUES
		('018f0000-0000-7000-8000-000002000001','leagues-cup','2026',NULL,'2026-08-03T23:59:59Z','finished',$1,$2,9,0,'FT','STATUS_FULL_TIME','espn'),
		('018f0000-0000-7000-8000-000002000002','leagues-cup','2026',NULL,'2026-08-15T00:00:00Z','finished',$1,$2,9,0,'FT','STATUS_FULL_TIME','espn'),
		('018f0000-0000-7000-8000-000002000003','leagues-cup','2026','quarterfinals','2026-08-25T01:00:00Z','finished',$1,$2,9,0,'FT','STATUS_FULL_TIME','espn'),
		('018f0000-0000-7000-8000-000002000004','mls','2026',NULL,'2026-08-10T01:00:00Z','finished',$1,$3,9,0,'FT','STATUS_FULL_TIME','espn')`,
		vancouver, toluca, columbus)
	exec(`INSERT INTO standing (competition_id, season_id, team_id, table_key, group_id, group_name, rank, source)
		VALUES ('liga-mx','2026-clausura',$1,'1','1','Liga MX',1,'espn')`, vancouver)
	exec(`ANALYZE`)

	// Every statement the three input reads run, as the least-privilege login.
	queries := &atomic.Int32{}
	app := teamIntegrationApp(t, reader, &bytes.Buffer{})
	app.store = NewStore(countingStore{countingPool{Pool: reader.pool.(*pgxpool.Pool), queries: queries}})
	router := app.router()
	get := func(path string) ([]any, int) {
		t.Helper()
		before := queries.Load()
		response := performRequest(router, http.MethodGet, path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		var body []any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body, int(queries.Load() - before)
	}
	const phaseRoute = "/v1/competitions/leagues-cup/2026/matches?range=20260804-20260814"
	routes := map[string]string{
		"mls":    "/v1/competitions/mls/2026/standings",
		"ligaMx": "/v1/competitions/liga-mx/2026-apertura/standings",
	}
	actual := derivedStandingsVector{PhaseRoute: phaseRoute, Membership: map[string]derivedTables{}}
	statements := map[string]int{}
	actual.PhaseMatch, statements["phaseMatches"] = get(phaseRoute)
	for key, route := range routes {
		groups, count := get(route)
		actual.Membership[key] = derivedTables{Route: route, Groups: groups}
		statements[key] = count
	}

	if os.Getenv("SCOREARC_UPDATE_DERIVED_STANDINGS") == "1" {
		var previous derivedStandingsVector
		if data, err := os.ReadFile(derivedStandingsPath); err == nil {
			_ = json.Unmarshal(data, &previous)
		}
		actual.About, actual.Evidence = previous.About, previous.Evidence
		data, err := json.MarshalIndent(actual, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(derivedStandingsPath, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Skip("rewrote " + derivedStandingsPath)
	}
	data, err := os.ReadFile(derivedStandingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var expected derivedStandingsVector
	if err := json.Unmarshal(data, &expected); err != nil {
		t.Fatal(err)
	}
	if len(actual.PhaseMatch) != 54 {
		t.Fatalf("phase window served %d matches, want the 54 recorded", len(actual.PhaseMatch))
	}
	assertWire(t, "phase route", actual.PhaseRoute, expected.PhaseRoute)
	assertWire(t, "phase matches", actual.PhaseMatch, expected.PhaseMatch)
	for key := range routes {
		assertWire(t, key+" membership", wire(t, actual.Membership[key]), wire(t, expected.Membership[key]))
	}
	// Bounded: the body and freshness in one snapshot, one statement per table
	// read -- the same for 54 matches as for one.
	assertWire(t, "statement counts", statements, map[string]int{"phaseMatches": 2, "mls": 2, "ligaMx": 2})
}
