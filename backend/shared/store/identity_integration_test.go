package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/mcasillas17/scorearc-backend/config"
)

// newIntegrationStore boots a throwaway Postgres, applies every migration in
// order, and returns a Store plus an admin pool for assertions.
func newIntegrationStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	store, pool, _ := newIntegrationStoreDSN(t)
	return store, pool
}

// newIntegrationStoreDSN is newIntegrationStore plus the container's DSN, which
// the least-privilege role tests need in order to connect as somebody else.
func newIntegrationStoreDSN(t *testing.T) (*Store, *pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("scorearc"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = container.Terminate(ctx) })

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	files, err := filepath.Glob(filepath.Join("..", "..", "migrations", "*.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("apply %s: %v", filepath.Base(file), err)
		}
	}

	store, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store, pool, dsn
}

func mustSeed(t *testing.T, store *Store) {
	t.Helper()
	if err := store.ApplyTeamSeed(context.Background(), []config.SeedTeam{
		{ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestResolveTeamHitsTheCrosswalk(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	id, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"})
	if err != nil {
		t.Fatalf("Team: %v", err)
	}
	if id != "eng-arsenal" {
		t.Fatalf("resolved %q, want the curated slug eng-arsenal", id)
	}
}

func TestResolveTeamCreatesProvisionalOnMiss(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	id, err := store.Team(ctx, "espn", TeamRef{
		SourceID: "99999", Name: "Newly Promoted FC", Abbr: "NPF",
	})
	if err != nil {
		t.Fatalf("Team: %v", err)
	}
	if !strings.HasPrefix(id, "prov-espn-") {
		t.Fatalf("provisional id = %q, want a prov-espn- prefix", id)
	}

	var name string
	var provisional bool
	if err := pool.QueryRow(ctx,
		`SELECT name, provisional FROM team WHERE id=$1`, id).Scan(&name, &provisional); err != nil {
		t.Fatal(err)
	}
	// The provider's real name must be carried so the site still renders.
	if name != "Newly Promoted FC" || !provisional {
		t.Fatalf("name=%q provisional=%v, want the real name and provisional=true", name, provisional)
	}

	// Resolving the same unknown team again must reuse the row, not create another.
	again, err := store.Team(ctx, "espn", TeamRef{SourceID: "99999", Name: "Newly Promoted FC", Abbr: "NPF"})
	if err != nil {
		t.Fatal(err)
	}
	if again != id {
		t.Fatalf("second resolve = %q, want the same provisional id %q", again, id)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team WHERE provisional`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("provisional teams = %d, want 1", count)
	}
}

func TestResolveTeamCachesLookups(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	if _, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"}); err != nil {
		t.Fatal(err)
	}
	// Deleting the crosswalk row proves the second lookup came from cache.
	if _, err := pool.Exec(ctx, `DELETE FROM team_external_ref WHERE source_id='359'`); err != nil {
		t.Fatal(err)
	}
	id, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"})
	if err != nil {
		t.Fatalf("cached lookup failed: %v", err)
	}
	if id != "eng-arsenal" {
		t.Fatalf("cached resolve = %q, want eng-arsenal", id)
	}
}

// The ingester resolves several competitions in parallel, so every goroutine
// shares one identity cache. Run under -race: an unsynchronised map here is a
// crash in production, not a slow path.
func TestResolveTeamIsSafeForConcurrentUse(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	const goroutines = 16
	var group sync.WaitGroup
	errs := make([]error, goroutines)
	ids := make([]string, goroutines)
	start := make(chan struct{})
	for worker := range goroutines {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			// Half hammer the curated hit, half mint provisional rows.
			ref := TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"}
			if worker%2 == 1 {
				ref = TeamRef{
					SourceID: fmt.Sprintf("9000%d", worker),
					Name:     fmt.Sprintf("Unknown %d FC", worker),
					Abbr:     "UNK",
				}
			}
			ids[worker], errs[worker] = store.Team(ctx, "espn", ref)
		}()
	}
	close(start)
	group.Wait()

	for worker, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", worker, err)
		}
		if worker%2 == 0 && ids[worker] != "eng-arsenal" {
			t.Fatalf("worker %d resolved %q, want eng-arsenal", worker, ids[worker])
		}
	}
	var provisional int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team WHERE provisional`).Scan(&provisional); err != nil {
		t.Fatal(err)
	}
	if provisional != goroutines/2 {
		t.Fatalf("provisional teams = %d, want %d", provisional, goroutines/2)
	}
}

// A resolver that misses the crosswalk must never take the mapping FROM whoever
// already holds it. The seed claiming espn/359 for eng-arsenal while the
// resolver is mid-miss is the live case: repointing would hand the club its own
// provisional placeholder back and silently revert curation. Driven as an
// explicit interleaving, like the player race, because releasing goroutines does
// not reliably produce one.
func TestResolveTeamAdoptsTheCuratedIncumbentInsteadOfRepointing(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	// The incumbent: a curated team claiming espn/359 in an in-flight
	// transaction, so the resolver's crosswalk SELECT still misses.
	if _, err := pool.Exec(ctx,
		`INSERT INTO team (id, kind, name, abbr) VALUES ('eng-arsenal','club','Arsenal','ARS')`,
	); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, `
INSERT INTO team_external_ref (source, source_id, team_id)
VALUES ('espn','359','eng-arsenal')`); err != nil {
		t.Fatal(err)
	}

	type result struct {
		id  string
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"})
		done <- result{id, err}
	}()
	waitForBlockedBackend(t, pool)

	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatalf("resolver returned an error: %v", got.err)
	}

	var crosswalk string
	var provisionalRows int
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM team_external_ref WHERE source='espn' AND source_id='359'`,
	).Scan(&crosswalk); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM team WHERE provisional`).Scan(&provisionalRows); err != nil {
		t.Fatal(err)
	}
	t.Logf("resolver returned=%s crosswalk=%s provisional rows left=%d",
		got.id, crosswalk, provisionalRows)

	if got.id != "eng-arsenal" {
		t.Fatalf("resolver returned its own %q, want the curated eng-arsenal", got.id)
	}
	if crosswalk != "eng-arsenal" {
		t.Fatalf("crosswalk was repointed to %q, want it left at eng-arsenal", crosswalk)
	}
	if provisionalRows != 0 {
		t.Fatalf("%d provisional row(s) left behind, want the minted one rolled back", provisionalRows)
	}
}

// The property this whole design exists to provide: the same fixture arriving
// from two different sources, with different provider ids and kickoff times
// minutes apart, must resolve to exactly ONE canonical match.
func TestResolveMatchIsDeterministicAcrossSources(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	first, err := store.Match(ctx, "espn", MatchRef{
		SourceID:      "401",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("first Match: %v", err)
	}

	// A different source, its own id, kickoff 15 minutes later.
	second, err := store.Match(ctx, "football-data-uk", MatchRef{
		SourceID:      "E0-2026-08-21-ARS-CHE",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 21, 19, 15, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("second Match: %v", err)
	}

	if first != second {
		t.Fatalf("resolved to two matches (%s, %s), want one", first, second)
	}
	var matches, refs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_external_ref`).Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if matches != 1 || refs != 2 {
		t.Fatalf("matches=%d refs=%d, want 1 match with 2 source refs", matches, refs)
	}

	// The resolver's adopt-path is a SELECT, so the assertions above still hold
	// if the natural-key UNIQUE were dropped from the schema — they would just
	// stop being guaranteed the moment two writers race. The constraint is the
	// backstop, so pin it directly: a third writer inserting the same fixture
	// behind the resolver's back, at a different time on the same date, must be
	// refused by the database.
	if _, err := pool.Exec(ctx, `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, source)
VALUES (gen_random_uuid(),'premier-league','2026-27','eng-arsenal','eng-chelsea',
	'2026-08-21T20:30:00Z','scheduled','rogue')`); err == nil {
		t.Fatal("a duplicate on the natural key was accepted; the UNIQUE constraint is missing")
	}
}

// Reversing home and away is a DIFFERENT fixture (the return leg), so it must
// resolve to its own match.
func TestResolveMatchTreatsReversedLegsAsDistinct(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	kickoff := time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC)
	home, err := store.Match(ctx, "espn", MatchRef{
		SourceID: "401", CompetitionID: "premier-league", SeasonID: "2026-27",
		HomeTeamID: "eng-arsenal", AwayTeamID: "eng-chelsea", Kickoff: kickoff,
	})
	if err != nil {
		t.Fatal(err)
	}
	away, err := store.Match(ctx, "espn", MatchRef{
		SourceID: "402", CompetitionID: "premier-league", SeasonID: "2026-27",
		HomeTeamID: "eng-chelsea", AwayTeamID: "eng-arsenal", Kickoff: kickoff,
	})
	if err != nil {
		t.Fatal(err)
	}
	if home == away {
		t.Fatal("reversed legs collapsed into one match")
	}
	var matches int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 2 {
		t.Fatalf("matches = %d, want 2", matches)
	}
}

func mustSeedTwoTeams(t *testing.T, store *Store) {
	t.Helper()
	if err := store.ApplyTeamSeed(context.Background(), []config.SeedTeam{
		{ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
		{ID: "eng-chelsea", Kind: "club", Name: "Chelsea", Abbr: "CHE",
			Country: "eng", Refs: map[string]string{"espn": "363"}},
	}); err != nil {
		t.Fatal(err)
	}
}

func mustSeedSeason(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
INSERT INTO competition (id, name, short_name, kind)
VALUES ('premier-league','Premier League','EPL','league')
ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO season (competition_id, id, label) VALUES ('premier-league','2026-27','2026-27')
ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
}

func TestResolvePlayerCreatesOnceAndReuses(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	first, err := store.Player(ctx, "espn", PlayerRef{SourceID: "253989", FullName: "Erling Haaland"})
	if err != nil {
		t.Fatalf("Player: %v", err)
	}
	second, err := store.Player(ctx, "espn", PlayerRef{SourceID: "253989", FullName: "Erling Haaland"})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("same source player resolved to %s then %s", first, second)
	}

	var players int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player`).Scan(&players); err != nil {
		t.Fatal(err)
	}
	if players != 1 {
		t.Fatalf("players = %d, want 1", players)
	}

	// A different source id is a different player until cross-source merging
	// exists — it must NOT be guessed by name.
	other, err := store.Player(ctx, "statsbomb", PlayerRef{SourceID: "sb-1", FullName: "Erling Haaland"})
	if err != nil {
		t.Fatal(err)
	}
	if other == first {
		t.Fatal("players from different sources were merged by name; merging is out of scope")
	}
}

func TestResolvePlayerRequiresSourceID(t *testing.T) {
	store, _ := newIntegrationStore(t)
	if _, err := store.Player(context.Background(), "espn", PlayerRef{FullName: "No Id"}); err == nil {
		t.Fatal("expected an error when the player ref has no source id")
	}
}

// A canonical player must never be split by concurrency. Every goroutine
// resolving one provider player must get ONE id, leave ONE player row, and
// leave no orphan player rows the crosswalk cannot name.
func TestResolvePlayerIsSafeForConcurrentUse(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	const goroutines = 8
	var group sync.WaitGroup
	ids := make([]uuid.UUID, goroutines)
	errs := make([]error, goroutines)
	start := make(chan struct{})
	for worker := range goroutines {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			ids[worker], errs[worker] = store.Player(ctx, "espn",
				PlayerRef{SourceID: "253989", FullName: "Erling Haaland"})
		}()
	}
	close(start)
	group.Wait()

	distinct := make(map[uuid.UUID]struct{}, goroutines)
	for worker, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", worker, err)
		}
		distinct[ids[worker]] = struct{}{}
	}

	var players, orphans int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player`).Scan(&players); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM player p
WHERE NOT EXISTS (SELECT 1 FROM player_external_ref r WHERE r.player_id = p.id)`,
	).Scan(&orphans); err != nil {
		t.Fatal(err)
	}
	t.Logf("callers=%d  distinct ids returned=%d  player rows=%d  orphan player rows=%d",
		goroutines, len(distinct), players, orphans)
	if len(distinct) != 1 || players != 1 || orphans != 0 {
		t.Fatalf("canonical identity split: distinct=%d players=%d orphans=%d, want 1/1/0",
			len(distinct), players, orphans)
	}
}

