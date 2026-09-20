package source

import (
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestSeasonBoundsUTCExclusiveContract(t *testing.T) {
	for _, tc := range []struct {
		name, id, bracket, start, end string
		hasBracket                    bool
	}{
		{"calendar", "2026", "", "2026-01-01", "2027-01-01", false},
		{"split", "2026-27", "", "2026-07-01", "2027-07-01", false},
		{"apertura", "2026-apertura", "", "2026-07-01", "2027-01-01", false},
		{"clausura", "2027-clausura", "", "2027-01-01", "2027-07-01", false},
		{"leap", "2024", "20240228-20240229", "2024-01-01", "2024-03-01", true},
		{"bracket capped", "2026", "20260628-20260719", "2026-01-01", "2026-07-20", true},
		{"bracket same day", "2026", "20260628-20260628", "2026-01-01", "2026-06-29", true},
		{"bracket last day", "2026", "20261220-20261231", "2026-01-01", "2027-01-01", true},
		{"bracket absent", "2026", "", "2026-01-01", "2027-01-01", true},
		{"bracket disabled", "2026", "invalid", "2026-01-01", "2027-01-01", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			season := config.Season{ID: tc.id, HasBracket: tc.hasBracket}
			if tc.bracket != "" {
				season.BracketDatesRange = &tc.bracket
			}
			start, end, err := SeasonBounds(season)
			if err != nil {
				t.Fatal(err)
			}
			if start.Format(time.RFC3339) != tc.start+"T00:00:00Z" ||
				end.Format(time.RFC3339) != tc.end+"T00:00:00Z" ||
				start.Location() != time.UTC || end.Location() != time.UTC {
				t.Fatalf("bounds=[%s,%s), want [%s,%s)", start, end, tc.start, tc.end)
			}
		})
	}
}

func TestSeasonBoundsInvalidConfigurationContract(t *testing.T) {
	for _, dates := range []string{
		"", "20260628", "20260628/20260719", "20260628-20260719-extra",
		"20260628-20261301", "20260230-20260719", "20260628-20260229",
		"20260719-20260628", "20250628-20250719", "20270101-20270119",
	} {
		t.Run(dates, func(t *testing.T) {
			if _, _, err := SeasonBounds(config.Season{
				ID: "2026", HasBracket: true, BracketDatesRange: &dates,
			}); err == nil {
				t.Fatal("invalid bracket date range accepted")
			}
		})
	}
	for _, id := range []string{"", "invalid"} {
		if _, _, err := SeasonBounds(config.Season{ID: id}); err == nil {
			t.Fatalf("invalid season %q accepted", id)
		}
	}
}

func TestSeasonBoundsAcceptsConfiguredSeasons(t *testing.T) {
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, comp := range registry.List() {
		for _, season := range comp.Seasons {
			start, end, err := SeasonBounds(season)
			if err != nil || !end.After(start) {
				t.Fatalf("%s/%s bounds=[%s,%s) err=%v", comp.ID, season.ID, start, end, err)
			}
		}
	}
}
