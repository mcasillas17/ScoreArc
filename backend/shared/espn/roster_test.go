package espn

import (
	"os"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func loadRosterFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/espn-team-roster.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTeamRosterURL(t *testing.T) {
	want := "https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227/roster"
	if got := TeamRosterURL("mex.1", "227"); got != want {
		t.Fatalf("TeamRosterURL = %s, want %s", got, want)
	}
	if got := TeamRosterURL("mex.1", "../secret"); strings.Contains(got, "../") {
		t.Fatalf("TeamRosterURL = %q, want the team id encoded", got)
	}
}

// 35 athletes, 27 with statistics. A mapper that assumes the block is present
// nil-panics on the 28th.
func TestMapRosterKeepsPlayersWhoHaveNotPlayed(t *testing.T) {
	squad, err := MapRoster(loadRosterFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if squad.TeamSourceID != "227" {
		t.Fatalf("team source id = %q, want 227", squad.TeamSourceID)
	}
	if len(squad.Players) != 35 {
		t.Fatalf("players = %d, want 35", len(squad.Players))
	}
	var withStats int
	for _, player := range squad.Players {
		if player.Stats != nil {
			withStats++
		}
	}
	if withStats != 27 {
		t.Fatalf("players with stats = %d, want 27", withStats)
	}
	// The eight without are still squad members. Dropping them would make a
	// squad list silently shorter than the squad.
	if len(squad.Players)-withStats != 8 {
		t.Fatalf("players without stats = %d, want 8", len(squad.Players)-withStats)
	}
}

// Stats are read by name across all three categories, never by index. Unlike
// the match summary, this payload gives every position all fifteen names --
// but the order within a category is still ESPN's.
func TestMapRosterReadsStatsAcrossCategoriesByName(t *testing.T) {
	squad, err := MapRoster(loadRosterFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	var keeper *model.SquadMember
	for index := range squad.Players {
		if squad.Players[index].Position == "G" && squad.Players[index].Stats != nil {
			keeper = &squad.Players[index]
			break
		}
	}
	if keeper == nil {
		t.Fatal("the fixture has a goalkeeper with statistics")
	}
	// general, offensive and goalKeeping all have to be walked: a mapper that
	// reads only categories[0] gets seven of fifteen.
	if keeper.Stats.Appearances == nil {
		t.Fatal("Appearances (general) is nil")
	}
	if keeper.Stats.Goals == nil {
		t.Fatal("Goals (offensive) is nil -- only the general category was read")
	}
	if keeper.Stats.Saves == nil {
		t.Fatal("Saves (goalKeeping) is nil -- only two categories were read")
	}
}

// The roster carries a real ISO dateOfBirth. The per-athlete endpoint's
// displayDOB ("23/9/2003") is locale-formatted and is never parsed.
func TestMapRosterReadsIsoBirthDate(t *testing.T) {
	squad, err := MapRoster(loadRosterFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	var dated int
	for _, player := range squad.Players {
		if player.BirthDate != nil {
			dated++
		}
	}
	if dated == 0 {
		t.Fatal("no birth dates parsed; the fixture carries dateOfBirth on every athlete")
	}
}

func TestMapRosterLeavesProviderOmissionsNilInsteadOfZero(t *testing.T) {
	squad, err := MapRoster([]byte(`{
		"status":"success",
		"team":{"id":"227"},
		"athletes":[{
			"id":"p1",
			"fullName":"Measured Player",
			"statistics":{"splits":{"categories":[
				{"name":"general","stats":[{"name":"appearances","value":0}]}
			]}}
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	stats := squad.Players[0].Stats
	if stats == nil || stats.Appearances == nil || *stats.Appearances != 0 {
		t.Fatalf("provider zero must remain a measured zero, got %+v", stats)
	}
	if stats.Goals != nil {
		t.Fatalf("omitted goals = %v, want nil", *stats.Goals)
	}
}

func TestMapRosterRejectsMalformedBirthDate(t *testing.T) {
	_, err := MapRoster([]byte(`{
		"status":"success",
		"team":{"id":"227"},
		"athletes":[{"id":"p1","fullName":"Bad Date","dateOfBirth":"03/09/2003"}]
	}`))
	if err == nil {
		t.Fatal("expected malformed non-ISO dateOfBirth to fail")
	}
}

func TestMapRosterRejectsMissingAthletesArray(t *testing.T) {
	if _, err := MapRoster([]byte(`{"status":"success","team":{"id":"227"}}`)); err == nil {
		t.Fatal("expected missing athletes array to fail")
	}
}

func TestMapRosterRejectsFailedEnvelope(t *testing.T) {
	if _, err := MapRoster([]byte(`{
		"status":"error",
		"team":{"id":"227"},
		"athletes":[]
	}`)); err == nil {
		t.Fatal("expected non-success roster envelope to fail")
	}
}

// The team.color column is CHECK-constrained to six hex digits, so anything
// else is dropped at the mapper rather than failing a whole squad write for
// one club whose colour arrived malformed.
func TestNormaliseHexColour(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"ffff91", "ffff91"},
		{"#ffff91", "ffff91"},
		{"  ffff91  ", "ffff91"},
		{"FFFF91", "FFFF91"},
		{"", ""},
		{"fff", ""},
		{"transparent", ""},
		{"ffff9g", ""},
		{"ffff911", ""},
	}
	for _, c := range cases {
		if got := normaliseHexColour(c.in); got != c.want {
			t.Errorf("normaliseHexColour(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
