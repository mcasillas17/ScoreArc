package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

const maxPlayerCareer = 50
const maxPlayerGameLog = 5
const maxPlayerCandidates = 2000

type PlayerSeasonTotal struct {
	Name    string `json:"name"`
	Label   string `json:"label"`
	Display string `json:"display"`
	Value   *int   `json:"value"`
}

type CareerStint struct {
	TeamID   *string `json:"teamId"`
	TeamName string  `json:"teamName"`
	CrestURL *string `json:"crestUrl"`
	Seasons  string  `json:"seasons"`
}

type PlayerProfile struct {
	ID           string              `json:"id"`
	PlayerSlug   *string             `json:"playerSlug"`
	Name         string              `json:"name"`
	Age          *int                `json:"age"`
	Position     string              `json:"position"`
	Jersey       *string             `json:"jersey"`
	Nationality  *string             `json:"nationality"`
	FlagURL      *string             `json:"flagUrl"`
	HeadshotURL  *string             `json:"headshotUrl"`
	Team         *espn.Team          `json:"team"`
	SeasonLabel  string              `json:"seasonLabel"`
	Totals       []PlayerSeasonTotal `json:"totals"`
	GameLogLabel string              `json:"gameLogLabel"`
	GameLog      []GameLogRow        `json:"gameLog"`
	Career       []CareerStint       `json:"career"`
}

func isCanonicalPlayerID(raw string) bool {
	id, err := uuid.Parse(raw)
	return err == nil && id.String() == raw
}

func (a *App) handlePlayer(w http.ResponseWriter, r *http.Request) {
	comp, season, id := chi.URLParam(r, "comp"), chi.URLParam(r, "season"), chi.URLParam(r, "playerId")
	if _, _, ok := a.resolve(comp, season); !ok {
		writeError(w, 400, "unknown competition or season")
		return
	}
	if !isCanonicalPlayerID(id) {
		writeError(w, 400, "playerId must be a canonical UUID")
		return
	}
	if parseNoQuery(r.URL.RawQuery) != nil {
		writeError(w, 400, "invalid query")
		return
	}
	reader, finish, ok := a.beginMatchSnapshot(w, r)
	if !ok {
		return
	}
	defer finish()
	player, err := reader.Player(r.Context(), id, comp, season)
	finish()
	if errors.Is(err, ErrNotFound) {
		writeError(w, 404, "player not found")
		return
	}
	if err != nil {
		a.logger.Error("player unavailable")
		writeError(w, 500, "internal error")
		return
	}
	cacheFor(w, 60)
	writeContractJSON(w, player)
}

const playerIdentitySQL = `
SELECT p.id::text,p.full_name,
 CASE WHEN p.birth_date <= (current_timestamp AT TIME ZONE 'UTC')::date
 THEN extract(year FROM age((current_timestamp AT TIME ZONE 'UTC')::date,p.birth_date))::int END,
 coalesce(p.position,''),nullif(p.nationality,''),sm.shirt_number::text,
 t.id,t.name,t.abbr,t.crest_url,coalesce(sn.label||' '||c.short_name||' Stats',''),
 (SELECT count(*) FROM (SELECT 1 FROM appearance a JOIN match m ON m.id=a.match_id
 WHERE a.player_id=p.id AND m.competition_id=$2 AND m.season_id=$3
 AND m.state IN ('live','finished') LIMIT 2001) candidates)
FROM player p
LEFT JOIN player_season_stat ps ON ps.player_id=p.id AND ps.competition_id=$2 AND ps.season_id=$3
LEFT JOIN LATERAL (SELECT * FROM squad_membership
 WHERE player_id=p.id AND competition_id=$2 AND season_id=$3
 AND (ps.team_id IS NULL OR team_id=ps.team_id)
 ORDER BY updated_at DESC,team_id LIMIT 1) sm ON true
LEFT JOIN team t ON t.id=coalesce(ps.team_id,sm.team_id)
LEFT JOIN competition c ON c.id=$2
LEFT JOIN season sn ON sn.competition_id=$2 AND sn.id=$3
WHERE p.id=$1`

