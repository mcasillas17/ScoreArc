package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

type fakeReaderStore struct {
	pingErr            error
	pingCalls          atomic.Int32
	pingBlock          <-chan struct{}
	matchesHasDeadline bool
	matches            []Match
	matchesErr         error
	standings          []Group
	standingsErr       error
	bracket            []BracketRound
	bracketErr         error
	summary            *MatchSummary
	summaryErr         error
	topScorers         []espn.TopScorer
	topScorersErr      error
	calls              int
}

func (f *fakeReaderStore) Ping(ctx context.Context) error {
	f.pingCalls.Add(1)
	if f.pingBlock != nil {
		select {
		case <-f.pingBlock:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.pingErr
}
func (f *fakeReaderStore) Matches(ctx context.Context, _ string, _ string) ([]Match, error) {
	f.calls++
	_, f.matchesHasDeadline = ctx.Deadline()
	return f.matches, f.matchesErr
}
func (f *fakeReaderStore) Standings(context.Context, string, string, string) ([]Group, error) {
	f.calls++
	return f.standings, f.standingsErr
}
func (f *fakeReaderStore) Bracket(context.Context, string, string) ([]BracketRound, error) {
	f.calls++
	return f.bracket, f.bracketErr
}
func (f *fakeReaderStore) MatchSummary(context.Context, string) (*MatchSummary, error) {
	f.calls++
	return f.summary, f.summaryErr
}
func (f *fakeReaderStore) TopScorers(context.Context, string, string) ([]espn.TopScorer, error) {
	f.calls++
	return f.topScorers, f.topScorersErr
}

type fakeNewsReader struct {
	articles []espn.NewsArticle
	err      error
	slug     string
	calls    int
}

func (f *fakeNewsReader) Get(_ context.Context, slug string) ([]espn.NewsArticle, error) {
	f.calls++
	f.slug = slug
	return f.articles, f.err
}

func newTestApp(t *testing.T, store *fakeReaderStore, news *fakeNewsReader) *App {
	t.Helper()
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	app := &App{
		store:    store,
		registry: registry,
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		news:     news,
		limiter:  newIPRateLimiter(1_000_000, 1_000_000),
	}
	app.health = newHealthChecker(context.Background(), store.Ping)
	return app
}

func performRequest(handler http.Handler, method, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	request.RemoteAddr = "192.0.2.1:1234"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestPublicRoutesAndCachePolicies(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{
		matches:    []Match{{ID: "1", State: espn.MatchStateLive, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}},
		standings:  []Group{{ID: "A", Name: "Group A", Standings: []Standing{}}},
		bracket:    []BracketRound{{Slug: "final", Name: "Final", Matches: []espn.BracketMatch{}}},
		summary:    &MatchSummary{Scorers: []espn.Scorer{}, Cards: []espn.Card{}, Videos: []espn.MatchVideo{}, Commentary: []espn.CommentaryItem{}, H2H: []espn.H2HMeeting{}},
		topScorers: []espn.TopScorer{},
	}
	news := &fakeNewsReader{articles: []espn.NewsArticle{}}
	router := newTestApp(t, store, news).router()

	tests := []struct {
		path         string
		cacheControl string
		array        bool
	}{
		{path: "/v1/competitions/world-cup/2026/matches", cacheControl: "public, max-age=10", array: true},
		{path: "/v1/competitions/world-cup/2026/standings", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/competitions/world-cup/2026/bracket", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/competitions/world-cup/2026/top-scorers", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/competitions/world-cup/news", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/matches/1", cacheControl: "public, max-age=30"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			recorder := performRequest(router, http.MethodGet, tt.path)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Cache-Control"); got != tt.cacheControl {
				t.Fatalf("Cache-Control = %q, want %q", got, tt.cacheControl)
			}
			if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
				t.Fatalf("Content-Type = %q", got)
			}
			if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("X-Content-Type-Options = %q", got)
			}
			if tt.array && !strings.HasPrefix(strings.TrimSpace(recorder.Body.String()), "[") {
				t.Fatalf("body is not an array: %s", recorder.Body.String())
			}
		})
	}
	if !store.matchesHasDeadline {
		t.Fatal("database request context had no deadline")
	}
	if news.calls != 1 || news.slug != "fifa.world" {
		t.Fatalf("news calls=%d slug=%q", news.calls, news.slug)
	}
}

