package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, status, map[string]string{"error": message})
}

func cacheFor(writer http.ResponseWriter, seconds int) {
	writer.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", seconds))
}

func liveMaxAge(anyLive bool) int {
	if anyLive {
		return 10
	}
	return 60
}

func (a *App) handleMatches(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	matches, err := a.store.Matches(request.Context(), competition, season)
	if err != nil {
		a.logger.Error("matches", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if matches == nil {
		matches = []Match{}
	}
	anyLive := false
	for _, match := range matches {
		if match.State == espn.MatchStateLive {
			anyLive = true
			break
		}
	}
	cacheFor(writer, liveMaxAge(anyLive))
	writeJSON(writer, http.StatusOK, matches)
}

func (a *App) handleStandings(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	comp, _, ok := a.resolve(competition, season)
	if !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	groups, err := a.store.Standings(request.Context(), competition, season, comp.ShortName)
	if err != nil {
		a.logger.Error("standings", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if groups == nil {
		groups = []Group{}
	}
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, groups)
}

func (a *App) handleBracket(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	rounds, err := a.store.Bracket(request.Context(), competition, season)
	if err != nil {
		a.logger.Error("bracket", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if rounds == nil {
		rounds = []BracketRound{}
	}
	anyLive := false
	for _, round := range rounds {
		for _, match := range round.Matches {
			if match.State == espn.MatchStateLive {
				anyLive = true
				break
			}
		}
	}
	cacheFor(writer, liveMaxAge(anyLive))
	writeJSON(writer, http.StatusOK, rounds)
}

func (a *App) handleTopScorers(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	scorers, err := a.store.TopScorers(request.Context(), competition, season)
	if err != nil {
		a.logger.Error("top scorers", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if scorers == nil {
		scorers = []espn.TopScorer{}
	}
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, scorers)
}

func (a *App) handleNews(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	comp, ok := a.registry.Get(competition)
	if !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition")
		return
	}
	articles, err := a.news.Get(request.Context(), comp.ESPNSlug)
	if err != nil {
		a.logger.Error("news", "competition", competition, "err", err)
		writeError(writer, http.StatusBadGateway, "upstream error")
		return
	}
	if articles == nil {
		articles = []espn.NewsArticle{}
	}
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, articles)
}

func (a *App) handleMatchSummary(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "id")
	summary, err := a.store.MatchSummary(request.Context(), id)
	if errors.Is(err, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "match not found")
		return
	}
	if err != nil {
		a.logger.Error("match summary", "id", id, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	cacheFor(writer, 30)
	writeJSON(writer, http.StatusOK, summary)
}

// One club inside one competition: identity, colours, season record, squad
// with season statistics, and the club's fixtures and results.
//
// A team we do not hold is 404, not 500: the request was well-formed and the
// answer is that there is no such team here. An unknown competition stays 400,
// matching the other handlers -- that is a malformed request, not a miss.
func (a *App) handleTeam(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	teamID := chi.URLParam(request, "teamId")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	profile, err := a.store.Team(request.Context(), teamID, competition, season)
	if err != nil {
		a.logger.Error("team",
			"competition", competition, "season", season, "team", teamID, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if profile == nil {
		writeError(writer, http.StatusNotFound, "unknown team")
		return
	}
	if profile.Squad == nil {
		profile.Squad = []SquadPlayer{}
	}
	if profile.Schedule == nil {
		profile.Schedule = []Match{}
	}
	cacheFor(writer, 120)
	writeJSON(writer, http.StatusOK, profile)
}
