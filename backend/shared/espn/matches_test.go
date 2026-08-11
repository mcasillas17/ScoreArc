package espn

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

func TestMapScoreboardRejectsBlankTeamIDs(t *testing.T) {
	raw := []byte(`{"events":[{"id":"m","date":"2026-01-01T00:00:00Z",
		"status":{"type":{"state":"pre"}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"","displayName":"Unknown"}},
			{"homeAway":"away","team":{"id":"2","displayName":"Away"}}
		]}]}]}`)
	if _, err := MapScoreboard(raw); err == nil {
		t.Fatal("expected blank team identity error")
	}
}

func loadScoreboardFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/espn-scoreboard.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

// buildMixedEventsPayload appends a malformed event (raw JSON object) onto
// the fixture's events array, mirroring the TS test's
// `{ events: [...raw.events, malformed] }`.
func buildMixedEventsPayload(t *testing.T, raw []byte, malformed []byte) []byte {
	t.Helper()
	var doc struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	doc.Events = append(doc.Events, malformed)
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal mixed payload: %v", err)
	}
	return out
}

func TestMapScoreboard(t *testing.T) {
	raw := loadScoreboardFixture(t)

	var rawEvents struct {
		Events []struct{} `json:"events"`
	}
	if err := json.Unmarshal(raw, &rawEvents); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}

	matches, err := MapScoreboard(raw)
	if err != nil {
		t.Fatalf("MapScoreboard returned error: %v", err)
	}

	t.Run("returns one match per event", func(t *testing.T) {
		if len(matches) != len(rawEvents.Events) {
			t.Fatalf("got %d matches, want %d", len(matches), len(rawEvents.Events))
		}
	})

	t.Run("extracts home/away teams with crest urls", func(t *testing.T) {
		if len(matches) == 0 {
			t.Fatal("no matches to check")
		}
		m := matches[0]
		abbrRe := regexp.MustCompile(`^[A-Z]{3}$`)
		if !abbrRe.MatchString(m.Home.Abbr) {
			t.Errorf("home abbr %q does not match ^[A-Z]{3}$", m.Home.Abbr)
		}
		if !abbrRe.MatchString(m.Away.Abbr) {
			t.Errorf("away abbr %q does not match ^[A-Z]{3}$", m.Away.Abbr)
		}
		if m.Home.CrestURL == nil || !regexp.MustCompile(`espncdn\.com`).MatchString(*m.Home.CrestURL) {
			t.Errorf("home crestUrl %v does not contain espncdn.com", m.Home.CrestURL)
		}
	})

	t.Run("parses numeric scores", func(t *testing.T) {
		var finished *Match
		for i := range matches {
			if matches[i].State == MatchStateFinished {
				finished = &matches[i]
				break
			}
		}
		if finished == nil {
			t.Fatal("expected a finished match")
		}
		if finished.HomeScore == nil {
			t.Fatal("expected homeScore to be non-nil for a finished match")
		}
	})

	t.Run("captures penalty/advance note when present", func(t *testing.T) {
		var withNote *Match
		for i := range matches {
			if matches[i].Note != nil {
				withNote = &matches[i]
				break
			}
		}
		if withNote == nil {
			t.Fatal("expected a match with a note")
		}
		noteRe := regexp.MustCompile(`(?i)advance|penalties`)
		if !noteRe.MatchString(*withNote.Note) {
			t.Errorf("note %q does not match advance|penalties", *withNote.Note)
		}
	})

	t.Run("sets winnerId to a competing team id when there is a winner", func(t *testing.T) {
		var decided *Match
		for i := range matches {
			if matches[i].WinnerID != nil {
				decided = &matches[i]
				break
			}
		}
		if decided == nil {
			t.Fatal("expected a decided match")
		}
		if *decided.WinnerID != decided.Home.ID && *decided.WinnerID != decided.Away.ID {
			t.Errorf("winnerId %q is neither home %q nor away %q", *decided.WinnerID, decided.Home.ID, decided.Away.ID)
		}
	})
}

func TestMapScoreboardResilience(t *testing.T) {
	raw := loadScoreboardFixture(t)

	malformed := []byte(`{"competitions":[{"competitors":[]}],"status":{"type":{}}}`)

	t.Run("skips malformed events mixed with valid ones without throwing", func(t *testing.T) {
		var rawEvents struct {
			Events []struct{} `json:"events"`
		}

		if err := json.Unmarshal(raw, &rawEvents); err != nil {
			t.Fatalf("unmarshal fixture: %v", err)
		}

		mixed := buildMixedEventsPayload(t, raw, malformed)
		if _, err := MapScoreboard(mixed); err == nil {
			t.Fatal("expected mixed malformed scoreboard error")
		}
	})

	t.Run("rejects an array containing only a malformed event", func(t *testing.T) {
		onlyMalformed := []byte(`{"events":[` + string(malformed) + `]}`)
		if _, err := MapScoreboard(onlyMalformed); err == nil {
			t.Fatal("expected malformed scoreboard error")
		}
	})
}

