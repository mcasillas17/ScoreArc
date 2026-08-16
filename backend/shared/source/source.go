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
	HomeScore     *int
	AwayScore     *int
}

// Source returns canonical ScoreArc models independent of provider payloads.
type Source interface {
	Name() string
	Scoreboard(context.Context, config.Competition, config.Season, bool) ([]model.Match, error)
	Summary(context.Context, config.Competition, model.Match) (SummaryResult, error)
	Standings(context.Context, config.Competition, config.Season) ([]model.Standing, error)
	Statistics(context.Context, config.Competition, config.Season) ([]byte, error)
	Bracket(context.Context, config.Competition, config.Season, bool) ([]model.BracketMatch, error)
}
