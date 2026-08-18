package main

import (
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func standingFixture() model.Standing {
	group := "A"
	name := "Group A"
	return model.Standing{
		Team:      model.Team{ID: "espn-1", Name: "Home", Abbr: "HOM"},
		GroupID:   &group,
		GroupName: &name,
		Rank:      1, Played: 3, Wins: 2, Draws: 1, Losses: 0,
		GoalsFor: 5, GoalsAgainst: 2, GoalDifference: 3, Points: 7,
		Advanced: true,
	}
}

func leaderFixture() model.StatLeader {
	crest := "https://a.espncdn.com/i/teamlogos/soccer/500/359.png"
	matches := 3
	return model.StatLeader{
		Rank: 1, Player: "Striker", TeamAbbr: "HOM", TeamName: "Home",
		TeamCrestURL: &crest, Value: 5, Matches: &matches,
	}
}

func testTeamIDs() map[string]string {
	return map[string]string{"espn-1": "canonical-1"}
}

// Every column ReplaceStandings INSERTs must move the fingerprint. A column
// that does not is a column whose change would be silently skipped -- which is
// the only way this guard can lose data.
func TestStandingsFingerprintMovesWithEveryWrittenColumn(t *testing.T) {
	t.Parallel()
	teamIDs := testTeamIDs()
	base := standingsFingerprint(sourceESPN, []model.Standing{standingFixture()}, teamIDs)

	otherGroup := "B"
	otherName := "Group B"
	mutations := map[string]func(*model.Standing){
		"rank":            func(row *model.Standing) { row.Rank = 2 },
		"played":          func(row *model.Standing) { row.Played = 4 },
		"wins":            func(row *model.Standing) { row.Wins = 3 },
		"draws":           func(row *model.Standing) { row.Draws = 2 },
		"losses":          func(row *model.Standing) { row.Losses = 1 },
		"goals for":       func(row *model.Standing) { row.GoalsFor = 6 },
		"goals against":   func(row *model.Standing) { row.GoalsAgainst = 3 },
		"goal difference": func(row *model.Standing) { row.GoalDifference = 4 },
		"points":          func(row *model.Standing) { row.Points = 10 },
		"advanced":        func(row *model.Standing) { row.Advanced = false },
		"group id":        func(row *model.Standing) { row.GroupID = &otherGroup },
		"group name":      func(row *model.Standing) { row.GroupName = &otherName },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := standingFixture()
			mutate(&row)
			if standingsFingerprint(sourceESPN, []model.Standing{row}, teamIDs) == base {
				t.Fatalf("%s does not move the fingerprint; a real change would be skipped", name)
			}
		})
	}
}

// The mirror image, and the reason the guard is worth anything: fields that
// arrive on model.Standing but are NOT written by ReplaceStandings must not
// move it. team.name/abbr/crest belong to `team`, which the seed, the resolver
// and SetTeamCrest own; hashing them would make one crest mirror rewrite 228
// standings rows that did not change.
func TestStandingsFingerprintIgnoresColumnsTheReplacementDoesNotWrite(t *testing.T) {
	t.Parallel()
	teamIDs := testTeamIDs()
	base := standingsFingerprint(sourceESPN, []model.Standing{standingFixture()}, teamIDs)

	row := standingFixture()
	crest := "https://cdn.scorearc.futbol/teams/canonical-1.png"
	row.Team.Name = "Home Renamed"
	row.Team.Abbr = "HRN"
	row.Team.CrestURL = &crest

	if standingsFingerprint(sourceESPN, []model.Standing{row}, teamIDs) != base {
		t.Fatal("the standings fingerprint tracks team fields the replacement never writes")
	}
}

// standing.group_id is nullable and a single-table league stores NULL, not ”.
// They are different values in the database, so they must be different bytes
// here.
func TestStandingsFingerprintSeparatesNullFromEmptyGroup(t *testing.T) {
	t.Parallel()
	teamIDs := testTeamIDs()
	empty := ""

	nullGroup := standingFixture()
	nullGroup.GroupID, nullGroup.GroupName = nil, nil
	emptyGroup := standingFixture()
	emptyGroup.GroupID, emptyGroup.GroupName = &empty, &empty

	if standingsFingerprint(sourceESPN, []model.Standing{nullGroup}, teamIDs) ==
		standingsFingerprint(sourceESPN, []model.Standing{emptyGroup}, teamIDs) {
		t.Fatal("NULL and '' collide; standing.group_id distinguishes them")
	}
}

// The INSERT carries the CANONICAL team id, so the fingerprint must follow it
// even when the provider row is byte-identical.
func TestStandingsFingerprintFollowsTheCanonicalTeamID(t *testing.T) {
	t.Parallel()
	rows := []model.Standing{standingFixture()}
	if standingsFingerprint(sourceESPN, rows, map[string]string{"espn-1": "canonical-1"}) ==
		standingsFingerprint(sourceESPN, rows, map[string]string{"espn-1": "canonical-2"}) {
		t.Fatal("a re-resolved team does not move the fingerprint")
	}
}

