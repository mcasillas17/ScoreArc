package store

import (
	"context"
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

// The seed runs in the ingester, and in production the ingester is
// scorearc_ingester — NOT the schema owner every other test here uses. Promotion
// ends by DELETEing the provisional team, so a missing DELETE grant makes
// curation permanently dead while ApplyTeamSeed still returns nil. Run the exact
// same promotion as that role: without `GRANT DELETE ON team`, this fails.
func TestApplyTeamSeedPromotesProvisionalTeamAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustProvisionalWithHistory(t, owner, pool)
	roleStore, roleName := newIngesterRoleStore(t, pool, dsn)

	if err := roleStore.ApplyTeamSeed(ctx, lutonSeed); err != nil {
		t.Fatalf("ApplyTeamSeed as %s: %v", roleName, err)
	}

	var provisionalLeft int
	var crosswalk, home string
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM team WHERE provisional`).Scan(&provisionalLeft); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM team_external_ref WHERE source='espn' AND source_id='9999'`,
	).Scan(&crosswalk); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT home_team_id FROM match`).Scan(&home); err != nil {
		t.Fatal(err)
	}

	// A promotion that could not complete must have left a failed ingest_run
	// row; a successful one must not.
	var failures int
	var recorded string
	if err := pool.QueryRow(ctx, `
SELECT count(*), COALESCE(max(error), '') FROM ingest_run
WHERE kind='team_promotion' AND ok IS FALSE`).Scan(&failures, &recorded); err != nil {
		t.Fatal(err)
	}
	t.Logf("as role %s: provisional rows left=%d crosswalk=%s match.home_team_id=%s blocked ingest_run rows=%d %s",
		roleName, provisionalLeft, crosswalk, home, failures, recorded)

	if provisionalLeft != 0 {
		t.Fatalf("provisional row survived curation run as %s: %d left (recorded failure: %s)",
			roleName, provisionalLeft, recorded)
	}
	if crosswalk != "eng-luton-town" || home != "eng-luton-town" {
		t.Fatalf("crosswalk=%s match.home_team_id=%s, want eng-luton-town", crosswalk, home)
	}
	if failures != 0 {
		t.Fatalf("a successful promotion recorded %d failures: %v", failures, recorded)
	}

	// The resolver in that same process must now hand out the curated id.
	id, err := roleStore.Team(ctx, "espn", TeamRef{SourceID: "9999", Name: "Luton Town", Abbr: "LUT"})
	if err != nil {
		t.Fatal(err)
	}
	if id != "eng-luton-town" {
		t.Fatalf("resolve after promotion = %q, want eng-luton-town", id)
	}
}

// Curating a club that has already played finished matches is the NORMAL
// lifecycle, not an exception: it is auto-created in August and curated in a
// later pass. The trigger carve-out exists so that promotion still works.
func TestApplyTeamSeedPromotesAcrossFinalizedMatches(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	provisional := mustProvisionalWithHistory(t, store, pool)
	if _, err := pool.Exec(ctx, `
UPDATE match SET state='finished', home_score=2, away_score=1, finalized_at=now()
WHERE home_team_id=$1`, provisional); err != nil {
		t.Fatal(err)
	}

	if err := store.ApplyTeamSeed(ctx, lutonSeed); err != nil {
		t.Fatalf("ApplyTeamSeed refused to curate across a finalized match: %v", err)
	}

	var home, winner string
	var homeScore, awayScore int
	var provisionalLeft int
	if err := pool.QueryRow(ctx,
		`SELECT home_team_id, winner_id, home_score, away_score FROM match`,
	).Scan(&home, &winner, &homeScore, &awayScore); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM team WHERE provisional`).Scan(&provisionalLeft); err != nil {
		t.Fatal(err)
	}
	t.Logf("finalized match after curation: home=%s winner=%s score=%d-%d provisional left=%d",
		home, winner, homeScore, awayScore, provisionalLeft)
	if home != "eng-luton-town" || winner != "eng-luton-town" || provisionalLeft != 0 {
		t.Fatalf("finalized match not repointed: home=%s winner=%s provisional=%d",
			home, winner, provisionalLeft)
	}
	// The RESULT is untouched — the carve-out moves pointers, not history.
	if homeScore != 2 || awayScore != 1 {
		t.Fatalf("score changed to %d-%d, want 2-1", homeScore, awayScore)
	}
}

