package store

import (
	"context"
	"fmt"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ReplaceStandings swaps a season's standings table wholesale. teamIDs maps the
// provider team id carried on each row to its canonical team id; the caller
// resolves them, because the store no longer mints team rows — the seed and the
// resolver own them.
func (s *Store) ReplaceStandings(
	ctx context.Context,
	competitionID, seasonID, source string,
	standings []model.Standing,
	teamIDs map[string]string,
) error {
	if len(standings) == 0 {
		return ErrEmptyReplacement
	}
	// Resolve every row up front. A standing for an unresolved team would
	// violate the foreign key and abort the whole replacement transaction, so
	// refuse before opening it and say which team was missing.
	canonical := make([]string, len(standings))
	for index, standing := range standings {
		teamID, resolved := teamIDs[standing.Team.ID]
		if !resolved || teamID == "" {
			return fmt.Errorf(
				"standings for %s/%s reference unresolved team %q",
				competitionID, seasonID, standing.Team.ID)
		}
		canonical[index] = teamID
	}

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var existingCount int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM standing WHERE competition_id=$1 AND season_id=$2`,
		competitionID, seasonID,
	).Scan(&existingCount); err != nil {
		return err
	}
	if existingCount > len(standings) {
		return ErrPartialReplacement
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM standing WHERE competition_id=$1 AND season_id=$2`,
		competitionID, seasonID); err != nil {
		return err
	}
	for index, standing := range standings {
		if _, err := tx.Exec(ctx, `
INSERT INTO standing (
	competition_id, season_id, team_id, group_id, group_name, rank, played,
	wins, draws, losses, goals_for, goals_against, goal_difference,
	points, advanced, source, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
			competitionID, seasonID, canonical[index], standing.GroupID, standing.GroupName,
			standing.Rank, standing.Played, standing.Wins, standing.Draws,
			standing.Losses, standing.GoalsFor, standing.GoalsAgainst,
			standing.GoalDifference, standing.Points, standing.Advanced, source,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ReplaceTopScorers(
	ctx context.Context,
	competitionID, seasonID, source string,
	scorers []model.TopScorer,
) error {
	if len(scorers) == 0 {
		return ErrEmptyReplacement
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM top_scorer WHERE competition_id=$1 AND season_id=$2`,
		competitionID, seasonID); err != nil {
		return err
	}
	for _, scorer := range scorers {
		if _, err := tx.Exec(ctx, `
INSERT INTO top_scorer (
	competition_id, season_id, rank, player, team_abbr, team_name,
	team_crest_url, goals, matches, source)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			competitionID, seasonID, scorer.Rank, scorer.Player, scorer.TeamAbbr,
			scorer.TeamName, scorer.TeamCrestURL, scorer.Goals, scorer.Matches, source,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
