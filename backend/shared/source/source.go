// Package source defines external football-data providers.
package source

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// Source returns canonical ScoreArc models independent of provider payloads.
type Source interface {
	Name() string
	Scoreboard(context.Context, config.Competition, config.Season) ([]model.Match, error)
	Summary(context.Context, config.Competition, string) (model.MatchDetail, error)
	Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error)
	TopScorers(context.Context, config.Competition, config.Season, int) ([]model.TopScorer, error)
	Bracket(context.Context, config.Competition, config.Season) ([]model.BracketMatch, error)
}
