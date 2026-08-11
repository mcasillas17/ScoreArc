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

	_, err := src.Scoreboard(
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
	if gotURL != espnprovider.ScoreboardURLWithLimit(
		"eng.1", rollingScoreboardRange(time.Now()), scoreboardEventLimit,
	) {
		t.Fatalf("url=%q", gotURL)
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

func TestRollingScoreboardRange(t *testing.T) {
	now := time.Date(2026, time.August, 11, 12, 0, 0, 0, time.UTC)
	if got := rollingScoreboardRange(now); got != "20260712-20260818" {
		t.Fatalf("range=%q", got)
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
	)
	if err != nil {
		t.Fatal(err)
	}
	want := espnprovider.BracketURLWithLimit("fifa.world", dates, scoreboardEventLimit)
	if gotURL != want {
		t.Fatalf("url=%q want=%q", gotURL, want)
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
	); err == nil {
		t.Fatal("expected wrong-season bracket error")
	}
}