func TestLeadersFingerprintMovesWithEveryWrittenColumn(t *testing.T) {
	t.Parallel()
	base := leadersFingerprint(sourceESPN, "goals", []model.StatLeader{leaderFixture()})

	mirrored := "https://cdn.scorearc.futbol/teams/scorer-abc.png"
	otherMatches := 4
	mutations := map[string]func(*model.StatLeader){
		"rank":      func(row *model.StatLeader) { row.Rank = 2 },
		"player":    func(row *model.StatLeader) { row.Player = "Someone Else" },
		"team abbr": func(row *model.StatLeader) { row.TeamAbbr = "AWY" },
		"team name": func(row *model.StatLeader) { row.TeamName = "Away" },
		// The mirrored crest is the whole reason the fingerprint is taken
		// AFTER mirrorLeaders: the URL is a stored column.
		"crest":          func(row *model.StatLeader) { row.TeamCrestURL = &mirrored },
		"value":          func(row *model.StatLeader) { row.Value = 6 },
		"matches":        func(row *model.StatLeader) { row.Matches = &otherMatches },
		"matches absent": func(row *model.StatLeader) { row.Matches = nil },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := leaderFixture()
			mutate(&row)
			if leadersFingerprint(sourceESPN, "goals", []model.StatLeader{row}) == base {
				t.Fatalf("%s does not move the fingerprint", name)
			}
		})
	}

	// The category is in the scope key already; it is in the digest too so a
	// mis-keyed scope cannot make the goals board look like the assists one.
	if leadersFingerprint(sourceESPN, "assists", []model.StatLeader{leaderFixture()}) == base {
		t.Fatal("the category does not move the fingerprint")
	}
}

// matches is nullable: "no matches figure published" and "zero matches" are
// different rows.
func TestLeadersFingerprintSeparatesNullFromZeroMatches(t *testing.T) {
	t.Parallel()
	zero := 0
	absent := leaderFixture()
	absent.Matches = nil
	present := leaderFixture()
	present.Matches = &zero

	if leadersFingerprint(sourceESPN, "goals", []model.StatLeader{absent}) ==
		leadersFingerprint(sourceESPN, "goals", []model.StatLeader{present}) {
		t.Fatal("a NULL matches count collides with zero")
	}
}

// Row order is not itself a change -- the primary keys make a reordered table
// the same table. Hashing in slice order anyway is deliberate: it is cheaper
// than sorting and it errs toward one extra write, never a missed one.
func TestFingerprintsAreOrderSensitive(t *testing.T) {
	t.Parallel()
	teamIDs := map[string]string{"espn-1": "canonical-1", "espn-2": "canonical-2"}
	first := standingFixture()
	second := standingFixture()
	second.Team.ID = "espn-2"
	second.Rank = 2

	if standingsFingerprint(sourceESPN, []model.Standing{first, second}, teamIDs) ==
		standingsFingerprint(sourceESPN, []model.Standing{second, first}, teamIDs) {
		t.Fatal("row order does not move the fingerprint; the encoding is ambiguous")
	}
}

// The memo is a claim about what THIS PROCESS committed, so it must never
// answer "unchanged" for a row set nothing has committed -- and an empty row
// set is the case that matters, because ReplaceLeaders rejects it and the
// runner preserves the stored board instead.
func TestContentUnchangedRefusesAnEmptyRowSet(t *testing.T) {
	t.Parallel()
	worker := &runner{written: map[string]uint64{}}
	scope := leadersScope("test", "2026", "assists")
	empty := leadersFingerprint(sourceESPN, "assists", nil)

	worker.markContentWritten(scope, empty)

	if worker.contentUnchanged(scope, 0, empty) {
		t.Fatal("an empty board was memoised as unchanged; the absent-board audit would stop firing")
	}
}

func TestContentUnchangedIsScoped(t *testing.T) {
	t.Parallel()
	worker := &runner{written: map[string]uint64{}}
	rows := []model.StatLeader{leaderFixture()}
	digest := leadersFingerprint(sourceESPN, "goals", rows)

	worker.markContentWritten(leadersScope("test", "2026", "goals"), digest)

	if !worker.contentUnchanged(leadersScope("test", "2026", "goals"), len(rows), digest) {
		t.Fatal("the scope it was written for reports changed")
	}
	for _, other := range []string{
		leadersScope("test", "2026", "assists"),
		leadersScope("test", "2025", "goals"),
		leadersScope("other", "2026", "goals"),
		standingsScope("test", "2026"),
	} {
		if worker.contentUnchanged(other, len(rows), digest) {
			t.Fatalf("scope %q shares a memo entry with another scope", other)
		}
	}
}
