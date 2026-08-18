# Live-Path Write Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ingester's **live-match write path** cost a number of database
statements proportional to the football that actually happened, not to the number of
20-second ticks multiplied by everything that has happened so far. Today one 2-hour
match is projected to cost **~47,000 statements to persist ~420 rows — 110:1** —
and **this code path has never executed in production** (see "Why this is urgent"),
so the ratio is a projection nobody has watched run. After this plan it is
**~2,100 statements, ~5:1**, and every one of the three worst offenders
(`match_commentary`, `appearance`, `match_event`) becomes **exactly one statement per
tick regardless of how far into the match it is**.

**Architecture:** One idea, applied three times.

Each of the three tables is written today by a Go loop that issues one `INSERT …
ON CONFLICT DO UPDATE` **per row it was handed**, plus a tail `DELETE`, on every
poll. The list it is handed is cumulative — ESPN's commentary at minute 90 is 113
lines, of which 112 were written on the previous tick and 111 on the one before —
so the loop rewrites the whole accumulated transcript to append one line.

Each becomes **one set-based statement**: the payload is passed as parallel arrays,
`unnest` turns it back into rows inside Postgres, and a single
`INSERT … SELECT … ON CONFLICT (…) DO UPDATE … WHERE <stored> IS DISTINCT FROM
<incoming>` converges the table. The `WHERE` on `DO UPDATE` is what makes the
rewrite disappear: a row whose stored content already equals the incoming content is
**not updated at all** — no tuple version, no WAL, no dead tuple, no autovacuum
debt. The tail `DELETE` folds into the same statement as a CTE, so a retraction still
works and costs nothing when there is nothing to retract. The statement returns
`(rows written, rows pruned)` so the caller — and the tests — can see the difference
between "converged" and "rewrote everything".

This is deliberately **not** a high-water mark and **not** an in-process memo (see
"How 'new' is determined", below, for why, and what that buys). The two remaining
changes are cadence, not shape: `ingest_run` stops recording one row per match per
poll for the two sampling operations, and `win_prob_snapshot` / `odds_snapshot` stop
issuing a statement for a minute bucket whose value they already wrote.

**Tech Stack:** Go 1.26, pgx v5.10.0, Postgres 16 (testcontainers) / 17 (Neon),
testcontainers-go v0.44 (**Docker must be running**).

