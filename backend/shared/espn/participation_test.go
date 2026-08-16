package espn

import (
	"os"
	"testing"
)

// The fixture's home roster is 4789, away 464 — the same ids TestMapSummary uses.
const (
	fixtureHomeID = "4789"
	fixtureAwayID = "464"
)

func TestMapParticipationCapturesSquadAthleteIDs(t *testing.T) {
	part, err := MapParticipation(loadSummaryFixture(t), fixtureHomeID, fixtureAwayID)
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}
	if part == nil {
		t.Fatal("expected non-nil participation")
	}

	// The whole point of this slice: substitutes are people too. MapSummary's
	// lineups keep 11; the squad keeps the full sheet.
	if len(part.Home) != 26 {
		t.Errorf("expected 26 home squad entries, got %d", len(part.Home))
	}
	if len(part.Away) == 0 {
		t.Fatal("expected a non-empty away squad")
	}

	var starters int
	for _, p := range part.Home {
		if p.SourceID == "" {
			t.Errorf("squad player %q has no source id — the athlete id was dropped", p.Name)
		}
		if p.Name == "" {
			t.Errorf("squad player %q has no name", p.SourceID)
		}
		if p.Starter {
			starters++
		}
	}
	if starters != 11 {
		t.Errorf("expected 11 home starters, got %d", starters)
	}
}

func TestMapParticipationCapturesEventAthleteIDs(t *testing.T) {
	part, err := MapParticipation(loadSummaryFixture(t), fixtureHomeID, fixtureAwayID)
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}
	if len(part.Events) == 0 {
		t.Fatal("expected at least one player event")
	}

	var resolved int
	for _, e := range part.Events {
		if e.TeamSourceID == "" {
			t.Errorf("event %q has no team source id", e.Type)
		}
		if e.Type == "" {
			t.Errorf("event at %q has no type", e.Minute)
		}
		if e.PlayerSourceID != "" {
			resolved++
		}
	}
	// Every participant in the recorded fixture carries an athlete id.
	if resolved != len(part.Events) {
		t.Errorf("expected every event to carry a player source id, got %d of %d",
			resolved, len(part.Events))
	}
}

// A provider that omits athlete ids must degrade to an unidentified event, not
// an error and not a name-keyed player.
func TestMapParticipationToleratesMissingAthleteIDs(t *testing.T) {
	raw := []byte(`{
	  "header": {"competitions": [{"competitors": [
	    {"id": "1", "homeAway": "home"}, {"id": "2", "homeAway": "away"}
	  ]}]},
	  "keyEvents": [
	    {"type": {"text": "Goal"}, "scoringPlay": true, "clock": {"displayValue": "12'"},
	     "team": {"id": "1"}, "participants": [{"athlete": {"displayName": "Nameless"}}]}
	  ]
	}`)

	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}
	if len(part.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(part.Events))
	}
	if got := part.Events[0].PlayerSourceID; got != "" {
		t.Errorf("expected empty player source id, got %q", got)
	}
	if got := part.Events[0].PlayerName; got != "Nameless" {
		t.Errorf("expected the name to survive, got %q", got)
	}
}

// A substitution becomes two player-actions, and the direction is not
// guessable — inverting it would silently credit minutes to the wrong player.
// ESPN's own prose ("X replaces Y") is the check.
func TestMapParticipationSplitsSubstitutionsInOrder(t *testing.T) {
	part, err := MapParticipation(loadSummaryFixture(t), fixtureHomeID, fixtureAwayID)
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}

	var on, off int
	for _, e := range part.Events {
		switch e.Type {
		case PlayerEventSubOn:
			on++
		case PlayerEventSubOff:
			off++
		}
	}
	if on == 0 {
		t.Fatal("expected substitution events; none were captured")
	}
	if on != off {
		t.Errorf("substitutions must pair: %d on vs %d off", on, off)
	}

	// The fixture's first substitution: Amad Diallo replaces Christ Inao Oulaï.
	var gotOn, gotOff string
	for i, e := range part.Events {
		if e.Type == PlayerEventSubOn {
			gotOn = e.PlayerName
			if i+1 < len(part.Events) {
				gotOff = part.Events[i+1].PlayerName
			}
			break
		}
	}
	if gotOn != "Amad Diallo" {
		t.Errorf("expected Amad Diallo coming on, got %q", gotOn)
	}
	if gotOff != "Christ Inao Oulaï" {
		t.Errorf("expected Christ Inao Oulaï going off, got %q", gotOff)
	}
}