// waitForBlockedBackend polls until a backend is parked on a lock, which is how
// this file proves an interleaving actually happened rather than hoping the Go
// scheduler produced one.
func waitForBlockedBackend(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var blocked int
		if err := pool.QueryRow(ctx, `
SELECT count(*) FROM pg_stat_activity
WHERE wait_event_type = 'Lock' AND state = 'active'`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no backend ever blocked; the interleaving under test did not happen")
}

// The losing writer in a player race must ADOPT the winner rather than repoint
// the crosswalk at itself. Releasing N goroutines at once does not reliably
// interleave them, so this drives the exact interleaving: a transaction holds
// an uncommitted crosswalk row for the player, Player() blocks behind it, and
// the holder then commits.
func TestResolvePlayerAdoptsTheWinnerOfARace(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	// The winner: a player already claimed by an in-flight transaction.
	winner := uuid.MustParse("01890000-0000-7000-8000-000000000001")
	if _, err := pool.Exec(ctx,
		`INSERT INTO player (id, full_name) VALUES ($1,'Erling Haaland')`, winner); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, `
INSERT INTO player_external_ref (source, source_id, player_id)
VALUES ('espn','253989',$1)`, winner); err != nil {
		t.Fatal(err)
	}

	// The loser starts now, misses the crosswalk (the holder is uncommitted),
	// mints its own player, and then blocks on the crosswalk insert.
	type result struct {
		id  uuid.UUID
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := store.Player(ctx, "espn", PlayerRef{SourceID: "253989", FullName: "Erling Haaland"})
		done <- result{id, err}
	}()
	waitForBlockedBackend(t, pool)

	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatalf("loser returned an error: %v", got.err)
	}

	var players, orphans int
	var crosswalk uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player`).Scan(&players); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM player p
WHERE NOT EXISTS (SELECT 1 FROM player_external_ref r WHERE r.player_id = p.id)`,
	).Scan(&orphans); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT player_id FROM player_external_ref WHERE source='espn' AND source_id='253989'`,
	).Scan(&crosswalk); err != nil {
		t.Fatal(err)
	}
	t.Logf("returned=%v winner=%v crosswalk=%v player rows=%d orphan player rows=%d",
		got.id, winner, crosswalk, players, orphans)

	if got.id != winner {
		t.Fatalf("loser returned its own id %v, want the winner %v", got.id, winner)
	}
	if crosswalk != winner {
		t.Fatalf("crosswalk was repointed to %v, want it left at the winner %v", crosswalk, winner)
	}
	if players != 1 || orphans != 0 {
		t.Fatalf("player rows=%d orphans=%d, want 1 and 0", players, orphans)
	}
}

// Two writers can both miss the adopt-read and race to insert the same
// fixture. The natural key lets exactly one win; the loser must retry and adopt
// rather than surfacing a raw constraint violation. Driven as an explicit
// interleaving because releasing goroutines does not reliably produce one.
func TestResolveMatchAdoptsTheWinnerOfANaturalKeyRace(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	kickoff := time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC)
	winner := uuid.MustParse("01890000-0000-7000-8000-0000000000aa")

	// The winner holds the natural key in an uncommitted transaction.
	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, source)
VALUES ($1,'premier-league','2026-27','eng-arsenal','eng-chelsea',$2,'scheduled','espn')`,
		winner, kickoff); err != nil {
		t.Fatal(err)
	}

	// The loser misses the crosswalk AND the adopt-read, then blocks on insert.
	type result struct {
		id  uuid.UUID
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := store.Match(ctx, "football-data-uk", MatchRef{
			SourceID: "E0-2026-08-21-ARS-CHE", CompetitionID: "premier-league",
			SeasonID: "2026-27", HomeTeamID: "eng-arsenal", AwayTeamID: "eng-chelsea",
			Kickoff: kickoff.Add(15 * time.Minute),
		})
		done <- result{id, err}
	}()
	waitForBlockedBackend(t, pool)

	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done

	var matches int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	t.Logf("loser returned=%v err=%v winner=%v match rows=%d", got.id, got.err, winner, matches)
	if got.err != nil {
		t.Fatalf("loser surfaced a constraint violation instead of adopting: %v", got.err)
	}
	if got.id != winner {
		t.Fatalf("loser returned %v, want the winner %v", got.id, winner)
	}
	if matches != 1 {
		t.Fatalf("match rows = %d, want 1", matches)
	}
}

