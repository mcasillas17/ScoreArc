package source

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ESPN implements Source with ESPN's keyless public API.
type ESPN struct {
	client *espn.Client
	group  singleflight.Group
	mu     sync.Mutex
	recent map[string]cachedResponse
}

type cachedResponse struct {
	raw       []byte
	fetchedAt time.Time
}

const (
	scoreboardEventLimit = 1000
	scoreboardCacheTTL   = 5 * time.Second
)

func NewESPN(client *espn.Client) *ESPN {
	if client == nil {
		client = espn.New()
	}

	return &ESPN{client: client, recent: make(map[string]cachedResponse)}
}

func (e *ESPN) Name() string { return "espn" }

func (e *ESPN) get(ctx context.Context, url string) ([]byte, error) {
	if !strings.Contains(url, "/scoreboard") {
		var raw json.RawMessage
		if err := e.client.GetJSON(ctx, url, &raw); err != nil {
			return nil, err
		}
		return raw, nil
	}
	if raw, ok := e.cached(url); ok {
		return raw, nil
	}
	value, err, _ := e.group.Do(url, func() (any, error) {
		if raw, ok := e.cached(url); ok {
			return raw, nil
		}
		var raw json.RawMessage
		if err := e.client.GetJSON(ctx, url, &raw); err != nil {
			return nil, err
		}
		stored := append([]byte(nil), raw...)
		now := time.Now()
		e.mu.Lock()
		for key, entry := range e.recent {
			if now.Sub(entry.fetchedAt) > scoreboardCacheTTL {
				delete(e.recent, key)
			}
		}
		e.recent[url] = cachedResponse{raw: stored, fetchedAt: now}
		e.mu.Unlock()
		return stored, nil
	})
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), value.([]byte)...), nil
}

func (e *ESPN) cached(url string) ([]byte, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	entry, ok := e.recent[url]
	if !ok || time.Since(entry.fetchedAt) > scoreboardCacheTTL {
		delete(e.recent, url)
		return nil, false
	}
	return append([]byte(nil), entry.raw...), true
}

func (e *ESPN) Scoreboard(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	backfill bool,
) ([]model.Match, error) {
	datesRange, err := rollingSeasonRange(time.Now(), season.ID)
	if err != nil {
		return nil, err
	}
	if backfill {
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
	if err := espn.ValidateBackfillCompleteness(raw, scoreboardEventLimit); err != nil {
		return nil, err
	}
	if backfill {
		if err := espn.ValidateScoreboardSeason(raw, expectedYear); err != nil {
			return nil, err
		}
	} else {
		raw, err = espn.FilterScoreboardSeason(raw, expectedYear)
		if err != nil {
			return nil, err
		}
	}
	matches, err := espn.MapScoreboard(raw)
	if err != nil {
		return nil, err
	}
	if !season.HasBracket {
		for i := range matches {
			required := false
			matches[i].BracketRequired = &required
			matches[i].BracketConfirmed = true
		}
	}
	return matches, nil
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
	// match here is the caller's provider-shaped copy, so its team ids are the
	// ones the payload's rosters and events are keyed on.
	participation, err := espn.MapParticipation(raw, match.Home.ID, match.Away.ID)
	if err != nil {
		return SummaryResult{}, err
	}
	result := SummaryResult{Detail: detail, Participation: participation}
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
	// ESPN's statistics season metadata is not reliably tied to the requested
	// league year; the season-scoped URL is the only stable provider contract.
	return espn.MapTopScorers(raw, limit)
}

func (e *ESPN) Bracket(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	backfill bool,
) ([]model.BracketMatch, error) {
	var dates string
	if season.BracketDatesRange != nil {
		dates = *season.BracketDatesRange
	} else if backfill {
		var err error
		dates, err = fullSeasonRange(season.ID)
		if err != nil {
			return nil, err
		}
	} else {
		var err error
		dates, err = rollingSeasonRange(time.Now(), season.ID)
		if err != nil {
			return nil, err
		}
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
	if backfill {
		if err := espn.ValidateBracketSeason(raw, expectedYear); err != nil {
			return nil, err
		}
	} else {
		raw, err = espn.FilterScoreboardSeason(raw, expectedYear)
		if err != nil {
			return nil, err
		}
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

func rollingSeasonRange(now time.Time, seasonID string) (string, error) {
	seasonRange, err := fullSeasonRange(seasonID)
	if err != nil {
		return "", err
	}
	seasonStart, err := time.Parse("20060102", seasonRange[:8])
	if err != nil {
		return "", err
	}
	seasonEnd, err := time.Parse("20060102", seasonRange[9:])
	if err != nil {
		return "", err
	}
	now = now.UTC()
	start := now.AddDate(0, 0, -30)
	end := now.AddDate(0, 0, 7)
	if start.Before(seasonStart) {
		start = seasonStart
	}
	if end.After(seasonEnd) {
		end = seasonEnd
	}
	if end.Before(start) {
		if now.Before(seasonStart) {
			start, end = seasonStart, seasonStart
		} else {
			start, end = seasonEnd, seasonEnd
		}
	}
	return start.Format("20060102") + "-" + end.Format("20060102"), nil
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
