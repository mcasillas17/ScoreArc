# Ingester — Win Probability Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record how a match's win/draw/win probability moved while it was being played,
one row per minute per match, so `win_prob_snapshot` stops being the second empty table
in the schema.

**Architecture:** `mapWinProbability` already computes a normalised three-way probability
from the first betting provider's moneylines on every summary fetch, and
`UpsertMatchDetail` already stores the **current** value in
`match_detail.win_probability`. Storing the current value overwrites the previous one, so
the shape of the swing — the thing that makes a live match readable after the fact — is
discarded 180 times per match. This plan appends each distinct minute instead. The write
sits in the existing summary block in `processMatches`, beside `WriteParticipation`, and
is bounded to **live matches only**: pre-match line movement is a different feature with
a different cadence and is explicitly out of scope here.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-history-and-trends-design.md`
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Task: T7.6** (new — not in the roadmap's
original task index; add it under E7)
**Branch:** `feat/ingester-win-prob-snapshots`

---

## ⚠️ Merge order and migration numbering

This plan adds migration **`0005_win_prob_snapshot_idempotency`**. It is only free after,
in this order:

1. **`feat/canonical-identity-impl`** — deletes `0003_ingester_delete_grant.*` and
   `0004_ingester_hardening.*`, folding them into a rewritten `0001`, and re-keys
   `win_prob_snapshot.match_id` to `uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE`.
2. **`feat/player-identity`** — adds `0003_player_capture.*`.
3. **T7.1** (`2026-08-15-ingester-standings-snapshots.md`) — adds `0004_*`.

**T7.1 is a prerequisite, not just a number reservation.** Do not start this plan before
it lands: T7.1 is the irreversible one, this one is not, and building them in parallel
means two agents editing `runner.go` and `contracts.go` at once.

```bash
ls backend/migrations/
```

Expected before you begin: `0001_init.*`, `0002_snapshots.*`, `0003_player_capture.*`,
`0004_standing_snapshot_idempotency.*`. If `0004` is missing, T7.1 has not landed — stop.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, and confirm it fails for the reason stated.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN` for writes, `INGESTER_LEASE_DSN` for the direct/unpooled advisory-lock
  session. Secrets via `fly secrets`, never in a file.
- `win_prob_snapshot` is **append-only**: no `DELETE` grant. `0001`'s
  `ALTER DEFAULT PRIVILEGES` already covers `SELECT, INSERT, UPDATE`.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## Scope boundary, stated once

**In:** a probability row per minute for every match while its state is `live`, plus the
final observation carried by the summary that finalizes it.

**Out, deliberately:**

- **Pre-match line movement.** A scheduled match's summary is fetched on slow ticks, so
  snapshotting those would write 288 rows a day for every fixture in every season — tens
  of thousands of rows to describe a market nobody is watching yet. If pre-match drift
  becomes a feature it needs its own cadence and its own bounded fixture window, not a
  quiet default here.
- **Calling this a model.** `mapWinProbability` is **market-implied**: the bookmaker's
  three-way moneyline with the margin removed. It is not ScoreArc's forecast and must
  never be presented as one. The Dixon–Coles simulator the roadmap contemplates is gated
  on a published Brier score computed against *our* history, and this table is one of the
  inputs that makes computing it possible — not a substitute for it.

---

## File Structure

- `backend/migrations/0005_win_prob_snapshot_idempotency.up.sql` / `.down.sql` — new.
- `backend/migrations/migrations_test.go` — one new case.
- `backend/shared/store/snapshots.go` — `WriteWinProbSnapshot` (append to the file T7.1
  created).
- `backend/shared/store/snapshots_integration_test.go` — new cases (append).
- `backend/ingester/contracts.go` — one method on `repository`.
- `backend/ingester/matches.go` — the call, beside `WriteParticipation`.
- `backend/ingester/runner_test.go` — `fakeRepository` method + two cases.
- `docs/backend/ARCHITECTURE.md` — re-file the table.

---

### Task 1: The per-minute key

