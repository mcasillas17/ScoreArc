package espn

import (
	"fmt"
	"math"
	"strconv"
	"testing"
)

func summaryShootoutValidationPayload(home, away string) []byte {
	return []byte(fmt.Sprintf(`{
		"header":{"id":"match","league":{"slug":"esp.1"},"season":{"year":2026},
			"competitions":[{"id":"match","date":"2026-09-15T19:00Z",
				"status":{"type":{"name":"STATUS_FINAL_PEN","state":"post","completed":true}},
				"competitors":[
					{"homeAway":"home","team":{"id":"home"},"score":"1","shootoutScore":%s},
					{"homeAway":"away","team":{"id":"away"},"score":"1","shootoutScore":%s}
				]}]},
		"gameInfo":{"venue":{"fullName":"Test stadium"}}
	}`, home, away))
}

func TestSummaryShootoutAuthoritativeGatesRejectMalformedTotals(t *testing.T) {
	limit := strconv.FormatFloat(math.Ldexp(1, strconv.IntSize-1), 'f', 0, 64)
	expected := Match{ID: "match", Home: Team{ID: "home"}, Away: Team{ID: "away"}}
	for _, value := range []string{`-1`, `"1.5"`, `"not-a-score"`, `"Infinity"`, `1e100`, limit, strconv.Quote(limit)} {
		for _, homeSide := range []bool{false, true} {
			home, away := `"4"`, `3`
			if homeSide {
				home = value
			} else {
				away = value
			}
			raw := summaryShootoutValidationPayload(home, away)
			if match, err := MapSummaryObservation(raw, expected, "esp.1", 2026); err == nil || match.ID != "" {
				t.Errorf("observation gate accepted home=%s away=%s: err=%v", home, away, err)
			}
			for _, requireFinal := range []bool{false, true} {
				if err := ValidateSummary(raw, "match", "home", "away", requireFinal); err == nil {
					t.Errorf("summary gate accepted home=%s away=%s (final=%t)", home, away, requireFinal)
				}
			}
		}
	}
}

func TestMapSummaryToleratesInvalidShootoutWithoutUnsafeConversion(t *testing.T) {
	for _, value := range []string{`-1`, `"1.5"`, `"Infinity"`, `1e100`} {
		detail, err := MapSummary(summaryShootoutValidationPayload(value, `3`))
		if err != nil || detail.Shootout != nil {
			t.Fatalf("tolerant mapper retained malformed/overflowing total %s: shootout=%+v err=%v", value, detail.Shootout, err)
		}
	}
}

func TestSummaryShootoutSafeIntegerConversionBoundary(t *testing.T) {
	// The exclusive float boundary matters: converting MaxInt64 to float64
	// rounds UP to 2^63, which is already unsafe to convert back to int.
	limit := math.Ldexp(1, strconv.IntSize-1)
	safe := math.Trunc(math.Nextafter(limit, 0))
	for _, value := range []string{
		strconv.FormatFloat(safe, 'f', 0, 64),
		strconv.Quote(strconv.FormatFloat(safe, 'f', 0, 64)),
	} {
		raw := summaryShootoutValidationPayload(value, `3`)
		if err := ValidateSummary(raw, "match", "home", "away", true); err != nil {
			t.Fatal(err)
		}

		detail, err := MapSummary(raw)
		if err != nil || detail.Shootout == nil || detail.Shootout.HomeScore < 0 ||
			float64(detail.Shootout.HomeScore) != safe || detail.Shootout.AwayScore != 3 {
			t.Fatalf("safe integral total converted incorrectly: shootout=%+v err=%v", detail.Shootout, err)
		}
	}
}
