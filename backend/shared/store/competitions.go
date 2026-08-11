package store

import (
	"context"
	"sort"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func (s *Store) ReplaceStandings(
	ctx context.Context,
	compID, seasonID string,
	standings []model.Standing,
) error {
	if len(standings) == 0 {
		return ErrEmptyReplacement
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	teams := make(map[string]model.Team, len(standings))
	teamIDs := make([]string, 0, len(standings))
	for _, standing := range standings {
		if _, exists := teams[standing.Team.ID]; !exists {
			teamIDs = append(teamIDs, standing.Team.ID)
		}
		teams[standing.Team.ID] = standing.Team
	}
	sort.Strings(teamIDs)
	for _, teamID := range teamIDs {
		team := teams[teamID]
		if _, err := tx.Exec(ctx, teamUpsertSQL, team.ID, team.Name, team.Abbr, team.CrestURL); err != nil {
			return err
		}
	}
	var existingCount int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM standing WHERE comp_id=$1 AND season_id=$2`,
		compID, seasonID,
	).Scan(&existingCount); err != nil {
		return err
	}
	if existingCount > len(standings) {
		return ErrPartialReplacement
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM standing WHERE comp_id=$1 AND season_id=$2`,
		compID, seasonID); err != nil {
		return err
	}
	for _, standing := range standings {
		if _, err := tx.Exec(ctx, `
INSERT INTO standing (
	comp_id, season_id, team_id, group_id, group_name, rank, played,
	wins, draws, losses, goals_for, goals_against, goal_difference,
	points, advanced, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
			compID, seasonID, standing.Team.ID, standing.GroupID, standing.GroupName,
			standing.Rank, standing.Played, standing.Wins, standing.Draws,
			standing.Losses, standing.GoalsFor, standing.GoalsAgainst,
			standing.GoalDifference, standing.Points, standing.Advanced,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ReplaceTopScorers(
	ctx context.Context,
	compID, seasonID string,
	scorers []model.TopScorer,
) error {
	if len(scorers) == 0 {
		return ErrEmptyReplacement
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM top_scorer WHERE comp_id=$1 AND season_id=$2`,
		compID, seasonID); err != nil {
		return err
	}
	for _, scorer := range scorers {
		if _, err := tx.Exec(ctx, `
INSERT INTO top_scorer (
	comp_id, season_id, rank, player, team_abbr, team_name,
	team_crest_url, goals, matches)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			compID, seasonID, scorer.Rank, scorer.Player, scorer.TeamAbbr,
			scorer.TeamName, scorer.TeamCrestURL, scorer.Goals, scorer.Matches,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
