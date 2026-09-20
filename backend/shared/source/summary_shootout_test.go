package source

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func shootoutSummary(home, away string) string {
	if home != "" {
		home = `,"shootoutScore":` + home
	}
	if away != "" {
		away = `,"shootoutScore":` + away
	}
	return fmt.Sprintf(`{
		"header":{"id":"401882876","league":{"slug":"esp.1"},"season":{"year":2026},
			"competitions":[{"id":"401882876","date":"2026-09-15T19:00Z",
				"status":{"type":{"name":"STATUS_FINAL_PEN","state":"post","completed":true}},
				"competitors":[
					{"homeAway":"home","team":{"id":"96"},"score":"1"%s},
					{"homeAway":"away","team":{"id":"94"},"score":"1"%s}
				]}]},
		"gameInfo":{"venue":{"fullName":"Test stadium"}}
	}`, home, away)
}

func TestESPNSummaryPathsRejectMalformedShootoutTotals(t *testing.T) {
	intLimit := strconv.FormatFloat(math.Ldexp(1, strconv.IntSize-1), 'f', 0, 64)
	for _, value := range []string{
		`-1`, `"-1"`, `1.5`, `"1.5"`, `"not-a-score"`, `"Infinity"`, `"NaN"`,
		`1e309`, `"1e309"`, `1e100`, `"1e100"`, intLimit, strconv.Quote(intLimit), `true`, `{}`,
	} {
		for _, side := range []string{"home", "away"} {
			t.Run(side+"/"+value, func(t *testing.T) {
				home, away := `"4"`, `3`
				if side == "home" {
					home = value
				} else {
					away = value
				}
				raw := shootoutSummary(home, away)
				src := recoverySource(func(*http.Request) (*http.Response, error) {
					return recoveryResponse(200, raw), nil
				})
				observed, summary, err := src.RecoverMatch(context.Background(), config.Competition{ESPNSlug: "esp.1"},
					config.Season{ID: "2026-27"}, recoveryMatch())
				if err == nil || !strings.Contains(err.Error(), "shootout") || observed.ID != "" ||
					summary.HomeScore != nil || summary.AwayScore != nil || summary.Detail.Shootout != nil {
					t.Errorf("recovery accepted malformed %s shootout %s: err=%v", side, value, err)
				}
				for _, state := range []model.MatchState{model.MatchStateScheduled, model.MatchStateLive, model.MatchStateFinished} {
					input := recoveryMatch()
					input.State = state
					result, err := src.Summary(context.Background(), config.Competition{ESPNSlug: "esp.1"}, input)
					if err == nil || !strings.Contains(err.Error(), "shootout") ||
						result.HomeScore != nil || result.AwayScore != nil || result.Detail.Shootout != nil {
						t.Errorf("ordinary %s summary accepted malformed %s shootout %s: err=%v", state, side, value, err)
					}
				}
			})
		}
	}
}

func TestESPNSummaryPathsPreserveValidAndOptionalShootoutTotals(t *testing.T) {
	for _, tc := range []struct {
		name, home, away string
		want             *model.Shootout
	}{
		{"numbers", `4`, `3`, &model.Shootout{HomeScore: 4, AwayScore: 3}},
		{"strings", `"4"`, `"3"`, &model.Shootout{HomeScore: 4, AwayScore: 3}},
		{"integral decimals", `4.0`, `"3.0"`, &model.Shootout{HomeScore: 4, AwayScore: 3}},
		{"integral exponents", `"4e0"`, `3e0`, &model.Shootout{HomeScore: 4, AwayScore: 3}},
		{"absent", "", "", nil},
		{"null", `null`, `null`, nil},
		{"empty", `""`, `""`, nil},
		{"mixed missing", "", `3`, nil},
		{"null coerces zero", `null`, `3`, &model.Shootout{HomeScore: 0, AwayScore: 3}},
		{"empty coerces zero", `""`, `3`, &model.Shootout{HomeScore: 0, AwayScore: 3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := shootoutSummary(tc.home, tc.away)
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, raw), nil
			})
			observed, recovered, err := src.RecoverMatch(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, recoveryMatch())
			if err != nil || observed.State != model.MatchStateFinished ||
				observed.HomeScore == nil || *observed.HomeScore != 1 || observed.AwayScore == nil || *observed.AwayScore != 1 {
				t.Fatalf("recovered regulation scores changed: match=%+v err=%v", observed, err)
			}
			input := recoveryMatch()
			input.State = model.MatchStateFinished
			ordinary, err := src.Summary(context.Background(), config.Competition{ESPNSlug: "esp.1"}, input)
			if err != nil {
				t.Fatal(err)
			}
			for _, result := range []SummaryResult{recovered, ordinary} {
				if result.HomeScore == nil || *result.HomeScore != 1 || result.AwayScore == nil || *result.AwayScore != 1 {
					t.Fatal("shootout totals replaced regulation scores")
				}
				got := result.Detail.Shootout
				if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
					t.Fatalf("shootout=%+v want=%+v", got, tc.want)
				}
			}
		})
	}
}
