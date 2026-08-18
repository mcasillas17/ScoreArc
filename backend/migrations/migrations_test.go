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
		"ADD COLUMN observed_at timestamptz",
		"ALTER COLUMN observed_at SET NOT NULL",
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
	if !strings.Contains(sql, "DROP COLUMN IF EXISTS observed_at") {
		t.Fatalf("rollback missing the observation timestamp drop:\n%s", sql)
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

// The stat set VARIES BY POSITION -- verified in espn-summary.json, where a
// goalkeeper has no `offsides` entry and an outfielder has no `saves` entry.
// A NOT NULL DEFAULT 0 column would record "the keeper was onside all match"
// and "the centre-back made no saves" as measurements, and T7.4's per-position
// percentiles would then average those inventions.
func TestAppearanceBoxScoreColumnsAreNullable(t *testing.T) {
	sql := readMigration(t, "0006_appearance_box_score.up.sql")
	for _, required := range []string{
		"ALTER TABLE appearance",
		"goals            int",
		"assists          int",
		"shots            int",
		"shots_on_target  int",
		"offsides         int",
		"fouls_committed  int",
		"fouls_suffered   int",
		"own_goals        int",
		"yellow_cards     int",
		"red_cards        int",
		"saves            int",
		"goals_conceded   int",
		"shots_faced      int",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0006_appearance_box_score.up.sql missing %q", required)
		}
	}
	var statements []string
	for _, line := range strings.Split(sql, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "--") {
			statements = append(statements, line)
		}
	}
	executableSQL := strings.Join(statements, "\n")
	for _, forbidden := range []string{"NOT NULL", "DEFAULT 0"} {
		if strings.Contains(executableSQL, forbidden) {
			t.Fatalf("box score columns must be nullable; found %q", forbidden)
		}
	}
}

// assistsLeaders arrives in the SAME /statistics response as goalsLeaders --
// 50 rows each in the repo's own recorded fixture -- and MapTopScorers threw it
// away. A category column costs one migration; a sibling top_assist table costs
// seven duplicated columns and a third table the day cleanSheetsLeaders matters.
func TestLeaderCategoryIsPartOfTheKey(t *testing.T) {
	sql := readMigration(t, "0010_leader_category.up.sql")
	for _, required := range []string{
		"ALTER TABLE top_scorer",
		"ADD COLUMN category text NOT NULL DEFAULT 'goals'",
		"DROP CONSTRAINT top_scorer_pkey",
		"PRIMARY KEY (competition_id, season_id, category, rank)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0010_leader_category.up.sql missing %q", required)
		}
	}
}

