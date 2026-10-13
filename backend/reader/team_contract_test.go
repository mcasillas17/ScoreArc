package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
)

type teamContractVectors struct {
	Scope struct {
		CompetitionID string `json:"competitionId"`
		SeasonID      string `json:"seasonId"`
	} `json:"scope"`
	Identity struct {
		ProviderID  string `json:"providerId"`
		CanonicalID string `json:"canonicalId"`
	} `json:"identity"`
	ReaderMatches []Match     `json:"readerMatches"`
	ReaderTeam    TeamProfile `json:"readerTeam"`
	Errors        []struct {
		Path   string `json:"path"`
		Status int    `json:"status"`
		Error  string `json:"error"`
	} `json:"errors"`
}

func loadTeamContract(t *testing.T) (teamContractVectors, map[string]any) {
	t.Helper()
	data, err := os.ReadFile("../../src/server/data/contracts/team-insights.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors teamContractVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	return vectors, raw
}

func TestTeamContractSerialization(t *testing.T) {
	vectors, raw := loadTeamContract(t)
	document := loadOpenAPI(t)
	data, err := json.Marshal(vectors.ReaderTeam)
	if err != nil {
		t.Fatal(err)
	}
	var actual any
	if err := json.Unmarshal(data, &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, raw["readerTeam"]) {
		t.Fatalf("readerTeam serialization lost or changed vector fields: %s", data)
	}
	schema := document.Components.Schemas["TeamProfile"].Value
	if err := schema.VisitJSON(actual); err != nil {
		t.Fatal(err)
	}
	// The absent standing/scheduleAvailability gap (T10.3-team) is owned by
	// reader_contract_test.go and reader-contract.json.
	for i, match := range vectors.ReaderMatches {
		data, err := json.Marshal(match)
		if err != nil {
			t.Fatal(err)
		}
		var actual map[string]any
		if err := json.Unmarshal(data, &actual); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, raw["readerMatches"].([]any)[i]) {
			t.Fatalf("match serialization mismatch: %s", data)
		}
		schema := document.Components.Schemas["Match"].Value
		if err := schema.VisitJSON(actual); err != nil {
			t.Fatal(err)
		}
		if _, exists := actual["scope"]; exists {
			t.Fatal("reader scope gap changed")
		}
		if _, exists := schema.Properties["scope"]; exists {
			t.Fatal("OpenAPI scope gap changed")
		}
		// Prove the schema rejects a missing required nullable value and a wrong type.
		delete(actual, "homeScore")
		if err := schema.VisitJSON(actual); err == nil {
			t.Fatal("missing homeScore accepted")
		}
		actual["homeScore"] = "3"
		if err := schema.VisitJSON(actual); err == nil {
			t.Fatal("string homeScore accepted")
		}
	}
}

func TestTeamContractHTTPQueriesAndErrors(t *testing.T) {
	vectors, raw := loadTeamContract(t)
	store := &fakeReaderStore{matches: vectors.ReaderMatches, teams: map[string]*TeamProfile{vectors.Identity.CanonicalID: &vectors.ReaderTeam}}
	app := newTestApp(t, store, &fakeNewsReader{})
	router := app.router()
	document := loadOpenAPI(t)
	base := "/v1/competitions/" + vectors.Scope.CompetitionID + "/" + vectors.Scope.SeasonID
	teamResponse := performRequest(router, "GET", base+"/teams/"+vectors.Identity.CanonicalID)
	var actualTeam any
	if err := json.Unmarshal(teamResponse.Body.Bytes(), &actualTeam); err != nil {
		t.Fatal(err)
	}
	if teamResponse.Code != 200 || !reflect.DeepEqual(actualTeam, raw["readerTeam"]) {
		t.Fatalf("team route changed shared wire fields: %d %s", teamResponse.Code, teamResponse.Body.String())
	}
	teamSchema := document.Paths.Value("/v1/competitions/{comp}/{season}/teams/{teamId}").Get.Responses.Status(200).Value.Content.Get("application/json").Schema.Value
	if err := teamSchema.VisitJSON(actualTeam); err != nil {
		t.Fatal(err)
	}
	// Route inventory and match-query parity (T10.1) are owned by
	// reader_contract_test.go, match_query_integration_test.go and
	// reader-contract.json.
	for _, vector := range vectors.Errors {
		response := performRequest(router, "GET", vector.Path)
		var body map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != vector.Status || body["error"] != vector.Error || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("error mismatch: %d %s", response.Code, response.Body.String())
		}
	}
	// Canonical team routes do not translate an ESPN numeric id.
	if response := performRequest(router, "GET", base+"/teams/"+vectors.Identity.ProviderID); response.Code != 404 {
		t.Fatalf("provider id unexpectedly resolved: %d", response.Code)
	}
	store.teamErr = errors.New("database unavailable")
	response := performRequest(router, "GET", base+"/teams/"+vectors.Identity.CanonicalID)
	if response.Code != 500 || response.Body.String() != "{\"error\":\"internal error\"}\n" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("dependency failure must not look empty: %d %s", response.Code, response.Body.String())
	}
	// Registry rejection must happen before any persistence call.
	before := store.calls
	performRequest(router, "GET", vectors.Errors[0].Path)
	if store.calls != before {
		t.Fatal("invalid scope queried storage")
	}
}

