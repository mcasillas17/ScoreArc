package source

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ESPN implements Source with ESPN's keyless public API.
type ESPN struct{ client *espn.Client }

const scoreboardEventLimit = 1000

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

func (e *ESPN) Scoreboard(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	backfill bool,
) ([]model.Match, error) {
	datesRange := rollingScoreboardRange(time.Now())
	if backfill {
		var err error
		datesRange, err = fullSeasonRange(season.ID)
		if err != nil {
			return nil, err
		}
	}
	scoreboardURL := espn.ScoreboardURLWithLimit(comp.ESPNSlug, datesRange, scoreboardEventLimit)
	raw, err := e.get(ctx, scoreboardURL)
	if err != nil {
		return nil, err
	}

	expectedYear, err := seasonStartYear(season.ID)
	if err != nil {
		return nil, err
	}
	if err := espn.ValidateScoreboardSeason(raw, expectedYear); err != nil {
		return nil, err
	}
	if err := espn.ValidateBackfillCompleteness(raw, scoreboardEventLimit); err != nil {
		return nil, err
	}
	return espn.MapScoreboard(raw)
}

func (e *ESPN) Summary(ctx context.Context, comp config.Competition, match model.Match) (SummaryResult, error) {
	raw, err := e.get(ctx, espn.SummaryURL(comp.ESPNSlug, match.ID))
	if err != nil {
		return SummaryResult{}, err
	}
	if err := espn.ValidateSummary(raw, match.ID, match.Home.ID, match.Away.ID,
		match.State == model.MatchStateFinished); err != nil {
		return SummaryResult{}, err
	}
	detail, err := espn.MapSummary(raw)
	if err != nil {
		return SummaryResult{}, err
	}
	if detail.Shootout == nil && match.Note != nil {
		detail.Shootout = espn.ParseShootoutNote(*match.Note, match.Home.Name, match.Away.Name)
	}
	result := SummaryResult{Detail: detail}
	if match.State == model.MatchStateFinished {
		result.HomeScore, result.AwayScore, err = espn.SummaryFinalScores(raw)
		if err != nil {
			return SummaryResult{}, err
		}
	}
	return result, nil
}

func (e *ESPN) Standings(ctx context.Context, comp config.Competition, season config.Season) ([]model.Standing, error) {
	expectedYear, err := seasonStartYear(season.ID)
	if err != nil {
		return nil, err
	}
	raw, err := e.get(ctx, espn.StandingsURL(comp.ESPNSlug, expectedYear))
	if err != nil {
		return nil, err
	}
	if err := espn.ValidateStandingsSeason(raw, expectedYear); err != nil {
		return nil, err
	}
	return espn.MapStandings(raw)
}

func (e *ESPN) TopScorers(ctx context.Context, comp config.Competition, season config.Season, limit int) ([]model.TopScorer, error) {
	expectedYear, err := seasonStartYear(season.ID)
	if err != nil {
		return nil, err
	}
	raw, err := e.get(ctx, espn.StatisticsURL(comp.ESPNSlug, expectedYear))
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
	raw, err := e.get(ctx, espn.BracketURLWithLimit(comp.ESPNSlug, dates, scoreboardEventLimit))
	if err != nil {
		return nil, err
	}
	if err := espn.ValidateBackfillCompleteness(raw, scoreboardEventLimit); err != nil {
		return nil, err
	}
	expectedYear, err := seasonStartYear(season.ID)
	if err != nil {
		return nil, err
	}
	if err := espn.ValidateBracketSeason(raw, expectedYear); err != nil {
		return nil, err
	}
	return espn.MapBracket(raw)
}

var _ Source = (*ESPN)(nil)

func rollingScoreboardRange(now time.Time) string {
	now = now.UTC()
	start := now.AddDate(0, 0, -30)
	end := now.AddDate(0, 0, 7)
	return start.Format("20060102") + "-" + end.Format("20060102")
}

var seasonYearRe = regexp.MustCompile(`^(\d{4})(?:-(\d{2}|apertura|clausura))?$`)

func fullSeasonRange(seasonID string) (string, error) {
	match := seasonYearRe.FindStringSubmatch(seasonID)
	if match == nil {
		return "", fmt.Errorf("cannot derive ESPN date range from season %q", seasonID)
	}
	startYear, _ := strconv.Atoi(match[1])
	start := time.Date(startYear, time.January, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(startYear, time.December, 31, 0, 0, 0, 0, time.UTC)
	switch strings.ToLower(match[2]) {
	case "":
	case "apertura":
		start = time.Date(startYear, time.July, 1, 0, 0, 0, 0, time.UTC)
	case "clausura":
		end = time.Date(startYear, time.June, 30, 0, 0, 0, 0, time.UTC)
	default:
		endYearSuffix, _ := strconv.Atoi(match[2])
		endYear := startYear/100*100 + endYearSuffix
		if endYear < startYear {
			endYear += 100
		}
		start = time.Date(startYear, time.July, 1, 0, 0, 0, 0, time.UTC)
		end = time.Date(endYear, time.June, 30, 0, 0, 0, 0, time.UTC)
	}
	return start.Format("20060102") + "-" + end.Format("20060102"), nil
}

func seasonStartYear(seasonID string) (int, error) {
	match := seasonYearRe.FindStringSubmatch(seasonID)
	if match == nil {
		return 0, fmt.Errorf("cannot derive ESPN season year from %q", seasonID)
	}
	year, err := strconv.Atoi(match[1])
	if err != nil {
		return 0, fmt.Errorf("parse season year %q: %w", seasonID, err)
	}
	if strings.EqualFold(match[2], "clausura") {
		year--
	}
	return year, nil
}
