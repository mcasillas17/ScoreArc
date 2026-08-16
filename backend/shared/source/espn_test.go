package source

import (
	"context"
	"io"
	"net/http"
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