func TestScheduledMatchesUseLongerCache(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{{State: espn.MatchStateScheduled, Scorers: []espn.Scorer{}, Cards: []espn.Card{}}}}
	recorder := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, "/v1/competitions/world-cup/2026/matches")
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestLiveBracketUsesShortCache(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{bracket: []BracketRound{{
		Slug:    "final",
		Name:    "Final",
		Matches: []espn.BracketMatch{{State: espn.MatchStateLive}},
	}}}
	recorder := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, "/v1/competitions/world-cup/2026/bracket")
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=10" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestNilListDependenciesStillEncodeArrays(t *testing.T) {
	t.Parallel()
	router := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{}).router()
	paths := []string{
		"/v1/competitions/world-cup/2026/matches",
		"/v1/competitions/world-cup/2026/standings",
		"/v1/competitions/world-cup/2026/bracket",
		"/v1/competitions/world-cup/2026/top-scorers",
		"/v1/competitions/world-cup/news",
	}
	for _, path := range paths {
		recorder := performRequest(router, http.MethodGet, path)
		if recorder.Code != http.StatusOK || recorder.Body.String() != "[]\n" {
			t.Fatalf("%s response = %d %q", path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestValidationStopsBeforeDependencies(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{}
	news := &fakeNewsReader{}
	router := newTestApp(t, store, news).router()
	paths := []string{
		"/v1/competitions/not-real/2026/matches",
		"/v1/competitions/world-cup/not-real/standings",
		"/v1/competitions/not-real/news",
	}
	for _, path := range paths {
		recorder := performRequest(router, http.MethodGet, path)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", path, recorder.Code, recorder.Body.String())
		}
	}
	if store.calls != 0 || news.calls != 0 {
		t.Fatalf("dependencies called after validation failure: store=%d news=%d", store.calls, news.calls)
	}
}

func TestDependencyErrorsAreSanitized(t *testing.T) {
	t.Parallel()
	secret := errors.New("postgres password=must-not-leak")
	tests := []struct {
		name   string
		path   string
		store  *fakeReaderStore
		news   *fakeNewsReader
		status int
	}{
		{name: "database", path: "/v1/competitions/world-cup/2026/matches", store: &fakeReaderStore{matchesErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "standings database", path: "/v1/competitions/world-cup/2026/standings", store: &fakeReaderStore{standingsErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "bracket database", path: "/v1/competitions/world-cup/2026/bracket", store: &fakeReaderStore{bracketErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "top scorers database", path: "/v1/competitions/world-cup/2026/top-scorers", store: &fakeReaderStore{topScorersErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "missing summary", path: "/v1/matches/missing", store: &fakeReaderStore{summaryErr: ErrNotFound}, news: &fakeNewsReader{}, status: http.StatusNotFound},
		{name: "summary database", path: "/v1/matches/1", store: &fakeReaderStore{summaryErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "news upstream", path: "/v1/competitions/world-cup/news", store: &fakeReaderStore{}, news: &fakeNewsReader{err: secret}, status: http.StatusBadGateway},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := performRequest(newTestApp(t, tt.store, tt.news).router(), http.MethodGet, tt.path)
			if recorder.Code != tt.status {
				t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), "password") {
				t.Fatalf("response leaked internal error: %s", recorder.Body.String())
			}
			if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body["error"] == "" {
				t.Fatalf("error body = %s, decode err %v", recorder.Body.String(), err)
			}
		})
	}
}

func TestHealthChecksDatabaseAndBypassesRateLimit(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{}
	app := newTestApp(t, store, &fakeNewsReader{})
	now := time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)
	app.health.now = func() time.Time { return now }
	app.limiter = newIPRateLimiter(0, 1)
	router := app.router()
	for range 3 {
		recorder := performRequest(router, http.MethodGet, "/healthz")
		if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"ok\"}\n" || recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("health response = %d %s", recorder.Code, recorder.Body.String())
		}
	}
	if store.pingCalls.Load() != 1 {
		t.Fatalf("health pings = %d, want one cached ping", store.pingCalls.Load())
	}
	store.pingErr = errors.New("database down")
	now = now.Add(3 * time.Second)
	recorder := performRequest(router, http.MethodGet, "/healthz")
	if recorder.Code != http.StatusServiceUnavailable || strings.Contains(recorder.Body.String(), "database down") || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unhealthy response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRateLimitAndCORS(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}
	app := newTestApp(t, store, &fakeNewsReader{})
	app.limiter = newIPRateLimiter(0, 1)
	router := app.router()

	if first := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/matches"); first.Code != http.StatusOK {
		t.Fatalf("first status = %d", first.Code)
	}
	second := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/matches")
	if second.Code != http.StatusTooManyRequests || second.Header().Get("Retry-After") != "1" {
		t.Fatalf("limited response = %d headers=%v body=%s", second.Code, second.Header(), second.Body.String())
	}

	preflight := httptest.NewRequest(http.MethodOptions, "/v1/competitions/world-cup/2026/matches", nil)
	preflight.RemoteAddr = "192.0.2.2:1234"
	preflight.Header.Set("Origin", "https://scorearc.futbol")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	preflightRecorder := httptest.NewRecorder()
	router.ServeHTTP(preflightRecorder, preflight)
	if preflightRecorder.Code != http.StatusOK || preflightRecorder.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight = %d headers=%v", preflightRecorder.Code, preflightRecorder.Header())
	}
}

