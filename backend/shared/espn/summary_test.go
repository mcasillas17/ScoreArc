package espn

import (
	"os"
	"strings"
	"testing"
)

func TestMapSummaryRejectsMissingTeams(t *testing.T) {
	if err := ValidateSummary([]byte(`{}`), "m1", "home", "away", true); err == nil {
		t.Fatal("expected missing-team error")
	}

}

func TestValidateSummaryChecksRequestedFinalEvent(t *testing.T) {
	raw := loadSummaryFixture(t)
	if err := ValidateSummary(raw, "760490", "4789", "464", true); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSummary(raw, "wrong", "4789", "464", true); err == nil {
		t.Fatal("expected event identity error")
	}
	if err := ValidateSummary(raw, "760490", "464", "4789", true); err == nil {
		t.Fatal("expected team identity error")
	}
}

func TestMapSummaryMapsShootoutAggregate(t *testing.T) {
	raw := []byte(`{"header":{"competitions":[{"competitors":[
		{"homeAway":"home","team":{"id":"1"},"shootoutScore":"5"},
		{"homeAway":"away","team":{"id":"2"},"shootoutScore":"4"}
	]}]}}`)
	detail, err := MapSummary(raw)
	if err != nil {
		t.Fatal(err)
	}

	if detail.Shootout == nil || detail.Shootout.HomeScore != 5 || detail.Shootout.AwayScore != 4 {
		t.Fatalf("shootout=%+v", detail.Shootout)
	}
}

func TestParseShootoutNoteUsesNamedWinner(t *testing.T) {
	got := ParseShootoutNote("Paraguay advance 4-3 on penalties", "Spain", "Paraguay")
	if got == nil || got.HomeScore != 3 || got.AwayScore != 4 {
		t.Fatalf("shootout=%+v", got)
	}
}

