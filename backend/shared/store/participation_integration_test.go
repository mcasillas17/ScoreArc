package store

import (
	"context"
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
	return &model.MatchParticipation{
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
	if stats.Appearances != 3 || stats.Events != 2 {
		t.Errorf("stats = %+v, want 3 appearances / 2 events", stats)
	}

	// The substitute must be recorded — that is the whole point of reading the
	// squad rather than the starting XI.
	if n := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1 AND NOT starter`, matchID); n != 1 {
		t.Errorf("expected 1 non-starter appearance, got %d", n)
	}
	// A player's team comes from their appearance, not from `player`.
	if n := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1 AND team_id='eng-chelsea'`, matchID); n != 1 {
		t.Errorf("expected 1 Chelsea appearance, got %d", n)
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
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); n != 3 {
		t.Errorf("re-ingest multiplied appearances: got %d, want 3", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM player`); n != 3 {
		t.Errorf("re-ingest split canonical players: got %d, want 3", n)
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
	shrunk.Home = shrunk.Home[:1]
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", shrunk); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); n != 2 {
		t.Errorf("dropped squad member survived: got %d appearances, want 2", n)
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

	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); n != 3 {
		t.Errorf("empty payload destroyed appearances: got %d, want 3", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); n != 2 {
		t.Errorf("empty payload destroyed events: got %d, want 2", n)
	}
}

// A provider that omits athlete ids must still record the events, with the
// person unknown — and must say so, or total capture failure is
// indistinguishable from a match where nothing happened.
func TestWriteParticipationDegradesWithoutAthleteIDs(t *testing.T) {
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
	if stats.SquadUnidentified != 2 {
		t.Errorf("SquadUnidentified = %d, want 2", stats.SquadUnidentified)
	}

	if n := countRows(t, pool,
		`SELECT count(*) FROM match_event WHERE match_id=$1 AND player_id IS NULL`, matchID); n != 2 {
		t.Errorf("expected 2 unidentified events, got %d", n)
	}
	// Critically: no player was invented from a display name.
	if n := countRows(t, pool, `SELECT count(*) FROM player`); n != 1 {
		t.Errorf("expected only the away player to exist, got %d players", n)
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
	shrunk.Home = shrunk.Home[:1]
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
	if appearances != 2 {
		t.Errorf("as %s: dropped squad member survived, got %d want 2", roleName, appearances)
	}
}
