package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func mustParticipationMatch(t *testing.T, store *Store, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID, err := store.Match(context.Background(), "espn", MatchRef{
		SourceID:      "401",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	return matchID
}

func sampleParticipation() *model.MatchParticipation {
	nine := 9
	part := &model.MatchParticipation{
		EventsPresent:    true,
		HomeTeamSourceID: "359",
		AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{
			{SourceID: "p1", Name: "Bukayo Saka", Number: &nine, Position: "F", Starter: true},
			{SourceID: "p2", Name: "Reserve Keeper", Position: "G", Starter: false},
		},
		Away: []model.SquadPlayer{
			{SourceID: "p3", Name: "Cole Palmer", Position: "M", Starter: true},
		},
		Events: []model.PlayerEvent{
			{TeamSourceID: "359", PlayerSourceID: "p1", PlayerName: "Bukayo Saka",
				Type: model.PlayerEventGoal, Minute: "23'", Detail: "Goal"},
			{TeamSourceID: "363", PlayerSourceID: "p3", PlayerName: "Cole Palmer",
				Type: model.PlayerEventYellow, Minute: "55'", Detail: "Yellow Card"},
		},
	}
	for i := 0; i < 10; i++ {
		part.Home = append(part.Home, model.SquadPlayer{SourceID: fmt.Sprintf("home-starter-%d", i), Name: fmt.Sprintf("Home Starter %d", i), Starter: true})
		part.Away = append(part.Away, model.SquadPlayer{SourceID: fmt.Sprintf("away-starter-%d", i), Name: fmt.Sprintf("Away Starter %d", i), Starter: true})
	}
	return part

}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestWriteParticipationRecordsSquadAndEvents(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	stats, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", sampleParticipation())
	if err != nil {
		t.Fatalf("WriteParticipation: %v", err)
	}
	if stats.Appearances != 23 || stats.Events != 2 {
		t.Errorf("stats = %+v, want 23 appearances / 2 events", stats)
	}

	// The substitute must be recorded — that is the whole point of reading the
	// squad rather than the starting XI.
	if n := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1 AND NOT starter`, matchID); n != 1 {
		t.Errorf("expected 1 non-starter appearance, got %d", n)
	}
	// A player's team comes from their appearance, not from `player`.
	if n := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1 AND team_id='eng-chelsea'`, matchID); n != 11 {
		t.Errorf("expected 11 Chelsea appearances, got %d", n)
	}
	// The goal must belong to a person, not a string.
	var scorer string
	if err := pool.QueryRow(ctx, `
SELECT p.full_name FROM match_event e JOIN player p ON p.id = e.player_id
WHERE e.match_id=$1 AND e.type='goal'`, matchID).Scan(&scorer); err != nil {
		t.Fatal(err)
	}
	if scorer != "Bukayo Saka" {
		t.Errorf("goal resolved to %q, want Bukayo Saka", scorer)
	}
}

// A live match is re-fetched repeatedly. Re-ingesting the same summary must not
// multiply goals, and must not churn canonical player ids.
func TestWriteParticipationIsIdempotent(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}
	var firstPlayerID uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT player_id FROM player_external_ref WHERE source='espn' AND source_id='p1'`,
	).Scan(&firstPlayerID); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 3; i++ {
		if _, err := store.WriteParticipation(ctx, "espn", matchID,
			"eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
			t.Fatalf("re-ingest %d: %v", i, err)
		}
	}

	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); n != 2 {
		t.Errorf("re-ingest multiplied events: got %d, want 2", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); n != 23 {
		t.Errorf("re-ingest multiplied appearances: got %d, want 23", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM player`); n != 23 {
		t.Errorf("re-ingest split canonical players: got %d, want 23", n)
	}
	var again uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT player_id FROM player_external_ref WHERE source='espn' AND source_id='p1'`,
	).Scan(&again); err != nil {
		t.Fatal(err)
	}
	if again != firstPlayerID {
		t.Errorf("canonical player id churned: %s -> %s", firstPlayerID, again)
	}
}

// ESPN retracting a mis-attributed goal must remove it, not leave a phantom.
func TestWriteParticipationDropsRetractedEvents(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}

	shrunk := sampleParticipation()
	shrunk.Events = shrunk.Events[:1]
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", shrunk); err != nil {
		t.Fatal(err)
	}

	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); n != 1 {
		t.Errorf("retracted event survived: got %d rows, want 1", n)
	}

	// And a player dropped from a corrected roster loses their appearance.
	shrunk.Home = append(shrunk.Home[:1], shrunk.Home[2:]...)
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", shrunk); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); n != 22 {
		t.Errorf("dropped squad member survived: got %d appearances, want 22", n)
	}
}

// A transient upstream blip returning no rosters must not be read as "this
// match now has nobody in it" — the same failure mode that once deleted curated
// teams on a failed fetch.
func TestWriteParticipationEmptyPayloadPreservesRows(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID, "eng-arsenal", "eng-chelsea",
		&model.MatchParticipation{HomeTeamSourceID: "359", AwayTeamSourceID: "363"}); err != nil {
		t.Fatal(err)
	}

	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); n != 23 {
		t.Errorf("empty payload destroyed appearances: got %d, want 23", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); n != 2 {
		t.Errorf("empty payload destroyed events: got %d, want 2", n)
	}
}

// Missing athlete ids leave events untouched and report incomplete coverage;
// ordinal event replacement is unsafe when the source omitted identities.
func TestWriteParticipationPreservesEventsWithoutAthleteIDs(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	part := sampleParticipation()
	for i := range part.Events {
		part.Events[i].PlayerSourceID = ""
	}
	for i := range part.Home {
		part.Home[i].SourceID = ""
	}

	stats, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", part)
	if err != nil {
		t.Fatalf("WriteParticipation: %v", err)
	}
	if stats.EventsUnidentified != 2 {
		t.Errorf("EventsUnidentified = %d, want 2", stats.EventsUnidentified)
	}
	if stats.SquadUnidentified != 12 {
		t.Errorf("SquadUnidentified = %d, want 12", stats.SquadUnidentified)
	}

	if n := countRows(t, pool,
		`SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); n != 0 {
		t.Errorf("expected incomplete event evidence to leave events unchanged, got %d", n)
	}
	// Critically: no player was invented from a display name.
	if n := countRows(t, pool, `SELECT count(*) FROM player`); n != 11 {
		t.Errorf("expected only the eleven away players to exist, got %d players", n)
	}
	// The coverage gap must be visible without reading logs.
	if n := countRows(t, pool,
		`SELECT count(*) FROM ingest_run WHERE kind='player_capture' AND ok IS FALSE`); n != 1 {
		t.Errorf("expected 1 coverage row, got %d", n)
	}
}

