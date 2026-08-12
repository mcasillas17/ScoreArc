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
