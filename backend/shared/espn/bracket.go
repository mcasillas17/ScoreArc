package espn

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
)

// Port of src/server/data/providers/espn-bracket.ts. Brackets come from a
// separate ESPN scoreboard feed pre-filtered to knockout rounds (not derived
// from the regular matches feed): each event carries a `season.slug` round
// tag ("round-of-32" ... "final") instead of belonging to a group.
//
// Divergence from the TS mapper (intentional, not a parity break): the TS
// mapBracket groups matches into BracketRound[] (slug + matches) for
// direct rendering. The Go port returns a flat []BracketMatch — each row
// already carries its own Round slug (reusing the same vocabulary as
// Match.Round) — because Task 6 upserts these as individual `match` rows;
// the reader reconstructs BracketRound[] (adding round display names) from
// the stored rows in slice 1c, and the frontend folds two-legged ties for
// presentation. The Go mapper therefore retains each provider leg separately;
// a completed first leg may legitimately have no winner. The round *ordering
// and membership* rules are ported exactly: matches are grouped by round
// internally and only rounds present in the canonical knockoutRounds
// vocabulary are emitted, in canonical order, preserving each round's original
// (bracket) match order.

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

// KnockoutRounds returns the knockout round vocabulary in bracket order. The
// reader serves exactly these slugs (OpenAPI enumerates them).
func KnockoutRounds() []string { return slices.Clone(knockoutRoundOrder) }

// roundSlugAlias mirrors espn-bracket.ts's SLUG_ALIAS: ESPN renamed some
// rounds across editions — older World Cups (1998-2010) tag the Round of 16
// as `second-round`, and 2002 uses `third-place`. Normalize so every edition
// buckets into the same canonical slugs.
var roundSlugAlias = map[string]string{
	"second-round": "round-of-16",
	"third-place":  "3rd-place-match",
	// Women's World Cup: `3rd-place` (2015-23), hyphenated rounds (2003-15).
	"3rd-place":      "3rd-place-match",
	"quarter-finals": "quarterfinals",
	"semi-finals":    "semifinals",
	// Liga MX tags its two-legged final `apertura---finals` / `clausura---finals`.
	"finals": "final",
}

var nonKnockoutRound = map[string]struct{}{
	"group-stage":         {},
	"league-phase":        {},
	"league-stage":        {},
	"preliminary-round":   {},
	"qualification":       {},
	"qualifying":          {},
	"regular-season":      {},
	"torneo-apertura":     {},
	"relegation-playoffs": {}, // UEFA Nations League promotion/relegation ties
}

// These ties qualify for the Gold Cup, not the Nations League title bracket.
// The 2026-27 edition tags its first stage `-prelims`; 2024-25 used the bare
// tag, which is what the stage after the prelims is expected to carry.
const (
	goldCupPlayInPrelimsRound = "gold-cup-play-in-prelims"
	goldCupPlayInRound        = "gold-cup-play-in"
)

// ESPN's actual tag for the UEFA Nations League promotion/relegation ties
// (`relegation-playoffs` above was a guess made before any were published).
// They decide league membership, not the title.
const uefaPromotionRelegationRound = "promotionrelegation-playoffs"

// outsideTitleBracket reports a provider stage that is explicitly not part of
// the competition's title bracket. Unlike nonKnockoutRound it also counts as
// confirmation, so it supersedes an unknown-round requirement already stored.
func outsideTitleBracket(seasonSlug string) bool {
	return seasonSlug == goldCupPlayInPrelimsRound || seasonSlug == goldCupPlayInRound ||
		seasonSlug == uefaPromotionRelegationRound
}

