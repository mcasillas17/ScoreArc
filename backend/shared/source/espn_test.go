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

func TestCurrentWeekRange(t *testing.T) {
	got := currentWeekRange(time.Date(2026, time.August, 12, 12, 0, 0, 0, time.UTC))
	if got != "20260810-20260816" {
		t.Fatalf("range=%q", got)
	}
}

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
	if gotURL != espnprovider.ScoreboardURL("eng.1", currentWeekRange(time.Now())) {
		t.Fatalf("url=%q", gotURL)
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
