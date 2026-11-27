package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// The read transaction carries the edition policy into nested profile and identity reads.
type editionPolicyKey struct{}
type editionPolicy struct {
	edition config.Season
	visible []string
}

func (a *App) withEdition(ctx context.Context, edition config.Season, identityResource string) context.Context {
	policy := editionPolicy{edition: edition, visible: []string{}}
	if identityResource != "" {
		for _, c := range a.registry.Visible() {
			for _, s := range c.Seasons {
				if s.Supports(identityResource) {
					policy.visible = append(policy.visible, c.ID+"/"+s.ID)
				}
			}
		}
	}
	return context.WithValue(ctx, editionPolicyKey{}, policy)
}

func canRead(ctx context.Context, resource string) bool {
	p, scoped := ctx.Value(editionPolicyKey{}).(editionPolicy)
	return !scoped || p.edition.Supports(resource)
}
func archiveRosterEdition(ctx context.Context) bool {
	p, _ := ctx.Value(editionPolicyKey{}).(editionPolicy)
	return p.edition.ArchiveRosters
}

func visibleEntityScopes(ctx context.Context) []string {
	p, _ := ctx.Value(editionPolicyKey{}).(editionPolicy)
	return p.visible
}

type matchReader interface {
	Identities(context.Context, string, string, identityQuery) ([]IdentityReference, error)
	Resources(context.Context, resourceScope) (resourceSnapshot, error)
	EditionTeams(context.Context, string, string, bool) ([]espn.Team, error)
	Standings(context.Context, string, string, string) ([]Group, error)
	TopScorers(context.Context, string, string) ([]espn.TopScorer, error)
	Leaders(context.Context, string, string, leaderQuery) ([]espn.StatLeader, error)
	Squad(ctx context.Context, teamID, competition, season string, asOf time.Time) ([]SquadPlayer, error)
	Player(context.Context, string, string, string) (*PlayerProfile, error)
	Matches(context.Context, string, string, matchQuery) ([]Match, error)
	Calendar(context.Context, string, string) (SeasonCalendar, error)
	Bracket(context.Context, string, string, bool) ([]BracketRound, error)
	MatchSummary(context.Context, string) (*MatchSummary, error)
	BoxScore(context.Context, string) (*BoxScore, error)
	Team(ctx context.Context, teamID, competition, season string, asOf time.Time) (*TeamProfile, error)
	Freshness(context.Context, freshnessScope) (freshnessSnapshot, error)
	MatchScope(context.Context, string) (freshnessScope, error)
}

type readerStore interface {
	matchReader
	Ping(context.Context) error
	Snapshot(context.Context) (matchReader, func() error, error)
}

type newsReader interface {
	Get(context.Context, string) ([]espn.NewsArticle, error)
	GetWithObservation(context.Context, string, string) ([]espn.NewsArticle, time.Time, error)
}

type App struct {
	store                readerStore
	registry             *config.Registry
	logger               *slog.Logger
	httpLog              *slog.Logger
	news                 newsReader
	limiter              *ipRateLimiter
	trustedLimiter       *ipRateLimiter
	trustedKeyHash       []byte
	requireTrustedSeason bool
	corsOrigins          []string
	inFlight             chan struct{}
	health               *healthChecker
	now                  func() time.Time
}

const retainedStatsHeader = "X-ScoreArc-Roster-Stats"

type retainedStatsKey struct{}

// Older v1 clients reject additional JSON properties. Keep the original body
// unless the caller explicitly requests the observation time for retained totals.
func negotiateRosterStats(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", retainedStatsHeader)
		if r.Header.Get(retainedStatsHeader) == "retained-v1" {
			r = r.WithContext(context.WithValue(r.Context(), retainedStatsKey{}, true))
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) router() http.Handler {
	router := chi.NewRouter()
	router.Use(a.requestID)
	if a.httpLog == nil {
		router.Use(a.recoverJSON, a.requestLogging)
	} else {
		// Observe the 500 written by recovery and disconnects rethrown by it.
		router.Use(a.requestLogging, a.recoverJSON)
	}
	router.Use(a.corsOriginHeaders)
	router.Use(a.securityHeaders)
	router.Use(a.rateLimit)
	router.Use(a.corsPreflight)

	router.Get("/healthz", a.handleHealthz)
	router.Route("/v1", func(router chi.Router) {
		router.Use(a.requestTimeout)
		router.Use(a.limitConcurrency)
		router.Get("/competitions/{comp}/{season}/matches", a.handleMatches)
		router.Get("/competitions/{comp}/{season}/identities", a.handleIdentities)
		router.Get("/competitions/{comp}/{season}/calendar", a.handleCalendar)
		router.Get("/competitions/{comp}/{season}/standings", a.handleStandings)
		router.Get("/competitions/{comp}/{season}/bracket", a.handleBracket)
		router.Get("/competitions/{comp}/{season}/top-scorers", a.handleTopScorers)
		router.Get("/competitions/{comp}/{season}/leaders", a.handleLeaders)
		router.Get("/competitions/{comp}/{season}/teams", a.handleEditionTeams)
		profiles := router.With(negotiateRosterStats)
		profiles.Get("/competitions/{comp}/{season}/teams/{teamId}", a.handleTeam)
		profiles.Get("/competitions/{comp}/{season}/teams/{teamId}/squad", a.handleSquad)
		profiles.Get("/competitions/{comp}/{season}/players/{playerId}", a.handlePlayer)
		router.Get("/competitions/{comp}/news", a.handleNews)
		router.Get("/matches/{id}", a.handleMatchSummary)
		router.Get("/matches/{id}/box-score", a.handleBoxScore)
	})
	router.NotFound(func(writer http.ResponseWriter, _ *http.Request) {
		writeError(writer, http.StatusNotFound, "not found")
	})
	router.MethodNotAllowed(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Allow", http.MethodGet)
		writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
	})
	return router
}