**Files:**
- Create: `backend/migrations/0005_win_prob_snapshot_idempotency.up.sql`
- Create: `backend/migrations/0005_win_prob_snapshot_idempotency.down.sql`
- Test: `backend/migrations/migrations_test.go`

A live match is polled every 20 seconds (`fastInterval` in `schedule.go`). Three polls a
minute times a 100-minute match is 300 rows per match to describe about 100 distinct
states, and a retried cycle would add 300 more. The bucket is a minute, and the key
enforces it.

- [x] **Step 1: Write the failing migration test**

Append to `backend/migrations/migrations_test.go`:

```go
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
```

- [x] **Step 2: Run it and watch it fail**

```bash
cd backend && go test ./migrations/ -run WinProbSnapshot
```

Expected: FAIL —
`open 0005_win_prob_snapshot_idempotency.up.sql: no such file or directory`.

- [x] **Step 3: Write the migrations**

Create `backend/migrations/0005_win_prob_snapshot_idempotency.up.sql`:

```sql
-- win_prob_snapshot has existed since 0002 and nothing has ever written to it.
-- Before anything does it needs a bucket, because the write is driven by a
-- 20-second poll and the interesting unit is a minute.
--
-- Unlike standing_snapshot's captured_on, this bucket is NOT a generated
-- column: minute granularity is a WRITER POLICY (how finely we want the curve
-- sampled), not a fact derived from the row. Store.WriteWinProbSnapshot
-- truncates captured_at to the minute in UTC before inserting, and this index
-- is what makes that truncation binding instead of a convention someone can
-- quietly drop.
--
-- 0002 already created a NON-unique (match_id, captured_at) index for range
-- reads. Postgres will happily keep both; drop the redundant one, since a
-- unique index serves every query the plain one did.
DROP INDEX IF EXISTS win_prob_snapshot_match_idx;

CREATE UNIQUE INDEX win_prob_snapshot_minute_key
  ON win_prob_snapshot (match_id, captured_at);
```

Create `backend/migrations/0005_win_prob_snapshot_idempotency.down.sql`:

```sql
-- Drops the key and restores 0002's read index. Never drops the rows: a
-- probability curve is sampled from a live market that no longer exists once
-- the match ends, so it cannot be re-fetched.
DROP INDEX IF EXISTS win_prob_snapshot_minute_key;
CREATE INDEX IF NOT EXISTS win_prob_snapshot_match_idx
  ON win_prob_snapshot (match_id, captured_at);
```

- [x] **Step 4: Run the migration tests and prove the SQL applies**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`. The second command is the real check — the store integration harness
globs and applies every `*.up.sql` in order, so invalid SQL in `0005` aborts it with
`apply 0005_win_prob_snapshot_idempotency.up.sql: ...`.

- [x] **Step 5: Commit**

```bash
git add backend/migrations/0005_win_prob_snapshot_idempotency.up.sql \
        backend/migrations/0005_win_prob_snapshot_idempotency.down.sql \
        backend/migrations/migrations_test.go
git commit -m "feat: give win_prob_snapshot a per-minute idempotency key

A live match is polled every 20s, so an unkeyed table would hold ~300 rows
per match for ~100 distinct states, and a retried cycle would append
another 300.

The bucket is a writer policy rather than a generated column -- how finely
we sample the curve is a decision, not a fact derived from the row -- so
the writer truncates and this index makes the truncation binding.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `Store.WriteWinProbSnapshot`

**Files:**
- Modify: `backend/shared/store/snapshots.go`
- Test: `backend/shared/store/snapshots_integration_test.go`

**Interfaces:**
- `func (s *Store) WriteWinProbSnapshot(ctx context.Context, matchID uuid.UUID, probability model.WinProbability, capturedAt time.Time) error`
  — one row, truncated to the minute in UTC. A `nil` probability never reaches here; the
  caller checks.

- [x] **Step 1: Write the failing test**

Append to `backend/shared/store/snapshots_integration_test.go`:

```go
// mustSeedMatch inserts the minimum row win_prob_snapshot's foreign key needs.
// It goes through the resolver rather than raw SQL so the test exercises the
// same id-minting path production does.
func mustSeedMatch(t *testing.T, store *Store) uuid.UUID {
	t.Helper()
	matchID, err := store.Match(context.Background(), "espn", MatchRef{
		SourceID:      "401863609",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 15, 19, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("resolve match: %v", err)
	}
	return matchID
}

func winProbRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM win_prob_snapshot`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

// Three polls land inside one minute -- that is the 20s live cadence -- and
// must produce one row carrying the last of them.
func TestWinProbSnapshotCollapsesAMinute(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	base := time.Date(2026, 8, 15, 19, 42, 0, 0, time.UTC)
	for offset, p := range map[int]model.WinProbability{
		3:  {Home: 50, Draw: 26, Away: 24},
		23: {Home: 55, Draw: 24, Away: 21},
		47: {Home: 61, Draw: 21, Away: 18},
	} {
		if err := store.WriteWinProbSnapshot(ctx, matchID, p,
			base.Add(time.Duration(offset)*time.Second)); err != nil {
			t.Fatalf("write at +%ds: %v", offset, err)
		}
	}
	if got := winProbRows(t, pool); got != 1 {
		t.Fatalf("stored %d rows for one minute of polling, want 1", got)
	}

	var home float64
	var capturedAt time.Time
	if err := pool.QueryRow(ctx,
		`SELECT home, captured_at FROM win_prob_snapshot WHERE match_id=$1`,
		matchID).Scan(&home, &capturedAt); err != nil {
		t.Fatal(err)
	}
	if home != 61 {
		t.Fatalf("home = %v, want the last observation in the minute, 61", home)
	}
	// The stored instant is the bucket, not the poll: a curve plotted against
	// captured_at must have evenly spaced x values.
	if !capturedAt.UTC().Equal(base) {
		t.Fatalf("captured_at = %s, want it truncated to %s", capturedAt.UTC(), base)
	}
}