// In production the ingester is scorearc_ingester, not the schema owner. The
// replacement writes end in DELETEs; without `GRANT DELETE ON appearance,
// match_event` those raise 42501 and re-ingestion silently accumulates
// duplicates. Running as the owner would prove nothing.
func TestWriteParticipationAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, owner, pool)
	roleStore, roleName := newIngesterRoleStore(t, pool, dsn)

	if _, err := roleStore.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatalf("WriteParticipation as %s: %v", roleName, err)
	}

	shrunk := sampleParticipation()
	shrunk.Events = shrunk.Events[:1]
	shrunk.Home = append(shrunk.Home[:1], shrunk.Home[2:]...)
	if _, err := roleStore.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", shrunk); err != nil {
		t.Fatalf("shrinking write as %s: %v", roleName, err)
	}

	events := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, matchID)
	appearances := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID)
	t.Logf("as role %s: events=%d appearances=%d", roleName, events, appearances)
	if events != 1 {
		t.Errorf("as %s: retracted event survived, got %d events want 1", roleName, events)
	}
	if appearances != 22 {
		t.Errorf("as %s: dropped squad member survived, got %d want 22", roleName, appearances)
	}
}

// The numbers land on the row that already says the player was there.
func TestWriteParticipationStoresTheBoxScore(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	goals, shots, saves := 2, 5, 0
	part := &model.MatchParticipation{
		HomeTeamSourceID: "359", AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{{
			SourceID: "77", Name: "Striker", Position: "F", Starter: true,
			Stats: &model.PlayerMatchStats{Goals: &goals, Shots: &shots},
		}, {
			SourceID: "88", Name: "Keeper", Position: "G", Starter: true,
			Stats: &model.PlayerMatchStats{Saves: &saves},
		}},
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", part); err != nil {
		t.Fatalf("WriteParticipation: %v", err)
	}

	var storedGoals, storedShots *int
	var storedOffsides, storedSaves *int
	if err := pool.QueryRow(ctx, `
SELECT a.goals, a.shots, a.offsides, a.saves
FROM appearance a
JOIN player_external_ref r ON r.player_id = a.player_id
WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='77'`,
		matchID).Scan(&storedGoals, &storedShots, &storedOffsides, &storedSaves); err != nil {
		t.Fatal(err)
	}
	if storedGoals == nil || *storedGoals != 2 {
		t.Fatalf("goals = %v, want 2", storedGoals)
	}
	if storedShots == nil || *storedShots != 5 {
		t.Fatalf("shots = %v, want 5", storedShots)
	}
	// The whole rule: not measured stays NULL, and never becomes 0.
	if storedOffsides != nil {
		t.Fatalf("offsides = %d, want NULL -- it was never measured", *storedOffsides)
	}
	if storedSaves != nil {
		t.Fatalf("saves = %d on an outfielder, want NULL", *storedSaves)
	}

	var keeperSaves *int
	if err := pool.QueryRow(ctx, `
SELECT a.saves FROM appearance a
JOIN player_external_ref r ON r.player_id = a.player_id
WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='88'`,
		matchID).Scan(&keeperSaves); err != nil {
		t.Fatal(err)
	}
	// A measured zero is a measurement.
	if keeperSaves == nil || *keeperSaves != 0 {
		t.Fatalf("keeper saves = %v, want a measured 0", keeperSaves)
	}
}

