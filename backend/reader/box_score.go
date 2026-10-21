package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const maxRosterPlayers = 64
const maxParticipationEvents = 512

type BoxScoreTeam struct {
	TeamID  string               `json:"teamId"`
	Players []model.LineupPlayer `json:"players"`
}

type BoxScore struct {
	MatchID      string       `json:"matchId"`
	Availability string       `json:"availability"`
	Home         BoxScoreTeam `json:"home"`
	Away         BoxScoreTeam `json:"away"`
}

// Limit the match roster before player and source-qualified identity joins.
const boxScorePlayersSQL = `
SELECT a.player_id::text,a.team_id,p.full_name,a.starter,a.shirt_number,coalesce(a.position,''),r.source_id,
 a.goals,a.assists,a.shots,a.shots_on_target,a.offsides,a.fouls_committed,a.fouls_suffered,
 a.yellow_cards,a.red_cards,a.own_goals,a.saves,a.goals_conceded,a.shots_faced
FROM (SELECT * FROM appearance WHERE match_id=$1 ORDER BY team_id,starter DESC,shirt_number NULLS LAST,player_id LIMIT 65) a
JOIN player p ON p.id=a.player_id
LEFT JOIN LATERAL (SELECT CASE WHEN count(*)=1 THEN min(source_id) END AS source_id
 FROM (SELECT source_id FROM player_external_ref
 WHERE player_id=a.player_id AND source=$2 AND source='espn' LIMIT 2) refs) r ON true
ORDER BY a.team_id,a.starter DESC,a.shirt_number NULLS LAST,a.player_id`

func (s *Store) BoxScore(ctx context.Context, id string) (*BoxScore, error) {
	if !isCanonicalMatchID(id) {
		return nil, ErrNotFound
	}
	box := &BoxScore{MatchID: id, Availability: "unavailable", Home: BoxScoreTeam{Players: []model.LineupPlayer{}}, Away: BoxScoreTeam{Players: []model.LineupPlayer{}}}
	var source string
	var completed *bool
	err := s.db.QueryRow(ctx, `SELECT m.home_team_id,m.away_team_id,m.source,p.completed FROM match m LEFT JOIN match_participation_availability p ON p.match_id=m.id WHERE m.id=$1`, id).Scan(&box.Home.TeamID, &box.Away.TeamID, &source, &completed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, boxScorePlayersSQL, id, source)
	if err != nil {
		return nil, err
	}
	count := 0
	for rows.Next() {
		var player model.LineupPlayer
		var team string
		stats := &model.LineupStats{}
		if err = rows.Scan(&player.PlayerID, &team, &player.Name, &player.Starter, &player.Number, &player.Position, &player.AthleteID,
			&stats.TotalGoals, &stats.GoalAssists, &stats.TotalShots, &stats.ShotsOnTarget, &stats.Offsides, &stats.FoulsCommitted, &stats.FoulsSuffered,
			&stats.YellowCards, &stats.RedCards, &stats.OwnGoals, &stats.Saves, &stats.GoalsConceded, &stats.ShotsFaced); err != nil {
			rows.Close()
			return nil, err
		}
		count++
		if count > maxRosterPlayers {
			rows.Close()
			return nil, fmt.Errorf("match roster exceeds bound")
		}
		player.Stats = stats
		switch team {
		case box.Home.TeamID:
			box.Home.Players = append(box.Home.Players, player)
		case box.Away.TeamID:
			box.Away.Players = append(box.Away.Players, player)
		default:
			rows.Close()
			return nil, fmt.Errorf("match roster side mismatch")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if completed != nil {
		box.Availability = "pending"
		if *completed {
			box.Availability = "complete"
		}
	} else if count > 0 {
		box.Availability = "partial"
	}
	// A bounded whole event set avoids one query per player and fails closed on overflow.
	events, err := s.db.Query(ctx, `SELECT player_id::text,team_id,type FROM match_event WHERE match_id=$1 ORDER BY seq LIMIT 513`, id)
	if err != nil {
		return nil, err
	}
	subbed := map[string]string{}
	// Contradictory on-pitch events cannot prove an unused bench zero. Cards can happen off-pitch.
	onPitch := map[string]bool{}
	eventCount := 0
	for events.Next() {
		var playerID *string
		var team, kind string
		if err = events.Scan(&playerID, &team, &kind); err != nil {
			events.Close()
			return nil, err
		}
		eventCount++
		if eventCount > maxParticipationEvents {
			events.Close()
			return nil, fmt.Errorf("match events exceed bound")
		}
		if kind == model.PlayerEventSubOn && playerID != nil {
			subbed[*playerID] = team
		}
		if playerID != nil {
			switch kind {
			case model.PlayerEventGoal, model.PlayerEventOwnGoal, model.PlayerEventSubOff:
				onPitch[*playerID] = true
			}
		}
	}
	err = events.Err()
	events.Close()
	if err != nil {
		return nil, err
	}
	for _, side := range []*BoxScoreTeam{&box.Home, &box.Away} {
		for i := range side.Players {
			player := &side.Players[i]
			zero, one := 0, 1
			if *player.Starter {
				player.Stats.Appearances = &one
				player.Stats.SubIns = &zero
			} else if subbed[*player.PlayerID] == side.TeamID {
				player.Stats.Appearances = &one
				player.Stats.SubIns = &one
			} else if box.Availability == "complete" && !onPitch[*player.PlayerID] && !hasOnPitchMeasurements(player.Stats) {
				player.Stats.Appearances = &zero
				player.Stats.SubIns = &zero
			}
		}
	}
	return box, nil
}

// Bench cards do not prove play; positive on-pitch measurements contradict an unused zero.
func hasOnPitchMeasurements(stats *model.LineupStats) bool {
	for _, count := range []*int{stats.TotalGoals, stats.GoalAssists, stats.TotalShots, stats.ShotsOnTarget,
		stats.Offsides, stats.FoulsCommitted, stats.FoulsSuffered, stats.OwnGoals,
		stats.Saves, stats.GoalsConceded, stats.ShotsFaced} {
		if count != nil && *count > 0 {
			return true
		}
	}
	return false
}

func (a *App) handleBoxScore(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "id")
	if !isCanonicalMatchID(id) {
		writeError(writer, http.StatusNotFound, "match not found")
		return
	}
	if parseNoQuery(request.URL.RawQuery) != nil {
		writeError(writer, http.StatusBadRequest, "invalid query")
		return
	}
	reader, finish, ok := a.beginMatchSnapshot(writer, request)
	if !ok {
		return
	}
	defer finish()
	box, err := reader.BoxScore(request.Context(), id)
	if errors.Is(err, ErrNotFound) {
		finish()
		writeError(writer, http.StatusNotFound, "match not found")
		return
	}
	if err != nil {
		finish()
		a.logger.Error("box score unavailable")
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	finish()
	cacheFor(writer, 30)
	writeContractJSON(writer, box)
}
