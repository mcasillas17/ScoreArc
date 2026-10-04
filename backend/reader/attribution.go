package main

import (
	"encoding/json"
	"slices"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// matchSide is one served side of a match: its canonical team id and the
// provider ids the match's source knows that team by (team_external_ref,
// selected with the row as sideRefsColumns).
type matchSide struct {
	id   string
	refs []string
}

// sideRefsColumns selects each side's provider ids for the match's source.
// Two indexed lookups per row (team_external_ref_target_idx), inside the same
// statement: no per-event queries.
const sideRefsColumns = `
       ARRAY(SELECT r.source_id FROM team_external_ref r WHERE r.team_id = m.home_team_id AND r.source = m.source),
       ARRAY(SELECT r.source_id FROM team_external_ref r WHERE r.team_id = m.away_team_id AND r.source = m.source)`

// attributeDetail serves each scorer and card team reference as the canonical
// id of the side it names. match_detail keeps the provider's team id as the
// mapper wrote it, and a finalized row is sealed, so every stored row --
// whenever it was written -- is translated here, at read time. A canonical id
// passes through. A reference that neither side owns, or that both claim, is
// null: never a default side.
func attributeDetail(scorers []espn.Scorer, cards []espn.Card, home, away matchSide) {
	for i := range scorers {
		scorers[i].TeamID = attribute(scorers[i].TeamID, home, away)
	}
	for i := range cards {
		cards[i].TeamID = attribute(cards[i].TeamID, home, away)
	}
}

func attribute(stored *string, home, away matchSide) *string {
	if stored == nil {
		return nil
	}
	owns := func(side matchSide) bool { return *stored == side.id || slices.Contains(side.refs, *stored) }
	var served string
	switch isHome, isAway := owns(home), owns(away); {
	case isHome && !isAway:
		served = home.id
	case isAway && !isHome:
		served = away.id
	default:
		return nil
	}
	return &served
}

// legacyGoalsColumn selects, only for a detail row written before T16.2 -- its
// scorers carry no ownGoal key -- the match's captured goal and own-goal
// events in mapper order, each with its player's id on the match's source. A
// current row costs the jsonpath test and nothing else; a legacy row adds one
// primary-key range scan of match_event and one player_external_ref_target_idx
// lookup per goal, inside the same statement.
const legacyGoalsColumn = `,
       CASE WHEN jsonb_path_exists(d.scorers, '$[*] ? (!(exists(@.ownGoal)))') THEN (
         SELECT jsonb_agg(jsonb_build_object(
                  'teamId', e.team_id, 'minute', e.minute, 'penalty', e.penalty,
                  'shootout', e.shootout, 'ownGoal', e.type = 'own_goal',
                  'athleteId', (SELECT CASE WHEN count(*) = 1 THEN min(r.source_id) END
                                FROM player_external_ref r
                                WHERE r.player_id = e.player_id AND r.source = m.source))
                ORDER BY e.seq)
         FROM match_event e
         WHERE e.match_id = m.id AND e.type IN ('goal', 'own_goal'))
       END`

// legacyGoal is one captured scoring event, as legacyGoalsColumn selects it.
type legacyGoal struct {
	TeamID    string  `json:"teamId"`
	Minute    string  `json:"minute"`
	Penalty   bool    `json:"penalty"`
	Shootout  bool    `json:"shootout"`
	OwnGoal   bool    `json:"ownGoal"`
	AthleteID *string `json:"athleteId"`
}

// recoverLegacyScorers fills ownGoal and athleteId on a legacy row's scorers
// from its captured match events -- all or nothing. The ingester wrote both
// lists from the same summary keyEvents in the same order, so the scorers and
// the goal events must have the same length and agree pairwise on canonical
// side, minute, penalty and shootout. Any disagreement -- participation never
// captured, a side the reader could not attribute, a later summary than the
// events -- leaves every scorer unknown rather than guessing which event each
// one was. Run after attributeDetail, which supplies the canonical sides.
func recoverLegacyScorers(scorers []espn.Scorer, raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	var goals []legacyGoal
	if err := json.Unmarshal(raw, &goals); err != nil {
		return err
	}
	if len(goals) != len(scorers) {
		return nil
	}
	for i, goal := range goals {
		scorer := scorers[i]
		if scorer.OwnGoal != nil || scorer.AthleteID != nil || scorer.TeamID == nil || *scorer.TeamID != goal.TeamID ||
			scorer.Minute != goal.Minute || scorer.Penalty != goal.Penalty || scorer.Shootout != goal.Shootout {
			return nil
		}
	}
	for i := range goals {
		scorers[i].OwnGoal = &goals[i].OwnGoal
		scorers[i].AthleteID = goals[i].AthleteID
	}
	return nil
}
