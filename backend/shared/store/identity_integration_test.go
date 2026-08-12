package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

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
	return store, pool
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