func normRoundSlug(slug string) string {
	// Leagues with a post-season prefix the round with its phase:
	// `playoffs---quarterfinals` (NWSL), `apertura---quarterfinals` (Liga MX).
	// The round is what follows; the phase is the season's business.
	if i := strings.LastIndex(slug, "---"); i >= 0 {
		slug = slug[i+3:]
	}
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

var placeholderNameRe = regexp.MustCompile(`(?i)\b(winner|loser|tbd|to be determined)\b`)

// IsBracketPlaceholder identifies a provider slot before a team has qualified.
func IsBracketPlaceholder(name string, crest *string) bool {
	return (crest == nil || *crest == "") && placeholderNameRe.MatchString(name)
}

// bracketRoundSlug ports espn-bracket.ts's roundSlug: a per-event correction
// wins over the season-slug alias mapping.
func bracketRoundSlug(eventID, seasonSlug string, season config.Season) string {
	if v, ok := eventRoundSlugOverride[eventID]; ok {
		return v
	}
	if season.PlayoffFormat == "nwsl" && seasonSlug == "playoffs---championship" {
		return "final"
	}
	return normRoundSlug(seasonSlug)
}

func bracketRequirement(seasonSlug, round string) *bool {
	if seasonSlug == "" {
		return nil
	}
	if isKnockoutRound(round) {
		required := true
		return &required
	}
	if _, ok := nonKnockoutRound[round]; ok || outsideTitleBracket(round) {
		required := false
		return &required
	}
	required := true
	return &required
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
		ID:          string(t.ID),
		Name:        name,
		Abbr:        t.Abbreviation,
		CrestURL:    crest,
		Placeholder: IsBracketPlaceholder(name, crest),
	}
}

// mapBracketMatch validates a bracket observation before mapping its facts.
// Invalid status or incomplete identity must fail the whole bracket response,
// not become candidates or a successful empty observation.
func mapBracketMatch(ev rawEvent, season config.Season, round string) (BracketMatch, error) {
	if len(ev.Competitions) == 0 {
		return BracketMatch{}, fmt.Errorf("missing competition")
	}
	comp := ev.Competitions[0]

	home, away := comp.sides()
	if ev.ID == "" || ev.Date == "" || home == nil || away == nil ||
		home.Team.ID == "" || away.Team.ID == "" {
		return BracketMatch{}, fmt.Errorf("incomplete match/team identity")
	}
	state, err := observedMatchState(ev.Status)
	if err != nil {
		return BracketMatch{}, err
	}
	kickoff, err := parseESPNDate(ev.Date)
	if err != nil {
		return BracketMatch{}, err
	}
	status := ev.Status

	homeScore, awayScore := scoreOf(home.Score), scoreOf(away.Score)
	if (home.Score != nil && *home.Score != "" && homeScore == nil) ||
		(away.Score != nil && *away.Score != "" && awayScore == nil) {
		return BracketMatch{}, fmt.Errorf("invalid score")
	}
	leg := IsLiguillaLeg(season, round, nil)
	note, err := competitionNote(comp.Notes, comp.Leg, leg)
	if err != nil {
		return BracketMatch{}, err
	}
	homeTeam, awayTeam := mapBracketTeam(home.Team), mapBracketTeam(away.Team)
	// The scoreboard's rule and tiers: a malformed structured total rejects the
	// bracket; otherwise structured totals, then the anchored note. The
	// aggregate rides to the ingester's candidate and decides a finished winner.
	for _, competitor := range []*rawCompetitor{home, away} {
		if !scoreboardTotal(competitor.ShootoutScore) {
			return BracketMatch{}, fmt.Errorf("invalid shootout score")
		}
	}
	shootout := shootoutTotals(home.ShootoutScore, away.ShootoutScore)
	if shootout == nil && note != nil {
		shootout = parseMatchShootoutNote(*note, homeTeam.Name, awayTeam.Name, leg)
	}
	var winnerID, flag *string
	if leg {
		winnerID = LegWinner(season, status.Type.Name, round, note, homeTeam.ID, awayTeam.ID, homeScore, awayScore)
		if state == MatchStateFinished && !terminalMatchStatus(status.Type.Name) && (homeScore == nil || awayScore == nil) {
			return BracketMatch{}, fmt.Errorf("finished leg lacks scores")
		}
	} else {
		var legacyLeg struct{ Value int }
		if len(comp.Leg) != 0 {
			if err := json.Unmarshal(comp.Leg, &legacyLeg); err != nil {
				return BracketMatch{}, err
			}
		}
		flag = flaggedWinnerID(homeTeam.ID, awayTeam.ID, home.Winner, away.Winner)
		winnerID, err = shootoutFirstWinnerID(homeTeam.ID, awayTeam.ID, shootout, home.Winner, away.Winner, state == MatchStateFinished)
		if err != nil {
			return BracketMatch{}, err
		}
		if state == MatchStateFinished && winnerID == nil && legacyLeg.Value != 1 && !terminalMatchStatus(status.Type.Name) {
			return BracketMatch{}, fmt.Errorf("finished knockout match lacks winner")
		}
	}

	// A live minute is ESPN's display clock; without one it is unknown (nil),
	// never "" (T16.2 live-minute contract).
	var minute *string
	if state == MatchStateLive && status.DisplayClock != "" {
		clock := status.DisplayClock
		minute = &clock
	}

	return BracketMatch{
		ID:           string(ev.ID),
		Round:        round,
		Kickoff:      kickoff.Format(time.RFC3339),
		Home:         homeTeam,
		Away:         awayTeam,
		HomeScore:    homeScore,
		AwayScore:    awayScore,
		State:        state,
		StatusDetail: status.Type.ShortDetail,
		StatusName:   status.Type.Name,
		Minute:       minute,
		WinnerID:     winnerID,
		Note:         note,
		Shootout:     shootout,
		WinnerFlagID: flag,
	}, nil
}