// The other half: consecutive minutes are the curve.
func TestWinProbSnapshotKeepsEachMinute(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	base := time.Date(2026, 8, 15, 19, 42, 0, 0, time.UTC)
	for minute := range 5 {
		if err := store.WriteWinProbSnapshot(ctx, matchID,
			model.WinProbability{Home: 40 + float64(minute), Draw: 30, Away: 30 - float64(minute)},
			base.Add(time.Duration(minute)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	if got := winProbRows(t, pool); got != 5 {
		t.Fatalf("stored %d rows across five minutes, want 5", got)
	}
}

// numeric(5,2) has two decimal places. A normalised probability like 33.333…
// must round rather than raise, or a three-way market that does not divide
// evenly would take down the write.
func TestWinProbSnapshotRoundsToTheColumnScale(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	if err := store.WriteWinProbSnapshot(ctx, matchID,
		model.WinProbability{Home: 33.333333, Draw: 33.333333, Away: 33.333334},
		time.Date(2026, 8, 15, 19, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("WriteWinProbSnapshot: %v", err)
	}
	var home, draw, away float64
	if err := pool.QueryRow(ctx,
		`SELECT home, draw, away FROM win_prob_snapshot WHERE match_id=$1`,
		matchID).Scan(&home, &draw, &away); err != nil {
		t.Fatal(err)
	}
	if home != 33.33 || draw != 33.33 || away != 33.33 {
		t.Fatalf("stored %v/%v/%v, want 33.33 each", home, draw, away)
	}
}

// Production writes as scorearc_ingester. A missing grant is a 42501 inside
// the ingester, not a failing test, unless a test connects as that role.
func TestWriteWinProbSnapshotAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, owner)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, owner)

	if _, err := pool.Exec(ctx, `
CREATE ROLE winprob_writer LOGIN PASSWORD 'winprob_writer';
GRANT scorearc_ingester TO winprob_writer;`); err != nil {
		t.Fatal(err)
	}
	asIngester, err := New(ctx,
		strings.Replace(dsn, "postgres:postgres@", "winprob_writer:winprob_writer@", 1))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(asIngester.Close)

	at := time.Date(2026, 8, 15, 19, 42, 0, 0, time.UTC)
	if err := asIngester.WriteWinProbSnapshot(ctx, matchID,
		model.WinProbability{Home: 50, Draw: 25, Away: 25}, at); err != nil {
		t.Fatalf("insert as scorearc_ingester: %v", err)
	}
	if err := asIngester.WriteWinProbSnapshot(ctx, matchID,
		model.WinProbability{Home: 60, Draw: 22, Away: 18}, at.Add(30*time.Second)); err != nil {
		t.Fatalf("same-minute update as scorearc_ingester: %v", err)
	}
	if got := winProbRows(t, pool); got != 1 {
		t.Fatalf("stored %d rows, want 1", got)
	}
	if _, err := asIngester.pool.Exec(ctx, `DELETE FROM win_prob_snapshot`); err == nil {
		t.Fatal("scorearc_ingester can DELETE win_prob_snapshot; history is not append-only")
	}
}
```

Add `"github.com/google/uuid"` to the file's imports.

- [x] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/store/ -run WinProbSnapshot
```

Expected: FAIL to compile —
`store.WriteWinProbSnapshot undefined (type *Store has no field or method WriteWinProbSnapshot)`.

- [x] **Step 3: Implement**

Append to `backend/shared/store/snapshots.go` (and add `"github.com/google/uuid"` to its
imports):

```go
// WriteWinProbSnapshot appends one point of a match's probability curve.
//
// The instant is truncated to the minute in UTC before it is stored, so the
// 20-second live poll produces one row per minute rather than three, and so a
// curve plotted against captured_at has evenly spaced x values. A second write
// inside the same minute replaces the first: later is fresher, and the curve
// should read as "where the market was at the end of minute N".
//
// This is a MARKET-implied probability -- the first betting provider's
// three-way moneyline with the margin removed, per mapWinProbability. It is
// not a ScoreArc forecast and nothing downstream may present it as one.
func (s *Store) WriteWinProbSnapshot(
	ctx context.Context,
	matchID uuid.UUID,
	probability model.WinProbability,
	capturedAt time.Time,
) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, winProbSnapshotSQL,
		matchID, capturedAt.UTC().Truncate(time.Minute),
		probability.Home, probability.Draw, probability.Away)
	return err
}

// The numeric(5,2) columns round on their own; the explicit ::numeric(5,2)
// casts document that and keep a float64 like 33.333333 from depending on
// implicit-cast behaviour.
const winProbSnapshotSQL = `
INSERT INTO win_prob_snapshot (match_id, captured_at, home, draw, away)
VALUES ($1,$2,$3::numeric(5,2),$4::numeric(5,2),$5::numeric(5,2))
ON CONFLICT (match_id, captured_at) DO UPDATE SET
	home = EXCLUDED.home,
	draw = EXCLUDED.draw,
	away = EXCLUDED.away`
```

Note `time.Time.Truncate(time.Minute)` is correct here in a way it is **not** for a day:
truncation is relative to the zero time, and minutes divide that boundary evenly while
calendar days do not. T7.1's `utcDay` builds a date explicitly for exactly that reason.

- [x] **Step 4: Run the tests**

```bash
cd backend && go test ./shared/store/ -run WinProbSnapshot -v
```

Expected: four `--- PASS` lines — `TestWinProbSnapshotCollapsesAMinute`,
`TestWinProbSnapshotKeepsEachMinute`, `TestWinProbSnapshotRoundsToTheColumnScale`,
`TestWriteWinProbSnapshotAsTheIngesterRole`.

- [x] **Step 5: Commit**

```bash
git add backend/shared/store/snapshots.go backend/shared/store/snapshots_integration_test.go
git commit -m "feat: append win probability snapshots per minute

mapWinProbability already runs on every summary fetch and its result was
being overwritten in match_detail 180 times a match, discarding the shape
of the swing. This appends it instead.

Truncated to the minute in UTC so the 20s live poll yields one row per
minute and a plotted curve has evenly spaced x values. A second write in
the same minute replaces the first -- later is fresher.

Market-implied, not a ScoreArc forecast; the comment says so where the
next reader will find it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Snapshot live matches from the ingester

**Files:**
- Modify: `backend/ingester/contracts.go`
- Modify: `backend/ingester/matches.go`
- Test: `backend/ingester/runner_test.go`

- [x] **Step 1: Write the failing tests**

Append to `backend/ingester/runner_test.go`:

```go
// A live match's probability is the whole point: it is the only state in which
// the market moves fast enough for a curve to mean anything.
func TestWinProbSnapshotWrittenForALiveMatch(t *testing.T) {
	repo := &fakeRepository{}
	source := &fakeSource{live: true, winProbability: &model.WinProbability{
		Home: 52, Draw: 25, Away: 23,
	}}
	worker := newTestRunnerWithSource(repo, source)

	worker.runCycle(context.Background(), false)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.winProb) != 1 {
		t.Fatalf("win prob writes = %d, want 1", len(repo.winProb))
	}
	if repo.winProb[0].Home != 52 {
		t.Fatalf("home = %v, want 52", repo.winProb[0].Home)
	}
}

