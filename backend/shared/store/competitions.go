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
	canonical, err := canonicalStandings("standings", competitionID, seasonID, standings, teamIDs)
	if err != nil {
		return err
	}

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// The shrink guard counts teams, not rows: a team ranked in two tables is
	// one team, so a refresh that drops an overlapping table but keeps every
	// team is the provider's current table set, not a partial one.
	var existingTeams int
	if err := tx.QueryRow(ctx,
		`SELECT count(DISTINCT team_id) FROM standing WHERE competition_id=$1 AND season_id=$2`,
		competitionID, seasonID,
	).Scan(&existingTeams); err != nil {
		return err
	}
	incomingTeams := make(map[string]struct{}, len(canonical))
	for _, teamID := range canonical {
		incomingTeams[teamID] = struct{}{}
	}
	if existingTeams > len(incomingTeams) {
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
	points, advanced, source, table_key, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())`,
			competitionID, seasonID, canonical[index], standing.GroupID, standing.GroupName,
			standing.Rank, standing.Played, standing.Wins, standing.Draws,
			standing.Losses, standing.GoalsFor, standing.GoalsAgainst,
			standing.GoalDifference, standing.Points, standing.Advanced, source,
			standing.TableKey,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// canonicalStandings resolves every row's canonical team before a write opens
// its transaction: an unresolved team would breach the foreign key and abort
// the whole write, so refuse first and name it. A team holds one row per table
// it is ranked in (T16.2); the same canonical team twice in ONE table -- two
// provider ids naming one club -- is a conflict, refused here so the stored
// rows survive and no arrival order picks a winner.
func canonicalStandings(
	what, competitionID, seasonID string,
	standings []model.Standing,
	teamIDs map[string]string,
) ([]string, error) {
	canonical := make([]string, len(standings))
	seen := make(map[[2]string]struct{}, len(standings))
	for index, standing := range standings {
		teamID, resolved := teamIDs[standing.Team.ID]
		if !resolved || teamID == "" {
			return nil, fmt.Errorf("%s for %s/%s reference unresolved team %q",
				what, competitionID, seasonID, standing.Team.ID)
		}
		membership := [2]string{standing.TableKey, teamID}
		if _, duplicate := seen[membership]; duplicate {
			return nil, fmt.Errorf("%s for %s/%s list team %q twice in table %q",
				what, competitionID, seasonID, teamID, standing.TableKey)
		}
		seen[membership] = struct{}{}
		canonical[index] = teamID
	}
	return canonical, nil
}

func (s *Store) ReplaceLeaders(
	ctx context.Context,
	competitionID, seasonID, source, category string,
	leaders []model.StatLeader,
) error {
	if len(leaders) == 0 {
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
		// Scoped by category. A category-blind DELETE here would wipe the goals
		// board every time the assists board is written, leaving whichever ran
		// last, with no error and a silently half-empty page.
		`DELETE FROM top_scorer WHERE competition_id=$1 AND season_id=$2 AND category=$3`,
		competitionID, seasonID, category); err != nil {
		return err
	}
	for _, leader := range leaders {
		if _, err := tx.Exec(ctx, `
INSERT INTO top_scorer (
	competition_id, season_id, category, rank, player, team_abbr, team_name,
	team_crest_url, goals, matches, source)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			competitionID, seasonID, category, leader.Rank, leader.Player, leader.TeamAbbr,
			leader.TeamName, leader.TeamCrestURL, leader.Value, leader.Matches, source,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
