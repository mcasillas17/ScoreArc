// Package source defines external football-data providers.
package source

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type SummaryResult struct {
	Detail    model.MatchDetail
	HomeScore *int
	AwayScore *int
}

// Source returns canonical ScoreArc models independent of provider payloads.
type Source interface {
	Name() string
	Scoreboard(context.Context, config.Competition, config.Season, bool) ([]model.Match, error)
	Summary(context.Context, config.Competition, model.Match) (SummaryResult, error)
	Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error)
	TopScorers(context.Context, config.Competition, config.Season, int) ([]model.TopScorer, error)
	Bracket(context.Context, config.Competition, config.Season, bool) ([]model.BracketMatch, error)
}
