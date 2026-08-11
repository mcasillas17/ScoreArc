package source

import (
	"context"
	"encoding/json"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ESPN implements Source with ESPN's keyless public API.
type ESPN struct{ client *espn.Client }

func NewESPN(client *espn.Client) *ESPN {
	if client == nil {
		client = espn.New()
	}
	return &ESPN{client: client}
}

func (e *ESPN) Name() string { return "espn" }

func (e *ESPN) get(ctx context.Context, url string) ([]byte, error) {
	var raw json.RawMessage
	if err := e.client.GetJSON(ctx, url, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func (e *ESPN) Scoreboard(ctx context.Context, comp config.Competition, _ config.Season) ([]model.Match, error) {
	raw, err := e.get(ctx, espn.ScoreboardURL(comp.ESPNSlug, ""))
	if err != nil {
		return nil, err
	}
	return espn.MapScoreboard(raw)
}

func (e *ESPN) Summary(ctx context.Context, comp config.Competition, matchID string) (model.MatchDetail, error) {
	raw, err := e.get(ctx, espn.SummaryURL(comp.ESPNSlug, matchID))
	if err != nil {
		return model.MatchDetail{}, err
	}
	return espn.MapSummary(raw)
}

func (e *ESPN) Standings(ctx context.Context, comp config.Competition, _ config.Season) ([]model.Standing, error) {
	raw, err := e.get(ctx, espn.StandingsURL(comp.ESPNSlug))
	if err != nil {
		return nil, err
	}
	return espn.MapStandings(raw)
}

func (e *ESPN) TopScorers(ctx context.Context, comp config.Competition, _ config.Season, limit int) ([]model.TopScorer, error) {
	raw, err := e.get(ctx, espn.StatisticsURL(comp.ESPNSlug))
	if err != nil {
		return nil, err
	}
	return espn.MapTopScorers(raw, limit)
}

func (e *ESPN) Bracket(ctx context.Context, comp config.Competition, season config.Season) ([]model.BracketMatch, error) {
	var dates string
	if season.BracketDatesRange != nil {
		dates = *season.BracketDatesRange
	}
	raw, err := e.get(ctx, espn.BracketURL(comp.ESPNSlug, dates))
	if err != nil {
		return nil, err
	}
	return espn.MapBracket(raw)
}

var _ Source = (*ESPN)(nil)