func TestLeaderCategoryRollbackRestoresTheOldKey(t *testing.T) {
	sql := readMigration(t, "0010_leader_category.down.sql")
	for _, required := range []string{
		"DELETE FROM top_scorer WHERE category <> 'goals'",
		"PRIMARY KEY (competition_id, season_id, rank)",
		"DROP COLUMN IF EXISTS category",
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

func TestAppearanceBoxScoreRollbackDropsOnlyTheColumns(t *testing.T) {
	sql := readMigration(t, "0006_appearance_box_score.down.sql")
	if !strings.Contains(sql, "DROP COLUMN IF EXISTS goals_conceded") {
		t.Fatalf("rollback missing a column drop:\n%s", sql)
	}
	if strings.Contains(sql, "DROP TABLE") {
		t.Fatal("the rollback must not drop appearance itself")
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

// The play stream is keyed on ESPN's own play id, not on an ordinal. A live
// match is re-fetched every 20s and plays are appended mid-match; an ordinal
// key would renumber on any insertion upstream and rewrite the wrong rows.
func TestPlayStreamKeysOnTheProviderPlayID(t *testing.T) {
	sql := readMigration(t, "0007_play_stream.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_play",
		"PRIMARY KEY (match_id, source_id)",
		"start_x numeric(5,2)",
		"goal_z  numeric(5,2)",
		"CREATE TABLE match_play_archive",
		"touch_tier bool",
		"GRANT SELECT ON match_play, match_play_archive TO scorearc_reader",
		"GRANT SELECT, INSERT, UPDATE ON match_play, match_play_archive TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0007_play_stream.up.sql missing %q", required)
		}
	}

	// Coordinates are the reason this table exists at all. A NOT NULL default
	// would put every unlocated play at the corner flag.
	if strings.Contains(sql, "start_x numeric(5,2) NOT NULL") {
		t.Fatal("coordinates must be nullable")
	}
	// A play retracted upstream is vanishingly rare and a DELETE grant here
	// would let a bug erase a stream ESPN will not serve again.
	if strings.Contains(sql, "GRANT DELETE ON match_play") {
		t.Fatal("match_play must not be deletable by the ingester")
	}
}

func TestOfficialsUseCanonicalIdentity(t *testing.T) {
	sql := readMigration(t, "0014_match_officials.up.sql")
	for _, required := range []string{
		"CREATE TABLE official",
		"id        uuid PRIMARY KEY",
		"CREATE TABLE official_external_ref",
		"PRIMARY KEY (source, source_id)",
		"CREATE TABLE match_official",
		"PRIMARY KEY (match_id, official_id)",
		"GRANT SELECT, INSERT, UPDATE ON official, official_external_ref, match_official TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0014_match_officials.up.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "id text PRIMARY KEY") {
		t.Fatal("official identity must use canonical UUIDs, not provider text ids")
	}
}

func TestOfficialsRollbackDropsOnlyOwnedTablesInReverseOrder(t *testing.T) {
	sql := readMigration(t, "0014_match_officials.down.sql")
	matchOfficial := strings.Index(sql, "DROP TABLE IF EXISTS match_official")
	externalRef := strings.Index(sql, "DROP TABLE IF EXISTS official_external_ref")
	official := strings.Index(sql, "DROP TABLE IF EXISTS official;")
	if matchOfficial < 0 || externalRef < 0 || official < 0 {
		t.Fatal("0014_match_officials.down.sql must drop every owned table")
	}
	if !(matchOfficial < externalRef && externalRef < official) {
		t.Fatal("0008 rollback must drop match_official, official_external_ref, then official")
	}
	for _, drop := range strings.Split(sql, ";") {
		drop = strings.TrimSpace(drop)
		if strings.HasPrefix(drop, "DROP TABLE") &&
			drop != "DROP TABLE IF EXISTS match_official" &&
			drop != "DROP TABLE IF EXISTS official_external_ref" &&
			drop != "DROP TABLE IF EXISTS official" {
			t.Fatalf("0008 rollback must not drop unrelated tables: %q", drop)
		}
	}
}

func TestOddsSeparatesFixedLinesFromSamples(t *testing.T) {
	sql := readMigration(t, "0015_odds_snapshot.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_odds",
		"PRIMARY KEY (match_id, provider_id, phase)",
		"phase text NOT NULL CHECK (phase IN ('open','close'))",
		"CREATE TABLE odds_snapshot",
		"PRIMARY KEY (match_id, provider_id, captured_at)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0015_odds_snapshot.up.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "GRANT DELETE ON odds_snapshot") {
		t.Fatal("odds_snapshot must not be deletable by the ingester")
	}
}

func TestOddsTablesUseExplicitNullableMarketColumns(t *testing.T) {
	sql := readMigration(t, "0015_odds_snapshot.up.sql")
	marketColumns := []string{
		"home_moneyline",
		"draw_moneyline",
		"away_moneyline",
		"spread",
		"home_spread_odds",
		"away_spread_odds",
		"over_under",
		"over_odds",
		"under_odds",
	}

	for _, table := range []string{"match_odds", "odds_snapshot"} {
		tableSQL := oddsTableSQL(t, sql, table)
		for _, column := range marketColumns {
			columnSQL := oddsColumnSQL(t, tableSQL, column)
			if strings.Contains(columnSQL, "NOT NULL") || strings.Contains(columnSQL, "DEFAULT 0") {
				t.Fatalf("%s.%s must be nullable without DEFAULT 0: %q", table, column, columnSQL)
			}
		}
	}

	if !strings.Contains(oddsTableSQL(t, sql, "match_odds"), "provider_name text NOT NULL") {
		t.Fatal("match_odds must retain provider_name")
	}
	if strings.Contains(oddsTableSQL(t, sql, "odds_snapshot"), "provider_name") {
		t.Fatal("odds_snapshot must not duplicate provider_name")
	}
}

func oddsTableSQL(t *testing.T, sql, table string) string {
	t.Helper()
	start := strings.Index(sql, "CREATE TABLE "+table+" (")
	if start < 0 {
		t.Fatalf("missing CREATE TABLE %s", table)
	}
	end := strings.Index(sql[start:], "\n);")
	if end < 0 {
		t.Fatalf("missing end of CREATE TABLE %s", table)
	}
	return sql[start : start+end]
}

func oddsColumnSQL(t *testing.T, tableSQL, column string) string {
	t.Helper()
	for _, line := range strings.Split(tableSQL, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, column+" ") {
			return line
		}
	}
	t.Fatalf("missing explicit odds column %q in:\n%s", column, tableSQL)
	return ""
}

func TestOddsRollbackDropsOnlyOwnedTablesInReverseOrder(t *testing.T) {
	sql := readMigration(t, "0015_odds_snapshot.down.sql")
	snapshot := strings.Index(sql, "DROP TABLE IF EXISTS odds_snapshot")
	odds := strings.Index(sql, "DROP TABLE IF EXISTS match_odds")
	if snapshot < 0 || odds < 0 {
		t.Fatal("0015_odds_snapshot.down.sql must drop every owned table")
	}
	if snapshot > odds {
		t.Fatal("0009 rollback must drop odds_snapshot before match_odds")
	}
	for _, drop := range strings.Split(sql, ";") {
		drop = strings.TrimSpace(drop)
		if strings.HasPrefix(drop, "DROP TABLE") &&
			drop != "DROP TABLE IF EXISTS odds_snapshot" &&
			drop != "DROP TABLE IF EXISTS match_odds" {
			t.Fatalf("0009 rollback must not drop unrelated tables: %q", drop)
		}
	}
}

// ESPN's officials crew and fixed-odds lines are fetched in a follow-up call
// AFTER a match finalizes, and either can fail or the process can die before
// it succeeds. This table is the durable record of that: one row per
// (match, capture kind) that says whether it is done, and if not, when to
// retry and why the last attempt failed. It is internal ingest bookkeeping,
// not published data, so it must not inherit 0001's default SELECT grant to
// scorearc_reader, and it must never be deletable by the ingester.
func TestFinalCaptureStatusDefinesSchema(t *testing.T) {
	sql := readMigration(t, "0016_final_capture_status.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_final_capture_status",
		"match_id          uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE",
		"kind              text NOT NULL CHECK (kind IN ('officials','fixed_odds'))",
		"attempt_count     int NOT NULL CHECK (attempt_count >= 1)",
		"last_attempted_at timestamptz NOT NULL",
		"retry_at          timestamptz",
		"completed_at      timestamptz",
		"last_error        text NOT NULL DEFAULT ''",
		"PRIMARY KEY (match_id, kind)",
		// Exactly one of retry_at/completed_at is ever set: a row that is
		// neither would be a capture nobody is tracking, and one that is both
		// would not say whether it is done or still pending.
		"CHECK ((retry_at IS NULL) <> (completed_at IS NULL))",
		// A completed row's last_error would misreport why a done capture
		// "failed" once a later cycle reads it.
		"CHECK (completed_at IS NULL OR last_error = '')",
		// The retry scanner only ever looks at incomplete rows ordered by
		// when they are next due; a full index would carry finished history
		// it never reads.
		"CREATE INDEX match_final_capture_status_retry_idx",
		"ON match_final_capture_status (retry_at, match_id)",
		"WHERE completed_at IS NULL",
		"REVOKE ALL ON match_final_capture_status FROM scorearc_reader",
		"GRANT SELECT, INSERT, UPDATE ON match_final_capture_status TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0016_final_capture_status.up.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "GRANT DELETE ON match_final_capture_status") {
		t.Fatal("match_final_capture_status must not be deletable by the ingester")
	}
	if strings.Contains(sql, "GRANT SELECT ON match_final_capture_status TO scorearc_reader") {
		t.Fatal("match_final_capture_status is internal ingest bookkeeping and must not grant scorearc_reader SELECT")
	}
}

func TestFinalCaptureStatusRollbackDropsOnlyOwnedTable(t *testing.T) {
	sql := readMigration(t, "0016_final_capture_status.down.sql")
	if !strings.Contains(sql, "DROP TABLE IF EXISTS match_final_capture_status") {
		t.Fatal("0016_final_capture_status.down.sql must drop match_final_capture_status")
	}
	for _, drop := range strings.Split(sql, ";") {
		drop = strings.TrimSpace(drop)
		if strings.HasPrefix(drop, "DROP TABLE") &&
			drop != "DROP TABLE IF EXISTS match_final_capture_status" {
			t.Fatalf("0016_final_capture_status.down.sql must not drop unrelated tables: %q", drop)
		}
	}
}

// The C1 guards. Each assertion below encodes a decision that is easy to
// "simplify" into a production outage, so each is pinned by text.
func TestFinalizationInvariantsSealEachTableByItsOwnMarker(t *testing.T) {
	sql := readMigration(t, "0021_finalization_invariants.up.sql")
	for _, required := range []string{
		// One function, one escape hatch, six triggers.
		"CREATE FUNCTION scorearc_final_writes_allowed(target regclass)",
		"CREATE FUNCTION scorearc_protect_final_records() RETURNS trigger",
		"CREATE TRIGGER protect_final_appearance",
		"CREATE TRIGGER protect_final_match_event",
		"CREATE TRIGGER protect_final_match_commentary",
		"CREATE TRIGGER protect_final_match_play",
		"CREATE TRIGGER protect_final_match_official",
		"CREATE TRIGGER protect_final_match_odds",
		// The seal phrasing that keeps a cascade delete working. The inverted
		// form would make a finalized match permanently undeletable.
		"WHERE id = target_match AND finalized_at IS NOT NULL",
		// match_play is sealed by the ledger, joined to match so the cascade
		// order between two sibling children cannot decide the outcome.
		"FROM match_play_archive a",
		"JOIN match m ON m.id = a.match_id",
		// The curation carve-out, in jsonb so one function serves tables with
		// and without the column.
		"- 'team_id' - 'player_id'",
		"SELECT 1 FROM team WHERE id = old_row->>'team_id' AND provisional",
		// A classifiable rejection.
		"ERRCODE = 'SA001'",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0021_finalization_invariants.up.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "CREATE TRIGGER protect_finalized_detail") {
		t.Fatal("0021 must leave 0001's protect_finalized_detail trigger untouched")
	}
}

// match_official and match_odds are written AFTER finalization on the normal
// path (ingester/matches.go:311, :312). Guarding their INSERT would reject the
// one legitimate write each of them ever receives.
func TestFinalizationInvariantsDoNotGuardTheFinalizationInsert(t *testing.T) {
	sql := readMigration(t, "0021_finalization_invariants.up.sql")
	for _, table := range []string{"match_official", "match_odds"} {
		guarded := "BEFORE UPDATE OR DELETE ON " + table
		if !strings.Contains(sql, guarded) {
			t.Fatalf("%s must be guarded on UPDATE and DELETE only, missing %q", table, guarded)
		}
		if strings.Contains(sql, "BEFORE INSERT OR UPDATE OR DELETE ON "+table) {
			t.Fatalf(
				"%s guards INSERT: that rejects the finalization write at "+
					"ingester/matches.go and breaks production finalization", table)
		}
	}
	// The other four must guard all three, because their writers upsert and
	// then issue a tail DELETE.
	for _, table := range []string{
		"appearance", "match_event", "match_commentary", "match_play",
	} {
		guarded := "BEFORE INSERT OR UPDATE OR DELETE ON " + table
		if !strings.Contains(sql, guarded) {
			t.Fatalf("%s must guard INSERT, UPDATE and DELETE, missing %q", table, guarded)
		}
	}
}

func TestFinalizationInvariantsRollbackRemovesEveryOwnedObject(t *testing.T) {
	sql := readMigration(t, "0021_finalization_invariants.down.sql")
	for _, required := range []string{
		"DROP TRIGGER IF EXISTS protect_final_appearance ON appearance",
		"DROP TRIGGER IF EXISTS protect_final_match_event ON match_event",
		"DROP TRIGGER IF EXISTS protect_final_match_commentary ON match_commentary",
		"DROP TRIGGER IF EXISTS protect_final_match_play ON match_play",
		"DROP TRIGGER IF EXISTS protect_final_match_official ON match_official",
		"DROP TRIGGER IF EXISTS protect_final_match_odds ON match_odds",
		"DROP FUNCTION IF EXISTS scorearc_protect_final_records()",
		"DROP FUNCTION IF EXISTS scorearc_final_writes_allowed(regclass)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0021_finalization_invariants.down.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "protect_finalized_detail") {
		t.Fatal("0021 rollback must not drop 0001's protect_finalized_detail trigger")
	}
}

// match_play_archive is the ledger the match_play seal reads. Guarding it would
// break cmd/play-backfill, whose entire job is to write that ledger for
// already-finalized matches.
func TestFinalizationInvariantsLeaveTheArchiveLedgerWritable(t *testing.T) {
	sql := readMigration(t, "0021_finalization_invariants.up.sql")
	if strings.Contains(sql, "ON match_play_archive") {
		t.Fatal(
			"0021 guards match_play_archive: cmd/play-backfill writes exactly that " +
				"table for already-finalized matches and would stop working")
	}
}
