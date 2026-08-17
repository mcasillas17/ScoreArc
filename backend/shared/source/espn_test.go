package source

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	espnprovider "github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestESPNScoreboardBuildsProviderURL(t *testing.T) {
	var gotURL string
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotURL = req.URL.String()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"events":[]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	src := NewESPN(client)

	before, err := rollingSeasonRange(time.Now(), "2026")
	if err != nil {
		t.Fatal(err)
	}
	_, err = src.Scoreboard(
		context.Background(),
		config.Competition{ESPNSlug: "eng.1"},
		config.Season{ID: "2026"},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}

	if src.Name() != "espn" {
		t.Fatalf("name=%q", src.Name())
	}
	after, err := rollingSeasonRange(time.Now(), "2026")
	if err != nil {
		t.Fatal(err)
	}
	beforeURL := espnprovider.ScoreboardURLWithLimit("eng.1", before, scoreboardEventLimit)
	afterURL := espnprovider.ScoreboardURLWithLimit("eng.1", after, scoreboardEventLimit)
	if gotURL != beforeURL && gotURL != afterURL {
		t.Fatalf("url=%q want=%q or %q", gotURL, beforeURL, afterURL)
	}

}

func TestESPNScoreboardRejectsLimitSizedRollingResponse(t *testing.T) {
	body := `{"events":[` + strings.Repeat(`{},`, scoreboardEventLimit-1) + `{}` + `]}`
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(body)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	if _, err := NewESPN(client).Scoreboard(
		context.Background(),
		config.Competition{ESPNSlug: "eng.1"},
		config.Season{ID: "2026"},
		false,
	); err == nil {
		t.Fatal("expected truncated rolling scoreboard error")
	}
}

func TestESPNRosterRejectsImplausiblyShortSuccess(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(`{
					"status":"success",
					"team":{"id":"227"},
					"athletes":[{"id":"p1","fullName":"Only Player"}]
				}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	if _, err := NewESPN(client).Roster(
		context.Background(),
		config.Competition{ESPNSlug: "mex.1"},
		"227",
	); err == nil {
		t.Fatal("expected implausibly short roster to fail")
	}
}

func TestESPNAthleteBioRejectsMissingHistoryEnvelope(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	if _, err := NewESPN(client).AthleteBio(
		context.Background(),
		config.Competition{ESPNSlug: "mex.1"},
		"297287",
	); err == nil {
		t.Fatal("expected missing teamHistory envelope to fail")
	}
}

func TestESPNAthleteBioAcceptsExplicitEmptyHistory(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"teamHistory":[]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	entries, err := NewESPN(client).AthleteBio(
		context.Background(),
		config.Competition{ESPNSlug: "mex.1"},
		"297287",
	)
	if err != nil {
		t.Fatal(err)
	}
	if entries == nil || len(entries) != 0 {
		t.Fatalf("explicit empty history = %#v, want non-nil empty slice", entries)
	}
}

func TestESPNRollingScoreboardFiltersForeignSeason(t *testing.T) {
	body := `{"events":[
		{"id":"old","date":"2025-12-31T12:00:00Z","season":{"year":2025,"slug":"regular-season"},
		 "status":{"type":{"state":"post","completed":true}},
		 "competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"old-home","displayName":"Old Home","abbreviation":"OHO"}},
			{"homeAway":"away","team":{"id":"old-away","displayName":"Old Away","abbreviation":"OAW"}}
		 ]}]},
		{"id":"current","date":"2026-01-01T12:00:00Z","season":{"year":2026,"slug":"regular-season"},
		 "status":{"type":{"state":"pre","completed":false}},
		 "competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"home","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","team":{"id":"away","displayName":"Away","abbreviation":"AWY"}}
		 ]}]}
	]}`
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(body)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	matches, err := NewESPN(client).Scoreboard(
		context.Background(),
		config.Competition{ESPNSlug: "eng.1"},
		config.Season{ID: "2026"},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].ID != "current" {
		t.Fatalf("matches=%+v", matches)
	}
}

func TestESPNBackfillRejectsForeignSeason(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"events":[{"id":"old","season":{"year":2025}}]}`,
				)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	if _, err := NewESPN(client).Scoreboard(
		context.Background(),
		config.Competition{ESPNSlug: "eng.1"},
		config.Season{ID: "2026"},
		true,
	); err == nil {
		t.Fatal("expected foreign-season backfill error")
	}
}

