package main

import (
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestReaderResourceContractRoutes(t *testing.T) {
	_, raw := loadReaderContract(t)
	routes := vector(t, raw, "resourceFreshness", "routes").(map[string]any)
	document := loadOpenAPI(t)
	dataRoutes := 0
	for path := range document.Paths.Map() {
		if strings.HasPrefix(path, "/v1/") {
			dataRoutes++
			if _, ok := routes[path]; !ok {
				t.Errorf("data route lacks resource contract: %s", path)
			}
		}
	}
	if len(routes) != dataRoutes {
		t.Fatalf("resource routes %d, data routes %d", len(routes), dataRoutes)
	}
	fake := &fakeReaderStore{summary: &MatchSummary{}, boxScore: &BoxScore{}, player: &PlayerProfile{},
		teams: map[string]*TeamProfile{"nat-arg": {}}}
	app := newTestApp(t, fake, &fakeNewsReader{})
	for route, expected := range routes {
		t.Run(route, func(t *testing.T) {
			path := strings.NewReplacer("{comp}", "world-cup", "{season}", "2026", "{teamId}", "nat-arg", "{playerId}", finalMatchID, "{id}", finalMatchID).Replace(route)
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.Header.Set("Origin", "https://scorearc.futbol")
			response := httptest.NewRecorder()
			app.router().ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
			}
			var result resourceEnvelope
			header := response.Header().Get("X-ScoreArc-Resources")
			if err := json.Unmarshal([]byte(header), &result); err != nil {
				t.Fatalf("resource header: %v", err)
			}
			keys := slices.Sorted(maps.Keys(result.Resources))
			assertWire(t, route, wire(t, keys), expected)
			validateSchema(t, document, "ReaderResources", wire(t, result))
			if !strings.Contains(strings.ToLower(response.Header().Get("Access-Control-Expose-Headers")), "x-scorearc-resources") {
				t.Fatal("browser cannot read resource metadata")
			}
		})
	}
}

// Independent literal expectations shared with the future consumer's parser.
func TestReaderResourceContractVectors(t *testing.T) {
	_, raw := loadReaderContract(t)
	encoded, err := json.Marshal(vector(t, raw, "resourceFreshness"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name, Resource, Scope, Derivation string
			Now                               time.Time
			TTLSeconds                        int64
			Dormant                           bool
			Evidence                          *collectionEvidence
			Expected                          resourceEnvelope
		}
	}
	if err := json.Unmarshal(encoded, &vectors); err != nil {
		t.Fatal(err)
	}
	document := loadOpenAPI(t)
	statuses := map[string]bool{}
	for _, c := range vectors.Cases {
		t.Run(c.Name, func(t *testing.T) {
			result := collectionResource(c.Now, c.Evidence, time.Duration(c.TTLSeconds)*time.Second, c.Scope, c.Derivation, c.Dormant)
			envelope := resourceEnvelope{Version: 1, Resources: map[string]resourceMetadata{c.Resource: result}}
			assertWire(t, c.Name, wire(t, envelope), wire(t, c.Expected))
			validateSchema(t, document, "ReaderResources", wire(t, envelope))
			statuses[result.Status] = true
		})
	}
	if len(statuses) != 5 {
		t.Fatalf("shared resource cases cover %v", statuses)
	}
}