// loadSummaryFixture loads the recorded ESPN summary payload shared with the
// TS test (src/server/data/__fixtures__/espn-summary.json): Ivory Coast
// (home, id 4789) vs Norway (away, id 464), 2026 World Cup Round of 32.
func loadSummaryFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func TestMapSummary(t *testing.T) {
	raw := loadSummaryFixture(t)

	detail, err := MapSummary(raw)
	if err != nil {
		t.Fatalf("MapSummary returned error: %v", err)
	}

	t.Run("scorers", func(t *testing.T) {
		if len(detail.Scorers) == 0 {
			t.Fatal("expected at least one scorer")
		}
		var names []string
		for _, s := range detail.Scorers {
			if s.Player == "" {
				t.Error("scorer has empty player name")
			}
			if s.Minute == "" {
				t.Error("scorer has empty minute")
			}
			if s.TeamID == "" {
				t.Error("scorer has empty teamId")
			}
			names = append(names, s.Player)
		}
		joined := strings.Join(names, "|")
		if !strings.Contains(joined, "Antonio Nusa") {
			t.Errorf("expected scorers to include Antonio Nusa, got %v", names)
		}
		if !strings.Contains(joined, "Erling Haaland") {
			t.Errorf("expected scorers to include Erling Haaland, got %v", names)
		}
	})

	t.Run("cards", func(t *testing.T) {
		if len(detail.Cards) == 0 {
			t.Fatal("expected at least one card")
		}
		for _, c := range detail.Cards {
			if c.TeamID == "" {
				t.Error("card has empty teamId")
			}
			if c.Type != "yellow" && c.Type != "red" {
				t.Errorf("card type %q is neither yellow nor red", c.Type)
			}
		}
	})

	t.Run("winProbability home=4789 away=464", func(t *testing.T) {
		wp := detail.WinProbability
		if wp == nil {
			t.Fatal("expected non-nil winProbability")
		}
		assertClose(t, "home", wp.Home, 26.6)
		assertClose(t, "draw", wp.Draw, 29.0)
		assertClose(t, "away", wp.Away, 44.5)
		total := wp.Home + wp.Draw + wp.Away
		assertClose(t, "total", total, 100.0)
	})

	t.Run("stats home=4789 (CIV) away=464 (NOR)", func(t *testing.T) {
		if detail.Stats == nil {
			t.Fatal("expected non-nil stats")
		}
		home := detail.Stats.Home
		away := detail.Stats.Away
		assertFloatPtr(t, "home.possession", home.Possession, 47.1)
		assertFloatPtr(t, "home.shots", home.Shots, 14)
		assertFloatPtr(t, "home.shotsOnTarget", home.ShotsOnTarget, 5)
		assertFloatPtr(t, "home.passes", home.Passes, 401)
		assertFloatPtr(t, "home.corners", home.Corners, 14)
		assertFloatPtr(t, "home.fouls", home.Fouls, 6)
		assertFloatPtr(t, "away.possession", away.Possession, 52.9)
		assertFloatPtr(t, "away.shots", away.Shots, 9)
		assertFloatPtr(t, "away.shotsOnTarget", away.ShotsOnTarget, 4)
		assertFloatPtr(t, "away.passes", away.Passes, 473)
		assertFloatPtr(t, "away.corners", away.Corners, 3)
		assertFloatPtr(t, "away.fouls", away.Fouls, 7)
		// fraction-scale accuracy stats normalize to 0-100
		assertFloatPtr(t, "home.passAccuracy", home.PassAccuracy, 80)
		assertFloatPtr(t, "away.passAccuracy", away.PassAccuracy, 90)
	})

	t.Run("shootout is nil for a fixture with no shootout", func(t *testing.T) {
		if detail.ShootoutDetail != nil {
			t.Errorf("expected nil shootoutDetail, got %+v", detail.ShootoutDetail)
		}
	})

	t.Run("lineups home=4789 away=464", func(t *testing.T) {
		if detail.Lineups == nil {
			t.Fatal("expected non-nil lineups")
		}
		if detail.Lineups.Home.Formation == "" {
			t.Error("expected non-empty home formation")
		}
		if len(detail.Lineups.Home.Players) != 11 {
			t.Errorf("expected 11 home starters, got %d", len(detail.Lineups.Home.Players))
		}
		if len(detail.Lineups.Away.Players) != 11 {
			t.Errorf("expected 11 away starters, got %d", len(detail.Lineups.Away.Players))
		}
		var withJersey int
		for _, p := range detail.Lineups.Home.Players {
			if p.Name == "" {
				t.Error("expected non-empty player name")
			}
			if p.Jersey != nil {
				withJersey++
				if !strings.HasPrefix(*p.Jersey, "https://") {
					t.Errorf("jersey url %q does not start with https://", *p.Jersey)
				}
			}
		}
		if withJersey == 0 {
			t.Error("expected at least one home starter with a jersey image")
		}
	})

	t.Run("videos", func(t *testing.T) {
		if len(detail.Videos) == 0 {
			t.Fatal("expected at least one video")
		}
		seenNonGoal := false
		for _, v := range detail.Videos {
			if v.Mp4URL == nil || !strings.Contains(*v.Mp4URL, ".mp4") {
				t.Errorf("video %q missing playable mp4 url", v.Headline)
			}
			if !v.IsGoal {
				seenNonGoal = true
			} else if seenNonGoal {
				t.Error("goal clip found after a non-goal clip; goals should sort first")
			}
		}
		if detail.Videos[0].Headline == "" {
			t.Error("expected first video to carry a headline")
		}
		var anyGoal bool
		for _, v := range detail.Videos {
			if v.IsGoal {
				anyGoal = true
			}
		}
		if !anyGoal {
			t.Error("expected at least one goal-flagged video")
		}
	})

	t.Run("info", func(t *testing.T) {
		if detail.Info == nil {
			t.Fatal("expected non-nil info")
		}
		if detail.Info.Venue == nil || *detail.Info.Venue == "" {
			t.Error("expected non-empty venue")
		}
	})

	t.Run("form", func(t *testing.T) {
		if detail.Form == nil {
			t.Fatal("expected non-nil form")
		}
		if len(detail.Form.Home) > 5 || len(detail.Form.Away) > 5 {
			t.Error("form entries should be capped at 5")
		}
		for _, r := range detail.Form.Home {
			if r.Result != "W" && r.Result != "L" && r.Result != "D" {
				t.Errorf("unexpected form result %q", r.Result)
			}
		}
	})

	t.Run("commentary", func(t *testing.T) {
		if len(detail.Commentary) == 0 {
			t.Fatal("expected non-empty commentary")
		}
		for _, c := range detail.Commentary {
			if c.Text == "" {
				t.Error("commentary item has empty text")
			}
		}
	})

	t.Run("h2h resilience", func(t *testing.T) {
		// The fixture's only headToHeadGames group has zero prior meetings, so
		// h2h is expected to be empty here; label formatting is exercised via
		// the resilience cases below.
		if detail.H2H == nil {
			t.Error("expected h2h to be a non-nil empty slice")
		}
	})
}

func TestMapSummaryShootoutDetail(t *testing.T) {
	synthetic := []byte(`{
		"shootout": [
			{"id": "H", "team": "Home", "shots": [
				{"shotNumber": 1, "player": "A", "didScore": true},
				{"shotNumber": 2, "player": "B", "didScore": false}
			]},
			{"id": "A", "team": "Away", "shots": [
				{"shotNumber": 1, "player": "C", "didScore": true}
			]}
		]
	}`)

	sd := mapSummaryShootoutDetail(mustParseRawSummary(t, synthetic), "H", "A")
	if sd == nil {
		t.Fatal("expected non-nil shootout detail")
	}
	if len(sd.Home) != 2 {
		t.Fatalf("expected 2 home kicks, got %d", len(sd.Home))
	}
	if !sd.Home[0].Scored {
		t.Error("expected first home kick to be scored")
	}
	if sd.Home[1].Scored {
		t.Error("expected second home kick to be missed")
	}
	if sd.Home[1].Order != 2 {
		t.Errorf("expected second home kick order 2, got %d", sd.Home[1].Order)
	}
	if sd.Away[0].Player != "C" {
		t.Errorf("expected away kicker C, got %q", sd.Away[0].Player)
	}

	// Ids not present in the shootout -> nil.
	if got := mapSummaryShootoutDetail(mustParseRawSummary(t, synthetic), "X", "Y"); got != nil {
		t.Errorf("expected nil for unmatched ids, got %+v", got)
	}

	// MapSummary as a whole must not error just because this synthetic
	// payload has no `header` to derive home/away ids from — it simply
	// can't resolve ShootoutDetail (or anything else id-scoped) in that case.
	if _, err := MapSummary(synthetic); err != nil {
		t.Fatalf("MapSummary returned error on a headerless payload: %v", err)
	}
}

