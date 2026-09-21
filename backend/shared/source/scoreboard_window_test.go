package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func monthEnvelope(slug string, events ...string) string {
	return fmt.Sprintf(`{"leagues":[{"slug":%q}],"events":[%s]}`, slug, strings.Join(events, ","))
}

func windowEvent(id, date string, year int) string {
	event := strings.TrimSuffix(strings.SplitN(currentScoreboard, `"events":[`, 2)[1], `]}`)
	event = strings.Replace(event, `"id":"current"`, fmt.Sprintf(`"id":%q`, id), 1)
	event = strings.Replace(event, `"2026-09-19T19:00Z"`, fmt.Sprintf("%q", date), 1)
	return strings.Replace(event, `"year":2026`, fmt.Sprintf(`"year":%d`, year), 1)
}

func TestMonthlyScoreboardRepairsObservedRangeFailure(t *testing.T) {
	fixture, err := os.ReadFile("testdata/scoreboard-month-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		RejectedRange json.RawMessage `json:"rejectedRange"`
	}
	if err := json.Unmarshal(fixture, &recorded); err != nil {
		t.Fatal(err)
	}
	var selectors []string
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		date := req.URL.Query().Get("dates")
		selectors = append(selectors, date)
		if strings.Contains(date, "-") {
			return recoveryResponse(400, string(recorded.RejectedRange)), nil
		}
		body := monthEnvelope("esp.1")
		if date == "202609" {
			body = monthEnvelope("esp.1", windowEvent("unknown", "2026-09-15T19:30Z", 2026))
		}
		return recoveryResponse(200, body), nil
	})
	src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
	matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
		config.Season{ID: "2026-27"}, false)
	if err != nil || len(matches) != 1 || matches[0].ID != "unknown" {
		t.Fatalf("incomplete discovery: matches=%+v err=%v selectors=%v", matches, err, selectors)
	}
	if !reflect.DeepEqual(selectors, []string{"202608", "202609"}) {
		t.Fatalf("unexpected discovery requests: %v", selectors)
	}
}

func TestMonthlyScoreboardRecordedCalendarBoundary(t *testing.T) {
	raw, err := os.ReadFile("testdata/scoreboard-month-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		January, February json.RawMessage
	}
	if err := json.Unmarshal(raw, &recorded); err != nil {
		t.Fatal(err)
	}
	var months []string
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		month := req.URL.Query().Get("dates")
		months = append(months, month)
		if month == "202601" {
			return recoveryResponse(200, string(recorded.January)), nil
		}
		return recoveryResponse(200, string(recorded.February)), nil
	})
	start := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	raw, err = src.scoreboardWindow(context.Background(), config.Competition{ESPNSlug: "mex.1"},
		config.Season{ID: "2026-clausura"}, start, start.AddDate(0, 0, 1))
	if err != nil {
		t.Fatal(err)
	}
	matches, err := espn.MapScoreboard(raw)
	if err != nil || len(matches) != 3 || !reflect.DeepEqual(months, []string{"202601", "202602"}) {
		t.Fatalf("calendar-day spill lost: matches=%+v months=%v err=%v", matches, months, err)
	}
	if matches[0].ID != "401840846" || matches[0].HomeScore == nil || *matches[0].HomeScore != 1 ||
		matches[0].AwayScore == nil || *matches[0].AwayScore != 2 || matches[0].Kickoff != "2026-02-01T01:10:00Z" {
		t.Fatalf("recorded fact changed: %+v", matches[0])
	}
}

func TestMonthlyScoreboardGuardIncludesFollowingProviderMonth(t *testing.T) {
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		if req.URL.Query().Get("dates") == "202602" {
			return recoveryResponse(200, monthEnvelope("esp.1",
				windowEvent("east-edge", "2026-01-31T23:30Z", 2026))), nil
		}
		return recoveryResponse(200, monthEnvelope("esp.1",
			windowEvent("too-early", "2026-01-30T23:59:59Z", 2026),
			windowEvent("too-late", "2026-02-01T00:00Z", 2026))), nil
	})
	start := time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC)
	raw, err := src.scoreboardWindow(context.Background(), config.Competition{ESPNSlug: "esp.1"},
		config.Season{ID: "2026"}, start, start.AddDate(0, 0, 1))
	if err != nil {
		t.Fatal(err)
	}
	matches, err := espn.MapScoreboard(raw)
	if err != nil || len(matches) != 1 || matches[0].ID != "east-edge" {
		t.Fatalf("following-month UTC guard or exact bounds failed: matches=%+v err=%v", matches, err)
	}
}

