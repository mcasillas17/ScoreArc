# Ingester — Daily Standings Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ScoreArc a memory of its own league tables. Every UTC day, for every
competition, persist one row per team into `standing_snapshot` — idempotently, so a
re-run, a redeploy or a crash-loop cannot duplicate a day or lose one.

**Architecture:** `standing_snapshot` already exists (migration `0002_snapshots`) and
**nothing has ever written to it**. Grep confirms the table name appears only in the
migration files. This plan closes that. The write hangs off the *existing*
`refreshStandings` path, immediately after `ReplaceStandings` commits, so the snapshot
is a copy of exactly the rows that were accepted into `standing` — never of a payload
the replacement guards rejected. Idempotency lives in the **database**, as a unique
index over a generated `captured_on` date, mirroring the `match.kickoff_date` pattern
already in `0001_init.up.sql`; the in-process day gate is a cost optimisation on top of
that guarantee, never the guarantee itself.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go, Fly.io.

**Spec:** `docs/superpowers/specs/2026-08-15-history-and-trends-design.md`
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Task: T7.1**
**Branch:** `feat/ingester-standings-snapshots`

---

## Why this one cannot wait

A standings snapshot not written on 2026-08-15 is **gone forever**. ESPN publishes the
current table, not yesterday's. Every trend, every form curve, every "biggest riser
this month", every table-trajectory chart and the Brier score that would legitimise a
match simulator are all functions of a time series that only exists if we started
recording before we needed it.

This is the only task on the entire product roadmap with a cost for waiting. Shipping
the writer with **no UI at all** is a complete and correct deliverable — T7.3 (form
column) and T7.5 (previous seasons) render it later.

---

## ⚠️ Merge-order dependency — read before writing a single line

This plan adds migration **`0004_standing_snapshot_idempotency`**. That number is only
free once two unmerged branches land, and they must land in this order:

1. **`feat/canonical-identity-impl`** (29 commits) — rewrites `0001_init.*.sql` onto
   canonical ids and **deletes `0003_ingester_delete_grant.*` and
   `0004_ingester_hardening.*`**, folding them into `0001`. It also re-keys
   `standing_snapshot` from `comp_id` to **`competition_id`** and adds
   `REFERENCES team(id)`.
2. **`feat/player-identity`** (6 commits, stacked on the branch above) — adds
   **`0003_player_capture.*.sql`** (`appearance`, `match_event`).

So after both merge, the migration directory is `0001`, `0002`, `0003_player_capture`,
and `0004` is the next free number.

**Before you start, verify the world you are building on:**

```bash
git fetch origin && git log --oneline origin/main -1
ls backend/migrations/
```

Expected: `0001_init.*`, `0002_snapshots.*`, `0003_player_capture.*` and
`migrations_test.go` — and **no** `0003_ingester_delete_grant` or
`0004_ingester_hardening`. If you still see those two, the canonical-identity branch has
not merged; **stop and say so** rather than writing a migration against a schema that is
about to be replaced. If `0004_*` already exists, take the next free number and adjust
every filename and test reference in this plan consistently.

**Migration numbers reserved by the sibling ingester plans** (do not reuse). Execute in
this order — the numbering assumes it:

| # | Migration | Plan | Task |
|---|---|---|---|
| 1 | `0004_standing_snapshot_idempotency` | **this plan** | T7.1 |
| 2 | `0005_win_prob_snapshot_idempotency` | `2026-08-15-ingester-win-probability-snapshots.md` | T7.6 |
| 3 | `0006_appearance_box_score` | `2026-08-15-ingester-box-score.md` | T7.7 |
| 4 | `0007_play_stream` | `2026-08-15-ingester-play-stream.md` | T7.12, T7.13 |
| 5 | `0008_match_officials`, `0009_odds_snapshot` | `2026-08-15-ingester-officials-and-odds.md` | T7.14, T7.15 |
| 6 | `0010_leader_category` | `2026-08-15-ingester-season-leaders.md` | T7.8 |
| 7 | `0011_squad_and_season_stats`, `0012_player_bio` | `2026-08-15-ingester-squad-and-athletes.md` | T7.9, T7.10 |
| 8 | `0013_match_commentary` | `2026-08-15-ingester-commentary.md` | T7.11 |

**Urgency, which is not the same as the numbering.** This plan is first because a
standings day not written is gone. **T7.12/T7.13 (the play stream) is a close second and
should be started in parallel by a second agent** — ESPN prunes the touch-level tier of
its play stream for older matches, so this season's early fixtures are losing it now.
Everything from row 5 down can wait weeks at no cost.

---

## Global Constraints

- **Never commit or merge to `main`** — it auto-deploys production. Branch for all work
  (`AGENTS.md`).
- TDD: write the failing test, run it, see it fail for the stated reason, then implement.
- Backend gate, all three clean before a PR:
  ```bash
  cd backend && go build ./... && go test -race ./... && go vet ./...
  ```
  **Docker must be running** — `shared/store` and `reader` use testcontainers.
- Every migration needs **both** `.up.sql` and `.down.sql`.
- The ingester connects with the **least-privilege login, never the database owner**:
  `POOLED_DSN` for writes, `INGESTER_LEASE_DSN` for the dedicated direct/unpooled
  advisory-lock session. Secrets go in via `fly secrets`, never into a file.
- `standing_snapshot` is **append-only by design**. Do **not** grant the ingester
  `DELETE` on it. `0001`'s `ALTER DEFAULT PRIVILEGES` already gives it
  `SELECT, INSERT, UPDATE` on tables created afterwards, which is exactly what an
  idempotent upsert needs and nothing more.
- Conventional commit prefixes, every message ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Substitute your
  own agent identity if you are not Claude.

---

## File Structure

