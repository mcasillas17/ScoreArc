package main

import (
	"context"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

type readerStore interface {
	Ping(context.Context) error
	Matches(context.Context, string, string) ([]Match, error)
	Standings(context.Context, string, string, string) ([]Group, error)
	Bracket(context.Context, string, string) ([]BracketRound, error)
	MatchSummary(context.Context, string) (*MatchSummary, error)
	TopScorers(context.Context, string, string) ([]espn.TopScorer, error)
}

type newsReader interface {
	Get(context.Context, string) ([]espn.NewsArticle, error)
}

type App struct {
	store    readerStore
	registry *config.Registry
	logger   *slog.Logger
	news     newsReader
	limiter  *ipRateLimiter
	health   *healthChecker
}

func (a *App) router() http.Handler {
	router := chi.NewRouter()
	router.Use(a.requestID)
	router.Use(a.recoverJSON)
	router.Use(a.requestLogging)
	router.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{http.MethodGet, http.MethodOptions},
		AllowedHeaders: []string{"Accept", "Content-Type"},
		MaxAge:         300,
	}))
	router.Use(a.securityHeaders)
	router.Use(a.rateLimit)

	router.Get("/healthz", a.handleHealthz)
	router.Route("/v1", func(router chi.Router) {
		router.Use(a.requestTimeout)
		router.Get("/competitions/{comp}/{season}/matches", a.handleMatches)
		router.Get("/competitions/{comp}/{season}/standings", a.handleStandings)
		router.Get("/competitions/{comp}/{season}/bracket", a.handleBracket)
		router.Get("/competitions/{comp}/{season}/top-scorers", a.handleTopScorers)
		router.Get("/competitions/{comp}/news", a.handleNews)
		router.Get("/matches/{id}", a.handleMatchSummary)
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
	if !ok {
		return config.Competition{}, config.Season{}, false
	}
	return comp, resolvedSeason, true
}

func (a *App) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
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
				id, _ := request.Context().Value(requestIDKey).(string)
				route := request.URL.Path
				if pattern := chi.RouteContext(request.Context()).RoutePattern(); pattern != "" {
					route = pattern
				}
				a.logger.Error("panic recovered",
					"request_id", id,
					"method", request.Method,
					"path", request.URL.Path,
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

func (a *App) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/healthz" {
			next.ServeHTTP(writer, request)
			return
		}
		if !a.limiter.Allow(clientIP(request)) {
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
