package store

import "context"

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