- `backend/migrations/0004_standing_snapshot_idempotency.up.sql` — new. The generated
  `captured_on` date, the unique index that makes the write idempotent, and the lookup
  index for the day gate.
- `backend/migrations/0004_standing_snapshot_idempotency.down.sql` — new.
- `backend/migrations/migrations_test.go` — one new case asserting the idempotency key
  exists.
- `backend/shared/store/snapshots.go` — new. `WriteStandingSnapshot`.
- `backend/shared/store/snapshots_integration_test.go` — new. Real Postgres: write,
  re-write, re-write with changed values, and write as `scorearc_ingester`.
- `backend/ingester/runner.go` — `refreshStandings` gains a `tableChanged` parameter and
  a call to the new `snapshotStandings`; the `runner` struct gains `snapshotted`.
- `backend/ingester/contracts.go` — `WriteStandingSnapshot` on the `repository`
  interface.
- `backend/ingester/main.go` — initialise `snapshotted` in the worker literal.
- `backend/ingester/runner_test.go` — `fakeRepository` implements the new method; three
  new cases.
- `docs/backend/ARCHITECTURE.md` — move `standing_snapshot` out of "WRITTEN in Phase 2".

---

### Task 1: The idempotency key

**Files:**
- Create: `backend/migrations/0004_standing_snapshot_idempotency.up.sql`
- Create: `backend/migrations/0004_standing_snapshot_idempotency.down.sql`
- Test: `backend/migrations/migrations_test.go`

`standing_snapshot` today is `id bigserial PRIMARY KEY` and four indexed columns. There
is **no uniqueness anywhere on it**, so a naive writer that runs twice on the same day —
because the process restarted, because a deploy rolled, because a slow tick fired twice
— appends a second full table and every downstream `GROUP BY captured_at` silently
double-counts. The key has to exist before the writer does.

- [ ] **Step 1: Write the failing migration test**

Append to `backend/migrations/migrations_test.go`, after
`TestPlayerCaptureKeysOnCanonicalPlayers`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./migrations/ -run StandingSnapshot
```

Expected: FAIL, twice, with
`open 0004_standing_snapshot_idempotency.up.sql: no such file or directory` — the
`readMigration` helper calls `t.Fatal` on the read error.

- [ ] **Step 3: Write the up migration**

Create `backend/migrations/0004_standing_snapshot_idempotency.up.sql`:

```sql
-- standing_snapshot has existed since 0002 and nothing has ever written to it.
-- Before anything does, it needs a key, because the one property this table has
-- to hold is that a day appears once.
--
-- The bucket is a GENERATED column rather than one the writer fills, for the
-- same reason match.kickoff_date is generated in 0001: a value the writer
-- supplies can disagree with the value it was derived from, and the whole point
-- of the key is that it cannot.
--
-- `AT TIME ZONE 'UTC'` is what makes the expression immutable enough to be
-- generated (timezone(text, timestamptz) is IMMUTABLE; a bare ::date cast of a
-- timestamptz is not). It also fixes the day boundary at 00:00 UTC for every
-- competition, so Liga MX and the Premier League bucket the same way and a
-- cross-competition chart has one x-axis. Consumers that need the true
-- observation time read captured_at, which is untouched.
ALTER TABLE standing_snapshot
  ADD COLUMN captured_on date
  GENERATED ALWAYS AS ((captured_at AT TIME ZONE 'UTC')::date) STORED;

-- The guarantee. The in-process day gate in the ingester is a cost
-- optimisation; THIS is what makes a restart, a redeploy or a crash-loop
-- unable to duplicate a day.
CREATE UNIQUE INDEX standing_snapshot_day_key
  ON standing_snapshot (competition_id, season_id, team_id, captured_on);

-- The reader's "has today been recorded" and "give me the series for this
-- season" queries both lead with (competition_id, season_id) and filter on the
-- date, not on captured_at. The 0002 index is keyed on captured_at and cannot
-- serve them.
CREATE INDEX standing_snapshot_day_idx
  ON standing_snapshot (competition_id, season_id, captured_on);
