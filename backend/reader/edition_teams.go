package main

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

func (a *App) handleEditionTeams(w http.ResponseWriter, r *http.Request) {
	comp, season := chi.URLParam(r, "comp"), chi.URLParam(r, "season")
	_, edition, ok := a.resolve(comp, season)
	if !ok {
		writeError(w, 400, "unknown competition or season")
		return
	}
	if parseNoQuery(r.URL.RawQuery) != nil {
		writeError(w, 400, errQueryInvalid)
		return
	}
	fromMatches := edition.MatchDerivedTeams()
	if !edition.Supports("teams") || (!edition.Supports("standings") && !fromMatches) {
		writeUnavailable(w, "editionTeams")
		return
	}
	reader, finish, ok := a.beginMatchSnapshot(w, r)
	if !ok {
		return
	}
	defer finish()
	teams, err := reader.EditionTeams(r.Context(), comp, season, fromMatches)
	if err != nil {
		a.logDependencyError(r, "edition teams", err, "competition", comp, "season", season)
		writeError(w, 500, "internal error")
		return
	}
	if teams == nil {
		teams = []model.Team{}
	}
	if !a.attachResources(w, r, reader, finish, resourceScope{freshnessScope: freshnessScope{Competition: comp, Season: season}, Route: "editionTeams", MatchMembership: fromMatches, MemberCount: len(teams)}) {
		return
	}
	cacheFor(w, 60)
	writeContractJSON(w, teams)
}

func (s *Store) EditionTeams(ctx context.Context, comp, season string, fromMatches bool) ([]model.Team, error) {
	query := `SELECT t.id,t.name,t.abbr,t.crest_url FROM
 (SELECT DISTINCT team_id FROM standing WHERE competition_id=$1 AND season_id=$2 AND source='espn' LIMIT $3) members
 JOIN team t ON t.id=members.team_id ORDER BY t.id`
	args := []any{comp, season, writerstore.MaxEditionTeams + 1}
	if fromMatches {
		ids, err := writerstore.MatchEditionMembers(ctx, s.db, comp, season)
		if err != nil {
			return nil, err
		}
		query = `SELECT id,name,abbr,crest_url FROM team WHERE id=ANY($1) ORDER BY id`
		args = []any{ids}
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Team{}
	for rows.Next() {
		if len(result) == writerstore.MaxEditionTeams {
			return nil, writerstore.ErrEditionTeamsTooLarge
		}
		var team model.Team
		if err := rows.Scan(&team.ID, &team.Name, &team.Abbr, &team.CrestURL); err != nil {
			return nil, err
		}
		result = append(result, team)
	}
	return result, rows.Err()
}
