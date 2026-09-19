package espn

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestSummaryObservationRejectsContradictoryCompetitorIdentity(t *testing.T) {
	raw := loadSummaryFixture(t)
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	header := payload["header"].(map[string]any)
	competition := header["competitions"].([]any)[0].(map[string]any)
	home := competition["competitors"].([]any)[0].(map[string]any)
	home["id"] = "wrong"
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	expected := Match{ID: "760490", Home: Team{ID: "4789"}, Away: Team{ID: "464"}}
	if _, err := MapSummaryObservation(raw, expected, "fifa.world", 2026); err == nil {
		t.Fatal("accepted contradictory competitor.id and competitor.team.id")
	}
}

func TestSummaryObservationMapsOnlyFreshProviderFacts(t *testing.T) {
	raw := []byte(`{"header":{"id":123,"league":{"slug":"esp.1"},"season":{"year":2026},
		"competitions":[{"id":123,"date":"2026-09-20T23:00-02:00",
			"status":{"displayClock":"90+2'","type":{"name":"STATUS_SECOND_HALF","state":"in","completed":false,"shortDetail":"90+2"}},
			"notes":[{"text":"New provider note"}],
			"competitors":[
				{"homeAway":"away","team":{"id":2},"score":1},
				{"homeAway":"home","team":{"id":1},"score":0}
			]}]}}`)
	staleNote, staleWinner, staleMinute, staleScore := "Old note", "1", "10'", 9
	expected := Match{ID: "123", State: MatchStateFinished,
		Home: Team{ID: "1", Name: "Stable Home"}, Away: Team{ID: "2", Name: "Stable Away"},
		WinnerID: &staleWinner, Note: &staleNote, Minute: &staleMinute,
		HomeScore: &staleScore, AwayScore: &staleScore, HomePlaceholder: true}
	match, err := MapSummaryObservation(raw, expected, "esp.1", 2026)
	if err != nil {
		t.Fatal(err)
	}
	if match.State != MatchStateLive || match.Kickoff != "2026-09-21T01:00:00Z" ||
		match.Minute == nil || *match.Minute != "90+2'" || match.StatusDetail != "90+2" ||
		match.Note == nil || *match.Note != "New provider note" ||
		match.WinnerID != nil || *match.HomeScore != 0 || *match.AwayScore != 1 ||
		match.Home.Name != "Stable Home" || !match.HomePlaceholder || match.BracketConfirmed {
		t.Fatalf("not fresh provider facts with stable identities: %+v", match)
	}
	if expected.State != MatchStateFinished || *expected.HomeScore != 9 || *expected.Note != "Old note" {
		t.Fatalf("input mutated: %+v", expected)
	}
	for _, score := range []string{`null`, `""`, `"-1"`, `"NaN"`} {
		missing := bytes.Replace(raw, []byte(`"score":0`), []byte(`"score":`+score), 1)
		if _, err := MapSummaryObservation(missing, expected, "esp.1", 2026); err == nil {
			t.Fatalf("accepted live score %s", score)
		}
	}
}

func TestSummaryObservationDoesNotPromoteOldScheduledMatch(t *testing.T) {
	raw := []byte(`{"header":{"id":"123","league":{"slug":"esp.1"},"season":{"year":2010},
		"competitions":[{"id":"123","date":"2010-09-20T23:00Z",
			"status":{"type":{"name":"STATUS_SCHEDULED","state":"pre","completed":false}},
			"competitors":[
				{"homeAway":"home","team":{"id":"1"}},
				{"homeAway":"away","team":{"id":"2"}}
			]}]}}`)
	expected := Match{ID: "123", State: MatchStateLive, Home: Team{ID: "1"}, Away: Team{ID: "2"}}
	match, err := MapSummaryObservation(raw, expected, "esp.1", 2010)
	if err != nil || match.State != MatchStateScheduled || match.HomeScore != nil || match.AwayScore != nil {
		t.Fatalf("elapsed time/candidate inferred a result: match=%+v err=%v", match, err)
	}
}
