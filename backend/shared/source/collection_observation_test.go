package source

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestRosterExplicitEmptyObservationStillRequiresCompleteMatchingTeam(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		wantErr   bool
	}{
		{"explicit empty", `{"status":"success","team":{"id":"227"},"athletes":[]}`, false},
		{"missing athletes", `{"status":"success","team":{"id":"227"}}`, true},
		{"null athletes", `{"status":"success","team":{"id":"227"},"athletes":null}`, true},
		{"wrong team", `{"status":"success","team":{"id":"228"},"athletes":[]}`, true},
		{"truncated empty", `{"status":"success","team":{"id":"227"},"athletes":[],"truncated":true}`, true},
		{"short nonempty", `{"status":"success","team":{"id":"227"},"athletes":[{"id":"1","fullName":"Player"}]}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := espn.NewWithOptions(espn.Options{MaxAttempts: 1, HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(tc.raw))}, nil
			})}})
			got, err := NewESPN(client).Roster(context.Background(), config.Competition{ESPNSlug: "mex.1"}, "227")
			if (err != nil) != tc.wantErr {
				t.Fatalf("squad=%+v err=%v", got, err)
			}
		})
	}
}

func TestStatisticsObservationFetchKeepsRequestedSeasonScope(t *testing.T) {
	var urls []string
	client := espn.NewWithOptions(espn.Options{MaxAttempts: 1, HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		urls = append(urls, req.URL.String())
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"stats":[]}`))}, nil
	})}})
	for _, id := range []string{"2025-26", "2026-27"} {
		if _, err := NewESPN(client).Statistics(context.Background(), config.Competition{ESPNSlug: "eng.1"}, config.Season{ID: id}); err != nil {
			t.Fatal(err)
		}
	}
	if len(urls) != 2 || !strings.Contains(urls[0], "season=2025") || !strings.Contains(urls[1], "season=2026") {
		t.Fatalf("season source URLs = %v", urls)
	}
}
