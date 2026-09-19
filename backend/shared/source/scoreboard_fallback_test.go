package source

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	espnprovider "github.com/mcasillas17/scorearc-backend/shared/espn"
)

const currentScoreboard = `{"events":[{
	"id":"current","date":"2026-09-19T19:00Z","season":{"year":2026,"slug":"regular-season"},
	"status":{"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false}},
	"competitions":[{"competitors":[
		{"homeAway":"home","team":{"id":"96","displayName":"Home"},"score":"0"},
		{"homeAway":"away","team":{"id":"94","displayName":"Away"},"score":"1"}
	]}]}]}`

func TestESPNScoreboardFallbackRemainsPartialForRollingAndBackfill(t *testing.T) {
	for _, backfill := range []bool{false, true} {
		for _, empty := range []bool{false, true} {
			t.Run(fmt.Sprintf("backfill=%t/empty=%t", backfill, empty), func(t *testing.T) {
				var requests []string
				src := recoverySource(func(req *http.Request) (*http.Response, error) {
					requests = append(requests, req.URL.Query().Get("dates"))
					if req.URL.Query().Get("limit") != "1000" {
						t.Fatalf("event limit lost: %s", req.URL)
					}
					if len(requests) == 1 {
						return recoveryResponse(400, "Failed to get events endpoint."), nil
					}
					body := currentScoreboard
					if empty {
						body = `{"events":[]}`
					}
					return recoveryResponse(200, body), nil
				})
				// Local calendar still reads Sep 18; the request must use UTC Sep 19.
				src.now = func() time.Time {
					return time.Date(2026, 9, 18, 20, 0, 0, 0, time.FixedZone("west", -7*3600))
				}
				matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
					config.Season{ID: "2026-27"}, backfill)
				var partial *PartialScoreboardError
				var status *espnprovider.HTTPStatusError
				if !errors.As(err, &partial) || !IsPartialScoreboard(fmt.Errorf("poll: %w", err)) ||
					!errors.As(err, &status) || status.StatusCode != 400 ||
					!strings.Contains(status.URL, "dates=2026") || status.Body != "Failed to get events endpoint." {
					t.Fatalf("lost typed partial error/original cause: %v", err)
				}
				wantRange := "20260820-20260926"
				if backfill {
					wantRange = "20260701-20270630"
				}
				if len(requests) != 2 || requests[0] != wantRange || requests[1] != "20260919" {
					t.Fatalf("requests=%v", requests)
				}
				wantCount := 1
				if empty {
					wantCount = 0
				}
				if matches == nil || len(matches) != wantCount {
					t.Fatalf("validated fallback matches=%+v", matches)
				}
			})
		}
	}
	if IsPartialScoreboard(nil) || IsPartialScoreboard(errors.New("partial scoreboard")) {
		t.Fatal("partial detection must use the error type, not text")
	}
}

