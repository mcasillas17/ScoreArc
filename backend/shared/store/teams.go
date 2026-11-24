package store

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// SetTeamCrest records a mirrored crest against a CANONICAL team id. There is
// deliberately no UpsertTeams beside it: team rows are created by the curated
// seed and, on a miss, by the resolver. Nothing else may mint a team, or an
// unrecognised provider id would quietly become a second copy of a club that
// already exists.
func (s *Store) SetTeamCrest(ctx context.Context, teamID, cdnURL string) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`UPDATE team SET crest_url=$2, updated_at=now() WHERE id=$1`,
		teamID, cdnURL)
	return err
}

// SetScoreboardTeamColours applies a full poll in one write. Conflicting
// colours (including across provider aliases) leave the held colour intact.
func (s *Store) SetScoreboardTeamColours(ctx context.Context, source string, matches []model.Match) error {
	type observation struct{ id, colour string }
	seen := make(map[observation]bool)
	var ids, colours []string
	for _, match := range matches {
		for _, team := range []model.Team{match.Home, match.Away} {
			row := observation{team.ID, team.AlternateColor}
			if row.id == "" || row.colour == "" || seen[row] {
				continue
			}
			seen[row] = true
			ids = append(ids, row.id)
			colours = append(colours, row.colour)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, `UPDATE team t SET alternate_color = observed.colour, updated_at = now()
		FROM (SELECT ref.team_id, min(input.colour) AS colour
		      FROM unnest($2::text[], $3::text[]) AS input(id, colour)
		      JOIN team_external_ref ref ON ref.source = $1 AND ref.source_id = input.id
		      GROUP BY ref.team_id HAVING min(lower(input.colour)) = max(lower(input.colour))) observed
		WHERE t.id = observed.team_id AND t.alternate_color IS DISTINCT FROM observed.colour`, source, ids, colours)
	return err
}
