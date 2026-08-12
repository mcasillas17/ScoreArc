package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

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

func TestApplyCompetitionSeedPopulatesSeasonsAndRefs(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	for range 2 { // idempotent
		if err := store.ApplyCompetitionSeed(ctx, registry.List()); err != nil {
			t.Fatalf("ApplyCompetitionSeed: %v", err)
		}
	}

	var comps, seasons, refs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM competition`).Scan(&comps); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM season`).Scan(&seasons); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM competition_external_ref`).Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if comps != len(registry.List()) || refs != len(registry.List()) {
		t.Fatalf("comps=%d refs=%d, want %d each", comps, refs, len(registry.List()))
	}
	wantSeasons := 0
	for _, comp := range registry.List() {
		wantSeasons += len(comp.Seasons)
	}
	if seasons != wantSeasons {
		t.Fatalf("seasons = %d, want exactly the registry's %d", seasons, wantSeasons)
	}

	// The ESPN slug must resolve to our canonical competition id.
	id, err := store.Competition(ctx, "espn", "eng.1")
	if err != nil {
		t.Fatalf("Competition: %v", err)
	}
	if id != "premier-league" {
		t.Fatalf("resolved %q, want premier-league", id)
	}
}

// mustProvisionalWithHistory creates a provisional team via the resolver and
// hangs one match, one standing row, and one snapshot off it — every foreign
// key that must follow the team when it is later curated.
func mustProvisionalWithHistory(t *testing.T, store *Store, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	provisional, err := store.Team(ctx, "espn", TeamRef{
		SourceID: "9999", Name: "Luton Town", Abbr: "LUT",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Match(ctx, "espn", MatchRef{
		SourceID: "700", CompetitionID: "premier-league", SeasonID: "2026-27",
		HomeTeamID: provisional, AwayTeamID: "eng-chelsea",
		Kickoff: time.Date(2026, 9, 12, 14, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE match SET winner_id=$1 WHERE home_team_id=$1`, provisional); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO standing (competition_id, season_id, team_id, rank, source)
VALUES ('premier-league','2026-27',$1,17,'espn')`, provisional); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO standing_snapshot (competition_id, season_id, team_id, captured_at, rank, points, goal_difference, played)
VALUES ('premier-league','2026-27',$1, now(), 17, 12, -8, 10)`, provisional); err != nil {
		t.Fatal(err)
	}
	return provisional
}

var lutonSeed = []config.SeedTeam{
	{ID: "eng-luton-town", Kind: "club", Name: "Luton Town", Abbr: "LUT",
		Country: "eng", Refs: map[string]string{"espn": "9999"}},
}

// Curating a team that ESPN introduced between curation passes must MOVE its
// history onto the curated row and delete the provisional one. Leaving the
// provisional row behind is what lets a second source create a duplicate match.
func TestApplyTeamSeedPromotesProvisionalTeam(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	provisional := mustProvisionalWithHistory(t, store, pool)

	if err := store.ApplyTeamSeed(ctx, lutonSeed); err != nil {
		t.Fatalf("ApplyTeamSeed: %v", err)
	}

	var provisionalRows, provisionalLeft int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM team WHERE id=$1`, provisional).Scan(&provisionalRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM team WHERE provisional`).Scan(&provisionalLeft); err != nil {
		t.Fatal(err)
	}
	var home, winner, crosswalk, standing, snapshot string
	if err := pool.QueryRow(ctx,
		`SELECT home_team_id, winner_id FROM match`).Scan(&home, &winner); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM team_external_ref WHERE source='espn' AND source_id='9999'`,
	).Scan(&crosswalk); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM standing WHERE competition_id='premier-league'`).Scan(&standing); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM standing_snapshot`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	t.Logf("provisional rows left=%d (all provisional=%d) crosswalk=%s match.home_team_id=%s winner_id=%s standing=%s snapshot=%s",
		provisionalRows, provisionalLeft, crosswalk, home, winner, standing, snapshot)

	if provisionalRows != 0 || provisionalLeft != 0 {
		t.Fatalf("provisional row survived curation: id rows=%d, provisional total=%d",
			provisionalRows, provisionalLeft)
	}
	for label, got := range map[string]string{
		"crosswalk": crosswalk, "match.home_team_id": home, "match.winner_id": winner,
		"standing.team_id": standing, "standing_snapshot.team_id": snapshot,
	} {
		if got != "eng-luton-town" {
			t.Fatalf("%s = %q, want eng-luton-town", label, got)
		}
	}

	// The point of all of the above: a second source now lands on the SAME
	// match instead of forking a duplicate.
	second, err := store.Match(ctx, "football-data-uk", MatchRef{
		SourceID: "E0-2026-09-12-LUT-CHE", CompetitionID: "premier-league",
		SeasonID: "2026-27", HomeTeamID: "eng-luton-town", AwayTeamID: "eng-chelsea",
		Kickoff: time.Date(2026, 9, 12, 14, 30, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	var matches int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	var original string
	if err := pool.QueryRow(ctx,
		`SELECT match_id::text FROM match_external_ref WHERE source='espn'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	t.Logf("second-source resolve: same match=%v  total match rows=%d", second.String() == original, matches)
	if matches != 1 || second.String() != original {
		t.Fatalf("second source forked a duplicate: matches=%d same=%v", matches, second.String() == original)
	}
}

// Repointing a finalized match would breach the immutability guard, so
// promotion refuses loudly and names the rows a human has to deal with.
func TestApplyTeamSeedRefusesToPromoteAcrossFinalizedMatches(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	provisional := mustProvisionalWithHistory(t, store, pool)
	if _, err := pool.Exec(ctx,
		`UPDATE match SET state='finished', finalized_at=now() WHERE home_team_id=$1`,
		provisional); err != nil {
		t.Fatal(err)
	}

	err := store.ApplyTeamSeed(ctx, lutonSeed)
	t.Logf("ApplyTeamSeed error: %v", err)
	if !errors.Is(err, ErrPromotionBlocked) {
		t.Fatalf("error = %v, want ErrPromotionBlocked", err)
	}
	var matchID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM match`).Scan(&matchID); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(err.Error(), matchID) {
		t.Fatalf("error %q does not name the blocking match %s", err, matchID)
	}
	// The whole seed rolls back, so nothing is half-applied.
	var curated int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM team WHERE id='eng-luton-town'`).Scan(&curated); err != nil {
		t.Fatal(err)
	}
	if curated != 0 {
		t.Fatal("seed was partially applied despite the blocked promotion")
	}
}

// A process that resolved the provisional id keeps a warm mapping. Seeding
// repoints the crosswalk underneath it, so the seed must invalidate the cache.
func TestApplyTeamSeedInvalidatesTheIdentityCache(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustProvisionalWithHistory(t, store, pool) // warms the cache with prov-espn-9999

	if err := store.ApplyTeamSeed(ctx, lutonSeed); err != nil {
		t.Fatal(err)
	}
	id, err := store.Team(ctx, "espn", TeamRef{SourceID: "9999", Name: "Luton Town", Abbr: "LUT"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("cached resolve in the SAME process = %s", id)
	if id != "eng-luton-town" {
		t.Fatalf("resolve after seeding = %q, want eng-luton-town", id)
	}
}
