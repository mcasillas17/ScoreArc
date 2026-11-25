package espn

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
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

func TestMapBracketRejectsUnknownStatusState(t *testing.T) {
	raw := []byte(`{"events":[{"id":"1","date":"2026-07-01T12:00Z",
		"season":{"slug":"quarterfinals"},
		"status":{"type":{"state":"mystery","completed":false,"name":"STATUS_IN_PROGRESS"}},
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

func TestMapBracketAllowsFinishedFirstLegWithoutWinner(t *testing.T) {
	raw := []byte(`{"events":[{"id":"401929776","date":"2026-11-13T00:30Z",
		"season":{"slug":"quarterfinals"},
		"status":{"type":{"state":"post","completed":true,"name":"STATUS_FULL_TIME","shortDetail":"FT"}},
		"competitions":[{"leg":{"value":1,"displayValue":"1st Leg"},"notes":[{"text":"1st Leg"}],"competitors":[
			{"homeAway":"home","winner":false,"score":"0","team":{"id":"11678","displayName":"Curaçao","abbreviation":"CUW"}},
			{"homeAway":"away","winner":false,"score":"0","team":{"id":"2659","displayName":"Panama","abbreviation":"PAN"}}
		]}]}]}`)
	matches, err := MapBracket(raw)
	if err != nil {
		t.Fatalf("finished first leg rejected: %v", err)
	}
	if len(matches) != 1 || matches[0].State != MatchStateFinished ||
		matches[0].WinnerID != nil || matches[0].HomeScore == nil ||
		matches[0].AwayScore == nil || *matches[0].HomeScore != 0 ||
		*matches[0].AwayScore != 0 {
		t.Fatalf("first leg=%+v", matches)
	}
}

func TestMapBracketRejectsFinishedSecondLegWithoutWinner(t *testing.T) {
	raw := []byte(`{"events":[{"id":"2","date":"2026-11-18T03:00Z",
		"season":{"slug":"quarterfinals"},
		"status":{"type":{"state":"post","completed":true,"name":"STATUS_FULL_TIME"}},
		"competitions":[{"leg":{"value":2,"displayValue":"2nd Leg"},"competitors":[
			{"homeAway":"home","winner":false,"score":"0","team":{"id":"2659","displayName":"Panama","abbreviation":"PAN"}},
			{"homeAway":"away","winner":false,"score":"0","team":{"id":"11678","displayName":"Curaçao","abbreviation":"CUW"}}
		]}]}]}`)
	if _, err := MapBracket(raw); err == nil {
		t.Fatal("accepted finished second leg without winner")
	}
}

// Every tag here was read from the provider: the first two from this
// edition, `gold-cup-play-in` from the 2024-25 CONCACAF Nations League.
func TestStagesOutsideTheTitleBracketAreConfirmedNotRequired(t *testing.T) {
	for _, slug := range []string{"gold-cup-play-in-prelims", "promotionrelegation-playoffs", "gold-cup-play-in"} {
		required := bracketRequirement(slug, normRoundSlug(slug))
		if required == nil || *required || !outsideTitleBracket(slug) {
			t.Errorf("%q: required=%v outside=%t", slug, required, outsideTitleBracket(slug))
		}
	}
	// The guard itself stays: a tag nobody has classified is still required.
	if required := bracketRequirement("some-new-stage", "some-new-stage"); required == nil || !*required {
		t.Errorf("unknown stage no longer requires bracket confirmation: %v", required)
	}
}

func TestNormRoundSlugReadsPhasePrefixedAndHyphenatedRounds(t *testing.T) {
	for raw, want := range map[string]string{
		"playoffs---quarterfinals":  "quarterfinals",
		"apertura---semifinals":     "semifinals",
		"playoffs---regular-season": "regular-season",
		"quarter-finals":            "quarterfinals",
		"semi-finals":               "semifinals",
		"3rd-place":                 "3rd-place-match",
		"final":                     "final",
		"apertura---finals":         "final",
		"clausura---finals":         "final",
	} {
		if got := normRoundSlug(raw); got != want {
			t.Errorf("normRoundSlug(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestWomensPlayoffRoundsAndLegs(t *testing.T) {
	raw, err := os.ReadFile("../../../src/server/data/__fixtures__/womens-playoff-games.json")
	if err != nil {
		t.Fatal(err)
	}
	var sample struct{ Events []json.RawMessage }
	if err := json.Unmarshal(raw, &sample); err != nil || len(sample.Events) != 3 {
		t.Fatalf("invalid recorded sample: %v", err)
	}
	var legs []BracketMatch
	for _, edition := range []struct {
		format string
		events []json.RawMessage
	}{
		{"nwsl", sample.Events[:1]}, {"femenil-apertura", sample.Events[1:]},
	} {
		body, err := json.Marshal(map[string]any{"events": edition.events})
		if err != nil {
			t.Fatal(err)
		}
		season := config.Season{PlayoffFormat: edition.format}
		scoreboard, err := MapSeasonScoreboard(body, season)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range scoreboard {
			if match.BracketRequired == nil || !*match.BracketRequired || match.BracketConfirmed {
				t.Fatalf("scoreboard bypassed knockout confirmation for %s", match.ID)
			}
		}
		games, err := MapSeasonBracket(body, season)
		if err != nil {
			t.Fatal(err)
		}
		legs = append(legs, games...)
	}
	want := map[string]string{"401932958": "15364", "401932079": "22413", "401932077": "133981"}
	if len(legs) != len(want) {
		t.Fatalf("got %d games", len(legs))
	}
	for _, leg := range legs {
		if leg.Round != "quarterfinals" || leg.WinnerID == nil || *leg.WinnerID != want[leg.ID] {
			t.Fatalf("incorrect match %s: %+v", leg.ID, leg)
		}
		delete(want, leg.ID)
	}
	if len(want) != 0 {
		t.Fatalf("missing games: %v", want)
	}
	if requirement := bracketRequirement("torneo-apertura", "torneo-apertura"); requirement == nil || *requirement {
		t.Fatal("Apertura regular-season result requires a knockout confirmation")
	}
}

func TestFemenilBracketPerLegResult(t *testing.T) {
	for _, tc := range []struct{ name, round, leg, note, home, away, winner string }{
		{"drawn first leg with tie flag", "quarterfinals", "1", "1st Leg", `"score":"0","winner":true`, `"score":"0"`, ""},
		{"drawn second leg with no flag", "quarterfinals", "2", "2nd Leg - Away win 2-0 on aggregate", `"score":"0"`, `"score":"0"`, ""},
		{"different leg and shootout winners", "final", "2", "Away win 4-3 on penalties", `"score":"2"`, `"score":"0","winner":true`, "h"},
		{"contradictory ordinal", "semifinals", "1", "2nd Leg", `"score":"1","winner":true`, `"score":"0"`, "error"},
	} {
		t.Run(tc.name, func(t *testing.T) {

			status := "STATUS_FULL_TIME"
			if tc.round == "final" {
				status = "STATUS_FINAL_PEN"
			}
			raw := []byte(`{"events":[{"id":"1","date":"2026-11-14T23:00Z","season":{"slug":"apertura---` + tc.round + `"},
			"status":{"type":{"state":"post","completed":true,"name":"` + status + `"}},
			"competitions":[{"leg":{"value":` + tc.leg + `},"notes":[{"text":"` + tc.note + `"}],"competitors":[
			{"homeAway":"home","team":{"id":"h","displayName":"Home"},` + tc.home + `},
			{"homeAway":"away","team":{"id":"a","displayName":"Away"},` + tc.away + `}]}]}]}`)
			season := config.Season{PlayoffFormat: "femenil-apertura"}
			bracket, bracketErr := MapSeasonBracket(raw, season)
			scoreboard, scoreboardErr := MapSeasonScoreboard(raw, season)
			if tc.winner == "error" {
				if bracketErr == nil || scoreboardErr == nil {
					t.Fatalf("contradictory ordinals accepted: %v / %v", bracketErr, scoreboardErr)
				}
				return
			}
			if bracketErr != nil || scoreboardErr != nil || len(bracket) != 1 || len(scoreboard) != 1 {
				t.Fatalf("leg rejected: %v / %v", bracketErr, scoreboardErr)
			}
			for _, winner := range []*string{bracket[0].WinnerID, scoreboard[0].WinnerID} {
				if (winner == nil) != (tc.winner == "") || (winner != nil && *winner != tc.winner) {
					t.Fatalf("leg winner %v, want %q", winner, tc.winner)
				}
			}
			if tc.round == "final" {
				for _, totals := range []*Shootout{bracket[0].Shootout, scoreboard[0].Shootout} {
					if totals == nil || totals.HomeScore != 3 || totals.AwayScore != 4 {
						t.Fatalf("lost final shootout: %v", totals)
					}
				}
				if bracket[0].Note == nil || *bracket[0].Note != "2nd Leg - "+tc.note {
					t.Fatalf("lost ordinal or original note: %v", bracket[0].Note)
				}
			}
		})
	}
}

func TestFemenilBracketOrdinalEvidence(t *testing.T) {
	for _, tc := range []struct{ leg, copy, secondary, want string }{
		{`{"displayValue":" 2nd LEG"}`, "Pumas advance", "", "2nd Leg - Pumas advance"},
		{`null`, "", "1st Leg", "1st Leg"},
		{`{"value":2}`, "2nd Leg", "1st Leg", ""},
		{`{"value":2,"displayValue":"1st Leg"}`, "", "", ""},
		{`{"value":0}`, "1st Leg", "", ""},
		{`{"value":1}`, "3rd Leg", "", ""},
	} {
		note, err := competitionNote([]rawNote{{Text: tc.copy}, {Text: tc.secondary}}, json.RawMessage(tc.leg), true)
		if (err != nil) != (tc.want == "") || (err == nil && (note == nil || *note != tc.want)) {
			t.Errorf("ordinal %s %q %q gave %v %v", tc.leg, tc.copy, tc.secondary, note, err)
		}
	}
}

func TestNWSLChampionshipCompletesBracket(t *testing.T) {
	raw, err := os.ReadFile("../../../src/server/data/__fixtures__/nwsl-championship.json")
	if err != nil {
		t.Fatal(err)
	}
	season := config.Season{PlayoffFormat: "nwsl"}
	matches, err := MapSeasonScoreboard(raw, season)
	if err != nil || len(matches) != 1 || matches[0].BracketRequired == nil || !*matches[0].BracketRequired {
		t.Fatalf("scoreboard: %+v, %v", matches, err)
	}
	bracket, err := MapSeasonBracket(raw, season)
	if err != nil || len(bracket) != 1 {
		t.Fatalf("bracket: %+v, %v", bracket, err)
	}
	final := bracket[0]
	if final.ID != matches[0].ID || final.ID != "401934232" || final.Round != "final" || final.State != MatchStateScheduled || final.WinnerID != nil ||
		final.Home.ID != "15365" || final.Away.ID != "20907" {
		t.Fatalf("final: %+v", final)
	}
	other, err := MapBracket(raw)
	if err != nil || len(other) != 0 {
		t.Fatalf("unscoped bracket: %+v, %v", other, err)
	}
}

func TestMensAperturaEditionIngestsBothLegsOfAllFourQuarterfinals(t *testing.T) {
	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	competition, _ := registry.Get("liga-mx")
	season := competition.Seasons["2026-apertura"]
	if !season.HasBracket || season.PlayoffFormat != config.LigaMXApertura || season.BracketDatesRange == nil {
		t.Fatalf("missing configured Apertura playoff: %+v", season)
	}
	raw, err := os.ReadFile("../../../src/server/data/__fixtures__/liga-mx-apertura-quarterfinals.json")
	if err != nil {
		t.Fatal(err)
	}
	legs, err := MapSeasonBracket(raw, season)
	if err != nil || len(legs) != 8 {
		t.Fatalf("ingested %d legs: %v", len(legs), err)
	}
	for i, leg := range legs {
		if leg.Round != "quarterfinals" || leg.Note == nil || noteLeg(*leg.Note) != 1+i/4 || leg.WinnerID != nil {
			t.Fatalf("unexpected leg: %+v", leg)
		}
	}
	second, home, away := "2nd Leg", 2, 1
	if winner := LegWinner(season, "STATUS_FINAL_AET", "final", &second, "h", "a", &home, &away); winner == nil || *winner != "h" {
		t.Fatal("the completed extra-time return leg of the men's final lost its result")
	}
}
