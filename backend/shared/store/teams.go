package store

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const teamUpsertSQL = `
INSERT INTO team (id, name, abbr, crest_url, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (id) DO UPDATE SET
	name = COALESCE(NULLIF(EXCLUDED.name, ''), team.name),
	abbr = COALESCE(NULLIF(EXCLUDED.abbr, ''), team.abbr),
	crest_url = COALESCE(team.crest_url, EXCLUDED.crest_url),
	updated_at = now()
WHERE team.name IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.name, ''), team.name)
	OR team.abbr IS DISTINCT FROM COALESCE(NULLIF(EXCLUDED.abbr, ''), team.abbr)
	OR (team.crest_url IS NULL AND EXCLUDED.crest_url IS NOT NULL)`

func (s *Store) UpsertTeams(ctx context.Context, teams []model.Team) error {
	if len(teams) == 0 {
		return nil
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	teams = teamsByID(teams)
	batch := &pgx.Batch{}
	for _, team := range teams {
		batch.Queue(teamUpsertSQL, team.ID, team.Name, team.Abbr, team.CrestURL)
	}
	return s.pool.SendBatch(ctx, batch).Close()
}

func teamsByID(teams []model.Team) []model.Team {
	sorted := append([]model.Team(nil), teams...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].ID < sorted[j].ID
	})
	return sorted
}

func (s *Store) SetTeamCrest(ctx context.Context, teamID, cdnURL string) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`UPDATE team SET crest_url=$2, updated_at=now() WHERE id=$1`,
		teamID, cdnURL)
	return err
}
