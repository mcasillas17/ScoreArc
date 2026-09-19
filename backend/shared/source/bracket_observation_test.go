package source

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestESPNBracketPropagatesInvalidObservationStatus(t *testing.T) {
	for _, backfill := range []bool{false, true} {
		for _, tc := range []struct {
			name, status string
		}{
			{"missing completion", `{"state":"pre","name":"STATUS_SCHEDULED"}`},
			{"null completion", `{"state":"pre","completed":null,"name":"STATUS_SCHEDULED"}`},
			{"completed pre", `{"state":"pre","completed":true,"name":"STATUS_SCHEDULED"}`},
			{"completed in", `{"state":"in","completed":true,"name":"STATUS_IN_PROGRESS"}`},
			{"incomplete final", `{"state":"post","completed":false,"name":"STATUS_FULL_TIME"}`},
			{"completed suspended", `{"state":"post","completed":true,"name":"STATUS_SUSPENDED"}`},
			{"completed postponed", `{"state":"post","completed":true,"name":"STATUS_POSTPONED"}`},
			{"unknown post status", `{"state":"post","completed":false,"name":"STATUS_PROVIDER_NEW"}`},
		} {
			t.Run(fmt.Sprintf("backfill=%t/%s", backfill, tc.name), func(t *testing.T) {
				raw := fmt.Sprintf(`{"events":[{
					"id":"bracket-only","date":"2026-07-01T12:00Z",
					"season":{"year":2026,"slug":"quarterfinals"},
					"status":{"type":%s},
					"competitions":[{"competitors":[
						{"homeAway":"home","winner":true,"score":"1","team":{"id":"1","displayName":"Home"}},
						{"homeAway":"away","score":"0","team":{"id":"2","displayName":"Away"}}
					]}]}]}`, tc.status)
				calls := 0
				src := recoverySource(func(*http.Request) (*http.Response, error) {
					calls++
					return recoveryResponse(200, raw), nil
				})
				dates := "20260628-20260719"
				matches, err := src.Bracket(context.Background(), config.Competition{ESPNSlug: "fifa.world"},
					config.Season{ID: "2026", HasBracket: true, BracketDatesRange: &dates}, backfill)
				if err == nil || matches != nil || IsPartialScoreboard(err) || calls != 1 {
					t.Fatalf("invalid bracket yielded candidates/empty success: matches=%+v calls=%d err=%v", matches, calls, err)
				}
				if !strings.Contains(err.Error(), "bracket-only") {
					t.Fatalf("bracket event context lost: %v", err)
				}
			})
		}
	}
}
