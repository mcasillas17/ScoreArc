package espn

import "github.com/mcasillas17/scorearc-backend/shared/model"

func nullableAthleteID(id string) *string {
	if id == "" {
		return nil
	}
	return &id
}

func mapLineupStats(entries []rawPlayerStat) *model.LineupStats {
	if len(entries) == 0 {
		return nil
	}
	stats := &model.LineupStats{}
	targets := map[string]**int{
		"appearances": &stats.Appearances, "subIns": &stats.SubIns,
		"totalGoals": &stats.TotalGoals, "goalAssists": &stats.GoalAssists, "totalShots": &stats.TotalShots,
		"shotsOnTarget": &stats.ShotsOnTarget, "offsides": &stats.Offsides, "foulsCommitted": &stats.FoulsCommitted,
		"foulsSuffered": &stats.FoulsSuffered, "yellowCards": &stats.YellowCards, "redCards": &stats.RedCards,
		"ownGoals": &stats.OwnGoals, "saves": &stats.Saves, "goalsConceded": &stats.GoalsConceded, "shotsFaced": &stats.ShotsFaced,
	}
	for _, entry := range entries {
		if target, ok := targets[entry.Name]; ok {
			if count, valid := wholeCount(entry.Value); valid {
				*target = &count
			}
		}
	}
	return stats
}
