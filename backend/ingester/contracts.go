package main

import (
	"context"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type repository interface {
	UpsertTeams(context.Context, []model.Team) error
	SetTeamCrest(context.Context, string, string) error
	UpsertMatch(context.Context, string, string, model.Match) error
	UpsertMatchDetail(context.Context, string, model.MatchDetail) error
	FinalizeMatch(context.Context, string, string, model.Match, model.MatchDetail) (bool, error)
	ExistingMatches(context.Context, string, string) (map[string]store.MatchRow, error)
	ReplaceStandings(context.Context, string, string, []model.Standing) error
	ReplaceTopScorers(context.Context, string, string, []model.TopScorer) error
	LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error
}

type crestMirror interface {
	BaseURL() string
	Mirror(context.Context, string, string, string) (string, error)
}
