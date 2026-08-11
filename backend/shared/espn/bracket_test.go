package espn

import (
	"os"
	"strings"
	"testing"
)

func loadBracketFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

// TestMapBracket mirrors espn-bracket.test.ts's assertions against
// espn-bracket.json (the 2026 fixture). The TS mapper groups matches into
// BracketRound[]; the Go port returns a flat []BracketMatch, so round
// membership/order/count is checked by filtering the flat slice per round
// instead of indexing rounds directly.
func TestMapBracket(t *testing.T) {
	raw := loadBracketFixture(t, "espn-bracket.json")

	matches, err := MapBracket(raw)
	if err != nil {
		t.Fatalf("MapBracket returned error: %v", err)
	}

	byRound := func(slug string) []BracketMatch {
		var out []BracketMatch
		for _, m := range matches {
			if m.Round == slug {
				out = append(out, m)
			}
		}
		return out
	}

	t.Run("round-of-32 has 16 matches", func(t *testing.T) {
		if got := len(byRound("round-of-32")); got != 16 {
			t.Errorf("got %d round-of-32 matches, want 16", got)
		}
	})

	t.Run("final has 1 match", func(t *testing.T) {
		if got := len(byRound("final")); got != 1 {
			t.Errorf("got %d final matches, want 1", got)
		}
	})

	t.Run("rounds appear in fixed bracket order", func(t *testing.T) {
		wantOrder := []string{"round-of-32", "round-of-16", "quarterfinals", "semifinals", "final", "3rd-place-match"}
		lastIdx := -1
		seen := map[string]bool{}
		for _, m := range matches {
			idx := -1
			for i, s := range wantOrder {
				if s == m.Round {
					idx = i
				}
			}
			if idx == -1 {
				t.Fatalf("match %s has round %q, not in canonical order", m.ID, m.Round)
			}
			if !seen[m.Round] {
				if idx < lastIdx {
					t.Fatalf("round %q appeared out of order (after round index %d)", m.Round, lastIdx)
				}
				lastIdx = idx
				seen[m.Round] = true
			}
		}
		for _, s := range wantOrder {
			if !seen[s] {
				t.Errorf("expected round %q present in fixture, got none", s)
			}
		}
	})

	t.Run("decided R32 match has non-placeholder teams with numeric scores", func(t *testing.T) {
		r32 := byRound("round-of-32")
		var decided *BracketMatch
		for i := range r32 {
			if r32[i].WinnerID != nil {
				decided = &r32[i]
				break
			}
		}
		if decided == nil {
			t.Fatal("expected a decided round-of-32 match")
		}
		if decided.Home.Placeholder {
			t.Error("home.placeholder = true, want false")
		}
		if decided.Away.Placeholder {
			t.Error("away.placeholder = true, want false")
		}
		if decided.HomeScore == nil {
			t.Error("homeScore is nil, want a number")
		}
		if decided.AwayScore == nil {
			t.Error("awayScore is nil, want a number")
		}
	})

	t.Run("non-placeholder R32 teams have a crestUrl containing /countries/", func(t *testing.T) {
		r32 := byRound("round-of-32")
		if len(r32) == 0 {
			t.Fatal("no round-of-32 matches")
		}
		m := r32[0] // first R32 match is always real teams
		if m.Home.CrestURL == nil || !strings.Contains(*m.Home.CrestURL, "/countries/") {
			t.Errorf("home crestUrl %v does not contain /countries/", m.Home.CrestURL)
		}
		if m.Away.CrestURL == nil || !strings.Contains(*m.Away.CrestURL, "/countries/") {
			t.Errorf("away crestUrl %v does not contain /countries/", m.Away.CrestURL)
		}
	})

	t.Run("later round contains at least one placeholder team", func(t *testing.T) {
		r16 := byRound("round-of-16")
		found := false
		for _, m := range r16 {
			if m.Home.Placeholder || m.Away.Placeholder {
				found = true
				break
			}
		}
		if !found {
			t.Error("expected at least one placeholder team in round-of-16")
		}
	})

	t.Run("final teams are all placeholders", func(t *testing.T) {
		final := byRound("final")
		if len(final) != 1 {
			t.Fatalf("got %d final matches, want 1", len(final))
		}
		m := final[0]
		if !m.Home.Placeholder {
			t.Error("home.placeholder = false, want true")
		}
		if !m.Away.Placeholder {
			t.Error("away.placeholder = false, want true")
		}
	})

	t.Run("third-place loser slots are placeholders", func(t *testing.T) {
		thirdPlace := byRound("3rd-place-match")
		if len(thirdPlace) != 1 {
			t.Fatalf("got %d third-place matches, want 1", len(thirdPlace))
		}
		if !thirdPlace[0].Home.Placeholder || !thirdPlace[0].Away.Placeholder {
			t.Fatalf("third-place placeholders=%+v", thirdPlace[0])
		}
	})
}

