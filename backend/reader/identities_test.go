package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const identityBase = "/v1/competitions/world-cup/2026/identities"

func TestIdentityQueryValidation(t *testing.T) {
	ids := make([]string, 100)
	for i := range ids {
		ids[i] = fmt.Sprint(i + 1)
	}
	valid := []string{
		"kind=match&from=espn&ids=401877007,401877008",
		"kind=player&from=canonical&ids=" + testPlayerID,
		"kind=team&from=canonical&ids=nat-arg,prov-espn-9991",
		"kind=team&from=espn&ids=" + strings.Join(ids, ","),
	}
	for _, raw := range valid {
		if _, err := parseIdentityQuery(raw); err != nil {
			t.Errorf("valid query rejected %q: %v", raw, err)
		}
	}
	invalid := []string{
		"", "kind=match&from=espn&ids=", "kind=match&from=espn&ids=401,401",
		"kind=match&from=espn&ids=401&ids=402", "kind=match&from=espn&ids=401&url=https://example.com",
		"kind=match&from=espn&ids=" + finalMatchID, "kind=player&from=canonical&ids=297287",
		"kind=match&from=canonical&ids=" + strings.ToUpper(finalMatchID),
		"kind=team&from=canonical&ids=nat-arg%27%3BSELECT+1", "kind=team&from=canonical&ids=%ZZ",
		"kind=team&from=canonical&ids=" + strings.Repeat("x", 129),
		"kind=team&from=espn&ids=" + strings.Repeat("1", 33), "kind=team&from=espn&ids=0",
		"kind=match&from=provider&ids=401", "kind=person&from=espn&ids=401",
		"kind=team&from=espn&ids=" + strings.Join(append(ids, "101"), ","),
	}
	for _, raw := range invalid {
		if _, err := parseIdentityQuery(raw); err == nil {
			t.Errorf("invalid query accepted %q", raw)
		}
	}
}

func TestIdentityRouteValidationMetadataAndErrors(t *testing.T) {
	id, provider, comp, season, home, away := finalMatchID, "401877007", "world-cup", "2026", "nat-arg", "nat-fra"
	refs := []IdentityReference{
		{ID: provider, Status: "resolved", CanonicalID: &id, ProviderID: &provider, CompetitionID: &comp, SeasonID: &season, HomeID: &home, AwayID: &away},
		{ID: "999", Status: "missing"},
	}
	store := &fakeReaderStore{identities: refs}
	app := newTestApp(t, store, &fakeNewsReader{})
	router := app.router()
	for _, path := range []string{
		"/v1/competitions/no-such-competition/2026/identities?kind=match&from=espn&ids=401",
		identityBase, identityBase + "?kind=match&from=espn&ids=401&ids=402",
	} {
		response := performRequest(router, http.MethodGet, path)
		if response.Code != 400 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid request: %d %s", response.Code, response.Body.String())
		}
	}
	if store.calls != 0 {
		t.Fatalf("invalid queries made %d reads", store.calls)
	}
	response := performRequest(router, http.MethodGet, identityBase+"?kind=match&from=espn&ids=401877007,999")
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response: %d %s", response.Code, response.Body.String())
	}
	var actual []IdentityReference
	if err := json.Unmarshal(response.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, refs) {
		t.Fatalf("identity changed: %+v", actual)
	}
	var wireRefs []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &wireRefs); err != nil {
		t.Fatal(err)
	}
	for _, ref := range wireRefs {
		if len(ref) != 8 {
			t.Fatalf("missing null fields: %v", ref)
		}
		validateSchema(t, loadOpenAPI(t), "IdentityReference", ref)
	}
	metadata := resourceHeader(t, response.Header()).Resources["identity"]
	if metadata.Status != "unavailable" || metadata.Availability != "partial" || metadata.Scope != "selection" || metadata.Source != "mixed" || metadata.ObservedAt != nil || metadata.FinalizedAt != nil {
		t.Fatalf("invented identity observation: %+v", metadata)
	}
	store.identitiesErr = errors.New("postgres://secret:password@host SELECT private_identity")
	response = performRequest(router, http.MethodGet, identityBase+"?kind=match&from=espn&ids=401")
	if response.Code != 500 || response.Body.String() != "{\"error\":\"internal error\"}\n" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get(resourcesHeader) != "" {
		t.Fatalf("unsanitized failure: %d %s", response.Code, response.Body.String())
	}
}

func TestIdentitySnapshotClosedBeforeEveryResponse(t *testing.T) {
	for _, err := range []error{nil, errors.New("dependency unavailable")} {
		fake := &fakeReaderStore{identities: []IdentityReference{}, identitiesErr: err}
		store := &trackingSnapshotStore{fakeReaderStore: fake}
		app := newTestApp(t, fake, &fakeNewsReader{})
		app.store = store
		responseAfterSnapshotClosed(t, app.router(), identityBase+"?kind=match&from=espn&ids=401", store)
		if store.begins != 1 || store.closes != 1 || !store.deadline {
			t.Fatalf("snapshot lifecycle: %+v", store)
		}
	}
}