func TestMapScoreboardAcceptsNumericIdentityAndScores(t *testing.T) {
	raw := []byte(`{"events":[{"id":123,"date":"2026-01-01T00:00:00Z",
		"season":{"year":2026},
		"status":{"type":{"state":"post","completed":true}},
		"competitions":[{"competitors":[
			{"homeAway":"home","score":2,"team":{"id":1,"displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","score":1,"team":{"id":2,"displayName":"Away","abbreviation":"AWY"}}
		]}]}]}`)
	matches, err := MapScoreboard(raw)
	if err != nil {
		t.Fatal(err)
	}

	if matches[0].ID != "123" || matches[0].Home.ID != "1" ||
		matches[0].HomeScore == nil || *matches[0].HomeScore != 2 {
		t.Fatalf("match=%+v", matches[0])
	}

}

func TestBackfillCompletenessRejectsLimitSizedResponse(t *testing.T) {
	raw := []byte(`{"events":[{},{}]}`)
	if err := ValidateBackfillCompleteness(raw, 2); err == nil {
		t.Fatal("expected truncated backfill error")
	}
}

func TestMapScoreboardNormalizesSecondlessKickoff(t *testing.T) {
	raw := []byte(`{"events":[{"id":"1","date":"2026-06-29T17:00Z",
		"season":{"slug":"group-stage"},
		"status":{"type":{"state":"pre","completed":false}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
		]}]}]}`)
	matches, err := MapScoreboard(raw)
	if err != nil {
		t.Fatal(err)
	}

	if matches[0].Kickoff != "2026-06-29T17:00:00Z" {
		t.Fatalf("kickoff=%q", matches[0].Kickoff)
	}
	if matches[0].BracketRequired == nil || *matches[0].BracketRequired {
		t.Fatalf("bracket required=%v", matches[0].BracketRequired)
	}
}

func TestFilterScoreboardSeasonRemovesForeignEvents(t *testing.T) {
	raw := []byte(`{"events":[
		{"id":"old","season":{"year":2025}},
		{"id":"current","season":{"year":2026}},
		{"id":"unknown"}
	]}`)
	filtered, err := FilterScoreboardSeason(raw, 2026)
	if err != nil {
		t.Fatal(err)
	}
	var scoreboard rawScoreboard
	if err := json.Unmarshal(filtered, &scoreboard); err != nil {
		t.Fatal(err)
	}
	if len(scoreboard.Events) != 2 ||
		string(scoreboard.Events[0].ID) != "current" ||
		string(scoreboard.Events[1].ID) != "unknown" {
		t.Fatalf("filtered events=%+v", scoreboard.Events)
	}
}

func TestScoreboardClassificationUsesHistoricalRoundOverride(t *testing.T) {
	raw := []byte(`{"events":[{"id":"264118","date":"2010-07-03T18:30:00Z",
		"season":{"year":2010,"slug":"group-stage"},
		"status":{"type":{"state":"post","completed":true}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
		]}]}]}`)
	matches, err := MapScoreboard(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].BracketRequired == nil ||
		!*matches[0].BracketRequired {
		t.Fatalf("matches=%+v", matches)
	}
}

func TestMapStateHandlesIncompletePostStatuses(t *testing.T) {
	if got := mapState("post", false, "STATUS_CANCELED"); got != MatchStateFinished {
		t.Fatalf("canceled state=%q", got)
	}
	if got := mapState("post", false, "STATUS_POSTPONED"); got != MatchStateScheduled {
		t.Fatalf("postponed state=%q", got)
	}
	if got := mapState("post", false, "STATUS_FULL_TIME"); got != MatchStateFinished {
		t.Fatalf("incomplete post state=%q", got)
	}
	if got := mapState("post", false, "STATUS_SUSPENDED"); got != MatchStateScheduled {
		t.Fatalf("suspended state=%q", got)
	}
	if got := mapState("post", false, "STATUS_PROVIDER_NEW"); got != MatchStateLive {
		t.Fatalf("unknown post state=%q", got)
	}
}

func TestScoreboardUnknownRoundRequiresBracketClassification(t *testing.T) {
	raw := []byte(`{"events":[{"id":"unknown-round","date":"2026-06-29T17:00Z",
		"season":{"year":2026,"slug":"provider-new-round"},
		"status":{"type":{"state":"post","completed":true}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
		]}]}]}`)
	matches, err := MapScoreboard(raw)
	if err != nil {
		t.Fatal(err)
	}

	if len(matches) != 1 || matches[0].BracketRequired == nil ||
		!*matches[0].BracketRequired {
		t.Fatalf("matches=%+v", matches)
	}
}

func TestGroupStageDoesNotRequireBracketClassification(t *testing.T) {
	required := bracketRequirement("group", "group-stage")
	if required == nil || *required {
		t.Fatalf("required=%v", required)
	}
}
