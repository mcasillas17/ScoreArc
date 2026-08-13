package espn

import "testing"

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