// A live match is re-polled every 20 seconds and the numbers climb. Later must
// win, or the box score freezes at the first minute of the match.
func TestWriteParticipationUpdatesAClimbingBoxScore(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	write := func(goals int) {
		t.Helper()
		g := goals
		part := sampleParticipation()
		part.Home[0].Stats = &model.PlayerMatchStats{Goals: &g}
		if _, err := store.WriteParticipation(ctx, "espn", matchID,
			"eng-arsenal", "eng-chelsea", part); err != nil {
			t.Fatal(err)
		}
	}
	write(1)
	write(3)

	var goals *int
	if err := pool.QueryRow(ctx,
		`SELECT a.goals FROM appearance a JOIN player_external_ref r ON r.player_id=a.player_id WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='p1'`, matchID).Scan(&goals); err != nil {
		t.Fatal(err)
	}
	if goals == nil || *goals != 3 {
		t.Fatalf("goals = %v, want the later observation 3", goals)
	}
}

// A poll that comes back with a roster but NO stats block must not erase
// numbers an earlier poll established. Absence of evidence only -- the same
// rule WriteParticipation already applies to an empty payload.
func TestWriteParticipationKeepsStatsWhenAPollOmitsThem(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	goals := 2
	withStats := &model.MatchParticipation{
		HomeTeamSourceID: "359", AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{{
			SourceID: "77", Name: "Striker", Position: "F", Starter: true,
			Stats: &model.PlayerMatchStats{Goals: &goals},
		}},
	}
	withoutStats := &model.MatchParticipation{
		HomeTeamSourceID: "359", AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{{
			SourceID: "77", Name: "Striker", Position: "F", Starter: true,
		}},
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", withStats); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", withoutStats); err != nil {
		t.Fatal(err)
	}

	var stored *int
	if err := pool.QueryRow(ctx,
		`SELECT goals FROM appearance WHERE match_id=$1`, matchID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == nil || *stored != 2 {
		t.Fatalf("goals = %v after a statless poll, want the earlier 2 preserved", stored)
	}
}

// The live path: the same roster, polled again, must cost nothing. The stats
// block is deliberately absent on the second poll -- ESPN does that, and the
// COALESCE in the upsert exists because of it. Absent stats mean "unchanged",
// so the whole write must be a no-op, not 44 rewrites that store the same
// numbers.
func TestWriteParticipationIsANoOpWhenTheRosterIsUnchanged(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	scored := 1
	withStats := sampleParticipation()
	withStats.Home[0].Stats = &model.PlayerMatchStats{Goals: &scored}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", withStats); err != nil {
		t.Fatal(err)
	}
	before := tupleVersions(t, pool,
		`SELECT xmin::text FROM appearance WHERE match_id=$1 ORDER BY player_id`, matchID)

	// Second poll: identical squad, no stats block at all.
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}
	after := tupleVersions(t, pool,
		`SELECT xmin::text FROM appearance WHERE match_id=$1 ORDER BY player_id`, matchID)

	if len(before) != len(after) {
		t.Fatalf("appearances = %d, want %d", len(after), len(before))
	}
	for index := range before {
		if before[index] != after[index] {
			t.Fatalf("appearance %d was rewritten (xmin %s -> %s) by an unchanged poll",
				index, before[index], after[index])
		}
	}
	// And the number the first poll established survived the stats-less one.
	if goals := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1 AND goals=1`, matchID); goals != 1 {
		t.Fatalf("a stats-less poll erased an established number (rows with goals=1: %d)", goals)
	}
}

// Two roster entries can resolve to one canonical player -- the crosswalk
// allows it and a merged duplicate produces it. A repeated key in the source
// of a set-based upsert raises SQLSTATE 21000 and would fail the whole match's
// participation write.
func TestWriteParticipationToleratesADuplicatePlayer(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	part := sampleParticipation()
	twin := part.Home[0]
	twin.Starter = false
	part.Home = append(part.Home, twin)

	stats, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", part)
	if err != nil {
		t.Fatalf("a duplicate player failed the whole write: %v", err)
	}
	if stats.Appearances != 23 {
		t.Fatalf("appearances = %d, want 23 distinct players", stats.Appearances)
	}
	var starter bool
	if err := pool.QueryRow(ctx, `