// This is a real SQL/reader contract check, not the fake-store HTTP test above.
// Docker is required, as for the existing reader integration tests.
func TestTeamContractStoreIntegration(t *testing.T) {
	vectors, _ := loadTeamContract(t)
	store, pool := newIntegrationStore(t)
	seedLigaTeam(t, pool)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO team (id, kind, name, abbr, crest_url) VALUES ($1,'club',$2,$3,$4)`, vectors.ReaderMatches[0].Away.ID, vectors.ReaderMatches[0].Away.Name, vectors.ReaderMatches[0].Away.Abbr, vectors.ReaderMatches[0].Away.CrestURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range vectors.ReaderMatches {
		_, err := pool.Exec(ctx, `INSERT INTO match (id,competition_id,season_id,kickoff,state,home_team_id,away_team_id,home_score,away_score,winner_id,status_detail,status_name,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'espn')`, match.ID, vectors.Scope.CompetitionID, vectors.Scope.SeasonID, match.Kickoff, match.State, match.Home.ID, match.Away.ID, match.HomeScore, match.AwayScore, match.WinnerID, match.StatusDetail, match.StatusName)
		if err != nil {
			t.Fatal(err)
		}
	}
	// Same kickoff, reverse insertion order: id is the deterministic tie-breaker.
	// Reverse the sides for the second row to respect the match natural key.
	for _, match := range []struct{ id, home, away string }{
		{"018f0000-0000-7000-8000-000000000399", "mex-america", "nat-arg"},
		{"018f0000-0000-7000-8000-000000000398", "nat-arg", "mex-america"},
	} {
		_, err := pool.Exec(ctx, `INSERT INTO match (id,competition_id,season_id,kickoff,state,home_team_id,away_team_id,source) VALUES ($1,'liga-mx','2026-apertura','2026-09-09T00:00:00Z','scheduled',$2,$3,'espn')`, match.id, match.home, match.away)
		if err != nil {
			t.Fatal(err)
		}
	}
	profile, err := store.Team(ctx, vectors.Identity.CanonicalID, vectors.Scope.CompetitionID, vectors.Scope.SeasonID)
	if err != nil {
		t.Fatal(err)
	}
	expectedIDs := []string{vectors.ReaderMatches[0].ID, vectors.ReaderMatches[1].ID, "018f0000-0000-7000-8000-000000000201", "018f0000-0000-7000-8000-000000000202", "018f0000-0000-7000-8000-000000000398", "018f0000-0000-7000-8000-000000000399"}
	var actualIDs []string
	for _, match := range profile.Schedule {
		actualIDs = append(actualIDs, match.ID)
	}
	if !reflect.DeepEqual(actualIDs, expectedIDs) {
		t.Fatalf("scope/order: got %v want %v", actualIDs, expectedIDs)
	}
	for i, expected := range vectors.ReaderMatches {
		actual := profile.Schedule[i]
		// The seed's América crest is NULL. Set identity metadata explicitly from the
		// real team table expectation; do not normalize match scores or state.
		expected.Home.CrestURL = nil
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("stored match %d: got %+v want %+v", i, actual, expected)
		}
	}
}
