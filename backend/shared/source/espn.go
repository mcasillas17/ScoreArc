package source

import (
	"bytes"
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
	client   *espn.Client
	coreBase string
	group    singleflight.Group
	mu       sync.Mutex
	recent   map[string]cachedResponse
}

type cachedResponse struct {
	raw       []byte
	fetchedAt time.Time
}

const (
	scoreboardEventLimit = 1000
	scoreboardCacheTTL   = 5 * time.Second
	maxPlayPages         = 10
	// A successful first-team roster must contain at least a starting XI.
	// Shorter payloads are not authoritative enough for replacement deletion.
	minimumRosterPlayers = 11
)

func NewESPN(client *espn.Client) *ESPN {
	if client == nil {
		client = espn.New()
	}

	return &ESPN{
		client: client, coreBase: espn.CorePlaysBase,
		recent: make(map[string]cachedResponse),
	}
}

// NewESPNWithBase overrides the core-host base for tests.
func NewESPNWithBase(client *espn.Client, coreBase string) *ESPN {
	provider := NewESPN(client)
	provider.coreBase = coreBase
	return provider
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
	commentary, err := espn.MapCommentaryLines(raw)
	if err != nil {
		return SummaryResult{}, fmt.Errorf("map commentary: %w", err)
	}
	result := SummaryResult{
		Detail: detail, Participation: participation, Commentary: commentary,
	}
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

// Statistics returns the raw season response so one fetch can feed every
// leaderboard mapper.
func (e *ESPN) Statistics(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) ([]byte, error) {
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
	return raw, nil
}

func (e *ESPN) Roster(
	ctx context.Context,
	comp config.Competition,
	teamSourceID string,
) (model.Squad, error) {
	raw, err := e.get(ctx, espn.TeamRosterURL(comp.ESPNSlug, teamSourceID))
	if err != nil {
		return model.Squad{}, err
	}
	squad, err := espn.MapRoster(raw)
	if err != nil {
		return model.Squad{}, err
	}
	if squad.TeamSourceID != teamSourceID {
		return model.Squad{}, fmt.Errorf(
			"roster team %q does not match %q", squad.TeamSourceID, teamSourceID)
	}
	if len(squad.Players) < minimumRosterPlayers {
		return model.Squad{}, fmt.Errorf(
			"roster team %q has only %d players", teamSourceID, len(squad.Players))
	}
	return squad, nil
}

func (e *ESPN) AthleteBio(
	ctx context.Context,
	comp config.Competition,
	athleteSourceID string,
) ([]model.TeamHistoryEntry, error) {
	raw, err := e.get(ctx, espn.AthleteBioURL(comp.ESPNSlug, athleteSourceID))
	if err != nil {
		return nil, err
	}
	if err := espn.ValidateAthleteBioEnvelope(raw); err != nil {
		return nil, err
	}
	return espn.MapAthleteBio(raw)
}

func (e *ESPN) Plays(
	ctx context.Context,
	comp config.Competition,
	eventID string,
) (model.PlayStream, []byte, error) {
	if comp.ESPNSlug == "" {
		return model.PlayStream{}, nil, fmt.Errorf("espn plays: competition slug is required")
	}
	if eventID == "" {
		return model.PlayStream{}, nil, fmt.Errorf("espn plays: event id is required")
	}

	var merged model.PlayStream
	var pages [][]byte
	seenPlayIDs := make(map[string]struct{})
	for page := 1; ; page++ {
		playsURL := espn.CorePlaysURLOn(
			e.coreBase, comp.ESPNSlug, eventID, page, espn.CorePlayPageLimit)
		raw, err := e.get(ctx, playsURL)
		if err != nil {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s page %d: %w", eventID, page, err)
		}
		stream, err := espn.MapPlays(raw)
		if err != nil {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s page %d: %w", eventID, page, err)
		}
		if stream.Total == 0 && stream.PageCount == 0 && len(stream.Plays) == 0 {
			if page != 1 {
				return model.PlayStream{}, nil, fmt.Errorf(
					"espn plays %s: empty envelope returned on page %d after pagination started",
					eventID, page)
			}
			pages = append(pages, raw)
			merged = stream
			break
		}
		// A provider that quietly hands back its default page size instead of
		// the one asked for turns a 2-request fetch into 62. It has a documented
		// cliff at limit>1000 and no error, so this is the only place it can be
		// caught.
		if stream.PageSize != espn.CorePlayPageLimit {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s: requested page size %d, provider returned %d",
				eventID, espn.CorePlayPageLimit, stream.PageSize)
		}
		if stream.PageIndex != page {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s: requested page index %d, provider returned %d",
				eventID, page, stream.PageIndex)
		}
		if stream.PageCount > maxPlayPages {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s: pageCount %d exceeds the sane bound",
				eventID, stream.PageCount)
		}
		for _, play := range stream.Plays {
			if _, duplicate := seenPlayIDs[play.SourceID]; duplicate {
				return model.PlayStream{}, nil, fmt.Errorf(
					"espn plays %s: duplicate play id %s", eventID, play.SourceID)
			}
			seenPlayIDs[play.SourceID] = struct{}{}
		}

		pages = append(pages, raw)
		if page == 1 {
			merged = stream
		} else {
			if stream.Total != merged.Total || stream.PageCount != merged.PageCount {
				return model.PlayStream{}, nil, fmt.Errorf(
					"espn plays %s: pagination metadata changed at page %d",
					eventID, page)
			}
			merged.Plays = append(merged.Plays, stream.Plays...)
		}
		if stream.PageCount == 0 || page >= stream.PageCount {
			break
		}
	}
	if len(merged.Plays) != merged.Total {
		return model.PlayStream{}, nil, fmt.Errorf(
			"espn plays %s: expected %d plays, received %d",
			eventID, merged.Total, len(merged.Plays))
	}
	return merged, bytes.Join(pages, []byte("\n")), nil
}

