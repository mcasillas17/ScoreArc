package model

import "time"

// CommentaryLine is one line of match commentary with the structure ESPN sends
// and match_detail.commentary drops.
//
// It is ingester-internal, like the participation types: no json tags, never
// serialized into match_detail, and never returned by the reader.
type CommentaryLine struct {
	// ESPN's `sequence`. The reason order is a guarantee here and a
	// coincidence in the jsonb array.
	Seq int

	// nil when the provider omitted the measurement. Zero is a real reading and
	// must not collide with unknown.
	Period     *int
	ClockValue *int
	// time.displayValue verbatim, empty string included. Kickoff, halftime and
	// full-time lines all carry "", which is exactly why ClockValue exists.
	ClockDisplay string

	// play.type.type, the machine value ("kickoff", "goal"), and
	// play.type.text, the English label.
	PlayType     string
	PlayTypeText string

	// play.wallclock. The only field that lets commentary be joined against
	// anything outside the match clock.
	Wallclock *time.Time

	Text string
}
