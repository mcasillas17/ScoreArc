package model

import "errors"

// Types in this file are INGESTER-INTERNAL. Unlike everything in types.go they
// are never serialized into `match_detail`'s jsonb columns and never reach the
// reader, so they carry no json tags and adding a field here cannot change an
// API response.
//
// They exist because the shapes that DO reach the reader — LineupPlayer,
// Scorer, Card — identify a player by display name. That is fine for rendering
// and useless for identity: two players who share a name are one string, and
// one player in two competitions is two strings. These carry the provider's
// athlete id alongside, so the ingester can resolve a canonical player.
//
// They stay in PROVIDER shape (SourceID, not a canonical uuid). Resolution
// belongs to the ingester, where the Store lives — the same seam TeamRef and
// MatchRef already sit on.

// PlayerMatchStats is what one player did in one match, as the provider
// measured it.
//
// Every field is a POINTER, and that is the entire design. ESPN's stat set
// varies by position: a goalkeeper's row carries saves, goalsConceded and
// shotsFaced but no offsides; an outfielder's carries offsides and no saves.
// nil means "the provider did not measure this", zero means "the provider
// measured this and it was zero", and collapsing the two would put an
// invention into every per-position percentile computed downstream.
//
// The field names are ScoreArc's; the ESPN names they are read from are on the
// right. They are looked up by name in the stats array, never by index -- the
// order is ESPN's and an index read would mis-attribute silently.
type PlayerMatchStats struct {
	Goals          *int // totalGoals
	Assists        *int // goalAssists
	Shots          *int // totalShots
	ShotsOnTarget  *int // shotsOnTarget
	Offsides       *int // offsides       -- absent for goalkeepers
	FoulsCommitted *int // foulsCommitted
	FoulsSuffered  *int // foulsSuffered
	// OwnGoals counts own goals THIS PLAYER put into their own net. It is a
	// different attribution from match_event, where ESPN credits an own goal to
	// the team that BENEFITS and names the opposition player. Both are correct;
	// they answer different questions.
	OwnGoals      *int // ownGoals
	YellowCards   *int // yellowCards
	RedCards      *int // redCards
	Saves         *int // saves         -- absent for outfielders
	GoalsConceded *int // goalsConceded
	ShotsFaced    *int // shotsFaced
}

// SquadPlayer is one roster entry as the provider reported it.
//
// Unlike LineupPlayer this includes substitutes. The lineups blob keeps
// starters only because that is what the site renders; appearances need the
// whole sheet, since a player who came off the bench still played.
type SquadPlayer struct {
	SourceID string // "" when the provider omitted the athlete id
	Name     string
	Number   *int
	Position string
	Starter  bool
	// Stats is nil when the payload carried no stat entries for this player --
	// which is NOT the same as an array containing only some stat names. The
	// store relies on the difference: nil must never overwrite numbers an
	// earlier poll established.
	Stats *PlayerMatchStats
}

// Player event types. These are ScoreArc's own vocabulary, not the provider's —
// one row per player-action, so "minutes played" is a query over sub_on/sub_off
// plus Starter rather than a parse of prose.
const (
	PlayerEventGoal    = "goal"
	PlayerEventOwnGoal = "own_goal"
	PlayerEventYellow  = "yellow"
	PlayerEventRed     = "red"
	PlayerEventSubOn   = "sub_on"
	PlayerEventSubOff  = "sub_off"
)

// PlayerEvent is one thing one player did, in provider shape.
//
// A substitution becomes TWO events (sub_on and sub_off) rather than one event
// with two players, so every row is one player-action and the table can be
// grouped by player without special-casing.
type PlayerEvent struct {
	TeamSourceID   string
	PlayerSourceID string // "" when the provider omitted the athlete id
	PlayerName     string
	Type           string
	Minute         string
	Penalty        bool
	Shootout       bool
	// Detail is the provider's own label, kept verbatim. It is the reason a
	// misclassification above is recoverable from stored data instead of
	// requiring a re-fetch that, for a finished match, may be impossible.
	Detail string
}

