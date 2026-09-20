package source

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func futureStatusScoreboardEvent(id, state string, completed bool) string {
	return fmt.Sprintf(`{
		"id":%q,"date":"2026-09-19T19:00Z","season":{"year":2026,"slug":"regular-season"},
		"status":{"type":{"name":"STATUS_PROVIDER_FUTURE","state":%q,"completed":%t}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"96","displayName":"Home"},"score":"0"},
			{"homeAway":"away","team":{"id":"94","displayName":"Away"},"score":"1"}
		]}]
	}`, id, state, completed)
}

func TestESPNScoreboardFutureStatesKeepOtherMatches(t *testing.T) {
	known := strings.Replace(futureStatusScoreboardEvent("known", "in", false), "STATUS_PROVIDER_FUTURE", "STATUS_IN_PROGRESS", 1)
	events := []string{
		known,
		futureStatusScoreboardEvent("future-pre", "pre", false),
		futureStatusScoreboardEvent("future-in", "in", false),
		futureStatusScoreboardEvent("future-post", "post", true),
	}
	for _, backfill := range []bool{false, true} {
		for _, fallback := range []bool{false, true} {
			t.Run(fmt.Sprintf("backfill=%t/fallback=%t", backfill, fallback), func(t *testing.T) {
				calls := 0
				src := recoverySource(func(*http.Request) (*http.Response, error) {
					calls++
					if fallback && calls == 1 {
						return recoveryResponse(400, "range unavailable"), nil
					}
					return recoveryResponse(200, `{"events":[`+strings.Join(events, ",")+`]}`), nil
				})
				src.now = func() time.Time { return time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC) }
				matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
					config.Season{ID: "2026-27"}, backfill)
				if (err != nil) != fallback || IsPartialScoreboard(err) != fallback || len(matches) != 4 {
					t.Fatalf("future status blocked peers or hid partial coverage: matches=%+v err=%v", matches, err)
				}
				want := map[string]model.MatchState{
					"known": model.MatchStateLive, "future-pre": model.MatchStateScheduled,
					"future-in": model.MatchStateLive, "future-post": model.MatchStateFinished,
				}
				for _, match := range matches {
					if match.State != want[match.ID] {
						t.Fatalf("match %s state=%s want %s", match.ID, match.State, want[match.ID])
					}
					delete(want, match.ID)
				}
				if len(want) != 0 {
					t.Fatalf("lost peer matches: %v", want)
				}
			})
		}
	}
}

func TestESPNScoreboardFutureStateDoesNotHideInvalidNeighbor(t *testing.T) {
	body := `{"events":[` + futureStatusScoreboardEvent("valid", "pre", false) + `,` +
		futureStatusScoreboardEvent("ambiguous", "post", false) + `]}`
	src := recoverySource(func(*http.Request) (*http.Response, error) {
		return recoveryResponse(200, body), nil
	})
	matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
		config.Season{ID: "2026-27"}, false)
	if matches != nil || err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("invalid neighbor silently skipped or wrong event rejected: matches=%+v err=%v", matches, err)
	}
}

func TestESPNRecoverMatchFutureFinalRequiresScoresAndDetail(t *testing.T) {
	for _, tc := range []struct {
		name, old, replacement, wantError string
	}{
		{name: "valid explicit final"},
		{"missing score", `"score":"0",`, ``, "lacks scores"},
		{"null score", `"score":"0"`, `"score":null`, "lacks scores"},
		{"negative score", `"score":"0"`, `"score":"-1"`, "invalid score"},
		{"missing detail", `"gameInfo":{"venue":{"fullName":"Test stadium"}}`, `"gameInfo":null`, "no detail sections"},
		{"ambiguous post", `"completed":true`, `"completed":false`, "contradictory status"},
		{"completed pre", `"state":"post"`, `"state":"pre"`, "contradictory status"},
		{"completed in", `"state":"post"`, `"state":"in"`, "contradictory status"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := strings.Replace(recoverySummary, "STATUS_FULL_TIME", "STATUS_PROVIDER_FUTURE", 1)
			if tc.old != "" {
				mutated := strings.Replace(body, tc.old, tc.replacement, 1)
				if mutated == body {
					t.Fatal("test mutation did not apply")
				}
				body = mutated
			}
			calls := 0
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				calls++
				return recoveryResponse(200, body), nil
			})
			match, summary, err := src.RecoverMatch(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, recoveryMatch())
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) || match.ID != "" {
					t.Fatalf("final trust guard not applied: match=%+v err=%v want %q", match, err, tc.wantError)
				}
			} else if err != nil || match.State != model.MatchStateFinished ||
				match.StatusName != "STATUS_PROVIDER_FUTURE" ||
				match.HomeScore == nil || *match.HomeScore != 0 || match.AwayScore == nil || *match.AwayScore != 1 ||
				summary.HomeScore == nil || *summary.HomeScore != 0 || summary.AwayScore == nil || *summary.AwayScore != 1 ||
				summary.Detail.Info == nil {
				t.Fatalf("explicit future final not observed: match=%+v summary=%+v err=%v", match, summary, err)
			}
			if calls != 1 {
				t.Fatalf("summary fetched %d times", calls)
			}
		})
	}
}
