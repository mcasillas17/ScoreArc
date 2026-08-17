package espn

import (
	"os"
	"testing"
)

func TestMapLeadersRejectsMalformedLeaders(t *testing.T) {
	raw := []byte(`{"stats":[{"name":"goalsLeaders","leaders":[{"value":3,"athlete":{}}]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 10); err == nil {
		t.Fatal("expected malformed scorer error")
	}
}

func TestMapLeadersRejectsFractionalCounts(t *testing.T) {
	raw := []byte(`{"stats":[{"name":"goalsLeaders","leaders":[{"value":1.5,"athlete":{"displayName":"Player"}}]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 20); err == nil {
		t.Fatal("expected fractional count error")
	}
}

func loadStatisticsFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/espn-statistics.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func TestMapLeadersGoals(t *testing.T) {
	raw := loadStatisticsFixture(t)

	scorers, err := MapLeaders(raw, "goalsLeaders", 20)
	if err != nil {
		t.Fatalf("MapLeaders returned error: %v", err)
	}

	t.Run("returns a ranked list starting at 1", func(t *testing.T) {
		if len(scorers) == 0 {
			t.Fatal("got 0 scorers, want > 0")
		}
		if scorers[0].Rank != 1 {
			t.Errorf("scorers[0].Rank = %d, want 1", scorers[0].Rank)
		}
		if scorers[1].Rank != 2 {
			t.Errorf("scorers[1].Rank = %d, want 2", scorers[1].Rank)
		}
	})

	t.Run("is sorted by goals descending", func(t *testing.T) {
		for i := 1; i < len(scorers); i++ {
			if scorers[i-1].Value < scorers[i].Value {
				t.Errorf("scorers[%d].Value=%d < scorers[%d].Value=%d, want non-increasing", i-1, scorers[i-1].Value, i, scorers[i].Value)
			}
		}
	})

	t.Run("maps player, team abbreviation and goals", func(t *testing.T) {
		top := scorers[0]
		if top.Player == "" {
			t.Error("Player is empty")
		}
		if top.TeamAbbr == "" {
			t.Error("TeamAbbr is empty")
		}
		if top.Value <= 0 {
			t.Errorf("Value = %d, want > 0", top.Value)
		}
	})

	t.Run("parses matches played from the display value", func(t *testing.T) {
		anyNonNil := false
		for _, s := range scorers {
			if s.Matches != nil {
				if *s.Matches <= 0 {
					t.Errorf("Matches = %d, want > 0 or nil", *s.Matches)
				}
				anyNonNil = true
			}
		}
		if !anyNonNil {
			t.Error("expected at least one scorer with non-nil Matches")
		}
	})

	t.Run("caps the list at the requested limit", func(t *testing.T) {
		capped, err := MapLeaders(raw, "goalsLeaders", 5)
		if err != nil {
			t.Fatalf("MapLeaders returned error: %v", err)
		}
		if len(capped) != 5 {
			t.Errorf("got %d scorers, want 5", len(capped))
		}
	})

	t.Run("treats an absent pre-season dataset as empty", func(t *testing.T) {
		for _, raw := range [][]byte{[]byte(`{}`), []byte(`null`)} {
			got, err := MapLeaders(raw, "goalsLeaders", 20)
			if err != nil || len(got) != 0 {
				t.Fatalf("scorers=%v err=%v", got, err)
			}
		}
	})

	t.Run("sets teamCrestUrl to null when the fixture team has no logo", func(t *testing.T) {
		if scorers[0].TeamCrestURL != nil {
			t.Errorf("scorers[0].TeamCrestURL = %v, want nil", *scorers[0].TeamCrestURL)
		}
		for _, s := range scorers {
			if s.TeamCrestURL != nil {
				t.Errorf("TeamCrestURL = %v, want nil for all fixture scorers", *s.TeamCrestURL)
			}
		}
	})

	t.Run("maps teamCrestUrl from team.logo when present", func(t *testing.T) {
		payload := []byte(`{
			"stats": [{
				"name": "goalsLeaders",
				"leaders": [{
					"value": 3,
					"displayValue": "Matches: 2, Goals: 3",
					"athlete": {
						"displayName": "Test Player",
						"team": { "abbreviation": "TST", "displayName": "Test FC", "logo": "https://a.espncdn.com/test.png" }
					}
				}]
			}]
		}`)
		result, err := MapLeaders(payload, "goalsLeaders", 20)
		if err != nil {
			t.Fatalf("MapLeaders returned error: %v", err)
		}
		if len(result) != 1 || result[0].TeamCrestURL == nil || *result[0].TeamCrestURL != "https://a.espncdn.com/test.png" {
			t.Errorf("got %+v, want TeamCrestURL=https://a.espncdn.com/test.png", result)
		}
	})

	t.Run("maps teamCrestUrl from team.logos[0].href when team.logo is absent", func(t *testing.T) {
		payload := []byte(`{
			"stats": [{
				"name": "goalsLeaders",
				"leaders": [{
					"value": 2,
					"displayValue": "Matches: 1, Goals: 2",
					"athlete": {
						"displayName": "Another Player",
						"team": {
							"abbreviation": "ANO",
							"displayName": "Another FC",
							"logos": [{ "href": "https://a.espncdn.com/logos/team.png" }]
						}
					}
				}]
			}]
		}`)
		result, err := MapLeaders(payload, "goalsLeaders", 20)
		if err != nil {
			t.Fatalf("MapLeaders returned error: %v", err)
		}
		if len(result) != 1 || result[0].TeamCrestURL == nil || *result[0].TeamCrestURL != "https://a.espncdn.com/logos/team.png" {
			t.Errorf("got %+v, want TeamCrestURL=https://a.espncdn.com/logos/team.png", result)
		}
	})
}

// The point of the generalisation, against the fixture already in the repo.
func TestMapLeadersReadsBothBoardsFromOneResponse(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-statistics.json")
	if err != nil {
		t.Fatal(err)
	}
	goals, err := MapLeaders(raw, "goalsLeaders", 50)
	if err != nil {
		t.Fatal(err)
	}
	assists, err := MapLeaders(raw, "assistsLeaders", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(goals) != 50 {
		t.Fatalf("goals = %d, want 50", len(goals))
	}
	if len(assists) != 50 {
		t.Fatalf("assists = %d, want 50 -- this board was in the payload all along",
			len(assists))
	}
	// Ranks are per board. Both start at 1, and that is exactly why category
	// had to join the primary key.
	if goals[0].Rank != 1 || assists[0].Rank != 1 {
		t.Fatalf("ranks = %d/%d, want 1 and 1", goals[0].Rank, assists[0].Rank)
	}
}

// A category ESPN does not publish for this competition is an empty board, not
// an error. Coverage varies, and a hard failure here would take down the whole
// competition's ingest over a leaderboard nobody asked for.
func TestMapLeadersReturnsEmptyForAnAbsentCategory(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-statistics.json")
	if err != nil {
		t.Fatal(err)
	}
	board, err := MapLeaders(raw, "cleanSheetsLeaders", 20)
	if err != nil {
		t.Fatalf("an absent category must not be an error: %v", err)
	}
	if len(board) != 0 {
		t.Fatalf("board = %d, want 0", len(board))
	}
}

// The validation MapTopScorers already had must survive the generalisation: a
// leaderboard row with no player, or a fractional count, is a payload we do not
// understand and publishing it would put a wrong number on the front page.
func TestMapLeadersStillRejectsAnImpossibleRow(t *testing.T) {
	raw := []byte(`{"stats":[{"name":"goalsLeaders","leaders":[
	  {"value":1.5,"displayValue":"Matches: 3","athlete":{"displayName":"Striker","team":{}}}]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 20); err == nil {
		t.Fatal("want an error for a fractional goal count")
	}
	raw = []byte(`{"stats":[{"name":"goalsLeaders","leaders":[
	  {"value":3,"displayValue":"Matches: 3","athlete":{"team":{}}}]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 20); err == nil {
		t.Fatal("want an error for a row with no player identity")
	}
}
