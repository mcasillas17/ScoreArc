package model

import "time"

// Types in this file are INGESTER-INTERNAL, like participation.go: they are
// never serialized into match_detail's jsonb and never reach the reader, so
// they carry no json tags and adding a field here cannot change an API
// response.
//
// They stay in PROVIDER shape -- TeamSourceID, not a canonical id. Resolution
// belongs to the ingester, where the Store lives.

// PlayCoordinates is where on the pitch something happened.
//
// These EXIST. The product roadmap used to record, under "Not building, and
// why", that "no pass or touch coordinates exist in any response we can
// reach" -- that is true of the SITE host and false of the CORE host. Verified
// 2026-08-15 on mex.1 event 401877018: 546 of 567 sampled plays carried
// non-zero values, and shots additionally carry placement within the goal
// mouth. An xG model needs shot location; shot location is here.
//
// Axes run 0-100. Start is where the action began, End where it finished.
// GoalY/GoalZ are the goal-mouth placement of a shot (there is no meaningful
// goalPositionX). Every field is a pointer because a play can be located
// without having a destination, and a shot without having been on frame.
type PlayCoordinates struct {
	StartX, StartY *float64
	EndX, EndY     *float64
	GoalY, GoalZ   *float64
}

// Play is one event in a match's touch-level stream.
type Play struct {
	SourceID string // ESPN's play id -- stable, and the key we store on
	Seq      int    // provider order, for replay

	TypeID   string
	TypeKey  string // type.type, the machine value: "shot-blocked"
	TypeText string // type.text, English display: "Shot Blocked"

	// Parsed out of the $ref URLs, NEVER fetched. See espn.RefID.
	TeamSourceID   string
	PlayerSourceID string

	// nil means the provider omitted the measurement. Zero is a real reading.
	Period       *int
	ClockValue   *int
	ClockDisplay string
	Wallclock    *time.Time

	HomeScore   *int
	AwayScore   *int
	ScoringPlay bool
	ScoreValue  *int

	OwnGoal      bool
	PenaltyKick  bool
	YellowCard   bool
	RedCard      bool
	Substitution bool
	Shootout     bool

	// nil when the provider located nothing, which includes the (0,0) it uses
	// as an unset sentinel.
	Coordinates *PlayCoordinates

	Text string
}

// PlayStream is one page of a match's plays plus the pagination the caller
// needs in order to know it is not done.
type PlayStream struct {
	Total     int
	PageIndex int
	PageSize  int
	PageCount int
	Plays     []Play
}

// touchTierKeys are the play types ESPN prunes for older matches. Verified
// 2026-08-15: event 740722 (2025-11-30) returned 175 plays containing none of
// these; event 401877018 (2026-08-15) returned 1542 containing all of them.
var touchTierKeys = map[string]bool{
	"pass": true, "ball-touch": true, "tackle": true, "take-on": true,
	"aerial": true, "clear": true, "cross": true, "dispossessed": true,
	"interception": true, "blocked-pass": true, "out": true,
	"attempted-tackle": true,
}

// retentionTierKeys are the touch types whose presence proves ESPN has not
// pruned the full stream. This differs from touchTierKeys by one observed type:
// the pruned fixture still carries 13 blocked-pass events, so blocked-pass stays
// R2-only for storage cost but cannot be used as a retention sentinel.
var retentionTierKeys = map[string]bool{
	"pass": true, "ball-touch": true, "tackle": true, "take-on": true,
	"aerial": true, "clear": true, "cross": true, "dispossessed": true,
	"interception": true, "out": true, "attempted-tackle": true,
}

// HasTouchTier reports whether this stream still contains the perishable tier.
//
// The caller records the answer against the archive, because "this object will
// never yield a pass network" is a fact about the object that a later
// re-processing run cannot re-derive -- it would just see an empty result and
// conclude the parser is broken.
func (s PlayStream) HasTouchTier() bool {
	for _, play := range s.Plays {
		if retentionTierKeys[play.TypeKey] {
			return true
		}
	}
	return false
}

// IsTouchTier reports whether a play type belongs to the tier ESPN prunes.
func IsTouchTier(typeKey string) bool { return touchTierKeys[typeKey] }
