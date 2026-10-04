package main

import (
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
