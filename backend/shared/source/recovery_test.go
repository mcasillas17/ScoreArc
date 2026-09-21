package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	espnprovider "github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestESPNMonth400ReturnsValidatedCurrentMatchesWithError(t *testing.T) {
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	var dates []string
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		date := req.URL.Query().Get("dates")
		dates = append(dates, date)
		if len(date) == 6 {
			return recoveryResponse(400, `{"error":"Failed to get events endpoint."}`), nil
		}
		return recoveryResponse(200, fmt.Sprintf(`{"leagues":[{"slug":"esp.1"}],"events":[{
			"id":"current","date":%q,"season":{"year":%d,"slug":"regular-season"},
			"status":{"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false}},
			"competitions":[{"competitors":[
				{"homeAway":"home","team":{"id":"96","displayName":"Home"},"score":"0"},
				{"homeAway":"away","team":{"id":"94","displayName":"Away"},"score":"1"}
			]}]}]}`, now.Format(time.RFC3339), now.Year())), nil
	})
	src.now = func() time.Time { return now }
	matches, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "esp.1"},
		config.Season{ID: fmt.Sprint(now.Year())}, false)
	if err == nil {
		t.Fatal("partial coverage must retain the range failure")
	}
	if len(matches) != 1 || matches[0].ID != "current" {
		t.Fatalf("range 400 yielded no validated current events: matches=%+v err=%v", matches, err)
	}
	if len(dates) != 2 || len(dates[0]) != 6 || dates[1] != now.Format("20060102") {
		t.Fatalf("requests=%v, want month then one current UTC date", dates)
	}
}

func TestESPNRecoverMatchObservesFinalFromLiveInput(t *testing.T) {
	calls := 0
	src := recoverySource(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.String() != espnprovider.SummaryURL("esp.1", "401882876") {
			t.Errorf("unexpected URL %s", req.URL)
		}
		return recoveryResponse(200, recoverySummary), nil
	})
	input := recoveryMatch()
	match, summary, err := recoverMatch(t, src, context.Background(),
		config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026-27"}, input)
	if err != nil {
		t.Fatal(err)
	}
	if match.State != model.MatchStateFinished || match.StatusName != "STATUS_FULL_TIME" ||
		match.HomeScore == nil || *match.HomeScore != 0 || match.AwayScore == nil || *match.AwayScore != 1 ||
		match.Minute != nil {
		t.Fatalf("not a fresh provider final: %+v", match)
	}
	if summary.HomeScore == nil || *summary.HomeScore != 0 ||
		summary.AwayScore == nil || *summary.AwayScore != 1 || summary.Detail.Info == nil {
		t.Fatalf("missing reused final summary: %+v", summary)
	}
	if calls != 1 {
		t.Fatalf("summary fetched %d times", calls)
	}
	if !reflect.DeepEqual(match.Home, input.Home) || !reflect.DeepEqual(match.Away, input.Away) ||
		match.Round != input.Round || match.BracketRequired != input.BracketRequired || match.BracketConfirmed {
		t.Fatalf("stable identity/bracket metadata changed: %+v", match)
	}
	if match.WinnerID == nil || *match.WinnerID != "94" {
		t.Fatalf("explicit provider winner lost: %+v", match)
	}
}