func TestRollingScoreboardRange(t *testing.T) {
	now := time.Date(2026, time.August, 11, 12, 0, 0, 0, time.UTC)
	if got := rollingScoreboardRange(now); got != "20260712-20260818" {
		t.Fatalf("range=%q", got)
	}
}

func TestRollingSeasonRangeClampsSplitSeason(t *testing.T) {
	now := time.Date(2025, time.January, 10, 12, 0, 0, 0, time.UTC)
	got, err := rollingSeasonRange(now, "2025-clausura")
	if err != nil || got != "20250101-20250117" {
		t.Fatalf("range=%q err=%v", got, err)
	}
}

func TestFullSeasonRange(t *testing.T) {
	for _, test := range []struct {
		season string
		want   string
	}{
		{season: "2026", want: "20260101-20261231"},
		{season: "2026-27", want: "20260701-20270630"},
		{season: "2026-apertura", want: "20260701-20261231"},
		{season: "2026-clausura", want: "20260101-20260630"},
	} {
		got, err := fullSeasonRange(test.season)
		if err != nil || got != test.want {
			t.Fatalf("season %q range=%q err=%v", test.season, got, err)
		}

	}
}

func TestSeasonStartYearHandlesClausura(t *testing.T) {
	got, err := seasonStartYear("2027-clausura")
	if err != nil || got != 2026 {
		t.Fatalf("year=%d err=%v", got, err)
	}
}

func TestESPNSummaryRejectsPayloadWithoutTeams(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"header":{"competitions":[]}}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	_, err := NewESPN(client).Summary(
		context.Background(),
		config.Competition{ESPNSlug: "eng.1"},
		model.Match{
			ID: "match-1", State: model.MatchStateFinished,
			Home: model.Team{ID: "home"}, Away: model.Team{ID: "away"},
		},
	)
	if err == nil {
		t.Fatal("expected malformed summary error")
	}
}

