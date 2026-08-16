package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

type database interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Ping(context.Context) error
}

// Store is the parameterized read layer over the SELECT-only database pool.
type Store struct{ db database }

func NewStore(db database) *Store { return &Store{db: db} }

var ErrNotFound = errors.New("not found")

func (s *Store) Ping(ctx context.Context) error { return s.db.Ping(ctx) }

func isoTime(value time.Time) string { return value.UTC().Format(time.RFC3339) }

func jsonInto(raw []byte, destination any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, destination)
}

const matchesSQL = `
SELECT m.id, m.kickoff, m.state, m.minute, m.status_detail, m.status_name,
       m.home_score, m.away_score, m.winner_id, m.note,
       ht.id, ht.name, ht.abbr, ht.crest_url,
       at.id, at.name, at.abbr, at.crest_url,
       d.scorers, d.cards, d.stats, d.win_probability, d.shootout, d.shootout_detail
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
LEFT JOIN match_detail d ON d.match_id = m.id
WHERE m.competition_id = $1 AND m.season_id = $2
ORDER BY m.kickoff, m.id`

func (s *Store) Matches(ctx context.Context, competition, season string) ([]Match, error) {
	rows, err := s.db.Query(ctx, matchesSQL, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	matches := make([]Match, 0)
	for rows.Next() {
		match := Match{Scorers: []espn.Scorer{}, Cards: []espn.Card{}}
		var id uuid.UUID
		var kickoff time.Time
		var state string
		var scorers, cards, stats, winProbability, shootout, shootoutDetail []byte
		if err := rows.Scan(
			&id, &kickoff, &state, &match.Minute, &match.StatusDetail, &match.StatusName,
			&match.HomeScore, &match.AwayScore, &match.WinnerID, &match.Note,
			&match.Home.ID, &match.Home.Name, &match.Home.Abbr, &match.Home.CrestURL,
			&match.Away.ID, &match.Away.Name, &match.Away.Abbr, &match.Away.CrestURL,
			&scorers, &cards, &stats, &winProbability, &shootout, &shootoutDetail,
		); err != nil {
			return nil, err
		}
		match.ID = id.String()
		match.Kickoff = isoTime(kickoff)
		match.State = espn.MatchState(state)
		for _, item := range []struct {
			raw         []byte
			destination any
		}{
			{scorers, &match.Scorers},
			{cards, &match.Cards},
			{stats, &match.Stats},
			{winProbability, &match.WinProbability},
			{shootout, &match.Shootout},
			{shootoutDetail, &match.ShootoutDetail},
		} {
			if err := jsonInto(item.raw, item.destination); err != nil {
				return nil, err
			}
		}
		normalizeMatch(&match)
		matches = append(matches, match)
	}
	return matches, rows.Err()
}

const standingsSQL = `
SELECT s.group_id, s.group_name, s.rank, s.played, s.wins, s.draws, s.losses,
       s.goals_for, s.goals_against, s.goal_difference, s.points, s.advanced,
       t.id, t.name, t.abbr, t.crest_url
FROM standing s
JOIN team t ON t.id = s.team_id
WHERE s.competition_id = $1 AND s.season_id = $2
ORDER BY COALESCE(s.group_name, ''), s.rank, t.id`

func (s *Store) Standings(ctx context.Context, competition, season, defaultGroupName string) ([]Group, error) {
	rows, err := s.db.Query(ctx, standingsSQL, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := make([]Group, 0)
	index := make(map[string]int)
	for rows.Next() {
		var groupID, groupName *string
		var standing Standing
		if err := rows.Scan(
			&groupID, &groupName, &standing.Rank, &standing.Played, &standing.Wins,
			&standing.Draws, &standing.Losses, &standing.GoalsFor, &standing.GoalsAgainst,
			&standing.GoalDifference, &standing.Points, &standing.Advanced,
			&standing.Team.ID, &standing.Team.Name, &standing.Team.Abbr, &standing.Team.CrestURL,
		); err != nil {
			return nil, err
		}

		name := defaultGroupName
		if groupName != nil && *groupName != "" {
			name = *groupName
		}
		id := strings.TrimPrefix(name, "Group ")
		if groupID != nil && *groupID != "" {
			id = *groupID
		}
		key := id + "\x00" + name
		position, exists := index[key]
		if !exists {
			groups = append(groups, Group{ID: id, Name: name, Standings: []Standing{}})
			position = len(groups) - 1
			index[key] = position
		}
		groups[position].Standings = append(groups[position].Standings, standing)
	}
	return groups, rows.Err()
}

var bracketRoundOrder = []string{
	"round-of-32", "round-of-16", "quarterfinals", "semifinals", "final", "3rd-place-match",
}

var bracketRoundNames = map[string]string{
	"round-of-32":     "Round of 32",
	"round-of-16":     "Round of 16",
	"quarterfinals":   "Quarterfinals",
	"semifinals":      "Semifinals",
	"final":           "Final",
	"3rd-place-match": "Third Place",
}

const bracketSQL = `
SELECT m.id, m.round, m.kickoff, m.state, m.minute, m.status_detail, m.status_name,
       m.home_score, m.away_score, m.winner_id, m.note,
       m.home_placeholder, m.away_placeholder,
       ht.id, ht.name, ht.abbr, ht.crest_url,
       at.id, at.name, at.abbr, at.crest_url
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
WHERE m.competition_id = $1 AND m.season_id = $2 AND m.round IS NOT NULL AND m.round <> ''
ORDER BY m.kickoff, m.id`

func (s *Store) Bracket(ctx context.Context, competition, season string) ([]BracketRound, error) {
	rows, err := s.db.Query(ctx, bracketSQL, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bySlug := make(map[string][]espn.BracketMatch)
	for rows.Next() {
		var match espn.BracketMatch
		var id uuid.UUID
		var kickoff time.Time
		var state string
		var homeID, homeName, homeAbbr string
		var homeCrest *string
		var awayID, awayName, awayAbbr string
		var awayCrest *string
		var homePlaceholder, awayPlaceholder bool
		if err := rows.Scan(
			&id, &match.Round, &kickoff, &state, &match.Minute, &match.StatusDetail,
			&match.StatusName, &match.HomeScore, &match.AwayScore, &match.WinnerID, &match.Note,
			&homePlaceholder, &awayPlaceholder,
			&homeID, &homeName, &homeAbbr, &homeCrest,
			&awayID, &awayName, &awayAbbr, &awayCrest,
		); err != nil {
			return nil, err
		}
		match.ID = id.String()
		match.Kickoff = isoTime(kickoff)
		match.State = espn.MatchState(state)
		match.Home = espn.BracketTeam{ID: homeID, Name: homeName, Abbr: homeAbbr, CrestURL: homeCrest, Placeholder: homePlaceholder}
		match.Away = espn.BracketTeam{ID: awayID, Name: awayName, Abbr: awayAbbr, CrestURL: awayCrest, Placeholder: awayPlaceholder}
		bySlug[match.Round] = append(bySlug[match.Round], match)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rounds := make([]BracketRound, 0, len(bySlug))
	for _, slug := range bracketRoundOrder {
		matches, exists := bySlug[slug]
		if !exists {
			continue
		}
		rounds = append(rounds, BracketRound{Slug: slug, Name: bracketRoundNames[slug], Matches: matches})
	}
	return rounds, nil
}

const summarySQL = `
SELECT scorers, cards, stats, win_probability, shootout_detail,
       lineups, videos, info, form, commentary, h2h
FROM match_detail
WHERE match_id = $1`

// MatchSummary keeps a string parameter because the route parameter is one.
// It is parsed rather than handed to Postgres: match_id is a uuid column, so an
// arbitrary path segment would be a type error from the database instead of the
// 404 it plainly is.
func (s *Store) MatchSummary(ctx context.Context, id string) (*MatchSummary, error) {
	matchID, err := uuid.Parse(id)
	if err != nil {
		return nil, ErrNotFound
	}
	var scorers, cards, stats, winProbability, shootoutDetail []byte
	var lineups, videos, info, form, commentary, h2h []byte
	if err := s.db.QueryRow(ctx, summarySQL, matchID).Scan(
		&scorers, &cards, &stats, &winProbability, &shootoutDetail,
		&lineups, &videos, &info, &form, &commentary, &h2h,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	summary := &MatchSummary{
		Scorers:    []espn.Scorer{},
		Cards:      []espn.Card{},
		Videos:     []espn.MatchVideo{},
		Commentary: []espn.CommentaryItem{},
		H2H:        []espn.H2HMeeting{},
	}
	fields := []struct {
		raw         []byte
		destination any
	}{
		{scorers, &summary.Scorers},
		{cards, &summary.Cards},
		{stats, &summary.Stats},
		{winProbability, &summary.WinProbability},
		{shootoutDetail, &summary.ShootoutDetail},
		{lineups, &summary.Lineups},
		{videos, &summary.Videos},
		{info, &summary.Info},
		{form, &summary.Form},
		{commentary, &summary.Commentary},
		{h2h, &summary.H2H},
	}
	for _, field := range fields {
		if err := jsonInto(field.raw, field.destination); err != nil {
			return nil, err
		}
	}
	normalizeMatchSummary(summary)
	return summary, nil
}

const topScorersSQL = `
SELECT rank, player, goals, matches, team_abbr, team_name, team_crest_url
FROM top_scorer
WHERE competition_id = $1 AND season_id = $2 AND category = 'goals'
ORDER BY rank`

func (s *Store) TopScorers(ctx context.Context, competition, season string) ([]espn.TopScorer, error) {
	rows, err := s.db.Query(ctx, topScorersSQL, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	scorers := make([]espn.TopScorer, 0)
	for rows.Next() {
		var scorer espn.TopScorer
		var teamAbbr, teamName *string
		if err := rows.Scan(
			&scorer.Rank, &scorer.Player, &scorer.Goals, &scorer.Matches,
			&teamAbbr, &teamName, &scorer.TeamCrestURL,
		); err != nil {
			return nil, err
		}
		if teamAbbr != nil {
			scorer.TeamAbbr = *teamAbbr
		}
		if teamName != nil {
			scorer.TeamName = *teamName
		}
		scorers = append(scorers, scorer)
	}
	return scorers, rows.Err()
}