// MapBracket ports espn-bracket.ts's mapBracket. It maps ESPN's
// knockout-filtered scoreboard JSON into a flat []BracketMatch: matches are
// grouped by round slug internally (preserving each round's original event
// order) then flattened in canonical knockoutRoundOrder, dropping any round
// whose slug isn't in that vocabulary — mirroring the TS mapper's grouping
// and `ROUND_ORDER.filter(...)` behavior. Malformed knockout events reject the
// payload so partial bracket metadata cannot be persisted.
func MapBracket(raw []byte) ([]BracketMatch, error) {
	return MapSeasonBracket(raw, config.Season{})
}

// MapSeasonBracket retains one score and winner per game for two-legged editions.
func MapSeasonBracket(raw []byte, season config.Season) ([]BracketMatch, error) {
	if err := validateArrayEnvelope(raw, "events"); err != nil {
		return nil, err
	}
	var sb rawScoreboard
	if err := json.Unmarshal(raw, &sb); err != nil {
		return nil, err
	}

	byRound := make(map[string][]BracketMatch, len(knockoutRoundOrder))
	eligibleEvents := 0
	for _, ev := range sb.Events {
		slug := bracketRoundSlug(string(ev.ID), ev.Season.Slug, season)
		if !isKnockoutRound(slug) {
			continue
		}
		eligibleEvents++
		match, err := mapBracketMatch(ev, season, slug)
		if err != nil {
			return nil, fmt.Errorf("ESPN bracket event %q: %w", ev.ID, err)
		}
		byRound[slug] = append(byRound[slug], match)
	}

	matches := make([]BracketMatch, 0, len(sb.Events))
	for _, slug := range knockoutRoundOrder {
		matches = append(matches, byRound[slug]...)
	}
	if eligibleEvents > 0 && len(matches) == 0 {
		return nil, fmt.Errorf("ESPN bracket contained no valid events")
	}

	return matches, nil
}

func isKnockoutRound(slug string) bool {
	for _, candidate := range knockoutRoundOrder {
		if slug == candidate {
			return true
		}
	}
	return false
}