// A scheduled match is polled on slow ticks all season. Snapshotting those
// would write ~288 rows a day for every fixture on the calendar to describe a
// market nobody is watching yet. Pre-match drift is a separate feature with a
// separate cadence.
func TestWinProbSnapshotSkippedForAScheduledMatch(t *testing.T) {
	repo := &fakeRepository{}
	source := &fakeSource{winProbability: &model.WinProbability{Home: 40, Draw: 30, Away: 30}}
	worker := newTestRunnerWithSource(repo, source)

	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.winProb) != 0 {
		t.Fatalf("win prob writes = %d for a scheduled match, want 0", len(repo.winProb))
	}
}

// Not every competition has a betting market, and mapWinProbability returns
// nil when there is no usable three-way moneyline. Writing 0/0/0 for those
// would be inventing a market -- worse than an empty curve, because a reader
// cannot tell the difference.
func TestWinProbSnapshotSkippedWhenTheMarketIsAbsent(t *testing.T) {
	repo := &fakeRepository{}
	worker := newTestRunnerWithSource(repo, &fakeSource{live: true, winProbability: nil})

	worker.runCycle(context.Background(), false)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.winProb) != 0 {
		t.Fatalf("win prob writes = %d with no market, want 0", len(repo.winProb))
	}
}

// The snapshot is additive. A failure here must be recorded and must not stop
// a scoreline from ingesting -- unlike the standings snapshot, a lost minute
// of a market curve is not a lost day of league history.
func TestWinProbSnapshotFailureDoesNotStopTheMatch(t *testing.T) {
	repo := &fakeRepository{winProbErr: errors.New("boom")}
	source := &fakeSource{live: true, winProbability: &model.WinProbability{Home: 52, Draw: 25, Away: 23}}
	worker := newTestRunnerWithSource(repo, source)

	worker.runCycle(context.Background(), false)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.matchCalls == 0 {
		t.Fatal("the match was not upserted; an additive write blocked a scoreline")
	}
	if !hasLoggedKind(repo.logged, "win_prob_snapshot") {
		t.Fatal("the failure was not recorded in ingest_run")
	}
}
```

Add to the `fakeSource` struct a `winProbability *model.WinProbability` field and have
its `Summary` method set `Detail.WinProbability` from it. Add to `fakeRepository`:

```go
	winProb    []model.WinProbability
	winProbErr error
```

and the method:

```go
func (f *fakeRepository) WriteWinProbSnapshot(
	_ context.Context,
	_ uuid.UUID,
	probability model.WinProbability,
	_ time.Time,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.winProbErr != nil {
		return f.winProbErr
	}
	f.winProb = append(f.winProb, probability)
	return nil
}
```

`newTestRunnerWithSource(repo, source)` is `newTestRunner` with the source injected;
extract it if the file does not already have it.

- [x] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./ingester/ -run WinProbSnapshot
```

