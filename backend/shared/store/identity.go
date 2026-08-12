package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
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

// MatchRef is a provider-scoped match identity. The canonical natural key is
// (competition, season, home, away, kickoff DATE) — deliberately date-grained,
// because sources routinely disagree on kickoff time by minutes.
type MatchRef struct {
	SourceID      string
	CompetitionID string
	SeasonID      string
	HomeTeamID    string
	AwayTeamID    string
	Kickoff       time.Time
}

// Match resolves a provider match to a canonical match id. On a crosswalk miss
// it upserts against the natural key, so a fixture already ingested from
// another source is adopted rather than duplicated.
func (s *Store) Match(ctx context.Context, source string, ref MatchRef) (uuid.UUID, error) {
	if ref.SourceID == "" {
		return uuid.Nil, fmt.Errorf("match ref has no source id")
	}
	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var matchID uuid.UUID
	err := s.pool.QueryRow(opCtx,
		`SELECT match_id FROM match_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&matchID)
	if err == nil {
		return matchID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}

	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(opCtx)

	// Adopt an existing match on the natural key if one is already there.
	err = tx.QueryRow(opCtx, `
SELECT id FROM match
WHERE competition_id=$1 AND season_id=$2 AND home_team_id=$3 AND away_team_id=$4
	AND kickoff_date=($5 AT TIME ZONE 'UTC')::date`,
		ref.CompetitionID, ref.SeasonID, ref.HomeTeamID, ref.AwayTeamID, ref.Kickoff,
	).Scan(&matchID)
	if errors.Is(err, pgx.ErrNoRows) {
		matchID, err = uuid.NewV7()
		if err != nil {
			return uuid.Nil, err
		}
		if _, err := tx.Exec(opCtx, `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, source, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,now())`,
			matchID, ref.CompetitionID, ref.SeasonID, ref.HomeTeamID, ref.AwayTeamID,
			ref.Kickoff, source,
		); err != nil {
			return uuid.Nil, err
		}
	} else if err != nil {
		return uuid.Nil, err
	}

	if _, err := tx.Exec(opCtx, `
INSERT INTO match_external_ref (source, source_id, match_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	match_id = EXCLUDED.match_id, last_seen_at = now()`,
		source, ref.SourceID, matchID,
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(opCtx); err != nil {
		return uuid.Nil, err
	}
	return matchID, nil
}

// PlayerRef is a provider-scoped player identity. Cross-source merging (the
// same human from two providers) is deliberately NOT attempted here: names
// collide, change with accents, and follow transfers. Two sources yield two
// canonical players until a merge step exists.
type PlayerRef struct {
	SourceID    string
	FullName    string
	KnownAs     string
	Nationality string
	Position    string
}

// Player resolves a provider player id to a canonical player id, creating the
// player on a miss.
func (s *Store) Player(ctx context.Context, source string, ref PlayerRef) (uuid.UUID, error) {
	if ref.SourceID == "" {
		return uuid.Nil, fmt.Errorf("player ref has no source id")
	}
	if ref.FullName == "" {
		return uuid.Nil, fmt.Errorf("player ref %s/%s has no name", source, ref.SourceID)
	}
	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var playerID uuid.UUID
	err := s.pool.QueryRow(opCtx,
		`SELECT player_id FROM player_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&playerID)
	if err == nil {
		return playerID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}

	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(opCtx)

	playerID, err = uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(opCtx, `
INSERT INTO player (id, full_name, known_as, nationality, position, updated_at)
VALUES ($1,$2,$3,$4,$5,now())`,
		playerID, ref.FullName, nullIfEmpty(ref.KnownAs),
		nullIfEmpty(ref.Nationality), nullIfEmpty(ref.Position),
	); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(opCtx, `
INSERT INTO player_external_ref (source, source_id, player_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	player_id = EXCLUDED.player_id, last_seen_at = now()`,
		source, ref.SourceID, playerID,
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(opCtx); err != nil {
		return uuid.Nil, err
	}
	return playerID, nil
}
