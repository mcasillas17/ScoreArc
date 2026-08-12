package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrUnknownCompetition means a source referenced a competition that is not in
// our configured registry. Competitions are a closed, configured set, so this
// is a configuration bug rather than upstream drift.
var ErrUnknownCompetition = errors.New("unknown competition for source")

// uniqueViolation is Postgres' SQLSTATE for a unique constraint breach. Two
// writers resolving the same entity at once is a normal, expected race here,
// not a fault: the loser re-reads and adopts the winner.
const uniqueViolation = "23505"

// maxIdentityAttempts bounds the adopt-retry loop. Each retry only runs after a
// competing writer committed, so one retry is enough in practice; the extra
// attempt is slack for a three-way race.
const maxIdentityAttempts = 3

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolation
}

// rollback releases a transaction using a context detached from the caller's.
// A rollback triggered BY a timeout would otherwise be handed an already-dead
// context and leave the transaction dangling until the connection is reaped.
func rollback(ctx context.Context, tx pgx.Tx) {
	rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(rollbackCtx)
}

// TeamRef is a provider-scoped team identity plus the hints needed to create a
// usable provisional row and to make the review list legible.
type TeamRef struct {
	SourceID string
	Name     string
	Abbr     string
	Kind     string // "club" | "national"; defaults to "club" when empty
}

// identityCache memoises crosswalk hits for the two closed-ish sets, teams and
// competitions (spec §5.3). Roughly 200 entries, and every match resolves two
// teams and a competition, so this removes the dominant query load. The
// ingester resolves several competitions in parallel, so it must be safe for
// concurrent use.
type identityCache struct {
	mu    sync.RWMutex
	teams map[string]string // "source\x00sourceID" -> canonical team id
	comps map[string]string // "source\x00sourceID" -> canonical competition id
}

func newIdentityCache() *identityCache {
	return &identityCache{
		teams: make(map[string]string),
		comps: make(map[string]string),
	}
}

func (c *identityCache) getTeam(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	id, ok := c.teams[key]
	return id, ok
}

func (c *identityCache) putTeam(key, id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.teams[key] = id
}

func (c *identityCache) getCompetition(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	id, ok := c.comps[key]
	return id, ok
}

func (c *identityCache) putCompetition(key, id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.comps[key] = id
}

// reset drops every memoised mapping. Seeding repoints crosswalk rows —
// promoting a provisional team moves its source ids onto the curated row — so a
// long-lived process must forget what it learned before the repoint or it keeps
// writing the dead id. The cache re-warms within one ingest cycle.
func (c *identityCache) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.teams)
	clear(c.comps)
}

// cache returns the identity cache, initialising it on first use. Stores built
// as bare struct literals (tests, and any future constructor) would otherwise
// nil-panic on the first resolve.
func (s *Store) cache() *identityCache {
	s.identityOnce.Do(func() {
		if s.identity == nil {
			s.identity = newIdentityCache()
		}
	})
	return s.identity
}

func cacheKey(source, sourceID string) string { return source + "\x00" + sourceID }

// Team resolves a provider team id to a canonical team id, creating a
// provisional team on a miss so ingestion never blocks on curation.
func (s *Store) Team(ctx context.Context, source string, ref TeamRef) (string, error) {
	if ref.SourceID == "" {
		return "", fmt.Errorf("team ref has no source id")
	}
	key := cacheKey(source, ref.SourceID)
	if id, ok := s.cache().getTeam(key); ok {
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
		s.cache().putTeam(key, teamID)
		return teamID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	teamID, err = s.createProvisionalTeam(opCtx, source, ref)
	if err != nil {
		return "", err
	}
	s.cache().putTeam(key, teamID)
	return teamID, nil
}

// teamRefClaimSQL is the RESOLVER's crosswalk write. Unlike the seed's
// teamRefRepointSQL it LOSES the conflict on purpose: DO UPDATE (rather than DO
// NOTHING) so the statement always returns a row, and it returns the team_id
// that actually holds (source, source_id) — which may be a curated team put
// there by the seed, or another writer's row, not the provisional slug we are
// offering. Repointing here would revert curation to a placeholder we minted
// ourselves, with no error raised anywhere.
const teamRefClaimSQL = `
INSERT INTO team_external_ref (source, source_id, team_id, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, now(), now())
ON CONFLICT (source, source_id) DO UPDATE SET last_seen_at = now()
RETURNING team_id`

// createProvisionalTeam mints a deterministic slug for an uncurated team. The
// slug encodes the source and its id so the same unknown team always lands on
// the same row, and so the review list shows where it came from. That
// determinism is what converges two writers racing to create the SAME unknown
// team; the crosswalk's RETURNING is what arbitrates against a writer aiming
// somewhere else entirely, such as a seed curating this source id right now.
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
	defer rollback(ctx, tx)

	if _, err := tx.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr, provisional, updated_at)
