package feeddrift

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestReviewedESPNShapes(t *testing.T) {
	for endpoint, file := range map[string]string{"roster": "espn-team-roster", "bio": "espn-athlete-bio"} {
		raw, err := os.ReadFile("../espn/testdata/" + file + ".json")
		if err != nil {
			t.Fatal(err)
		}
		if findings := Inspect(endpoint, raw); len(findings) != 0 {
			t.Errorf("recorded %s: %+v", endpoint, findings)
		}
	}
}

func TestNormalAlternates(t *testing.T) {
	for _, tc := range []struct{ endpoint, raw string }{
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":92800},"athletes":[{"id":7,"displayName":"New player","statistics":null},{"id":"98","fullName":"Another","statistics":{"splits":{"categories":[{"stats":[{"name":"totalGoals","value":null}],"count":1}],"pagination":{"hasMore":false}}}}],"status":"success","total":2}`},
		{"bio", `{"teamHistory":[{"id":445566,"seasons":"2021-2025","displayName":"New team"}]}`},
		{"bio", `{"code":0,"teamHistory":[],"pagination":{"total":0}}`},
		{"bio", `{"code":404,"message":"No biography","teamHistory":null}`},
		{"bio", `{"code":404}`},
		{"roster", `{"season":{"year":2026,"type":{"name":"Apertura","slug":"apertura"}},"league":{"id":3},"team":{"id":1},"status":"success","athletes":[]}`},
	} {
		if findings := Inspect(tc.endpoint, []byte(tc.raw)); len(findings) != 0 {
			t.Errorf("%s: %+v", tc.raw, findings)
		}
	}
}

func TestRequiredChanges(t *testing.T) {
	for _, tc := range []struct{ endpoint, raw, kind, path string }{
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"status":"pending","team":{"id":"1"},"athletes":[]}`, "unknown_status", "$.status"},
		{"bio", `{"code":503,"teamHistory":[]}`, "unknown_status", "$.code"},
		{"bio", `{"code":null,"teamHistory":[]}`, "type_changed", "$.code"},
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"status":"success","athletes":[]}`, "required_missing", "$.team"},
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"team":{},"status":"success","athletes":[]}`, "required_missing", "$.team.id"},
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":true},"status":"success","athletes":[]}`, "type_changed", "$.team.id"},
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"status":"success","athletes":{}}`, "type_changed", "$.athletes"},
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"status":"success","athletes":[{"id":1}]}`, "required_missing", "$.athletes[].fullName"},
		{"roster", `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"status":"success","athletes":[{"id":1,"displayName":"A","statistics":{}}]}`, "required_missing", "$.athletes[].statistics.splits"},
		{"roster", `{"season":{"year":2026},"team":{"id":1},"status":"success","athletes":[]}`, "required_missing", "$.season.displayName"},
		{"roster", `{"season":{"displayName":"League"},"team":{"id":1},"status":"success","athletes":[]}`, "required_missing", "$.season.year"},
		{"bio", `{}`, "required_missing", "$.teamHistory"},
		{"bio", `{"teamHistory":{"id":2}}`, "type_changed", "$.teamHistory"},
		{"bio", `{"teamHistory":[{"id":1,"displayName":"Club","seasons":[]}]}`, "type_changed", "$.teamHistory[].seasons"},
		{"bio", `{"teamHistory":[{"id":1,"displayName":"Club"}]}`, "required_missing", "$.teamHistory[].seasons"},
	} {
		f := Inspect(tc.endpoint, []byte(tc.raw))
		if len(f) != 1 || f[0].Kind != tc.kind || f[0].Path != tc.path {
			t.Errorf("%s: %+v, want %s %s", tc.raw, f, tc.kind, tc.path)
		}
	}
}

func TestNewStatsRetainFirstMeasurement(t *testing.T) {
	const raw = `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"athletes":[{"id":1,"fullName":"A","statistics":{"splits":{"categories":[{"stats":[{"name":"expectedGoals","value":1.25,"displayValue":"1.25"},{"name":"expectedGoals","value":9.75},{"name":"expectedShots","value":{"home":2}}]}]}}}],"status":"success"}`
	f := Inspect("roster", []byte(raw))
	if len(f) != 2 || f[0].Kind != "new_stat" || f[0].Detail != "expectedGoals" || f[1].Detail != "expectedShots" || f[0].Path != "$.athletes[].statistics.splits.categories[].stats[].name" {
		t.Fatalf("stat signatures: %+v", f)
	}
	var stat struct {
		Name         string
		Value        float64
		DisplayValue string
	}
	if err := json.Unmarshal(f[0].Example, &stat); err != nil || stat.Name != f[0].Detail || stat.Value != 1.25 || stat.DisplayValue != "1.25" {
		t.Fatalf("stat example %s, decode error: %v", f[0].Example, err)
	}
}

func TestNewFieldsAreNormalizedAndBounded(t *testing.T) {
	large := strings.Repeat("★\x00", 4000)
	long, _ := json.Marshal(large)
	raw := fmt.Sprintf(`{"teamHistory":[{"id":"1","seasons":"2000","displayName":"Club","newAttribute":{"metric":4,"accessToken":"do-not-store","text":%s,"27845":"x"}},{"id":"2","seasons":"2001","displayName":"Other","newAttribute":42}],"27845":1,"a/b":true}`, long)
	f := Inspect("bio", []byte(raw))
	if len(f) != 2 || f[0].Kind != "new_field" || f[0].Path != "$.teamHistory[].newAttribute" {
		t.Fatalf("unbounded path or incorrect addition: %+v", f)
	}
	for _, finding := range f {
		s := string(finding.Example)
		if !json.Valid(finding.Example) || len(s) > 1024 || strings.Contains(s, "do-not-store") || strings.Contains(s, `\u0000`) || strings.Contains(s, "27845") || strings.Contains(s, "teamHistory") {
			t.Errorf("unsafe example: %s", s)
		}
	}
	if !strings.Contains(string(f[0].Example), `"metric":4`) {
		t.Errorf("lost representative object: %s", f[0].Example)
	}
}

