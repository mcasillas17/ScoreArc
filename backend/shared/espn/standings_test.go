package espn

import (
	"encoding/json"
	"os"
	"testing"
)

func TestMapStandingsRejectsMalformedRows(t *testing.T) {
	raw := []byte(`{"children":[{"name":"League","standings":{"entries":[{"team":{"id":""}}]}}]}`)
	if _, err := MapStandings(raw); err == nil {
		t.Fatal("expected malformed standing error")
	}
}

func TestMapStandingsRejectsEmptyGroup(t *testing.T) {
	raw := []byte(`{"children":[{"name":"Group A","standings":{"entries":[]}}]}`)
	if _, err := MapStandings(raw); err == nil {
		t.Fatal("expected empty standings group error")
	}
}

func TestMapStandingsRejectsMissingRequiredStats(t *testing.T) {
	raw := []byte(`{"children":[{"name":"League","standings":{"entries":[{
		"team":{"id":"1","displayName":"Team","abbreviation":"TST"},
		"stats":[{"name":"gamesPlayed","value":1}]
	}]}}]}`)
	if _, err := MapStandings(raw); err == nil {
		t.Fatal("expected incomplete standing stats error")
	}
}

func loadStandingsFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/espn-standings.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func TestMapStandings(t *testing.T) {
	raw := loadStandingsFixture(t)

	// Mirror the TS test's shape check: 12 groups (A..L) of 4 teams each,
	// ranked 1..4 within each group (espn-standings.test.ts).
	var doc struct {
		Children []struct {
			Name      string `json:"name"`
			Standings struct {
				Entries []struct{} `json:"entries"`
			} `json:"standings"`
		} `json:"children"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if len(doc.Children) != 12 {
		t.Fatalf("fixture: got %d groups, want 12", len(doc.Children))
	}

	standings, err := MapStandings(raw)
	if err != nil {
		t.Fatalf("MapStandings returned error: %v", err)
	}

	wantTotal := 0
	for _, g := range doc.Children {
		wantTotal += len(g.Standings.Entries)
	}
	if len(standings) != wantTotal {
		t.Fatalf("got %d standings, want %d", len(standings), wantTotal)
	}

	t.Run("ranks restart at 1 for each group, 4 teams per group", func(t *testing.T) {
		i := 0
		for gi, g := range doc.Children {
			n := len(g.Standings.Entries)
			if gi == 0 && n != 4 {
				t.Fatalf("group A: got %d entries, want 4", n)
			}
			for j := 0; j < n; j++ {
				s := standings[i]
				if s.Rank != j+1 {
					t.Errorf("group %d entry %d: got rank %d, want %d", gi, j, s.Rank, j+1)
				}
				i++
			}
		}
	})

	t.Run("maps stat fields with correct names", func(t *testing.T) {
		s := standings[0]
		if s.Played < 0 {
			t.Errorf("played = %d, want >= 0", s.Played)
		}
		if s.Points != s.Wins*3+s.Draws {
			t.Errorf("points = %d, want %d (wins*3+draws)", s.Points, s.Wins*3+s.Draws)
		}
		if s.GoalDifference != s.GoalsFor-s.GoalsAgainst {
			t.Errorf("goalDifference = %d, want %d (goalsFor-goalsAgainst)", s.GoalDifference, s.GoalsFor-s.GoalsAgainst)
		}
	})

	t.Run("first team of group A advanced", func(t *testing.T) {
		if !standings[0].Advanced {
			t.Errorf("standings[0].Advanced = false, want true")
		}
	})

	t.Run("carries group id/name onto each row", func(t *testing.T) {
		s := standings[0]
		if s.GroupName == nil || *s.GroupName != "Group A" {
			t.Fatalf("GroupName = %v, want \"Group A\"", s.GroupName)
		}
		if s.GroupID == nil || *s.GroupID != "A" {
			t.Fatalf("GroupID = %v, want \"A\"", s.GroupID)
		}

		// Second group's rows should carry that group's own id/name, not
		// bleed over from the first.
		secondGroupStart := len(doc.Children[0].Standings.Entries)
		s2 := standings[secondGroupStart]
		if s2.GroupName == nil || *s2.GroupName != "Group B" {
			t.Fatalf("second group GroupName = %v, want \"Group B\"", s2.GroupName)
		}
		if s2.GroupID == nil || *s2.GroupID != "B" {
			t.Fatalf("second group GroupID = %v, want \"B\"", s2.GroupID)
		}
	})

	t.Run("rejects a malformed payload", func(t *testing.T) {
		if _, err := MapStandings([]byte(`{}`)); err == nil {
			t.Fatal("expected malformed standings error")
		}
	})
}