Expected: FAIL to compile —
`*fakeRepository does not implement repository (missing method WriteWinProbSnapshot)`.

- [x] **Step 3: Add the contract**

In `backend/ingester/contracts.go`, immediately after the `WriteParticipation` line:

```go
	// WriteWinProbSnapshot appends one point of a live match's probability
	// curve. Like WriteParticipation it is additive: a failure is recorded and
	// never blocks a scoreline.
	WriteWinProbSnapshot(context.Context, uuid.UUID, model.WinProbability, time.Time) error
```

- [x] **Step 4: Call it beside the participation write**

In `backend/ingester/matches.go`, inside the summary block, immediately after the
`WriteParticipation` call and before its closing brace:

```go
			// The market only moves fast enough to be worth a curve while the
			// match is live. A scheduled match is polled on slow ticks all
			// season, and mapWinProbability returns nil for competitions with
			// no usable three-way moneyline -- writing 0/0/0 for those would
			// invent a market a reader could not distinguish from a real one.
			if match.State == model.MatchStateLive && detail.WinProbability != nil {
				start := time.Now()
				err := r.repo.WriteWinProbSnapshot(
					ctx, identity.MatchID, *detail.WinProbability, time.Now())
				r.recordRun(ctx, comp.ID, winProbSnapshotRunKind, start, err)
				if err != nil {
					r.log.Warn("win probability snapshot",
						"match", match.ID, "err", err)
				}
			}
```

and add the kind constant beside `standingSnapshotRunKind` in `runner.go`:

```go
const winProbSnapshotRunKind = "win_prob_snapshot"
```

Note the error is **logged and recorded, not returned**. That is the opposite of T7.1's
standings snapshot, and deliberately so: a standings day is irrecoverable league history,
whereas a missed minute of a market curve is one point on a line that is still being
drawn every twenty seconds.

- [x] **Step 5: Run the suite**

```bash
cd backend && go test -race ./ingester/ -v -run WinProbSnapshot
cd backend && go test -race ./ingester/
```

Expected: four `--- PASS` lines, then
`ok  	github.com/mcasillas17/scorearc-backend/ingester`.

- [x] **Step 6: Commit**

```bash
git add backend/ingester/contracts.go backend/ingester/matches.go backend/ingester/runner_test.go
git commit -m "feat: snapshot win probability while a match is live

Bounded to state == live on purpose. A scheduled match is polled on slow
ticks all season, so snapshotting those would write ~288 rows a day for
every fixture on the calendar to describe a market nobody is watching.

nil probability is skipped rather than written as 0/0/0 -- not every
competition has a three-way moneyline, and an invented market is worse
than an empty curve because a reader cannot tell them apart.

Additive: recorded in ingest_run, never blocks a scoreline.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Doc and gate

- [x] **Step 1: Re-file the table in the architecture doc**

In `docs/backend/ARCHITECTURE.md`, under `### Tier 3`, replace the `win_prob_snapshot`
bullet:

```markdown
- **win_prob_snapshot**(id bigserial, match_id→match ON DELETE CASCADE, captured_at (truncated to the minute, UTC), home, draw, away numeric(5,2)) — append-only, **WRITTEN** by the ingester since T7.6, for matches in state `live` only. `UNIQUE (match_id, captured_at)` collapses the 20-second live poll to one row per minute. The values are **market-implied** — the first betting provider's three-way moneyline with the margin removed, per `mapWinProbability` — and are not a ScoreArc forecast. Pre-match line movement is deliberately not recorded: a scheduled fixture is polled on slow ticks all season and would produce ~288 rows a day describing a market nobody is watching yet.
```

