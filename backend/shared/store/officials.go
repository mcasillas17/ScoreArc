package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const matchOfficialUpsertSQL = `
INSERT INTO match_official (match_id, official_id, role, role_id, ord)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (match_id, official_id) DO UPDATE SET
	role    = EXCLUDED.role,
	role_id = EXCLUDED.role_id,
	ord     = EXCLUDED.ord`

// WriteMatchOfficials records a match's officiating crew.
//
// Every crew member is resolved to a canonical official BEFORE anything is
// written: writing the rest of the crew around an unresolvable member would
// leave a match that silently lost its referee, which reads exactly like a
// match nobody refereed.
//
// There is deliberately no tail DELETE, and migration 0008 grants none. A
// provider that briefly reports a shorter crew must not erase appointments;
// removing one is a future retention rule, made explicitly.
func (s *Store) WriteMatchOfficials(
	ctx context.Context,
	matchID uuid.UUID,
	crew []model.MatchOfficial,
	officialIDs map[string]uuid.UUID,
) error {
	if len(crew) == 0 {
		return nil
	}
	if matchID == uuid.Nil {
		return fmt.Errorf("write match officials: match id is required")
	}

	resolved := make([]uuid.UUID, len(crew))
	for index, official := range crew {
		if official.SourceID == "" {
			return fmt.Errorf(
				"write match officials for match %s: crew member %d has no provider id",
				matchID, index)
		}
		officialID, ok := officialIDs[official.SourceID]
		if !ok || officialID == uuid.Nil {
			return fmt.Errorf(
				"write match officials for match %s: crew member %s (%q) has no canonical official id",
				matchID, official.SourceID, official.FullName)
		}
		resolved[index] = officialID
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return fmt.Errorf("begin match official write: %w", err)
	}
	defer rollback(opCtx, tx)

	batch := &pgx.Batch{}
	for index, official := range crew {
		batch.Queue(matchOfficialUpsertSQL,
			matchID, resolved[index], official.Role,
			nullIfEmpty(official.RoleID), nullIfZero(official.Order))
	}
	results := tx.SendBatch(opCtx, batch)
	for _, official := range crew {
		if _, err := results.Exec(); err != nil {
			closeErr := results.Close()
			if closeErr != nil {
				return fmt.Errorf(
					"match %s official %s (%q): %w (close batch: %v)",
					matchID, official.SourceID, official.FullName, err, closeErr)
			}
			return fmt.Errorf("match %s official %s (%q): %w",
				matchID, official.SourceID, official.FullName, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("close match official batch for match %s: %w", matchID, err)
	}
	if err := tx.Commit(opCtx); err != nil {
		return fmt.Errorf("commit match officials for match %s: %w", matchID, err)
	}
	return nil
}

// nullIfZero keeps an unstated crew ordinal NULL. ESPN's crew order is 1-based,
// so storing 0 would claim a position in the crew that does not exist.
func nullIfZero(value int) any {
	if value <= 0 {
		return nil
	}
	return value
}