// An arity we have not seen must be skipped, not guessed at.
func TestMapParticipationSkipsMalformedSubstitution(t *testing.T) {
	raw := []byte(`{
	  "keyEvents": [
	    {"type": {"text": "Substitution", "type": "substitution"},
	     "clock": {"displayValue": "60'"}, "team": {"id": "1"},
	     "participants": [{"athlete": {"id": "9", "displayName": "Only One"}}]}
	  ]
	}`)

	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}
	if len(part.Events) != 0 {
		t.Errorf("expected a one-participant substitution to be skipped, got %d events",
			len(part.Events))
	}
}

// A second yellow is a sending off. The relational events must agree with the
// legacy card mapper, which treats "Yellow Red Card" as red.
func TestMapParticipationTreatsSecondYellowAsRed(t *testing.T) {
	raw := []byte(`{
	  "keyEvents": [
	    {"type": {"text": "Yellow Red Card", "type": "yellow-red-card"},
	     "clock": {"displayValue": "80'"}, "team": {"id": "1"},
	     "participants": [{"athlete": {"id": "9", "displayName": "Sent Off"}}]}
	  ]
	}`)

	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}
	if len(part.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(part.Events))
	}
	if got := part.Events[0].Type; got != PlayerEventRed {
		t.Errorf("expected a red, got %q", got)
	}
}

// ESPN sends ids as either JSON strings or numbers; the squad must accept both.
func TestMapParticipationAcceptsNumericAthleteIDs(t *testing.T) {
	raw := []byte(`{
	  "header": {"competitions": [{"competitors": [
	    {"id": "1", "homeAway": "home"}, {"id": "2", "homeAway": "away"}
	  ]}]},
	  "rosters": [
	    {"team": {"id": "1"}, "formation": "4-3-3", "roster": [
	      {"starter": true, "jersey": "9", "athlete": {"id": 12345, "displayName": "Striker"},
	       "position": {"abbreviation": "F"}}
	    ]}
	  ]
	}`)

	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatalf("MapParticipation returned error: %v", err)
	}
	if len(part.Home) != 1 {
		t.Fatalf("expected 1 home squad entry, got %d", len(part.Home))
	}
	if got := part.Home[0].SourceID; got != "12345" {
		t.Errorf("expected source id 12345, got %q", got)
	}
}

// The core rule, against the recorded fixture. A goalkeeper's row carries
// saves/goalsConceded/shotsFaced and NO offsides; an outfielder's carries
// offsides and NO saves. Both absences must arrive as nil, because the
// alternative is recording an unmeasured stat as a measured zero.
func TestMapParticipationReadsPerPositionStats(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	part, err := MapParticipation(raw, "4789", "464")
	if err != nil {
		t.Fatal(err)
	}

	var keeper, outfielder *SquadPlayer
	for i := range part.Home {
		p := &part.Home[i]
		if p.Stats == nil {
			continue
		}
		if p.Position == "G" && keeper == nil {
			keeper = p
		}
		if p.Position != "G" && p.Position != "SUB" && outfielder == nil {
			outfielder = p
		}
	}
	if keeper == nil || outfielder == nil {
		t.Fatalf("fixture gave keeper=%v outfielder=%v; both are needed", keeper, outfielder)
	}

	if keeper.Stats.Saves == nil {
		t.Fatal("keeper Saves is nil; the fixture carries a saves entry for G")
	}
	if keeper.Stats.Offsides != nil {
		t.Fatalf("keeper Offsides = %d, want nil -- ESPN sends no offsides for G",
			*keeper.Stats.Offsides)
	}
	if outfielder.Stats.Offsides == nil {
		t.Fatal("outfielder Offsides is nil; the fixture carries an offsides entry")
	}
	if outfielder.Stats.Saves != nil {
		t.Fatalf("outfielder Saves = %d, want nil -- ESPN sends no saves for outfielders",
			*outfielder.Stats.Saves)
	}
}