func TestESPNSummaryReturnsStructuredCommentary(t *testing.T) {
	raw, err := os.ReadFile("../espn/testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewReader(raw)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	result, err := NewESPN(client).Summary(
		context.Background(),
		config.Competition{ESPNSlug: "fifa.world"},
		model.Match{
			ID: "760490", State: model.MatchStateFinished,
			Home: model.Team{ID: "4789"}, Away: model.Team{ID: "464"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Commentary) != 91 {
		t.Fatalf("commentary lines = %d, want 91", len(result.Commentary))
	}
	if result.Commentary[0].Seq != 0 || result.Commentary[1].PlayType != "kickoff" {
		t.Fatalf("first structured lines = %#v, %#v", result.Commentary[0], result.Commentary[1])
	}
}

func TestESPNBracketUsesExplicitLimit(t *testing.T) {
	var gotURL string
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotURL = req.URL.String()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"events":[]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	dates := "20260601-20260731"
	_, err := NewESPN(client).Bracket(
		context.Background(),
		config.Competition{ESPNSlug: "fifa.world"},
		config.Season{ID: "2026", BracketDatesRange: &dates},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := espnprovider.BracketURLWithLimit("fifa.world", dates, scoreboardEventLimit)
	if gotURL != want {
		t.Fatalf("url=%q want=%q", gotURL, want)
	}
}

func TestESPNBracketBackfillUsesFullSeasonWithoutConfiguredRange(t *testing.T) {
	var gotURL string
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotURL = req.URL.String()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"events":[]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	_, err := NewESPN(client).Bracket(
		context.Background(),
		config.Competition{ESPNSlug: "concacaf.leagues.cup"},
		config.Season{ID: "2026"},
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := espnprovider.BracketURLWithLimit(
		"concacaf.leagues.cup", "20260101-20261231", scoreboardEventLimit,
	)
	if gotURL != want {
		t.Fatalf("url=%q want=%q", gotURL, want)
	}
}

func TestESPNBracketUsesRollingWindowWithoutConfiguredRange(t *testing.T) {
	var gotURL string
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotURL = req.URL.String()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"events":[]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	before, err := rollingSeasonRange(time.Now(), "2026")
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewESPN(client).Bracket(
		context.Background(),
		config.Competition{ESPNSlug: "concacaf.leagues.cup"},
		config.Season{ID: "2026"},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	after, err := rollingSeasonRange(time.Now(), "2026")
	if err != nil {
		t.Fatal(err)
	}
	beforeURL := espnprovider.BracketURLWithLimit(
		"concacaf.leagues.cup", before, scoreboardEventLimit,
	)
	afterURL := espnprovider.BracketURLWithLimit(
		"concacaf.leagues.cup", after, scoreboardEventLimit,
	)
	if gotURL != beforeURL && gotURL != afterURL {
		t.Fatalf("url=%q want=%q or %q", gotURL, beforeURL, afterURL)
	}
}

func TestESPNRollingBracketFiltersForeignSeason(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"events":[{"id":"old","season":{"year":2025}}]}`,
				)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	matches, err := NewESPN(client).Bracket(
		context.Background(),
		config.Competition{ESPNSlug: "concacaf.leagues.cup"},
		config.Season{ID: "2026"},
		false,
	)
	if err != nil || len(matches) != 0 {
		t.Fatalf("matches=%+v err=%v", matches, err)
	}
}

func TestESPNReusesIdenticalScoreboardForBracket(t *testing.T) {
	requests := 0
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			requests++
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"events":[]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	src := NewESPN(client)
	comp := config.Competition{ESPNSlug: "concacaf.leagues.cup"}
	season := config.Season{ID: "2026"}
	if _, err := src.Scoreboard(context.Background(), comp, season, false); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Bracket(context.Background(), comp, season, false); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("requests=%d", requests)
	}
}

func TestESPNNonBracketSeasonClearsProviderRoundClassification(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(`{"events":[{
					"id":"league-match","date":"2026-05-01T19:00:00Z",
					"season":{"year":2025,"slug":"2025-26-english-premier-league"},
					"status":{"type":{"state":"post","completed":true}},
					"competitions":[{"competitors":[
						{"homeAway":"home","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
						{"homeAway":"away","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
					]}]}]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	matches, err := NewESPN(client).Scoreboard(
		context.Background(),
		config.Competition{ESPNSlug: "eng.1"},
		config.Season{ID: "2025-26", HasBracket: false},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].BracketRequired == nil ||
		*matches[0].BracketRequired || !matches[0].BracketConfirmed {
		t.Fatalf("matches=%+v", matches)
	}
}

func TestESPNBracketRejectsWrongSeason(t *testing.T) {
	client := espnprovider.NewWithOptions(espnprovider.Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"events":[{"season":{"year":2022}}]}`)),
			}, nil
		})},
		MaxAttempts: 1,
	})
	if _, err := NewESPN(client).Bracket(
		context.Background(),
		config.Competition{ESPNSlug: "fifa.world"},
		config.Season{ID: "2026"},
		true,
	); err == nil {
		t.Fatal("expected wrong-season bracket error")
	}
}

// A fresh match is 1,542 plays at a 1,000 cap. A fetcher that stops after page
// one loses 542 of them -- including, since the stream is chronological, most
// of the second half.
func TestPlaysFollowsEveryPage(t *testing.T) {
	var requested []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Query().Get("page"))
		page := r.URL.Query().Get("page")
		items := `{"id":"a","type":{"id":"1","text":"Pass","type":"pass"},"period":{"number":1},"clock":{"value":0,"displayValue":""}}`
		if page == "2" {
			items = `{"id":"b","type":{"id":"2","text":"Goal","type":"goal"},"period":{"number":2},"clock":{"value":60,"displayValue":"60'"},"scoringPlay":true}`
		}
		fmt.Fprintf(w, `{"count":2,"pageIndex":%s,"pageSize":1000,"pageCount":2,"items":[%s]}`, page, items)
	}))
	defer server.Close()

	source := NewESPNWithBase(espnprovider.New(), server.URL)
	stream, raw, err := source.Plays(context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, "401877018")
	if err != nil {
		t.Fatal(err)
	}
	if len(requested) != 2 || requested[0] != "1" || requested[1] != "2" {
		t.Fatalf("requested pages %v, want [1 2]", requested)
	}
	if len(stream.Plays) != 2 {
		t.Fatalf("plays = %d, want 2 -- page two was dropped", len(stream.Plays))
	}
	// Sequence must continue across the page boundary, not restart.
	if stream.Plays[1].Seq <= stream.Plays[0].Seq {
		t.Fatalf("seq = %d then %d; page two restarted the ordinal",
			stream.Plays[0].Seq, stream.Plays[1].Seq)
	}
	if len(raw) == 0 {
		t.Fatal("no raw bytes returned; there would be nothing to archive")
	}
}

// The silent-degradation guard. If ESPN ever changes its default page size,
// asking for 1000 and being handed 25 turns one cycle into 62x the requests
// with nothing in the logs. Fail loudly instead.
func TestPlaysRefusesAnUnexpectedPageSize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"count":1542,"pageIndex":1,"pageSize":25,"pageCount":62,"items":[]}`)
	}))
	defer server.Close()

	_, _, err := NewESPNWithBase(espnprovider.New(), server.URL).Plays(context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, "401877018")
	if err == nil {
		t.Fatal("want an error when the provider ignores the requested page size")
	}
	if !strings.Contains(err.Error(), "page size") {
		t.Fatalf("err = %v, want it to name the page size", err)
	}
}

// A match with no stream is not an error. Plenty of competitions have none --
// CONCACAF Champions Cup returned 55 plays where Liga MX returned 1,542, and
// some will return zero.
func TestPlaysAcceptsAnEmptyStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// This is the provider's real empty envelope, recorded from canceled
		// MLS event 760078 on 2026-08-16.
		fmt.Fprint(w, `{"count":0,"pageIndex":0,"pageSize":25,"pageCount":0,"items":[]}`)
	}))
	defer server.Close()

	stream, _, err := NewESPNWithBase(espnprovider.New(), server.URL).Plays(context.Background(),
		config.Competition{ESPNSlug: "concacaf.champions"}, "1")
	if err != nil {
		t.Fatalf("an empty stream must not be an error: %v", err)
	}
	if len(stream.Plays) != 0 {
		t.Fatalf("plays = %d, want 0", len(stream.Plays))
	}
}

