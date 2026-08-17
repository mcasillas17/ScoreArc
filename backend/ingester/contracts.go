package main

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
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
	Official(context.Context, string, store.OfficialRef) (uuid.UUID, error)
	ApplyTeamSeed(context.Context, []config.SeedTeam) error
	ApplyCompetitionSeed(context.Context, []config.Competition) error

	// facts
	SetTeamCrest(context.Context, string, string) error
	UpsertMatch(context.Context, store.MatchIdentity, model.Match) error
	UpsertMatchDetail(context.Context, uuid.UUID, model.MatchDetail) error
	FinalizeMatch(context.Context, store.MatchIdentity, model.Match, model.MatchDetail) (bool, error)
	WriteParticipation(context.Context, string, uuid.UUID, string, string, *model.MatchParticipation) (store.ParticipationStats, error)
	// WriteWinProbSnapshot appends one point of a live match's probability
	// curve. Like WriteParticipation it is additive: a failure is recorded and
	// never blocks a scoreline.
	WriteWinProbSnapshot(context.Context, uuid.UUID, model.WinProbability, time.Time) error
	WriteCommentary(context.Context, uuid.UUID, []model.CommentaryLine) (int, error)
	// WriteMatchOfficials records a full-time officiating crew. Additive like
	// participation: a failure is audited and never blocks a scoreline.
	WriteMatchOfficials(context.Context, uuid.UUID, []model.MatchOfficial, map[string]uuid.UUID) error
	// WriteMatchOdds records the FIXED opening and closing lines, which are
	// only settled once the match is.
	WriteMatchOdds(context.Context, uuid.UUID, []model.ProviderOdds) error
	// WriteOddsSnapshot appends one sampled point of each bookmaker's current
	// line. These are raw prices and are deliberately separate from
	// WriteWinProbSnapshot's normalized probabilities.
	WriteOddsSnapshot(context.Context, uuid.UUID, []model.ProviderOdds, time.Time) error
	WritePlays(context.Context, uuid.UUID, []model.Play, map[string]string, map[string]uuid.UUID) (int, error)
	ResolveKnownPlayers(context.Context, string, []string) (map[string]uuid.UUID, error)
	RecordPlayArchive(context.Context, uuid.UUID, string, int, int, bool) error
	MatchesMissingPlays(context.Context, string, string, string, int) ([]store.MissingPlayMatch, error)
	ExistingMatches(context.Context, string, string, []uuid.UUID) (map[uuid.UUID]store.MatchRow, error)
	UnfinalizedMatches(context.Context, string, string, string) ([]model.Match, error)
	ReplaceStandings(context.Context, string, string, string, []model.Standing, map[string]string) error
	// WriteStandingSnapshot is the only write here whose absence is
	// irreversible: ESPN publishes the current table, not yesterday's, so a day
	// this does not record is gone. It is deliberately separate from
	// ReplaceStandings so it can only ever be called with rows that
	// replacement actually accepted.
	WriteStandingSnapshot(context.Context, string, string, []model.Standing, map[string]string, time.Time) (int, error)
	ReplaceLeaders(context.Context, string, string, string, string, []model.StatLeader) error
	ReplaceSquad(context.Context, string, string, string, string, []model.SquadMember, map[string]uuid.UUID) error
	PlayersNeedingBio(context.Context, string, time.Time, int) (map[string]uuid.UUID, error)
	ReplaceTeamHistory(context.Context, uuid.UUID, string, []model.TeamHistoryEntry) error
	LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error
	PruneIngestRuns(context.Context, time.Time) (int64, error)
}

type crestMirror interface {
	BaseURL() string
	Mirror(context.Context, string, string, string) (string, error)
}

// rawArchive is the PRIVATE bucket. Deliberately not folded into crestMirror:
// that interface exposes BaseURL(), which the raw bucket does not have and
// must not be given a plausible-looking value for.
type rawArchive interface {
	Put(
		context.Context,
		string,
		[]byte,
		assets.PlayArchiveMetadata,
	) (assets.ArchivePutResult, error)
}
