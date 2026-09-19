package source

import (
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestSeasonBoundsCalendarAndBracketEnd(t *testing.T) {
	bracket := "20260701-20260719"
	for _, tc := range []struct {
		season config.Season
		start  string
		end    string
	}{
		{config.Season{ID: "2026-27"}, "2026-07-01", "2027-07-01"},
		{config.Season{ID: "2026-apertura"}, "2026-07-01", "2027-01-01"},
		{config.Season{ID: "2026-clausura"}, "2026-01-01", "2026-07-01"},
		{config.Season{ID: "2026", HasBracket: true, BracketDatesRange: &bracket}, "2026-01-01", "2026-07-20"},
	} {
		start, end, err := SeasonBounds(tc.season)
		if err != nil || start.Format(time.DateOnly) != tc.start || end.Format(time.DateOnly) != tc.end {
			t.Fatalf("%s: start=%v end=%v err=%v", tc.season.ID, start, end, err)
		}
	}
	for _, malformed := range []string{"bad", "20260721-20260719", "20260701-20260231", "20270701-20270719"} {
		if _, _, err := SeasonBounds(config.Season{ID: "2026", HasBracket: true, BracketDatesRange: &malformed}); err == nil {
			t.Fatalf("accepted invalid bracket season boundary %q", malformed)
		}
	}
}
