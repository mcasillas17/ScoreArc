package model

import "time"

type Squad struct {
	TeamSourceID string
	Players      []SquadMember
}

type SquadMember struct {
	SourceID    string
	FullName    string
	Number      *int
	Position    string
	BirthDate   *time.Time
	Nationality string
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
