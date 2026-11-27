package main

import (
	"bytes"
	"context"
	"crypto/sha256"
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

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

type fakeReaderStore struct {
	identities         []IdentityReference
	identitiesErr      error
	identityQuery      identityQuery
	resources          resourceSnapshot
	resourcesErr       error
	resourceScope      resourceScope
	player             *PlayerProfile
	playerErr          error
	boxScore           *BoxScore
	boxScoreErr        error
	leaders            []espn.StatLeader
	leadersErr         error
	leaderQuery        leaderQuery
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
	teams              map[string]*TeamProfile
	teamErr            error
	query              matchQuery
	calendar           SeasonCalendar
	calendarErr        error
	freshness          freshnessSnapshot
	freshnessErr       error
	calls              int
}

func (f *fakeReaderStore) Identities(_ context.Context, _, _ string, query identityQuery) ([]IdentityReference, error) {
	f.calls++
	f.identityQuery = query
	return f.identities, f.identitiesErr
}

func (f *fakeReaderStore) Resources(_ context.Context, scope resourceScope) (resourceSnapshot, error) {
	f.resourceScope = scope
	snapshot := f.resources
	snapshot.Core = f.freshness
	snapshot.CoreFound = true
	if f.resourcesErr != nil {
		return snapshot, f.resourcesErr
	}
	return snapshot, f.freshnessErr
}

func (f *fakeReaderStore) Snapshot(context.Context) (matchReader, func() error, error) {
	return f, func() error { return nil }, nil
}

func (f *fakeReaderStore) Freshness(context.Context, freshnessScope) (freshnessSnapshot, error) {
	return f.freshness, f.freshnessErr
}
func (f *fakeReaderStore) MatchScope(_ context.Context, id string) (freshnessScope, error) {
	return freshnessScope{Competition: "world-cup", Season: "2026", MatchID: id}, nil
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
func (f *fakeReaderStore) Matches(ctx context.Context, _ string, _ string, query matchQuery) ([]Match, error) {
	f.calls++
	f.query = query
	_, f.matchesHasDeadline = ctx.Deadline()
	return f.matches, f.matchesErr
}
func (f *fakeReaderStore) Calendar(context.Context, string, string) (SeasonCalendar, error) {
	f.calls++
	return f.calendar, f.calendarErr
}
func (f *fakeReaderStore) Team(_ context.Context, teamID, _, _ string, _ time.Time) (*TeamProfile, error) {
	f.calls++
	if f.teamErr != nil {
		return nil, f.teamErr
	}
	profile, known := f.teams[teamID]
	if !known {
		return nil, nil
	}
	return profile, nil
}
func (f *fakeReaderStore) Squad(_ context.Context, teamID, _, _ string, _ time.Time) ([]SquadPlayer, error) {
	f.calls++
	if f.teamErr != nil {
		return nil, f.teamErr
	}
	profile, known := f.teams[teamID]
	if !known {
		return nil, ErrNotFound
	}
	return profile.Squad, nil
}
func (f *fakeReaderStore) EditionTeams(context.Context, string, string, bool) ([]espn.Team, error) {
	f.calls++
	return nil, nil
}
func (f *fakeReaderStore) Standings(context.Context, string, string, string) ([]Group, error) {
	f.calls++
	return f.standings, f.standingsErr
}
func (f *fakeReaderStore) Bracket(context.Context, string, string, bool) ([]BracketRound, error) {
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

func (f *fakeNewsReader) GetWithObservation(ctx context.Context, slug, _ string) ([]espn.NewsArticle, time.Time, error) {
	articles, err := f.Get(ctx, slug)
	return articles, time.Time{}, err
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
		calendar:   SeasonCalendar{Days: []CalendarDay{{Date: "2026-07-19", Matches: 1, Live: 1}}},
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
		{path: "/v1/competitions/world-cup/2026/calendar", cacheControl: "public, max-age=10"},
		{path: "/v1/competitions/world-cup/2026/standings", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/competitions/world-cup/2026/bracket", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/competitions/world-cup/2026/top-scorers", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/competitions/world-cup/news", cacheControl: "public, max-age=60", array: true},
		{path: "/v1/matches/" + finalMatchID, cacheControl: "public, max-age=30"},
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
		{name: "summary database", path: "/v1/matches/" + finalMatchID, store: &fakeReaderStore{summaryErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
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

// A team we do not hold is 404, not 500: the request was well-formed and the
// answer is that there is no such team here.
func TestTeamUnknownIs404(t *testing.T) {
	router := newTestApp(t, &fakeReaderStore{teams: map[string]*TeamProfile{}}, &fakeNewsReader{}).router()
	response := performRequest(router, "GET", "/v1/competitions/world-cup/2026/teams/nope")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", response.Code, response.Body.String())
	}
}

// An unknown competition is a malformed request, not a miss -- 400, matching
// every other handler.
func TestTeamUnknownCompetitionIs400(t *testing.T) {
	router := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{}).router()
	response := performRequest(router, "GET", "/v1/competitions/not-a-comp/2026/teams/arg")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", response.Code, response.Body.String())
	}
}

// The whole point of the nullable stats block: a player nobody has measured
// must serialise as "stats": null, never as a block of zeroes, which would
// assert they played and did nothing.
func TestTeamSerialisesUnmeasuredPlayerAsNullStats(t *testing.T) {
	at := time.Now().UTC().Add(-time.Minute)
	store := &fakeReaderStore{resources: resourceSnapshot{Squad: &collectionEvidence{ObservedAt: &at, RowCount: 1}}, teams: map[string]*TeamProfile{"arg": {
		Team: espn.Team{ID: "arg", Name: "Argentina", Abbr: "ARG"},
		Squad: []SquadPlayer{
			{ID: "p1", Name: "Unplayed", Position: "D"},
		},
	}}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	response := performRequest(router, "GET", "/v1/competitions/world-cup/2026/teams/arg")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var payload struct {
		Squad []struct {
			Stats *map[string]any `json:"stats"`
		} `json:"squad"`
		Schedule []any `json:"schedule"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Squad) != 1 {
		t.Fatalf("squad size = %d, want 1", len(payload.Squad))
	}
	if payload.Squad[0].Stats != nil {
		t.Fatalf("stats = %v, want null for a player with no statistics", *payload.Squad[0].Stats)
	}
	// An empty schedule must be [] rather than null, so clients can iterate it
	// without a nil check.
	if payload.Schedule == nil {
		t.Fatal("schedule = null, want []")
	}
}

func TestTeamErrorsDoNotLogDependencyText(t *testing.T) {
	const sensitive = "private_dependency_detail"
	for _, cause := range []error{
		errors.New("connect postgres://user:" + sensitive + "@db.example/private"),
		&pgconn.PgError{Code: "42703", Message: sensitive, Detail: sensitive, Where: sensitive},
	} {
		var logs bytes.Buffer
		app := newTestApp(t, &fakeReaderStore{teamErr: cause}, &fakeNewsReader{})
		app.logger = slog.New(slog.NewJSONHandler(&logs, nil))
		response := performRequest(app.router(), "GET", "/v1/competitions/world-cup/2026/teams/nat-arg")
		if response.Code != 500 || strings.Contains(response.Body.String(), sensitive) || strings.Contains(logs.String(), sensitive) {
			t.Fatalf("dependency text leaked: status=%d body=%s logs=%s", response.Code, response.Body.String(), logs.String())
		}
	}
}

func TestTeamInvalidScopeDoesNotQueryStore(t *testing.T) {
	for _, path := range []string{
		"/v1/competitions/unknown/2026/teams/nat-arg",
		"/v1/competitions/world-cup/unknown/teams/nat-arg",
	} {
		store := &fakeReaderStore{teamErr: errors.New("must not query")}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), "GET", path)
		if response.Code != 400 || store.calls != 0 {
			t.Fatalf("invalid scope: status=%d store calls=%d", response.Code, store.calls)
		}
	}
}

func (f *fakeReaderStore) Leaders(_ context.Context, _, _ string, query leaderQuery) ([]espn.StatLeader, error) {
	f.calls++
	f.leaderQuery = query
	return f.leaders, f.leadersErr
}

func (f *fakeReaderStore) BoxScore(context.Context, string) (*BoxScore, error) {
	f.calls++
	return f.boxScore, f.boxScoreErr
}

func (f *fakeReaderStore) Player(context.Context, string, string, string) (*PlayerProfile, error) {
	f.calls++
	if f.playerErr != nil {
		return nil, f.playerErr
	}
	if f.player == nil {
		return nil, ErrNotFound
	}
	return f.player, nil
}

func TestEditionEligibility(t *testing.T) {
	st := &fakeReaderStore{}
	a := newTestApp(t, st, &fakeNewsReader{})
	// The fake match UUID resolves to this edition even when its public status changes.
	comp, _ := a.registry.Get("world-cup")
	season := comp.Seasons["2026"]
	season.Publication = "candidate"
	comp.Seasons["2026"] = season
	for _, suffix := range []string{"", "/box-score"} {
		res := performRequest(a.router(), "GET", "/v1/matches/00000000-0000-4000-8000-000000000001"+suffix)
		if res.Code != 404 || res.Body.String() != "{\"error\":\"match not found\"}\n" {
			t.Fatalf("%s: %d %s", suffix, res.Code, res.Body.String())
		}
	}
	season.Publication = "live"
	season.Resources = []string{"scores"}
	comp.Seasons["2026"] = season
	res := performRequest(a.router(), "GET", "/v1/competitions/world-cup/2026/standings")
	if res.Header().Get(resourcesHeader) == "" || !strings.Contains(res.Header().Get(resourcesHeader), "unavailable") {
		t.Fatalf("unsupported standings %d %s", res.Code, res.Header())
	}
}

func TestSecurityHeadersAndLogPathTruncation(t *testing.T) {
	t.Parallel()
	app, buf := newObservedApp(t, &fakeReaderStore{})
	longPath := "/" + strings.Repeat("a", 300)
	res := performRequest(app.router(), http.MethodGet, longPath)
	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.Code)
	}
	if res.Header().Get("X-Content-Type-Options") != "nosniff" ||
		res.Header().Get("X-Frame-Options") != "DENY" ||
		res.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("missing security headers: %v", res.Header())
	}
	if strings.Contains(buf.String(), strings.Repeat("a", 260)) {
		t.Fatalf("untruncated long path was logged: %s", buf.String())
	}
}

func TestTrustedCallerRateLimitAndSeasonScopeGate(t *testing.T) {
	t.Parallel()
	const key = "trusted-secret-key-at-least-32-chars"
	sum := sha256.Sum256([]byte(key))
	store := &fakeReaderStore{matches: []Match{}}
	app := newTestApp(t, store, &fakeNewsReader{})
	app.trustedKeyHash = sum[:]
	app.requireTrustedSeason = true
	app.limiter = newIPRateLimiter(0, 1)
	app.trustedLimiter = newIPRateLimiter(0, 5)
	router := app.router()

	// Anonymous scope=season is rejected with 403 before querying the store.
	anonSeason := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/matches?scope=season&detail=summary")
	if anonSeason.Code != http.StatusForbidden || store.calls != 0 || anonSeason.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("anon season = %d calls=%d cache=%q", anonSeason.Code, store.calls, anonSeason.Header().Get("Cache-Control"))
	}

	// Second anonymous request from the same IP hits the tightened anonymous limiter (burst 1) and keeps CORS headers.
	anonLimited := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/matches")
	if anonLimited.Code != http.StatusTooManyRequests || anonLimited.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("anon limited = %d headers=%v", anonLimited.Code, anonLimited.Header())
	}

	// Wrong key still falls in the anonymous bucket and is rejected for scope=season.
	wrongKeyReq := httptest.NewRequest(http.MethodGet, "/v1/competitions/world-cup/2026/matches?scope=season", nil)
	wrongKeyReq.RemoteAddr = "192.0.2.50:1234"
	wrongKeyReq.Header.Set(trustedCallerHeader, "wrong-key")
	wrongKeyRec := httptest.NewRecorder()
	router.ServeHTTP(wrongKeyRec, wrongKeyReq)
	if wrongKeyRec.Code != http.StatusForbidden {
		t.Fatalf("wrong key season = %d, want 403", wrongKeyRec.Code)
	}

	// Trusted key uses trustedLimiter and can read scope=season with private, no-store cache header.
	trustedReq := httptest.NewRequest(http.MethodGet, "/v1/competitions/world-cup/2026/matches?scope=season&detail=summary", nil)
	trustedReq.RemoteAddr = "192.0.2.1:1234"
	trustedReq.Header.Set(trustedCallerHeader, key)
	trustedRec := httptest.NewRecorder()
	router.ServeHTTP(trustedRec, trustedReq)
	if trustedRec.Code != http.StatusOK || trustedRec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("trusted season = %d cache=%q body=%s", trustedRec.Code, trustedRec.Header().Get("Cache-Control"), trustedRec.Body.String())
	}
}

func TestCORSAllowlistNoneAndPreflightRateLimit(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}

	// Allowlist mode.
	app := newTestApp(t, store, &fakeNewsReader{})
	app.corsOrigins = []string{"https://www.scorearc.futbol"}
	router := app.router()

	allowedPreflight := httptest.NewRequest(http.MethodOptions, "/v1/competitions/world-cup/2026/matches", nil)
	allowedPreflight.RemoteAddr = "192.0.2.10:1234"
	allowedPreflight.Header.Set("Origin", "https://www.scorearc.futbol")
	allowedPreflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	allowedRec := httptest.NewRecorder()
	router.ServeHTTP(allowedRec, allowedPreflight)
	if allowedRec.Code != http.StatusOK || allowedRec.Header().Get("Access-Control-Allow-Origin") != "https://www.scorearc.futbol" || allowedRec.Header().Get("Vary") != "Origin" {
		t.Fatalf("allowed preflight = %d headers=%v", allowedRec.Code, allowedRec.Header())
	}

	disallowedPreflight := httptest.NewRequest(http.MethodOptions, "/v1/competitions/world-cup/2026/matches", nil)
	disallowedPreflight.RemoteAddr = "192.0.2.11:1234"
	disallowedPreflight.Header.Set("Origin", "https://evil.example")
	disallowedPreflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	disallowedRec := httptest.NewRecorder()
	router.ServeHTTP(disallowedRec, disallowedPreflight)
	if disallowedRec.Code != http.StatusForbidden || disallowedRec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("disallowed preflight = %d headers=%v", disallowedRec.Code, disallowedRec.Header())
	}

	// "none" mode omits Access-Control-Allow-Origin.
	noneApp := newTestApp(t, store, &fakeNewsReader{})
	noneApp.corsOrigins = []string{}
	noneGet := httptest.NewRequest(http.MethodGet, "/v1/competitions/world-cup/2026/matches", nil)
	noneGet.RemoteAddr = "192.0.2.12:1234"
	noneGet.Header.Set("Origin", "https://www.scorearc.futbol")
	noneRec := httptest.NewRecorder()
	noneApp.router().ServeHTTP(noneRec, noneGet)
	if noneRec.Code != http.StatusOK || noneRec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("none CORS = %d headers=%v", noneRec.Code, noneRec.Header())
	}

	// OPTIONS preflights are rate-limited.
	limitedApp := newTestApp(t, store, &fakeNewsReader{})
	limitedApp.limiter = newIPRateLimiter(0, 1)
	limitedRouter := limitedApp.router()
	for i := range 2 {
		req := httptest.NewRequest(http.MethodOptions, "/v1/competitions/world-cup/2026/matches", nil)
		req.RemoteAddr = "192.0.2.13:1234"
		req.Header.Set("Origin", "https://scorearc.futbol")
		req.Header.Set("Access-Control-Request-Method", http.MethodGet)
		rec := httptest.NewRecorder()
		limitedRouter.ServeHTTP(rec, req)
		if i == 0 && rec.Code != http.StatusOK {
			t.Fatalf("first preflight = %d", rec.Code)
		}
		if i == 1 && rec.Code != http.StatusTooManyRequests {
			t.Fatalf("second preflight = %d, want 429", rec.Code)
		}
	}
}

func TestLimitConcurrencyReturns503WhenBusy(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, &fakeReaderStore{matches: []Match{}}, &fakeNewsReader{})
	app.inFlight = make(chan struct{}, 1)
	app.inFlight <- struct{}{} // occupy the sole slot
	defer func() { <-app.inFlight }()

	res := performRequest(app.router(), http.MethodGet, "/v1/competitions/world-cup/2026/matches")
	if res.Code != http.StatusServiceUnavailable || res.Header().Get("Retry-After") != "1" || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("busy response = %d headers=%v body=%s", res.Code, res.Header(), res.Body.String())
	}
}
