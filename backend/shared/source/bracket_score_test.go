package source

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
)

const scheduledBracketEvent = `{
	"id":"scheduled","date":"2026-07-01T12:00Z",
	"season":{"year":2026,"slug":"quarterfinals"},
	"status":{"type":{"name":"STATUS_SCHEDULED","state":"pre","completed":false}},
	"competitions":[{"competitors":[
		{"homeAway":"home","team":{"id":"1","displayName":"Home"},"score":"0"},
		{"homeAway":"away","team":{"id":"2","displayName":"Away"},"score":"1"}
	]}]
}`

func TestESPNBracketRejectsMalformedScoresWithoutCandidates(t *testing.T) {
	for _, backfill := range []bool{false, true} {
		for _, score := range []string{`"-1"`, `-1`, `"1.5"`, `1.5`, `"not-a-score"`} {
			for _, field := range []string{"score", "shootoutScore"} {
				t.Run(fmt.Sprintf("backfill=%t/%s=%s", backfill, field, score), func(t *testing.T) {
					bad := strings.Replace(scheduledBracketEvent, `"id":"scheduled"`, `"id":"bad-scheduled"`, 1)
					replacement := `"score":` + score
					if field == "shootoutScore" {
						replacement = `"score":"0","shootoutScore":` + score
					}
					bad = strings.Replace(bad, `"score":"0"`, replacement, 1)
					for _, events := range []string{bad, scheduledBracketEvent + "," + bad} {
						calls := 0
						src := recoverySource(func(*http.Request) (*http.Response, error) {
							calls++
							return recoveryResponse(200, `{"events":[`+events+`]}`), nil
						})
						matches, err := src.Bracket(context.Background(), config.Competition{ESPNSlug: "fifa.world"},
							config.Season{ID: "2026", HasBracket: true}, backfill)
						if err == nil || matches != nil || IsPartialScoreboard(err) || calls != 1 ||
							!strings.Contains(err.Error(), "bad-scheduled") {
							t.Fatalf("bad score yielded %d bracket candidates: calls=%d err=%v", len(matches), calls, err)
						}
					}
				})
			}
		}
	}
}

func TestESPNBracketAllowsAbsentScheduledScores(t *testing.T) {
	for _, score := range []string{"absent", `""`, `null`} {
		t.Run(score, func(t *testing.T) {
			event := scheduledBracketEvent
			for _, original := range []string{`,"score":"0"`, `,"score":"1"`} {
				replacement := ""
				if score != "absent" {
					replacement = `,"score":` + score
				}
				event = strings.Replace(event, original, replacement, 1)
			}
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, `{"events":[`+event+`]}`), nil
			})
			matches, err := src.Bracket(context.Background(), config.Competition{ESPNSlug: "fifa.world"},
				config.Season{ID: "2026", HasBracket: true}, false)
			if err != nil || len(matches) != 1 || matches[0].HomeScore != nil || matches[0].AwayScore != nil {
				t.Fatalf("legitimate scheduled scores rejected: matches=%+v err=%v", matches, err)
			}
		})
	}
}
