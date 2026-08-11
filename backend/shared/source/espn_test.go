package source

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	espnprovider "github.com/mcasillas17/scorearc-backend/shared/espn"
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

	_, err := src.Scoreboard(context.Background(), config.Competition{ESPNSlug: "eng.1"}, config.Season{})
	if err != nil {
		t.Fatal(err)
	}
	if src.Name() != "espn" {
		t.Fatalf("name=%q", src.Name())
	}
	if gotURL != espnprovider.ScoreboardURL("eng.1", "") {
		t.Fatalf("url=%q", gotURL)
	}
}
