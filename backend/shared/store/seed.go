package store

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/config"
)

const teamSeedUpsertSQL = `
INSERT INTO team (id, kind, name, short_name, abbr, country, crest_url, provisional, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, false, now())
ON CONFLICT (id) DO UPDATE SET
	kind = EXCLUDED.kind,
	name = EXCLUDED.name,
	short_name = EXCLUDED.short_name,
	abbr = EXCLUDED.abbr,
	country = EXCLUDED.country,
	-- Never clobber a mirrored crest with a null from the seed.
	crest_url = COALESCE(EXCLUDED.crest_url, team.crest_url),
	-- Curating a team is exactly how a provisional row stops being provisional.
	provisional = false,
	updated_at = now()`

const teamRefUpsertSQL = `
INSERT INTO team_external_ref (source, source_id, team_id, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, now(), now())
ON CONFLICT (source, source_id) DO UPDATE SET
	team_id = EXCLUDED.team_id,
	last_seen_at = now()`

// ApplyTeamSeed writes the curated team registry and its source crosswalk
// rows. It is idempotent and runs at ingester startup, so curating a team in
// the seed file promotes any provisional row that already claimed its source
// ids.
func (s *Store) ApplyTeamSeed(ctx context.Context, seed []config.SeedTeam) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, team := range seed {
		if _, err := tx.Exec(ctx, teamSeedUpsertSQL,
			team.ID, team.Kind, team.Name, nullIfEmpty(team.ShortName),
			team.Abbr, nullIfEmpty(team.Country), team.CrestURL,
		); err != nil {
			return err
		}
		for source, sourceID := range team.Refs {
			if _, err := tx.Exec(ctx, teamRefUpsertSQL, source, sourceID, team.ID); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