**Spec:** `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
— **§4.4** ("Write the commentary tail, not the transcript") and **§4.5** ("Make
`ingest_run` coarse on the live path") are the two items this plan implements, with
§2's C1/C2/C5 classes as the vocabulary and §3.5 as the projection being attacked.
**Epic:** E7 (`docs/PRODUCT_ROADMAP.md`) — add **T7.16 (live-path write reduction)**
and **T7.17 (coarse live-path audit rows)** under it. Five sibling plans are landing
under E7 at the same time; if 7.16/7.17 are taken by the time you edit the roadmap,
take the next free pair and fix this header.
**Branch:** `fix/live-path-write-reduction` off latest `origin/main`

## Implementation record

Implemented on `mcasillas17-fix-live-path-write-reduction`, based on
`origin/main` at `3625016c4eb62b36f3f3a1f718bcd330853cb200`.

- The Task 1 tracer measured the expected baseline exactly: twelve ticks cost
  `[4 7 10 13 16 19 22 25 28 31 34 37]` commentary statements, or 246
  statements to persist 36 lines.
- The quoted Task 1 file imported `github.com/google/uuid` without using it.
  The import was removed before recording the behavioral failure.
- Task 2's old-code duplicate regression failed with `written = 4, want 3
  distinct lines`, not SQLSTATE 21000. The old row-at-a-time loop tolerates the
  duplicate but counts both inputs; SQLSTATE 21000 is the failure the new
  set-based statement would have without the last-wins deduplication.
- `origin/main` had replaced the plan's `finalized bool` odds API with
  `oddsCaptureMode`. The implementation throttles only `oddsCaptureLive`;
  final captures and fixed-row retries retain their newer completion-ledger and
  audit behavior.
- The sample memo clears its reservation after a failed odds or win-probability
  write. Without that correction, a failed first write would suppress the next
  poll in the same minute as though the value had reached Postgres.
- No migration was added. Unmeasured box-score values remain SQL `NULL`; the
  post-`COALESCE` comparison is covered by real-Postgres `xmin` assertions.
- There is no package-local ingester README. Shared architecture and roadmap
  updates are intentionally isolated in a separate docs PR from latest
  `origin/main`, per the coordination instruction.
- Independent review round 1 used Claude Opus 5 and GPT-5.6 Terra. Both ran the
  complete frontend/backend gate and reported no BLOCKING findings.

NON-BLOCKING follow-ups carried to the implementation PR:

- Decide whether the first all-unidentified, zero-row participation payload
  needs a separate once-per-match coverage signal; the current change gate can
  emit neither a row nor a warning in that edge case.
- Measure `player_capture` rows on the first live match. The report is now
  once per data change, not necessarily once per coverage gap, because changing
  player stats also make the converged write non-empty.
- Consider recording failures from their own start time and recording the first
  recovery immediately; the current audit window can backdate a failure across
  suppressed successes and suppress a recovery success for up to five minutes.
- Add focused tests for audit backdating/recovery/concurrency, cold-process
  sample gates, finalization cleanup, and fresh-pointer/nil digest stability.
- Make future nullable odds field types fail loudly in `sampleValue`; only the
  current `*int` and `*float64` fields are content-normalized.
- Clear sample memo entries for terminal transitions that do not pass through
  this process's `didFinalize` branch. The current leak is bounded to two small
  entries per such match for the process lifetime.

---

## 🔴 There is no migration in this plan. If you conclude you need one, it is `0020`.

The watermark is **15**. `0016`–`0019` are reserved by sibling plans landing in
parallel. **A migration numbered at or below the watermark silently never applies** —
`golang-migrate` records the highest applied version and skips anything below it,
with no error. That has bitten this project twice.

Nothing here needs one:

- No new column, table, index, constraint or grant. The `DELETE` grants
  `match_commentary`, `appearance` and `match_event` need already exist (migration
  `0013` line 80 for commentary, `0001`'s `ALTER DEFAULT PRIVILEGES` plus `0003` for
  the other two — the prune statements this plan writes are the same `DELETE`s the
  current code already issues, in a different position).
- The immutability triggers for these tables are **§4.6's** work, owned by the
  schema-invariants sibling plan. This plan does not add, remove or depend on them.

If you find yourself writing SQL DDL, stop: you have wandered into a sibling's slice.

---

## Why this is urgent, and what "unmeasured" means here

`pg_stat_user_tables` shows `appearance`, `match_event`, `match_commentary` and
`match_play` with **inserts ≈ live rows and ~zero updates**. That is not evidence
that these paths are cheap. It is evidence that **no match has been ingested while
live since the backend deployed**: every row in the database was written by a single
finalization pass per match (spec §0). The 20-second path runs for the first time on
the next matchday, untested.

`docs/research/2026-08-18-espn-payload-volatility.md` **could not measure a live
match either** — it sampled scheduled and finished fixtures. So this plan treats
in-play provider behaviour as **unknown** and designs against the worst plausible
case rather than citing that document as evidence. Concretely, three assumptions
this plan refuses to make:

| Tempting assumption | Why it is refused | What is done instead |
|---|---|---|
| "Commentary is append-only; old lines never change." | Unverified. ESPN is known to revise wording after publication, and nobody has watched it in-play. | Every poll content-compares **every** line. An edit anywhere is caught, and costs one row write. |
| "`sequence` is dense and unique within a payload." | Unverified, and a duplicate raises `SQLSTATE 21000` (`ON CONFLICT DO UPDATE command cannot affect row a second time`) — which would fail the **whole** write, not one line. Verified experimentally: a duplicate key in the source rows errors even when neither copy would change anything. | The payload is deduplicated in Go before it reaches SQL, last occurrence wins, with a test. |
| "A live poll always carries a stats block." | The existing `COALESCE` in the appearance upsert exists precisely because it does not. | The change-detection predicate compares against the **post-`COALESCE`** value, so a stats-less poll is a proven no-op rather than a rewrite. |

---

## How "new" is determined, and what happens to late edits

**Decision: "new" is determined by content comparison on the primary key, performed
by Postgres, inside the same statement that writes.** `match_commentary`'s key is
`(match_id, seq)`; `appearance`'s is `(match_id, player_id)`; `match_event`'s is
`(match_id, seq)`. A row is written when it is absent, or when any stored column
differs from the incoming one. Everything else is skipped by the `WHERE` clause on
`ON CONFLICT … DO UPDATE`.

Three alternatives were considered and rejected:

1. **A high-water `seq` per match, held in the runner** (what spec §4.4 proposes).
   Cheapest — zero extra reads — but it makes the tail a *decision* made from
   process memory, and that memory has three failure modes the store cannot see: a
   restart mid-match (empty map → one full transcript rewrite, harmless), a match
   whose provider renumbers (silently skips real lines, **not** harmless), and late
   edits (§4.4 patches this with a fixed ~10-line re-check window, which is a guess
   at a number nobody has measured). It also splits the invariant across the
   store/runner seam — the same criticism §4.6 makes of C1 being "a policy living in
   the caller instead of the schema".
2. **A row count.** Strictly worse than a high-water mark: it cannot survive a
   retraction, and it cannot see an edit at all.
3. **A `SELECT max(seq)` probe before each write.** Restart-safe, but it is one extra
   round trip per match per poll to reproduce a decision the `INSERT` can make for
   free, and it still needs the arbitrary re-check window.

**The chosen design has no window and no watermark**, because the comparison covers
the whole payload every time. The cost of that is not zero, and it is stated plainly:
the full transcript (~113 lines, ~17 kB) is uploaded to Postgres on every poll, and
Postgres performs ~113 primary-key probes to decide that 112 of them are unchanged.
That is one statement, index lookups only, no writes — versus 113 statements each
producing a dead tuple today. Per match: ~7 MB uploaded over two hours; with ten
simultaneous matches, ~8.5 kB/s. That is the trade, and it is a good one.

**Late edits, stated plainly:** they are handled, everywhere in the transcript, at
zero marginal cost — because the comparison is not restricted to a tail. A line
revised at minute 12 and re-published at minute 80 is rewritten on the next poll.
There is no reconciliation pass, no periodic full rewrite, and no residual class of
edit that only becomes visible at full time. This is the single largest reason to
prefer content comparison over a watermark, and it was verified experimentally before
this plan was written (see the evidence block below).

**Correctness on restart:** trivially satisfied, because there is no process state to
lose. A cold ingester's first poll of a match already in progress converges the table
in one statement: absent rows are inserted, present rows are compared and left alone.
It cannot skip a line already written (it compares every line) and it cannot duplicate
one (the primary key is the conflict target). A second process racing the first —
which the advisory lease already prevents, but which a `-once` run could still
produce — converges to the same state.

### Evidence: this was run against a real Postgres before the plan was written

A scratch `postgres:16-alpine` with the exact statement shape from Task 2, driven
through six ticks:

```
tick1 (10 new):      written=10 pruned=0
tick2 (identical):   written=0  pruned=0
tick3 (3 appended):  written=3  pruned=0
tick4 (late edit@2): written=1  pruned=0     <- an edit to line 2 at tick 4
tick5 (retract 2):   written=0  pruned=2
rows=11 seq2="line 2 (corrected)"
tick6 (2 appended): pre-existing rows rewritten=0 of 11   <- by xmin
match_event nullable uuid array: written=2
match_event identical replay:    written=0
appearance tick1: written=2 pruned=0
appearance tick2 (stats block absent): written=0 pruned=0  <- COALESCE no-op proven
appearance tick3 (roster shrinks, goals 1->2): written=1 pruned=1
appearance p1 goals=2
```

Task 1 rebuilds this as a real, committed test. The `xmin` line is the important
one: **pre-existing rows keep their tuple version**, which is what "no rewrite"
means at the storage layer.

---

## The projection, before and after

Per one 2-hour match at the 20-second fast tick (360 polls), using the spec's own
per-match content sizes: 114 commentary lines, 44 appearances, ~24 events. "Before"
is spec §3.5 verbatim. Data statements only, transaction control counted separately,
same convention as the spec.

| write | before | after | durable rows |
|---|---:|---:|---:|
| `match` UPDATE | 360 | **360** — unchanged, §4.2 sibling | 1 |
| `match_detail` UPDATE | 360 | **360** — unchanged, audited below | 1 |
| `appearance` upserts + tail delete | ~16,200 | **360** | 44 |
| `match_event` upserts + tail delete | ~8,600 | **360** | 24 |
| `match_commentary` upserts + tail delete | ~20,900 | **360** | 114 |
| `win_prob_snapshot` | 360 | **~120** | 120 |
| `odds_snapshot` | 360 | **~120** | 120 |
| `ingest_run` | 720 | **~50** | 50 |
| **total** | **≈47,000** | **≈2,090** | **≈420** |

**110 statements per durable row becomes 5.** A Saturday with ten simultaneous
matches goes from ~470,000 writes in two hours to ~21,000.

Tuple *writes* — the number that drives WAL, bloat and autovacuum — fall further,
because 720 of the remaining 2,090 statements (`match` + `match_detail`) are
single-row updates the siblings own, and the three converged statements write only
rows that changed: **~46,000 tuple versions becomes ~1,400**.

Two thirds of what is left is owned by other plans. After §4.2 (`match` no-op guard)
and §4.3 (scheduled-detail TTL) land, the live path is ~1,400 statements per match.

---

## Audit of the rest of the live path

The brief asks whether `appearance`, `match_event`, `match_play` and `match_detail`
share the full-rewrite-per-tick pattern. Answers, from the code:

| write | on the live tick? | full rewrite per tick? | disposition |
|---|---|---|---|
| `match_commentary` | yes, every poll | **yes** — every line, plus a tail `DELETE` | **fixed, Task 2** |
| `appearance` | yes, every poll | **yes** — every roster row, plus a tail `DELETE` | **fixed, Task 3** |
| `match_event` | yes, every poll | **yes** — every event, plus a tail `DELETE` | **fixed, Task 4** |
| `match_play` | **no** | n/a | **no change.** `capturePlays` is called only inside the `didFinalize` branch of `processMatches` (`ingester/matches.go`) and from the slow-tick `retryMissingPlayStreams` backlog. Its own doc comment states why: a live stream is ~1,500 plays over two pages and polling it every 20 s would be eighteen requests a minute per match. Task 8 adds a regression test so this stays true. |
| `match_detail` | yes, every poll | **no** — one `INSERT … ON CONFLICT` for one row | **no change, deliberately.** It is 1 statement/tick, not N. The ~5 kB tuple *is* rewritten every tick, but during a live match its content genuinely moves: it embeds the running stats block, the scorers/cards arrays and the growing `commentary` array. A content guard would fire rarely and cost a 12-column `IS DISTINCT FROM` duplicated from the `SET` list. The redundant case is the **scheduled** one (0 of 82 rows changed across a tick, spec §3.2) and that is §4.3's, not this plan's. Task 8 pins the per-tick statement count at 1 so a future change cannot quietly make it N. |
| `win_prob_snapshot` | yes, every poll | no — 1 statement/tick, 3 of every 3 writing the same minute bucket | **fixed, Task 7** (bucket+value dedupe, §5's "the writer should additionally skip a statement whose bucket and value both match the last one it wrote"). The pre-match sampling ladder in §5 is **not** in scope: it is coupled to the scheduled-match TTL, which is a sibling's. |
| `odds_snapshot` | yes, every poll | no — 1 statement per bookmaker/tick | **fixed, Task 7**, same rule. |
| `ingest_run` | yes — **two rows per match per poll** | n/a | **fixed, Task 6.** 720 rows per match per 2 h, plus up to 360 more from `reportParticipation` when any athlete id is missing. |
| `player_capture` coverage rows | yes, whenever anything is unidentified | n/a | **fixed, Task 4.** `reportParticipation` writes an `ingest_run` row per match per poll whenever one athlete id is missing; it is gated on the write having actually changed something. |

---

## What this plan does not touch

Five sibling plans are in flight against the same spec. Explicit boundaries:

- **`ReplaceLeaders`' double write / `leaderCrestsChanged`** (§4.1) — not touched.
- **The competition-level content memo** (`written map[string]uint64`, §4.1) — not
  touched. Task 7 adds a *per-match* sample memo keyed by `matchID + kind`; if §4.1's
  generic memo lands first the two are independent maps and the key spaces cannot
  collide.
- **The `match` upsert no-op guard and `MatchRow`'s new columns** (§4.2) — not
  touched. `store.MatchRow` is not modified by this plan.
- **The scheduled-match summary TTL** (§4.3) — not touched. `needsSummary` in
  `ingester/schedule.go` is not modified.
- **The C1 immutability triggers** (§4.6) — not touched, and no migration.
- **`docs/superpowers/plans/2026-08-18-postgres-storage-reduction.md` Task 5** drops
  `match_commentary.play_type_text` and narrows `period` to `smallint`. That plan and
  this one both rewrite `commentaryUpsertSQL`. **They conflict textually, not
  structurally**: if it lands first, drop `play_type_text` from the array list, the
  `INSERT` column list and the `IS DISTINCT FROM` tuple, and change `$3::int[]` to
  `$3::smallint[]`. The pattern is unaffected. Say so in the PR body.

---

## Global Constraints

- **No migration.** See the red box. If you become convinced one is needed, it is
  `0020`, and you should stop and ask the user first — it almost certainly means you
  have crossed into a sibling's slice.
- Backend gate, all three, from `backend/`:
  `go build ./... && go vet ./... && go test -race ./...`
  (testcontainers packages need **Docker running**).
- Frontend gate unchanged and still required by CI: `npm test`, `npx tsc --noEmit`,
  `npm run lint`, `npm run build`. Nothing in `src/**` changes, so these are a
  confirmation, not a risk.
- **Real-Postgres coverage is mandatory for every store change in this plan.** This
  path has never run; a unit test against a fake proves nothing about
  `ON CONFLICT … WHERE`. Every store task ends with a testcontainers integration
  test.
- **No wall-clock timing in tests.** Tick sequences are explicit
  (`base.Add(20*time.Second*n)`), the runner gets an injectable `now func() time.Time`
  in Task 6, and no test may call `time.Sleep` or assert on elapsed real time.
- Never print a DSN or a credential into a commit, a log or a PR body.
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.
- **Never push to `main`.** Feature branch, PR, and the merge is the user's call.

---

## File Structure

**New:**
- `backend/shared/store/livepath_integration_test.go` — the statement-counting
  harness (a pgx `QueryTracer`/`BatchTracer`), the simulated tick sequence, and the
  scaling assertions. Package `store`, so it can build a `&Store{pool: …}` with a
  traced pool without changing production code.

**Modified:**
- `backend/shared/store/commentary.go` — `commentaryUpsertSQL` → `commentaryConvergeSQL`
  (one set-based statement), `dedupeCommentary`, `commentaryArgs`; `WriteCommentary`
  returns rows **written** rather than rows **received**.
- `backend/shared/store/commentary_integration_test.go` — the two existing tests'
  return-value expectations, plus a duplicate-`seq` regression test.
- `backend/shared/store/participation.go` — `appearanceConvergeSQL`,
  `eventConvergeSQL`, `appearanceArgs`, `eventArgs`, `boxScoreArgs` →
  `boxScoreColumns`; `WriteParticipation`'s two loops collapse to two statements;
  `reportParticipation` gated on an actual change.
- `backend/shared/store/participation_integration_test.go` — a convergence test and
  a duplicate-player regression test.
- `backend/ingester/runner.go` — `now func() time.Time` + `clock()`;
  `sampleAudit map[string]auditWindow` + `recordSample`; `liveSamples
  map[string]liveSample` + `sampleUnchanged`/`rememberSample`/`forgetSamples`.
- `backend/ingester/odds.go` — `captureOdds` audits through `recordSample` while
  live, `recordRun` at finalization; skips a snapshot write whose bucket and prices
  it already wrote.
- `backend/ingester/matches.go` — the win-probability write skips an unchanged
  bucket+value; `forgetSamples` on finalization.
- `backend/ingester/main.go` — the two new maps in the `runner` literal.
- `backend/ingester/runner_test.go` — `testRunner` gains the two maps and a fixed
  clock; new tests for audit throttling and sample dedupe.
- `docs/backend/ARCHITECTURE.md` — the live-path write policy, in one short section.
- `docs/PRODUCT_ROADMAP.md` — T7.16 / T7.17 under E7.

**Deliberately NOT modified** — checked:
- `backend/reader/**` — no reader endpoint's behaviour changes. `/v1/ingest-freshness`
  (T10.10, `docs/superpowers/plans/2026-08-18-api-health-and-provenance.md`) reads
  `ingest_run` by `(competition_id, kind)`; Task 6 preserves every `kind` it reads
  and never lengthens the gap between rows beyond 5 minutes. See Task 6 for the
  argument in full.
- `backend/ingester/schedule.go`, `backend/ingester/plays.go`,
  `backend/shared/store/matches.go`, `backend/migrations/**` — sibling slices.
- `src/**` — the frontend still reads ESPN directly.

---

### Task 1: Branch, and prove the current cost with a failing test

**Files:**
- Create: `backend/shared/store/livepath_integration_test.go`

You cannot claim a reduction without a before, and the "before" for this path has
never been observed. This task builds the instrument first: a pgx tracer that counts
**every statement the store issues**, per table, so the assertion is on real protocol
traffic rather than on a fake's call count.

**Why a pgx tracer and not `pg_stat_statements` or `pg_stat_user_tables`.**
`pg_stat_user_tables` counters are flushed asynchronously (`PGSTAT_MIN_INTERVAL`),
so an assertion on them is a race. `pg_stat_statements` needs
`shared_preload_libraries` set at server start, which means a second container
configuration for the whole suite. `pgx.ConnConfig.Tracer` is exact, synchronous,
and needs no production change: `Store`'s own doc comment guarantees that a bare
`&Store{pool: …}` literal is valid, and this test file is in package `store`.

- [x] **Step 1: Branch**

```bash
git fetch origin && git checkout -b fix/live-path-write-reduction origin/main
```

Expected: `Switched to a new branch 'fix/live-path-write-reduction'`.

- [x] **Step 2: Write the harness and the failing test**

Create `backend/shared/store/livepath_integration_test.go`:

```go
package store

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// statementCounter counts every statement the store issues, per table.
//
// It traces the pgx connection rather than reading pg_stat_user_tables because
// the statistics collector flushes asynchronously and an assertion on it would
// be a race. Batched queries are counted individually: pgx calls
// TraceBatchQuery once per queued statement, which is exactly the property this
// file exists to measure -- a 113-statement batch is 113 statements.
type statementCounter struct {
	mu      sync.Mutex
	byTable map[string]int
}

// countedTables are matched as substrings of the SQL. They are distinct enough
// that no statement counts twice: the commentary statement never mentions
// appearance, and the identity queries WriteParticipation runs first mention
// neither.
var countedTables = []string{"match_commentary", "appearance", "match_event"}

func newStatementCounter() *statementCounter {
	return &statementCounter{byTable: make(map[string]int)}
}

func (c *statementCounter) record(sql string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, table := range countedTables {
		if strings.Contains(sql, table) {
			c.byTable[table]++
		}
	}
}

func (c *statementCounter) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byTable = make(map[string]int)
}

func (c *statementCounter) count(table string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byTable[table]
}

func (c *statementCounter) TraceQueryStart(
	ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData,
) context.Context {
	c.record(data.SQL)
	return ctx
}

func (c *statementCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (c *statementCounter) TraceBatchStart(
	ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData,
) context.Context {
	return ctx
}

func (c *statementCounter) TraceBatchQuery(
	_ context.Context, _ *pgx.Conn, data pgx.TraceBatchQueryData,
) {
	c.record(data.SQL)
}

func (c *statementCounter) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {}

var _ pgx.QueryTracer = (*statementCounter)(nil)
var _ pgx.BatchTracer = (*statementCounter)(nil)

// newTracedStore boots the same migrated Postgres every other integration test
// uses, then opens a SECOND pool with a tracer attached and wraps it in a bare
// Store literal -- which store.go documents as safe, because the identity cache
// initialises on first use.
func newTracedStore(t *testing.T) (*Store, *pgxpool.Pool, *statementCounter) {
	t.Helper()
	_, admin, dsn := newIntegrationStoreDSN(t)

	counter := newStatementCounter()
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = counter
	// One connection, so a statement can never be attributed to a tick that had
	// already finished on another.
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &Store{pool: pool}, admin, counter
}

// liveTick is one 20-second poll of a match in progress. Everything is derived
// from the tick number: no wall clock is read anywhere in this file.
const liveTickInterval = 20 * time.Second

var liveMatchKickoff = time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)

func liveTickAt(tick int) time.Time {
	return liveMatchKickoff.Add(time.Duration(tick) * liveTickInterval)
}

// growingTranscript is what ESPN hands back on tick N: the whole accumulated
// commentary, three lines longer than the tick before. That cumulative shape is
// the entire problem this plan exists to fix.
func growingTranscript(tick int) []model.CommentaryLine {
	lines := make([]model.CommentaryLine, 0, tick*3)
	for seq := 1; seq <= tick*3; seq++ {
		period, clock := 1, seq
		wallclock := liveTickAt(seq)
		lines = append(lines, model.CommentaryLine{
			Seq: seq, Period: &period, ClockValue: &clock, ClockDisplay: "",
			PlayType: "pass", PlayTypeText: "Pass", Wallclock: &wallclock,
			Text: fmt.Sprintf("Minute %d: a pass.", seq),
		})
	}
	return lines
}

// A live match is polled every 20 seconds for two hours. The number of
// statements that costs must be a function of the number of TICKS, never of how
// much football has already been played -- otherwise the 90th minute costs
// ninety times the first.
func TestCommentaryTickCostDoesNotGrowWithTheTranscript(t *testing.T) {
	store, pool, counter := newTracedStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	const ticks = 12
	perTick := make([]int, ticks+1)
	written := make([]int, ticks+1)
	for tick := 1; tick <= ticks; tick++ {
		counter.reset()
		rows, err := store.WriteCommentary(ctx, matchID, growingTranscript(tick))
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		perTick[tick] = counter.count("match_commentary")
		written[tick] = rows
	}

	// The cost of a tick is constant.
	for tick := 2; tick <= ticks; tick++ {
		if perTick[tick] != perTick[1] {
			t.Fatalf("tick %d issued %d statements against match_commentary, tick 1 issued %d: "+
				"cost scales with the accumulated transcript, not with new lines (all ticks: %v)",
				tick, perTick[tick], perTick[1], perTick[1:])
		}
	}
	if perTick[1] != 1 {
		t.Fatalf("one tick = %d statements, want exactly 1", perTick[1])
	}

	// And what it writes is exactly the three new lines.
	for tick := 2; tick <= ticks; tick++ {
		if written[tick] != 3 {
			t.Fatalf("tick %d wrote %d rows, want the 3 new lines only (all ticks: %v)",
				tick, written[tick], written[1:])
		}
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID); got != ticks*3 {
		t.Fatalf("stored rows = %d, want %d", got, ticks*3)
	}
}
```

- [x] **Step 3: Watch it fail, and record the number**

```bash
cd backend && go test ./shared/store/ -run TestCommentaryTickCostDoesNotGrowWithTheTranscript -v 2>&1 | tail -20
```

Expected — the failure names today's behaviour exactly:

```
    livepath_integration_test.go:...: tick 2 issued 7 statements against match_commentary, tick 1 issued 4: cost scales with the accumulated transcript, not with new lines (all ticks: [4 7 10 13 16 19 22 25 28 31 34 37])
--- FAIL: TestCommentaryTickCostDoesNotGrowWithTheTranscript (….s)
FAIL
```

Tick N today is `3N` upserts plus one tail `DELETE`, so `3N+1`; `BEGIN` and `COMMIT`
are not counted because they carry no table name. Twelve ticks of a match that grows
three lines at a time cost **246 statements** to store 36 rows. Write down whatever
your run prints — it is the baseline the PR body quotes.

- [x] **Step 4: Commit the instrument**

```bash
git add backend/shared/store/livepath_integration_test.go
git commit -m "test: count live-tick statements per table with a pgx tracer

The live write path has never executed in production. This adds the
instrument before the fix: a QueryTracer/BatchTracer that counts every
statement the store issues, and a twelve-tick simulation of a match in
progress. It fails today, which is the point.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Converge commentary in one statement

**Files:**
- Modify: `backend/shared/store/commentary.go`
- Modify: `backend/shared/store/commentary_integration_test.go`

**Interfaces:** `WriteCommentary(ctx, matchID, lines) (int, error)` keeps its
signature — the runner needs no change — but the `int` changes meaning from *lines
received* to **rows actually written**. That is the observable the whole plan turns
on, both existing callers ignore it (`ingester/matches.go` uses `_`), and a return
value that always equalled its input was telling nobody anything.

- [x] **Step 1: Write the failing tests**

In `backend/shared/store/commentary_integration_test.go`, update the two existing
expectations and add the duplicate-`seq` regression. Replace the body of
`TestWriteCommentaryUpsertsAsTheMatchGrows`'s assertion block:

```go
	written, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25))
	if err != nil {
		t.Fatal(err)
	}
	// 25 lines arrived; 10 of them were already stored, byte for byte. The
	// return value is what was WRITTEN, which is the only number that says
	// whether a 20-second poll cost anything.
	if written != 15 {
		t.Fatalf("written = %d, want the 15 new lines only", written)
	}
```

and append two new tests to the same file:

```go
// A poll that brings nothing new must cost nothing. This is the whole live
// path in one assertion.
func TestWriteCommentaryIsANoOpWhenNothingChanged(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(30)); err != nil {
		t.Fatal(err)
	}
	var before []string
	rows, err := pool.Query(ctx,
		`SELECT xmin::text FROM match_commentary WHERE match_id=$1 ORDER BY seq`, matchID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		before = append(before, version)
	}
	rows.Close()

	written, err := store.WriteCommentary(ctx, matchID, commentaryFixture(30))
	if err != nil {
		t.Fatal(err)
	}
	if written != 0 {
		t.Fatalf("re-writing an unchanged transcript wrote %d rows, want 0", written)
	}

	// xmin is the proof. A row whose tuple version changed was rewritten, even
	// if its contents are identical -- and that is what costs WAL and vacuum.
	after, index := make([]string, 0, len(before)), 0
	rows, err = pool.Query(ctx,
		`SELECT xmin::text FROM match_commentary WHERE match_id=$1 ORDER BY seq`, matchID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		after = append(after, version)
		index++
	}
	if len(after) != len(before) {
		t.Fatalf("rows = %d, want %d", len(after), len(before))
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("line %d was rewritten (xmin %s -> %s) despite identical content",
				i+1, before[i], after[i])
		}
	}
}

// ESPN's `sequence` is not guaranteed unique within one payload, and a
// duplicate in the source rows of a set-based upsert raises SQLSTATE 21000 --
// which would fail the ENTIRE write, not one line. Last occurrence wins,
// matching the old row-at-a-time loop's behaviour.
func TestWriteCommentaryToleratesADuplicateSequence(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	lines := commentaryFixture(3)
	corrected := lines[1]
	corrected.Text = "Corrected."
	lines = append(lines, corrected)

	written, err := store.WriteCommentary(ctx, matchID, lines)
	if err != nil {
		t.Fatalf("a duplicate sequence failed the whole write: %v", err)
	}
	if written != 3 {
		t.Fatalf("written = %d, want 3 distinct lines", written)
	}
	var text string
	if err := pool.QueryRow(ctx,
		`SELECT text FROM match_commentary WHERE match_id=$1 AND seq=2`, matchID).Scan(&text); err != nil {
		t.Fatal(err)
	}
	if text != "Corrected." {
		t.Fatalf("seq 2 = %q, want the last occurrence to win", text)
	}
}
```

Run them; all three fail (`written = 25, want the 15 new lines only`, then a `21000`
error on the duplicate test).

```bash
cd backend && go test ./shared/store/ -run 'TestWriteCommentary' 2>&1 | tail -12
```

- [x] **Step 2: Rewrite `commentary.go`**

Replace the whole file body below the imports:

```go
package store

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// commentaryConvergeSQL makes a match's stored commentary equal to the
// provider's latest list in ONE statement, and writes only the rows that
// differ.
//
// The shape matters more than the SQL. A live match is polled every 20
// seconds and ESPN returns the WHOLE transcript each time -- 113 lines at
// minute 90, of which 112 were written on the previous poll. The old
// row-at-a-time loop rewrote all 113 to append one, producing 113 dead tuples
// per poll and ~20,900 statements per match. Here the payload arrives as
// parallel arrays, unnest turns it back into rows inside Postgres, and the
// WHERE on DO UPDATE means an unchanged line is not written at all: no tuple
// version, no WAL, no vacuum debt.
//
// The comparison is over the FULL row, not a high-water sequence, so a line
// ESPN revises after publication is picked up wherever it is in the
// transcript -- a watermark would need an arbitrary re-check window and would
// still miss an edit older than it. It also means the write is stateless: a
// cold process converges a match already in progress in one statement, and
// cannot skip or duplicate a line.
//
// The prune is a CTE of the same statement rather than a second round trip. A
// data-modifying CTE always executes exactly once, and it targets only rows
// above the incoming maximum sequence -- a retraction -- so it is a no-op scan
// on every normal poll.
const commentaryConvergeSQL = `
WITH incoming AS (
	SELECT * FROM unnest(
		$2::int[], $3::int[], $4::int[], $5::text[],
		$6::text[], $7::text[], $8::timestamptz[], $9::text[]
	) AS line(seq, period, clock_value, clock_display,
	          play_type, play_type_text, wallclock, text)
), upserted AS (
	INSERT INTO match_commentary (
		match_id, seq, period, clock_value, clock_display,
		play_type, play_type_text, wallclock, text)
	SELECT $1, seq, period, clock_value, clock_display,
	       NULLIF(play_type, ''), NULLIF(play_type_text, ''), wallclock, text
	FROM incoming
	ON CONFLICT (match_id, seq) DO UPDATE SET
		period         = EXCLUDED.period,
		clock_value    = EXCLUDED.clock_value,
		clock_display  = EXCLUDED.clock_display,
		play_type      = EXCLUDED.play_type,
		play_type_text = EXCLUDED.play_type_text,
		wallclock      = EXCLUDED.wallclock,
		text           = EXCLUDED.text
	WHERE (
		match_commentary.period, match_commentary.clock_value,
		match_commentary.clock_display, match_commentary.play_type,
		match_commentary.play_type_text, match_commentary.wallclock,
		match_commentary.text
	) IS DISTINCT FROM (
		EXCLUDED.period, EXCLUDED.clock_value, EXCLUDED.clock_display,
		EXCLUDED.play_type, EXCLUDED.play_type_text, EXCLUDED.wallclock,
		EXCLUDED.text
	)
	RETURNING 1
), pruned AS (
	DELETE FROM match_commentary
	WHERE match_id = $1 AND seq > (SELECT max(seq) FROM incoming)
	RETURNING 1
)
SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM pruned)`

// WriteCommentary converges a match's relational commentary on the provider's
// latest non-empty list, writing only the lines that are new or changed. An
// empty list is absence of evidence and leaves previously recorded rows
// untouched.
//
// The returned count is rows WRITTEN, not lines received: on a live match's
// second poll of the same minute it is legitimately zero.
func (s *Store) WriteCommentary(
	ctx context.Context,
	matchID uuid.UUID,
	lines []model.CommentaryLine,
) (int, error) {
	lines = dedupeCommentary(lines)
	if len(lines) == 0 {
		return 0, nil
	}

	ctx, cancel := boundedContext(ctx)
	defer cancel()
	var written, pruned int
	if err := s.pool.QueryRow(ctx, commentaryConvergeSQL, commentaryArgs(matchID, lines)...).
		Scan(&written, &pruned); err != nil {
		return 0, fmt.Errorf("converge commentary: %w", err)
	}
	if pruned > 0 {
		// Rare and worth seeing: the provider retracted the end of the
		// transcript, which is the only reason rows disappear here.
		slog.Info("commentary tail retracted", "match", matchID, "rows", pruned)
	}
	return written, nil
}

// dedupeCommentary keeps the LAST line for each sequence.
//
// Two rows with the same key in the source of an ON CONFLICT DO UPDATE raise
// SQLSTATE 21000 and fail the whole statement -- verified, and it fires even
// when neither copy would change anything. The old row-at-a-time loop simply
// upserted twice and the second won, so last-wins is also the behaviour that
// does not change. Whether ESPN ever repeats a sequence in one payload is
// unmeasured, and a whole-match write is not the place to find out.
func dedupeCommentary(lines []model.CommentaryLine) []model.CommentaryLine {
	if len(lines) < 2 {
		return lines
	}
	at := make(map[int]int, len(lines))
	deduped := make([]model.CommentaryLine, 0, len(lines))
	for _, line := range lines {
		if index, seen := at[line.Seq]; seen {
			deduped[index] = line
			continue
		}
		at[line.Seq] = len(deduped)
		deduped = append(deduped, line)
	}
	return deduped
}

// commentaryArgs flattens the lines into the eight parallel arrays
// commentaryConvergeSQL unnests, in the order its column list declares them.
// One place, one order -- adding a column is one edit here and one there.
func commentaryArgs(matchID uuid.UUID, lines []model.CommentaryLine) []any {
	seq := make([]int, len(lines))
	period := make([]*int, len(lines))
	clockValue := make([]*int, len(lines))
	clockDisplay := make([]string, len(lines))
	playType := make([]string, len(lines))
	playTypeText := make([]string, len(lines))
	wallclock := make([]*time.Time, len(lines))
	text := make([]string, len(lines))
	for index, line := range lines {
		seq[index] = line.Seq
		period[index] = line.Period
		clockValue[index] = line.ClockValue
		clockDisplay[index] = line.ClockDisplay
		playType[index] = line.PlayType
		playTypeText[index] = line.PlayTypeText
		wallclock[index] = line.Wallclock
		text[index] = line.Text
	}
	return []any{
		matchID, seq, period, clockValue, clockDisplay,
		playType, playTypeText, wallclock, text,
	}
}
```

`nullIfEmpty` is no longer used here (the SQL's
`NULLIF` does that job) — leave the helper alone, other files use it; `go vet` will
tell you if it became unused package-wide, which it has not.

- [x] **Step 3: Run the commentary tests and Task 1's harness**

```bash
cd backend && go test ./shared/store/ -run 'TestWriteCommentary|TestCommentaryTickCost' -v 2>&1 | grep -E "^(=== RUN|--- (PASS|FAIL)|ok|FAIL)"
```

Expected:

```
--- PASS: TestWriteCommentaryUpsertsAsTheMatchGrows
--- PASS: TestWriteCommentaryPrunesARetractedTail
--- PASS: TestWriteCommentaryIsANoOpWhenNothingChanged
--- PASS: TestWriteCommentaryToleratesADuplicateSequence
--- PASS: TestCommentaryTickCostDoesNotGrowWithTheTranscript
ok  	github.com/mcasillas17/scorearc-backend/shared/store
```

- [x] **Step 4: Commit**

```bash
git add backend/shared/store/commentary.go backend/shared/store/commentary_integration_test.go
git commit -m "fix: converge match commentary in one statement, writing only what changed

A live match is polled every 20s and ESPN returns the whole transcript
each time. The row-at-a-time loop rewrote all 113 lines to append one --
~20,900 statements and as many dead tuples per match. One set-based
upsert with an IS DISTINCT FROM guard makes a tick cost exactly one
statement and write exactly the lines that are new or revised.

Spec §4.4. WriteCommentary now returns rows written, not lines received.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Converge appearances in one statement

**Files:**
- Modify: `backend/shared/store/participation.go`
- Modify: `backend/shared/store/participation_integration_test.go`

The appearance loop is the second-largest offender: 44 upserts plus a tail `DELETE`
per poll, ~16,200 statements per match. The `COALESCE` semantics must survive
exactly — a poll without a stats block must never turn a number back into unknown —
and the change-detection predicate must therefore compare against the
**post-`COALESCE`** value, or a stats-less poll would look like a change and rewrite
44 rows to store what was already there.

- [x] **Step 1: Write the failing tests**

Append to `backend/shared/store/participation_integration_test.go`:

```go
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
	if stats.Appearances != 3 {
		t.Fatalf("appearances = %d, want 3 distinct players", stats.Appearances)
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
```

Run: both fail — the first because every row's `xmin` moves, the second with
`ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time (SQLSTATE 21000)`.

- [x] **Step 2: Replace the appearance loop**

In `backend/shared/store/participation.go`, first **hoist `appearanceRow` and
`eventRow` out of `WriteParticipation` to package scope** (they are declared inside
the function today; the argument builders below and in Task 4 have to name them),
then add the statement and its argument builder and replace the
`if squadPresent { … }` block.

```go
// appearanceRow is one resolved roster entry: the canonical player, the
// canonical side, and the provider's view of what they did.
type appearanceRow struct {
	playerID uuid.UUID
	teamID   string
	player   model.SquadPlayer
}

// eventRow is one resolved event. playerID is nil when the provider sent no
// athlete id — the event still happened, and migration 0003 explains why it is
// recorded with the person unknown rather than dropped.
type eventRow struct {
	playerID *uuid.UUID
	teamID   string
	event    model.PlayerEvent
}
```

```go
// appearanceConvergeSQL makes a match's appearances equal the incoming roster
// in one statement, writing only rows that differ and pruning anyone the
// corrected roster dropped.
//
// The COALESCE in the SET list is load-bearing and is explained on the old
// upsert: a live poll that comes back without a stats block must not NULL out
// numbers an earlier poll established. The consequence for change detection is
// that the guard below compares the stored row against the POST-COALESCE value,
// not against EXCLUDED -- otherwise a stats-less poll would look like a change
// and rewrite the whole sheet to store what was already there.
const appearanceConvergeSQL = `
WITH incoming AS (
	SELECT * FROM unnest(
		$2::uuid[], $3::text[], $4::bool[], $5::int[], $6::text[],
		$7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
		$13::int[], $14::int[], $15::int[], $16::int[], $17::int[], $18::int[], $19::int[]
	) AS a(player_id, team_id, starter, shirt_number, position,
	       goals, assists, shots, shots_on_target, offsides,
	       fouls_committed, fouls_suffered, own_goals,
	       yellow_cards, red_cards, saves, goals_conceded, shots_faced)
), upserted AS (
	INSERT INTO appearance (
		match_id, player_id, team_id, starter, shirt_number, position,
		goals, assists, shots, shots_on_target, offsides,
		fouls_committed, fouls_suffered, own_goals,
		yellow_cards, red_cards, saves, goals_conceded, shots_faced)
	SELECT $1, player_id, team_id, starter, shirt_number, NULLIF(position, ''),
	       goals, assists, shots, shots_on_target, offsides,
	       fouls_committed, fouls_suffered, own_goals,
	       yellow_cards, red_cards, saves, goals_conceded, shots_faced
	FROM incoming
	ON CONFLICT (match_id, player_id) DO UPDATE SET
		team_id      = EXCLUDED.team_id,
		starter      = EXCLUDED.starter,
		shirt_number = EXCLUDED.shirt_number,
		position     = EXCLUDED.position,
		goals           = COALESCE(EXCLUDED.goals,           appearance.goals),
		assists         = COALESCE(EXCLUDED.assists,         appearance.assists),
		shots           = COALESCE(EXCLUDED.shots,           appearance.shots),
		shots_on_target = COALESCE(EXCLUDED.shots_on_target, appearance.shots_on_target),
		offsides        = COALESCE(EXCLUDED.offsides,        appearance.offsides),
		fouls_committed = COALESCE(EXCLUDED.fouls_committed, appearance.fouls_committed),
		fouls_suffered  = COALESCE(EXCLUDED.fouls_suffered,  appearance.fouls_suffered),
		own_goals       = COALESCE(EXCLUDED.own_goals,       appearance.own_goals),
		yellow_cards    = COALESCE(EXCLUDED.yellow_cards,    appearance.yellow_cards),
		red_cards       = COALESCE(EXCLUDED.red_cards,       appearance.red_cards),
		saves           = COALESCE(EXCLUDED.saves,           appearance.saves),
		goals_conceded  = COALESCE(EXCLUDED.goals_conceded,  appearance.goals_conceded),
		shots_faced     = COALESCE(EXCLUDED.shots_faced,     appearance.shots_faced)
	WHERE (
		appearance.team_id, appearance.starter, appearance.shirt_number,
		appearance.position, appearance.goals, appearance.assists,
		appearance.shots, appearance.shots_on_target, appearance.offsides,
		appearance.fouls_committed, appearance.fouls_suffered, appearance.own_goals,
		appearance.yellow_cards, appearance.red_cards, appearance.saves,
		appearance.goals_conceded, appearance.shots_faced
	) IS DISTINCT FROM (
		EXCLUDED.team_id, EXCLUDED.starter, EXCLUDED.shirt_number,
		EXCLUDED.position,
		COALESCE(EXCLUDED.goals,           appearance.goals),
		COALESCE(EXCLUDED.assists,         appearance.assists),
		COALESCE(EXCLUDED.shots,           appearance.shots),
		COALESCE(EXCLUDED.shots_on_target, appearance.shots_on_target),
		COALESCE(EXCLUDED.offsides,        appearance.offsides),
		COALESCE(EXCLUDED.fouls_committed, appearance.fouls_committed),
		COALESCE(EXCLUDED.fouls_suffered,  appearance.fouls_suffered),
		COALESCE(EXCLUDED.own_goals,       appearance.own_goals),
		COALESCE(EXCLUDED.yellow_cards,    appearance.yellow_cards),
		COALESCE(EXCLUDED.red_cards,       appearance.red_cards),
		COALESCE(EXCLUDED.saves,           appearance.saves),
		COALESCE(EXCLUDED.goals_conceded,  appearance.goals_conceded),
		COALESCE(EXCLUDED.shots_faced,     appearance.shots_faced)
	)
	RETURNING 1
), pruned AS (
	-- A player removed from a corrected roster must lose their appearance, or
	-- the phantom outlives the correction. Targeting the incoming set rather
	-- than the upserted one is deliberate: an unchanged row is NOT returned by
	-- the CTE above, and comparing against that would delete everyone who did
	-- not change.
	DELETE FROM appearance a
	WHERE a.match_id = $1
	  AND NOT (a.player_id = ANY(SELECT player_id FROM incoming))
	RETURNING 1
)
SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM pruned)`
```

Replace the loop:

```go
	appearancesWritten, appearancesPruned := 0, 0
	if squadPresent {
		rows = dedupeAppearances(rows)
		if err := tx.QueryRow(opCtx, appearanceConvergeSQL, appearanceArgs(matchID, rows)...).
			Scan(&appearancesWritten, &appearancesPruned); err != nil {
			return stats, fmt.Errorf("converge appearances: %w", err)
		}
		stats.Appearances = len(rows)
	}
```

and add, next to `boxScoreArgs` (which it replaces):

```go
// dedupeAppearances keeps the LAST entry for each canonical player. Two roster
// entries can resolve to one player once a duplicate is merged, and a repeated
// key in the source of an ON CONFLICT DO UPDATE raises SQLSTATE 21000 and fails
// the whole match's write. The old row-at-a-time loop upserted twice and the
// second won; last-wins keeps that.
func dedupeAppearances(rows []appearanceRow) []appearanceRow {
	if len(rows) < 2 {
		return rows
	}
	at := make(map[uuid.UUID]int, len(rows))
	deduped := make([]appearanceRow, 0, len(rows))
	for _, row := range rows {
		if index, seen := at[row.playerID]; seen {
			deduped[index] = row
			continue
		}
		at[row.playerID] = len(deduped)
		deduped = append(deduped, row)
	}
	return deduped
}

// appearanceArgs flattens the roster into the eighteen parallel arrays
// appearanceConvergeSQL unnests, in the order its column list declares them.
func appearanceArgs(matchID uuid.UUID, rows []appearanceRow) []any {
	playerIDs := make([]uuid.UUID, len(rows))
	teamIDs := make([]string, len(rows))
	starters := make([]bool, len(rows))
	numbers := make([]*int, len(rows))
	positions := make([]string, len(rows))
	columns := make([][]*int, boxScoreColumnCount)
	for column := range columns {
		columns[column] = make([]*int, len(rows))
	}
	for index, row := range rows {
		playerIDs[index] = row.playerID
		teamIDs[index] = row.teamID
		starters[index] = row.player.Starter
		numbers[index] = row.player.Number
		positions[index] = row.player.Position
		for column, value := range boxScoreColumns(row.player.Stats) {
			columns[column][index] = value
		}
	}
	args := []any{matchID, playerIDs, teamIDs, starters, numbers, positions}
	for _, column := range columns {
		args = append(args, column)
	}
	return args
}

const boxScoreColumnCount = 13

// boxScoreColumns lists the thirteen box-score values in the exact order the
// INSERT lists them. A nil PlayerMatchStats yields thirteen nils, which the
// COALESCE in the upsert turns into "change nothing" -- so a poll with no stats
// block is a no-op on the numbers rather than an erasure, AND compares equal in
// the change guard rather than looking like a change.
//
// The columns are listed here in one place, in one order, so adding a
// fourteenth stat is one edit to the INSERT, one to the guard, and one here
// rather than a hunt through positional placeholders.
func boxScoreColumns(stats *model.PlayerMatchStats) []*int {
	if stats == nil {
		return make([]*int, boxScoreColumnCount)
	}
	return []*int{
		stats.Goals, stats.Assists, stats.Shots, stats.ShotsOnTarget,
		stats.Offsides, stats.FoulsCommitted, stats.FoulsSuffered,
		stats.OwnGoals, stats.YellowCards, stats.RedCards,
		stats.Saves, stats.GoalsConceded, stats.ShotsFaced,
	}
}
```

Delete `boxScoreArgs`. Keep `appearancesWritten`/`appearancesPruned` in scope — Task 4
uses them.

- [x] **Step 3: Run**

```bash
cd backend && go test ./shared/store/ -run 'TestWriteParticipation' -v 2>&1 | grep -E "^(--- (PASS|FAIL)|ok|FAIL)"
```

Expected: every existing `TestWriteParticipation*` still passes, plus the two new
ones.

- [x] **Step 4: Commit**

```bash
git add backend/shared/store/participation.go backend/shared/store/participation_integration_test.go
git commit -m "fix: converge appearances in one statement, comparing post-COALESCE values

44 upserts plus a tail delete per 20-second poll -- ~16,200 statements a
match -- becomes one. The change guard compares the stored row against
the post-COALESCE value, so a poll with no stats block is a proven no-op
instead of 44 rewrites of numbers that did not move.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Converge events, and stop reporting coverage every poll

**Files:**
- Modify: `backend/shared/store/participation.go`
- Modify: `backend/shared/store/participation_integration_test.go`

`match_event` is the same pattern (24 upserts + a prune per poll, ~8,600 statements a
match), plus one extra problem hiding behind it: `reportParticipation` writes an
`ingest_run` row **per match per poll** whenever any athlete id is missing. On a live
match with one unidentifiable event that is 360 audit rows for one fact. It becomes
one row per genuine change.

- [x] **Step 1: Write the failing test**

Append to `backend/shared/store/participation_integration_test.go`:

```go
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
```

- [x] **Step 2: Replace the event loop and gate the report**

Add to `participation.go`:

```go
// eventConvergeSQL is appearanceConvergeSQL's shape for match_event. seq is a
// deterministic ordinal in mapper order -- events carry no stable provider id,
// which migration 0003 explains -- so re-ingestion is an upsert on
// (match_id, seq), and the prune removes any longer previous history an
// upstream retraction left behind.
const eventConvergeSQL = `
WITH incoming AS (
	SELECT * FROM unnest(
		$2::int[], $3::uuid[], $4::text[], $5::text[],
		$6::text[], $7::bool[], $8::bool[], $9::text[]
	) AS e(seq, player_id, team_id, type, minute, penalty, shootout, detail)
), upserted AS (
	INSERT INTO match_event (
		match_id, seq, player_id, team_id, type, minute, penalty, shootout, detail)
	SELECT $1, seq, player_id, team_id, type, minute, penalty, shootout, detail
	FROM incoming
	ON CONFLICT (match_id, seq) DO UPDATE SET
		player_id = EXCLUDED.player_id,
		team_id   = EXCLUDED.team_id,
		type      = EXCLUDED.type,
		minute    = EXCLUDED.minute,
		penalty   = EXCLUDED.penalty,
		shootout  = EXCLUDED.shootout,
		detail    = EXCLUDED.detail
	WHERE (
		match_event.player_id, match_event.team_id, match_event.type,
		match_event.minute, match_event.penalty, match_event.shootout,
		match_event.detail
	) IS DISTINCT FROM (
		EXCLUDED.player_id, EXCLUDED.team_id, EXCLUDED.type,
		EXCLUDED.minute, EXCLUDED.penalty, EXCLUDED.shootout, EXCLUDED.detail
	)
	RETURNING 1
), pruned AS (
	DELETE FROM match_event
	WHERE match_id = $1 AND seq >= (SELECT count(*) FROM incoming)
	RETURNING 1
)
SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM pruned)`

// eventArgs flattens the events into the eight parallel arrays
// eventConvergeSQL unnests. The sequence is the position in mapper order, which
// is what makes re-ingestion an upsert rather than a duplicate.
func eventArgs(matchID uuid.UUID, events []eventRow) []any {
	seq := make([]int, len(events))
	playerIDs := make([]*uuid.UUID, len(events))
	teamIDs := make([]string, len(events))
	types := make([]string, len(events))
	minutes := make([]string, len(events))
	penalties := make([]bool, len(events))
	shootouts := make([]bool, len(events))
	details := make([]string, len(events))
	for index, event := range events {
		seq[index] = index
		playerIDs[index] = event.playerID
		teamIDs[index] = event.teamID
		types[index] = event.event.Type
		minutes[index] = event.event.Minute
		penalties[index] = event.event.Penalty
		shootouts[index] = event.event.Shootout
		details[index] = event.event.Detail
	}
	return []any{
		matchID, seq, playerIDs, teamIDs, types, minutes, penalties, shootouts, details,
	}
}
```

`eventRow` was hoisted to package scope in Task 3. Replace the event block:

```go
	eventsWritten, eventsPruned := 0, 0
	if len(events) > 0 {
		if err := tx.QueryRow(opCtx, eventConvergeSQL, eventArgs(matchID, events)...).
			Scan(&eventsWritten, &eventsPruned); err != nil {
			return stats, fmt.Errorf("converge match events: %w", err)
		}
		stats.Events = len(events)
	}

	if err := tx.Commit(opCtx); err != nil {
		return stats, err
	}

	// Nothing moved, so nothing new is known about coverage. A live match is
	// polled 360 times; reporting the same gap on every one of them buries the
	// signal this exists to raise.
	if appearancesWritten+appearancesPruned+eventsWritten+eventsPruned > 0 {
		s.reportParticipation(ctx, matchID, stats)
	}
	return stats, nil
```

- [x] **Step 3: Run the whole store package**

```bash
cd backend && go test ./shared/store/ 2>&1 | tail -5
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/shared/store  <time>s`.

- [x] **Step 4: Commit**

```bash
git add backend/shared/store/participation.go backend/shared/store/participation_integration_test.go
git commit -m "fix: converge match events in one statement; report coverage on change only

The event loop was the same per-poll full rewrite as appearances
(~8,600 statements a match). reportParticipation was worse in kind: one
ingest_run row per match per poll whenever a single athlete id was
missing, which is 360 audit rows to say one thing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The whole live path, twelve ticks, one assertion

**Files:**
- Modify: `backend/shared/store/livepath_integration_test.go`

Task 1 proved commentary in isolation. This is the plan's headline claim: across a
simulated match, **total statements scale with new rows, not with accumulated ones**,
for all three tables at once.

- [x] **Step 1: Write the test**

Append to `backend/shared/store/livepath_integration_test.go`:

```go
// livePoll is what one 20-second poll of a match in progress hands the store.
// Everything grows the way a real match grows: the transcript gains three
// lines a tick, a substitute appears at tick 6, and a goal is scored at tick 8.
func livePoll(tick int) *model.MatchParticipation {
	part := &model.MatchParticipation{
		HomeTeamSourceID: "359",
		AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{
			{SourceID: "p1", Name: "Bukayo Saka", Position: "F", Starter: true},
			{SourceID: "p2", Name: "Reserve Keeper", Position: "G", Starter: false},
		},
		Away: []model.SquadPlayer{
			{SourceID: "p3", Name: "Cole Palmer", Position: "M", Starter: true},
		},
		Events: []model.PlayerEvent{
			{TeamSourceID: "359", PlayerSourceID: "p1", PlayerName: "Bukayo Saka",
				Type: model.PlayerEventYellow, Minute: "12'", Detail: "Yellow Card"},
		},
	}
	if tick >= 6 {
		part.Away = append(part.Away, model.SquadPlayer{
			SourceID: "p4", Name: "Late Substitute", Position: "F", Starter: false,
		})
		part.Events = append(part.Events, model.PlayerEvent{
			TeamSourceID: "363", PlayerSourceID: "p4", PlayerName: "Late Substitute",
			Type: model.PlayerEventSubOn, Minute: "60'", Detail: "Substitution",
		})
	}
	if tick >= 8 {
		scored := 1
		part.Home[0].Stats = &model.PlayerMatchStats{Goals: &scored}
		part.Events = append(part.Events, model.PlayerEvent{
			TeamSourceID: "359", PlayerSourceID: "p1", PlayerName: "Bukayo Saka",
			Type: model.PlayerEventGoal, Minute: "71'", Detail: "Goal",
		})
	}
	return part
}

// The claim this whole plan makes, stated as a test: a live match's cost is a
// function of the number of polls and of what actually changed, never of how
// much has already happened.
func TestLivePathStatementsScaleWithNewRowsNotAccumulatedOnes(t *testing.T) {
	store, pool, counter := newTracedStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	const ticks = 12
	counter.reset()
	for tick := 1; tick <= ticks; tick++ {
		if _, err := store.WriteParticipation(ctx, "espn", matchID,
			"eng-arsenal", "eng-chelsea", livePoll(tick)); err != nil {
			t.Fatalf("tick %d participation: %v", tick, err)
		}
		if _, err := store.WriteCommentary(ctx, matchID, growingTranscript(tick)); err != nil {
			t.Fatalf("tick %d commentary: %v", tick, err)
		}
	}

	// One statement per table per tick. Not one per row.
	for _, table := range countedTables {
		if got := counter.count(table); got != ticks {
			t.Fatalf("%s took %d statements over %d ticks, want exactly %d "+
				"(one per poll, independent of accumulated rows)", table, got, ticks, ticks)
		}
	}

	// And what those statements produced is the football, not a rewrite of it.
	if got := countRows(t, pool,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID); got != ticks*3 {
		t.Fatalf("commentary rows = %d, want %d", got, ticks*3)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); got != 4 {
		t.Fatalf("appearances = %d, want 4 (three from kickoff, one substitute)", got)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); got != 3 {
		t.Fatalf("events = %d, want 3", got)
	}

	// Tuple versions are the real cost. Four appearances polled twelve times
	// must not be forty-eight tuple versions: p1 changes once (the goal at tick
	// 8), p4 is inserted once (tick 6), p2 and p3 never change at all.
	versions := tupleVersions(t, pool,
		`SELECT DISTINCT xmin::text FROM appearance WHERE match_id=$1`, matchID)
	if len(versions) > 3 {
		t.Fatalf("appearance tuple versions = %d, want at most 3 "+
			"(kickoff insert, the substitute, the goal)", len(versions))
	}
}
```

- [x] **Step 2: Run it**

```bash
cd backend && go test ./shared/store/ -run TestLivePathStatementsScaleWithNewRows -v 2>&1 | grep -E "^(--- (PASS|FAIL)|ok|FAIL)"
```

Expected: `--- PASS: TestLivePathStatementsScaleWithNewRowsNotAccumulatedOnes`.

To see what it would have said before Tasks 2–4, run it on `origin/main` with the
test file cherry-picked; the failure reads
`match_commentary took 246 statements over 12 ticks, want exactly 12`. Quote that in
the PR body.

- [x] **Step 3: Commit**

```bash
git add backend/shared/store/livepath_integration_test.go
git commit -m "test: assert live-path statements scale with new rows, not accumulated ones

Twelve simulated 20-second polls of a match in progress, on a real
Postgres, with a fixed clock and no wall-clock timing anywhere: one
statement per table per tick, and appearance tuple versions bounded by
the three things that actually changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Make `ingest_run` coarse on the live path

**Files:**
- Modify: `backend/ingester/runner.go`
- Modify: `backend/ingester/odds.go`
- Modify: `backend/ingester/matches.go`
- Modify: `backend/ingester/main.go`
- Modify: `backend/ingester/runner_test.go`

Spec §4.5. Today `win_prob_snapshot` and `odds` each write **one `ingest_run` row per
match per poll**: 720 rows per match per two hours, before a Saturday multiplies it
by ten. Those two are the only per-match-per-poll audit kinds in the system; every
other `recordRun` call is already once per competition per cycle.

**The granularity, and why not something coarser.** A **success** for one of these
two kinds is recorded at most once per `(competition, kind)` per **5 minutes**;
suppressed successes are counted and the count goes to the structured log, and the
next recorded row's `started_at` is backdated to the start of the suppressed window
so the row truthfully spans it. A **failure is never suppressed** — it is written
immediately and resets the window.

**Why not one row per cycle** (§4.5's literal wording): with a single live match a
cycle *is* a poll, so per-cycle aggregation would save nothing at all. The 5-minute
window is what makes the row count independent of both the poll interval and the
number of live matches: ~24 rows per kind per competition per match-length, not 360.

**Why not longer than 5 minutes:** it must stay well inside the freshness
thresholds — see below — and it must stay short enough that "the odds sampler stopped
ten minutes ago" is visible while a match is still being played.

**Freshness (T10.10) compatibility — the check that matters.**
`docs/superpowers/plans/2026-08-18-api-health-and-provenance.md` computes, per
`(competition_id, kind)`, the most recent successful `ingest_run` and compares its age
to a threshold. Three facts make this change safe, and all three must stay true:

1. **No `kind` disappears.** `odds` still writes rows, just fewer. `win_prob_snapshot`
   is not one of the eight kinds that plan reads at all.
2. **`odds`' threshold is 24 hours** (it is event-driven — "a competition with no
   matches today is not stale"). A 5-minute heartbeat is 288× inside it.
3. **The "is the loop alive" signal is untouched.** That comes from the `matches`
   kind — `r.recordRun(ctx, comp.ID, "matches", matchStart, processErr)`, one row per
   competition per cycle, 20-minute threshold — and from `scoreboard_fetch`,
   `existing_matches` and `resolve_identity`, none of which this task modifies.
   **A silently stopped ingester still shows up within 20 minutes on `matches`,
   exactly as it does today.** The coarsened kinds are sampling detail, not
   liveness.

The one thing genuinely given up: the database no longer records *how many* samples
were taken, only that sampling ran and last succeeded at time T. That count goes to
the log. `ingest_run` is C5 — "would we miss this in ninety days?" — and the answer
for a per-poll sample counter is no.

- [x] **Step 1: Write the failing tests**

Append to `backend/ingester/runner_test.go`:

```go
// A live match is polled every 20 seconds. Writing an ingest_run row per match
// per poll for the two sampling kinds is 720 rows per match per two hours, to
// say the same thing 720 times.
func TestLiveSampleAuditIsThrottledToOneRowPerWindow(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})
	clock := time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)
	worker.now = func() time.Time { return clock }

	// Fifteen polls inside one five-minute window: 20s apart.
	for range 15 {
		worker.captureOdds(context.Background(),
			config.Competition{ID: "test"}, captureIdentity(), "m1", false)
		clock = clock.Add(20 * time.Second)
	}
	if runs := loggedRunsForKind(repo.logged, "odds"); len(runs) != 1 {
		t.Fatalf("odds audit rows = %d over five minutes of polling, want 1", len(runs))
	}

	// Past the window, one more row.
	clock = clock.Add(5 * time.Minute)
	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", false)
	if runs := loggedRunsForKind(repo.logged, "odds"); len(runs) != 2 {
		t.Fatalf("odds audit rows = %d after the window elapsed, want 2", len(runs))
	}
}

// Throttling successes must never throttle failures: a bookmaker feed going
// dark is exactly what the audit trail exists to show, and it must show up on
// the poll it happens rather than up to five minutes later.
func TestLiveSampleAuditNeverSuppressesAFailure(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})
	clock := time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)
	worker.now = func() time.Time { return clock }

	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", false)
	clock = clock.Add(20 * time.Second)
	src.oddsErr = errors.New("core api down")
	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", false)

	runs := loggedRunsForKind(repo.logged, "odds")
	if len(runs) != 2 || runs[1].ok {
		t.Fatalf("odds audit rows = %#v, want the failure recorded immediately", runs)
	}
}
```

- [x] **Step 2: Implement the clock seam and the throttle**

In `backend/ingester/runner.go`, add to the constants and the `runner` struct:

```go
// sampleAuditWindow bounds how often a SUCCESSFUL per-match sampling operation
// writes an ingest_run row. It has to stay far inside the freshness endpoint's
// thresholds (T10.10 gives `odds` 24 hours) and short enough that a sampler
// that stopped is visible while a match is still being played.
const sampleAuditWindow = 5 * time.Minute

// auditWindow is one (competition, kind) throttle. A restart empties it and the
// next sample writes a row, which is correct and cheap.
type auditWindow struct {
	windowStart  time.Time
	lastRecorded time.Time
	suppressed   int
}
```

```go
	// now is the runner's clock. Only the live-path audit and sampling
	// decisions read it, so tests can drive a tick sequence without sleeping;
	// nil means time.Now.
	now func() time.Time

	// sampleAudit throttles the audit rows of the two per-match-per-poll
	// sampling kinds. Successes only -- failures are never suppressed.
	sampleAudit map[string]auditWindow
```

and the methods:

```go
func (r *runner) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// recordSample audits a per-match, per-poll sampling operation.
//
// These are the only two writes in the system whose audit row would otherwise
// scale with matches x polls: 720 rows per match per two hours for
// win_prob_snapshot and odds together, before a Saturday multiplies it by the
// number of simultaneous matches. A SUCCESS is therefore recorded at most once
// per (competition, kind) per sampleAuditWindow, with the suppressed count
// logged and the recorded row's started_at backdated so it spans the window it
// stands for. A FAILURE is never suppressed.
//
// What is deliberately lost: the database no longer counts samples, only that
// sampling ran and last succeeded. ingest_run is operational (spec §2, C5) and
// a per-poll counter is not something anyone would miss in ninety days.
func (r *runner) recordSample(
	ctx context.Context,
	compID, kind string,
	started time.Time,
	operationErr error,
) {
	now := r.clock()
	key := compID + "\x00" + kind

	r.mu.Lock()
	window := r.sampleAudit[key]
	if operationErr == nil && !window.lastRecorded.IsZero() &&
		now.Sub(window.lastRecorded) < sampleAuditWindow {
		if window.suppressed == 0 {
			window.windowStart = started
		}
		window.suppressed++
		r.sampleAudit[key] = window
		r.mu.Unlock()
		return
	}
	from := started
	if window.suppressed > 0 && !window.windowStart.IsZero() {
		from = window.windowStart
	}
	suppressed := window.suppressed
	r.sampleAudit[key] = auditWindow{lastRecorded: now}
	r.mu.Unlock()

	if suppressed > 0 {
		r.log.Info("live sample window",
			"comp", compID, "kind", kind, "suppressed", suppressed, "since", from)
	}
	r.recordRun(ctx, compID, kind, from, operationErr)
}
```

Change `recordRunFor`'s `time.Now()` to `r.clock()` so a recorded row's
`finished_at` follows the same clock as the window that produced it.

In `backend/ingester/odds.go`, route the live audit through it:

```go
	// The finalized capture is a once-per-match event and must never be
	// throttled; the live sample is the one that repeats every 20 seconds.
	record := r.recordSample
	if finalized {
		record = r.recordRun
	}
```

and replace the four `r.recordRun(ctx, comp.ID, oddsRunKind, started, …)` calls in
that function with `record(ctx, comp.ID, oddsRunKind, started, …)`.

In `backend/ingester/matches.go`, change the win-probability audit call:

```go
					r.recordSample(ctx, comp.ID, winProbSnapshotRunKind, start, err)
```

In `backend/ingester/main.go` and `runner_test.go`'s `testRunner`, add
`sampleAudit: make(map[string]auditWindow),` to the `runner` literal.

- [x] **Step 3: Run the ingester package**

```bash
cd backend && go test ./ingester/ 2>&1 | tail -5
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/ingester  <time>s`. Every
existing `odds`/`win_prob_snapshot` audit test still passes unchanged, because a
fresh runner's first sample is always recorded and each of those tests makes exactly
one call.

- [x] **Step 4: Commit**

```bash
git add backend/ingester/
git commit -m "fix: throttle live sampling audit rows to one per window per competition

win_prob_snapshot and odds each wrote an ingest_run row per match per
poll -- 720 rows per match per two hours to say the same thing. A
success is now recorded once per (competition, kind) per five minutes,
backdated to span the window; a failure is never suppressed. The
liveness signal T10.10 reads (kind='matches', per cycle) is untouched.

Spec §4.5.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Stop re-writing a minute bucket that has not moved

**Files:**
- Modify: `backend/ingester/runner.go`
- Modify: `backend/ingester/odds.go`
- Modify: `backend/ingester/matches.go`
- Modify: `backend/ingester/main.go`
- Modify: `backend/ingester/runner_test.go`

Migration `0005` already decided the sampling rate: `win_prob_snapshot.captured_at` is
the minute bucket, with a unique index, so a 20-second poll is meant to yield one row
per minute. The *writer* did not get the message and issues a statement every poll,
so two of every three are conflict updates rewriting the row they just wrote.
`odds_snapshot` is identical (migration `0004`'s sibling shape, `WriteOddsSnapshot`
truncates to the minute).

Spec §5: **write on bucket change *or* value change, whichever comes first.** Never
skip on an unchanged value alone — a flat curve is a real observation and an even
one-row-per-minute x-axis is what makes two matches comparable.

**Out of scope:** §5's pre-match sampling ladder (hourly from T−24 h). It is a
function of time-to-kickoff and belongs with the scheduled-match TTL, which is a
sibling's slice.

- [x] **Step 1: Write the failing test**

Append to `backend/ingester/runner_test.go`:

```go
// Migration 0005 buckets the curve to the minute. Three polls inside one
// minute with the same prices must therefore produce one write, not three
// conflict updates rewriting the row they just wrote.
func TestLiveSamplesSkipAnUnchangedMinuteBucket(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{odds: oddsFixture()}
	worker := testRunner(src, repo, config.Competition{ID: "test"})
	clock := time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)
	worker.now = func() time.Time { return clock }

	for range 3 {
		worker.captureOdds(context.Background(),
			config.Competition{ID: "test"}, captureIdentity(), "m1", false)
		clock = clock.Add(20 * time.Second)
	}
	if len(repo.oddsSnapshots) != 1 {
		t.Fatalf("odds snapshot writes = %d within one minute, want 1", len(repo.oddsSnapshots))
	}

	// The next minute is a new bucket and must be sampled, even though the
	// prices are identical -- a flat curve is a real observation.
	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", false)
	if len(repo.oddsSnapshots) != 2 {
		t.Fatalf("odds snapshot writes = %d after the bucket rolled, want 2",
			len(repo.oddsSnapshots))
	}

	// A price move inside the same bucket is written immediately: the bucket is
	// a floor on resolution, not a ceiling on truth.
	moved := oddsFixture()
	price := 250
	moved[0].Current.HomeMoneyline = &price
	src.odds = moved
	clock = clock.Add(10 * time.Second)
	worker.captureOdds(context.Background(),
		config.Competition{ID: "test"}, captureIdentity(), "m1", false)
	if len(repo.oddsSnapshots) != 3 {
		t.Fatalf("odds snapshot writes = %d after the line moved, want 3",
			len(repo.oddsSnapshots))
	}
}
```

- [x] **Step 2: Implement the sample memo**

In `runner.go`:

```go
// liveSample is the last (bucket, value) this process wrote for one match and
// one sampling kind.
//
// It is a COST GATE, not the idempotency guarantee -- that is the unique index
// in migrations 0004 and 0005, the same relationship `snapshotted` has with the
// standings snapshot. A restart empties it and the next poll writes one extra
// row into a bucket it already holds, which the store upserts.
type liveSample struct {
	bucket time.Time
	digest uint64
}
```

```go
	// liveSamples gates the two per-poll time-series writes. Keyed by
	// match id + kind; dropped when the match finalizes.
	liveSamples map[string]liveSample
```

```go
// sampleUnchanged reports whether this match's sample for `kind` would land in
// the same minute bucket with the same value as the last one written.
//
// Both conditions, not either: spec §5. A flat probability curve is a finding
// and an even one-row-per-minute axis is what makes two matches comparable, so
// an unchanged VALUE in a new BUCKET is still written. What is skipped is only
// the second and third poll of the same minute, which the unique index would
// collapse anyway -- at the cost of a statement and a tuple version each.
func (r *runner) sampleUnchanged(matchID uuid.UUID, kind string, at time.Time, digest uint64) bool {
	bucket := at.UTC().Truncate(time.Minute)
	key := matchID.String() + "\x00" + kind
	r.mu.Lock()
	defer r.mu.Unlock()
	last, seen := r.liveSamples[key]
	if seen && last.bucket.Equal(bucket) && last.digest == digest {
		return true
	}
	r.liveSamples[key] = liveSample{bucket: bucket, digest: digest}
	return false
}

// forgetSamples drops a finalized match's gates. The match will never be polled
// live again, and leaving the entries would grow the map for the life of the
// process.
func (r *runner) forgetSamples(matchID uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, kind := range []string{winProbSnapshotRunKind, oddsRunKind} {
		delete(r.liveSamples, matchID.String()+"\x00"+kind)
	}
}

// sampleDigest fingerprints a value so an unchanged one can be recognised
// without keeping the value itself. Collisions cost one skipped sample in a
// bucket that will be re-sampled a minute later, which is why FNV is enough and
// a cryptographic hash would be theatre.
func sampleDigest(parts ...any) uint64 {
	hash := fnv.New64a()
	for _, part := range parts {
		fmt.Fprintf(hash, "%v\x1f", sampleValue(part))
	}
	return hash.Sum64()
}

// sampleValue renders a nullable market value by its CONTENT.
//
// This is not defensive tidiness. fmt's %v on a pointer prints its ADDRESS,
// which differs on every poll because the mapper allocates a fresh OddsLine —
// so digesting the pointers directly would make every fingerprint unique, the
// gate would never fire, and the bug would present as "the optimisation does
// nothing" rather than as a failure.
func sampleValue(value any) any {
	switch typed := value.(type) {
	case *int:
		if typed == nil {
			return "nil"
		}
		return *typed
	case *float64:
		if typed == nil {
			return "nil"
		}
		return *typed
	default:
		return value
	}
}

// oddsDigest covers every current-line field of every book, in provider order,
// so a move in any one of them is a change.
func oddsDigest(providers []model.ProviderOdds) uint64 {
	parts := make([]any, 0, len(providers)*10)
	for _, provider := range providers {
		parts = append(parts, provider.ProviderID)
		line := provider.Current
		if line == nil {
			parts = append(parts, "nil")
			continue
		}
		parts = append(parts,
			line.HomeMoneyline, line.DrawMoneyline, line.AwayMoneyline,
			line.Spread, line.HomeSpreadOdds, line.AwaySpreadOdds,
			line.OverUnder, line.OverOdds, line.UnderOdds)
	}
	return sampleDigest(parts...)
}
```

Add `"hash/fnv"` to the imports.

In `odds.go`, between the empty-providers guard and the write:

```go
	// The bucket is a minute (WriteOddsSnapshot truncates), so two of every
	// three live polls would otherwise rewrite the row they just wrote. A
	// finalized capture always writes: it is the closing sample and the fixed
	// lines, not a point on a curve.
	if !finalized &&
		r.sampleUnchanged(identity.MatchID, oddsRunKind, started, oddsDigest(providers)) {
		return
	}
```

In `matches.go`, guard the win-probability write:

```go
				if match.State == model.MatchStateLive {
					if detail.WinProbability != nil {
						probability := *detail.WinProbability
						if !r.sampleUnchanged(identity.MatchID, winProbSnapshotRunKind,
							summaryStartedAt, sampleDigest(
								probability.Home, probability.Draw, probability.Away)) {
							start := r.clock()
							err := r.repo.WriteWinProbSnapshot(
								ctx, identity.MatchID, probability, summaryStartedAt)
							r.recordSample(ctx, comp.ID, winProbSnapshotRunKind, start, err)
							if err != nil {
								r.log.Warn("win probability snapshot",
									"match", match.ID, "err", err)
							}
						}
					}
```

and, in the `didFinalize` branch after `r.captureOdds(ctx, comp, identity, match.ID, true)`:

```go
						r.forgetSamples(identity.MatchID)
```

Change `summaryStartedAt := time.Now()` to `summaryStartedAt := r.clock()` so the
bucket a test drives and the bucket the store writes agree.

Add `liveSamples: make(map[string]liveSample),` to the `runner` literal in `main.go`
and in `testRunner`.

- [x] **Step 3: Run**

```bash
cd backend && go test ./ingester/ -run 'TestLiveSamples|TestCaptureOdds|TestWinProb|TestLiveMatch' -v 2>&1 | grep -E "^(--- (PASS|FAIL)|ok|FAIL)"
```

Expected: all pass, including the six pre-existing `TestCaptureOdds*` cases — each
makes a single call against a fresh runner, so the first sample is always written.

- [x] **Step 4: Commit**

```bash
git add backend/ingester/
git commit -m "fix: skip a live sample whose minute bucket and value both repeat

Migration 0005 buckets the probability curve to the minute; the writer
still issued a statement every 20 seconds, so two of every three were
conflict updates rewriting the row they had just written. Odds are the
same shape. Write on bucket change OR value change, never on neither --
a flat curve in a new bucket is still a real observation.

Spec §5. The pre-match sampling ladder is not in scope.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Pin the two live-path writes this plan deliberately leaves alone

**Files:**
- Modify: `backend/ingester/runner_test.go`

`match_detail` and `match_play` were audited (see the audit table above) and
deliberately not changed. Both conclusions are load-bearing and both are one careless
edit away from becoming false, so both get a test.

- [x] **Step 1: Write the tests**

Append to `backend/ingester/runner_test.go`:

```go
// The touch-level stream is ~1,500 plays over two pages. capturePlays is called
// only when a match finalizes and from the slow-tick backlog, never on a live
// poll -- eighteen requests a minute per live match against a keyless API is
// the failure mode this guards.
func TestLiveCycleNeverCapturesThePlayStream(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{live: true, winProbability: &model.WinProbability{Home: 50, Draw: 25, Away: 25}}
	worker := newTestRunnerWithSource(repo, src)

	for range 3 {
		worker.runCycle(context.Background(), false)
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if src.playsCalls != 0 || len(repo.playWrites) != 0 {
		t.Fatalf("a live match fetched the play stream %d times and wrote %d batches, want 0/0",
			src.playsCalls, len(repo.playWrites))
	}
}

// match_detail is deliberately NOT content-guarded on the live path: its
// content genuinely moves every poll (running stats, the growing commentary
// array). What must stay true is that it costs ONE write per match per poll --
// if it ever becomes one per row of anything, it joins the tables Tasks 2-4
// fixed.
func TestLiveCycleWritesMatchDetailOncePerPoll(t *testing.T) {
	repo := &fakeRepository{}
	src := &fakeSource{live: true}
	worker := newTestRunnerWithSource(repo, src)

	const polls = 3
	for range polls {
		worker.runCycle(context.Background(), false)
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.detailCalls != polls {
		t.Fatalf("match_detail writes = %d over %d polls of one match, want %d",
			repo.detailCalls, polls, polls)
	}
}
```

`fakeRepository.UpsertMatchDetail` currently discards its call; give it a counter:

```go
func (f *fakeRepository) UpsertMatchDetail(context.Context, uuid.UUID, model.MatchDetail) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.detailCalls++
	return nil
}
```

and add `detailCalls int` to the struct.

- [x] **Step 2: Run**

```bash
cd backend && go test ./ingester/ -run 'TestLiveCycle' -v 2>&1 | grep -E "^(--- (PASS|FAIL)|ok|FAIL)"
```

Expected: both pass on unmodified production code — they are regression pins, not
change drivers.

- [x] **Step 3: Commit**

```bash
git add backend/ingester/runner_test.go
git commit -m "test: pin the two live-path writes this slice deliberately leaves alone

match_play is not fetched on a live poll and match_detail costs exactly
one write per poll. Both were audited and left unchanged; both are one
edit away from becoming false.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Document the policy, run the full gate, open the PR

**Files:**
- Modify: `docs/backend/ARCHITECTURE.md`
- Modify: `docs/PRODUCT_ROADMAP.md`

- [ ] **Step 1: Write the policy down where the next agent will look**

Add to `docs/backend/ARCHITECTURE.md`, in the ingester section:

```markdown
### The live write path

A match in play is polled every 20 seconds (`ingester/schedule.go`,
`fastInterval`). Three tables are written from that poll with the WHOLE
accumulated payload each time — commentary, appearances, events — and each is
converged by **one set-based statement** that writes only rows whose content
differs (`shared/store/commentary.go`, `shared/store/participation.go`).

Rules for anything added to this path:

- **Never loop `Exec` over the rows of a payload that grows during a match.**
  Pass parallel arrays, `unnest` them, and put an `IS DISTINCT FROM` guard on
  `ON CONFLICT … DO UPDATE`. A tick must cost a number of statements
  proportional to the number of tables, not to the number of rows.
- **Compare against the effective post-`COALESCE` value**, not against
  `EXCLUDED`, wherever the `SET` list preserves an existing value. Otherwise a
  poll with a missing block looks like a change.
- **Deduplicate the payload in Go** before a set-based upsert. A repeated key in
  the source rows raises `SQLSTATE 21000` and fails the whole write.
- **Time-series samples** (`win_prob_snapshot`, `odds_snapshot`) are bucketed to
  the minute by the schema; the writer skips a poll whose bucket *and* value both
  repeat, and never skips on an unchanged value alone.
- **`ingest_run` is coarse here.** A per-match, per-poll operation records a
  success at most once per competition per five minutes; failures are never
  suppressed. Liveness monitoring reads `kind='matches'`, which is per cycle and
  is not throttled.
```

Add T7.16 / T7.17 to E7's ingester write table in `docs/PRODUCT_ROADMAP.md`, linking
this plan.

- [x] **Step 2: Full backend gate**

```bash
cd backend && go build ./... && go vet ./... && go test -race ./... 2>&1 | tail -15
```

Expected: `ok` for every package, no `FAIL`, no vet output. Docker must be running.

- [x] **Step 3: Frontend gate**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build 2>&1 | tail -8
```

Expected: all clean. Nothing in `src/**` changed; this is CI parity, not a risk.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin fix/live-path-write-reduction
gh pr create --title "fix: cut the live-match write path from ~47,000 statements to ~2,100" --body "$(cat <<'EOF'
## What

The live write path has **never executed in production** — every table shows
inserts ≈ live rows and ~zero updates because no match has been ingested while
live since the backend deployed. It runs for the first time, untested, on the
next matchday. Projected cost per 2-hour match: **~47,000 statements to persist
~420 rows of football, 110:1** (spec §3.5).

Three tables were written by a loop that issued one statement **per row of a
payload that grows all match**: at minute 90, ESPN's 113-line transcript was
rewritten in full to append one line, having already been rewritten ~270 times.
Each is now **one set-based statement** — parallel arrays, `unnest`, and an
`IS DISTINCT FROM` guard on `ON CONFLICT … DO UPDATE` so an unchanged row is not
written at all.

| write | before | after |
|---|---:|---:|
| `match_commentary` | ~20,900 | **360** |
| `appearance` | ~16,200 | **360** |
| `match_event` | ~8,600 | **360** |
| `win_prob_snapshot` | 360 | ~120 |
| `odds_snapshot` | 360 | ~120 |
| `ingest_run` | 720 | ~50 |
| `match` / `match_detail` | 720 | 720 (siblings' slices) |
| **total** | **≈47,000** | **≈2,090** |

**110 statements per durable row becomes 5.** Tuple versions — what drives WAL,
bloat and autovacuum — fall from ~46,000 to ~1,400. Ten simultaneous matches:
~470,000 writes in two hours becomes ~21,000.

## How "new" is determined

Content comparison on the primary key, performed by Postgres inside the writing
statement. Not a high-water `seq`, not a row count, not an in-process memo:

- **Late edits are handled everywhere in the transcript**, at zero marginal
  cost, because the comparison is not restricted to a tail. A watermark would
  need an arbitrary re-check window and would still miss an edit older than it.
- **Restart-correct by construction** — there is no process state to lose. A
  cold process converges a match already in progress in one statement, and can
  neither skip a line already written nor duplicate one.
- The cost is stated, not hidden: the full payload (~17 kB) is uploaded per
  poll and Postgres performs ~113 index probes to find that 112 rows are
  unchanged. One statement, no writes.

## No migration

The watermark is 15 and `0016`–`0019` are reserved by sibling plans. This plan
adds no column, table, index, constraint or grant.

## Tests

- Real Postgres (testcontainers) throughout — this path has never run, and a
  fake proves nothing about `ON CONFLICT … WHERE`.
- A pgx `QueryTracer`/`BatchTracer` counts every statement per table. Twelve
  simulated 20-second polls of a match in progress assert **one statement per
  table per tick**, independent of accumulated rows. On `main` the same test
  reports `match_commentary took 246 statements over 12 ticks, want exactly 12`.
- `xmin` assertions prove unchanged rows keep their tuple version.
- Fixed clock and an explicit tick sequence everywhere; no `time.Sleep`, no
  wall-clock assertions.
- Regression pins for the two live writes deliberately left alone
  (`match_play` is never fetched live; `match_detail` costs one write per poll).

## Scope

Spec §4.4 and §4.5 plus the live half of §5. Deliberately untouched, because
sibling plans own them: the leader double-write and the competition-level
content memo (§4.1), the `match` upsert guard (§4.2), the scheduled-match TTL
and §5's pre-match sampling ladder (§4.3), and the C1 immutability triggers
(§4.6).

**Conflict note:** `2026-08-18-postgres-storage-reduction` Task 5 also rewrites
`match_commentary`'s column list. The conflict is textual, not structural — drop
`play_type_text` from the array list, the `INSERT` and the guard tuple, and the
pattern is unaffected.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Report, and say what is still unmeasured**

Tell the user, in the PR comment or the handoff:

> The first live match is still the first live match. Watch three things on it:
> (1) `SELECT kind, count(*) FROM ingest_run WHERE started_at > now() - interval '2 hours' GROUP BY 1`
> — `odds` should be in the tens, not the hundreds; (2)
> `SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='match_commentary'`
> before and after the match — it should be within a few of the number of lines
> ESPN revised, not a multiple of the transcript; (3) a `nil` win probability on
> a live match whose odds fetch returned data, which spec §5 flags as the one
> silent failure mode this path has.

---

## Self-review notes

**Why not the runner memo the spec proposed (§4.4).** It is cheaper by one round
trip per match per poll and worse on every other axis: it needs an arbitrary
re-check window (§4.4 guesses "~10 lines"), it still misses an edit older than the
window, it behaves differently on a cold process than a warm one, and it puts half
of a data invariant in the caller. The set-based statement has no window, no
warm/cold split, and lives with the SQL it constrains. Where a memo genuinely is the
only mechanism — the minute-bucket sample gate in Task 7, where a read would cost the
statement it saves — this plan uses one, and documents it as a cost gate whose
guarantee is still the unique index, exactly as `snapshotted` already does.

**Why the ingest_run throttle is time-based and not per-cycle.** §4.5 says "one row
per kind per competition per cycle". With one live match a cycle *is* a poll, so that
wording saves nothing. Five minutes makes the row count independent of both the poll
interval and the number of simultaneous matches.

**What a pathological failure costs.** Failures are never throttled, so a bookmaker
feed dark for two hours across ten live matches writes ~7,200 `ingest_run` rows. That
is deliberate: it is bounded, it is exactly when the audit trail earns its keep, and
the alternative — a quiet failure — is the thing this system already has too much of.

**What this plan does not claim.** The "after" column is a projection, like the
"before" column. It is a better-founded one — every mechanism in it was executed
against a real Postgres before this plan was written, and again in committed tests —
but the provider's in-play behaviour is still unmeasured. The numbers that survive
contact with a live match are the ones in the Step 5 handoff above.
