package store

import (
	"context"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestApplyTeamSeedIsIdempotent(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	seed := []config.SeedTeam{
		{ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
		{ID: "nat-mex", Kind: "national", Name: "Mexico", Abbr: "MEX",
			Country: "mex", Refs: map[string]string{"espn": "203"}},
	}

	for range 2 { // applying twice must not duplicate or error
		if err := store.ApplyTeamSeed(ctx, seed); err != nil {
			t.Fatalf("ApplyTeamSeed: %v", err)
		}
	}

	var teams, refs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team`).Scan(&teams); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team_external_ref`).Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if teams != 2 || refs != 2 {
		t.Fatalf("teams=%d refs=%d, want 2 and 2 after two applies", teams, refs)
	}

	// The seed must never mark a curated team provisional.
	var provisional bool
	if err := pool.QueryRow(ctx,
		`SELECT provisional FROM team WHERE id='eng-arsenal'`).Scan(&provisional); err != nil {
		t.Fatal(err)
	}
	if provisional {
		t.Fatal("seeded team was marked provisional")
	}

	// Re-seeding must refresh mutable fields.
	seed[0].Name = "Arsenal FC"
	if err := store.ApplyTeamSeed(ctx, seed); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := pool.QueryRow(ctx,
		`SELECT name FROM team WHERE id='eng-arsenal'`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Arsenal FC" {
		t.Fatalf("name = %q, want the re-seeded value", name)
	}
}
