package store

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"
)

// ErrUnknownCompetition means a source referenced a competition that is not in
// our configured registry. Competitions are a closed, configured set, so this
// is a configuration bug rather than upstream drift.
var ErrUnknownCompetition = errors.New("unknown competition for source")

// TeamRef is a provider-scoped team identity plus the hints needed to create a
// usable provisional row and to make the review list legible.
type TeamRef struct {
	SourceID string
	Name     string
	Abbr     string
	Kind     string // "club" | "national"; defaults to "club" when empty
}

// identityCache memoises crosswalk hits. The curated set is ~200 rows and every
// match resolves two teams, so this removes the dominant query load. The
// ingester resolves several competitions in parallel, so it must be safe for
// concurrent use.
type identityCache struct {
	mu    sync.RWMutex
	teams map[string]string // "source\x00sourceID" -> canonical team id
}

func newIdentityCache() *identityCache {
	return &identityCache{teams: make(map[string]string)}
}

func (c *identityCache) get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	id, ok := c.teams[key]
	return id, ok
}

func (c *identityCache) put(key, id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.teams[key] = id
}

func cacheKey(source, sourceID string) string { return source + "\x00" + sourceID }

// Team resolves a provider team id to a canonical team id, creating a
// provisional team on a miss so ingestion never blocks on curation.
func (s *Store) Team(ctx context.Context, source string, ref TeamRef) (string, error) {
	if ref.SourceID == "" {
		return "", fmt.Errorf("team ref has no source id")
	}
	key := cacheKey(source, ref.SourceID)
	if id, ok := s.identity.get(key); ok {
		return id, nil
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var teamID string
	err := s.pool.QueryRow(opCtx,
		`SELECT team_id FROM team_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&teamID)
	if err == nil {
		s.identity.put(key, teamID)
		return teamID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	teamID, err = s.createProvisionalTeam(opCtx, source, ref)
	if err != nil {
		return "", err
	}
	s.identity.put(key, teamID)
	return teamID, nil
}

// createProvisionalTeam mints a deterministic slug for an uncurated team. The
// slug encodes the source and its id so the same unknown team always lands on
// the same row, and so the review list shows where it came from.
func (s *Store) createProvisionalTeam(ctx context.Context, source string, ref TeamRef) (string, error) {
	kind := ref.Kind
	if kind != "national" {
		kind = "club"
	}
	name := ref.Name
	if name == "" {
		name = "Unknown " + source + " team " + ref.SourceID
	}
	slug := fmt.Sprintf("prov-%s-%s", source, ref.SourceID)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr, provisional, updated_at)
VALUES ($1, $2, $3, $4, true, now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
		slug, kind, name, ref.Abbr,
	); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, teamRefUpsertSQL, source, ref.SourceID, slug); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return slug, nil
}

// Competition resolves a provider competition id via the crosswalk. Unlike
// teams, a miss is an error: the set is closed and configured.
func (s *Store) Competition(ctx context.Context, source, sourceID string) (string, error) {
	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	var id string
	err := s.pool.QueryRow(opCtx,
		`SELECT competition_id FROM competition_external_ref WHERE source=$1 AND source_id=$2`,
		source, sourceID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("%w: %s/%s", ErrUnknownCompetition, source, sourceID)
	}
	return id, err
}
