package store

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func playInt(value int) *int { return &value }

func playsFixture() []model.Play {
	x, y := 77.2, 25.0
	return []model.Play{
		{
			SourceID: "50929858", Seq: 0, TypeKey: "pass", TypeText: "Pass",
			TeamSourceID: "359", PlayerSourceID: "295847", Period: playInt(1),
		},
		{
			SourceID: "50929900", Seq: 1, TypeKey: "shot-on-target", TypeText: "Shot On Target",
			TeamSourceID: "359", PlayerSourceID: "295847", Period: playInt(1),
			Coordinates: &model.PlayCoordinates{StartX: &x, StartY: &y},
		},
		{
			SourceID: "50929999", Seq: 2, TypeKey: "goal", TypeText: "Goal",
			TeamSourceID: "359", PlayerSourceID: "999999", ScoringPlay: true,
			Period: playInt(2),
		},
	}
}

func mustSeedPlayMatch(t *testing.T, store *Store) uuid.UUID {
	t.Helper()
	matchID, err := store.Match(context.Background(), "espn", MatchRef{
		SourceID:      "401877018",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, time.August, 15, 18, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	return matchID
}

// Re-ingestion is an upsert on ESPN's play id, so a live match polled every
// 20s converges instead of accumulating.
func TestWritePlaysIsIdempotentOnTheProviderID(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, store)

	playerID, err := store.Player(ctx, "espn", PlayerRef{
		SourceID: "295847", FullName: "Federico Vinas",
	})
	if err != nil {
		t.Fatal(err)
	}
	teamIDs := map[string]string{"359": "eng-arsenal"}
	playerIDs := map[string]uuid.UUID{"295847": playerID}

	for range 3 {
		if _, err := store.WritePlays(ctx, matchID, playsFixture(), teamIDs, playerIDs); err != nil {
			t.Fatalf("WritePlays: %v", err)
		}
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_play`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 3 {
		t.Fatalf("stored %d rows after three writes of three plays, want 3", rows)
	}
}

// An athlete the squad sheet never mentioned must NOT mint a canonical player.
// Minting from the play stream would create a person per unrecognised ref,
// at ~1,500 refs a match, with no name to give them.
func TestWritePlaysLeavesAnUnknownAthleteUnattributed(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, store)

	playerID, err := store.Player(ctx, "espn", PlayerRef{
		SourceID: "295847", FullName: "Federico Vinas",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.WritePlays(ctx, matchID, playsFixture(),
		map[string]string{"359": "eng-arsenal"},
		map[string]uuid.UUID{"295847": playerID}); err != nil {
		t.Fatal(err)
	}

	var storedPlayer *uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT player_id FROM match_play WHERE source_id='50929999'`).Scan(&storedPlayer); err != nil {
		t.Fatal(err)
	}
	if storedPlayer != nil {
		t.Fatalf("player_id = %v for an unknown athlete, want NULL", storedPlayer)
	}
	var players int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player`).Scan(&players); err != nil {
		t.Fatal(err)
	}
	if players != 1 {
		t.Fatalf("player rows = %d, want 1 -- the stream minted a person", players)
	}
	// The play itself is still there. It happened.
	var goals int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_play WHERE scoring_play`).Scan(&goals); err != nil {
		t.Fatal(err)
	}
	if goals != 1 {
		t.Fatalf("scoring plays = %d, want 1 -- an unattributed goal must not be dropped", goals)
	}
}

func TestWritePlaysStoresCoordinatesAndMissingValues(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, store)

	if _, err := store.WritePlays(ctx, matchID, playsFixture(),
		map[string]string{"359": "eng-arsenal"}, map[string]uuid.UUID{}); err != nil {
		t.Fatal(err)
	}
	var x, y *float64
	if err := pool.QueryRow(ctx,
		`SELECT start_x, start_y FROM match_play WHERE source_id='50929900'`).Scan(&x, &y); err != nil {
		t.Fatal(err)
	}
	if x == nil || *x != 77.2 || y == nil || *y != 25 {
		t.Fatalf("coordinates = %v/%v, want 77.2/25", x, y)
	}
	// The pass has no location or numeric clock measurement. Both must remain
	// NULL rather than becoming a measured zero.
	var passX *float64
	var clockValue *int
	if err := pool.QueryRow(ctx,
		`SELECT start_x, clock_value FROM match_play WHERE source_id='50929858'`).
		Scan(&passX, &clockValue); err != nil {
		t.Fatal(err)
	}
	if passX != nil || clockValue != nil {
		t.Fatalf("unmeasured pass stored start_x/clock = %v/%v, want NULL/NULL",
			passX, clockValue)
	}
}

