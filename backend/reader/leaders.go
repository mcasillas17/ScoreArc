package main

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

const maxLeaderLimit = 30

type leaderQuery struct {
	Metric string
	Limit  int
}

func parseLeaderQuery(raw string) (leaderQuery, error) {
	values, err := singleValues(raw, "metric", "limit")
	if err != nil {
		return leaderQuery{}, err
	}
	query := leaderQuery{Metric: "goals", Limit: 10}
	if metric, exists := values["metric"]; exists {
		if metric != "goals" && metric != "assists" {
			return leaderQuery{}, errors.New("metric must be 'goals' or 'assists'")
		}
		query.Metric = metric
	}
	if rawLimit, exists := values["limit"]; exists {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || rawLimit[0] < '0' || rawLimit[0] > '9' || limit < 1 || limit > maxLeaderLimit {
			return leaderQuery{}, errors.New("limit must be an integer between 1 and 30")
		}
		query.Limit = limit
	}
	return query, nil
}

func (a *App) handleLeaders(writer http.ResponseWriter, request *http.Request) {
	competition, season := chi.URLParam(request, "comp"), chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	query, err := parseLeaderQuery(request.URL.RawQuery)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	reader, finish, ok := a.beginMatchSnapshot(writer, request)
	if !ok {
		return
	}
	defer finish()
	rows, err := reader.Leaders(request.Context(), competition, season, query)
	if err != nil {
		finish()
		a.logger.Error("leaders", "competition", competition, "season", season)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if rows == nil {
		rows = []espn.StatLeader{}
	}
	if !a.attachResources(writer, request, reader, finish, resourceScope{freshnessScope: freshnessScope{Competition: competition, Season: season}, Route: "leaders", Metric: query.Metric}) {
		return
	}
	cacheFor(writer, 60)
	writeContractJSON(writer, rows)
}

// Bound the board before joining identities. Rank is the provider's order,
// including ties in value; source IDs alone never identify a canonical entity.
const leadersSQL = `
WITH board AS (
 SELECT * FROM top_scorer
 WHERE competition_id=$1 AND season_id=$2 AND category=$3
 ORDER BY rank LIMIT $4
)
SELECT b.rank,b.player,b.goals,b.matches,COALESCE(b.team_abbr,''),COALESCE(b.team_name,''),b.team_crest_url,
 CASE WHEN b.source='espn' THEN b.athlete_source_id END,
 p.player_id::text,t.team_id
FROM board b
LEFT JOIN player_external_ref p ON p.source=b.source AND p.source_id=b.athlete_source_id
LEFT JOIN team_external_ref t ON t.source=b.source AND t.source_id=b.team_source_id
ORDER BY b.rank`

func (s *Store) Leaders(ctx context.Context, competition, season string, query leaderQuery) ([]espn.StatLeader, error) {
	if (query.Metric != "goals" && query.Metric != "assists") || query.Limit < 1 || query.Limit > maxLeaderLimit {
		return nil, errors.New(errQueryInvalid)
	}
	rows, err := s.db.Query(ctx, leadersSQL, competition, season, query.Metric, query.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	leaders := make([]espn.StatLeader, 0)
	for rows.Next() {
		var leader espn.StatLeader
		if err := rows.Scan(&leader.Rank, &leader.Player, &leader.Value, &leader.Matches, &leader.TeamAbbr, &leader.TeamName, &leader.TeamCrestURL, &leader.AthleteID, &leader.PlayerID, &leader.TeamID); err != nil {
			return nil, err
		}
		leaders = append(leaders, leader)
	}
	return leaders, rows.Err()
}
