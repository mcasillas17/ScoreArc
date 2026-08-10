package espn

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Port of src/server/data/providers/espn-bracket.ts. Brackets come from a
// separate ESPN scoreboard feed pre-filtered to knockout rounds (not derived
// from the regular matches feed): each event carries a `season.slug` round
// tag ("round-of-32" ... "final") instead of belonging to a group.
//
// Divergence from the TS mapper (intentional, not a parity break): the TS
// mapBracket groups matches into BracketRound[] (slug + name + matches) for
// direct rendering. The Go port returns a flat []BracketMatch — each row
// already carries its own Round slug (reusing the same vocabulary as
// Match.Round) — because Task 6 upserts these as individual `match` rows;
// the reader reconstructs BracketRound[] (adding round display names) from
// the stored rows in slice 1c. The round *ordering and membership* rules are
// ported exactly: matches are grouped by round internally and only rounds
// present in the canonical knockoutRounds vocabulary are emitted, in
// canonical order, preserving each round's original (bracket) match order.

// knockoutRoundOrder mirrors espn-bracket.ts's ROUND_ORDER: the canonical
// knockoutRounds vocabulary, in bracket order. A match whose round slug
// (after alias/override normalization) isn't in this vocabulary is dropped
// from the output, exactly as the TS mapper's `ROUND_ORDER.filter(...)`
// silently excludes anything outside it.
var knockoutRoundOrder = []string{
	"round-of-32",
	"round-of-16",
	"quarterfinals",
	"semifinals",
	"final",
	"3rd-place-match",
}

// roundSlugAlias mirrors espn-bracket.ts's SLUG_ALIAS: ESPN renamed some
// rounds across editions — older World Cups (1998-2010) tag the Round of 16
// as `second-round`, and 2002 uses `third-place`. Normalize so every edition
// buckets into the same canonical slugs.
var roundSlugAlias = map[string]string{
	"second-round": "round-of-16",
	"third-place":  "3rd-place-match",
}

func normRoundSlug(slug string) string {
	if v, ok := roundSlugAlias[slug]; ok {
		return v
	}
	return slug
}

// eventRoundSlugOverride mirrors espn-bracket.ts's EVENT_SLUG_OVERRIDE: ESPN
// mis-tags a few specific historical knockout matches. These are finished,
// immutable records, so correct them precisely by ESPN event id.
var eventRoundSlugOverride = map[string]string{
	// 2010 WC quarterfinal Paraguay 0-1 Spain is tagged `group-stage` by
	// ESPN, which would drop it and leave only 3 QFs. It's the fourth
	// quarterfinal.
	"264118": "quarterfinals",
}

// bracketRoundSlug ports espn-bracket.ts's roundSlug: a per-event correction
// wins over the season-slug alias mapping.
func bracketRoundSlug(eventID, seasonSlug string) string {
	if v, ok := eventRoundSlugOverride[eventID]; ok {
		return v
	}
	return normRoundSlug(seasonSlug)
}

// rawBracketScoreboard mirrors the subset of ESPN's (knockout-filtered)
// scoreboard JSON the bracket mapper reads.
type rawBracketScoreboard struct {
	Events []rawBracketEvent `json:"events"`
}

type rawBracketEvent struct {
	ID           string                  `json:"id"`
	Date         string                  `json:"date"`
	Season       rawBracketSeason        `json:"season"`
	Status       *rawStatus              `json:"status"`
	Competitions []rawBracketCompetition `json:"competitions"`
}

type rawBracketSeason struct {
	Slug string `json:"slug"`
}

type rawBracketCompetition struct {
	Competitors []rawBracketCompetitor `json:"competitors"`
	Notes       []rawNote              `json:"notes"`
}

type rawBracketCompetitor struct {
	HomeAway string  `json:"homeAway"`
	Winner   bool    `json:"winner"`
	Score    *string `json:"score"`
	// ShootoutScore is deliberately raw JSON: ESPN sends it as a bare number
	// on modern payloads but the TS mapper (and older payloads) treat it as
	// `any` and coerce via `Number(...)`, so it must accept a JSON number, a
	// numeric string, null, or an absent key.
	ShootoutScore json.RawMessage `json:"shootoutScore"`
	Team          rawTeam         `json:"team"`
}

// jsNumber mirrors JS's `Number(x)` + `Number.isFinite(...)` coercion for
// the shootoutScore value: an absent key is `undefined` -> NaN (not
// finite); explicit `null` -> 0 (finite, matching `Number(null) === 0`); an
// empty string -> 0 (finite, matching `Number("") === 0`); a numeric string
// or bare JSON number parses to its value; anything else is NaN.
func jsNumber(raw json.RawMessage) (value float64, finite bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f, true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		s = strings.TrimSpace(s)
		if s == "" {
			return 0, true
		}
		if fv, err := strconv.ParseFloat(s, 64); err == nil {
			return fv, true
		}
	}
	return 0, false
}

