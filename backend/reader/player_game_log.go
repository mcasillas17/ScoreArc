package main

import (
	"context"
	"fmt"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type GameLogRow struct {
	EventID    string            `json:"eventId"`
	Appearance string            `json:"appearance"`
	Stats      model.LineupStats `json:"stats"`
	Date       *string           `json:"date"`
	AtVs       string            `json:"atVs"`
	Opponent   *espn.Team        `json:"opponent"`
	Score      string            `json:"score"`
	Result     string            `json:"result"`
	HomeTeamID *string           `json:"homeTeamId"`
	AwayTeamID *string           `json:"awayTeamId"`
	TeamID     *string           `json:"teamId"`
	TeamAbbr   string            `json:"teamAbbr"`
}

// Identity preflights at most 2,001 scoped roster rows in the same snapshot.
// Event evidence is bounded before aggregation; all five matches use one query.
const playerGameLogSQL = `
WITH candidates AS MATERIALIZED (
 SELECT a.*,m.kickoff,m.state,m.home_team_id,m.away_team_id,m.home_score,m.away_score
 FROM appearance a JOIN match m ON m.id=a.match_id
 WHERE a.player_id=$1 AND m.competition_id=$2 AND m.season_id=$3
 AND m.state IN ('live','finished')
 ORDER BY m.kickoff DESC,m.id DESC LIMIT 2001
), played AS (
 SELECT a.*,e.subbed,e.on_pitch,e.event_count,p.completed
 FROM candidates a
 LEFT JOIN match_participation_availability p ON p.match_id=a.match_id
 CROSS JOIN LATERAL (
 SELECT count(*) AS event_count,
 coalesce(bool_or(player_id=a.player_id AND team_id=a.team_id AND type='sub_on'),false) AS subbed,
 coalesce(bool_or(player_id=a.player_id AND type IN ('goal','own_goal','sub_off')),false) AS on_pitch
 FROM (SELECT player_id,team_id,type FROM match_event WHERE match_id=a.match_id ORDER BY seq LIMIT 513) events
 ) e
 WHERE a.starter OR e.subbed OR e.on_pitch OR e.event_count>512
 OR greatest(a.goals,a.assists,a.shots,a.shots_on_target,a.offsides,a.fouls_committed,
 a.fouls_suffered,a.own_goals,a.saves,a.goals_conceded,a.shots_faced)>0
 ORDER BY a.kickoff DESC,a.match_id DESC LIMIT 5
)
SELECT a.match_id::text,a.kickoff,a.state,a.home_team_id,a.away_team_id,a.team_id,own.abbr,
 a.home_score,a.away_score,a.starter,a.subbed,a.on_pitch,coalesce(a.completed,false),a.event_count,
 a.goals,a.assists,a.shots,a.shots_on_target,a.offsides,a.fouls_committed,a.fouls_suffered,
 a.yellow_cards,a.red_cards,a.own_goals,a.saves,a.goals_conceded,a.shots_faced,
 opp.id,opp.name,opp.abbr,opp.crest_url
FROM played a JOIN team own ON own.id=a.team_id
JOIN team opp ON opp.id=CASE WHEN a.team_id=a.home_team_id THEN a.away_team_id ELSE a.home_team_id END
ORDER BY a.kickoff DESC,a.match_id DESC`

func (s *Store) playerGameLog(ctx context.Context, id, competition, season string) ([]GameLogRow, error) {
	rows, err := s.db.Query(ctx, playerGameLogSQL, id, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	log := []GameLogRow{}
	for rows.Next() {
		var row GameLogRow
		var kickoff time.Time
		var state, home, away, team string
		var homeScore, awayScore *int
		var starter, subbed, onPitch, complete bool
		var events int
		opponent := &espn.Team{}
		stats := &row.Stats
		if err := rows.Scan(&row.EventID, &kickoff, &state, &home, &away, &team, &row.TeamAbbr,
			&homeScore, &awayScore, &starter, &subbed, &onPitch, &complete, &events,
			&stats.TotalGoals, &stats.GoalAssists, &stats.TotalShots, &stats.ShotsOnTarget, &stats.Offsides, &stats.FoulsCommitted, &stats.FoulsSuffered,
			&stats.YellowCards, &stats.RedCards, &stats.OwnGoals, &stats.Saves, &stats.GoalsConceded, &stats.ShotsFaced,
			&opponent.ID, &opponent.Name, &opponent.Abbr, &opponent.CrestURL); err != nil {
			return nil, err
		}
		if events > maxParticipationEvents {
			return nil, fmt.Errorf("player match events exceed bound")
		}
		if team != home && team != away {
			return nil, fmt.Errorf("player match side mismatch")
		}
		setParticipationStats(stats, starter, subbed, complete, onPitch)
		if starter {
			row.Appearance = "Started"
		} else if subbed {
			row.Appearance = "Sub"
		}
		date := isoTime(kickoff)
		row.Date = &date
		row.HomeTeamID, row.AwayTeamID, row.TeamID = &home, &away, &team
		row.Opponent = opponent
		row.AtVs = "vs"
		if team == away {
			row.AtVs = "@"
		}
		if homeScore != nil && awayScore != nil {
			row.Score = fmt.Sprintf("%d-%d", *homeScore, *awayScore)
			if state == "finished" {
				row.Result = "D"
				if *homeScore != *awayScore {
					row.Result = "L"
					if (*homeScore > *awayScore) == (team == home) {
						row.Result = "W"
					}
				}
			}
		}
		log = append(log, row)
	}
	return log, rows.Err()
}
