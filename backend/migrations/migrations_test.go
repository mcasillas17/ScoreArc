package migrations

import (
	"os"
	"strings"
	"testing"
)

func readMigration(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The canonical schema must key every entity on ids we mint, expose a
// per-source crosswalk with real foreign keys, and keep the hardening that
// used to live in 0004.
func TestInitDefinesCanonicalSchema(t *testing.T) {
	sql := readMigration(t, "0001_init.up.sql")
	for _, required := range []string{
		"CREATE TABLE competition",
		"CREATE TABLE season",
		"CREATE TABLE team",
		"CREATE TABLE player",
		"CREATE TABLE match",
		"CREATE TABLE team_external_ref",
		"CREATE TABLE player_external_ref",
		"CREATE TABLE match_external_ref",
		"CREATE TABLE competition_external_ref",
		// The natural key that makes match identity deterministic.
		"UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)",
		"kickoff_date date GENERATED ALWAYS AS",
		"provisional",
		// Hardening folded in from the old 0004.
		"protect_match_history",
		"protect_finalized_detail",
		"match_unfinalized_idx",
		"ingest_run_started_idx",
		// Least-privilege roles and grants, folded in from 0001/0003/0004.
		"CREATE ROLE scorearc_reader",
		"CREATE ROLE scorearc_ingester",
		"GRANT DELETE ON standing, top_scorer TO scorearc_ingester",
		"GRANT DELETE ON ingest_run TO scorearc_ingester",
		// Curation promotion deletes the provisional team it just folded in.
		// Without this grant every promotion fails in production, where the
		// ingester is scorearc_ingester rather than the schema owner.
		"GRANT DELETE ON team TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0001_init.up.sql missing %q", required)
		}
	}
}

func TestSnapshotsUseCanonicalKeys(t *testing.T) {
	sql := readMigration(t, "0002_snapshots.up.sql")
	for _, required := range []string{
		"CREATE TABLE standing_snapshot",
		"CREATE TABLE win_prob_snapshot",
		"REFERENCES team(id)",
		"match_id    uuid NOT NULL REFERENCES match(id)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0002_snapshots.up.sql missing %q", required)
		}
	}
}

// Player capture is only useful if a player is a person: appearances key on a
// canonical player id, and events may name no one rather than inventing one.
func TestPlayerCaptureKeysOnCanonicalPlayers(t *testing.T) {
	sql := readMigration(t, "0003_player_capture.up.sql")
	for _, required := range []string{
		"CREATE TABLE appearance",
		"CREATE TABLE match_event",
		"player_id    uuid NOT NULL REFERENCES player(id)",
		// Deterministic ordinal, not a surrogate key — re-fetching a live match
		// must upsert rather than duplicate every goal.
		"PRIMARY KEY (match_id, seq)",
		"match_event_type_known CHECK",
		// The replacement writes end in DELETEs. ALTER DEFAULT PRIVILEGES in
		// 0001 grants only SELECT/INSERT/UPDATE, so without this every
		// re-ingestion raises 42501 inside the ingester.
		"GRANT DELETE ON appearance, match_event TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0003_player_capture.up.sql missing %q", required)
		}
	}
	// An event whose athlete id the provider omitted still happened. A NOT NULL
	// player_id here would force us to either drop the event or invent a player
	// keyed by display name — the exact identity collision this work removes.
	if strings.Contains(sql, "player_id uuid NOT NULL REFERENCES player(id) ON DELETE SET NULL") {
		t.Fatal("match_event.player_id must stay nullable")
	}
}

// A snapshot series is only a series if a day appears once. standing_snapshot
// shipped in 0002 with a bigserial primary key and no uniqueness at all, so a
// writer that ran twice on one day would append a second full table and every
// downstream aggregate would double-count it. The generated date column is the
// bucket; the unique index over it is the guarantee.
func TestStandingSnapshotIsIdempotentPerDay(t *testing.T) {
	sql := readMigration(t, "0004_standing_snapshot_idempotency.up.sql")
	for _, required := range []string{
		"captured_on date GENERATED ALWAYS AS",
		"CREATE UNIQUE INDEX standing_snapshot_day_key",
		"(competition_id, season_id, team_id, captured_on)",
		"standing_snapshot_day_idx",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0004_standing_snapshot_idempotency.up.sql missing %q", required)
		}
	}
	// Snapshots are append-only. A DELETE grant here would let a bug erase
	// history that cannot be re-fetched from any provider.
	if strings.Contains(sql, "GRANT DELETE ON standing_snapshot") {
		t.Fatal("standing_snapshot must stay append-only for the ingester")
	}
}