// mapBracketTeam ports espn-bracket.ts's mapBracketTeam.
func mapBracketTeam(t rawTeam) BracketTeam {
	var crest *string
	if t.Logo != nil && *t.Logo != "" {
		crest = t.Logo
	} else if len(t.Logos) > 0 && t.Logos[0].Href != "" {
		href := t.Logos[0].Href
		crest = &href
	}

	name := t.DisplayName
	if name == "" {
		name = t.Name
	}
	if name == "" {
		name = t.Abbreviation
	}

	return BracketTeam{
		ID:          t.ID,
		Name:        name,
		Abbr:        t.Abbreviation,
		CrestURL:    crest,
		Placeholder: !(crest != nil && strings.Contains(*crest, "/countries/")),
	}
}

// bracketWinnerID ports espn-bracket.ts's shootout-first winner resolution:
// a decisive penalty shootout IS the result, so its score decides the
// winner ahead of the `winner` flag — ESPN sets that flag inconsistently on
// shootout matches (sometimes missing, sometimes plain wrong).
func bracketWinnerID(home, away rawBracketCompetitor) *string {
	hs, hFinite := jsNumber(home.ShootoutScore)
	as, aFinite := jsNumber(away.ShootoutScore)
	if hFinite && aFinite && hs != as {
		if hs > as {
			id := home.Team.ID
			return &id
		}
		id := away.Team.ID
		return &id
	}
	if home.Winner {
		id := home.Team.ID
		return &id
	}
	if away.Winner {
		id := away.Team.ID
		return &id
	}
	return nil
}

// mapBracketMatch ports espn-bracket.ts's mapBracketMatch. Returns ok=false
// for a malformed event (no competition, or missing a home/away competitor,
// or no status type) — mirroring the TS mapper's `return null`.
func mapBracketMatch(ev rawBracketEvent) (BracketMatch, bool) {
	if len(ev.Competitions) == 0 {
		return BracketMatch{}, false
	}
	comp := ev.Competitions[0]

	var home, away *rawBracketCompetitor
	for i := range comp.Competitors {
		c := &comp.Competitors[i]
		switch c.HomeAway {
		case "home":
			home = c
		case "away":
			away = c
		}
	}
	if home == nil || away == nil {
		return BracketMatch{}, false
	}
	if ev.Status == nil {
		return BracketMatch{}, false
	}
	status := ev.Status

	state := mapState(status.Type.State, status.Type.Completed)

	var note *string
	if len(comp.Notes) > 0 && comp.Notes[0].Text != "" {
		text := comp.Notes[0].Text
		note = &text
	}

	var minute *string
	if state == MatchStateLive {
		clock := status.DisplayClock
		minute = &clock
	}

	return BracketMatch{
		ID:           ev.ID,
		Round:        bracketRoundSlug(ev.ID, ev.Season.Slug),
		Kickoff:      ev.Date,
		Home:         mapBracketTeam(home.Team),
		Away:         mapBracketTeam(away.Team),
		HomeScore:    scoreOf(home.Score),
		AwayScore:    scoreOf(away.Score),
		State:        state,
		StatusDetail: status.Type.ShortDetail,
		StatusName:   status.Type.Name,
		Minute:       minute,
		WinnerID:     bracketWinnerID(*home, *away),
		Note:         note,
	}, true
}

// MapBracket ports espn-bracket.ts's mapBracket. It maps ESPN's
// knockout-filtered scoreboard JSON into a flat []BracketMatch: matches are
// grouped by round slug internally (preserving each round's original event
// order) then flattened in canonical knockoutRoundOrder, dropping any round
// whose slug isn't in that vocabulary — mirroring the TS mapper's grouping
// and `ROUND_ORDER.filter(...)` behavior. Malformed events are skipped
// rather than erroring.
func MapBracket(raw []byte) ([]BracketMatch, error) {
	var sb rawBracketScoreboard
	if err := json.Unmarshal(raw, &sb); err != nil {
		return nil, err
	}

	byRound := make(map[string][]BracketMatch, len(knockoutRoundOrder))
	for _, ev := range sb.Events {
		slug := bracketRoundSlug(ev.ID, ev.Season.Slug)
		if slug == "" {
			continue
		}
		match, ok := mapBracketMatch(ev)
		if !ok {
			continue
		}
		byRound[slug] = append(byRound[slug], match)
	}

	matches := make([]BracketMatch, 0, len(sb.Events))
	for _, slug := range knockoutRoundOrder {
		matches = append(matches, byRound[slug]...)
	}
	return matches, nil
}