func TestMonthlyScoreboardUTCAndSeasonIsolation(t *testing.T) {
	// Provider Jan 31 includes Feb 1 UTC. December's response is allowed to
	// contribute Jan 1 UTC, but never a previous-season December match.
	events := map[string][]string{
		"202512": {windowEvent("previous", "2025-12-31T23:00Z", 2025),
			windowEvent("new-year", "2026-01-01T01:00Z", 2025)},
		"202601": {windowEvent("month-edge", "2026-02-01T01:10Z", 2025),
			windowEvent("middle", "2026-01-20T23:00Z", 2025)},
		"202606": {windowEvent("next-half", "2026-07-01T01:00Z", 2026)},
	}
	var selectors []string
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		date := req.URL.Query().Get("dates")
		selectors = append(selectors, date)
		return recoveryResponse(200, monthEnvelope("mex.1", events[date]...)), nil
	})
	src.now = func() time.Time {
		return time.Date(2026, 1, 31, 20, 0, 0, 0, time.FixedZone("west", -7*3600))
	}
	matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "mex.1"},
		config.Season{ID: "2026-clausura"}, true)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, match := range matches {
		ids = append(ids, match.ID)
	}
	if !reflect.DeepEqual(ids, []string{"middle", "month-edge", "new-year"}) {
		t.Fatalf("season leak or UTC-edge loss: %v", ids)
	}
	if !reflect.DeepEqual(selectors, []string{"202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607"}) {
		t.Fatalf("selector coverage=%v", selectors)
	}
}

func TestMonthlyScoreboardFailsClosed(t *testing.T) {
	valid := windowEvent("valid", "2026-09-15T19:30Z", 2026)
	for _, tc := range []struct{ name, body string }{
		{"missing league", `{"events":[]}`},
		{"foreign league", monthEnvelope("eng.1", valid)},
		{"missing events", `{"leagues":[{"slug":"esp.1"}]}`},
		{"null events", `{"leagues":[{"slug":"esp.1"}],"events":null}`},
		{"malformed", `{`},
		{"foreign season in window", monthEnvelope("esp.1", windowEvent("wrong", "2026-09-15T19:30Z", 2025))},
		{"missing season", monthEnvelope("esp.1", strings.Replace(valid, `"year":2026`, `"unknown":2026`, 1))},
		{"out of month", monthEnvelope("esp.1", windowEvent("wrong", "2026-10-15T19:30Z", 2026))},
		{"truncated before filter", monthEnvelope("esp.1", strings.Split(strings.TrimSuffix(strings.Repeat(`{},`, 1000), ","), ",")...)},
		{"pagination signal", strings.Replace(monthEnvelope("esp.1", valid), `{"leagues"`, `{"pageCount":2,"leagues"`, 1)},
		{"total exceeds returned", strings.Replace(monthEnvelope("esp.1", valid), `{"leagues"`, `{"count":2,"leagues"`, 1)},
		{"conflicting duplicate", monthEnvelope("esp.1", valid, strings.Replace(valid, `"score":"0"`, `"score":"2"`, 1))},
		{"invalid status", monthEnvelope("esp.1", strings.Replace(valid, `"completed":false`, `"completed":true`, 1))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				if req.URL.Query().Get("dates") == "202608" {
					return recoveryResponse(200, monthEnvelope("esp.1")), nil
				}
				return recoveryResponse(200, tc.body), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
			matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, false)
			if err == nil || matches != nil || IsPartialScoreboard(err) {
				t.Fatalf("invalid complete poll: matches=%+v err=%v", matches, err)
			}
		})
	}
}