func TestWritePlaysCorrectionDoesNotEraseKnownIdentityOrGeometry(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, store)
	playerID, err := store.Player(ctx, "espn", PlayerRef{
		SourceID: "295847", FullName: "Federico Vinas",
	})
	if err != nil {
		t.Fatal(err)
	}

	shot := playsFixture()[1]
	if _, err := store.WritePlays(ctx, matchID, []model.Play{shot},
		map[string]string{"359": "eng-arsenal"},
		map[string]uuid.UUID{"295847": playerID}); err != nil {
		t.Fatal(err)
	}
	shot.TypeText = "Shot Corrected"
	shot.Coordinates = nil
	if _, err := store.WritePlays(ctx, matchID, []model.Play{shot},
		map[string]string{}, map[string]uuid.UUID{}); err != nil {
		t.Fatal(err)
	}

	var storedPlayer uuid.UUID
	var x *float64
	var text string
	if err := pool.QueryRow(ctx, `
SELECT player_id, start_x, type_text FROM match_play WHERE source_id='50929900'`).
		Scan(&storedPlayer, &x, &text); err != nil {
		t.Fatal(err)
	}
	if storedPlayer != playerID || x == nil || *x != 77.2 || text != "Shot Corrected" {
		t.Fatalf("corrected row player/x/text = %s/%v/%q", storedPlayer, x, text)
	}
}

func TestWritePlaysRollsBackTheWholeBatch(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, store)

	plays := playsFixture()[:2]
	plays[0].TeamSourceID = ""
	if _, err := store.WritePlays(ctx, matchID, plays,
		map[string]string{"359": "missing-team"}, map[string]uuid.UUID{}); err == nil {
		t.Fatal("want a foreign-key failure")
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_play`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("stored %d rows from a failed batch, want atomic rollback", rows)
	}
}

// One query for the whole match, not one per play.
func TestResolveKnownPlayersIsOneLookup(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()
	first, err := store.Player(ctx, "espn", PlayerRef{SourceID: "1", FullName: "One"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Player(ctx, "espn", PlayerRef{SourceID: "2", FullName: "Two"})
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := store.ResolveKnownPlayers(ctx, "espn", []string{"1", "2", "3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 2 || resolved["1"] != first || resolved["2"] != second {
		t.Fatalf("resolved = %v, want exactly the two known athletes", resolved)
	}
	if _, minted := resolved["3"]; minted {
		t.Fatal("an unknown athlete was resolved; nothing here may mint a player")
	}
}

// The archive ledger records whether the touch tier was present, because a
// later re-processing run cannot re-derive it -- it would see an empty result
// and conclude the parser is broken.
func TestRecordPlayArchiveRemembersThePrunedCase(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, store)
	key := "plays/espn/premier-league/2026-27/401877018.ndjson.gz"

	if err := store.RecordPlayArchive(ctx, matchID, key, 175, 20480, false); err != nil {
		t.Fatal(err)
	}
	var touchTier bool
	var plays int
	if err := pool.QueryRow(ctx,
		`SELECT touch_tier, plays FROM match_play_archive WHERE match_id=$1`,
		matchID).Scan(&touchTier, &plays); err != nil {
		t.Fatal(err)
	}
	if touchTier || plays != 175 {
		t.Fatalf("touch_tier=%v plays=%d, want false/175", touchTier, plays)
	}

	// Re-archiving a match that has since been re-fetched with the full stream
	// must upgrade the row, not duplicate it.
	if err := store.RecordPlayArchive(ctx, matchID, key, 1542, 204800, true); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT touch_tier, plays FROM match_play_archive WHERE match_id=$1`,
		matchID).Scan(&touchTier, &plays); err != nil {
		t.Fatal(err)
	}
	if !touchTier || plays != 1542 {
		t.Fatalf("touch_tier=%v plays=%d after re-archive, want true/1542", touchTier, plays)
	}

	// A later pruned response must not erase the fact that the object was once
	// captured with the full touch tier.
	if err := store.RecordPlayArchive(ctx, matchID, key, 175, 20480, false); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT touch_tier FROM match_play_archive WHERE match_id=$1`,
		matchID).Scan(&touchTier); err != nil {
		t.Fatal(err)
	}
	if !touchTier {
		t.Fatal("a pruned re-archive downgraded touch_tier from true")
	}
}

// Production writes as a member of scorearc_ingester, not as the schema owner.
// The role needs SELECT/INSERT/UPDATE and must not gain DELETE.
func TestWritePlaysAsTheIngesterRoleWithoutDelete(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	matchID := mustSeedPlayMatch(t, owner)
	asIngester, _ := newIngesterRoleStore(t, pool, dsn)

	if _, err := asIngester.WritePlays(ctx, matchID, playsFixture(),
		map[string]string{"359": "eng-arsenal"}, map[string]uuid.UUID{}); err != nil {
		t.Fatalf("write plays as scorearc_ingester: %v", err)
	}
	if err := asIngester.RecordPlayArchive(ctx, matchID,
		"plays/espn/premier-league/2026-27/401877018.ndjson.gz",
		1542, 204800, true); err != nil {
		t.Fatalf("record archive as scorearc_ingester: %v", err)
	}
	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM match_play`); err == nil {
		t.Fatal("scorearc_ingester can DELETE match_play")
	}
}