// Lookup is by name. The array order is ESPN's and has changed between
// payloads before; an index-based read is a silent mis-attribution rather than
// an error, which is the worst failure mode available here.
func TestMapParticipationLooksStatsUpByName(t *testing.T) {
	raw := []byte(`{
	  "rosters": [{
	    "team": {"id": "1"},
	    "roster": [{
	      "starter": true, "jersey": "9",
	      "athlete": {"id": "77", "displayName": "Striker"},
	      "position": {"abbreviation": "F"},
	      "stats": [
	        {"name": "yellowCards",  "value": 1},
	        {"name": "totalShots",   "value": 5},
	        {"name": "totalGoals",   "value": 2},
	        {"name": "goalAssists",  "value": 1},
	        {"name": "shotsOnTarget","value": 3},
	        {"name": "ownGoals",     "value": 0}
	      ]
	    }]
	  }]
	}`)
	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	if len(part.Home) != 1 || part.Home[0].Stats == nil {
		t.Fatalf("home = %#v, want one player with stats", part.Home)
	}
	s := part.Home[0].Stats
	// Shuffled on purpose: read positionally, totalGoals would come back as 5.
	if s.Goals == nil || *s.Goals != 2 {
		t.Fatalf("Goals = %v, want 2", s.Goals)
	}
	if s.Shots == nil || *s.Shots != 5 {
		t.Fatalf("Shots = %v, want 5", s.Shots)
	}
	if s.Assists == nil || *s.Assists != 1 {
		t.Fatalf("Assists = %v, want 1", s.Assists)
	}
	if s.ShotsOnTarget == nil || *s.ShotsOnTarget != 3 {
		t.Fatalf("ShotsOnTarget = %v, want 3", s.ShotsOnTarget)
	}
	// A stat the provider DID send as zero is a measurement and stays zero.
	if s.OwnGoals == nil || *s.OwnGoals != 0 {
		t.Fatalf("OwnGoals = %v, want a measured 0", s.OwnGoals)
	}
	// A stat the provider never sent stays nil.
	if s.Saves != nil {
		t.Fatalf("Saves = %v, want nil", s.Saves)
	}
}

// No stats array at all is a different thing from an array with gaps, and the
// store relies on the difference: nil means "the provider said nothing", which
// must never overwrite numbers a previous poll established.
func TestMapParticipationLeavesStatsNilWhenAbsent(t *testing.T) {
	raw := []byte(`{"rosters":[{"team":{"id":"1"},"roster":[
	  {"starter":true,"jersey":"9","athlete":{"id":"77","displayName":"Striker"},
	   "position":{"abbreviation":"F"}}]}]}`)
	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	if part.Home[0].Stats != nil {
		t.Fatalf("Stats = %#v, want nil when the payload has no stats array", part.Home[0].Stats)
	}
}

// A non-integral, negative, null, or out-of-range count is a payload we do not
// understand. Record nothing rather than converting it into a plausible-looking
// number.
func TestMapParticipationRejectsImpossibleCounts(t *testing.T) {
	raw := []byte(`{"rosters":[{"team":{"id":"1"},"roster":[
	  {"starter":true,"jersey":"9","athlete":{"id":"77","displayName":"Striker"},
	   "position":{"abbreviation":"F"},
	   "stats":[{"name":"totalGoals","value":1.5},{"name":"totalShots","value":-3},
	            {"name":"shotsOnTarget","value":1e20},{"name":"redCards","value":null},
	            {"name":"goalAssists","value":2}]}]}]}`)
	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	s := part.Home[0].Stats
	if s.Goals != nil {
		t.Fatalf("Goals = %d from value 1.5, want nil", *s.Goals)
	}
	if s.Shots != nil {
		t.Fatalf("Shots = %d from value -3, want nil", *s.Shots)
	}
	if s.ShotsOnTarget != nil {
		t.Fatalf("ShotsOnTarget = %d from value 1e20, want nil", *s.ShotsOnTarget)
	}
	if s.RedCards != nil {
		t.Fatalf("RedCards = %d from value null, want nil", *s.RedCards)
	}
	if s.Assists == nil || *s.Assists != 2 {
		t.Fatalf("Assists = %v, want 2 -- one bad entry must not discard the row", s.Assists)
	}
}