// Officials fetches a match's officiating crew from the CORE host.
//
// The crew is one small page, so unlike the play stream there is nothing to
// paginate and no $ref to follow: a crew member's identity is the id already in
// this payload, and following its $ref would spend a request per official to
// learn nothing the ingester's crosswalk does not already resolve.
func (e *ESPN) Officials(
	ctx context.Context,
	comp config.Competition,
	eventID string,
) ([]model.MatchOfficial, error) {
	if comp.ESPNSlug == "" {
		return nil, fmt.Errorf("espn officials: competition slug is required")
	}
	if eventID == "" {
		return nil, fmt.Errorf("espn officials: event id is required")
	}
	raw, err := e.get(ctx, espn.CoreOfficialsURLOn(e.coreBase, comp.ESPNSlug, eventID))
	if err != nil {
		return nil, fmt.Errorf("espn officials %s: %w", eventID, err)
	}
	crew, err := espn.MapOfficials(raw)
	if err != nil {
		return nil, fmt.Errorf("espn officials %s: %w", eventID, err)
	}
	return crew, nil
}

// Odds fetches every bookmaker's line for a match from the CORE host. Prop-bet
// refs inside the payload are deliberately not followed: they are a separate
// endpoint per provider per match, and nothing reads them.
func (e *ESPN) Odds(
	ctx context.Context,
	comp config.Competition,
	eventID string,
) ([]model.ProviderOdds, error) {
	if comp.ESPNSlug == "" {
		return nil, fmt.Errorf("espn odds: competition slug is required")
	}
	if eventID == "" {
		return nil, fmt.Errorf("espn odds: event id is required")
	}
	raw, err := e.get(ctx, espn.CoreOddsURLOn(e.coreBase, comp.ESPNSlug, eventID))
	if err != nil {
		return nil, fmt.Errorf("espn odds %s: %w", eventID, err)
	}
	providers, err := espn.MapOdds(raw)
	if err != nil {
		return nil, fmt.Errorf("espn odds %s: %w", eventID, err)
	}
	return providers, nil
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
