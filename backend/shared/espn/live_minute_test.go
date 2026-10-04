package espn

import (
	"encoding/json"
	"testing"
)

// liveFixtureEvent returns the first event of a recorded fixture, set live in
// the first half with the given display clock, or none when clock is nil.
func liveFixtureEvent(t *testing.T, fixture string, clock *string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(loadBracketFixture(t, fixture), &doc); err != nil {
		t.Fatal(err)
	}
	event := doc["events"].([]any)[0].(map[string]any)
	status := event["status"].(map[string]any)
	kind := status["type"].(map[string]any)
	kind["state"], kind["completed"], kind["name"] = "in", false, "STATUS_FIRST_HALF"
	delete(status, "displayClock")
	if clock != nil {
		status["displayClock"] = *clock
	}
	return map[string]any{"leagues": doc["leagues"], "events": []any{event}}
}

// Match.minute is string | null in the frontend contract: a live event ESPN
// sends without a display clock has no known minute. It must be nil (JSON
// null), never "" (T16.2-live-minute, T16.2-bracket-live-minute).
func TestLiveMinuteWithoutDisplayClockIsNil(t *testing.T) {
	sixty, empty := "60'", ""
	for _, c := range []struct {
		name  string
		clock *string
		want  *string
	}{{"with clock", &sixty, &sixty}, {"absent", nil, nil}, {"empty", &empty, nil}} {
		t.Run(c.name, func(t *testing.T) {
			check := func(label string, state MatchState, minute *string) {
				t.Helper()
				if state != MatchStateLive {
					t.Fatalf("%s state %q", label, state)
				}
				if (minute == nil) != (c.want == nil) || (minute != nil && *minute != *c.want) {
					t.Fatalf("%s minute %v, want %v", label, minute, c.want)
				}
			}
			scoreboard, err := json.Marshal(liveFixtureEvent(t, "espn-scoreboard.json", c.clock))
			if err != nil {
				t.Fatal(err)
			}
			matches, err := MapScoreboard(scoreboard)
			if err != nil || len(matches) != 1 {
				t.Fatalf("scoreboard: %v (%d)", err, len(matches))
			}
			check("scoreboard", matches[0].State, matches[0].Minute)
			bracket, err := json.Marshal(liveFixtureEvent(t, "espn-bracket.json", c.clock))
			if err != nil {
				t.Fatal(err)
			}
			knockout, err := MapBracket(bracket)
			if err != nil || len(knockout) != 1 {
				t.Fatalf("bracket: %v (%d)", err, len(knockout))
			}
			check("bracket", knockout[0].State, knockout[0].Minute)
		})
	}
}