// MatchParticipation is everything about a match that concerns people rather
// than teams.
type MatchParticipation struct {
	// Coverage evidence stays private; absence is not a measured zero.
	EventsPresent bool
	CoverageIssue string

	// The provider ids the squads were matched on, echoed back so the ingester
	// can map an event's TeamSourceID onto a canonical side without re-deriving
	// which team was home.
	HomeTeamSourceID string
	AwayTeamSourceID string
	Home             []SquadPlayer
	Away             []SquadPlayer
	Events           []PlayerEvent
}

// ValidateParticipation defines evidence sufficient to seal a final capture.
// ESPN provides no authoritative roster/event total; this rejects detectable
// gaps without claiming the upstream feed contains every bench player or card.
func ValidateParticipation(part *MatchParticipation, homeScore, awayScore *int) error {
	if err := ValidateParticipationEvidence(part); err != nil {
		return err
	}
	homeGoals, awayGoals := 0, 0
	for _, event := range part.Events {
		if (event.Type == PlayerEventGoal || event.Type == PlayerEventOwnGoal) && !event.Shootout {
			if event.TeamSourceID == part.HomeTeamSourceID {
				homeGoals++
			} else {
				awayGoals++
			}
		}
	}
	if homeScore == nil || awayScore == nil || *homeScore != homeGoals || *awayScore != awayGoals {
		return errors.New("score_conflict")
	}
	return nil
}

// ValidateParticipationEvidence gates both live replacement and final capture.
// Event identities can expose roster omissions even with eleven starters.
// Final score reconciliation is deliberately separate from this shared check.
func ValidateParticipationEvidence(part *MatchParticipation) error {
	if part == nil || !part.EventsPresent {
		return errors.New("coverage_unavailable")
	}
	if err := ValidateParticipationRosters(part); err != nil {
		return err
	}
	rosterSides := make(map[string]string, len(part.Home)+len(part.Away))
	for _, player := range part.Home {
		rosterSides[player.SourceID] = part.HomeTeamSourceID
	}
	for _, player := range part.Away {
		rosterSides[player.SourceID] = part.AwayTeamSourceID
	}
	for _, event := range part.Events {
		if event.PlayerSourceID == "" || event.PlayerName == "" {
			return errors.New("identity_unresolved")
		}
		if event.TeamSourceID != part.HomeTeamSourceID && event.TeamSourceID != part.AwayTeamSourceID {
			return errors.New("identity_conflict")
		}
		playerSide := rosterSides[event.PlayerSourceID]
		switch event.Type {
		case PlayerEventGoal, PlayerEventOwnGoal, PlayerEventSubOn, PlayerEventSubOff:
			if playerSide == "" {
				return errors.New("coverage_partial")
			}
			expectedSide := event.TeamSourceID
			if event.Type == PlayerEventOwnGoal {
				expectedSide = part.HomeTeamSourceID
				if event.TeamSourceID == part.HomeTeamSourceID {
					expectedSide = part.AwayTeamSourceID
				}
			}
			if playerSide != expectedSide {
				return errors.New("identity_conflict")
			}
		case PlayerEventYellow, PlayerEventRed:
			// Identified staff can receive cards outside the player roster; a known
			// roster player must still match the team receiving the card.
			if playerSide != "" && playerSide != event.TeamSourceID {
				return errors.New("identity_conflict")
			}
		default:
			return errors.New("coverage_partial")
		}
	}
	return nil
}

// ValidateParticipationRosters rejects detectable missing or conflicting roster
// evidence before a replacement may prune already-known players.
func ValidateParticipationRosters(part *MatchParticipation) error {
	if part == nil {
		return errors.New("coverage_unavailable")
	}
	if part.CoverageIssue != "" {
		return errors.New("coverage_partial")
	}
	if part.HomeTeamSourceID == "" || part.AwayTeamSourceID == "" || part.HomeTeamSourceID == part.AwayTeamSourceID {
		return errors.New("identity_conflict")
	}
	players := make(map[string]bool)
	for _, squad := range [][]SquadPlayer{part.Home, part.Away} {
		starters := 0
		for _, player := range squad {
			if player.SourceID == "" || player.Name == "" || players[player.SourceID] {
				return errors.New("identity_unresolved")
			}
			players[player.SourceID] = true
			if player.Starter {
				starters++
			}
		}
		if starters != 11 {
			return errors.New("coverage_partial")
		}
	}
	return nil
}