func TestESPNScoreboardFallbackOnlyWithinSeason(t *testing.T) {
	for _, tc := range []struct {
		season string
		now    string
		calls  int
	}{
		{"2026-27", "2026-06-30T23:59:59Z", 1},
		{"2026-27", "2026-07-01T00:00:00Z", 2},
		{"2026-27", "2027-06-30T23:59:59Z", 2},
		{"2026-27", "2027-07-01T00:00:00Z", 1},
		{"2027-clausura", "2027-01-01T00:00:00Z", 2},
		{"2027-clausura", "2027-07-01T00:00:00Z", 1},
		{"2026-apertura", "2026-01-01T00:00:00Z", 1},
		{"invalid", "2026-09-19T00:00:00Z", 0},
	} {
		t.Run(tc.season+"/"+tc.now, func(t *testing.T) {
			calls := 0
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				calls++
				if strings.Contains(req.URL.Query().Get("dates"), "-") {
					return recoveryResponse(400, "range unavailable"), nil
				}
				return recoveryResponse(200, `{"events":[]}`), nil
			})
			now, err := time.Parse(time.RFC3339, tc.now)
			if err != nil {
				t.Fatal(err)
			}
			src.now = func() time.Time { return now }
			_, err = src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: tc.season}, true)
			if err == nil || calls != tc.calls || IsPartialScoreboard(err) != (tc.calls == 2) {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestESPNScoreboardFallbackHonorsBracketSeasonBounds(t *testing.T) {
	for _, tc := range []struct {
		name, dates string
		hasBracket  bool
		calls       int
		invalid     bool
	}{
		{"after bracket end", "20260901-20260918", true, 1, false},
		{"on bracket end", "20260901-20260919", true, 2, false},
		{"before bracket starts", "20261001-20261101", true, 2, false},
		{"empty", "", true, 1, true},
		{"missing separator", "2026090120260919", true, 1, true},
		{"bad date", "20260230-20260919", true, 1, true},
		{"reversed", "20260920-20260901", true, 1, true},
		{"outside season", "20250601-20250630", true, 1, true},
		{"disabled bracket ignored", "invalid", false, 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return recoveryResponse(400, "original range failure"), nil
				}
				return recoveryResponse(200, `{"events":[]}`), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC) }
			_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "fifa.world"},
				config.Season{ID: "2026", HasBracket: tc.hasBracket, BracketDatesRange: &tc.dates}, true)
			if err == nil || calls != tc.calls || IsPartialScoreboard(err) != (tc.calls == 2) {
				t.Fatalf("calls=%d err=%v; want %d calls with bracket-aware fallback", calls, err, tc.calls)
			}
			if tc.invalid && !strings.Contains(err.Error(), "bracket date range") {
				t.Fatalf("invalid configured range was not reported: %v", err)
			}
			if !strings.Contains(err.Error(), "original range failure") {
				t.Fatalf("range error lost: %v", err)
			}
		})
	}
}

func TestESPNScoreboardFallbackFailuresStayExplicit(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		err      error
		attempts int
	}{
		{"400", 400, "single date rejected", nil, 1},
		{"500", 500, "single date unavailable", nil, 3},
		{"timeout", 0, "", context.DeadlineExceeded, 3},
		{"malformed", 200, "{", nil, 1},
		{"null", 200, "null", nil, 1},
		{"missing events", 200, "{}", nil, 1},
		{"missing status", 200, strings.Replace(currentScoreboard, `"status":`, `"ignored":`, 1), nil, 1},
		{"negative score", 200, strings.Replace(currentScoreboard, `"score":"0"`, `"score":"-1"`, 1), nil, 1},
		{"truncated", 200, `{"events":[` + strings.Repeat(`{},`, 999) + `{}]}`, nil, 1},
		{"wrong season", 200, strings.Replace(currentScoreboard, `"year":2026`, `"year":2025`, 1), nil, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rangeCalls, fallbackCalls := 0, 0
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				if strings.Contains(req.URL.Query().Get("dates"), "-") {
					rangeCalls++
					return recoveryResponse(400, "original range failure"), nil
				}
				fallbackCalls++
				if tc.err != nil {
					return nil, tc.err
				}
				return recoveryResponse(tc.status, tc.body), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC) }
			matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, true)
			if err == nil || len(matches) != 0 || IsPartialScoreboard(err) ||
				rangeCalls != 1 || fallbackCalls != tc.attempts ||
				!strings.Contains(err.Error(), "original range failure") ||
				!strings.Contains(err.Error(), "current-date scoreboard fallback") {
				t.Fatalf("range=%d fallback=%d matches=%+v err=%v", rangeCalls, fallbackCalls, matches, err)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("lost fallback error cause: %v", err)
			}
		})
	}
}

func TestESPNScoreboardDoesNotFallbackOnOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		err      error
		attempts int
	}{
		{"500", 500, "upstream failed", nil, 3},
		{"404", 404, "not found", nil, 1},
		{"timeout", 0, "", context.DeadlineExceeded, 3},
		{"fake status text", 0, "", errors.New("espn scoreboard: 400"), 3},
		{"malformed", 200, "{", nil, 1},
		{"missing envelope", 200, "{}", nil, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				calls++
				if !strings.Contains(req.URL.Query().Get("dates"), "-") {
					t.Errorf("unexpected fallback: %s", req.URL)
				}

				if tc.err != nil {
					return nil, tc.err
				}
				return recoveryResponse(tc.status, tc.body), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC) }
			_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, false)
			if err == nil || calls != tc.attempts || IsPartialScoreboard(err) {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}
