package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestIdentityReferencesPersistedCrosswalks(t *testing.T) {
	reader, owner := newIntegrationStore(t)
	ctx := context.Background()
	writer, err := writerstore.New(ctx, owner.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	canonical := espnToCanonical(t)["202"]
	if canonical != "nat-arg" {
		t.Fatal("recorded production team crosswalk changed")
	}
	exec(`INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','202',$1),('other','202','nat-fra'),('espn','9991','prov-espn-9991')`, canonical)
	player, err := writer.Player(ctx, "espn", writerstore.PlayerRef{SourceID: "297287", FullName: "Ali Avila"})
	if err != nil {
		t.Fatal(err)
	}
	otherPlayer, err := writer.Player(ctx, "other", writerstore.PlayerRef{SourceID: "297287", FullName: "Ali Avila"})
	if err != nil {
		t.Fatal(err)
	}
	if player == otherPlayer {
		t.Fatal("cross-source identity merged by name")
	}
	kickoff, _ := time.Parse(time.RFC3339, "2026-07-19T19:00:00Z")
	match, err := writer.Match(ctx, "espn", writerstore.MatchRef{SourceID: "401877007", CompetitionID: "world-cup", SeasonID: "2026", HomeTeamID: "nat-arg", AwayTeamID: "nat-fra", Kickoff: kickoff})
	if err != nil {
		t.Fatal(err)
	}
	if match.String() != finalMatchID {
		t.Fatal("resolver failed to adopt existing natural key")
	}
	exec(`INSERT INTO match_external_ref(source,source_id,match_id) VALUES ('other','401877007',$1),('espn','401877008',$1)`, otherCompMatch)
	queries := &atomic.Int32{}
	counted := NewStore(countingPool{Pool: reader.pool.(*pgxpool.Pool), queries: queries})
	router := teamIntegrationApp(t, counted, &bytes.Buffer{}).router()
	get := func(kind, from string, ids ...string) []IdentityReference {
		t.Helper()
		params := url.Values{"kind": {kind}, "from": {from}, "ids": {strings.Join(ids, ",")}}
		before := queries.Load()
		response := performRequest(router, http.MethodGet, identityBase+"?"+params.Encode())
		if response.Code != 200 {
			t.Fatalf("lookup failed: %d %s", response.Code, response.Body.String())
		}
		if queries.Load()-before != 1 {
			t.Fatalf("lookup used %d statements", queries.Load()-before)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("cached crosswalk: %s", response.Header().Get("Cache-Control"))
		}
		var refs []IdentityReference
		if err := json.Unmarshal(response.Body.Bytes(), &refs); err != nil {
			t.Fatal(err)
		}
		if len(refs) != len(ids) {
			t.Fatalf("length: %v", refs)
		}
		for i, ref := range refs {
			if ref.ID != ids[i] {
				t.Fatalf("input order changed: %+v", refs)
			}
		}
		for _, ref := range refs {
			validateSchema(t, loadOpenAPI(t), "IdentityReference", wire(t, ref))
		}
		return refs
	}
	assertResolved := func(ref IdentityReference, provider, canonical string) {
		t.Helper()
		if ref.Status != "resolved" || ref.CanonicalID == nil || *ref.CanonicalID != canonical || ref.ProviderID == nil || *ref.ProviderID != provider {
			t.Fatalf("wrong resolution: %+v", ref)
		}
	}
	assertUnresolved := func(ref IdentityReference, status string) {
		t.Helper()
		if !reflect.DeepEqual(ref, IdentityReference{ID: ref.ID, Status: status}) {
			t.Fatalf("unresolved reference leaked or invented identity: %+v", ref)
		}
	}
	for _, from := range []string{"canonical", "espn"} {
		teamID, playerID, matchID := "nat-arg", player.String(), finalMatchID
		if from == "espn" {
			teamID, playerID, matchID = "202", "297287", "401877007"
		}
		refs := get("team", from, teamID)
		assertResolved(refs[0], "202", "nat-arg")
		if refs[0].CompetitionID != nil || refs[0].HomeID != nil {
			t.Fatal("team acquired invented match scope")
		}
		assertResolved(get("player", from, playerID)[0], "297287", player.String())
		m := get("match", from, matchID)[0]
		assertResolved(m, "401877007", finalMatchID)
		if m.CompetitionID == nil || *m.CompetitionID != "world-cup" || m.SeasonID == nil || *m.SeasonID != "2026" || m.HomeID == nil || *m.HomeID != "nat-arg" || m.AwayID == nil || *m.AwayID != "nat-fra" {
			t.Fatalf("wrong match scope/sides: %+v", m)
		}
	}
	assertResolved(get("team", "canonical", "prov-espn-9991")[0], "9991", "prov-espn-9991")
	assertUnresolved(get("team", "canonical", "eng-crestless")[0], "missing")
	assertUnresolved(get("player", "canonical", otherPlayer.String())[0], "missing")
	assertUnresolved(get("match", "canonical", otherCompMatch)[0], "missing")
	assertUnresolved(get("match", "espn", "401877008")[0], "missing")
	assertUnresolved(get("match", "espn", "999999999")[0], "missing")
	// A later alias makes both representations ambiguous; never choose the first.
	exec(`INSERT INTO match_external_ref(source,source_id,match_id) VALUES ('espn','401877009',$1)`, finalMatchID)
	exec(`INSERT INTO player_external_ref(source,source_id,player_id) VALUES ('espn','297288',$1)`, player)
	exec(`INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','203','nat-arg')`)
	for _, tc := range []struct{ kind, provider, canonical string }{{"match", "401877007", finalMatchID}, {"player", "297287", player.String()}, {"team", "202", "nat-arg"}} {
		assertUnresolved(get(tc.kind, "espn", tc.provider)[0], "ambiguous")
		assertUnresolved(get(tc.kind, "canonical", tc.canonical)[0], "ambiguous")
	}
	ids := make([]string, 100)
	for i := range ids {
		ids[i] = fmt.Sprint(900000000 + i)
	}
	for _, ref := range get("match", "espn", ids...) {
		assertUnresolved(ref, "missing")
	}
	// The endpoint uses the SELECT-only login, not owner credentials.
	var user string
	if err := reader.db.QueryRow(ctx, "SELECT current_user").Scan(&user); err != nil || user != "scorearc_reader_test" {
		t.Fatalf("reader login=%s err=%v", user, err)
	}
	if _, err := reader.pool.(*pgxpool.Pool).Exec(ctx, `INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','999999','nat-arg')`); err == nil {
		t.Fatal("reader unexpectedly wrote an identity")
	}
}

func TestEditionEligibilityHiddenIdentities(t *testing.T) {
	reader, db := newIntegrationStore(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO team(id,kind,name,abbr) VALUES('hidden-team','club','Hidden','HID')`,
		`UPDATE match SET home_team_id='hidden-team' WHERE id='` + otherCompMatch + `'`,
		`INSERT INTO player(id,full_name) VALUES('` + testPlayerID + `','Hidden Player')`,
		`INSERT INTO squad_membership(competition_id,season_id,team_id,player_id,source) VALUES('premier-league','2026-27','hidden-team','` + testPlayerID + `','espn')`,
		`INSERT INTO player_external_ref(source,source_id,player_id) VALUES('espn','555','` + testPlayerID + `')`,
		`INSERT INTO team_external_ref(source,source_id,team_id) VALUES('espn','888','hidden-team')`,
		`INSERT INTO team(id,kind,name,abbr) VALUES('leader-only','club','Leader club','LEA')`,
		`INSERT INTO team_external_ref(source,source_id,team_id) VALUES('espn','777','leader-only')`,
		`INSERT INTO top_scorer(competition_id,season_id,category,rank,player,goals,matches,team_abbr,source,team_source_id) VALUES('premier-league','2026-27','goals',1,'Leading player',3,1,'LEA','espn','777')`,
	} {
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	app := teamIntegrationApp(t, reader, &bytes.Buffer{})
	comp, _ := app.registry.Get("premier-league")
	s := comp.Seasons["2026-27"]
	s.Publication = "candidate"
	comp.Seasons["2026-27"] = s
	router := app.router()
	for _, path := range []string{"teams/hidden-team", "teams/hidden-team/squad", "teams/leader-only", "teams/leader-only/squad", "players/" + testPlayerID} {
		r := performRequest(router, "GET", "/v1/competitions/world-cup/2026/"+path)
		if r.Code != 404 {
			t.Fatalf("%s: %d %s", path, r.Code, r.Body.String())
		}
	}
	for _, query := range []string{"kind=team&from=espn&ids=888", "kind=team&from=espn&ids=777", "kind=player&from=espn&ids=555"} {
		r := performRequest(router, "GET", identityBase+"?"+query)
		if r.Code != 200 || !strings.Contains(r.Body.String(), `"status":"missing"`) {
			t.Fatalf("%s: %d %s", query, r.Code, r.Body.String())
		}
	}
}

func TestEditionEligibilityScoreParticipantAddressing(t *testing.T) {
	reader, db := newIntegrationStore(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO team(id,kind,name,abbr) VALUES ('outside','club','Outside','OUT')`,
		`UPDATE match SET away_team_id='outside' WHERE id='` + otherCompMatch + `'`,
		`INSERT INTO team_external_ref(source,source_id,team_id) VALUES ('espn','9991','prov-espn-9991'),('espn','888','outside')`,
	} {
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	app := teamIntegrationApp(t, reader, &bytes.Buffer{})
	comp, _ := app.registry.Get("world-cup")
	s := comp.Seasons["2026"]
	s.Resources = []string{"scores"}
	comp.Seasons["2026"] = s
	router := app.router()
	for _, q := range []string{"from=canonical&ids=prov-espn-9991,outside", "from=espn&ids=9991,888"} {
		r := performRequest(router, "GET", identityBase+"?kind=team&"+q)
		var refs []IdentityReference
		if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &refs) != nil || len(refs) != 2 || refs[0].Status != "resolved" || refs[0].CanonicalID == nil || *refs[0].CanonicalID != "prov-espn-9991" || refs[1].Status != "missing" {
			t.Fatalf("%s: %d %s", q, r.Code, r.Body.String())
		}
	}
	r := performRequest(router, "GET", "/v1/competitions/world-cup/2026/teams/prov-espn-9991")
	if r.Code != 404 {
		t.Fatalf("unsupported team profile: %d", r.Code)
	}
}

func TestEditionEligibilityJoinedSummaryFields(t *testing.T) {
	reader, db := newIntegrationStore(t)
	if _, err := db.Exec(context.Background(), `UPDATE match_detail SET info=info||'{"referee":"Masked official"}' WHERE match_id=$1`, finalMatchID); err != nil {
		t.Fatal(err)
	}
	// France is the identified away side. The seed deliberately marks its opponent as a placeholder.
	if _, err := db.Exec(context.Background(), `INSERT INTO match_sync_status(match_id,source,observed_at) VALUES ($1,'espn',now())`, finalMatchID); err != nil {
		t.Fatal(err)
	}
	app := teamIntegrationApp(t, reader, &bytes.Buffer{})
	comp, _ := app.registry.Get("world-cup")
	s := comp.Seasons["2026"]
	s.Resources = []string{"scores", "summary", "teams"}
	comp.Seasons["2026"] = s
	for _, path := range []string{"/v1/matches/" + finalMatchID, "/v1/competitions/world-cup/2026/matches?scope=season&detail=summary", "/v1/competitions/world-cup/2026/teams/nat-fra"} {
		r := performRequest(app.router(), "GET", path)
		body := r.Body.String()
		if r.Code != 200 || strings.Contains(body, "Masked official") || strings.Contains(body, `"winProbability":{`) || !strings.Contains(body, "Lionel Messi") {
			t.Errorf("%s: code %d leaks official=%v odds=%v kept scorer=%v", path, r.Code, strings.Contains(body, "Masked official"), strings.Contains(body, `"winProbability":{`), strings.Contains(body, "Lionel Messi"))
		}
	}
}
