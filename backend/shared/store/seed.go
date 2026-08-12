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

const competitionUpsertSQL = `
INSERT INTO competition (id, name, short_name, kind, updated_at)
VALUES ($1,$2,$3,$4,now())
ON CONFLICT (id) DO UPDATE SET
	name = EXCLUDED.name, short_name = EXCLUDED.short_name,
	kind = EXCLUDED.kind, updated_at = now()`

const seasonUpsertSQL = `
INSERT INTO season (competition_id, id, label, has_bracket)
VALUES ($1,$2,$3,$4)
ON CONFLICT (competition_id, id) DO UPDATE SET
	label = EXCLUDED.label, has_bracket = EXCLUDED.has_bracket`

const competitionRefUpsertSQL = `
INSERT INTO competition_external_ref (source, source_id, competition_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	competition_id = EXCLUDED.competition_id, last_seen_at = now()`

// ApplyCompetitionSeed writes competitions and their seasons from the
// generated registry, plus the ESPN slug crosswalk. Match rows have a foreign
// key to season, so this must run before any ingest.
func (s *Store) ApplyCompetitionSeed(ctx context.Context, comps []config.Competition) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, comp := range comps {
		// A competition with any bracket season is a cup; otherwise a league.
		kind := "league"
		for _, season := range comp.Seasons {
			if season.HasBracket {
				kind = "cup"
				break
			}
		}
		if _, err := tx.Exec(ctx, competitionUpsertSQL,
			comp.ID, comp.Name, comp.ShortName, kind); err != nil {
			return err
		}
		for _, season := range comp.Seasons {
			if _, err := tx.Exec(ctx, seasonUpsertSQL,
				comp.ID, season.ID, season.Label, season.HasBracket); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, competitionRefUpsertSQL,
			"espn", comp.ESPNSlug, comp.ID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
