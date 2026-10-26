package main

import (
	"encoding/json"
	"strings"
	"testing"
)

const playerOpenAPIPath = "/v1/competitions/{comp}/{season}/players/{playerId}"

func TestOpenAPIPlayerRoute(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	path := document.Paths.Value(playerOpenAPIPath)
	if path == nil || path.Get == nil {
		t.Fatal("canonical player GET route is undocumented")
	}
	operation := path.Get
	if operation.OperationID != "getPlayer" {
		t.Fatalf("operationId = %q", operation.OperationID)
	}
	parameters := append(path.Parameters, operation.Parameters...)
	if len(parameters) != 3 {
		t.Fatalf("expected only three path parameters, got %d", len(parameters))
	}
	wantParameters := map[string]bool{"comp": true, "season": true, "playerId": true}
	for _, reference := range parameters {
		parameter := reference.Value
		if parameter.In != "path" || !parameter.Required || !wantParameters[parameter.Name] {
			t.Fatalf("unexpected player parameter: %+v", parameter)
		}
		delete(wantParameters, parameter.Name)
		if parameter.Name != "playerId" {
			continue
		}
		canonical := "0194d500-3e48-7000-8000-00000000000a"
		if err := parameter.Schema.Value.VisitJSON(canonical); err != nil {
			t.Fatalf("canonical player UUID rejected: %v", err)
		}
		for _, invalid := range []string{"", "45820", "same-name", strings.ToUpper(canonical), strings.ReplaceAll(canonical, "-", ""), "{" + canonical + "}", "urn:uuid:" + canonical} {
			if err := parameter.Schema.Value.VisitJSON(invalid); err == nil {
				t.Errorf("playerId accepts noncanonical id %q", invalid)
			}
		}
	}
	if len(operation.Responses.Map()) != 6 {
		t.Fatalf("expected 200/400/404/405/429/500 responses, got %v", operation.Responses.Map())
	}
	for _, status := range []int{200, 400, 404, 405, 429, 500} {
		response := operation.Responses.Status(status)
		if response == nil || response.Value == nil {
			t.Fatalf("missing player response %d", status)
		}
		wantSchema, wantCache := "Error", "NoStoreCacheControl"
		if status == 200 {
			wantSchema, wantCache = "PlayerProfile", "StandardCacheControl"
		}
		content := response.Value.Content.Get("application/json")
		if content == nil || content.Schema == nil || content.Schema.Ref != "#/components/schemas/"+wantSchema {
			t.Errorf("response %d must use %s", status, wantSchema)
		}
		header := response.Value.Headers["Cache-Control"]
		if header == nil || header.Ref != "#/components/headers/"+wantCache {
			t.Errorf("response %d must use %s", status, wantCache)
		}
	}
}

func TestOpenAPIPlayerProfileWireValues(t *testing.T) {
	t.Parallel()
	document := loadOpenAPI(t)
	schema := schemaOf(t, document, "PlayerProfile")
	full := wire(t, json.RawMessage(playerOpenAPIJSON)).(map[string]any)
	if err := schema.VisitJSON(full); err != nil {
		t.Fatalf("populated player profile rejected: %v", err)
	}
	empty := wire(t, json.RawMessage(`{"id":"0194d500-3e48-7000-8000-00000000000a","playerSlug":null,"name":"Held Player","age":null,"position":"","jersey":null,"nationality":null,"flagUrl":null,"headshotUrl":null,"team":null,"seasonLabel":"2026","totals":[],"gameLogLabel":"Last 5 Matches","gameLog":[],"career":[]}`))
	if err := schema.VisitJSON(empty); err != nil {
		t.Fatalf("identity with no optional rows rejected: %v", err)
	}
	unknown := wire(t, json.RawMessage(playerOpenAPIJSON)).(map[string]any)
	row := unknown["gameLog"].([]any)[0].(map[string]any)
	for _, key := range []string{"date", "opponent", "homeTeamId", "awayTeamId", "teamId"} {
		row[key] = nil
	}
	row["appearance"], row["score"], row["result"], row["teamAbbr"] = "", "", "", ""
	if err := schema.VisitJSON(unknown); err != nil {
		t.Fatalf("played match with unknown entry status and metadata rejected: %v", err)
	}
	for _, test := range []struct {
		field string
		limit int
	}{
		{"totals", 15},
		{"gameLog", 5},
		{"career", 50},
	} {
		t.Run(test.field+" bounds", func(t *testing.T) {
			value := wire(t, json.RawMessage(playerOpenAPIJSON)).(map[string]any)
			item := value[test.field].([]any)[0]
			rows := make([]any, test.limit)
			for i := range rows {
				rows[i] = item
			}
			value[test.field] = rows
			if err := schema.VisitJSON(value); err != nil {
				t.Fatalf("exact limit rejected: %v", err)
			}
			value[test.field] = append(rows, item)
			if err := schema.VisitJSON(value); err == nil {
				t.Fatal("over-limit array accepted")
			}
			value[test.field] = nil
			if err := schema.VisitJSON(value); err == nil {
				t.Fatal("null array accepted")
			}
		})
	}
}

