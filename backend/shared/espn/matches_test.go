package espn

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

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
		result, err := MapScoreboard(mixed)
		if err != nil {
			t.Fatalf("MapScoreboard returned error: %v", err)
		}
		if len(result) != len(rawEvents.Events) {
			t.Fatalf("got %d matches, want %d (malformed event should be skipped)", len(result), len(rawEvents.Events))
		}
	})

	t.Run("returns [] for an array containing only a malformed event", func(t *testing.T) {
		onlyMalformed := []byte(`{"events":[` + string(malformed) + `]}`)
		result, err := MapScoreboard(onlyMalformed)
		if err != nil {
			t.Fatalf("MapScoreboard returned error: %v", err)
		}
		if len(result) != 0 {
			t.Fatalf("got %d matches, want 0", len(result))
		}
	})
}