func TestMonthlyScoreboardConflictsAcrossWindowEdges(t *testing.T) {
	for _, tc := range []struct{ name, august, september string }{
		{"inside first", "", windowEvent("moved", "2026-09-15T12:00Z", 2026) + "," + windowEvent("moved", "2026-09-30T12:00Z", 2026)},
		{"outside first", "", windowEvent("moved", "2026-09-30T12:00Z", 2026) + "," + windowEvent("moved", "2026-09-15T12:00Z", 2026)},
		{"outside earlier partition", windowEvent("moved", "2026-08-21T12:00Z", 2026), windowEvent("moved", "2026-09-15T12:00Z", 2026)},
		{"outside later partition", windowEvent("moved", "2026-08-25T12:00Z", 2026), windowEvent("moved", "2026-09-30T12:00Z", 2026)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				events := tc.september
				if req.URL.Query().Get("dates") == "202608" {
					events = tc.august
				}
				return recoveryResponse(200, monthEnvelope("esp.1", events)), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
			matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, false)
			if matches != nil || err == nil || !strings.Contains(err.Error(), "conflicting") {
				t.Fatalf("conflicting reschedule was accepted: matches=%v err=%v", matches, err)
			}
		})
	}
}

func TestMonthlyScoreboardCompleteEmptyAndDuplicate(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(fmt.Sprint(empty), func(t *testing.T) {
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				body := monthEnvelope("esp.1")
				if !empty && req.URL.Query().Get("dates") == "202609" {
					one := windowEvent("one", "2026-09-15T19:30Z", 2026)
					body = monthEnvelope("esp.1", one, one)
				}
				return recoveryResponse(200, body), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
			matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
				config.Season{ID: "2026-27"}, false)
			want := 1
			if empty {
				want = 0
			}
			if err != nil || matches == nil || len(matches) != want {
				t.Fatalf("matches=%+v err=%v", matches, err)
			}
		})
	}
}

func TestMonthlyScoreboardFallbackScopeAndDuplicates(t *testing.T) {
	valid := windowEvent("a", "2026-09-19T12:00Z", 2026)
	other := windowEvent("b", "2026-09-19T18:00Z", 2026)
	conflict := strings.Replace(valid, `"score":"0"`, `"score":"2"`, 1)
	for _, tc := range []struct {
		name, events string
		valid        bool
	}{
		{"identical copies", other + "," + valid + "," + valid, true},
		{"conflict ABA", valid + "," + conflict + "," + valid, false},
		{"missing year", strings.Replace(valid, `"year":2026`, `"unknown":2026`, 1), false},
		{"wrong provider day", windowEvent("a", "2026-09-17T12:00Z", 2026), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				if len(req.URL.Query().Get("dates")) == 6 {
					return recoveryResponse(400, "monthly discovery unavailable"), nil
				}
				return recoveryResponse(200, monthEnvelope("esp.1", tc.events)), nil
			})
			src.now = func() time.Time { return time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC) }
			matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, false)
			if tc.valid {
				if !IsPartialScoreboard(err) || len(matches) != 2 || matches[0].ID != "a" || matches[1].ID != "b" {
					t.Fatalf("deduplication/order lost: matches=%+v err=%v", matches, err)
				}
			} else if matches != nil || err == nil || IsPartialScoreboard(err) {
				t.Fatalf("invalid fallback renewed evidence: matches=%+v err=%v", matches, err)
			}
		})
	}
}

