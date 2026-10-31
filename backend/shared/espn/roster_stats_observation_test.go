package espn

import "testing"

func TestRosterStatisticsRequireValidatedCollections(t *testing.T) {
	for name, statistics := range map[string]string{
		"missing splits":            `{}`,
		"null splits":               `{"splits":null}`,
		"missing categories":        `{"splits":{}}`,
		"null categories":           `{"splits":{"categories":null}}`,
		"missing stats":             `{"splits":{"categories":[{"name":"general"}]}}`,
		"null stats":                `{"splits":{"categories":[{"name":"general","stats":null}]}}`,
		"statistics pagination":     `{"pagination":{"hasMore":true},"splits":{"categories":[]}}`,
		"categories pagination":     `{"splits":{"categories":[],"pagination":{"pageCount":2}}}`,
		"stats pagination":          `{"splits":{"categories":[{"name":"general","stats":[],"pagination":{"total":1}}]}}`,
		"malformed count":           `{"splits":{"categories":[],"count":"zero"}}`,
		"missing measurement value": `{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances"}]}]}}`,
		"missing measurement name":  `{"splits":{"categories":[{"name":"general","stats":[{"value":1}]}]}}`,
		"fractional measurement":    `{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances","value":1.5}]}]}}`,
		"malformed measurement":     `{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances","value":"one"}]}]}}`,
		"duplicate measurement":     `{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances","value":1},{"name":"appearances","value":2}]}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			raw := []byte(`{"status":"success","team":{"id":"227"},"athletes":[{"id":"p1","fullName":"Measured Player","statistics":` + statistics + `}]}`)
			if _, err := MapRoster(raw); err == nil {
				t.Fatal("unvalidated statistics would overwrite retained totals and renew their clock")
			}
		})
	}
}

func TestRosterStatisticsDistinguishOmissionFromValidatedNullableValues(t *testing.T) {
	for _, tc := range []struct {
		name, field     string
		wantStats, zero bool
	}{
		{"absent", "", false, false},
		{"null", `,"statistics":null`, false, false},
		{"explicit empty categories", `,"statistics":{"splits":{"categories":[],"count":0}}`, true, false},
		{"explicit empty stats", `,"statistics":{"splits":{"categories":[{"name":"general","stats":[],"total":0}]}}`, true, false},
		{"nullable measurement", `,"statistics":{"splits":{"categories":[{"name":"general","stats":[{"name":"appearances","value":0},{"name":"totalGoals","value":null}]}]}}`, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			squad, err := MapRoster([]byte(`{"status":"success","team":{"id":"227"},"athletes":[{"id":"p1","fullName":"Measured Player"` + tc.field + `}]}`))
			if err != nil {
				t.Fatal(err)
			}
			stats := squad.Players[0].Stats
			if (stats != nil) != tc.wantStats {
				t.Fatalf("statistics=%+v", stats)
			}
			if tc.zero && (stats.Appearances == nil || *stats.Appearances != 0 || stats.Goals != nil) {
				t.Fatalf("measured zero or nullable goals changed: %+v", stats)
			}
		})
	}
}
