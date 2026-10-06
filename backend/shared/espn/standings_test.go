package espn

import (
	"encoding/json"
	"os"
	"slices"
	"strconv"
	"strings"
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

func TestMapStandingsRejectsNullRequiredStats(t *testing.T) {
	valid := `{"children":[{"name":"League","standings":{"entries":[{
		"team":{"id":"1","displayName":"Team","abbreviation":"TST"},
		"stats":[
			{"name":"gamesPlayed","value":1},{"name":"wins","value":1},
			{"name":"ties","value":1},{"name":"losses","value":1},
			{"name":"pointsFor","value":1},{"name":"pointsAgainst","value":1},
			{"name":"pointDifferential","value":1},{"name":"points","value":1}
		]
	}]}}]}`
	for _, name := range []string{
		"gamesPlayed", "wins", "ties", "losses",
		"pointsFor", "pointsAgainst", "pointDifferential", "points",
	} {
		t.Run(name, func(t *testing.T) {
			present := `"name":"` + name + `","value":1`
			nullValue := `"name":"` + name + `","value":null`
			raw := []byte(strings.Replace(valid, present, nullValue, 1))
			if _, err := MapStandings(raw); err == nil {
				t.Fatalf("expected null %s to be rejected", name)
			}
		})
	}
}

func standingRow(id, name, abbr string) string {
	return `{"team":{"id":"` + id + `","displayName":"` + name + `","abbreviation":"` + abbr + `"},
		"stats":[{"name":"gamesPlayed","value":1},{"name":"wins","value":1},
		{"name":"ties","value":0},{"name":"losses","value":0},
		{"name":"pointsFor","value":2},{"name":"pointsAgainst","value":1},
		{"name":"pointDifferential","value":1},{"name":"points","value":3}]}`
}

// A team ESPN lists in two tables (an "Overall" table alongside conference
// tables) is a member of both (owner decision A, T16.2). Each row carries its
// table's provider id as TableKey and keeps its true position in that table.
func TestMapStandingsKeepsEveryTableMembership(t *testing.T) {
	raw := []byte(`{"children":[
		{"id":"7","name":"Eastern Conference","standings":{"entries":[` + standingRow("1", "Miami", "MIA") + `,` + standingRow("2", "Orlando", "ORL") + `]}},
		{"id":"9","name":"Overall","standings":{"entries":[` + standingRow("3", "Portland", "POR") + `,` + standingRow("1", "Miami", "MIA") + `]}}
	]}`)
	standings, err := MapStandings(raw)
	if err != nil {
		t.Fatalf("MapStandings: %v", err)
	}
	var got []string
	for _, s := range standings {
		got = append(got, s.TableKey+"/"+*s.GroupName+"/"+s.Team.ID+"/"+strconv.Itoa(s.Rank))
	}
	want := []string{"7/Eastern Conference/1/1", "7/Eastern Conference/2/2", "9/Overall/3/1", "9/Overall/1/2"}
	if !slices.Equal(got, want) {
		t.Fatalf("memberships = %v, want %v", got, want)
	}
}

// Conflicting or unidentifiable tables reject the payload, so the writer keeps
// the stored standings instead of arrival order choosing a winner.
func TestMapStandingsRejectsConflictingTables(t *testing.T) {
	table := func(id, name string, rows ...string) string {
		idField := ""
		if id != "" {
			idField = `"id":"` + id + `",`
		}
		return `{` + idField + `"name":"` + name + `","standings":{"entries":[` + strings.Join(rows, ",") + `]}}`
	}
	miami, orlando := standingRow("1", "Miami", "MIA"), standingRow("2", "Orlando", "ORL")
	for name, children := range map[string]string{
		"team twice in one table":      table("7", "East", miami, orlando, miami),
		"team twice in a lone table":   table("", "League", miami, miami),
		"two tables share an id":       table("7", "East", miami) + `,` + table("7", "West", orlando),
		"a second table has no id":     table("7", "East", miami) + `,` + table("", "West", orlando),
		"neither of two tables has id": table("", "East", miami) + `,` + table("", "West", orlando),
	} {
		t.Run(name, func(t *testing.T) {
			if rows, err := MapStandings([]byte(`{"children":[` + children + `]}`)); err == nil {
				t.Fatalf("accepted %+v", rows)
			}
		})
	}
}

// A lone table may omit its id: it is the season's only table, keyed "".
func TestMapStandingsKeysALoneUnidentifiedTableEmpty(t *testing.T) {
	standings, err := MapStandings([]byte(`{"children":[{"standings":{"entries":[` + standingRow("1", "Miami", "MIA") + `]}}]}`))
	if err != nil || len(standings) != 1 || standings[0].TableKey != "" {
		t.Fatalf("standings %+v err %v", standings, err)
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
		// The table key is ESPN's table id, not the translated name or position.
		if s.TableKey != "1" || s2.TableKey != "2" {
			t.Fatalf("table keys %q %q, want ESPN's table ids 1 and 2", s.TableKey, s2.TableKey)
		}
	})

	t.Run("rejects a malformed payload", func(t *testing.T) {
		if _, err := MapStandings([]byte(`{}`)); err == nil {
			t.Fatal("expected malformed standings error")
		}
	})
}

// ESPN does not promise table order: World Cup groups and MLS conferences
// arrive in its own team order (verified against live payloads 2026-10-04),
// with each entry's true position in a `rank` stat. Port of espn-standings.ts's
// inTableOrder: use it when it is a complete 1..n permutation, else keep array
// order -- a partial, duplicated or out-of-range rank is worse than the index.
func TestMapStandingsOrdersByCompleteRankStat(t *testing.T) {
	entry := func(id string, rank string) string {
		stats := `{"name":"gamesPlayed","value":1},{"name":"wins","value":1},{"name":"ties","value":0},
			{"name":"losses","value":0},{"name":"pointsFor","value":2},{"name":"pointsAgainst","value":1},
			{"name":"pointDifferential","value":1},{"name":"points","value":3}`
		if rank != "" {
			stats += `,{"name":"rank","value":` + rank + `}`
		}
		return `{"team":{"id":"` + id + `","displayName":"Team ` + id + `","abbreviation":"T` + id + `"},"stats":[` + stats + `]}`
	}
	order := func(t *testing.T, ranks ...string) []string {
		t.Helper()
		var entries []string
		for i, rank := range ranks {
			entries = append(entries, entry(strconv.Itoa(i+1), rank))
		}
		standings, err := MapStandings([]byte(`{"children":[{"name":"Group A","standings":{"entries":[` + strings.Join(entries, ",") + `]}}]}`))
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for i, s := range standings {
			if s.Rank != i+1 {
				t.Fatalf("row %d has rank %d; rank is the position in the table", i, s.Rank)
			}
			got = append(got, s.Team.ID)
		}
		return got
	}
	for _, c := range []struct {
		name  string
		ranks []string
		want  []string
	}{
		{"complete permutation reorders", []string{"2", "3", "1"}, []string{"3", "1", "2"}},
		{"duplicated rank keeps array order", []string{"2", "2", "1"}, []string{"1", "2", "3"}},
		{"partial rank keeps array order", []string{"2", "", "1"}, []string{"1", "2", "3"}},
		{"out-of-range rank keeps array order", []string{"2", "4", "1"}, []string{"1", "2", "3"}},
		{"fractional rank keeps array order", []string{"2", "1.5", "1"}, []string{"1", "2", "3"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := order(t, c.ranks...); !slices.Equal(got, c.want) {
				t.Fatalf("order %v, want %v", got, c.want)
			}
		})
	}
}