func TestMonthlyScoreboardBoundsAndRequestBudgets(t *testing.T) {
	for _, tc := range []struct {
		season, now, bracket, first, last string
		backfill                          bool
		count                             int
	}{
		{"2026", "2026-09-21", "", "202512", "202701", true, 14},
		{"2026-27", "2026-09-21", "", "202606", "202707", true, 14},
		{"2026-apertura", "2026-09-21", "", "202606", "202701", true, 8},
		{"2027-clausura", "2027-01-01", "", "202612", "202707", true, 8},
		{"2024", "2024-02-29", "", "202401", "202403", false, 3},
		{"2026", "2026-09-21", "20260628-20260719", "202512", "202607", true, 8},
		{"2026", "2026-09-21", "20260628-20260719", "202607", "202607", false, 1},
		{"2026-27", "2026-06-01", "", "202606", "202607", false, 2},
	} {
		t.Run(fmt.Sprintf("%s/%s/%t/%s", tc.season, tc.now, tc.backfill, tc.bracket), func(t *testing.T) {
			var dates []string
			at, err := time.Parse(time.DateOnly, tc.now)
			if err != nil {
				t.Fatal(err)
			}
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				dates = append(dates, req.URL.Query().Get("dates"))
				if req.URL.Query().Get("limit") != "1000" || req.URL.Query().Has("page") {
					t.Fatalf("unverified request contract: %s", req.URL)
				}
				deadline, ok := req.Context().Deadline()
				if !ok || time.Until(deadline) > 45*time.Second {
					t.Fatalf("window request lacks bounded deadline: %v", deadline)
				}
				return recoveryResponse(200, monthEnvelope("esp.1")), nil
			})
			src.now = func() time.Time { return at }
			season := config.Season{ID: tc.season}
			if tc.bracket != "" {
				season.HasBracket, season.BracketDatesRange = true, &tc.bracket
			}
			_, err = src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, season, tc.backfill)
			if err != nil || len(dates) != tc.count || dates[0] != tc.first || dates[len(dates)-1] != tc.last {
				t.Fatalf("dates=%v err=%v want [%s,%s] count=%d", dates, err, tc.first, tc.last, tc.count)
			}
		})
	}
}

func TestMonthlyScoreboardFailureBudgetsAndNoPartialWindow(t *testing.T) {
	for _, code := range []int{400, 429, 503} {
		for _, backfill := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/%t", code, backfill), func(t *testing.T) {
				calls := 0
				attempts := make(map[string]int)
				src := recoverySource(func(req *http.Request) (*http.Response, error) {
					calls++
					date := req.URL.Query().Get("dates")
					attempts[date]++
					if len(date) == 8 {
						return recoveryResponse(200, monthEnvelope("esp.1")), nil
					}
					// All earlier partitions first exercise both retry attempts.
					if date == "202609" || attempts[date] < 3 {
						return recoveryResponse(code, "upstream unavailable"), nil
					}
					return recoveryResponse(200, monthEnvelope("esp.1")), nil
				})
				src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
				matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
					config.Season{ID: "2026-27"}, backfill)
				wantCalls := 6
				if backfill {
					wantCalls = 12
				}
				if code == 400 {
					wantCalls = 2 // permanent first-month failure plus single-date fallback
				}
				if err == nil || len(matches) != 0 || calls != wantCalls || IsPartialScoreboard(err) != (code == 400) {
					t.Fatalf("calls=%d matches=%v err=%v", calls, matches, err)
				}
			})
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	calls := 0
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		calls++
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	_, err := src.Scoreboard(ctx, config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, true)
	if !errors.Is(err, context.DeadlineExceeded) || calls > 2 {
		t.Fatalf("deadline did not bound retries: calls=%d err=%v", calls, err)
	}
}

func TestMonthlyScoreboardLimitAppliesPerMonthNotMergedWindow(t *testing.T) {
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		month := req.URL.Query().Get("dates")
		events := make([]string, 600)
		for i := range events {
			events[i] = windowEvent(fmt.Sprintf("%s-%d", month, i), month[:4]+"-"+month[4:]+"-25T12:00Z", 2026)
		}
		return recoveryResponse(200, monthEnvelope("esp.1", events...)), nil
	})
	src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
	matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, false)
	if err != nil || len(matches) != 1200 {
		t.Fatalf("valid partitioned window rejected: count=%d err=%v", len(matches), err)
	}
}

func TestMonthlyScoreboardNewPollDoesNotReusePriorFacts(t *testing.T) {
	score := "0"
	calls := 0
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		calls++
		return partitionedTestResponse(req, strings.Replace(currentScoreboard, `"score":"0"`, `"score":"`+score+`"`, 1)), nil
	})
	src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
	for _, next := range []string{"0", "1"} {
		score = next
		matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, false)
		if err != nil || len(matches) != 1 || fmt.Sprint(*matches[0].HomeScore) != score {
			t.Fatalf("new polling timestamp would renew cached facts: matches=%v err=%v", matches, err)
		}
	}
	if calls != 4 {
		t.Fatalf("new observations must fetch again: calls=%d", calls)
	}
}