func (s *Store) Player(ctx context.Context, id, competition, season string) (*PlayerProfile, error) {
	if !isCanonicalPlayerID(id) {
		return nil, errors.New("invalid player id")
	}
	p := &PlayerProfile{Totals: []PlayerSeasonTotal{}, GameLog: []GameLogRow{}, Career: []CareerStint{}, GameLogLabel: "Last 5 Matches"}
	var teamID, name, abbr, crest *string
	var candidates int
	err := s.db.QueryRow(ctx, playerIdentitySQL, id, competition, season).Scan(&p.ID, &p.Name, &p.Age, &p.Position, &p.Nationality, &p.Jersey, &teamID, &name, &abbr, &crest, &p.SeasonLabel, &candidates)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if candidates > maxPlayerCandidates {
		return nil, fmt.Errorf("player appearances exceed bound")
	}
	if teamID != nil {
		p.Team = &espn.Team{ID: *teamID, Name: *name, Abbr: *abbr, CrestURL: crest}
	}
	p.Totals, err = s.playerTotals(ctx, id, competition, season)
	if err != nil {
		return nil, err
	}
	p.Career, err = s.playerCareer(ctx, id)
	if err != nil {
		return nil, err
	}
	p.GameLog, err = s.playerGameLog(ctx, id, competition, season)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (s *Store) playerTotals(ctx context.Context, id, competition, season string) ([]PlayerSeasonTotal, error) {
	var stats PlayerSeasonStats
	err := s.db.QueryRow(ctx, `SELECT appearances,sub_ins,goals,assists,shots,shots_on_target,offsides,
 fouls_committed,fouls_suffered,yellow_cards,red_cards,own_goals,saves,shots_faced,goals_conceded
 FROM player_season_stat WHERE player_id=$1 AND competition_id=$2 AND season_id=$3`, id, competition, season).Scan(
		&stats.Appearances, &stats.SubIns, &stats.TotalGoals, &stats.GoalAssists, &stats.TotalShots, &stats.ShotsOnTarget, &stats.Offsides,
		&stats.FoulsCommitted, &stats.FoulsSuffered, &stats.YellowCards, &stats.RedCards, &stats.OwnGoals, &stats.Saves, &stats.ShotsFaced, &stats.GoalsConceded)
	if errors.Is(err, pgx.ErrNoRows) {
		return []PlayerSeasonTotal{}, nil
	}
	if err != nil {
		return nil, err
	}
	totals := []PlayerSeasonTotal{
		{Name: "appearances", Label: "Appearances", Value: stats.Appearances},
		{Name: "subIns", Label: "Substitute Appearances", Value: stats.SubIns},
		{Name: "totalGoals", Label: "Total Goals", Value: stats.TotalGoals},
		{Name: "goalAssists", Label: "Assists", Value: stats.GoalAssists},
		{Name: "totalShots", Label: "Shots", Value: stats.TotalShots},
		{Name: "shotsOnTarget", Label: "Shots on Target", Value: stats.ShotsOnTarget},
		{Name: "offsides", Label: "Offsides", Value: stats.Offsides},
		{Name: "foulsCommitted", Label: "Fouls Committed", Value: stats.FoulsCommitted},
		{Name: "foulsSuffered", Label: "Fouls Suffered", Value: stats.FoulsSuffered},
		{Name: "yellowCards", Label: "Yellow Cards", Value: stats.YellowCards},
		{Name: "redCards", Label: "Red Cards", Value: stats.RedCards},
		{Name: "ownGoals", Label: "Own Goals", Value: stats.OwnGoals},
		{Name: "saves", Label: "Saves", Value: stats.Saves},
		{Name: "shotsFaced", Label: "Shots Faced", Value: stats.ShotsFaced},
		{Name: "goalsConceded", Label: "Goals Conceded", Value: stats.GoalsConceded},
	}
	for i := range totals {
		if totals[i].Value != nil {
			totals[i].Display = strconv.Itoa(*totals[i].Value)
		}
	}
	return totals, nil
}

func (s *Store) playerCareer(ctx context.Context, id string) ([]CareerStint, error) {
	rows, err := s.db.Query(ctx, `SELECT r.team_id,h.team_name,t.crest_url,h.seasons
 FROM (SELECT * FROM player_team_history WHERE player_id=$1
 ORDER BY ord,team_source_id,seasons LIMIT 50) h
 LEFT JOIN team_external_ref r ON r.source=h.source AND r.source_id=h.team_source_id
 LEFT JOIN team t ON t.id=r.team_id ORDER BY h.ord,h.team_source_id,h.seasons`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	career := []CareerStint{}
	for rows.Next() {
		var stint CareerStint
		if err := rows.Scan(&stint.TeamID, &stint.TeamName, &stint.CrestURL, &stint.Seasons); err != nil {
			return nil, err
		}
		career = append(career, stint)
	}
	return career, rows.Err()
}
