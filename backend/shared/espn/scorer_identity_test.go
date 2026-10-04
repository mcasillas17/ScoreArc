package espn

import (
	"encoding/json"
	"testing"
)

// Scorer identity mirrors mapSummaryScorers in providers/espn-summary.ts: the
// own-goal flag comes only from type.type, the athlete id from the first
// participant, and an event without one keeps a null id rather than a guess.
func TestMapSummaryScorerIdentity(t *testing.T) {
	scorers := mapSummaryScorers(mustParseRawSummary(t, []byte(`{"keyEvents": [
		{"scoringPlay": true, "team": {"id": "226"}, "type": {"type": "own-goal", "text": "Own Goal"},
		 "participants": [{"athlete": {"id": "337030", "displayName": "Devin Padelford"}}], "clock": {"displayValue": "32'"}},
		{"scoringPlay": true, "team": {"id": 17362}, "type": {"type": "goal", "text": "Goal"},
		 "participants": [{"athlete": {"id": 353246, "displayName": "Mauricio Gonzalez"}}], "clock": {"displayValue": "59'"}},
		{"scoringPlay": true, "team": {"id": "17362"}, "type": {"type": "goal", "text": "Goal"}, "clock": {"displayValue": "60'"}}
	]}`)))
	got, err := json.Marshal(scorers)
	if err != nil {
		t.Fatal(err)
	}
	want := `[` +
		`{"teamId":"226","player":"Devin Padelford","minute":"32'","penalty":false,"shootout":false,"ownGoal":true,"athleteId":"337030"},` +
		`{"teamId":"17362","player":"Mauricio Gonzalez","minute":"59'","penalty":false,"shootout":false,"ownGoal":false,"athleteId":"353246"},` +
		`{"teamId":"17362","player":"","minute":"60'","penalty":false,"shootout":false,"ownGoal":false,"athleteId":null}]`
	if string(got) != want {
		t.Fatalf("scorers\n got %s\nwant %s", got, want)
	}

	// A row stored before these fields existed decodes to unknown, not false.
	var legacy []Scorer
	if err := json.Unmarshal([]byte(`[{"teamId":"226","player":"P","minute":"1'","penalty":false,"shootout":false}]`), &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy[0].OwnGoal != nil || legacy[0].AthleteID != nil {
		t.Fatalf("legacy scorer identity invented: %+v", legacy[0])
	}
}