func TestStandingSnapshotRollbackDropsOnlyWhatItAdded(t *testing.T) {
	sql := readMigration(t, "0004_standing_snapshot_idempotency.down.sql")
	for _, required := range []string{
		"DROP INDEX IF EXISTS standing_snapshot_day_key",
		"DROP INDEX IF EXISTS standing_snapshot_day_idx",
		"DROP COLUMN IF EXISTS captured_on",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
	// Rolling back an index must not roll back the data it indexed.
	if strings.Contains(sql, "DROP TABLE") {
		t.Fatal("the rollback must not drop standing_snapshot itself")
	}
}

// A live match is polled every 20s. Without a key, one match produces ~300
// rows for ~100 distinct states, and a retried cycle appends another 300. The
// writer truncates captured_at to the minute; this index is what makes that
// truncation binding rather than a convention.
func TestWinProbSnapshotIsIdempotentPerMinute(t *testing.T) {
	sql := readMigration(t, "0005_win_prob_snapshot_idempotency.up.sql")
	for _, required := range []string{
		"CREATE UNIQUE INDEX win_prob_snapshot_minute_key",
		"(match_id, captured_at)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0005_win_prob_snapshot_idempotency.up.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "GRANT DELETE ON win_prob_snapshot") {
		t.Fatal("win_prob_snapshot must stay append-only for the ingester")
	}
}

func TestWinProbSnapshotRollbackKeepsTheData(t *testing.T) {
	sql := readMigration(t, "0005_win_prob_snapshot_idempotency.down.sql")
	if !strings.Contains(sql, "DROP INDEX IF EXISTS win_prob_snapshot_minute_key") {
		t.Fatalf("rollback missing the index drop:\n%s", sql)
	}
	if strings.Contains(sql, "DROP TABLE") {
		t.Fatal("the rollback must not drop win_prob_snapshot itself")
	}
}

func TestInitialRollbackRevokesDefaultPrivileges(t *testing.T) {
	sql := readMigration(t, "0001_init.down.sql")
	for _, required := range []string{
		"ALTER DEFAULT PRIVILEGES",
		"FROM scorearc_reader",
		"FROM scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}

// Squad membership is per season, not per player: a player belongs to a club
// in a season, and a transfer is a second row rather than an overwrite -- the
// same reason `appearance` records the team per match instead of on `player`.
func TestSquadAndSeasonStatsAreSeasonScoped(t *testing.T) {
	sql := readMigration(t, "0011_squad_and_season_stats.up.sql")
	for _, required := range []string{
		"CREATE TABLE squad_membership",
		"PRIMARY KEY (competition_id, season_id, team_id, player_id)",
		"CREATE TABLE player_season_stat",
		"PRIMARY KEY (competition_id, season_id, player_id)",
		"ALTER TABLE player",
		"GRANT SELECT, INSERT, UPDATE ON squad_membership, player_season_stat TO scorearc_ingester",
		"GRANT DELETE ON squad_membership TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0011_squad_and_season_stats.up.sql missing %q", required)
		}
	}
	// Eight of 35 roster athletes had no statistics block at all. NOT NULL
	// would force a zero onto a player who has not played.
	if strings.Contains(sql, "appearances int NOT NULL") {
		t.Fatal("season stat columns must be nullable")
	}
}

func TestSquadAndSeasonStatsRollbackDropsOwnedTablesInReverseOrder(t *testing.T) {
	sql := readMigration(t, "0011_squad_and_season_stats.down.sql")
	stats := strings.Index(sql, "DROP TABLE IF EXISTS player_season_stat")
	squad := strings.Index(sql, "DROP TABLE IF EXISTS squad_membership")
	if stats < 0 || squad < 0 {
		t.Fatal("0011 rollback must drop both owned tables")
	}
	if stats > squad {
		t.Fatal("0011 rollback must drop player_season_stat before squad_membership")
	}
	for _, existingColumn := range []string{"birth_date", "nationality"} {
		if strings.Contains(sql, "DROP COLUMN IF EXISTS "+existingColumn) {
			t.Fatalf("0011 rollback must not drop pre-existing player.%s", existingColumn)
		}
	}
}

func TestPlayerBioMigrationDefinesHistoryAndDurableTTL(t *testing.T) {
	sql := readMigration(t, "0012_player_bio.up.sql")
	for _, required := range []string{
		"CREATE TABLE player_team_history",
		"PRIMARY KEY (player_id, team_source_id, seasons)",
		"ALTER TABLE player ADD COLUMN IF NOT EXISTS bio_fetched_at timestamptz",
		"CREATE INDEX player_bio_stale_idx ON player (bio_fetched_at NULLS FIRST)",
		"GRANT SELECT, INSERT, UPDATE ON player_team_history TO scorearc_ingester",
		"GRANT DELETE ON player_team_history TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0012_player_bio.up.sql missing %q", required)
		}
	}
}

func TestPlayerBioRollbackRemovesEveryOwnedObject(t *testing.T) {
	sql := readMigration(t, "0012_player_bio.down.sql")
	history := strings.Index(sql, "DROP TABLE IF EXISTS player_team_history")
	index := strings.Index(sql, "DROP INDEX IF EXISTS player_bio_stale_idx")
	column := strings.Index(sql, "ALTER TABLE player DROP COLUMN IF EXISTS bio_fetched_at")
	if history < 0 || index < 0 || column < 0 {
		t.Fatal("0012 rollback must remove history, TTL index, and TTL column")
	}
	if !(history < index && index < column) {
		t.Fatal("0012 rollback statements must stay in dependency-safe order")
	}
}

// Commentary is ALREADY stored, as {minute, text} in match_detail.commentary
// jsonb. What is missing is everything else ESPN sends: the sequence, the
// period, the clock value, the play type and the wallclock. This table carries
// those; the jsonb stays, because the reader serves it verbatim.
func TestMatchCommentaryKeepsTheStructureTheJsonbDrops(t *testing.T) {
	sql := readMigration(t, "0013_match_commentary.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_commentary",
		"PRIMARY KEY (match_id, seq)",
		"period",
		"clock_value",
		"play_type",
		"wallclock",
		"GRANT SELECT, INSERT, UPDATE ON match_commentary TO scorearc_ingester",
		"GRANT DELETE ON match_commentary TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0013_match_commentary.up.sql missing %q", required)
		}
	}
	// The jsonb column is the reader's contract. Dropping it here would break
	// MatchSummaryData and slice 1d's cutover.
	if strings.Contains(sql, "match_detail DROP COLUMN") {
		t.Fatal("match_detail.commentary must stay; this table is additive")
	}

	down := readMigration(t, "0013_match_commentary.down.sql")
	if !strings.Contains(down, "DROP TABLE IF EXISTS match_commentary") {
		t.Fatal("0013_match_commentary.down.sql must fully remove the additive table")
	}
}
