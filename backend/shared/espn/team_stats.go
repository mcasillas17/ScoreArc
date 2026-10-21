package espn

import (
	"math"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// Preserve invalid-present operands until normalization has rejected their ratio.
func parseTeamOperand(stats []rawStatEntry, name string) *float64 {
	value := parseStat(stats, name)
	if value != nil {
		return value
	}
	for _, stat := range stats {
		if stat.Name == name {
			invalid := math.NaN()
			return &invalid
		}
	}
	return nil
}

// ESPN accuracy values are fractions; possession is already a percentage.
func parsePct(stats []rawStatEntry, name string) *float64 {
	value := parseStat(stats, name)
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 || *value > 1 {
		return nil
	}
	normalized := math.Round(*value*1000) / 10
	return &normalized
}

// buildTeamStats ports buildTeamStats: pulls the fixed stat set out of a
// boxscore team's `statistics` array.
func buildTeamStats(stats []rawStatEntry) TeamStats {
	result := TeamStats{
		Possession:       parseStat(stats, "possessionPct"),
		Shots:            parseTeamOperand(stats, "totalShots"),
		ShotsOnTarget:    parseTeamOperand(stats, "shotsOnTarget"),
		ShotAccuracy:     parsePct(stats, "shotPct"),
		Corners:          parseStat(stats, "wonCorners"),
		Offsides:         parseStat(stats, "offsides"),
		Passes:           parseTeamOperand(stats, "totalPasses"),
		PassesAccurate:   parseTeamOperand(stats, "accuratePasses"),
		PassAccuracy:     parsePct(stats, "passPct"),
		Crosses:          parseTeamOperand(stats, "totalCrosses"),
		CrossesAccurate:  parseTeamOperand(stats, "accurateCrosses"),
		CrossAccuracy:    parsePct(stats, "crossPct"),
		LongBalls:        parseStat(stats, "totalLongBalls"),
		Tackles:          parseTeamOperand(stats, "totalTackles"),
		TacklesEffective: parseTeamOperand(stats, "effectiveTackles"),
		TackleAccuracy:   parsePct(stats, "tacklePct"),
		Interceptions:    parseStat(stats, "interceptions"),
		Clearances:       parseStat(stats, "totalClearance"),
		BlockedShots:     parseStat(stats, "blockedShots"),
		Saves:            parseStat(stats, "saves"),
		Fouls:            parseStat(stats, "foulsCommitted"),
		YellowCards:      parseStat(stats, "yellowCards"),
		RedCards:         parseStat(stats, "redCards"),
	}
	model.NormalizeTeamStats(&result)
	return result
}