// One team whose promotion cannot complete must not take the rest of the seed
// down with it. It keeps resolving through its provisional row — degraded, not
// down — and the next seed run retries.
func TestApplyTeamSeedIsolatesAFailedPromotion(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	// Blocked: the curated team ALREADY has the fixture the provisional team's
	// match would collide with on the natural key.
	blocked, err := store.Team(ctx, "espn", TeamRef{SourceID: "9999", Name: "Luton Town", Abbr: "LUT"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr) VALUES ('eng-luton-town','club','Luton Town','LUT')`); err != nil {
		t.Fatal(err)
	}
	kickoff := time.Date(2026, 9, 12, 14, 0, 0, 0, time.UTC)
	for _, home := range []string{blocked, "eng-luton-town"} {
		if _, err := pool.Exec(ctx, `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id, kickoff, state, source)
VALUES (gen_random_uuid(),'premier-league','2026-27',$1,'eng-chelsea',$2,'scheduled','espn')`,
			home, kickoff); err != nil {
			t.Fatal(err)
		}
	}

	// Promotable: an ordinary provisional team with no conflict.
	promotable, err := store.Team(ctx, "espn", TeamRef{SourceID: "8888", Name: "Burnley", Abbr: "BUR"})
	if err != nil {
		t.Fatal(err)
	}

	err = store.ApplyTeamSeed(ctx, []config.SeedTeam{
		{ID: "eng-luton-town", Kind: "club", Name: "Luton Town", Abbr: "LUT",
			Country: "eng", Refs: map[string]string{"espn": "9999"}},
		{ID: "eng-burnley", Kind: "club", Name: "Burnley", Abbr: "BUR",
			Country: "eng", Refs: map[string]string{"espn": "8888"}},
	})
	if err != nil {
		t.Fatalf("one blocked promotion failed the whole seed: %v", err)
	}

	var blockedRows, promotableRows, provisionalLeft int
	var blockedCrosswalk, promotableCrosswalk string
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team WHERE id=$1`, blocked).Scan(&blockedRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team WHERE id=$1`, promotable).Scan(&promotableRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team WHERE provisional`).Scan(&provisionalLeft); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM team_external_ref WHERE source='espn' AND source_id='9999'`).Scan(&blockedCrosswalk); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT team_id FROM team_external_ref WHERE source='espn' AND source_id='8888'`).Scan(&promotableCrosswalk); err != nil {
		t.Fatal(err)
	}
	t.Logf("blocked: rows=%d crosswalk=%s | promotable: rows=%d crosswalk=%s | provisional left=%d",
		blockedRows, blockedCrosswalk, promotableRows, promotableCrosswalk, provisionalLeft)

	// The blocked team is untouched and still serving.
	if blockedRows != 1 || blockedCrosswalk != blocked {
		t.Fatalf("blocked team was disturbed: rows=%d crosswalk=%s want 1 and %s",
			blockedRows, blockedCrosswalk, blocked)
	}
	// The promotable one went through.
	if promotableRows != 0 || promotableCrosswalk != "eng-burnley" {
		t.Fatalf("promotable team did not promote: rows=%d crosswalk=%s",
			promotableRows, promotableCrosswalk)
	}
	if provisionalLeft != 1 {
		t.Fatalf("provisional teams = %d, want exactly the blocked one", provisionalLeft)
	}

	// Degraded rather than down is the right call — but it must not be
	// invisible. The blocked promotion is an auditable failed run, not just a
	// log line nobody reads.
	var failures int
	var recorded string
	if err := pool.QueryRow(ctx, `
SELECT count(*), COALESCE(max(error), '') FROM ingest_run
WHERE kind='team_promotion' AND ok IS FALSE`).Scan(&failures, &recorded); err != nil {
		t.Fatal(err)
	}
	t.Logf("blocked promotion recorded %d failed ingest_run row(s): %s", failures, recorded)
	if failures != 1 {
		t.Fatalf("blocked promotions recorded = %d, want 1", failures)
	}
	if !strings.Contains(recorded, blocked) || !strings.Contains(recorded, "eng-luton-town") {
		t.Fatalf("recorded failure %q names neither end of the promotion", recorded)
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
