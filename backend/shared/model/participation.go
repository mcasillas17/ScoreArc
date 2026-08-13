package model

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
	Home   []SquadPlayer
	Away   []SquadPlayer
	Events []PlayerEvent
}