func TestPlaysRejectsATruncatedAggregate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		items := `{"id":"a","type":{"id":"1","text":"Pass","type":"pass"}}`
		if page == "2" {
			items = ""
		}
		fmt.Fprintf(w,
			`{"count":2,"pageIndex":%s,"pageSize":1000,"pageCount":2,"items":[%s]}`,
			page, items)
	}))
	defer server.Close()

	_, _, err := NewESPNWithBase(espnprovider.New(), server.URL).Plays(
		context.Background(), config.Competition{ESPNSlug: "mex.1"}, "1")
	if err == nil || !strings.Contains(err.Error(), "expected 2 plays") {
		t.Fatalf("err = %v, want aggregate truncation", err)
	}
}

func TestPlaysRejectsDuplicateProviderIDsAcrossPages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		fmt.Fprintf(w,
			`{"count":2,"pageIndex":%s,"pageSize":1000,"pageCount":2,"items":[`+
				`{"id":"duplicate","type":{"id":"1","text":"Pass","type":"pass"}}]}`,
			page)
	}))
	defer server.Close()

	_, _, err := NewESPNWithBase(espnprovider.New(), server.URL).Plays(
		context.Background(), config.Competition{ESPNSlug: "mex.1"}, "1")
	if err == nil || !strings.Contains(err.Error(), "duplicate play id") {
		t.Fatalf("err = %v, want duplicate provider id", err)
	}
}

func TestPlaysRefusesAMismatchedPageIndex(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"count":1,"pageIndex":2,"pageSize":1000,"pageCount":2,"items":[]}`)
	}))
	defer server.Close()

	_, _, err := NewESPNWithBase(espnprovider.New(), server.URL).Plays(context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, "1")
	if err == nil || !strings.Contains(err.Error(), "page index") {
		t.Fatalf("err = %v, want page index mismatch", err)
	}
}

func TestPlaysRefusesARunawayPageCountBeforeFollowingIt(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		fmt.Fprint(w, `{"count":11000,"pageIndex":1,"pageSize":1000,"pageCount":11,"items":[]}`)
	}))
	defer server.Close()

	_, _, err := NewESPNWithBase(espnprovider.New(), server.URL).Plays(context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, "1")
	if err == nil || !strings.Contains(err.Error(), "sane bound") {
		t.Fatalf("err = %v, want page-count bound", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1 before rejecting runaway pagination", requests)
	}
}

func TestPlaysRejectsMissingIdentifiersWithoutARequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer server.Close()

	source := NewESPNWithBase(espnprovider.New(), server.URL)
	for _, test := range []struct {
		name    string
		comp    config.Competition
		eventID string
	}{
		{name: "competition slug", eventID: "1"},
		{name: "event id", comp: config.Competition{ESPNSlug: "mex.1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := source.Plays(context.Background(), test.comp, test.eventID)
			if err == nil {
				t.Fatal("want missing identifier to fail")
			}
		})
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want no request for invalid identifiers", requests)
	}
}
