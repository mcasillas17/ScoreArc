package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const teamUpsertSQL = `
INSERT INTO team (id, name, abbr, crest_url, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (id) DO UPDATE SET
	name = EXCLUDED.name,
	abbr = EXCLUDED.abbr,
	crest_url = COALESCE(team.crest_url, EXCLUDED.crest_url),
	updated_at = now()
WHERE team.name IS DISTINCT FROM EXCLUDED.name
	OR team.abbr IS DISTINCT FROM EXCLUDED.abbr
	OR (team.crest_url IS NULL AND EXCLUDED.crest_url IS NOT NULL)`

func (s *Store) UpsertTeams(ctx context.Context, teams []model.Team) error {
	if len(teams) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, team := range teams {
		batch.Queue(teamUpsertSQL, team.ID, team.Name, team.Abbr, team.CrestURL)
	}
	return s.pool.SendBatch(ctx, batch).Close()
}

func (s *Store) SetTeamCrest(ctx context.Context, teamID, cdnURL string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE team SET crest_url=$2, updated_at=now() WHERE id=$1`,
		teamID, cdnURL)
	return err
}