- [x] **Step 2: Full gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok`, vet silent.

- [x] **Step 3: Prove it on a real live match**

This one needs a competition with a match actually in play. Find one:

```bash
cd backend
docker run -d --name scorearc-wp -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:16-alpine
sleep 5
for f in migrations/*.up.sql; do docker exec -i scorearc-wp psql -U postgres -q < "$f"; done
docker exec -i scorearc-wp psql -U postgres -q <<'SQL'
CREATE ROLE ingest_local LOGIN PASSWORD 'ingest_local';
GRANT ingest_local TO postgres;
GRANT scorearc_ingester TO ingest_local;
GRANT USAGE ON SCHEMA public TO ingest_local;
SQL
export POOLED_DSN='postgres://ingest_local:ingest_local@localhost:55433/postgres?sslmode=disable'
export INGESTER_LEASE_DSN="$POOLED_DSN"
go run ./ingester -once
go run ./ingester -once
docker exec -i scorearc-wp psql -U postgres -q -c \
  "SELECT match_id, count(*) AS points, min(captured_at), max(captured_at)
     FROM win_prob_snapshot GROUP BY 1;"
docker rm -f scorearc-wp
```

Expected: **if a match was live**, one row per live match with `points` = the number of
distinct minutes the two runs spanned — normally 1, never 2 per minute. **If nothing was
live**, zero rows, which is the correct result and not a failure; say so explicitly in the
PR rather than claiming coverage you did not get. In that case
`TestWinProbSnapshotWrittenForALiveMatch` is the evidence.

- [x] **Step 4: Open the PR**

```bash
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: win_prob_snapshot is written for live matches now

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/ingester-win-prob-snapshots
gh pr create --title "feat: record win probability while a match is live (T7.6)" --body "$(cat <<'EOF'
## What

`win_prob_snapshot` was the second table in the schema that existed and had never been
written to. This writes it.

`mapWinProbability` already ran on every summary fetch, and `UpsertMatchDetail` already
stored the result — as the *current* value, overwriting the previous one roughly 180 times
per match. The shape of the swing, which is the only part of a probability that is
interesting after full time, was being discarded.

- `0005_win_prob_snapshot_idempotency` replaces 0002's plain `(match_id, captured_at)`
  index with a unique one.
- `Store.WriteWinProbSnapshot` truncates to the minute in UTC and upserts.
- The ingester writes only while `state == 'live'`.

## Scope, stated deliberately

- **Pre-match line movement is out.** A scheduled fixture is polled on slow ticks all
  season; snapshotting it would write ~288 rows a day per fixture about a market nobody is
  watching yet. If it becomes a feature it needs its own cadence and fixture window.
- **This is market-implied, not a forecast.** It is the first betting provider's three-way
  moneyline with the margin removed. The Dixon–Coles simulator the roadmap contemplates is
  gated on a published Brier score computed from *our* history; this table is an input to
  making that computable, not a substitute for it. The doc and the code comment both say so.
- `nil` probability is skipped, never stored as `0/0/0`. Not every competition has a
  three-way moneyline, and an invented market is worse than an empty curve because a reader
  cannot distinguish them.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Real Postgres: a minute of 20-second polls collapses to one row carrying the last
  observation; five minutes give five rows; `numeric(5,2)` rounding is asserted rather than
  assumed; and the write runs **as `scorearc_ingester`**, including a case that fails if
  that role ever gains `DELETE`.
- Ingester tests cover live-yes, scheduled-no, no-market-no, and failure-is-additive.

Plan: `docs/superpowers/plans/2026-08-15-ingester-win-probability-snapshots.md`
EOF
)"
```

- [x] **Step 5: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **Why the error handling differs from T7.1.** T7.1 returns its snapshot error so it
  counts as a cycle failure; this one logs and continues. That asymmetry is intentional and
  is stated in both the code comment (Task 3 Step 4) and the PR body: a missed standings
  day is irrecoverable league history, a missed minute of a market curve is one point on a
  line still being sampled every twenty seconds.
- **Why `Truncate` is safe here and not in T7.1.** `time.Time.Truncate` rounds relative to
  the zero time. Minutes divide that boundary evenly; calendar days do not, which is why
  T7.1 builds its date with `time.Date`. Noted at the implementation site.
- **Naming consistency.** `win_prob_snapshot_minute_key` is created in Task 1 Step 3, named
  in the migration test in Step 1, targeted by `ON CONFLICT` in Task 2 Step 3, and dropped
  by the rollback. `winProbSnapshotRunKind` is declared in Task 3 Step 4 and asserted in
  Step 1's failure test.
- **Ordering hazard.** Task 1 drops `win_prob_snapshot_match_idx`, which `0002` created. If
  a future migration is written against that name it will silently no-op; the rollback
  restores it.

---

## Implementation record — 2026-08-16

All checkboxes above reflect commands that were run and verified. The final implementation
is on PR #59; this worker did not merge it.

### Discrepancies from the quoted plan

- The plan says verbatim: **“In: a probability row per minute for every match while its
  state is `live`, plus the final observation carried by the summary that finalizes it.”**
  The linked spec says “Per live minute,” and every prescribed test, state condition,
  architecture edit, and PR contract is live-only. The coordinator explicitly chose that
  consistent live-only contract; no finished-state write was added.
- Task 2's same-minute test used a Go map while asserting which observation ran last.
  The implementation uses an ordered slice so the freshness assertion is deterministic.
- Task 3's red step expected a missing-interface-method compile error after the same step
  had already added the fake method. The actual red evidence was behavioral: zero live
  writes and no failed-write audit.
- Task 3's commit list omitted `backend/ingester/runner.go`, although Step 4 adds
  `winProbSnapshotRunKind` there. The file was included in the Task 3 commit.
- Repository instructions require the executing worker's identity, so commit trailers use
  Copilot rather than the plan author's Claude identity.
- Colima required the documented `DOCKER_HOST` and
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` exports before real-Postgres tests could run.
- Review found that the plan's unconditional same-minute upsert could let a delayed older
  response overwrite a fresher one. Migration `0005` therefore also adds and backfills
  `observed_at timestamptz NOT NULL`; the ingester captures it before the summary request,
  and the conflict update applies only when the incoming poll is at least as recent.
  A real-Postgres out-of-order test covers the guard. The down migration removes
  `observed_at`, restores 0002's index, and retains populated snapshot rows.
- While the PR was open, current `origin/main` was merged normally twice: first
  `db64f3c` (squad, athlete bio, and commentary integration), then `1c8c786` (T7.7 box
  score / migration `0006`). Conflict and adjacency tests preserved all features; no
  rebase, stack, or history rewrite was used.

### Verification evidence

- Required frontend gate: `npm ci`; competition export with a clean generated diff;
  25 Vitest files / 210 tests; TypeScript; lint; and production build all passed.
  Lint/build retained six pre-existing component warnings.
- Required backend gate: `go test -race ./...`, `go vet ./...`, and `go build ./...`
  passed with Docker-backed Postgres integration tests.
- Real live-provider proof reported `live=true`; two live matches produced one point each
  at `2026-08-16 22:41:00+00` across two runs in the same minute.
- Populated migration rollback proof retained the row, removed `observed_at` and the unique
  key, and restored `win_prob_snapshot_match_idx`.
- GitHub's push and pull-request CI runs passed on final reviewed head `b5b6fa3`.

### Independent review rounds

- A pre-integration Luna review on `eaefe23` was obsoleted when `origin/main` advanced and
  is not counted.
- Round 1 on `26ec478`: GPT-5.6 Luna reported one blocker — stale same-minute responses
  could overwrite fresher values. The `observed_at` guard and Postgres regression test
  resolved it.
- Round 2 on final head `b5b6fa3`: GPT-5.6 Luna and Claude Opus 5 each independently ran
  the full gate and reported **NO BLOCKERS**.

### Non-blocking follow-ups

- Shared-doc coordination should reconcile the stale Tier 3 heading and
  `standing_snapshot` bullet in `docs/backend/ARCHITECTURE.md`; this PR updates only the
  T7.6-owned `win_prob_snapshot` entry.
- Automated populated-down-migration coverage would strengthen the current SQL-text and
  whole-schema rollback checks. Both independent reviewers verified the populated `0005`
  rollback directly against Postgres, so this is coverage hardening rather than a known
  defect.
</content>
