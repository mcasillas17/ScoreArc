// Package source defines external football-data providers.
package source

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type SummaryResult struct {
	Detail model.MatchDetail
	// Participation is the people in the match — squads and per-player events —
	// in provider shape. Nil when the source can't supply it. It is separate
	// from Detail because Detail is serialized wholesale into match_detail's
	// jsonb and served to the site, whereas this is resolved to canonical
	// player ids and never leaves the ingester.
	Participation *model.MatchParticipation
	// Commentary preserves the provider sequence, numeric clock and play shape
	// for relational storage. Detail.Commentary remains the reader's jsonb
	// contract and is intentionally independent.
	Commentary []model.CommentaryLine
	HomeScore  *int
	AwayScore  *int
}

// Source returns canonical ScoreArc models independent of provider payloads.
type Source interface {
	Name() string
	Scoreboard(context.Context, config.Competition, config.Season, bool) ([]model.Match, error)
	Summary(context.Context, config.Competition, model.Match) (SummaryResult, error)
	Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error)
	Statistics(context.Context, config.Competition, config.Season) ([]byte, error)
	Bracket(context.Context, config.Competition, config.Season, bool) ([]model.BracketMatch, error)
	Roster(context.Context, config.Competition, string) (model.Squad, error)
	AthleteBio(context.Context, config.Competition, string) ([]model.TeamHistoryEntry, error)
	// Plays returns a match's full touch-level stream AND the raw pages that
	// produced it. The raw bytes are what gets archived: re-serialising our own
	// structs would archive our parser's blind spots instead of ESPN's data,
	// and the entire point of the archive is that a better parser can be run
	// over it later.
	Plays(context.Context, config.Competition, string) (model.PlayStream, []byte, error)
	// Officials returns a match's officiating crew in provider identity space.
	// Canonical resolution belongs to the ingester, which owns the crosswalk.
	Officials(context.Context, config.Competition, string) ([]model.MatchOfficial, error)
	// Odds returns every bookmaker's fixed opening and closing lines plus the
	// current line, as published. Prices are kept as the provider quotes them;
	// nothing here converts them into probabilities.
	Odds(context.Context, config.Competition, string) ([]model.ProviderOdds, error)
}
