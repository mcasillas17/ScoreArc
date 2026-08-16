package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func (s *Store) PlayersNeedingBio(
	ctx context.Context,
	source string,
	staleBefore time.Time,
	limit int,
) (map[string]uuid.UUID, error) {
	if source == "" {
		return nil, fmt.Errorf("bio source is required")
	}
	if limit <= 0 {
		return nil, fmt.Errorf("bio candidate limit must be positive")
	}
	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	rows, err := s.pool.Query(opCtx, `
SELECT r.source_id, p.id
FROM player p
JOIN player_external_ref r ON r.player_id = p.id AND r.source = $1
WHERE (p.bio_fetched_at IS NULL OR p.bio_fetched_at < $2)
  AND EXISTS (SELECT 1 FROM appearance a WHERE a.player_id = p.id)
ORDER BY p.bio_fetched_at NULLS FIRST
LIMIT $3`,
		source, staleBefore, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query players needing bio: %w", err)
	}
	defer rows.Close()

	candidates := make(map[string]uuid.UUID)
	for rows.Next() {
		var sourceID string
		var playerID uuid.UUID
		if err := rows.Scan(&sourceID, &playerID); err != nil {
			return nil, fmt.Errorf("scan player needing bio: %w", err)
		}
		candidates[sourceID] = playerID
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate players needing bio: %w", err)
	}
	return candidates, nil
}

func (s *Store) ReplaceTeamHistory(
	ctx context.Context,
	playerID uuid.UUID,
	source string,
	entries []model.TeamHistoryEntry,
) error {
	if playerID == uuid.Nil {
		return fmt.Errorf("team history player id is required")
	}
	if source == "" {
		return fmt.Errorf("team history source is required")
	}
	teamSourceIDs := make([]string, 0, len(entries))
	seasons := make([]string, 0, len(entries))
	for index, entry := range entries {
		if entry.TeamSourceID == "" || entry.TeamName == "" || entry.Seasons == "" {
			return fmt.Errorf("team history entry %d is incomplete", index)
		}
		teamSourceIDs = append(teamSourceIDs, entry.TeamSourceID)
		seasons = append(seasons, entry.Seasons)
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return err
	}
	defer rollback(opCtx, tx)

	for index, entry := range entries {
		if _, err := tx.Exec(opCtx, `
INSERT INTO player_team_history
  (player_id, team_source_id, team_name, seasons, ord, source)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (player_id, team_source_id, seasons) DO UPDATE SET
  team_name = EXCLUDED.team_name,
  ord       = EXCLUDED.ord,
  source    = EXCLUDED.source`,
			playerID, entry.TeamSourceID, entry.TeamName, entry.Seasons, index, source,
		); err != nil {
			return fmt.Errorf("upsert player team history: %w", err)
		}
	}
	if _, err := tx.Exec(opCtx, `
DELETE FROM player_team_history h
WHERE h.player_id=$1 AND h.source=$2
  AND NOT EXISTS (
    SELECT 1
    FROM unnest($3::text[], $4::text[]) AS keep(team_source_id, seasons)
    WHERE keep.team_source_id=h.team_source_id AND keep.seasons=h.seasons
  )`,
		playerID, source, teamSourceIDs, seasons,
	); err != nil {
		return fmt.Errorf("prune player team history: %w", err)
	}
	tag, err := tx.Exec(opCtx,
		`UPDATE player SET bio_fetched_at=now(), updated_at=now() WHERE id=$1`,
		playerID,
	)
	if err != nil {
		return fmt.Errorf("stamp player bio refresh: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("stamp player bio refresh: player %s not found", playerID)
	}
	if err := tx.Commit(opCtx); err != nil {
		return err
	}
	return nil
}
