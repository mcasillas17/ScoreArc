package espn

import (
	"encoding/json"
	"testing"
)

func TestTeamStatsRecordedCountsAndAccuracy(t *testing.T) {
	detail, err := MapSummary(loadSummaryFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(detail.Stats.Home)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]float64{"passesAccurate": 339, "crossesAccurate": 7, "tacklesEffective": 18, "passAccuracy": 84.5, "crossAccuracy": 24.1, "tackleAccuracy": 75, "shotAccuracy": 35.7} {
		if fields[key] != want {
			t.Errorf("%s = %v, want %v", key, fields[key], want)
		}
	}
}

func TestTeamStatsAccuracyOperands(t *testing.T) {
	for _, metric := range []struct{ numerator, total, provider, count, accuracy string }{
		{"shotsOnTarget", "totalShots", "shotPct", "shotsOnTarget", "shotAccuracy"},
		{"accuratePasses", "totalPasses", "passPct", "passesAccurate", "passAccuracy"},
		{"accurateCrosses", "totalCrosses", "crossPct", "crossesAccurate", "crossAccuracy"},
		{"effectiveTackles", "totalTackles", "tacklePct", "tacklesEffective", "tackleAccuracy"},
	} {
		for _, tc := range []struct {
			name, numerator, total, provider string
			want                             any
		}{
			{"derived", "3", "11", "0.3", 27.3},
			{"genuine zero", "0", "11", "0.3", float64(0)},
			{"zero denominator", "0", "0", "0.3", nil},
			{"missing numerator", "", "11", "0.333", 33.3},
			{"missing total", "3", "", "0.333", 33.3},
			{"no operands", "", "", "0.005", 0.5},
			{"negative numerator", "-1", "11", "0.3", nil},
			{"negative denominator", "3", "-11", "0.3", nil},
			{"numerator exceeds total", "12", "11", "0.3", nil},
			{"malformed numerator", "invalid", "11", "0.3", nil},
			{"nonfinite numerator", "Infinity", "11", "0.3", nil},
			{"overflow total", "3", "1e999", "0.3", nil},
			{"invalid total missing numerator", "", "-11", "0.3", nil},
			{"negative fallback", "", "11", "-0.3", nil},
			{"overfull fallback", "", "11", "1.1", nil},
			{"missing fallback", "", "11", "", nil},
		} {
			t.Run(metric.accuracy+"/"+tc.name, func(t *testing.T) {
				var stats []rawStatEntry
				for _, v := range []struct{ name, value string }{{metric.numerator, tc.numerator}, {metric.total, tc.total}, {metric.provider, tc.provider}} {
					if v.value != "" {
						stats = append(stats, rawStatEntry{Name: v.name, DisplayValue: v.value})
					}
				}
				encoded, err := json.Marshal(buildTeamStats(stats))
				if err != nil {
					t.Fatal(err)
				}
				var fields map[string]any
				if err := json.Unmarshal(encoded, &fields); err != nil {
					t.Fatal(err)
				}
				if fields[metric.accuracy] != tc.want {
					t.Fatalf("accuracy=%v want=%v", fields[metric.accuracy], tc.want)
				}
				if tc.numerator == "" && fields[metric.count] != nil {
					t.Fatalf("manufactured numerator: %v", fields[metric.count])
				}
			})
		}
	}
}
