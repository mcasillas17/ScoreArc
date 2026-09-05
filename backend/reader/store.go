package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	return scanMatches(rows)
}

// scanMatches reads the shared match projection. Extracted so the team page's
// fixture list reads the same columns through the same normalisation as the
// competition match list -- two copies of this would drift the first time a
// detail column changed.
func scanMatches(rows pgx.Rows) ([]Match, error) {
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

// One club inside one competition.
//
// Identity, colours and the season record come from team and standing; the
// squad from squad_membership joined to player_season_stat; the matches from
// match. Nothing here needs a new ingest -- every table is already written.
//
// The squad join is LEFT: a player in the squad with no player_season_stat row
// has never been measured, and must still appear. An INNER join would silently
// drop exactly the players the "has not appeared" row exists to show.
const teamProfileSQL = `
SELECT t.id, t.name, t.abbr, t.crest_url, t.color, t.alternate_color,
       s.rank, s.played, s.wins, s.draws, s.losses, s.points, s.goal_difference
FROM team t
LEFT JOIN standing s
       ON s.team_id = t.id AND s.competition_id = $2 AND s.season_id = $3
WHERE t.id = $1`

const teamSquadSQL = `
SELECT p.id, COALESCE(p.known_as, p.full_name), sm.shirt_number, COALESCE(sm.position, ''),
       p.nationality,
       st.appearances, st.sub_ins, st.goals, st.assists, st.shots, st.shots_on_target,
       st.offsides, st.fouls_committed, st.fouls_suffered, st.yellow_cards,
       st.red_cards, st.own_goals, st.saves, st.shots_faced, st.goals_conceded,
       (st.player_id IS NOT NULL) AS has_stats
FROM squad_membership sm
JOIN player p ON p.id = sm.player_id
LEFT JOIN player_season_stat st
       ON st.player_id = sm.player_id
      AND st.competition_id = sm.competition_id
      AND st.season_id = sm.season_id
WHERE sm.competition_id = $2 AND sm.season_id = $3 AND sm.team_id = $1
ORDER BY sm.shirt_number NULLS LAST, p.full_name`

// Preserve the original error for inspection while naming the failed block.
// The HTTP handler logs only safe metadata, not the dependency's error text.
type teamReadError struct {
	operation string
	err       error
}

func (e *teamReadError) Error() string { return fmt.Sprintf("team %s: %v", e.operation, e.err) }
func (e *teamReadError) Unwrap() error { return e.err }

func (s *Store) Team(
	ctx context.Context,
	teamID, competition, season string,
) (*TeamProfile, error) {
	var profile TeamProfile
	var colour, altColour *string
	var rank, played, wins, draws, losses, points, goalDifference *int

	err := s.db.QueryRow(ctx, teamProfileSQL, teamID, competition, season).Scan(
		&profile.Team.ID, &profile.Team.Name, &profile.Team.Abbr, &profile.Team.CrestURL,
		&colour, &altColour,
		&rank, &played, &wins, &draws, &losses, &points, &goalDifference,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, &teamReadError{operation: "identity", err: err}
	}

	// Stored bare, rendered with the '#': the column holds six hex digits so
	// consumers that are not CSS do not have to strip punctuation.
	if colour != nil {
		hashed := "#" + *colour
		profile.Color = &hashed
	}
	if altColour != nil {
		hashed := "#" + *altColour
		profile.AltColor = &hashed
	}

	// The record is built from our own standing row rather than echoed from a
	// provider string, so W-D-L is ours and stays consistent with the table.
	if wins != nil && draws != nil && losses != nil {
		summary := fmt.Sprintf("%d-%d-%d", *wins, *draws, *losses)
		profile.Record = &TeamRecord{
			Summary:        summary,
			GamesPlayed:    played,
			Points:         points,
			GoalDifference: goalDifference,
		}
	}
	if rank != nil {
		standing := fmt.Sprintf("%d in %s", *rank, competition)
		profile.StandingSummary = &standing
	}

	squad, err := s.teamSquad(ctx, teamID, competition, season)
	if err != nil {
		return nil, &teamReadError{operation: "squad", err: err}
	}
	profile.Squad = squad

	schedule, err := s.teamSchedule(ctx, teamID, competition, season)
	if err != nil {
		return nil, &teamReadError{operation: "schedule", err: err}
	}
	profile.Schedule = schedule
	return &profile, nil
}

func (s *Store) teamSquad(
	ctx context.Context,
	teamID, competition, season string,
) ([]SquadPlayer, error) {
	rows, err := s.db.Query(ctx, teamSquadSQL, teamID, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	squad := make([]SquadPlayer, 0)
	for rows.Next() {
		var player SquadPlayer
		var stats PlayerSeasonStats
		var hasStats bool
		if err := rows.Scan(
			&player.ID, &player.Name, &player.Jersey, &player.Position, &player.Nationality,
			&stats.Appearances, &stats.SubIns, &stats.TotalGoals, &stats.GoalAssists,
			&stats.TotalShots, &stats.ShotsOnTarget, &stats.Offsides,
			&stats.FoulsCommitted, &stats.FoulsSuffered, &stats.YellowCards,
			&stats.RedCards, &stats.OwnGoals, &stats.Saves, &stats.ShotsFaced,
			&stats.GoalsConceded, &hasStats,
		); err != nil {
			return nil, err
		}
		// No row at all means never measured, which the page shows as "has not
		// appeared". A row of nulls would read as a measurement that failed.
		if hasStats {
			player.Stats = &stats
		}
		squad = append(squad, player)
	}
	return squad, rows.Err()
}

// The club's fixtures and results: the same projection as Matches, filtered to
// the matches this team plays in. No new ingest -- match already carries both
// team ids.
const teamScheduleSQL = `
SELECT m.id, m.kickoff, m.state, m.minute, m.status_detail, m.status_name,
       m.home_score, m.away_score, m.winner_id, m.note,
       ht.id, ht.name, ht.abbr, ht.crest_url,
       at.id, at.name, at.abbr, at.crest_url,
       d.scorers, d.cards, d.stats, d.win_probability, d.shootout, d.shootout_detail
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
LEFT JOIN match_detail d ON d.match_id = m.id
WHERE m.competition_id = $2 AND m.season_id = $3
  AND (m.home_team_id = $1 OR m.away_team_id = $1)
ORDER BY m.kickoff, m.id`

func (s *Store) teamSchedule(
	ctx context.Context,
	teamID, competition, season string,
) ([]Match, error) {
	rows, err := s.db.Query(ctx, teamScheduleSQL, teamID, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMatches(rows)
}
