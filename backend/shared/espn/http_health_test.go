package espn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPHealthCountsResponsesRetriesRedirectsAndInvalidJSON(t *testing.T) {
	var buf bytes.Buffer
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/scoreboard") {
			http.Redirect(w, r, "/private-redirect", http.StatusFound)
			return
		}
		calls++
		if calls == 1 {
			w.WriteHeader(503)
			_, _ = io.WriteString(w, "secret-raw")
			return
		}
		_, _ = io.WriteString(w, "{")
	}))
	defer server.Close()
	client := NewWithOptions(Options{HTTP: server.Client(), MaxAttempts: 2, BaseDelay: time.Millisecond, HTTPLog: slog.New(slog.NewJSONHandler(&buf, nil)).With("service", "ingester")})
	err := client.GetJSON(context.Background(), server.URL+"/secret-team/scoreboard?secret=query", &map[string]any{})
	if err == nil {
		t.Fatal("invalid JSON was accepted")
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("got %d HTTP observations: %s", len(lines), buf.String())
	}
	for n, expected := range []struct {
		status  int
		outcome string
	}{{302, "success"}, {503, "http_error"}, {302, "success"}, {200, "body"}} {
		var got map[string]any
		if err := json.Unmarshal([]byte(lines[n]), &got); err != nil {
			t.Fatal(err)
		}
		if got["event"] != "scorearc_http" || got["direction"] != "outbound" || got["dependency"] != "espn" || got["endpoint"] != "scoreboard" || got["method"] != "GET" || got["status"] != float64(expected.status) || got["outcome"] != expected.outcome || got["attempt"] != float64(n/2+1) || got["durationMs"] == nil || got["time"] == nil {
			t.Errorf("event %d = %#v", n, got)
		}
	}
	if strings.Contains(buf.String(), "secret") || strings.Contains(buf.String(), "private-redirect") || strings.Contains(buf.String(), server.URL) {
		t.Fatal("raw address, ID or body leaked")
	}
}

func TestHTTPHealthRejectedRedirect(t *testing.T) {
	var buf bytes.Buffer
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/rejected", http.StatusFound)
	}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	c := NewWithOptions(Options{HTTP: client, MaxAttempts: 1, HTTPLog: slog.New(slog.NewJSONHandler(&buf, nil))})
	if err := c.GetJSON(context.Background(), server.URL+"/news", &map[string]any{}); err == nil {
		t.Fatal("expected terminal redirect to fail")
	}
	var got map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil || got["status"] != float64(302) || got["outcome"] != "redirect" {
		t.Fatalf("event=%s err=%v", buf.Bytes(), err)
	}
}

func TestHTTPHealthNetworkAndSuccessfulResponse(t *testing.T) {
	var buf bytes.Buffer
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "{}") }))
	defer server.Close()
	c := NewWithOptions(Options{HTTP: server.Client(), MaxAttempts: 1, HTTPLog: slog.New(slog.NewJSONHandler(&buf, nil))})
	var v map[string]any
	if err := c.GetJSON(context.Background(), server.URL+"/news", &v); err != nil {
		t.Fatal(err)
	}
	server.Close()
	if err := c.GetJSON(context.Background(), server.URL+"/news", &v); err == nil {
		t.Fatal("expected connection error")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.GetJSON(ctx, server.URL+"/news", &v); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	var records []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		records = append(records, row)
	}
	if len(records) != 2 || records[0]["bytes"] != float64(2) || records[0]["outcome"] != "success" || records[1]["status"] != nil || records[1]["outcome"] != "network" {
		t.Fatalf("records=%+v", records)
	}
}

func TestHTTPHealthEndpointFamilies(t *testing.T) {
	for _, tc := range []struct{ url, want string }{
		{ScoreboardURLWithLimit("eng.1", "202611", 1000), "scoreboard"},
		{StandingsURL("eng.1", 2026), "standings"}, {SummaryURL("eng.1", "123"), "summary"},
		{StatisticsURL("eng.1", 2026), "statistics"}, {TeamRosterURL("eng.1", "123"), "roster"},
		{AthleteBioURL("eng.1", "123"), "bio"}, {NewsURL("eng.1"), "news"},
		{CorePlaysURL("eng.1", "123", 2, 1000), "plays"}, {CoreOfficialsURLOn(CorePlaysBase, "eng.1", "123"), "officials"},
		{CoreOddsURLOn(CorePlaysBase, "eng.1", "123"), "odds"}, {"https://test.example/private-id", "other"},
	} {
		req, err := http.NewRequest(http.MethodGet, tc.url, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := endpointFamily(req.URL); got != tc.want {
			t.Errorf("family=%q, want %q", got, tc.want)
		}
	}
}