```

- [ ] **Step 4: Write the down migration**

Create `backend/migrations/0004_standing_snapshot_idempotency.down.sql`:

```sql
-- Drops the key, never the history. standing_snapshot rows cannot be
-- re-fetched from any provider, so a rollback that dropped the table would be
-- irreversible data loss dressed up as a schema change.
DROP INDEX IF EXISTS standing_snapshot_day_idx;
DROP INDEX IF EXISTS standing_snapshot_day_key;
ALTER TABLE standing_snapshot DROP COLUMN IF EXISTS captured_on;
```

- [ ] **Step 5: Run the migration tests**

```bash
cd backend && go test ./migrations/
```

Expected: `ok  	github.com/mcasillas17/scorearc-backend/migrations` — all cases pass,
including the pre-existing `TestInitDefinesCanonicalSchema`,
`TestSnapshotsUseCanonicalKeys` and `TestPlayerCaptureKeysOnCanonicalPlayers`.

- [ ] **Step 6: Prove the migration actually applies to a real Postgres**

The tests above are string assertions. The integration harness in
`backend/shared/store/identity_integration_test.go` globs `../../migrations/*.up.sql`,
sorts them and applies each in order, so any pre-existing store integration test now
also executes `0004`. Run one:

```bash
cd backend && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk -v
```

Expected: `--- PASS: TestResolveTeamHitsTheCrosswalk`. If `0004` were invalid SQL the
harness would abort with `apply 0004_standing_snapshot_idempotency.up.sql: ...` before
the test body ran. In particular, a `PASS` here is the proof that Postgres accepts
`(captured_at AT TIME ZONE 'UTC')::date` in a `GENERATED ... STORED` column.

Docker must be running. If it is not, this fails with a container-runtime error rather
than a SQL error — start Docker and re-run before concluding anything.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/0004_standing_snapshot_idempotency.up.sql \
        backend/migrations/0004_standing_snapshot_idempotency.down.sql \
        backend/migrations/migrations_test.go
git commit -m "feat: give standing_snapshot a per-day idempotency key

The table has existed since 0002 and nothing has ever written to it. It
has a bigserial primary key and no uniqueness, so a writer that ran twice
on one day -- restart, redeploy, crash-loop -- would append a second full
table and every downstream aggregate would double-count it.

captured_on is generated from captured_at rather than supplied, for the
same reason match.kickoff_date is: a value the writer fills can disagree
with the value it was derived from.

No DELETE grant: snapshots are append-only and cannot be re-fetched from
any provider.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `Store.WriteStandingSnapshot`

**Files:**
- Create: `backend/shared/store/snapshots.go`
- Test: `backend/shared/store/snapshots_integration_test.go`

**Interfaces:**
- `func (s *Store) WriteStandingSnapshot(ctx context.Context, competitionID, seasonID string, standings []model.Standing, teamIDs map[string]string, capturedAt time.Time) (int, error)`
  — returns the number of rows written. `teamIDs` maps the **provider** team id carried
  on each `model.Standing` to its **canonical** team id, exactly as
  `ReplaceStandings` already takes it, because `standing_snapshot.team_id` carries a
  real `REFERENCES team(id)` after the canonical-identity merge.

- [ ] **Step 1: Write the failing integration test**

Create `backend/shared/store/snapshots_integration_test.go`:

```go
package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// standingsFor builds a two-row table in PROVIDER shape, the way the ESPN
// mapper hands it over: Team.ID is the provider's id, and the canonical ids
// arrive separately in teamIDs.
func standingsFor(topPoints, bottomPoints int) []model.Standing {
	return []model.Standing{
		{Team: model.Team{ID: "359", Name: "Arsenal", Abbr: "ARS"},
			Rank: 1, Played: 3, Points: topPoints, GoalDifference: 5},
		{Team: model.Team{ID: "363", Name: "Chelsea", Abbr: "CHE"},
			Rank: 2, Played: 3, Points: bottomPoints, GoalDifference: 1},
	}
}

var snapshotTeamIDs = map[string]string{"359": "eng-arsenal", "363": "eng-chelsea"}

func snapshotRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM standing_snapshot`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

// The property the whole feature rests on: a day appears once, no matter how
// many times the writer runs. A restart, a redeploy and a crash-loop all look
// like this.
func TestStandingSnapshotIsIdempotentWithinADay(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	morning := time.Date(2026, 8, 15, 6, 0, 0, 0, time.UTC)
	evening := time.Date(2026, 8, 15, 22, 30, 0, 0, time.UTC)

	written, err := store.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(9, 6), snapshotTeamIDs, morning)
	if err != nil {
		t.Fatalf("WriteStandingSnapshot: %v", err)
	}
	if written != 2 {
		t.Fatalf("wrote %d rows, want 2", written)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d rows, want 2", got)
	}

	// Same day, later, and the table has moved. The day must still be one row
	// per team, and it must carry the LATER observation -- a daily series wants
	// the day's settled table, not its 06:00 state.
	if _, err := store.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(12, 6), snapshotTeamIDs, evening); err != nil {
		t.Fatalf("second write: %v", err)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d rows after a same-day rewrite, want 2", got)
	}

	var points int
	var capturedAt time.Time
	if err := pool.QueryRow(ctx, `
SELECT points, captured_at FROM standing_snapshot
WHERE competition_id='premier-league' AND season_id='2026-27' AND team_id='eng-arsenal'`,
	).Scan(&points, &capturedAt); err != nil {
		t.Fatal(err)
	}
	if points != 12 {
		t.Fatalf("points = %d, want the later observation 12", points)
	}
	if !capturedAt.UTC().Equal(evening) {
		t.Fatalf("captured_at = %s, want the later observation %s", capturedAt.UTC(), evening)
	}
}

// The other half: a NEW day is a new row, or there is no series at all.
func TestStandingSnapshotAddsARowPerDay(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	day1 := time.Date(2026, 8, 15, 23, 59, 0, 0, time.UTC)
	// 00:30 UTC the next calendar day. A local-time bucket would fold this into
	// the 15th for a Mexican kickoff and split it for a European one; the UTC
	// bucket makes every competition agree.
	day2 := time.Date(2026, 8, 16, 0, 30, 0, 0, time.UTC)

	for _, at := range []time.Time{day1, day2} {
		if _, err := store.WriteStandingSnapshot(ctx,
			"premier-league", "2026-27", standingsFor(9, 6), snapshotTeamIDs, at); err != nil {
			t.Fatalf("write at %s: %v", at, err)
		}
	}
	if got := snapshotRows(t, pool); got != 4 {
		t.Fatalf("stored %d rows across two days, want 4", got)
	}

	var days int
	if err := pool.QueryRow(ctx,
		`SELECT count(DISTINCT captured_on) FROM standing_snapshot`).Scan(&days); err != nil {
		t.Fatal(err)
	}
	if days != 2 {
		t.Fatalf("distinct captured_on = %d, want 2", days)
	}
}

// A pre-season table is still a fact. ESPN ranks an unplayed table
// alphabetically (E0/T0.1), so these rows are not a standing -- but skipping
// them would make "the season had not started" indistinguishable from "the
// writer was down", which is the one thing a time series must never confuse.
// played = 0 is on the row; filtering is the reader's job.
func TestStandingSnapshotRecordsAPreSeasonTable(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	preseason := standingsFor(0, 0)
	for i := range preseason {
		preseason[i].Played = 0
		preseason[i].GoalDifference = 0
	}
	if _, err := store.WriteStandingSnapshot(ctx, "premier-league", "2026-27",
		preseason, snapshotTeamIDs, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("WriteStandingSnapshot: %v", err)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d pre-season rows, want 2", got)
	}
}

func TestStandingSnapshotRefusesAnEmptyTable(t *testing.T) {
	store, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	_, err := store.WriteStandingSnapshot(context.Background(),
		"premier-league", "2026-27", nil, snapshotTeamIDs, time.Now())
	if !errors.Is(err, ErrEmptyReplacement) {
		t.Fatalf("err = %v, want ErrEmptyReplacement", err)
	}
	if got := snapshotRows(t, pool); got != 0 {
		t.Fatalf("stored %d rows for an empty table, want 0", got)
	}
}

// An unresolved team would violate the foreign key mid-transaction and abort
// the whole day. Refuse before opening it, and name the team.
func TestStandingSnapshotRefusesAnUnresolvedTeam(t *testing.T) {
	store, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	_, err := store.WriteStandingSnapshot(context.Background(),
		"premier-league", "2026-27", standingsFor(9, 6),
		map[string]string{"359": "eng-arsenal"}, time.Now())
	if err == nil {
		t.Fatal("want an error naming the unresolved team")
	}
	if !strings.Contains(err.Error(), "363") {
		t.Fatalf("err = %v, want it to name provider team 363", err)
	}
	if got := snapshotRows(t, pool); got != 0 {
		t.Fatalf("stored %d rows, want 0 -- the day must be all or nothing", got)
	}
}
```

Add `"strings"` to that file's imports.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./shared/store/ -run StandingSnapshot
```

Expected: FAIL to **compile**, with
`store.WriteStandingSnapshot undefined (type *Store has no field or method WriteStandingSnapshot)`.

- [ ] **Step 3: Implement the writer**

Create `backend/shared/store/snapshots.go`:

```go
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// WriteStandingSnapshot records one row per team for the UTC day capturedAt
// falls in.
//
// This is the only write in the whole system whose absence is irreversible.
// ESPN publishes the current table, not yesterday's, so a day this does not
// record can never be recovered from any provider. That is why it is a
// transaction (a half-written table is worse than none, because a reader
// cannot tell it is half-written) and why the day key is enforced by the
// database rather than by the caller.
//
// Re-running for a day that already exists UPDATES it rather than duplicating
// it. The semantic is "the day's last observed table": a snapshot taken at
// 06:00 and refreshed at 22:30 keeps the 22:30 numbers, because a daily series
// wants the day settled, not the day's first minute. captured_at always holds
// the true observation time, so a consumer that needs precision has it.
//
// teamIDs maps provider team id -> canonical team id. The store does not
// resolve identity; the caller does, exactly as ReplaceStandings requires.
func (s *Store) WriteStandingSnapshot(
	ctx context.Context,
	competitionID, seasonID string,
	standings []model.Standing,
	teamIDs map[string]string,
	capturedAt time.Time,
) (int, error) {
	if len(standings) == 0 {
		return 0, ErrEmptyReplacement
	}

	// Resolve every row before opening the transaction. A snapshot for an
	// unresolved team would breach the foreign key and abort the day; failing
	// here costs nothing and says which team was missing.
	canonical := make([]string, len(standings))
	for index, standing := range standings {
		teamID, resolved := teamIDs[standing.Team.ID]
		if !resolved || teamID == "" {
			return 0, fmt.Errorf(
				"standing snapshot for %s/%s references unresolved team %q",
				competitionID, seasonID, standing.Team.ID)
		}
		canonical[index] = teamID
	}
	capturedAt = capturedAt.UTC()

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(ctx, tx)

	batch := &pgx.Batch{}
	for index, standing := range standings {
		batch.Queue(standingSnapshotSQL,
			competitionID, seasonID, canonical[index], capturedAt,
			standing.Rank, standing.Points, standing.GoalDifference, standing.Played)
	}
	results := tx.SendBatch(ctx, batch)
	for index := range standings {
		if _, err := results.Exec(); err != nil {
			_ = results.Close()
			return 0, fmt.Errorf("snapshot row %d: %w", index, err)
		}
	}
	if err := results.Close(); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(standings), nil
}

// The conflict target is the generated captured_on, not captured_at: two
// writes on the same day at different clock times must collide, and two writes
// at the same clock time on different days must not.
const standingSnapshotSQL = `
INSERT INTO standing_snapshot (
	competition_id, season_id, team_id, captured_at,
	rank, points, goal_difference, played)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (competition_id, season_id, team_id, captured_on) DO UPDATE SET
	captured_at     = EXCLUDED.captured_at,
	rank            = EXCLUDED.rank,
	points          = EXCLUDED.points,
	goal_difference = EXCLUDED.goal_difference,
	played          = EXCLUDED.played`
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && go test ./shared/store/ -run StandingSnapshot -v
```

Expected: five `--- PASS` lines —
`TestStandingSnapshotIsIdempotentWithinADay`,
`TestStandingSnapshotAddsARowPerDay`,
`TestStandingSnapshotRecordsAPreSeasonTable`,
`TestStandingSnapshotRefusesAnEmptyTable`,
`TestStandingSnapshotRefusesAnUnresolvedTeam`.

- [ ] **Step 5: Prove the least-privilege login can actually do this**

Every other store test runs as the schema owner. Production does not. A missing grant
surfaces as SQLSTATE `42501` **inside the ingester**, which is exactly how curation once
shipped permanently broken (see the comment block in `0003_player_capture.up.sql`).

Append to `backend/shared/store/snapshots_integration_test.go`:

```go
// Production writes as scorearc_ingester, not as the schema owner. 0001's
// ALTER DEFAULT PRIVILEGES grants SELECT/INSERT/UPDATE on tables created after
// it, which is precisely what an idempotent upsert needs -- and deliberately
// NOT DELETE, because a snapshot series must be append-only. This test is the
// only thing that proves the first half; remove the grant and it fails 42501.
func TestWriteStandingSnapshotAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)

	if _, err := pool.Exec(ctx, `
CREATE ROLE snapshot_writer LOGIN PASSWORD 'snapshot_writer';
GRANT scorearc_ingester TO snapshot_writer;`); err != nil {
		t.Fatal(err)
	}
	ingesterDSN := strings.Replace(dsn, "postgres:postgres@", "snapshot_writer:snapshot_writer@", 1)
	asIngester, err := New(ctx, ingesterDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(asIngester.Close)

	at := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	if _, err := asIngester.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(9, 6), snapshotTeamIDs, at); err != nil {
		t.Fatalf("insert as scorearc_ingester: %v", err)
	}
	// The UPDATE half of the upsert needs its own grant. An INSERT-only role
	// passes the line above and fails here.
	if _, err := asIngester.WriteStandingSnapshot(ctx,
		"premier-league", "2026-27", standingsFor(12, 6), snapshotTeamIDs, at); err != nil {
		t.Fatalf("same-day update as scorearc_ingester: %v", err)
	}
	if got := snapshotRows(t, pool); got != 2 {
		t.Fatalf("stored %d rows, want 2", got)
	}

	// Append-only is a grant, not a convention.
	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM standing_snapshot`); err == nil {
		t.Fatal("scorearc_ingester can DELETE standing_snapshot; history is not append-only")
	}
}
```

```bash
cd backend && go test ./shared/store/ -run WriteStandingSnapshotAsTheIngesterRole -v
```

Expected: `--- PASS: TestWriteStandingSnapshotAsTheIngesterRole`.

- [ ] **Step 6: Commit**

```bash
git add backend/shared/store/snapshots.go backend/shared/store/snapshots_integration_test.go
git commit -m "feat: write daily standings snapshots

standing_snapshot has existed since 0002 with nothing writing to it. This
is the write. One row per team per UTC day, transactional so a day is
never half-recorded, and upserting so a restart or redeploy refreshes the
day rather than duplicating it.

A day this does not record can never be recovered -- ESPN publishes the
current table, not yesterday's.

Covered as scorearc_ingester, not as the schema owner: a missing grant
surfaces as 42501 inside the ingester, which is how curation once shipped
permanently broken.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Hang the snapshot off the standings refresh

**Files:**
- Modify: `backend/ingester/contracts.go`
- Modify: `backend/ingester/runner.go`
- Modify: `backend/ingester/main.go`
- Test: `backend/ingester/runner_test.go`

**Interfaces:**
- `repository` gains
  `WriteStandingSnapshot(context.Context, string, string, []model.Standing, map[string]string, time.Time) (int, error)`.
- `refreshStandings` gains a trailing `tableChanged bool` parameter — true when a match
  in this competition finalized during the cycle, i.e. when the table actually moved.
- `runner` gains `snapshotted map[string]time.Time` (key `comp/season`, value the UTC
  day already recorded in this process).

**Cadence, and why it is what it is.** `refreshStandings` already runs on every slow
tick (5 minutes) and additionally whenever a match finalizes. Snapshotting on all of
those would be ~52,000 upserts a day for nine competitions to produce nine rows of
value. Snapshotting only once per day would peg every snapshot to ~00:05 UTC, before
any of that day's matches. So: **write on the first standings refresh of a new UTC day,
and again whenever a match finalized in this cycle.** The day key makes the extra writes
free of duplicates, and the day ends holding the table as it settled.

- [ ] **Step 1: Write the failing runner tests**

Append to `backend/ingester/runner_test.go`:

```go
// The cadence contract. refreshStandings runs every slow tick; snapshotting
// every one of those is ~52k upserts/day for nine rows of value. Once per UTC
// day is the floor.
func TestStandingsSnapshotWritesOncePerDay(t *testing.T) {
	repo := &fakeRepository{}
	worker := newTestRunner(repo)

	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls != 1 {
		t.Fatalf("snapshot calls = %d across two slow ticks in one day, want 1", repo.snapshotCalls)
	}
	if !hasLoggedKind(repo.logged, "standings_snapshot") {
		t.Fatal("the snapshot was not recorded in ingest_run")
	}
}

// A finished match is the only thing that moves a table, so it is the only
// reason to re-record a day already recorded. The store's day key makes the
// rewrite an update, not a duplicate.
func TestStandingsSnapshotRewritesTheDayWhenAMatchFinalizes(t *testing.T) {
	repo := &fakeRepository{}
	worker := newTestRunner(repo)

	worker.runCycle(context.Background(), true)
	worker.mu.Lock()
	before := repo.snapshotCalls
	worker.mu.Unlock()

	// The fake source's match finishes, so the next cycle finalizes it.
	worker.source.(*fakeSource).finished = true
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls <= before {
		t.Fatalf("snapshot calls = %d after a finalization, want more than %d",
			repo.snapshotCalls, before)
	}
}

// A restart empties the in-process day gate. The series must survive that --
// and it does, because the gate is an optimisation and the database holds the
// guarantee. A fresh runner re-writes today, and the store upserts it.
func TestStandingsSnapshotSurvivesARestart(t *testing.T) {
	repo := &fakeRepository{}
	newTestRunner(repo).runCycle(context.Background(), true)
	newTestRunner(repo).runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls != 2 {
		t.Fatalf("snapshot calls = %d across two processes, want 2", repo.snapshotCalls)
	}
	// The day the second process wrote must be the same day, so the store's
	// ON CONFLICT collapses them rather than appending a second table.
	if len(repo.snapshotDays) != 2 || !repo.snapshotDays[0].Equal(repo.snapshotDays[1]) {
		t.Fatalf("snapshot days = %v, want the same UTC day twice", repo.snapshotDays)
	}
}

// A rejected standings replacement must not be snapshotted. ReplaceStandings
// refuses an empty or shrinking table precisely because it is probably an
// upstream blip; recording that blip as a day of history would bake the blip
// in permanently.
func TestStandingsSnapshotSkipsARejectedReplacement(t *testing.T) {
	repo := &fakeRepository{standingsErr: store.ErrPartialReplacement}
	newTestRunner(repo).runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.snapshotCalls != 0 {
		t.Fatalf("snapshot calls = %d after a rejected replacement, want 0", repo.snapshotCalls)
	}
}
```

Add the `fakeRepository` fields and method. In the struct literal, after
`standingsErr    error`:

```go
	snapshotCalls   int
	snapshotDays    []time.Time
	snapshotErr     error
```

and the method, next to `ReplaceStandings`:

```go
func (f *fakeRepository) WriteStandingSnapshot(
	_ context.Context,
	_, _ string,
	standings []model.Standing,
	_ map[string]string,
	capturedAt time.Time,
) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshotCalls++
	f.snapshotDays = append(f.snapshotDays, utcDay(capturedAt))
	if f.snapshotErr != nil {
		return 0, f.snapshotErr
	}
	return len(standings), nil
}
```

`newTestRunner` is whatever helper the file already uses to build a `runner` around a
`fakeRepository` and `fakeSource`; if the existing tests construct the literal inline,
extract it into a helper first so the three tests above can share it — including the new
`snapshotted: make(map[string]time.Time)` field, which a `runner` literal that omits it
will nil-map-panic on write.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./ingester/ -run StandingsSnapshot
```

Expected: FAIL to compile —
`cannot use repo (variable of type *fakeRepository) as repository value ... missing method WriteStandingSnapshot`
and `undefined: utcDay`.

- [ ] **Step 3: Add the method to the repository contract**

In `backend/ingester/contracts.go`, inside the `// facts` half of the `repository`
interface, immediately after the `ReplaceStandings` line:

```go
	// WriteStandingSnapshot is the only write here whose absence is
	// irreversible: ESPN publishes the current table, not yesterday's, so a day
	// this does not record is gone. It is deliberately separate from
	// ReplaceStandings so it can only ever be called with rows that
	// replacement actually accepted.
	WriteStandingSnapshot(context.Context, string, string, []model.Standing, map[string]string, time.Time) (int, error)
```

- [ ] **Step 4: Add the day gate and the snapshot call**

In `backend/ingester/runner.go`, add to the `runner` struct, after
`backfillAttempted map[string]time.Time`:

```go
	// snapshotted is the UTC day each competition's standings snapshot has
	// already been written for IN THIS PROCESS. It is a cost gate, not the
	// idempotency guarantee -- that is the unique index in migration 0004. A
	// restart empties this map and the next cycle re-writes the day, which the
	// store upserts.
	snapshotted map[string]time.Time
```

Add the constant and helper next to `ingestRunRetention`:

```go
const standingSnapshotRunKind = "standings_snapshot"

// utcDay is the snapshot bucket: midnight UTC. Fixing the boundary in UTC for
// every competition is what lets a Liga MX series and a Premier League series
// share one x-axis. time.Truncate is deliberately not used -- it rounds
// relative to the zero time, not to a calendar day.
func utcDay(at time.Time) time.Time {
	at = at.UTC()
	return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
}
```

Replace the signature and tail of `refreshStandings`. The existing signature:

```go
func (r *runner) refreshStandings(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) error {
```

becomes:

```go
func (r *runner) refreshStandings(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	tableChanged bool,
) error {
```

and the existing tail:

```go
	if err == nil {
		for _, row := range rows {
			// The mirror keys crests by canonical team id, because that is what
			// SetTeamCrest writes against.
			team := row.Team
			team.ID = teamIDs[row.Team.ID]
			r.mirrorCrest(ctx, team)
		}
	}
	r.recordRun(ctx, comp.ID, "standings", start, err)
	return err
}
```

becomes:

```go
	if err == nil {
		for _, row := range rows {
			// The mirror keys crests by canonical team id, because that is what
			// SetTeamCrest writes against.
			team := row.Team
			team.ID = teamIDs[row.Team.ID]
			r.mirrorCrest(ctx, team)
		}
	}
	r.recordRun(ctx, comp.ID, "standings", start, err)
	if err != nil {
		// Only rows the replacement accepted get snapshotted. ReplaceStandings
		// rejects an empty or shrinking table because it is probably an
		// upstream blip; recording the blip as a day of history would bake it
		// in permanently, and unlike `standing` this table is never rewritten.
		return err
	}
	return r.snapshotStandings(ctx, comp, season, rows, teamIDs, tableChanged)
}

// snapshotStandings records the day's table. It is called only after
// ReplaceStandings committed, so the snapshot and the live table always agree.
//
// The error is RETURNED rather than swallowed. Player capture is additive and
// a failure there costs a re-fetch; a snapshot this cycle drops is a day of
// history that no provider can give back, so it must count towards the cycle's
// failures and show up in ingest_run.
func (r *runner) snapshotStandings(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	rows []model.Standing,
	teamIDs map[string]string,
	tableChanged bool,
) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	now := time.Now().UTC()
	day := utcDay(now)
	key := comp.ID + "/" + season.ID

	r.mu.Lock()
	recorded, seen := r.snapshotted[key]
	r.mu.Unlock()
	// A day already recorded is re-recorded only when a match finalized this
	// cycle, because that is the only thing that moves a table. Everything else
	// would be ~52k upserts a day to produce nine rows.
	if seen && recorded.Equal(day) && !tableChanged {
		return nil
	}

	start := time.Now()
	written, err := r.repo.WriteStandingSnapshot(
		ctx, comp.ID, season.ID, rows, teamIDs, now)
	r.recordRun(ctx, comp.ID, standingSnapshotRunKind, start, err)
	if err != nil {
		r.log.Error("standings snapshot failed; this day cannot be recovered",
			"comp", comp.ID, "season", season.ID, "day", day.Format(time.DateOnly),
			"err", err)
		return err
	}
	r.mu.Lock()
	r.snapshotted[key] = day
	r.mu.Unlock()
	r.log.Info("standings snapshot", "comp", comp.ID, "season", season.ID,
		"day", day.Format(time.DateOnly), "rows", written)
	return nil
}
```

Update the one call site, in `ingestCompSeason`:

```go
	var refreshErrors []error
	if matchResult.finalized || slowTick {
		refreshErrors = append(refreshErrors,
			r.refreshStandings(ctx, comp, season, matchResult.finalized),
			r.refreshTopScorers(ctx, comp, season),
		)
	}
```

- [ ] **Step 5: Initialise the map in production**

In `backend/ingester/main.go`, in the `worker := &runner{...}` literal, after
`backfillAttempted: make(map[string]time.Time),`:

```go
		snapshotted:       make(map[string]time.Time),
```

Omitting this is a nil-map assignment panic on the first successful snapshot — in
production, on the one write that matters. `go vet` will not catch it.

- [ ] **Step 6: Run the ingester suite**

```bash
cd backend && go test -race ./ingester/ -v -run StandingsSnapshot
```

Expected: four `--- PASS` lines —
`TestStandingsSnapshotWritesOncePerDay`,
`TestStandingsSnapshotRewritesTheDayWhenAMatchFinalizes`,
`TestStandingsSnapshotSurvivesARestart`,
`TestStandingsSnapshotSkipsARejectedReplacement`.

Then the whole package:

```bash
cd backend && go test -race ./ingester/
```

Expected: `ok  	github.com/mcasillas17/scorearc-backend/ingester`. The pre-existing
tests that call `refreshStandings` directly will fail to compile until you add the new
`tableChanged` argument to those call sites — pass `false`, which is what a plain slow
tick means.

- [ ] **Step 7: Commit**

```bash
git add backend/ingester/contracts.go backend/ingester/runner.go \
        backend/ingester/main.go backend/ingester/runner_test.go
git commit -m "feat: snapshot the standings table once per UTC day

Hangs off refreshStandings immediately after ReplaceStandings commits, so
a snapshot only ever contains rows the replacement guards accepted -- an
empty or shrinking table is rejected as an upstream blip, and recording
that blip as history would bake it in permanently.

Written once per UTC day, plus again whenever a match finalized in the
cycle, because that is the only thing that moves a table. The day gate is
in-process and is a cost optimisation; migration 0004's unique index is
the actual guarantee, so a restart re-writes the day rather than
duplicating it.

The error is returned rather than swallowed: a dropped snapshot is a day
of history no provider can give back.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Correct the architecture doc

**Files:**
- Modify: `docs/backend/ARCHITECTURE.md`

The doc currently files `standing_snapshot` under
`### Tier 3 — time-series (created now, WRITTEN in Phase 2 via emitSnapshots())`. That
heading is now wrong for half the section, and a stale doc is how the next agent
concludes the writer still does not exist and builds a second one.

- [ ] **Step 1: Re-file the table**

In `docs/backend/ARCHITECTURE.md`, replace the `standing_snapshot` bullet under
`### Tier 3` with:

```markdown
- **standing_snapshot**(id bigserial, competition_id, season_id, team_id→team, captured_at, **captured_on** (generated, UTC date), rank, points, goal_difference, played) — append-only, **WRITTEN** by the ingester since T7.1. One row per team per UTC day, upserted on `UNIQUE (competition_id, season_id, team_id, captured_on)` so a restart or redeploy refreshes the day instead of duplicating it. Written only after `ReplaceStandings` commits, so it can never contain a table the replacement guards rejected. The ingester has **no DELETE grant** here: a day ESPN has moved past cannot be re-fetched, so the series is append-only at the privilege level, not by convention.
```

and change the section heading to:

```markdown
### Tier 3 — time-series (append-only history)
```

- [ ] **Step 2: Verify no other line still claims it is unwritten**

```bash
grep -n "standing_snapshot\|emitSnapshots\|WRITTEN in Phase 2" docs/backend/ARCHITECTURE.md
```

Expected: the new bullet, the heading, and the `win_prob_snapshot` bullet — which is
still genuinely unwritten until T7.6 lands, and must keep saying so.

- [ ] **Step 3: Commit**

```bash
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: standing_snapshot is written now, not in Phase 2

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full gate, a real run, and the PR

- [ ] **Step 1: The three-command gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok` (Docker running), vet silent.

- [ ] **Step 2: Prove it against a real database, once**

`-once` runs one complete ingest cycle and exits. Point it at a scratch Postgres, not at
production, and connect as the least-privilege login — the same one production uses.

```bash
cd backend
docker run -d --name scorearc-snap -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
sleep 5
for f in migrations/*.up.sql; do
  docker exec -i scorearc-snap psql -U postgres -q < "$f"
done
docker exec -i scorearc-snap psql -U postgres -q <<'SQL'
CREATE ROLE ingest_local LOGIN PASSWORD 'ingest_local';
GRANT ingest_local TO postgres;
GRANT scorearc_ingester TO ingest_local;
GRANT USAGE ON SCHEMA public TO ingest_local;
SQL
export POOLED_DSN='postgres://ingest_local:ingest_local@localhost:55432/postgres?sslmode=disable'
export INGESTER_LEASE_DSN="$POOLED_DSN"
go run ./ingester -once
```

Expected: JSON log lines including at least one
`{"level":"INFO","msg":"standings snapshot","comp":"...","rows":N}` with `N` equal to
the number of clubs in that competition.

Now assert the property this whole plan exists for — run it **twice** and count:

```bash
go run ./ingester -once
docker exec -i scorearc-snap psql -U postgres -q -c \
  "SELECT competition_id, captured_on, count(*) AS rows
     FROM standing_snapshot GROUP BY 1,2 ORDER BY 1;"
```

Expected: one row per competition, all with today's date, and `rows` equal to that
competition's team count — **not double**. If any count doubled, the `ON CONFLICT`
target does not match the unique index; go back to Task 1.

Tear down:

```bash
docker rm -f scorearc-snap
```

- [ ] **Step 3: Confirm the DSN discipline**

```bash
grep -rn "POOLED_DSN\|INGESTER_LEASE_DSN" backend/ingester/main.go
grep -rn "postgres://" backend/ --include=*.go --include=*.toml --include=*.yml \
  | grep -v _test.go
```

Expected: `main.go` reads both from the environment, and the second grep prints
**nothing**. A DSN in a tracked file is a leaked credential; production values arrive
only via `fly secrets`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/ingester-standings-snapshots
gh pr create --title "feat: daily standings snapshots — the backend finally remembers" --body "$(cat <<'EOF'
## What

Implements **T7.1**, the only task on the product roadmap with a cost for waiting.

`standing_snapshot` has existed since migration `0002` and **nothing has ever written to
it** — grep confirmed the table name appeared only in the migration files. This is the
write.

- `0004_standing_snapshot_idempotency` adds a generated `captured_on` UTC date and
  `UNIQUE (competition_id, season_id, team_id, captured_on)`. The table previously had a
  `bigserial` primary key and no uniqueness at all, so any writer that ran twice on one
  day would have appended a second full table.
- `Store.WriteStandingSnapshot` writes one transactional batch per competition per day,
  upserting on the day key.
- The ingester writes on the first standings refresh of each UTC day, and again whenever
  a match finalized in that cycle — the only thing that moves a table.

## Why it could not wait

ESPN publishes the current table, not yesterday's. A day not recorded is gone forever.
Every trend, form curve, table-trajectory chart and the Brier score that would legitimise
a match simulator are functions of a series that only exists if we started recording
before we needed it.

**No UI is part of this PR, and none is required.** T7.3 and T7.5 render it later.

## Design notes

- The snapshot hangs off `refreshStandings` *after* `ReplaceStandings` commits, so it can
  never contain a table the replacement guards rejected as an upstream blip. `standing`
  gets rewritten every cycle; `standing_snapshot` never does.
- The in-process day gate is a **cost** optimisation. The unique index is the guarantee —
  that is what makes a restart, a redeploy and a crash-loop safe.
- Pre-season tables **are** recorded. ESPN ranks an unplayed table alphabetically (see
  E0/T0.1), so those rows are not a standing — but skipping them would make "the season
  had not started" indistinguishable from "the writer was down", which is the one thing a
  time series must never confuse. `played = 0` is on the row; filtering is the reader's job.
- **No `DELETE` grant** on `standing_snapshot`. Append-only is enforced by privilege, not
  by convention, and there is a test that fails if that changes.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` all clean (Docker running).
- Real-Postgres coverage of same-day idempotency, per-day growth, pre-season tables,
  empty and unresolved-team refusal, and the write executed **as `scorearc_ingester`**
  rather than as the schema owner — including a case that fails if the role ever gains
  `DELETE`.
- Ran `go run ./ingester -once` twice against a scratch Postgres as the least-privilege
  login: one row per team per competition per day, unchanged by the second run.

Plan: `docs/superpowers/plans/2026-08-15-ingester-standings-snapshots.md`
EOF
)"
```

- [ ] **Step 5: Stop**

Do **not** merge. Merging is the user's decision — see `AGENTS.md`.

---

## Self-review notes

- **Spec coverage.** The E7 spec's four verification bullets map to: "writes a snapshot
  per competition per day, idempotently" → Task 2 Steps 4/5 and Task 5 Step 2; "a re-run
  on the same date does not duplicate" → `TestStandingSnapshotIsIdempotentWithinADay` and
  Task 5 Step 2's double `-once`; "the series survives a deploy and a restart" →
  `TestStandingsSnapshotSurvivesARestart` plus the database-side key; "no UI is required"
  → stated in the PR body.
- **Naming consistency.** `captured_on` is defined in Task 1 Step 3 and used under that
  name in the `ON CONFLICT` target (Task 2 Step 3), the migration test (Task 1 Step 1) and
  the doc (Task 4). `snapshotted` is added in Task 3 Step 4 and initialised in Step 5.
  `tableChanged` is introduced in the signature in Step 4 and passed from `ingestCompSeason`
  in the same step.
- **Known ordering hazard.** Task 3 changes `refreshStandings`'s signature, which breaks
  every existing call site in `runner_test.go` until they pass the new argument. Called
  out in Task 3 Step 6. Do not "fix" it by giving the parameter a default — Go has none,
  and a variadic here would hide the one call site that matters.
- **The thing most likely to be got wrong.** Snapshotting before checking
  `ReplaceStandings`' error. `refreshStandings` returns early on `ErrEmptyReplacement` and
  `ErrPartialReplacement` *before* the snapshot call for exactly that reason; if you
  restructure that function, keep the ordering.
</content>
</invoke>