SELECT a.starter FROM appearance a
JOIN player_external_ref r ON r.player_id = a.player_id
WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='p1'`, matchID).Scan(&starter); err != nil {
		t.Fatal(err)
	}
	if starter {
		t.Fatal("the last occurrence did not win")
	}
}

func tupleVersions(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var versions []string
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return versions
}

// The coverage report exists to raise a gap where a human can find it. Raising
// it 360 times for one live match buries the signal it exists to carry, so it
// is written only when the poll actually changed something.
func TestParticipationCoverageIsReportedOncePerChange(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	part := sampleParticipation()
	// An event whose athlete id the provider omitted: recorded, unidentified.
	part.Events = append(part.Events, model.PlayerEvent{
		TeamSourceID: "359", PlayerName: "", Type: model.PlayerEventYellow,
		Minute: "70'", Detail: "Yellow Card",
	})

	for range 4 {
		if _, err := store.WriteParticipation(ctx, "espn", matchID,
			"eng-arsenal", "eng-chelsea", part); err != nil {
			t.Fatal(err)
		}
	}

	reported := countRows(t, pool,
		`SELECT count(*) FROM ingest_run WHERE kind='player_capture'`)
	if reported != 1 {
		t.Fatalf("player_capture audit rows = %d after four identical polls, want 1", reported)
	}
}

func TestWriteParticipationPreservesFactsOnPartialOrUnresolvedInput(t *testing.T) {
	st, pool := newIntegrationStore(t)
	id := mustParticipationMatch(t, st, pool)
	ctx := context.Background()
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}
	partial := sampleParticipation()
	partial.Home = partial.Home[:1]
	partial.Away = nil
	partial.Events = partial.Events[:1]
	partial.Events[0].PlayerSourceID = ""
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", partial); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 23 {
		t.Fatalf("partial roster pruned facts: %d", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1 AND player_id IS NOT NULL`, id); n != 2 {
		t.Fatalf("partial events erased identity/facts: %d", n)
	}
	unresolved := sampleParticipation()
	unresolved.Home[0].SourceID = "new-player"
	if _, err := pool.Exec(ctx, `ALTER TABLE player ADD CONSTRAINT injected_failure CHECK (false) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", unresolved); err == nil {
		t.Fatal("resolution error silently reported success")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 23 {
		t.Fatal("unresolved input pruned valid facts")
	}
}

func TestWriteParticipationPartialIdentifiedRostersCannotPrune(t *testing.T) {
	st, pool := newIntegrationStore(t)
	id := mustParticipationMatch(t, st, pool)
	ctx := context.Background()
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}
	partial := sampleParticipation()
	partial.Home = partial.Home[:len(partial.Home)-1]
	partial.Away = partial.Away[:len(partial.Away)-1]
	partial.Events = partial.Events[:1]
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", partial); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 23 {
		t.Fatalf("partial identified roster erased appearances: %d", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, id); n != 2 {
		t.Fatalf("partial identified roster rewrote ordinal events: %d", n)
	}
}

func TestWriteParticipationPartialInputPreservesAppearanceFields(t *testing.T) {
	st, pool := newIntegrationStore(t)
	id := mustParticipationMatch(t, st, pool)
	ctx := context.Background()
	full := sampleParticipation()
	goals := 2
	full.Home[0].Stats = &model.PlayerMatchStats{Goals: &goals}
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", full); err != nil {
		t.Fatal(err)
	}
	partial := sampleParticipation()
	partial.Home = partial.Home[:1]
	partial.Away = partial.Away[:1]
	changed := &partial.Home[0]
	changed.Starter = false
	changed.Number = nil
	changed.Position = ""
	wrongGoals := 9
	changed.Stats = &model.PlayerMatchStats{Goals: &wrongGoals}
	if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", partial); err != nil {
		t.Fatal(err)
	}
	var starter bool
	var number, storedGoals *int
	var position *string
	if err := pool.QueryRow(ctx, `SELECT a.starter,a.shirt_number,a.position,a.goals FROM appearance a JOIN player_external_ref r ON r.player_id=a.player_id WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='p1'`, id).Scan(&starter, &number, &position, &storedGoals); err != nil {
		t.Fatal(err)
	}
	if !starter || number == nil || *number != 9 || position == nil || *position != "F" || storedGoals == nil || *storedGoals != 2 {
		t.Fatalf("partial input replaced established fields: starter=%v number=%v position=%v goals=%v", starter, number, position, storedGoals)
	}
}

func TestWriteParticipationPreservesFactsWhenEventsContradictRosters(t *testing.T) {
	st, pool := newIntegrationStore(t)
	id := mustParticipationMatch(t, st, pool)
	ctx := context.Background()
	for _, tc := range []struct {
		name, eventType, player string
		omit                    bool
	}{
		{"omitted scorer", model.PlayerEventGoal, "p2", true},
		{"omitted substitute on", model.PlayerEventSubOn, "p2", true},
		{"omitted substitute off", model.PlayerEventSubOff, "p2", true},
		{"opposition scorer", model.PlayerEventGoal, "p3", false},
		{"opposition substitute on", model.PlayerEventSubOn, "p3", false},
		{"opposition substitute off", model.PlayerEventSubOff, "p3", false},
		{"opposition yellow", model.PlayerEventYellow, "p3", false},
		{"opposition red", model.PlayerEventRed, "p3", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prior := sampleParticipation()
			prior.Events = append(prior.Events, model.PlayerEvent{Type: model.PlayerEventSubOn, TeamSourceID: "359", PlayerSourceID: "p2", PlayerName: "Reserve Keeper", Minute: "60"})
			if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", prior); err != nil {
				t.Fatal(err)
			}
			partial := sampleParticipation()
			if tc.omit {
				partial.Home = append(partial.Home[:1], partial.Home[2:]...)
			}
			partial.Events = []model.PlayerEvent{{Type: tc.eventType, TeamSourceID: "359", PlayerSourceID: tc.player, PlayerName: "Identified player", Minute: "70"}}
			if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", partial); err != nil {
				t.Fatal(err)
			}
			if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 23 {
				t.Fatalf("contradictory event pruned known appearance: %d", n)
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, id); n != 3 {
				t.Fatalf("contradictory event replaced known ordinal history: %d", n)
			}
		})
	}
}