// TestMapBracket2022 sanity-checks parity against the 2022 fixture, which
// (unlike 2026) is a fully finished tournament with real shootout data.
func TestMapBracket2022(t *testing.T) {
	raw := loadBracketFixture(t, "espn-bracket-2022.json")

	matches, err := MapBracket(raw)
	if err != nil {
		t.Fatalf("MapBracket returned error: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("expected matches from the 2022 bracket fixture")
	}

	for _, m := range matches {
		if m.State != MatchStateFinished {
			t.Errorf("match %s: state = %q, want finished (2022 WC is over)", m.ID, m.State)
		}
		if m.WinnerID == nil {
			t.Errorf("match %s: winnerId is nil, want a decided winner (knockout match, finished)", m.ID)
		} else if *m.WinnerID != m.Home.ID && *m.WinnerID != m.Away.ID {
			t.Errorf("match %s: winnerId %q is neither home %q nor away %q", m.ID, *m.WinnerID, m.Home.ID, m.Away.ID)
		}
	}

	final := 0
	for _, m := range matches {
		if m.Round == "final" {
			final++
		}
	}
	if final != 1 {
		t.Errorf("got %d final matches, want 1", final)
	}
}

func TestMapBracketResilience(t *testing.T) {
	t.Run("rejects entirely malformed events", func(t *testing.T) {
		malformed := []byte(`{"events":[{"season":{"slug":"round-of-32"},"competitions":[]}]}`)
		if _, err := MapBracket(malformed); err == nil {
			t.Fatal("expected malformed bracket error")
		}
	})

	t.Run("returns [] for empty events", func(t *testing.T) {
		got, err := MapBracket([]byte(`{"events":[]}`))
		if err != nil {
			t.Fatalf("MapBracket returned error: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("got %d matches, want 0", len(got))
		}
	})

	t.Run("rejects a missing events envelope", func(t *testing.T) {
		if _, err := MapBracket([]byte(`{}`)); err == nil {
			t.Fatal("expected malformed bracket error")
		}
	})

	t.Run("drops a round outside the canonical knockoutRounds vocabulary", func(t *testing.T) {
		raw := []byte(`{"events":[{"id":"g1","date":"2026-06-01T00:00Z","season":{"slug":"group-stage"},
			"status":{"type":{"state":"post","completed":true,"shortDetail":"FT","name":"STATUS_FULL_TIME"}},
			"competitions":[{"notes":[],"competitors":[
				{"homeAway":"home","winner":true,"score":"1","team":{"id":"1","abbreviation":"AAA","displayName":"Aaa"}},
				{"homeAway":"away","winner":false,"score":"0","team":{"id":"2","abbreviation":"BBB","displayName":"Bbb"}}
			]}]}]}`)
		got, err := MapBracket(raw)
		if err != nil {
			t.Fatalf("MapBracket returned error: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("got %d matches, want 0 (group-stage isn't in the knockout vocabulary)", len(got))
		}
	})
}

// TestMapBracketRoundSlugNormalization mirrors espn-bracket.test.ts's
// "slug normalization (older editions)" describe block.
func TestMapBracketRoundSlugNormalization(t *testing.T) {
	ev := func(slug, id string) []byte {
		return []byte(`{"id":"` + id + `","date":"2010-06-27T00:00Z","season":{"slug":"` + slug + `"},
			"status":{"type":{"state":"post","completed":true,"shortDetail":"FT","name":"STATUS_FULL_TIME"}},
			"competitions":[{"notes":[],"competitors":[
				{"homeAway":"home","winner":true,"score":"2","team":{"id":"1","abbreviation":"AAA","displayName":"Aaa","logo":"x/countries/aaa.png"}},
				{"homeAway":"away","winner":false,"score":"1","team":{"id":"2","abbreviation":"BBB","displayName":"Bbb","logo":"x/countries/bbb.png"}}
			]}]}`)
	}

	raw := []byte(`{"events":[` + string(ev("second-round", "a")) + `,` + string(ev("third-place", "b")) + `]}`)
	matches, err := MapBracket(raw)
	if err != nil {
		t.Fatalf("MapBracket returned error: %v", err)
	}

	slugs := map[string]bool{}
	for _, m := range matches {
		slugs[m.Round] = true
	}
	if !slugs["round-of-16"] {
		t.Error("expected second-round to normalize to round-of-16")
	}
	if !slugs["3rd-place-match"] {
		t.Error("expected third-place to normalize to 3rd-place-match")
	}
	if slugs["second-round"] || slugs["third-place"] {
		t.Errorf("raw slugs leaked through unnormalized: %v", slugs)
	}
}

// TestMapBracketShootoutWinnerFallback mirrors espn-bracket.test.ts's
// "penalty-shootout winner fallback" describe block: winner flags unset,
// shootoutScore decides it.
func TestMapBracketShootoutWinnerFallback(t *testing.T) {
	raw := []byte(`{"events":[{"id":"p1","date":"1998-06-30T00:00Z","season":{"slug":"quarterfinals"},
		"status":{"type":{"state":"post","completed":true,"shortDetail":"FT (pens)","name":"STATUS_FINAL_PEN"}},
		"competitions":[{"notes":[],"competitors":[
			{"homeAway":"home","winner":false,"score":"2","shootoutScore":"4","team":{"id":"10","abbreviation":"ARG","displayName":"Argentina","logo":"x/countries/arg.png"}},
			{"homeAway":"away","winner":false,"score":"2","shootoutScore":"3","team":{"id":"11","abbreviation":"ENG","displayName":"England","logo":"x/countries/eng.png"}}
		]}]}]}`)

	matches, err := MapBracket(raw)
	if err != nil {
		t.Fatalf("MapBracket returned error: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("got %d matches, want 1", len(matches))
	}
	m := matches[0]
	if m.WinnerID == nil || *m.WinnerID != "10" {
		t.Errorf("winnerId = %v, want \"10\" (Argentina, higher shootoutScore)", m.WinnerID)
	}
}

// TestMapBracketEventOverride covers EVENT_SLUG_OVERRIDE (the 2010 QF ESPN
// mis-tags as group-stage): a per-event correction wins over season.slug.
func TestMapBracketEventOverride(t *testing.T) {
	raw := []byte(`{"events":[{"id":"264118","date":"2010-07-03T00:00Z","season":{"slug":"group-stage"},
		"status":{"type":{"state":"post","completed":true,"shortDetail":"FT","name":"STATUS_FULL_TIME"}},
		"competitions":[{"notes":[],"competitors":[
			{"homeAway":"home","winner":false,"score":"0","team":{"id":"20","abbreviation":"PAR","displayName":"Paraguay","logo":"x/countries/par.png"}},
			{"homeAway":"away","winner":true,"score":"1","team":{"id":"21","abbreviation":"ESP","displayName":"Spain","logo":"x/countries/esp.png"}}
		]}]}]}`)

	matches, err := MapBracket(raw)
	if err != nil {
		t.Fatalf("MapBracket returned error: %v", err)
	}

	if len(matches) != 1 {
		t.Fatalf("got %d matches, want 1 (event override should rescue this from being dropped as group-stage)", len(matches))
	}
	if matches[0].Round != "quarterfinals" {
		t.Errorf("round = %q, want quarterfinals (EVENT_SLUG_OVERRIDE for event 264118)", matches[0].Round)
	}
}

func TestMapBracketTeamDoesNotTreatClubCrestAsPlaceholder(t *testing.T) {
	crest := "https://example.test/clubs/123.png"
	team := mapBracketTeam(rawTeam{
		ID: "123", DisplayName: "Club FC", Abbreviation: "CLB", Logo: &crest,
	})
	if team.Placeholder {
		t.Fatal("real club marked as placeholder")
	}
}

func TestValidateBracketSeasonRejectsMismatch(t *testing.T) {
	raw := []byte(`{"events":[{"season":{"year":2022}}]}`)
	if err := ValidateBracketSeason(raw, 2026); err == nil {
		t.Fatal("expected bracket season mismatch")
	}
}

func TestMapBracketRejectsUnknownStatusState(t *testing.T) {
	raw := []byte(`{"events":[{"id":"1","date":"2026-07-01T12:00Z",
		"season":{"slug":"quarterfinals"},
		"status":{"type":{"state":"mystery"}},
		"competitions":[{"competitors":[
			{"homeAway":"home","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
		]}]}]}`)
	if _, err := MapBracket(raw); err == nil {
		t.Fatal("expected unknown bracket state error")
	}
}

func TestMapBracketRejectsFinishedMatchWithoutWinner(t *testing.T) {
	raw := []byte(`{"events":[{"id":"1","date":"2026-07-01T12:00Z",
		"season":{"slug":"quarterfinals"},
		"status":{"type":{"state":"post","completed":true,"name":"STATUS_FULL_TIME"}},
		"competitions":[{"competitors":[
			{"homeAway":"home","score":"1","team":{"id":"1","displayName":"Home","abbreviation":"HOM"}},
			{"homeAway":"away","score":"1","team":{"id":"2","displayName":"Away","abbreviation":"AWY"}}
		]}]}]}`)
	if _, err := MapBracket(raw); err == nil {
		t.Fatal("accepted finished knockout match without winner")
	}
}