func TestESPNRecoverMatchRejectsUntrustedObservation(t *testing.T) {
	for _, tc := range []struct {
		name string
		old  string
		new  string
	}{
		{"event", `"header":{"id":"401882876"`, `"header":{"id":"other"`},
		{"competition", `"competitions":[{"id":"401882876"`, `"competitions":[{"id":"other"`},
		{"missing event", `"header":{"id":"401882876",`, `"header":{`},
		{"league", `"slug":"esp.1"`, `"slug":"eng.1"`},
		{"missing league", `"league":{"slug":"esp.1"}`, `"league":null`},
		{"season", `"year":2026`, `"year":2025`},
		{"missing season", `"season":{"year":2026}`, `"season":null`},
		{"swapped home away", `"homeAway":"home"`, `"homeAway":"away"`},
		{"home team", `"id":"96"`, `"id":"94"`},
		{"away team", `"id":"94"`, `"id":"other"`},
		{"third competitor", `"competitors":[`, `"competitors":[{"homeAway":"home","team":{"id":"extra"}},`},
		{"date", `"2026-09-15T19:00Z"`, `"not-a-date"`},
		{"missing date", `"date":"2026-09-15T19:00Z",`, ``},
		{"outside season", `"2026-09-15T19:00Z"`, `"2027-07-01T00:00Z"`},
		{"before season", `"2026-09-15T19:00Z"`, `"2026-06-30T23:59Z"`},
		{"missing status", `"status":`, `"ignoredStatus":`},
		{"null status", `"status":{"type":{"name":"STATUS_FULL_TIME","state":"post","completed":true,"shortDetail":"FT"}}`, `"status":null`},
		{"null type", `"status":{"type":{"name":"STATUS_FULL_TIME","state":"post","completed":true,"shortDetail":"FT"}}`, `"status":{"type":null}`},
		{"malformed type", `"status":{"type":{"name":"STATUS_FULL_TIME","state":"post","completed":true,"shortDetail":"FT"}}`, `"status":{"type":[]}`},
		{"missing state", `"state":"post",`, ``},
		{"unknown state", `"state":"post"`, `"state":"unknown"`},
		{"missing name", `"name":"STATUS_FULL_TIME",`, ``},
		{"missing completion", `"completed":true,`, ``},
		{"null completion", `"completed":true`, `"completed":null`},
		{"wrong completion type", `"completed":true`, `"completed":"true"`},
		{"final incomplete", `"completed":true`, `"completed":false`},
		{"completed active", `"state":"post"`, `"state":"in"`},
		{"completed scheduled", `"state":"post"`, `"state":"pre"`},
		{"completed live name", `"name":"STATUS_FULL_TIME"`, `"name":"STATUS_IN_PROGRESS"`},
		{"completed suspended", `"name":"STATUS_FULL_TIME"`, `"name":"STATUS_SUSPENDED"`},
		{"completed postponed", `"name":"STATUS_FULL_TIME"`, `"name":"STATUS_POSTPONED"`},
		{"missing score", `"score":"0",`, ``},
		{"null score", `"score":"0"`, `"score":null`},
		{"empty score", `"score":"0"`, `"score":""`},
		{"negative score", `"score":"0"`, `"score":"-1"`},
		{"fractional score", `"score":"0"`, `"score":"1.5"`},
		{"malformed score", `"score":"0"`, `"score":{}`},
		{"two winners", `"winner":false`, `"winner":true`},
		{"no final detail", `"gameInfo":{"venue":{"fullName":"Test stadium"}}`, `"gameInfo":{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := strings.Replace(recoverySummary, tc.old, tc.new, 1)
			if raw == recoverySummary {
				t.Fatal("test mutation did not apply")
			}
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, raw), nil
			})
			match, _, err := recoverMatch(t, src, context.Background(),
				config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026-27"}, recoveryMatch())
			if err == nil || match.ID != "" {
				t.Fatalf("untrusted observation accepted: match=%+v err=%v", match, err)
			}
		})
	}
}

func TestESPNRecoverMatchMutableAndTerminalStatuses(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		completed   bool
		want        model.MatchState
		scores      bool
	}{
		{"STATUS_IN_PROGRESS", "in", false, model.MatchStateLive, true},
		{"STATUS_HALFTIME", "in", false, model.MatchStateLive, true},
		{"STATUS_SCHEDULED", "pre", false, model.MatchStateScheduled, false},
		{"STATUS_POSTPONED", "post", false, model.MatchStateScheduled, false},
		{"STATUS_SUSPENDED", "in", false, model.MatchStateScheduled, false},
		{"STATUS_SUSPENDED", "post", false, model.MatchStateScheduled, false},
		{"STATUS_CANCELED", "post", true, model.MatchStateFinished, false},
		{"STATUS_CANCELED", "post", false, model.MatchStateFinished, false},
		{"STATUS_ABANDONED", "post", true, model.MatchStateFinished, false},
		{"STATUS_FORFEIT", "post", true, model.MatchStateFinished, false},
	} {
		t.Run(tc.name+"/"+tc.state+fmt.Sprint(tc.completed), func(t *testing.T) {
			raw := strings.ReplaceAll(recoverySummary, "STATUS_FULL_TIME", tc.name)
			raw = strings.ReplaceAll(raw, `"state":"post"`, fmt.Sprintf(`"state":%q`, tc.state))
			raw = strings.ReplaceAll(raw, `"completed":true`, fmt.Sprintf(`"completed":%t`, tc.completed))
			raw = strings.ReplaceAll(raw, `"status":{"type":`, `"status":{"displayClock":"88'","type":`)
			raw = strings.ReplaceAll(raw, `"gameInfo":{"venue":{"fullName":"Test stadium"}}`, `"gameInfo":null`)
			raw = strings.ReplaceAll(raw, `,"winner":true`, ``)
			if !tc.scores {
				raw = strings.ReplaceAll(raw, `"score":"0",`, ``)
				raw = strings.ReplaceAll(raw, `,"score":"1"`, ``)
			}
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				return recoveryResponse(200, raw), nil
			})
			// A stale input's finality and winner are never authority.
			input := recoveryMatch()
			input.State, input.WinnerID, input.BracketConfirmed = model.MatchStateFinished, &input.Home.ID, true
			match, _, err := recoverMatch(t, src, context.Background(),
				config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026-27"}, input)
			if err != nil {
				t.Fatal(err)
			}
			if match.State != tc.want || match.StatusName != tc.name || match.WinnerID != nil || match.BracketConfirmed {
				t.Fatalf("stale candidate leaked into observation: %+v", match)
			}
			if tc.want == model.MatchStateLive && (match.Minute == nil || *match.Minute != "88'") {
				t.Fatalf("live clock missing: %+v", match)
			}
			if !tc.scores && (match.HomeScore != nil || match.AwayScore != nil) {
				t.Fatalf("stale scores retained: %+v", match)
			}
		})
	}
}

func TestESPNRecoverMatchRescheduledClausura(t *testing.T) {
	raw := strings.ReplaceAll(recoverySummary, "2026-09-15T19:00Z", "2027-06-30T23:59Z")
	raw = strings.ReplaceAll(raw, `"slug":"esp.1"`, `"slug":"mex.1"`)
	src := recoverySource(func(*http.Request) (*http.Response, error) {
		return recoveryResponse(200, raw), nil
	})
	match, _, err := recoverMatch(t, src, context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, config.Season{ID: "2027-clausura"}, recoveryMatch())
	if err != nil || match.Kickoff != "2027-06-30T23:59:00Z" {
		t.Fatalf("rescheduled Clausura match=%+v err=%v", match, err)
	}
}

func TestESPNRecoverMatchReusesRecordedSummary(t *testing.T) {
	raw, err := os.ReadFile("../espn/testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	src := recoverySource(func(*http.Request) (*http.Response, error) {
		calls++
		return recoveryResponse(200, string(raw)), nil
	})
	input := model.Match{ID: "760490", State: model.MatchStateLive,
		Home: model.Team{ID: "4789"}, Away: model.Team{ID: "464"}}
	match, result, err := recoverMatch(t, src, context.Background(),
		config.Competition{ESPNSlug: "fifa.world"}, config.Season{ID: "2026"}, input)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || match.State != model.MatchStateFinished ||
		len(result.Commentary) != 91 || result.Participation == nil || len(result.Participation.Home) == 0 {
		t.Fatalf("summary not reused: calls=%d match=%+v result=%+v", calls, match, result)
	}
}

func TestESPNRecoverMatchShootoutScoresStaySeparate(t *testing.T) {
	raw := strings.ReplaceAll(recoverySummary, "STATUS_FULL_TIME", "STATUS_FINAL_PEN")
	raw = strings.ReplaceAll(raw, `"score":"0"`, `"score":"1","shootoutScore":"4"`)
	raw = strings.ReplaceAll(raw, `"score":"1","winner":true`, `"score":"1","shootoutScore":"5","winner":true`)
	src := recoverySource(func(*http.Request) (*http.Response, error) {
		return recoveryResponse(200, raw), nil
	})
	match, result, err := recoverMatch(t, src, context.Background(),
		config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026-27"}, recoveryMatch())
	if err != nil {
		t.Fatal(err)
	}
	if *match.HomeScore != 1 || *match.AwayScore != 1 || *result.HomeScore != 1 || *result.AwayScore != 1 ||
		result.Detail.Shootout == nil || result.Detail.Shootout.HomeScore != 4 || result.Detail.Shootout.AwayScore != 5 {
		t.Fatalf("shootout contaminated regulation scores: match=%+v summary=%+v", match, result)
	}
}

func TestESPNRecoverMatchFailuresRemainExplicitAndBounded(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		err      error
		attempts int
	}{
		{"400", 400, "Bad request", nil, 1},
		{"500", 500, "Unavailable", nil, 3},
		{"timeout", 0, "", context.DeadlineExceeded, 3},
		{"malformed", 200, "{", nil, 1},
		{"null", 200, "null", nil, 1},
		{"missing", 200, "{}", nil, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			src := recoverySource(func(*http.Request) (*http.Response, error) {
				calls++
				if tc.err != nil {
					return nil, tc.err
				}
				return recoveryResponse(tc.status, tc.body), nil
			})
			match, _, err := recoverMatch(t, src, context.Background(),
				config.Competition{ESPNSlug: "esp.1"}, config.Season{ID: "2026-27"}, recoveryMatch())
			if err == nil || match.ID != "" || calls != tc.attempts {
				t.Fatalf("calls=%d match=%+v err=%v", calls, match, err)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("lost cause: %v", err)
			}
		})
	}
}

func TestESPNRecoverMatchRejectsInvalidRequestBeforeFetching(t *testing.T) {
	src := recoverySource(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid request reached provider")
		return nil, nil
	})
	for _, tc := range []struct {
		slug, season string
		match        model.Match
	}{
		{"", "2026-27", recoveryMatch()},
		{"esp.1", "invalid", recoveryMatch()},
		{"esp.1", "2026-27", model.Match{}},
	} {
		if _, _, err := recoverMatch(t, src, context.Background(),
			config.Competition{ESPNSlug: tc.slug}, config.Season{ID: tc.season}, tc.match); err == nil {
			t.Fatal("invalid request succeeded")
		}
	}
}

func recoverMatch(t *testing.T, src *ESPN, ctx context.Context, comp config.Competition,
	season config.Season, match model.Match) (model.Match, SummaryResult, error) {
	t.Helper()
	return src.RecoverMatch(ctx, comp, season, match)
}

const recoverySummary = `{
	"header":{"id":"401882876","league":{"slug":"esp.1"},"season":{"year":2026},
		"competitions":[{"id":"401882876","date":"2026-09-15T19:00Z",
			"status":{"type":{"name":"STATUS_FULL_TIME","state":"post","completed":true,"shortDetail":"FT"}},
			"competitors":[
				{"homeAway":"home","team":{"id":"96"},"score":"0","winner":false},
				{"homeAway":"away","team":{"id":"94"},"score":"1","winner":true}
			]}]},
	"gameInfo":{"venue":{"fullName":"Test stadium"}}
}`

func recoveryMatch() model.Match {
	zero, required, minute := 0, true, "15'"
	return model.Match{
		ID: "401882876", Kickoff: "2026-09-15T19:00:00Z", State: model.MatchStateLive,
		StatusName: "STATUS_IN_PROGRESS", Minute: &minute,
		Home:      model.Team{ID: "96", Name: "Home", Abbr: "HOM"},
		Away:      model.Team{ID: "94", Name: "Away", Abbr: "AWY"},
		HomeScore: &zero, AwayScore: &zero, Round: "quarterfinal",
		BracketRequired: &required,
	}
}

func recoverySource(transport roundTripFunc) *ESPN {
	return NewESPN(espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: transport}, BaseDelay: time.Nanosecond,
	}))
}

func recoveryResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