func TestBreakingChangeSurvivesFloodOfAdditions(t *testing.T) {
	obj := map[string]any{"teamHistory": []any{map[string]any{"id": "1", "displayName": "A"}}}
	for i := 0; i < 300; i++ {
		obj[fmt.Sprintf("field%d", i)] = i
	}
	raw, err := json.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	f := Inspect("bio", raw)
	if len(f) > 32 || len(f) == 0 || f[0].Kind != "required_missing" || f[0].Path != "$.teamHistory[].seasons" {
		t.Fatalf("missing contract failure or uncapped findings: %+v", f)
	}
}

func TestVerboseMeasurementStillReplays(t *testing.T) {
	verbose := strings.Repeat("<", 1000)
	stat := map[string]any{"name": "expectedGoals", "value": 1.25, "abbreviation": verbose, "displayName": verbose, "shortDisplayName": verbose, "displayValue": verbose}
	statJSON, err := json.Marshal(stat)
	if err != nil {
		t.Fatal(err)
	}
	raw := `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"athletes":[{"id":1,"fullName":"A","statistics":{"splits":{"categories":[{"stats":[` + string(statJSON) + `]}]}}}],"status":"success"}`
	f := Inspect("roster", []byte(raw))
	if len(f) != 1 {
		t.Fatalf("findings = %+v", f)
	}
	var sample struct {
		Name  string
		Value float64
	}
	if err := json.Unmarshal(f[0].Example, &sample); err != nil || len(f[0].Example) > MaxExampleBytes || sample.Name != "expectedGoals" || sample.Value != 1.25 {
		t.Fatalf("lost measurement in oversized row: %s", f[0].Example)
	}
}

func TestDiagnosticBudgetAndRootSamples(t *testing.T) {
	for _, raw := range []string{"{incomplete", `{"code":404} {}`, strings.Repeat(" ", maxBodyBytes) + `{}`} {
		if f := Inspect("bio", []byte(raw)); len(f) != 0 {
			t.Fatalf("unexpected sample: %+v", f)
		}
	}
	f := Inspect("bio", []byte(`"entire raw provider response"`))
	if len(f) != 1 || f[0].Kind != "type_changed" || strings.Contains(string(f[0].Example), "raw provider") {
		t.Fatalf("whole response in sample: %+v", f)
	}
}

func TestMissingMeasurementKeepsName(t *testing.T) {
	const raw = `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"athletes":[{"id":1,"fullName":"A","statistics":{"splits":{"categories":[{"stats":[{"name":"totalGoals","privateMessage":"unrelated"}]}]}}}],"status":"success"}`
	f := Inspect("roster", []byte(raw))
	if len(f) == 0 || f[0].Kind != "required_missing" || string(f[0].Example) != `{"name":"totalGoals"}` {
		t.Fatalf("expected projected evidence for the missing value: %+v", f)
	}
}

func TestNewProviderReferencesRetainSanitizedURL(t *testing.T) {
	const raw = `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"athletes":[{"id":1,"fullName":"A","headshot":{"$ref":"https://user:password@example.org/headshot?signature=private#secret","$17":1},"newMedia":{"$ref":"/media?id=7","$dynamic":"hidden","481":"hidden"}}],"status":"success"}`
	f := Inspect("roster", []byte(raw))
	if len(f) != 2 || f[0].Path != "$.athletes[].headshot.$ref" || f[0].Kind != "new_field" || string(f[0].Example) != `{"$ref":"https://example.org/headshot"}` {
		t.Fatalf("missing or unsafe reference finding: %+v", f)
	}
	if f[1].Path != "$.athletes[].newMedia" || string(f[1].Example) != `{"newMedia":{"$ref":"/media"}}` {
		t.Fatalf("unexpected keys or query in nested reference: %s", f[1].Example)
	}
}

func TestSensitiveMeasurementValuesAreRedacted(t *testing.T) {
	const raw = `{"season":{"year":2026,"displayName":"2026 League"},"team":{"id":"1"},"athletes":[{"id":1,"fullName":"A","statistics":{"splits":{"categories":[{"stats":[{"name":"accessToken","value":"sensitive-example","displayValue":{"text":"sensitive-example"}}]}]}}}],"status":"success"}`
	f := Inspect("roster", []byte(raw))
	if len(f) != 2 || f[0].Kind != "type_changed" || f[1].Kind != "new_stat" || f[1].Detail != "accessToken" {
		t.Fatalf("lost structural findings: %+v", f)
	}
	for _, finding := range f {
		if strings.Contains(string(finding.Example), "sensitive-example") {
			t.Fatalf("sensitive sample at %s", finding.Path)
		}
	}
	if string(f[1].Example) != `{"displayValue":"[redacted]","name":"accessToken","value":"[redacted]"}` {
		t.Errorf("unexpected sensitive measurement shape: %s", f[1].Example)
	}
}