// Competitions are a closed, configured set, so a miss is a configuration bug
// and must be reported as one rather than auto-created.
func TestResolveCompetitionMissIsAnError(t *testing.T) {
	store, _ := newIntegrationStore(t)
	id, err := store.Competition(context.Background(), "espn", "not.a.league")
	if !errors.Is(err, ErrUnknownCompetition) {
		t.Fatalf("err = %v, want ErrUnknownCompetition", err)
	}
	if id != "" {
		t.Fatalf("id = %q, want empty on a miss", id)
	}
	if !strings.Contains(err.Error(), "not.a.league") {
		t.Fatalf("error %q does not name the offending source id", err)
	}
}

// Spec §5.3: team AND competition lookups are cached.
func TestResolveCompetitionCachesLookups(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedSeason(t, pool)
	if _, err := pool.Exec(ctx, `
INSERT INTO competition_external_ref (source, source_id, competition_id)
VALUES ('espn','eng.1','premier-league')`); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Competition(ctx, "espn", "eng.1"); err != nil {
		t.Fatal(err)
	}
	// Deleting the crosswalk row proves the second lookup came from cache.
	if _, err := pool.Exec(ctx, `DELETE FROM competition_external_ref`); err != nil {
		t.Fatal(err)
	}
	id, err := store.Competition(ctx, "espn", "eng.1")
	if err != nil {
		t.Fatalf("cached lookup failed: %v", err)
	}
	if id != "premier-league" {
		t.Fatalf("cached resolve = %q, want premier-league", id)
	}
}
