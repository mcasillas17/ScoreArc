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
	Number      *int
	Position    string
	BirthDate   *time.Time
	Nationality string
	// Provider CDN media only (cdnurl.ProviderMedia), or "" when the provider
	// sent none or sent anything else.
	HeadshotURL string
	Stats       *PlayerSeasonStats
}

type PlayerSeasonStats struct {
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
	Seasons      string
}
