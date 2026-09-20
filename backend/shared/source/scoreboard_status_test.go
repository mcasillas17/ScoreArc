package source

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestESPNScoreboardRejectsInvalidObservationStatus(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		for _, tc := range []struct {
			name, status string
		}{
			{"null", `null`},
			{"empty", `{}`},
			{"null type", `{"type":null}`},
			{"wrong type", `{"type":[]}`},
			{"missing completion", `{"type":{"state":"pre","name":"STATUS_SCHEDULED"}}`},
			{"null completion", `{"type":{"state":"in","completed":null,"name":"STATUS_IN_PROGRESS"}}`},
			{"wrong completion type", `{"type":{"state":"in","completed":"true","name":"STATUS_IN_PROGRESS"}}`},
			{"missing name", `{"type":{"state":"post","completed":true}}`},
			{"missing state", `{"type":{"completed":true,"name":"STATUS_FULL_TIME"}}`},
			{"unknown state", `{"type":{"state":"unknown","completed":false,"name":"STATUS_IN_PROGRESS"}}`},
			{"completed pre", `{"type":{"state":"pre","completed":true,"name":"STATUS_SCHEDULED"}}`},
			{"completed in", `{"type":{"state":"in","completed":true,"name":"STATUS_IN_PROGRESS"}}`},
			{"completed active name", `{"type":{"state":"post","completed":true,"name":"STATUS_IN_PROGRESS"}}`},
			{"incomplete final", `{"type":{"state":"post","completed":false,"name":"STATUS_FULL_TIME"}}`},
			{"active final", `{"type":{"state":"in","completed":false,"name":"STATUS_FULL_TIME"}}`},
			{"completed suspended", `{"type":{"state":"post","completed":true,"name":"STATUS_SUSPENDED"}}`},
			{"completed postponed", `{"type":{"state":"post","completed":true,"name":"STATUS_POSTPONED"}}`},
		} {
			t.Run(fmt.Sprintf("fallback=%t/%s", fallback, tc.name), func(t *testing.T) {
				body := strings.Replace(currentScoreboard,
					`{"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false}}`, tc.status, 1)
				if body == currentScoreboard {
					t.Fatal("status mutation did not apply")
				}
				calls := 0
				src := recoverySource(func(*http.Request) (*http.Response, error) {
					calls++
					if fallback && calls == 1 {
						return recoveryResponse(400, "range unavailable"), nil
					}
					return recoveryResponse(200, body), nil
				})
				src.now = func() time.Time { return time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC) }
				matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
					config.Season{ID: "2026-27"}, false)
				if err == nil || len(matches) != 0 || IsPartialScoreboard(err) {
					t.Fatalf("invalid status counted as validated: matches=%+v err=%v", matches, err)
				}
				wantCalls := 1
				if fallback {
					wantCalls = 2
				}
				if calls != wantCalls {
					t.Fatalf("calls=%d want %d", calls, wantCalls)
				}
			})
		}
	}
}