func TestMonthlyScoreboardRejectsOversizedResponseAndWindow(t *testing.T) {
	for _, aggregate := range []bool{false, true} {
		calls := 0
		src := recoverySource(func(*http.Request) (*http.Response, error) {
			calls++
			size := maxScoreboardBytes + 1
			if aggregate {
				size = maxScoreboardBytes/2 + 1
			}
			body := strings.Replace(monthEnvelope("esp.1"), `"events"`, `"padding":"`+strings.Repeat("x", size)+`","events"`, 1)
			return recoveryResponse(200, body), nil
		})
		src.now = func() time.Time { return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC) }
		_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, false)
		if err == nil || !strings.Contains(err.Error(), "bytes") {
			t.Fatalf("oversized response accepted: calls=%d err=%v", calls, err)
		}
	}
}

func TestMonthlyScoreboardRetryCeilingUsesRealClient(t *testing.T) {
	calls := 0
	src := NewESPN(espn.NewWithOptions(espn.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return recoveryResponse(429, "retry"), nil
		})}, BaseDelay: time.Nanosecond,
	}))
	_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, true)
	if err == nil || calls != 3 {
		t.Fatalf("retry budget=%d err=%v", calls, err)
	}
}

func TestMonthlyScoreboardWorstCasePhysicalAttempts(t *testing.T) {
	for _, backfill := range []bool{false, true} {
		t.Run(fmt.Sprint(backfill), func(t *testing.T) {
			attempts, calls := make(map[string]int), 0
			last, want := "202603", 12 // three rolling months plus fallback
			now := time.Date(2026, 2, 28, 0, 0, 0, 0, time.UTC)
			if backfill {
				last, want = "202701", 45 // fourteen full-season months plus fallback
			}
			src := recoverySource(func(req *http.Request) (*http.Response, error) {
				date := req.URL.Query().Get("dates")
				attempts[date]++
				calls++
				if attempts[date] < 3 {
					return recoveryResponse(503, "transient before final outcome"), nil
				}
				if date == last {
					return recoveryResponse(400, "selector rejected after transient failures"), nil
				}
				return recoveryResponse(200, monthEnvelope("esp.1")), nil
			})
			src.now = func() time.Time { return now }
			_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026"}, backfill)
			if !IsPartialScoreboard(err) || calls != want {
				t.Fatalf("physical attempts=%d want=%d err=%v", calls, want, err)
			}
		})
	}
}

func TestMonthlyScoreboardCacheRemainsBounded(t *testing.T) {
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		padding := strings.Repeat("x", maxScoreboardBytes/2)
		return recoveryResponse(200, `{"padding":"`+padding+`","events":[]}`), nil
	})
	for _, month := range []string{"202601", "202602", "202603"} {
		if _, err := src.get(context.Background(), espn.ScoreboardURLWithLimit("esp.1", month, 1000)); err != nil {
			t.Fatal(err)
		}
		total := 0
		for _, entry := range src.recent {
			total += len(entry.raw)
		}
		if total > maxScoreboardBytes {
			t.Fatalf("shared short cache grew to %d bytes", total)
		}
	}
}

func TestMonthlyScoreboardRejectsExcessiveSeasonBeforeRequests(t *testing.T) {
	calls := 0
	src := recoverySource(func(*http.Request) (*http.Response, error) {
		calls++
		return recoveryResponse(200, monthEnvelope("esp.1")), nil
	})
	_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026-28"}, true)
	if err == nil || calls != 0 {
		t.Fatalf("oversized season escaped preflight: calls=%d err=%v", calls, err)
	}
}

// A transport for existing mapper-focused adapter tests: model a provider's
// month partition while preserving all event fields consumed by either mapper.
func partitionedTestResponse(req *http.Request, body string) *http.Response {
	var envelope struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		panic(err)
	}
	var selected []string
	date := req.URL.Query().Get("dates")
	for _, event := range envelope.Events {
		var fields struct {
			Date string `json:"date"`
		}
		if err := json.Unmarshal(event, &fields); err != nil {
			panic(err)
		}
		if len(date) != 6 || len(fields.Date) < 7 || strings.ReplaceAll(fields.Date[:7], "-", "") == date {
			selected = append(selected, string(event))
		}
	}
	parts := strings.Split(req.URL.Path, "/")
	return recoveryResponse(200, monthEnvelope(parts[len(parts)-2], selected...))
}