VALUES ($1, $2, $3, $4, true, now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
		slug, kind, name, ref.Abbr,
	); err != nil {
		return "", err
	}
	var holder string
	if err := tx.QueryRow(ctx, teamRefClaimSQL, source, ref.SourceID, slug).Scan(&holder); err != nil {
		return "", err
	}
	if holder != slug {
		// Somebody — most likely the seed curating this club — already owns this
		// source id. Roll back, discarding the provisional row we were about to
		// create, and adopt theirs.
		return holder, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return slug, nil
}

// Competition resolves a provider competition id via the crosswalk. Unlike
// teams, a miss is an error: the set is closed and configured.
func (s *Store) Competition(ctx context.Context, source, sourceID string) (string, error) {
	key := cacheKey(source, sourceID)
	if id, ok := s.cache().getCompetition(key); ok {
		return id, nil
	}

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
	if err != nil {
		return "", err
	}
	s.cache().putCompetition(key, id)
	return id, nil
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
// it adopts an existing match on the natural key, so a fixture already ingested
// from another source is adopted rather than duplicated.
//
// Two writers can both miss the adopt-read and then race to insert. The natural
// key makes exactly one of them win; the loser retries, and its second
// adopt-read now sees the winner's row. Without the retry that loser would
// surface a bare constraint violation to the caller.
func (s *Store) Match(ctx context.Context, source string, ref MatchRef) (uuid.UUID, error) {
	if ref.SourceID == "" {
		return uuid.Nil, fmt.Errorf("match ref has no source id")
	}
	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var err error
	for range maxIdentityAttempts {
		var matchID uuid.UUID
		matchID, err = s.resolveMatch(opCtx, source, ref)
		if err == nil {
			return matchID, nil
		}
		if !isUniqueViolation(err) {
			return uuid.Nil, err
		}
	}
	return uuid.Nil, fmt.Errorf(
		"resolve match %s/%s after %d attempts: %w", source, ref.SourceID, maxIdentityAttempts, err)
}

func (s *Store) resolveMatch(ctx context.Context, source string, ref MatchRef) (uuid.UUID, error) {
	var matchID uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT match_id FROM match_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&matchID)
	if err == nil {
		return matchID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer rollback(ctx, tx)

	// Adopt an existing match on the natural key if one is already there.
	err = tx.QueryRow(ctx, `
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
		if _, err := tx.Exec(ctx, `
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

	if _, err := tx.Exec(ctx, `
INSERT INTO match_external_ref (source, source_id, match_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	match_id = EXCLUDED.match_id, last_seen_at = now()`,
		source, ref.SourceID, matchID,
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
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
//
// A player id is minted fresh, so unlike a provisional team two racing writers
// aim at DIFFERENT ids and nothing converges them. The crosswalk row is what
// arbitrates: its upsert RETURNS the id that actually holds (source, source_id),
// which is the winner's. A loser that finds someone else's id there abandons the
// player it just minted and adopts the winner. The alternative —
// `DO UPDATE SET player_id = EXCLUDED.player_id` — repoints the mapping at the
// loser and orphans the winner's row, silently splitting one human into N
// canonical players with no error raised.
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
	defer rollback(opCtx, tx)

	minted, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(opCtx, `
INSERT INTO player (id, full_name, known_as, nationality, position, updated_at)
VALUES ($1,$2,$3,$4,$5,now())`,
		minted, ref.FullName, nullIfEmpty(ref.KnownAs),
		nullIfEmpty(ref.Nationality), nullIfEmpty(ref.Position),
	); err != nil {
		return uuid.Nil, err
	}

	// DO UPDATE (not DO NOTHING) so the statement always returns a row: on a
	// conflict it returns the incumbent player_id rather than ours.
	var holder uuid.UUID
	if err := tx.QueryRow(opCtx, `
INSERT INTO player_external_ref (source, source_id, player_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET last_seen_at = now()
RETURNING player_id`,
		source, ref.SourceID, minted,
	).Scan(&holder); err != nil {
		return uuid.Nil, err
	}
	if holder != minted {
		// Someone else got there first. Roll back, discarding the player we
		// minted, and adopt theirs.
		return holder, nil
	}
	if err := tx.Commit(opCtx); err != nil {
		return uuid.Nil, err
	}
	return minted, nil
}
