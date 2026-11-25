package model

import "time"

type Squad struct {
	TeamSourceID string
	// Club primary colour, six hex digits without '#', or "" when the provider
	// did not send a usable one.
	Color string
	// The provider's location label for the club ("América", "Tijuana"), or "".
	Location string
	// In provider roster order; the writer stores each member's index.
	Players []SquadMember
}

type SquadMember struct {
	SourceID    string
	FullName    string
	DisplayName string // Observed roster name used by the 2002 archive.
	Number      *int
	Position    string
	BirthDate   *time.Time
	Nationality string
	// Provider CDN media only (cdnurl.ProviderMedia), or "" when the provider
	// sent none or sent anything else.
	HeadshotURL string
	FlagURL     string
	Stats       *PlayerSeasonStats
}

type PlayerSeasonStats struct {
	// Canonical measurement columns missing from a nonempty provider block.
	// A present null is an observation. An omitted prior count must keep its clock.
	OmittedMeasurements []string `json:"-"`

	Appearances    *int
	SubIns         *int
	Goals          *int
	Assists        *int
	Shots          *int
	ShotsOnTarget  *int
	Offsides       *int
	FoulsCommitted *int
	FoulsSuffered  *int
	OwnGoals       *int
	YellowCards    *int
	RedCards       *int
	Saves          *int
	GoalsConceded  *int
	ShotsFaced     *int
}

type TeamHistoryEntry struct {
	TeamSourceID string
	TeamName     string
	CrestURL     string
	Seasons      string
}