func TestMapWinProbabilitySwapsLegs(t *testing.T) {
	raw := loadSummaryFixture(t)
	parsed := mustParseRawSummary(t, raw)

	home := mapWinProbability(parsed, "4789", "464")
	swapped := mapWinProbability(parsed, "464", "4789")
	if home == nil || swapped == nil {
		t.Fatal("expected non-nil win probabilities")
	}
	assertClose(t, "swapped.home", swapped.Home, home.Away)
	assertClose(t, "swapped.away", swapped.Away, home.Home)
}

func TestMapWinProbabilityNilOnMissingOdds(t *testing.T) {
	if wp := mapWinProbability(mustParseRawSummary(t, []byte(`{}`)), "a", "b"); wp != nil {
		t.Errorf("expected nil, got %+v", wp)
	}
}

func TestMapSummaryScorersResilience(t *testing.T) {
	input := []byte(`{
		"keyEvents": [
			{"scoringPlay": true, "clock": {"displayValue": "10'"}},
			{"scoringPlay": true, "team": {"id": "1"}, "clock": {"displayValue": "20'"},
			 "participants": [{"athlete": {"displayName": "Player A"}}],
			 "penaltyKick": false, "shootout": false}
		]
	}`)
	scorers := mapSummaryScorers(mustParseRawSummary(t, input))
	if len(scorers) != 1 {
		t.Fatalf("expected 1 scorer (event without team skipped), got %d", len(scorers))
	}
	if scorers[0].Player != "Player A" {
		t.Errorf("expected Player A, got %q", scorers[0].Player)
	}
}

func TestMapSummaryStatsMissingStatIsNilNotZero(t *testing.T) {
	partial := []byte(`{
		"boxscore": {
			"teams": [
				{"team": {"id": "4789"}, "statistics": [{"name": "totalShots", "displayValue": "5"}]},
				{"team": {"id": "464"}, "statistics": [{"name": "totalShots", "displayValue": "3"}]}
			]
		}
	}`)
	s := mapSummaryStats(mustParseRawSummary(t, partial), "4789", "464")
	if s == nil {
		t.Fatal("expected non-nil stats")
	}
	assertFloatPtr(t, "home.shots", s.Home.Shots, 5)
	if s.Home.Saves != nil {
		t.Errorf("expected nil saves (stat absent), got %v", *s.Home.Saves)
	}
	if s.Home.PassAccuracy != nil {
		t.Errorf("expected nil passAccuracy (stat absent), got %v", *s.Home.PassAccuracy)
	}
}

func TestMapSummaryStatsNilOnMismatch(t *testing.T) {
	if s := mapSummaryStats(mustParseRawSummary(t, []byte(`{}`)), "a", "b"); s != nil {
		t.Errorf("expected nil, got %+v", s)
	}
	raw := loadSummaryFixture(t)
	if s := mapSummaryStats(mustParseRawSummary(t, raw), "x", "y"); s != nil {
		t.Errorf("expected nil for unmatched team ids, got %+v", s)
	}
}

func TestValidateSummaryAcceptsNumericIdentityAndScores(t *testing.T) {
	raw := []byte(`{"header":{"id":123,"competitions":[{
		"id":123,
		"status":{"type":{"completed":true}},
		"competitors":[
			{"homeAway":"home","team":{"id":1},"score":2},
			{"homeAway":"away","team":{"id":2},"score":1}
		]
	}]}}`)
	if err := ValidateSummary(raw, "123", "1", "2", true); err != nil {
		t.Fatal(err)
	}
}

// --- helpers ---

func mustParseRawSummary(t *testing.T, raw []byte) rawSummary {
	t.Helper()
	var rs rawSummary
	if err := parseRawSummary(raw, &rs); err != nil {
		t.Fatalf("parseRawSummary: %v", err)
	}
	return rs
}

func assertClose(t *testing.T, label string, got, want float64) {
	t.Helper()
	const eps = 0.5 // mirrors vitest's toBeCloseTo(want, 0): within 0.5
	if got < want-eps || got > want+eps {
		t.Errorf("%s: got %v, want ~%v", label, got, want)
	}
}

func assertFloatPtr(t *testing.T, label string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s: got nil, want %v", label, want)
		return
	}
	if *got != want {
		t.Errorf("%s: got %v, want %v", label, *got, want)
	}
}