func TestOpenAPIPlayerProfileRejectsInvalidWireValues(t *testing.T) {
	t.Parallel()
	schema := schemaOf(t, loadOpenAPI(t), "PlayerProfile")
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"provider player id", func(p map[string]any) { p["id"] = "45820" }},
		{"uppercase player id", func(p map[string]any) { p["id"] = strings.ToUpper(p["id"].(string)) }},
		{"guessed slug", func(p map[string]any) { p["playerSlug"] = "held-player" }},
		{"number jersey", func(p map[string]any) { p["jersey"] = float64(10) }},
		{"missing nullable field", func(p map[string]any) { delete(p, "flagUrl") }},
		{"extra profile field", func(p map[string]any) { p["providerId"] = "45820" }},
		{"provider match id", func(p map[string]any) { p["gameLog"].([]any)[0].(map[string]any)["eventId"] = "401773153" }},
		{"unknown appearance", func(p map[string]any) { p["gameLog"].([]any)[0].(map[string]any)["appearance"] = "Bench" }},
		{"null statistics", func(p map[string]any) { p["gameLog"].([]any)[0].(map[string]any)["stats"] = nil }},
		{"invalid kickoff", func(p map[string]any) { p["gameLog"].([]any)[0].(map[string]any)["date"] = "yesterday" }},
		{"unknown venue", func(p map[string]any) { p["gameLog"].([]any)[0].(map[string]any)["atVs"] = "home" }},
		{"unknown result", func(p map[string]any) { p["gameLog"].([]any)[0].(map[string]any)["result"] = "won" }},
		{"fractional total", func(p map[string]any) { p["totals"].([]any)[0].(map[string]any)["value"] = 0.5 }},
		{"missing career identity", func(p map[string]any) { delete(p["career"].([]any)[0].(map[string]any), "teamId") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := wire(t, json.RawMessage(playerOpenAPIJSON)).(map[string]any)
			test.mutate(value)
			if err := schema.VisitJSON(value); err == nil {
				t.Fatal("invalid player response accepted")
			}
		})
	}
}

const playerOpenAPIJSON = `{
  "id":"0194d500-3e48-7000-8000-00000000000a", "playerSlug":null,
  "name":"Held Player", "age":29, "position":"M", "jersey":"10", "nationality":"Mexico",
  "flagUrl":null, "headshotUrl":null,
  "team":{"id":"mex-club","name":"Club","abbr":"CLU","crestUrl":null},
  "seasonLabel":"2026",
  "totals":[{"name":"totalGoals","label":"Goals","display":"0","value":0},{"name":"saves","label":"Saves","display":"—","value":null}],
  "gameLogLabel":"Last 5 Matches",
  "gameLog":[{
    "eventId":"0194d500-3e48-7000-8000-00000000000b", "appearance":"Started",
    "stats":{"appearances":1,"subIns":0,"totalGoals":0,"goalAssists":null,"totalShots":null,"shotsOnTarget":null,"offsides":null,"foulsCommitted":null,"foulsSuffered":null,"yellowCards":0,"redCards":0,"ownGoals":null,"saves":null,"goalsConceded":null,"shotsFaced":null},
    "date":"2026-10-21T20:00:00Z", "atVs":"@", "opponent":{"id":"mex-opponent","name":"Opponent","abbr":"OPP","crestUrl":null},
    "score":"2-1", "result":"L", "homeTeamId":"mex-opponent", "awayTeamId":"mex-club", "teamId":"mex-club", "teamAbbr":"CLU"
  }],
  "career":[{"teamId":"mex-club","teamName":"Club","crestUrl":null,"seasons":"2024–2026"},{"teamId":null,"teamName":"Unresolved Club","crestUrl":null,"seasons":"2022–2023"}]
}`
