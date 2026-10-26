package model

import "math"

// NormalizeTeamStats prefers captured counts to rounded provider percentages.
// Stored percentages already use 0–100; a value below one is not a fraction.
func NormalizeTeamStats(stats *TeamStats) {
	stats.ShotAccuracy = accuracyPercentage(stats.ShotsOnTarget, stats.Shots, stats.ShotAccuracy)
	stats.PassAccuracy = accuracyPercentage(stats.PassesAccurate, stats.Passes, stats.PassAccuracy)
	stats.CrossAccuracy = accuracyPercentage(stats.CrossesAccurate, stats.Crosses, stats.CrossAccuracy)
	stats.TackleAccuracy = accuracyPercentage(stats.TacklesEffective, stats.Tackles, stats.TackleAccuracy)
	// Validate before discarding invalid operands so they cannot become a missing-operand fallback.
	for _, count := range []**float64{&stats.Shots, &stats.ShotsOnTarget, &stats.Passes, &stats.PassesAccurate,
		&stats.Crosses, &stats.CrossesAccurate, &stats.Tackles, &stats.TacklesEffective} {
		if *count != nil && !validCount(**count) {
			*count = nil
		}
	}
}

func validCount(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func accuracyPercentage(numerator, denominator, provided *float64) *float64 {
	if numerator != nil && !validCount(*numerator) || denominator != nil && (!validCount(*denominator) || *denominator == 0) {
		return nil
	}
	var value float64
	if numerator != nil && denominator != nil {
		if *numerator > *denominator {
			return nil
		}
		value = *numerator / *denominator * 100
	} else {
		if provided == nil || !validCount(*provided) || *provided > 100 {
			return nil
		}
		value = *provided
	}
	value = math.Round(value*10) / 10
	return &value
}
