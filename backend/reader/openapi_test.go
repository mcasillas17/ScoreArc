package main

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func loadOpenAPI(t *testing.T) *openapi3.T {
	t.Helper()
	document, err := openapi3.NewLoader().LoadFromFile("openapi.yaml")
	if err != nil {
		t.Fatalf("load openapi.yaml: %v", err)
	}
	if err := document.Validate(context.Background()); err != nil {
		t.Fatalf("validate openapi.yaml: %v", err)
	}
	return document
}

func TestOpenAPIObjectSchemasAreExact(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	for name, reference := range document.Components.Schemas {
		schema := reference.Value
		if schema == nil || !schema.Type.Includes("object") {
			continue
		}
		properties := make([]string, 0, len(schema.Properties))
		for property := range schema.Properties {
			properties = append(properties, property)
		}
		sort.Strings(properties)
		required := append([]string(nil), schema.Required...)
		sort.Strings(required)
		if !reflect.DeepEqual(required, properties) {
			t.Errorf("schema %s required=%v, properties=%v", name, required, properties)
		}
		if schema.AdditionalProperties.Has == nil || *schema.AdditionalProperties.Has {
			t.Errorf("schema %s must set additionalProperties: false", name)
		}
	}
}

func TestOpenAPIValidatesPublicResponseModels(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	kickoff := "2026-07-19T19:00:00Z"
	crest := "https://cdn.scorearc.futbol/team.png"
	team := espn.Team{ID: "arg", Name: "Argentina", Abbr: "ARG", CrestURL: &crest}

	tests := []struct {
		schema string
		value  any
	}{
		{schema: "Match", value: Match{ID: "1", Kickoff: kickoff, State: espn.MatchStateScheduled, Home: team, Away: team, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		{schema: "Group", value: Group{ID: "A", Name: "Group A", Standings: []Standing{{Team: team, Rank: 1}}}},
		{
			schema: "BracketRound",
			value: BracketRound{
				Slug: "final",
				Name: "Final",
				Matches: []espn.BracketMatch{
					{
						ID:      "1",
						Round:   "final",
						Kickoff: kickoff,
						State:   espn.MatchStateScheduled,
						Home:    espn.BracketTeam{ID: "arg", Name: "Argentina", Abbr: "ARG", CrestURL: &crest},
						Away:    espn.BracketTeam{ID: "fra", Name: "France", Abbr: "FRA", CrestURL: &crest},
					},
				},
			},
		},
		{schema: "TopScorer", value: espn.TopScorer{Rank: 1, Player: "Player", TeamAbbr: "ARG", TeamName: "Argentina", Goals: 7}},
		{schema: "NewsArticle", value: espn.NewsArticle{ID: "1", Headline: "Headline", Published: kickoff, URL: "https://example.com/article"}},
		{schema: "MatchSummary", value: MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{{Date: "", Label: "Unknown date"}}}},
	}

	for _, tt := range tests {
		t.Run(tt.schema, func(t *testing.T) {
			data, err := json.Marshal(tt.value)
			if err != nil {
				t.Fatal(err)
			}
			var value any
			if err := json.Unmarshal(data, &value); err != nil {
				t.Fatal(err)
			}
			schema := document.Components.Schemas[tt.schema]
			if schema == nil || schema.Value == nil {
				t.Fatalf("missing schema %s", tt.schema)
			}
			if err := schema.Value.VisitJSON(value); err != nil {
				t.Fatalf("%s response violates OpenAPI: %v\nJSON: %s", tt.schema, err, data)
			}
		})
	}
}

func TestOpenAPIValidatesActualRouteResponses(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	store := &fakeReaderStore{
		matches:   []Match{{ID: "1", Kickoff: "2026-07-19T19:00:00Z", State: espn.MatchStateScheduled, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		standings: []Group{{ID: "A", Name: "Group A", Standings: []Standing{{Team: espn.Team{ID: "arg", Name: "Argentina", Abbr: "ARG"}, Rank: 1}}}},
		bracket: []BracketRound{{Slug: "final", Name: "Final", Matches: []espn.BracketMatch{{
			ID: "2", Round: "final", Kickoff: "2026-07-19T19:00:00Z", State: espn.MatchStateScheduled,
			Home: espn.BracketTeam{ID: "arg", Name: "Argentina", Abbr: "ARG"}, Away: espn.BracketTeam{ID: "fra", Name: "France", Abbr: "FRA"},
		}}}},
		summary:    &MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{}},
		topScorers: []espn.TopScorer{{Rank: 1, Player: "Player", TeamAbbr: "ARG", TeamName: "Argentina", Goals: 7}},
	}
	router := newTestApp(t, store, &fakeNewsReader{articles: []espn.NewsArticle{{ID: "1", Headline: "Headline", URL: "https://example.com/article"}}}).router()
	tests := []struct {
		target   string
		template string
	}{
		{target: "/v1/competitions/world-cup/2026/matches", template: "/v1/competitions/{comp}/{season}/matches"},
		{target: "/v1/competitions/world-cup/2026/standings", template: "/v1/competitions/{comp}/{season}/standings"},
		{target: "/v1/competitions/world-cup/2026/bracket", template: "/v1/competitions/{comp}/{season}/bracket"},
		{target: "/v1/competitions/world-cup/2026/top-scorers", template: "/v1/competitions/{comp}/{season}/top-scorers"},
		{target: "/v1/competitions/world-cup/news", template: "/v1/competitions/{comp}/news"},
		{target: "/v1/matches/1", template: "/v1/matches/{id}"},
	}
	for _, tt := range tests {
		t.Run(tt.template, func(t *testing.T) {
			response := performRequest(router, "GET", tt.target)
			if response.Code != 200 {
				t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
			}
			var value any
			if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
				t.Fatal(err)
			}
			schema := document.Paths.Value(tt.template).Get.Responses.Status(200).Value.Content.Get("application/json").Schema
			if err := schema.Value.VisitJSON(value); err != nil {
				t.Fatalf("actual route response violates OpenAPI: %v\nJSON: %s", err, response.Body.String())
			}
		})
	}
}

func TestOpenAPIValidatesNewsMapperOutput(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	articles, err := espn.MapNews([]byte(`{"articles":[{"headline":"Headline","links":{"web":{"href":"https://example.com/article"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(articles[0])
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if err := document.Components.Schemas["NewsArticle"].Value.VisitJSON(value); err != nil {
		t.Fatalf("mapped news violates OpenAPI: %v\nJSON: %s", err, data)
	}
}

func TestOpenAPIDocumentsOperationalResponses(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	for path, item := range document.Paths.Map() {
		if item.Get == nil {
			continue
		}
		if item.Get.Responses.Status(httpStatusOK) == nil {
			t.Errorf("GET %s missing 200 response", path)
		}
		if item.Get.Responses.Status(httpStatusInternalServerError) == nil {
			t.Errorf("GET %s missing 500 response", path)
		}
		if item.Get.Responses.Status(httpStatusMethodNotAllowed) == nil {
			t.Errorf("GET %s missing 405 response", path)
		}
		if path == "/healthz" {
			if item.Get.Responses.Status(httpStatusServiceUnavailable) == nil {
				t.Errorf("GET %s missing 503 response", path)
			}
			for status, response := range item.Get.Responses.Map() {
				if response.Value.Headers["Cache-Control"] == nil {
					t.Errorf("GET %s response %s missing Cache-Control response header", path, status)
				}
			}
			continue
		}
		if item.Get.Responses.Status(httpStatusTooManyRequests) == nil {
			t.Errorf("GET %s missing 429 response", path)
		}
		response := item.Get.Responses.Status(httpStatusOK)
		if response.Value.Headers["Cache-Control"] == nil {
			t.Errorf("GET %s missing Cache-Control response header", path)
		}
		for status, response := range item.Get.Responses.Map() {
			if status != "200" && response.Value.Headers["Cache-Control"] == nil {
				t.Errorf("GET %s response %s missing Cache-Control response header", path, status)
			}
		}
	}
}

const (
	httpStatusOK                  = 200
	httpStatusInternalServerError = 500
	httpStatusMethodNotAllowed    = 405
	httpStatusTooManyRequests     = 429
	httpStatusServiceUnavailable  = 503
)