func (a *App) resolve(competition, season string) (config.Competition, config.Season, bool) {
	comp, ok := a.registry.Get(competition)
	if !ok {
		return config.Competition{}, config.Season{}, false
	}
	resolvedSeason, ok := comp.Seasons[season]
	if !ok || !a.registry.Readable(competition, resolvedSeason) {
		return config.Competition{}, config.Season{}, false
	}
	return comp, resolvedSeason, true
}

var exposedHeaders = strings.Join(append(append([]string{}, freshnessHeaders...), resourcesHeader, "X-ScoreArc-Poll-Evidence"), ", ")

func (a *App) isTrustedCaller(request *http.Request) bool {
	if len(a.trustedKeyHash) == 0 {
		return false
	}
	raw := request.Header.Get(trustedCallerHeader)
	if raw == "" {
		return false
	}
	sum := sha256.Sum256([]byte(raw))
	return subtle.ConstantTimeCompare(sum[:], a.trustedKeyHash) == 1
}

func (a *App) originAllowed(origin string) bool {
	if a.corsOrigins == nil {
		return true
	}
	if len(a.corsOrigins) == 0 || origin == "" {
		return false
	}
	return slices.Contains(a.corsOrigins, strings.ToLower(origin))
}

// corsOriginHeaders attaches CORS headers before rateLimit so 429 responses
// remain readable by allowed browser origins while keeping preflights subject
// to rate limiting.
func (a *App) corsOriginHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		header := writer.Header()
		switch {
		case a.corsOrigins == nil:
			header.Set("Access-Control-Allow-Origin", "*")
			header.Set("Access-Control-Expose-Headers", exposedHeaders)
		case len(a.corsOrigins) > 0:
			header.Add("Vary", "Origin")
			if origin := request.Header.Get("Origin"); a.originAllowed(origin) {
				header.Set("Access-Control-Allow-Origin", origin)
				header.Set("Access-Control-Expose-Headers", exposedHeaders)
			}
		}
		next.ServeHTTP(writer, request)
	})
}

func (a *App) corsPreflight(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodOptions && request.Header.Get("Access-Control-Request-Method") != "" {
			if !a.originAllowed(request.Header.Get("Origin")) {
				writeError(writer, http.StatusForbidden, "origin not allowed")
				return
			}
			header := writer.Header()
			header.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			header.Set("Access-Control-Allow-Headers", "Accept, Content-Type, "+retainedStatsHeader)
			header.Set("Access-Control-Max-Age", "300")
			writer.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (a *App) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		header := writer.Header()
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(writer, request)
	})
}

func (a *App) recoverJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler {
					panic(recovered)
				}
				if recorder, ok := writer.(*statusRecorder); ok {
					// Recovery can write a 500 only if the handler has not committed a response.
					recorder.panicked = true
				}
				id, _ := request.Context().Value(requestIDKey).(string)
				path := truncatePath(request.URL.Path)
				route := path
				if pattern := chi.RouteContext(request.Context()).RoutePattern(); pattern != "" {
					route = pattern
				}
				a.logger.Error("panic recovered",
					"request_id", id,
					"method", request.Method,
					"path", path,
					"route", route,
					"panic", recovered,
					"stack", string(debug.Stack()),
				)
				writeError(writer, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(writer, request)
	})
}

func (a *App) requestTimeout(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
		defer cancel()
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func (a *App) limitConcurrency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if a.inFlight == nil {
			next.ServeHTTP(writer, request)
			return
		}
		select {
		case a.inFlight <- struct{}{}:
		default:
			wait := time.NewTimer(500 * time.Millisecond)
			select {
			case a.inFlight <- struct{}{}:
				wait.Stop()
			case <-wait.C:
				writer.Header().Set("Retry-After", "1")
				writeError(writer, http.StatusServiceUnavailable, "service busy")
				return
			case <-request.Context().Done():
				wait.Stop()
				return
			}
		}
		defer func() { <-a.inFlight }()
		next.ServeHTTP(writer, request)
	})
}

func (a *App) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/healthz" {
			next.ServeHTTP(writer, request)
			return
		}
		limiter := a.limiter
		if a.trustedLimiter != nil && a.isTrustedCaller(request) {
			limiter = a.trustedLimiter
		}
		if !limiter.Allow(clientIP(request)) {
			writer.Header().Set("Retry-After", "1")
			writeError(writer, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (a *App) handleHealthz(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if err := a.health.Check(request.Context()); err != nil {
		a.logger.Error("health check", "err", err)
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "unhealthy"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}