func TestUnsupportedMethodIsRejected(t *testing.T) {
	t.Parallel()
	recorder := performRequest(newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{}).router(), http.MethodPost, "/v1/competitions/world-cup/2026/matches")
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Content-Type") != "application/json; charset=utf-8" || recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("response = %d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
}

func TestUnknownRouteAndPanicsReturnJSON(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	notFound := performRequest(app.router(), http.MethodGet, "/not-a-route")
	if notFound.Code != http.StatusNotFound || notFound.Header().Get("Content-Type") != "application/json; charset=utf-8" || notFound.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("not found = %d headers=%v body=%s", notFound.Code, notFound.Header(), notFound.Body.String())
	}

	panicking := app.recoverJSON(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("secret panic detail")
	}))
	recovered := performRequest(panicking, http.MethodGet, "/")
	if recovered.Code != http.StatusInternalServerError || recovered.Header().Get("Content-Type") != "application/json; charset=utf-8" || recovered.Header().Get("Cache-Control") != "no-store" || strings.Contains(recovered.Body.String(), "secret") {
		t.Fatalf("recovered = %d headers=%v body=%s", recovered.Code, recovered.Header(), recovered.Body.String())
	}
}

func TestHealthChecksCoalesceConcurrentPings(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	store := &fakeReaderStore{pingBlock: release}
	app := newTestApp(t, store, &fakeNewsReader{})
	router := app.router()

	const callers = 12
	start := make(chan struct{})
	results := make(chan int, callers)
	for range callers {
		go func() {
			<-start
			results <- performRequest(router, http.MethodGet, "/healthz").Code
		}()
	}
	close(start)
	deadline := time.Now().Add(time.Second)
	for store.pingCalls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(release)
	for range callers {
		if status := <-results; status != http.StatusOK {
			t.Fatalf("status = %d", status)
		}
	}
	if store.pingCalls.Load() != 1 {
		t.Fatalf("health pings = %d, want 1", store.pingCalls.Load())
	}
}

func TestHTTPServerHasDefensiveTimeouts(t *testing.T) {
	t.Parallel()
	server := newHTTPServer("9090", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if server.Addr != ":9090" {
		t.Fatalf("Addr = %q", server.Addr)
	}
	if server.ReadTimeout <= 0 || server.ReadHeaderTimeout <= 0 || server.WriteTimeout <= 0 || server.IdleTimeout <= 0 || server.MaxHeaderBytes <= 0 {
		t.Fatalf("server is missing defensive limits: %+v", server)
	}
}
