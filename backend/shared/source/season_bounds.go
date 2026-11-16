package source

import (
	"fmt"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

// SeasonBounds shares the provider's calendar scope with freshness checks.
// End is exclusive; an explicit knockout end may close a cup earlier.
func SeasonBounds(season config.Season) (start, end time.Time, err error) {
	if season.StartsAt != "" || season.EndsAt != "" {
		start, err = time.Parse(time.RFC3339, season.StartsAt)
		if err != nil {
			return start, end, err
		}
		end, err = time.Parse(time.RFC3339, season.EndsAt)
		if err == nil && !end.After(start) {
			err = fmt.Errorf("invalid edition bounds for %s", season.ID)
		}
		return start.UTC(), end.UTC(), err
	}
	window, err := fullSeasonRange(season.ID)
	if err != nil {
		return start, end, err
	}
	start, err = time.Parse("20060102", window[:8])
	if err != nil {
		return start, end, err
	}
	end, err = time.Parse("20060102", window[9:])
	if err != nil {
		return start, end, err
	}
	end = end.AddDate(0, 0, 1)
	if season.HasBracket && season.BracketDatesRange != nil {
		parts := strings.Split(*season.BracketDatesRange, "-")
		if len(parts) != 2 {
			return start, end, fmt.Errorf("invalid bracket date range for %s", season.ID)
		}
		bracketStart, startErr := time.Parse("20060102", parts[0])
		bracketEnd, endErr := time.Parse("20060102", parts[1])
		if startErr != nil || endErr != nil || bracketEnd.Before(bracketStart) ||
			bracketStart.Before(start) || !bracketEnd.Before(end) {
			return start, end, fmt.Errorf("invalid bracket date range for %s", season.ID)
		}
		end = bracketEnd.AddDate(0, 0, 1)
	}
	return start, end, nil
}
