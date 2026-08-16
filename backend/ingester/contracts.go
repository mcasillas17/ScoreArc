package main

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

// repository is the ingester's whole view of persistence, in two halves:
// identity, which turns provider ids into ScoreArc ids, and facts, which are
// only ever written against ids identity produced.
//
// There is deliberately no UpsertTeams. Team rows belong to the curated seed
// and, on a miss, to the resolver; if the ingester could mint them as a side
// effect of writing a match, every unrecognised provider id would quietly
// become a second copy of a club we already have.
type repository interface {
	// identity
	Team(context.Context, string, store.TeamRef) (string, error)
	Match(context.Context, string, store.MatchRef) (uuid.UUID, error)
	ApplyTeamSeed(context.Context, []config.SeedTeam) error
	ApplyCompetitionSeed(context.Context, []config.Competition) error

	// facts
	SetTeamCrest(context.Context, string, string) error
	UpsertMatch(context.Context, store.MatchIdentity, model.Match) error
	UpsertMatchDetail(context.Context, uuid.UUID, model.MatchDetail) error
	FinalizeMatch(context.Context, store.MatchIdentity, model.Match, model.MatchDetail) (bool, error)
	WriteParticipation(context.Context, string, uuid.UUID, string, string, *model.MatchParticipation) (store.ParticipationStats, error)
	ExistingMatches(context.Context, string, string, []uuid.UUID) (map[uuid.UUID]store.MatchRow, error)
	UnfinalizedMatches(context.Context, string, string, string) ([]model.Match, error)
	ReplaceStandings(context.Context, string, string, string, []model.Standing, map[string]string) error
	// WriteStandingSnapshot is the only write here whose absence is
	// irreversible: ESPN publishes the current table, not yesterday's, so a day
	// this does not record is gone. It is deliberately separate from
	// ReplaceStandings so it can only ever be called with rows that
	// replacement actually accepted.
	WriteStandingSnapshot(context.Context, string, string, []model.Standing, map[string]string, time.Time) (int, error)
	ReplaceTopScorers(context.Context, string, string, string, []model.TopScorer) error
	LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error
	PruneIngestRuns(context.Context, time.Time) (int64, error)
}

type crestMirror interface {
	BaseURL() string
	Mirror(context.Context, string, string, string) (string, error)
}
