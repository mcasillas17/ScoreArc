package source

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func summaryWithStatus(t *testing.T, status string) string {
	t.Helper()
	const original = `"status":{"type":{"name":"STATUS_FULL_TIME","state":"post","completed":true,"shortDetail":"FT"}}`
	var raw string
	if status == "" {
		raw = strings.Replace(recoverySummary, `"status":`, `"ignoredStatus":`, 1)
	} else {
		raw = strings.Replace(recoverySummary, original, `"status":`+status, 1)
	}
	if raw == recoverySummary {
		t.Fatal("summary status mutation did not apply")
	}
	return raw
}

func TestESPNSummaryRejectsInvalidFinalObservationStatus(t *testing.T) {
	for _, tc := range []struct {
		name, status string
	}{
		{"completed suspended active", `{"type":{"state":"in","completed":true,"name":"STATUS_SUSPENDED"}}`},
		{"completed scheduled", `{"type":{"state":"pre","completed":true,"name":"STATUS_SCHEDULED"}}`},
		{"completed active", `{"type":{"state":"in","completed":true,"name":"STATUS_IN_PROGRESS"}}`},
		{"completed active name", `{"type":{"state":"post","completed":true,"name":"STATUS_IN_PROGRESS"}}`},
		{"completed postponed", `{"type":{"state":"post","completed":true,"name":"STATUS_POSTPONED"}}`},
		{"missing state", `{"type":{"completed":true,"name":"STATUS_FULL_TIME"}}`},
		{"missing name", `{"type":{"state":"post","completed":true}}`},
		{"missing completion", `{"type":{"state":"post","name":"STATUS_FULL_TIME"}}`},
		{"null completion", `{"type":{"state":"post","completed":null,"name":"STATUS_FULL_TIME"}}`},
		{"missing status", ""},
		{"null status", `null`},
		{"null type", `{"type":null}`},
		{"wrong type", `{"type":[]}`},
		{"valid live not final", `{"type":{"state":"in","completed":false,"name":"STATUS_IN_PROGRESS"}}`},
		{"valid scheduled not final", `{"type":{"state":"pre","completed":false,"name":"STATUS_SCHEDULED"}}`},
		{"ambiguous future post", `{"type":{"state":"post","completed":false,"name":"STATUS_PROVIDER_FUTURE"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := summaryWithStatus(t, tc.status)
			calls := 0
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				calls++
				return recoveryResponse(200, raw), nil
			})
			match := recoveryMatch()
			match.State, match.StatusName = model.MatchStateFinished, "STATUS_FULL_TIME"
			result, err := src.Summary(context.Background(), config.Competition{ESPNSlug: "esp.1"}, match)
			if err == nil || result.HomeScore != nil || result.AwayScore != nil || result.Detail.Info != nil {
				t.Fatalf("ordinary final summary accepted invalid observation: result=%+v err=%v", result, err)
			}
			if calls != 1 || *match.HomeScore != 0 || *match.AwayScore != 0 {
				t.Fatalf("summary refetched or input scoreboard scores changed: calls=%d match=%+v", calls, match)
			}
		})
	}
}

func TestESPNSummaryAcceptsKnownAndFutureFinalObservationStatus(t *testing.T) {
	for _, name := range []string{"STATUS_FULL_TIME", "STATUS_FINAL", "STATUS_FINAL_AET", "STATUS_FINAL_PEN", "STATUS_PROVIDER_FUTURE"} {
		t.Run(name, func(t *testing.T) {
			raw := summaryWithStatus(t, fmt.Sprintf(`{"type":{"name":%q,"state":"post","completed":true}}`, name))
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, raw), nil
			})
			match := recoveryMatch()
			match.State, match.StatusName = model.MatchStateFinished, "STATUS_FULL_TIME"
			result, err := src.Summary(context.Background(), config.Competition{ESPNSlug: "esp.1"}, match)
			if err != nil || result.HomeScore == nil || *result.HomeScore != 0 ||
				result.AwayScore == nil || *result.AwayScore != 1 || result.Detail.Info == nil {
				t.Fatalf("valid ordinary final summary rejected: result=%+v err=%v", result, err)
			}
		})
	}
}

func TestESPNSummaryPreservesTerminalNoDetailPolicy(t *testing.T) {
	for _, name := range []string{"STATUS_CANCELED", "STATUS_ABANDONED", "STATUS_FORFEIT"} {
		t.Run(name, func(t *testing.T) {
			raw := summaryWithStatus(t, fmt.Sprintf(`{"type":{"name":%q,"state":"post","completed":false}}`, name))
			raw = strings.Replace(raw, `"gameInfo":{"venue":{"fullName":"Test stadium"}}`, `"gameInfo":null`, 1)
			raw = strings.Replace(raw, `"score":"0",`, "", 1)
			raw = strings.Replace(raw, `"score":"1",`, "", 1)
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, raw), nil
			})
			match := recoveryMatch()
			match.State, match.StatusName = model.MatchStateFinished, name
			result, err := src.Summary(context.Background(), config.Competition{ESPNSlug: "esp.1"}, match)
			if err != nil || result.HomeScore != nil || result.AwayScore != nil || result.Detail.Info != nil {
				t.Fatalf("terminal no-detail policy changed: result=%+v err=%v", result, err)
			}
		})
	}
}
