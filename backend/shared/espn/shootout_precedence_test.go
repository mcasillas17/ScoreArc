package espn

import (
	"encoding/json"
	"testing"
)

// The lightweight scoreboard carries both evidence tiers below the summary
// header: each competitor's structured shootoutScore, then the prose note. One
// precedence in both languages (T16.2-shootout-source): structured, else the
// anchored note, else nil. Regulation scores are never touched.
func TestMapScoreboardShootoutPrecedence(t *testing.T) {
	event := func(home, away, homeShootout, awayShootout, note string) []byte {
		competitor := func(side, id, name, shootout string) string {
			out := `{"homeAway":"` + side + `","score":"1","team":{"id":"` + id + `","displayName":"` + name + `","abbreviation":"X` + id + `"}`
			if shootout != "" {
				out += `,"shootoutScore":` + shootout
			}
			return out + "}"
		}
		notes := "[]"
		if note != "" {
			data, _ := json.Marshal(note)
			notes = `[{"text":` + string(data) + `}]`
		}
		return []byte(`{"events":[{"id":"9","date":"2026-07-04T17:00Z",
			"status":{"type":{"state":"post","completed":true,"name":"STATUS_FINAL_PEN","shortDetail":"FT-Pens"}},
			"competitions":[{"notes":` + notes + `,"competitors":[` +
			competitor("home", "1", home, homeShootout) + `,` + competitor("away", "2", away, awayShootout) + `]}]}]}`)
	}
	for _, c := range []struct {
		name                           string
		home, away, homeSO, awaySO, nt string
		want                           *Shootout
	}{
		{"structured and note agree", "Germany", "Paraguay", "3", "4", "Paraguay advance 4-3 on penalties", &Shootout{HomeScore: 3, AwayScore: 4}},
		{"structured wins a conflicting note", "Germany", "Paraguay", "5", "4", "Paraguay advance 4-3 on penalties", &Shootout{HomeScore: 5, AwayScore: 4}},
		{"note without structured", "Germany", "Paraguay", "", "", "Paraguay advance 4-3 on penalties", &Shootout{HomeScore: 3, AwayScore: 4}},
		{"both-zero structured falls back to the note", "Germany", "Paraguay", "0", "0", "Paraguay advance 4-3 on penalties", &Shootout{HomeScore: 3, AwayScore: 4}},
		{"winner named by the note's leading team only", "Inter", "Inter Miami CF", "", "", "Inter Miami CF advance 5-4 on penalties", &Shootout{HomeScore: 4, AwayScore: 5}},
		{"a note naming neither side is unknown", "Germany", "Paraguay", "", "", "Somebody advance 4-3 on penalties", nil},
		{"no evidence", "Germany", "Paraguay", "", "", "", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, err := MapScoreboard(event(c.home, c.away, `"x"`, "4", c.nt)); err == nil {
				t.Fatal("a malformed shootout total must reject the scoreboard")
			}
			matches, err := MapScoreboard(event(c.home, c.away, c.homeSO, c.awaySO, c.nt))
			if err != nil || len(matches) != 1 {
				t.Fatalf("map: %v", err)
			}
			got := matches[0].Shootout
			if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
				t.Fatalf("shootout %+v, want %+v", got, c.want)
			}
			if *matches[0].HomeScore != 1 || *matches[0].AwayScore != 1 {
				t.Fatal("shootout totals replaced regulation scores")
			}
		})
	}
}
