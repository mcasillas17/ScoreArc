# Content-Memo Write Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the ingester rewriting `standing` and `top_scorer` when nothing
changed. Today those two tables absorb **~477,000 tuple writes and ~830,000
pooler round trips a day to keep 528 rows exactly as they were.** This plan adds
a per-scope content memo in the runner so a tick that produces the row set we
already committed issues no transaction at all — and it does that without
weakening the empty-replacement guard or the freshness signal T10.10 reads.

**Architecture:** Three moving parts, all in `backend/ingester`, none in SQL.

1. **A fingerprint over the mapped domain rows.** FNV-1a/64 over exactly the
   column values `ReplaceStandings` and `ReplaceLeaders` are about to write —
   never over the raw ESPN body, because the volatility audit proves the raw
   body carries per-fetch timestamps that would defeat the comparison on almost
   every poll (`roster.timestamp` changes on *every single fetch*, confirmed at a
   25-second gap).
2. **A memo on the runner:** `written map[string]uint64`, keyed by write scope
   (`standing`/competition/season, `top_scorer`/competition/season/category),
   holding the fingerprint of the row set **last committed by this process**.
   The runner already carries this exact pattern — `snapshotted map[string]time.Time`
   gates the daily standings snapshot with a comment saying it is "a cost gate,
   not the idempotency guarantee". This generalises it, and inherits the same
   restart story.
3. **A reordering of `refreshLeaders`:** mirror the crests **first**, then
   fingerprint the mirrored board, then write once or not at all. That single
   change also removes the unconditional second full replacement described in
   §3.1 of the spec, and `leaderCrestsChanged` — which could only ever return
   true — is deleted.

The guard sits **between** the mapper and the store. `ReplaceStandings` and
`ReplaceLeaders` are not touched: their delete-and-reinsert transaction, their
`ErrEmptyReplacement` / `ErrPartialReplacement` contracts and their grants stay
exactly as they are, and remain the authority on whether a replacement is
acceptable. The memo only decides whether to *ask*.

**Tech Stack:** Go 1.26, `hash/fnv` (stdlib), pgx v5.10.0, Postgres 17.10 (Neon
production). No new dependency, no schema change, no new `ingest_run` kind.

**Spec:** `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
— **§4.1 is what this plan implements**, with §2 (the C1–C5 classification) as
its vocabulary and §3.1 as its evidence.
**Research this plan depends on:** `docs/research/2026-08-18-espn-payload-volatility.md`
— §3, the exhaustive list of fields that change independent of any real change.
**Epic:** E7 (`docs/PRODUCT_ROADMAP.md`) — see Task 7 for the task number, which
must be confirmed at execution time.
**Branch:** `tweak/content-memo-write-guard` off latest `origin/main`

---

## 🔴 There is no migration in this plan. If you find yourself writing one, it is `0017`.

The database watermark is **15**, and **`0016` is already claimed** by
`docs/superpowers/plans/2026-08-18-postgres-storage-reduction.md`.

`golang-migrate` applies files **strictly above** the recorded version, so a file
numbered at or below the watermark is **silently skipped forever on production
while passing CI perfectly** — CI applies every `*.up.sql` in lexical order
against an empty database and therefore cannot see the difference. **This project
has shipped that defect twice.**

This plan deliberately needs **no migration at all** (Decision 1 explains why the
memo is not a column), which is the safest possible answer to that hazard. If a
later reviewer insists on persistence, the file is
`backend/migrations/0017_<name>.up.sql` + `.down.sql`, both required, and the
number must be re-checked against `SELECT * FROM schema_migrations` first —
because a sibling slice may have taken 0017 by then.

---

## What was measured, and where the numbers come from

Every figure below is from the live Neon production database, 2026-08-17/18,
with the finalization backlog drained and **no live match**. Task 1 re-measures
before you change anything; the ratios are stable but the absolute counters are
not.

### The idle slow tick — 298 seconds, exactly one tick

| table | inserts | deletes | rows the table holds |
|---|---:|---:|---:|
| `top_scorer` | **+600** | **−600** | 300 |
| `standing` | **+228** | **−228** | 228 |

At 288 slow ticks a day:

| table | rows held | tuple writes / day | ratio |
|---|---:|---:|---:|
| `standing` | 228 | **131,328** | 576× the table, every day |
| `top_scorer` | 300 | **345,600** | 1,152× the table, every day |
| **total** | **528** | **476,928** | |

`top_scorer` moves 600 tuples for a 300-row table because it is replaced
**twice** per tick — see Decision 5.

### The redundancy is measured, not inferred

Content hashes over the stored rows — `md5(to_jsonb(row) - 'updated_at' - 'id')`,
aggregated per competition and per category — were captured across **three
windows spanning confirmed delete-and-reinsert ticks** (`pg_stat_user_tables`
confirms the replacements happened between the samples).

**Nine standings tables. Ten leader boards. Zero changed, every time.** Every one
of that tick's 1,656 tuple writes reproduced the bytes it had just destroyed.

That result generalises with an argument rather than only a sample: **a standings
table is a pure function of the finished matches in its competition, and a leader
board is a pure function of the goals and assists scored in it.** Both can only
move when a match finalizes. On a heavy day ~60 matches finalize across all nine
competitions, against **2,592 competition-slow-ticks** (9 × 288). At least
**97.7%** of these replacements rewrite byte-identical content, and on most days
well over 99%.

### The cost is compute and vacuum, not storage

Neon bills compute time. Each replacement is a full transaction: `BEGIN`, a
`count(*)`, a `DELETE` touching 228 rows and their indexes, then **228 single-row
`INSERT`s issued one `tx.Exec` at a time** (`ReplaceStandings` loops; it does not
batch), `COMMIT`. That is ~230 round trips through the pooler per competition per
tick — **~830,000 a day** across the registry once the leader boards' two passes
are added — plus the WAL, plus the autovacuum that follows every delete.
`standing` and `top_scorer` are already **the two most-autovacuumed tables in the
database** (7 and 10 cycles in the first forty minutes of uptime, against zero for
tables ten times their size), despite being the smallest. That vacuum load is the
cost becoming visible.

### What this plan leaves behind

| | today | after |
|---|---:|---:|
| `standing` tuple writes / day | 131,328 | ~3,000 |
| `top_scorer` tuple writes / day | 345,600 | ~5,000 |
| replacement transactions / day | 5,184 | ~120 |
| pooler round trips / day (these two tables) | ~830,000 | ~15,000 |

The residue is the real work: ~60 finalizations a day, each rewriting one
competition's ~25-row table and its two ~17-row boards, plus one write per scope
per process start. **A ≥97% cut on both tables, and the exact figure moves with
the fixture calendar** — which is the point, because after this the write volume
finally tracks the football rather than the clock.

---

## Decision 1 — the memo lives in the runner process, not in Postgres

**This follows §4.1, and nothing in the code contradicts it.** The reasoning,
re-derived from the code rather than taken on faith:

**(a) The runner already does this, with the same semantics and the same restart
story.** `runner.snapshotted map[string]time.Time` gates `WriteStandingSnapshot`
to once per UTC day per competition, and its comment states the contract this
memo inherits verbatim:

> `snapshotted` is the UTC day each competition's standings snapshot has already
> been written for IN THIS PROCESS. It is a cost gate, not the idempotency
> guarantee — that is the unique index in migration 0004. A restart empties this
> map and the next cycle re-writes the day, which the store upserts.

Swap "day" for "fingerprint" and "unique index in 0004" for "primary key on
`standing` / `top_scorer`" and you have this design. There is already a test that
locks that restart behaviour in (`TestStandingsSnapshotSurvivesARestart`), and
Task 3 adds its twin.

**(b) There is exactly one writer, enforced by the database.** `shared/store/lease.go`
takes `pg_try_advisory_lock` on a dedicated **unpooled** connection
(`INGESTER_LEASE_DSN`, which the process rejects if the host contains `-pooler`),
and a second instance exits 1 rather than waiting. `ingester/fly.toml` pins
`strategy = "immediate"` for that reason and documents `fly scale count 1`. An
in-process memo is only unsound when a second writer can change the table behind
it; the lease is what forbids that, and it is enforced in Postgres, not by
convention.

**(c) The persisted alternative costs more than it saves, and needs a migration.**
Neither table has anywhere to put a per-scope hash: `standing`'s primary key is
`(competition_id, season_id, team_id)` and `top_scorer`'s is
`(competition_id, season_id, category, rank)`, so a `content_hash` column would
either be repeated on every row (rewriting the whole table to store it — the
thing we are trying to stop) or need a new `replacement_memo(scope, fingerprint)`
table and migration 0017. That table would take **27 UPDATEs per slow tick**
(9 competitions × 3 scopes) = **7,776 tuple writes a day**, plus its own
autovacuum, **to save ~27 writes per deploy**. Deploys happen a few times a week.
The in-process map costs one map with 27 entries and zero writes.

**(d) The map is bounded by the registry, not by the data.** One entry per
competition-season for `standing` and one per category for `top_scorer` — **27
entries** for the nine-competition registry, forever. It cannot grow with
matches, players or seasons. (A per-match memo would need a different argument;
that is a sibling slice's problem, not this one's.)

**Correctness under restart, stated plainly rather than engineered around:** a
cold memo means **one redundant replacement per scope after every deploy or
restart** — 27 writes, ~530 tuples, once. That is 0.005% of a day's current
volume and it is *correct*: the memo's only claim is "this process committed
these bytes", and a fresh process has committed nothing. **Do not add a
warm-start read-back.** Reading the table to avoid writing it pays a query to
save a query, on the one tick per deploy where it would help. The `-once` CLI
mode (`ingester/main.go`) has a cold memo by construction and always writes; that
is also correct and is the reason `-once` remains a usable operator tool.

**Rejected alternatives, for the record:**

- *Guard in SQL, `INSERT … ON CONFLICT … WHERE row IS DISTINCT FROM EXCLUDED`.*
  Turns a wholesale replacement into a per-row upsert plus a tail delete — a
  larger change to a store function whose delete-and-reinsert shape is what makes
  `ErrPartialReplacement` checkable at all, and it still issues 228 statements per
  competition per tick. The guard exists precisely to issue **zero**.
- *Batch `ReplaceStandings`' 228 `tx.Exec` calls into one `pgx.Batch`.* A real
  improvement, and explicitly **out of scope**. After this guard only ~60
  replacements a day survive, so batching would save ~13,000 of the original
  830,000 round trips — **1.6% of the problem** — for a change to the store's
  transaction shape. Do it later, on its own, against its own measurement.

---

## Decision 2 — what is hashed: the mapped domain rows, and only the columns we write

**The fingerprint is taken over `[]model.Standing` / `[]model.StatLeader` after
mapping, never over the ESPN response body.** This is not a stylistic preference;
`docs/research/2026-08-18-espn-payload-volatility.md` §3 makes a raw-body hash
unusable:

| field | endpoint | behaviour |
|---|---|---|
| `.timestamp` (top level) | `teams/{id}/roster` | **changes on every single fetch** — confirmed at a 25-second gap. It is the response's own generation time. |
| `.timestamp` (top level) | per-event `statistics?event=` | changes on a **~9–10 minute CDN regeneration cycle**, independent of the stats (which did not move across 3 samples). |
| `meta.lastUpdatedAt` | `summary?event=` | wrapper metadata of the same class; the audit says exclude preemptively. |
| `news.*` (whole subtree) | `summary`, athlete `/overview` | newsroom-driven; **one new article produced 2,087 differing leaf paths** under positional diffing. |
| `videos[]` | `summary`, athletes | same class — editorial, not match state. |
| `nextEvent…tickets[].numberAvailable` | `teams/{id}`, `scoreboard` | secondary-market counters, observed decrementing in near-real time. |

A `sha256(response body)` would therefore report "changed" on a large fraction of
polls of a competition where nothing whatsoever happened, and the guard would
never fire. **Mapping strips every one of them:** `espn.MapLeaders` reads only
`stats[].leaders[].{value, displayValue, athlete}` and `espn.MapStandings` only
the entries' stats — no wrapper timestamp can reach a `model.Standing` or a
`model.StatLeader`. (Whether the *season-level* `/statistics` body carries the
same wrapper timestamp the per-event one does is unmeasured and irrelevant for
exactly that reason.)

The audit also **cleared** `logos[].lastUpdated` — suspicious by name, byte-identical
across every sample, and a genuine crest-asset-swap timestamp. It does not reach a
mapped row at all; only the crest **href** does, as `TeamCrestURL`, and a real
crest swap *should* invalidate a leader board, because that URL is a stored column.

### Hashed for `standing` — exactly the columns `ReplaceStandings` INSERTs

`teamIDs[row.Team.ID]` (the **canonical** team id, which is what the INSERT
carries), `group_id`, `group_name`, `rank`, `played`, `wins`, `draws`, `losses`,
`goals_for`, `goals_against`, `goal_difference`, `points`, `advanced`, and
`source`.

**Deliberately not hashed:** `updated_at` (it is `now()`, so hashing it would
make every fingerprint unique — this is the whole trick), and
`row.Team.Name` / `row.Team.Abbr` / `row.Team.CrestURL`. Those last three arrive
on `model.Standing` but **`ReplaceStandings` never writes them** — they belong to
`team`, owned by the seed, the resolver and `SetTeamCrest`, each with its own
guard. Hashing them would make a crest mirror or a name correction rewrite 228
standings rows that did not change.

**The canonical id, not the provider id.** Two provider ids can resolve to one
canonical team; the fingerprint must see what lands in the column. The resolution
loop runs before the fingerprint and aborts the whole refresh on a miss, so a
partially-resolved set can never be fingerprinted.

### Hashed for `top_scorer` — exactly the columns `ReplaceLeaders` INSERTs

`category`, `rank`, `player`, `team_abbr`, `team_name`, `team_crest_url`,
`goals` (`StatLeader.Value`), `matches`, and `source` — over the **mirrored**
board (Decision 5). `top_scorer` has no `updated_at` column at all.

### Encoding rules that matter

- **`NULL` is not `''`.** `standing.group_id` is nullable and a single-table
  league stores `NULL`; a `*string` nil and a pointer to `""` must produce
  different bytes, so optional values are prefixed `-` (absent) or `+` (present).
  Same for `top_scorer.matches` (`*int`).
- **Fields and rows are separated** by `\x1f` and `\x1e`, control characters that
  cannot survive `MapStandings`/`MapLeaders` into a team name, a player name or a
  URL — so no run of values can be re-read as a different run.
- **Order-sensitive on purpose.** `(competition, season, team)` is the primary
  key, so a reordered table stores the same rows; hashing in slice order anyway
  is cheaper than sorting and errs toward **one extra write**, never a missed
  one. In practice a reorder means the ranks moved, and `rank` is hashed.

### Why FNV-1a/64 is enough

The input is a few hundred short strings produced by our own mappers from a
non-adversarial provider, and the consequence of a collision is **one skipped
write that persists until the content next changes for real** — not corruption,
and self-healing on the next genuine change. At 64 bits against ~10⁵ distinct row
sets per scope per season the collision probability is ~3×10⁻¹⁰ per scope per
year. §4.1 specifies FNV; there is no reason to pay SHA-256 for it.

---

## Decision 3 — the empty replacement must never be memoised, and never be short-circuited

This is the subtle half of the design, and it has **two** rules, not one.

**Rule A: memoise only after the store returned `nil`.** The dangerous failure is
memoising at fingerprint time rather than after commit. Board `B` maps, the write
fails (network, timeout, a rejected replacement), the memo says `B` — and the
next tick, carrying the same `B`, skips. **The table never gets `B`, and the
guard hides the failure until the content changes again.** So the memo is written
on exactly one line in each refresh, on the success branch, after the transaction
committed. A failed or rejected replacement leaves the memo pointing at the last
row set that really is in the table, which is precisely what the next tick must
compare against.

**Rule B: a zero-row set is never "unchanged".** `ReplaceLeaders` returns
`ErrEmptyReplacement` for a board that is not published, and `refreshLeaders`
treats that as **normal** — `continue`, not an error — because not every
competition publishes an assists table and an absent one must not take the Golden
Boot down with it. It records a `leaders_preserved` `ingest_run` and keeps the
rows already stored.

If an empty board could take the skip path, two things break. The
`leaders_preserved` audit row — the only signal an operator has that a board is
missing — stops being written after the first tick. And the memo starts asserting
"the last thing committed for this scope is the empty set" about a table that in
fact holds last week's board, which is simply false. So `contentUnchanged`
refuses a zero-row set outright, the store stays the authority on what an absent
board means, and that branch remains reachable on every tick.

`ReplaceStandings`' `ErrEmptyReplacement` / `ErrPartialReplacement` are covered by
the same two rules: `refreshStandings` returns early on both, before the success
branch, so neither can memoise.

**One behavioural consequence, called out because it breaks an existing test:**
once the guard lands, a store-side rejection is unreachable when the content is
byte-identical to what we last committed — we no longer ask. That is correct
(`ErrPartialReplacement` fires when the incoming set is *smaller* than the stored
one, which an identical set is not), and
`TestStandingsSnapshotRetriesAfterFinalizationReplacementIsRejected` currently
relies on it being reachable with unchanged content. Task 3 Step 4 repairs it by
making the content actually move, which is also the more faithful scenario.

---

## Decision 4 — a skipped write still records an `ingest_run`, under the same kind

`recordRun` is called **once per operation per competition per cycle**, at the end
of the operation, with the error it produced:

```go
r.recordRun(ctx, comp.ID, "standings", start, err)   // refreshStandings
r.recordRun(ctx, comp.ID, "leaders", start, joined)  // refreshLeaders
```

T10.10's freshness endpoint (`docs/superpowers/plans/2026-08-18-api-health-and-provenance.md`)
reads `ingest_run` **per competition per kind**, with a **20-minute** threshold for
`standings` and `leaders` — chosen to tolerate three missed slow ticks. A guard
that stopped recording those runs, or recorded them under a new kind like
`standings_unchanged`, would make a perfectly healthy competition report **stale
within twenty minutes of its table settling** — trading a write-amplification bug
for a monitoring one, and the monitoring one is worse because it fires on exactly
the competitions that are working.

So the guard is placed **inside** the operation, between the mapper and the store,
and changes nothing about the audit:

- the `standings` / `leaders` run is recorded on every tick, `ok = true`, as today;
- **no new `ingest_run` kind is introduced** — `ingest_run` is C5 and should get
  coarser, not finer;
- `leaders_preserved` still fires per absent board, per tick (Decision 3);
- `standings_preserved` still fires on a rejected standings replacement;
- `standings_snapshot` is untouched: `snapshotStandings` sits downstream of the
  `err == nil` path and a skip keeps `err == nil`, so **the daily snapshot fires
  whether or not the live table was rewritten**. That is deliberate and load-bearing
  — `standing_snapshot` is **C4**, the one class where writing the same value twice
  is *correct*, and ESPN publishes today's table but never yesterday's. The memo
  gates C3 and must never reach C4.
- `refreshSquads` is downstream of the same path and is likewise unaffected.

The skip itself logs at `Debug`. The ingester's logger is
`slog.New(slog.NewJSONHandler(os.Stdout, nil))` — default level `Info` — so a
Debug line is dropped in production, which is the right answer for something that
would otherwise print 2,600 lines a day to say "nothing happened". **The proof
that the guard works is the `pg_stat_user_tables` delta in Task 8, not a log
line.**

---

## Decision 5 — mirror first, fingerprint the mirrored board, write once

`refreshLeaders` today writes the board, mirrors its crests to R2, and then
re-writes the entire board when `leaderCrestsChanged(board, mirrored)`:

```go
writeErr := r.repo.ReplaceLeaders(ctx, comp.ID, season.ID, sourceESPN, category, board)
...
mirrored := r.mirrorLeaders(ctx, board)
if leaderCrestsChanged(board, mirrored) {
	if err := r.repo.ReplaceLeaders(ctx, comp.ID, season.ID, sourceESPN, category, mirrored); err != nil {
```

`board` is mapped fresh from ESPN on every tick and therefore **always** carries
`a.espncdn.com` URLs; `mirrored` **always** carries `cdn.scorearc.futbol` ones.
**The comparison is unconditionally true, so the second full replacement runs on
every tick, forever.** That is why 600 tuples move for a 300-row table, and it is
independently confirmed by the stored data: all 300 rows carry CDN hosts, which is
only reachable through the second write.

There is a correctness edge inside it too — between the two writes the table
serves provider hotlinks.

Mirroring **before** the fingerprint fixes both at once: mirror, fingerprint the
mirrored board, write it once or not at all. `leaderCrestsChanged` then has no job
and is deleted, along with its only helper `stringValue` (Task 4 verifies neither
has another caller).

**Mirroring on a tick whose write is skipped is free.** `mirrorLeader`
short-circuits on `isMirroredURL`, and otherwise reads `r.mirrored[assetID]`, an
in-process cache keyed by a hash of the source URL — so after the first tick no
R2 call is made. `TestLeaderCrestMirrorsOnceAcrossRefreshes` already asserts
exactly that across two cycles and must keep passing.

If the mirror is unavailable, the board is written with provider URLs and *that*
is what gets memoised; when the mirror recovers the URLs change, the fingerprint
moves, and the board is rewritten once. Correct, and no worse than today.

---

## What this plan does NOT touch

Five sibling slices are being planned in parallel against the same spec. This one
is **only** the competition-level content memo.

- **`match` / `match_detail` upsert guard (§4.2)** — another agent. Do not extend
  `store.MatchRow`, do not touch `processMatches` or `matchUpsertSQL`.
- **Scheduled-match summary TTL (§4.3)** — another agent. Do not touch
  `needsSummary` in `ingester/schedule.go`.
- **Commentary tail (§4.4)** — another agent. Do not touch `WriteCommentary` or
  `WriteParticipation`.
- **`ingest_run` coarsening (§4.5)** and **C1 triggers (§4.6)** — not here. This
  plan adds no `ingest_run` rows and no migration.
- **`ReplaceSquad`'s unconditional `UPDATE player` (§3.4)** — not here.
- **`backend/shared/store/competitions.go`** — unchanged. The store's replacement
  contract is what the guard defers to, not what it edits.
- **`backend/reader/**`, `backend/migrations/**`, `src/**`** — unchanged.

---

## Global Constraints

- **No migration.** If one ever becomes necessary it is `0017` and the watermark
  must be re-checked first — see the red box.
- **No new `ingest_run` kind, and no removal of an existing one.** T10.10 reads
  `standings` and `leaders` with a 20-minute threshold.
- **Never memoise anything the store did not commit** (Decision 3, Rule A), and
  **never let a zero-row set take the skip path** (Rule B).
- Backend gate, all three, from `backend/`:
  `go build ./... && go vet ./... && go test -race ./...`
  (the testcontainers packages need **Docker running**).
- Frontend gate, still required by `ci.yml` on a backend-only PR:
  `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Never print a DSN or a credential into a commit, a log or a PR body.
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.
- **Never push to `main`.** Feature branch, PR, and the merge is the user's call.

---

## File Structure

**New:**
- `backend/ingester/memo.go` — the fingerprint, the scope keys, and the two
  runner methods.
- `backend/ingester/memo_test.go` — unit tests for the fingerprint.

**Modified:**
- `backend/ingester/runner.go` — the `written` field on `runner`; the guard in
  `refreshStandings`; the mirror-first restructure of `refreshLeaders`; deletion
  of `leaderCrestsChanged` and `stringValue`.
- `backend/ingester/main.go` — `written: make(map[string]uint64)` in the runner
  literal.
- `backend/ingester/runner_test.go` — `written` in `testRunner`; one new field on
  `fakeRepository`; six new tests; one existing test repaired.
- `docs/backend/ARCHITECTURE.md` — the `standing` and `top_scorer` bullets gain
  the write-cadence policy.
- `docs/PRODUCT_ROADMAP.md` — one roadmap row (Task 7 confirms the number).

**Deliberately NOT modified** — checked, and the reasons are in "What this plan
does NOT touch" above: `backend/shared/store/competitions.go`,
`backend/shared/espn/**`, `backend/migrations/**`, `backend/reader/**`, `src/**`.

---

### Task 1: Measure your own baseline, then branch

**Files:** none — this task produces evidence, not code.

The database is written to continuously, so the numbers in this plan are not your
baseline; yours is. The PR body quotes both.

- [x] **Step 1: Capture the tuple counters, twice, across a slow tick**

```bash
set -a; source ~/.scorearc-db.env; set +a
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
psql "$DIRECT_DSN" -X -c "SELECT now()::timestamptz(0) AS sampled_at, relname,
    n_tup_ins, n_tup_del, n_live_tup, autovacuum_count
  FROM pg_stat_user_tables
  WHERE relname IN ('standing','top_scorer') ORDER BY relname;"
sleep 330
psql "$DIRECT_DSN" -X -c "SELECT now()::timestamptz(0) AS sampled_at, relname,
    n_tup_ins, n_tup_del, n_live_tup, autovacuum_count
  FROM pg_stat_user_tables
  WHERE relname IN ('standing','top_scorer') ORDER BY relname;"
```

Expected: between the two samples, `standing` gains roughly **+228 inserts and
+228 deletes** against ~228 live tuples, and `top_scorer` roughly **+600 and
+600** against ~300 live tuples. `autovacuum_count` on both is high relative to
every larger table. Record the exact deltas.

If the deltas are ~0, a slow tick did not land inside your window (or the ingester
is down) — re-run with a longer sleep before concluding anything.

- [x] **Step 2: Confirm the content is genuinely unchanged across that tick**

Run this twice, spanning another tick, and diff the two outputs:

```bash
psql "$DIRECT_DSN" -X -c "
SELECT competition_id, season_id,
       count(*) AS rows,
       md5(string_agg(row_hash, '' ORDER BY row_hash)) AS table_hash
FROM (SELECT competition_id, season_id,
             md5((to_jsonb(s.*) - 'updated_at')::text) AS row_hash
      FROM standing s) rows
GROUP BY 1,2 ORDER BY 1,2;" \
 -c "
SELECT competition_id, season_id, category,
       count(*) AS rows,
       md5(string_agg(row_hash, '' ORDER BY row_hash)) AS board_hash
FROM (SELECT competition_id, season_id, category,
             md5(to_jsonb(t.*)::text) AS row_hash
      FROM top_scorer t) rows
GROUP BY 1,2,3 ORDER BY 1,2,3;"
```

Expected: **every `table_hash` and every `board_hash` identical between the two
runs**, while Step 1 proves the rows were deleted and reinserted in between. That
is the whole justification for this plan, reproduced by you. (`standing` has no
`id` column and `top_scorer` has neither `id` nor `updated_at`, which is why only
`standing` needs the `- 'updated_at'` subtraction.)

If a hash *does* change, note which competition — a match finalized during your
window, which is the guard working as intended and not a counter-example. Re-run
across a quieter tick.

- [x] **Step 3: Confirm the migration watermark, so you do not accidentally need one**

```bash
psql "$DIRECT_DSN" -X -c 'SELECT * FROM schema_migrations;'
```

Expected: `version | dirty` = `15 | f`. This plan writes **no** migration; you are
checking so that if a reviewer later asks for one you already know the number is
0017 and that 0016 is claimed elsewhere.

- [x] **Step 4: Branch**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git fetch origin && git checkout -b tweak/content-memo-write-guard origin/main
```

---

### Task 2: The fingerprint and the memo

**Files:**
- Create: `backend/ingester/memo.go`
- Create: `backend/ingester/memo_test.go`
- Modify: `backend/ingester/runner.go` (the `written` field)
- Modify: `backend/ingester/main.go` (initialise it)
- Modify: `backend/ingester/runner_test.go` (initialise it in `testRunner`)

**Interfaces:**
- `standingsScope(competitionID, seasonID string) string`
- `leadersScope(competitionID, seasonID, category string) string`
- `standingsFingerprint(source string, rows []model.Standing, teamIDs map[string]string) uint64`
- `leadersFingerprint(source, category string, rows []model.StatLeader) uint64`
- `(*runner).contentUnchanged(scope string, rowCount int, digest uint64) bool`
- `(*runner).markContentWritten(scope string, digest uint64)`

- [x] **Step 1: Write the failing test**

Create `backend/ingester/memo_test.go`:

```go
package main

import (
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func standingFixture() model.Standing {
	group := "A"
	name := "Group A"
	return model.Standing{
		Team:      model.Team{ID: "espn-1", Name: "Home", Abbr: "HOM"},
		GroupID:   &group,
		GroupName: &name,
		Rank:      1, Played: 3, Wins: 2, Draws: 1, Losses: 0,
		GoalsFor: 5, GoalsAgainst: 2, GoalDifference: 3, Points: 7,
		Advanced: true,
	}
}

func leaderFixture() model.StatLeader {
	crest := "https://a.espncdn.com/i/teamlogos/soccer/500/359.png"
	matches := 3
	return model.StatLeader{
		Rank: 1, Player: "Striker", TeamAbbr: "HOM", TeamName: "Home",
		TeamCrestURL: &crest, Value: 5, Matches: &matches,
	}
}

func testTeamIDs() map[string]string {
	return map[string]string{"espn-1": "canonical-1"}
}

// Every column ReplaceStandings INSERTs must move the fingerprint. A column
// that does not is a column whose change would be silently skipped -- which is
// the only way this guard can lose data.
func TestStandingsFingerprintMovesWithEveryWrittenColumn(t *testing.T) {
	t.Parallel()
	teamIDs := testTeamIDs()
	base := standingsFingerprint(sourceESPN, []model.Standing{standingFixture()}, teamIDs)

	otherGroup := "B"
	otherName := "Group B"
	mutations := map[string]func(*model.Standing){
		"rank":            func(row *model.Standing) { row.Rank = 2 },
		"played":          func(row *model.Standing) { row.Played = 4 },
		"wins":            func(row *model.Standing) { row.Wins = 3 },
		"draws":           func(row *model.Standing) { row.Draws = 2 },
		"losses":          func(row *model.Standing) { row.Losses = 1 },
		"goals for":       func(row *model.Standing) { row.GoalsFor = 6 },
		"goals against":   func(row *model.Standing) { row.GoalsAgainst = 3 },
		"goal difference": func(row *model.Standing) { row.GoalDifference = 4 },
		"points":          func(row *model.Standing) { row.Points = 10 },
		"advanced":        func(row *model.Standing) { row.Advanced = false },
		"group id":        func(row *model.Standing) { row.GroupID = &otherGroup },
		"group name":      func(row *model.Standing) { row.GroupName = &otherName },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := standingFixture()
			mutate(&row)
			if standingsFingerprint(sourceESPN, []model.Standing{row}, teamIDs) == base {
				t.Fatalf("%s does not move the fingerprint; a real change would be skipped", name)
			}
		})
	}
}

// The mirror image, and the reason the guard is worth anything: fields that
// arrive on model.Standing but are NOT written by ReplaceStandings must not
// move it. team.name/abbr/crest belong to `team`, which the seed, the resolver
// and SetTeamCrest own; hashing them would make one crest mirror rewrite 228
// standings rows that did not change.
func TestStandingsFingerprintIgnoresColumnsTheReplacementDoesNotWrite(t *testing.T) {
	t.Parallel()
	teamIDs := testTeamIDs()
	base := standingsFingerprint(sourceESPN, []model.Standing{standingFixture()}, teamIDs)

	row := standingFixture()
	crest := "https://cdn.scorearc.futbol/teams/canonical-1.png"
	row.Team.Name = "Home Renamed"
	row.Team.Abbr = "HRN"
	row.Team.CrestURL = &crest

	if standingsFingerprint(sourceESPN, []model.Standing{row}, teamIDs) != base {
		t.Fatal("the standings fingerprint tracks team fields the replacement never writes")
	}
}

// standing.group_id is nullable and a single-table league stores NULL, not ''.
// They are different values in the database, so they must be different bytes
// here.
func TestStandingsFingerprintSeparatesNullFromEmptyGroup(t *testing.T) {
	t.Parallel()
	teamIDs := testTeamIDs()
	empty := ""

	nullGroup := standingFixture()
	nullGroup.GroupID, nullGroup.GroupName = nil, nil
	emptyGroup := standingFixture()
	emptyGroup.GroupID, emptyGroup.GroupName = &empty, &empty

	if standingsFingerprint(sourceESPN, []model.Standing{nullGroup}, teamIDs) ==
		standingsFingerprint(sourceESPN, []model.Standing{emptyGroup}, teamIDs) {
		t.Fatal("NULL and '' collide; standing.group_id distinguishes them")
	}
}

// The INSERT carries the CANONICAL team id, so the fingerprint must follow it
// even when the provider row is byte-identical.
func TestStandingsFingerprintFollowsTheCanonicalTeamID(t *testing.T) {
	t.Parallel()
	rows := []model.Standing{standingFixture()}
	if standingsFingerprint(sourceESPN, rows, map[string]string{"espn-1": "canonical-1"}) ==
		standingsFingerprint(sourceESPN, rows, map[string]string{"espn-1": "canonical-2"}) {
		t.Fatal("a re-resolved team does not move the fingerprint")
	}
}

func TestLeadersFingerprintMovesWithEveryWrittenColumn(t *testing.T) {
	t.Parallel()
	base := leadersFingerprint(sourceESPN, "goals", []model.StatLeader{leaderFixture()})

	mirrored := "https://cdn.scorearc.futbol/teams/scorer-abc.png"
	otherMatches := 4
	mutations := map[string]func(*model.StatLeader){
		"rank":      func(row *model.StatLeader) { row.Rank = 2 },
		"player":    func(row *model.StatLeader) { row.Player = "Someone Else" },
		"team abbr": func(row *model.StatLeader) { row.TeamAbbr = "AWY" },
		"team name": func(row *model.StatLeader) { row.TeamName = "Away" },
		// The mirrored crest is the whole reason the fingerprint is taken
		// AFTER mirrorLeaders: the URL is a stored column.
		"crest":   func(row *model.StatLeader) { row.TeamCrestURL = &mirrored },
		"value":   func(row *model.StatLeader) { row.Value = 6 },
		"matches": func(row *model.StatLeader) { row.Matches = &otherMatches },
		"matches absent": func(row *model.StatLeader) { row.Matches = nil },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := leaderFixture()
			mutate(&row)
			if leadersFingerprint(sourceESPN, "goals", []model.StatLeader{row}) == base {
				t.Fatalf("%s does not move the fingerprint", name)
			}
		})
	}

	// The category is in the scope key already; it is in the digest too so a
	// mis-keyed scope cannot make the goals board look like the assists one.
	if leadersFingerprint(sourceESPN, "assists", []model.StatLeader{leaderFixture()}) == base {
		t.Fatal("the category does not move the fingerprint")
	}
}

// matches is nullable: "no matches figure published" and "zero matches" are
// different rows.
func TestLeadersFingerprintSeparatesNullFromZeroMatches(t *testing.T) {
	t.Parallel()
	zero := 0
	absent := leaderFixture()
	absent.Matches = nil
	present := leaderFixture()
	present.Matches = &zero

	if leadersFingerprint(sourceESPN, "goals", []model.StatLeader{absent}) ==
		leadersFingerprint(sourceESPN, "goals", []model.StatLeader{present}) {
		t.Fatal("a NULL matches count collides with zero")
	}
}

// Row order is not itself a change -- the primary keys make a reordered table
// the same table. Hashing in slice order anyway is deliberate: it is cheaper
// than sorting and it errs toward one extra write, never a missed one.
func TestFingerprintsAreOrderSensitive(t *testing.T) {
	t.Parallel()
	teamIDs := map[string]string{"espn-1": "canonical-1", "espn-2": "canonical-2"}
	first := standingFixture()
	second := standingFixture()
	second.Team.ID = "espn-2"
	second.Rank = 2

	if standingsFingerprint(sourceESPN, []model.Standing{first, second}, teamIDs) ==
		standingsFingerprint(sourceESPN, []model.Standing{second, first}, teamIDs) {
		t.Fatal("row order does not move the fingerprint; the encoding is ambiguous")
	}
}

// The memo is a claim about what THIS PROCESS committed, so it must never
// answer "unchanged" for a row set nothing has committed -- and an empty row
// set is the case that matters, because ReplaceLeaders rejects it and the
// runner preserves the stored board instead.
func TestContentUnchangedRefusesAnEmptyRowSet(t *testing.T) {
	t.Parallel()
	worker := &runner{written: map[string]uint64{}}
	scope := leadersScope("test", "2026", "assists")
	empty := leadersFingerprint(sourceESPN, "assists", nil)

	worker.markContentWritten(scope, empty)

	if worker.contentUnchanged(scope, 0, empty) {
		t.Fatal("an empty board was memoised as unchanged; the absent-board audit would stop firing")
	}
}

func TestContentUnchangedIsScoped(t *testing.T) {
	t.Parallel()
	worker := &runner{written: map[string]uint64{}}
	rows := []model.StatLeader{leaderFixture()}
	digest := leadersFingerprint(sourceESPN, "goals", rows)

	worker.markContentWritten(leadersScope("test", "2026", "goals"), digest)

	if !worker.contentUnchanged(leadersScope("test", "2026", "goals"), len(rows), digest) {
		t.Fatal("the scope it was written for reports changed")
	}
	for _, other := range []string{
		leadersScope("test", "2026", "assists"),
		leadersScope("test", "2025", "goals"),
		leadersScope("other", "2026", "goals"),
		standingsScope("test", "2026"),
	} {
		if worker.contentUnchanged(other, len(rows), digest) {
			t.Fatalf("scope %q shares a memo entry with another scope", other)
		}
	}
}
```

- [x] **Step 2: Run it and watch it fail**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend && go test ./ingester/ -run 'Fingerprint|ContentUnchanged'
```

Expected: a **compile failure**, not a test failure —

```
./memo_test.go:...: undefined: standingsFingerprint
./memo_test.go:...: undefined: leadersFingerprint
./memo_test.go:...: undefined: leadersScope
./memo_test.go:...: undefined: standingsScope
./memo_test.go:...: unknown field written in struct literal of type runner
```

A red compiler is the correct first state for a symbol that does not exist yet.

- [x] **Step 3: Write `memo.go`**

Create `backend/ingester/memo.go`:

```go
package main

import (
	"hash"
	"hash/fnv"
	"strconv"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// The content memo -- the C3 write guard from §4.1 of
// docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md.
//
// WHAT IT SOLVES. `standing` and `top_scorer` are replaced WHOLESALE -- DELETE
// the scope, INSERT every row, one tx.Exec at a time -- on every slow tick, for
// every competition, whether or not a single result moved. Measured on
// production over a 298-second window with the backlog drained and no live
// match: standing +228/-228 for a 228-row table, top_scorer +600/-600 for a
// 300-row table. ~477,000 tuple writes and ~830,000 pooler round trips a day to
// keep 528 rows exactly as they were, and both tables are already the most
// autovacuumed in the database despite being the smallest.
//
// WHY SKIPPING IS SAFE. A standings table is a pure function of the finished
// matches in its competition, and a leader board is a pure function of the
// goals and assists scored in it; both can only move when a match finalizes.
// That was measured, not assumed: content hashes over the stored rows,
// aggregated per competition and per category, were captured across three
// windows that pg_stat_user_tables confirms spanned full delete-and-reinsert
// ticks. Nine standings tables, ten leader boards, ZERO changed, every time.
//
// WHY IT HASHES MAPPED ROWS AND NOT THE ESPN BODY.
// docs/research/2026-08-18-espn-payload-volatility.md §3 lists fields that
// change independently of any real change: roster `.timestamp` moves on EVERY
// SINGLE FETCH (confirmed at a 25-second gap), the per-event statistics
// `.timestamp` moves on a ~9-10 minute CDN regeneration cycle, and
// `summary.meta.lastUpdatedAt`, the whole `news.*` subtree, `videos[]` and the
// ticket counters all churn on their own schedule. A hash of the response body
// would report "changed" on most polls and this guard would never fire. The
// mappers strip all of it: nothing but the columns below reaches a
// model.Standing or a model.StatLeader.
//
// WHAT IT IS NOT. A cost gate, exactly like the runner's `snapshotted` day
// marker -- it carries no correctness weight. The primary keys on `standing`
// and `top_scorer` remain the guarantee, a restart empties the map and rewrites
// each scope once (27 writes, once, per deploy), and nothing is EVER memoised
// that the store did not commit.

const (
	// A unit separator between fields and a record separator between rows, so
	// no run of values can be re-read as a different run. Both are C0 control
	// characters that cannot survive MapStandings/MapLeaders into a team name,
	// a player name or a URL.
	fingerprintFieldSep = "\x1f"
	fingerprintRowSep   = "\x1e"
)

// contentDigest accumulates FNV-1a/64 over a canonical encoding of the exact
// column values a replacement is about to write.
//
// FNV rather than SHA-256 because the input is a few hundred short strings that
// our own mappers produced from a non-adversarial provider, and because the
// only consequence of a collision is ONE skipped write that persists until the
// content next changes for real -- self-healing, not corrupting. At 64 bits
// against ~10^5 distinct row sets per scope per season that is a ~3e-10 chance
// per scope per year.
type contentDigest struct{ hash hash.Hash64 }

func newContentDigest() *contentDigest {
	return &contentDigest{hash: fnv.New64a()}
}

// text writes one field. hash.Hash's contract is that Write never returns an
// error, which is why the returns are discarded here and nowhere else.
func (d *contentDigest) text(value string) {
	_, _ = d.hash.Write([]byte(value))
	_, _ = d.hash.Write([]byte(fingerprintFieldSep))
}

func (d *contentDigest) number(value int) { d.text(strconv.Itoa(value)) }

func (d *contentDigest) flag(value bool) { d.text(strconv.FormatBool(value)) }

// optionalText keeps a nil pointer distinct from a pointer to "". They are
// different values in the database -- standing.group_id is nullable and a
// single-table league stores NULL, not '' -- so they must be different bytes
// here. The "-"/"+" prefix is what stops a nil colliding with any real string.
func (d *contentDigest) optionalText(value *string) {
	if value == nil {
		d.text("-")
		return
	}
	d.text("+" + *value)
}

func (d *contentDigest) optionalNumber(value *int) {
	if value == nil {
		d.text("-")
		return
	}
	d.text("+" + strconv.Itoa(*value))
}

func (d *contentDigest) endRow() { _, _ = d.hash.Write([]byte(fingerprintRowSep)) }

func (d *contentDigest) sum() uint64 { return d.hash.Sum64() }

func standingsScope(competitionID, seasonID string) string {
	return "standing\x00" + competitionID + "\x00" + seasonID
}

func leadersScope(competitionID, seasonID, category string) string {
	return "top_scorer\x00" + competitionID + "\x00" + seasonID + "\x00" + category
}

// standingsFingerprint covers EXACTLY the columns ReplaceStandings INSERTs, in
// its own order.
//
// The team id hashed is the CANONICAL one -- teamIDs[row.Team.ID] -- because
// that is what the INSERT carries, and two provider ids can resolve to one
// canonical team. The resolution loop in refreshStandings runs first and aborts
// the refresh on a miss, so a partially resolved set never reaches here.
//
// Team.Name, Team.Abbr and Team.CrestURL are DELIBERATELY absent: they arrive
// on model.Standing but ReplaceStandings never writes them. They belong to
// `team`, which the seed, the resolver and SetTeamCrest own, each with its own
// guard. Hashing them would make one crest mirror rewrite 228 standings rows
// that did not change.
//
// updated_at is absent for the obvious reason -- it is now(), so hashing it
// would make every fingerprint unique and the guard would never fire.
func standingsFingerprint(
	source string,
	rows []model.Standing,
	teamIDs map[string]string,
) uint64 {
	digest := newContentDigest()
	digest.text(source)
	for _, row := range rows {
		digest.text(teamIDs[row.Team.ID])
		digest.optionalText(row.GroupID)
		digest.optionalText(row.GroupName)
		digest.number(row.Rank)
		digest.number(row.Played)
		digest.number(row.Wins)
		digest.number(row.Draws)
		digest.number(row.Losses)
		digest.number(row.GoalsFor)
		digest.number(row.GoalsAgainst)
		digest.number(row.GoalDifference)
		digest.number(row.Points)
		digest.flag(row.Advanced)
		digest.endRow()
	}
	return digest.sum()
}

// leadersFingerprint covers EXACTLY the columns ReplaceLeaders INSERTs.
// top_scorer has no updated_at column at all, so every stored value is here.
//
// It must be taken over the MIRRORED board -- after mirrorLeaders has run --
// because team_crest_url is a stored column and the mirror is what decides its
// final value. Fingerprinting the freshly-mapped board instead would memoise
// a.espncdn.com URLs against a table holding cdn.scorearc.futbol ones and
// rewrite the board on every tick forever, which is precisely the bug §3.1
// found in leaderCrestsChanged.
func leadersFingerprint(
	source, category string,
	rows []model.StatLeader,
) uint64 {
	digest := newContentDigest()
	digest.text(source)
	digest.text(category)
	for _, row := range rows {
		digest.number(row.Rank)
		digest.text(row.Player)
		digest.text(row.TeamAbbr)
		digest.text(row.TeamName)
		digest.optionalText(row.TeamCrestURL)
		digest.number(row.Value)
		digest.optionalNumber(row.Matches)
		digest.endRow()
	}
	return digest.sum()
}

// contentUnchanged reports whether `digest` is the fingerprint this PROCESS
// last committed for scope.
//
// A ZERO-ROW SET IS NEVER UNCHANGED, and that is the load-bearing half of this
// function. ReplaceStandings and ReplaceLeaders reject an empty replacement
// (ErrEmptyReplacement) and the runner turns that into a "…_preserved" audit
// row while keeping the rows already stored -- normal, because not every
// competition publishes every board. Nothing is committed on that path, so
// letting an empty set take the skip would (a) stop the absent-board audit
// firing after the first tick and (b) have the memo assert that the table holds
// nothing when it in fact holds last week's board. The store, not the memo,
// decides what an absent board means.
func (r *runner) contentUnchanged(scope string, rowCount int, digest uint64) bool {
	if rowCount == 0 {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, seen := r.written[scope]
	return seen && previous == digest
}

// markContentWritten records a fingerprint that a replacement transaction
// COMMITTED. Call it on the success branch and nowhere else: memoising before
// the write, or on an error path, would let a failed write be skipped on the
// next tick and hide the failure until the content changed again.
func (r *runner) markContentWritten(scope string, digest uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.written == nil {
		// Defensive, in the same shape as mirrorAsset's rejectedAssets guard: a
		// runner literal that forgets this map must not panic mid-cycle.
		r.written = make(map[string]uint64, 32)
	}
	r.written[scope] = digest
}
```

- [x] **Step 4: Add the field and initialise it in both constructors**

In `backend/ingester/runner.go`, in the `runner` struct, immediately after the
`snapshotted` field and its comment, add:

```go
	// written maps a write scope -- one per (competition, season) for `standing`
	// and one per (competition, season, category) for `top_scorer` -- to the
	// fingerprint of the row set last COMMITTED for it IN THIS PROCESS. Like
	// `snapshotted` above it is purely a cost gate: the tables' primary keys
	// remain the guarantee, and a restart empties the map and rewrites each
	// scope once, which is correct and costs ~530 tuples per deploy. Bounded by
	// the registry at three entries per competition, so it cannot grow with
	// matches, players or seasons. See memo.go.
	written map[string]uint64
```

In `backend/ingester/main.go`, in the `worker := &runner{...}` literal, after
`snapshotted: make(map[string]time.Time),`:

```go
		written:           make(map[string]uint64, 32),
```

In `backend/ingester/runner_test.go`, in `testRunner`'s `&runner{...}` literal,
after `snapshotted: make(map[string]time.Time),`:

```go
		written:           make(map[string]uint64, 32),
```

- [x] **Step 5: Run the tests**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend && go test ./ingester/ -race -run 'Fingerprint|ContentUnchanged' -v
```

Expected: every subtest `PASS`, including all twelve `standings` mutations and
all eight `leaders` mutations. If a mutation subtest fails, the corresponding
column is missing from the fingerprint — fix `memo.go`, never the test.

- [x] **Step 6: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/ingester/memo.go backend/ingester/memo_test.go \
        backend/ingester/runner.go backend/ingester/main.go backend/ingester/runner_test.go
git commit -m "feat: fingerprint the rows a competition-level replacement writes

FNV-1a/64 over exactly the columns ReplaceStandings and ReplaceLeaders
INSERT, taken over the MAPPED domain rows rather than the ESPN body --
the volatility audit shows the raw payloads carry per-fetch timestamps
(roster .timestamp changes on every single fetch) that would defeat a
naive content hash.

Adds runner.written, the memo those fingerprints live in. Nothing reads
it yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Guard `refreshStandings`

**Files:**
- Modify: `backend/ingester/runner.go`
- Test: `backend/ingester/runner_test.go`

**Interfaces:** none new. `refreshStandings`' signature and every one of its
downstream calls — crest mirroring, `recordRun("standings", …)`,
`snapshotStandings`, `refreshSquads` — are unchanged.

- [x] **Step 1: Write the failing tests**

Append to `backend/ingester/runner_test.go`:

```go
// THE TEST THIS SLICE EXISTS FOR. Two consecutive slow ticks over identical
// upstream content must produce exactly ONE replacement.
//
// Measured on production before this guard: `standing` took +228 inserts and
// -228 deletes per tick against a 228-row table -- 131,328 tuple writes a day
// to keep 228 rows as they were -- while content hashes over those same rows,
// captured across three tick boundaries, never once changed.
func TestUnchangedStandingsAreReplacedOnce(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.standingsCalls != 1 {
		t.Fatalf("ReplaceStandings calls = %d across two identical slow ticks, want 1",
			repo.standingsCalls)
	}
}

// The other half of the contract, and the one that makes the guard safe: a
// table that MOVED must be written. A standings table moves when a match
// finalizes, which is the only thing that can move it.
func TestChangedStandingsAreReplacedAgain(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)

	src.mu.Lock()
	src.standings = []model.Standing{{
		Rank: 1, Team: model.Team{ID: "home"},
		Played: 1, Wins: 1, Points: 3, GoalsFor: 2, GoalDifference: 2,
	}}
	src.mu.Unlock()
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.standingsCalls != 2 {
		t.Fatalf("ReplaceStandings calls = %d after the table moved, want 2",
			repo.standingsCalls)
	}
}

// The memo records what was COMMITTED. A failed replacement must leave it
// pointing at the last row set that really is in the table, or the next tick
// would skip the retry and hide the failure until the content changed again.
func TestFailedStandingsReplacementIsNotMemoised(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{
		existing:     map[string]store.MatchRow{},
		standingsErr: errors.New("write failed"),
	}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	if first := worker.runCycle(context.Background(), true); first.failures == 0 {
		t.Fatal("a failed standings replacement did not fail the cycle")
	}

	repo.mu.Lock()
	repo.standingsErr = nil
	repo.mu.Unlock()

	if second := worker.runCycle(context.Background(), true); second.failures != 0 {
		t.Fatalf("retry cycle = %+v, want a clean cycle", second)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.standingsCalls != 2 {
		t.Fatalf("ReplaceStandings calls = %d, want the failure retried", repo.standingsCalls)
	}
}

// A restart empties the memo, exactly as it empties the snapshot day gate. One
// redundant replacement per scope per deploy -- 27 writes, ~530 tuples, once --
// is the correct price for holding no state the database has to keep in sync,
// and it is the same trade TestStandingsSnapshotSurvivesARestart already makes.
func TestStandingsMemoIsColdAfterARestart(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}

	testRunner(src, repo, comp).runCycle(context.Background(), true)
	testRunner(src, repo, comp).runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.standingsCalls != 2 {
		t.Fatalf("ReplaceStandings calls = %d across two processes, want 2",
			repo.standingsCalls)
	}
}
```

- [x] **Step 2: Run them and watch the first one fail**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend && go test ./ingester/ -race -run 'Standings(AreReplaced|MemoIsCold)|UnchangedStandings|FailedStandings'
```

Expected: `FAIL`, with

```
--- FAIL: TestUnchangedStandingsAreReplacedOnce
    runner_test.go:...: ReplaceStandings calls = 2 across two identical slow ticks, want 1
```

The other three pass already — they describe behaviour today's code has by
accident (it writes unconditionally) and must keep after the guard.

- [x] **Step 3: Add the guard**

In `backend/ingester/runner.go`, inside `refreshStandings`, replace:

```go
	if err == nil {
		err = r.repo.ReplaceStandings(ctx, comp.ID, season.ID, sourceESPN, rows, teamIDs)
	}
```

with:

```go
	if err == nil {
		// The C3 guard (spec §4.1). A standings table is a pure function of the
		// finished matches in its competition, so it can only move when a match
		// finalizes -- ~60 times a day across all nine competitions, against
		// 2,592 competition-slow-ticks. Measured on production across three
		// windows spanning confirmed delete-and-reinsert ticks: nine tables,
		// zero changes. Everything below this block is unchanged; the guard only
		// decides whether to open the transaction at all.
		//
		// Note what is NOT gated on it: the crest mirroring below, the
		// `standings` ingest_run (T10.10 reads it with a 20-minute threshold and
		// a skip must not read as stale), snapshotStandings -- which is C4, the
		// class where writing the same value twice is CORRECT -- and
		// refreshSquads. A skip keeps err == nil precisely so all four still run.
		scope := standingsScope(comp.ID, season.ID)
		digest := standingsFingerprint(sourceESPN, rows, teamIDs)
		if r.contentUnchanged(scope, len(rows), digest) {
			r.log.Debug("standings unchanged; replacement skipped",
				"comp", comp.ID, "season", season.ID, "rows", len(rows))
		} else {
			err = r.repo.ReplaceStandings(
				ctx, comp.ID, season.ID, sourceESPN, rows, teamIDs)
			if err == nil {
				// Only after the transaction committed. A rejected or failed
				// replacement must leave the memo on the row set that really is
				// in the table.
				r.markContentWritten(scope, digest)
			}
		}
	}
```

- [x] **Step 4: Repair the one existing test the guard invalidates**

`TestStandingsSnapshotRetriesAfterFinalizationReplacementIsRejected` sets
`repo.standingsErr = store.ErrPartialReplacement` on a cycle whose standings
content is byte-identical to the previous cycle's. The guard now skips that
write, so the store never gets the chance to reject it and the cycle does not
fail.

That is correct behaviour — `ErrPartialReplacement` fires when the incoming set
is *smaller* than the stored one, which an identical set is not — and the test's
scenario is more faithful when the content actually moves. In that test, replace:

```go
	source := worker.source.(*fakeSource)
	source.mu.Lock()
	source.matches = []model.Match{finishedMatch()}
	source.mu.Unlock()
	repo.mu.Lock()
	repo.standingsErr = store.ErrPartialReplacement
	repo.mu.Unlock()
```

with:

```go
	source := worker.source.(*fakeSource)
	source.mu.Lock()
	source.matches = []model.Match{finishedMatch()}
	// The content memo skips a byte-identical row set before it ever reaches
	// the store, so the table has to MOVE for the replacement to be attempted
	// at all. A post-finalization table the store rejects as shrinking is by
	// definition a different row set, so say so rather than relying on an
	// unconditional write.
	source.standings = []model.Standing{{
		Rank: 1, Team: model.Team{ID: "home"},
		Played: 1, Wins: 1, Points: 3, GoalsFor: 2, GoalDifference: 2,
	}}
	source.mu.Unlock()
	repo.mu.Lock()
	repo.standingsErr = store.ErrPartialReplacement
	repo.mu.Unlock()
```

The retry cycle that follows still writes, because the memo still holds the first
cycle's fingerprint and the rejected content differs from it.

- [x] **Step 5: Run the whole ingester suite**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend && go test ./ingester/ -race
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/ingester`.

The five snapshot tests are the ones to watch, and all five must stay green
without further edits: `TestStandingsSnapshotWritesOncePerDay` (the second tick
skips the replacement but the day gate, not the memo, is what holds
`snapshotCalls` at 1), `TestStandingsSnapshotRewritesTheDayWhenAMatchFinalizes`
(the snapshot fires on finalization whether or not the live table was rewritten —
this is Decision 4's "the memo gates C3, never C4"),
`TestStandingsSnapshotRetriesAfterWriteFailure`,
`TestStandingsSnapshotRetriesAFailedFinalizationRewrite`, and
`TestSquadRefreshRunsOncePerDay` (`refreshSquads` runs on the skip path, so
`standingTeamIDs` from the first tick still matches `squadCalls`).

- [x] **Step 6: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/ingester/runner.go backend/ingester/runner_test.go
git commit -m "perf: skip the standings replacement when the table did not move

131,328 tuple writes a day to keep 228 rows unchanged, on a table that
can only move when a match finalizes -- ~60 times a day against 2,592
competition-slow-ticks. Content hashes captured across three production
tick boundaries showed nine tables changing zero times.

The guard sits between the mapper and the store, so the standings
ingest_run, the crest mirroring, the daily standing_snapshot (C4, where
writing the same value twice is correct) and the squad refresh all still
run on a skipped tick.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Mirror first, then guard `refreshLeaders`

**Files:**
- Modify: `backend/ingester/runner.go`
- Test: `backend/ingester/runner_test.go`

**Interfaces:**
- `leaderCrestsChanged` and `stringValue` are **deleted** — after mirror-first
  neither has a caller.
- `fakeRepository` gains `leaderRows [][]model.StatLeader` so a test can assert
  what was written, not only that something was.

- [x] **Step 1: Record the written board in the fake**

In `backend/ingester/runner_test.go`, add to the `fakeRepository` struct, next to
`leaderCategories`:

```go
	leaderRows        [][]model.StatLeader
```

and in `fakeRepository.ReplaceLeaders`, after
`f.leaderCategories = append(f.leaderCategories, category)`:

```go
	f.leaderRows = append(f.leaderRows, append([]model.StatLeader(nil), rows...))
```

- [x] **Step 2: Write the failing tests**

Append to `backend/ingester/runner_test.go`:

```go
// The leader boards' twin of TestUnchangedStandingsAreReplacedOnce, and the
// larger half of the measured waste: top_scorer took +600 inserts and -600
// deletes per tick against a 300-row table -- 345,600 tuple writes a day.
func TestUnchangedLeaderBoardsAreReplacedOnce(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.leaderCategories) != 2 {
		t.Fatalf("ReplaceLeaders calls = %v across two identical slow ticks, want one per category",
			repo.leaderCategories)
	}
}

// top_scorer moved 600 tuples for a 300-row table because the board was
// replaced TWICE per tick: the old code wrote the freshly-mapped board, mirrored
// its crests, and re-wrote the whole board when leaderCrestsChanged(board,
// mirrored) said the URLs had moved -- which it always did, because `board`
// always carries a.espncdn.com URLs and `mirrored` always carries CDN ones.
// Mirroring first collapses that to one write and removes the window in which
// the table served provider hotlinks.
func TestMirroredLeaderBoardIsWrittenOnceWithCDNCrests(t *testing.T) {
	crest := "https://a.espncdn.com/crest.png"
	src := &fakeSource{statistics: statisticsPayload(
		t,
		[]model.StatLeader{{
			Rank: 1, Player: "Striker", TeamAbbr: "HOM",
			TeamCrestURL: &crest, Value: 5,
		}},
		[]model.StatLeader{{Rank: 1, Player: "Playmaker", Value: 3}},
	)}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)
	worker.mirror = &fakeMirror{}

	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.leaderCategories) != 2 {
		t.Fatalf("ReplaceLeaders calls = %v in one tick, want exactly one per category",
			repo.leaderCategories)
	}
	written := false
	for index, category := range repo.leaderCategories {
		if category != "goals" {
			continue
		}
		written = true
		stored := repo.leaderRows[index][0].TeamCrestURL
		if stored == nil || !strings.HasPrefix(*stored, "https://cdn.example/") {
			t.Fatalf("stored crest = %v, want the mirrored URL on the FIRST write", stored)
		}
	}
	if !written {
		t.Fatal("the goals board was never written")
	}
}

// An absent board must never be memoised, because nothing was committed: the
// store rejected the replacement and the rows already stored survive. If it
// were, the leaders_preserved audit -- the only signal that a board is missing
// -- would stop firing after the first tick, and a board that later appears
// must still be written.
func TestAbsentLeaderBoardIsNeverMemoised(t *testing.T) {
	goals := []model.StatLeader{{Rank: 1, Player: "Striker", Value: 5}}
	src := &fakeSource{statistics: statisticsPayload(t, goals, nil)}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	preserved := len(loggedRunsForKind(repo.logged, "leaders_preserved"))
	repo.mu.Unlock()
	if preserved != 2 {
		t.Fatalf("leaders_preserved runs = %d across two ticks with an absent board, want 2",
			preserved)
	}

	// The board appears. It must be written, once.
	src.mu.Lock()
	src.statistics = statisticsPayload(
		t, goals, []model.StatLeader{{Rank: 1, Player: "Playmaker", Value: 3}})
	src.mu.Unlock()
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	assists := 0
	for _, category := range repo.leaderCategories {
		if category == "assists" {
			assists++
		}
	}
	if assists != 1 {
		t.Fatalf("assists writes = %d, want the board written exactly once when it appeared",
			assists)
	}
	if len(repo.leaderCategories) != 2 {
		t.Fatalf("writes = %v, want one goals write and one assists write in total",
			repo.leaderCategories)
	}
}
```

`statisticsPayload` already exists in this file, as do `fakeMirror` and
`loggedRunsForKind`. `strings` is already imported.

- [x] **Step 3: Run them and watch two fail**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend && go test ./ingester/ -race -run 'LeaderBoard|UnchangedLeader'
```

Expected: `FAIL`, with

```
--- FAIL: TestUnchangedLeaderBoardsAreReplacedOnce
    runner_test.go:...: ReplaceLeaders calls = [goals assists goals assists] across two identical slow ticks, want one per category
--- FAIL: TestMirroredLeaderBoardIsWrittenOnceWithCDNCrests
    runner_test.go:...: ReplaceLeaders calls = [goals assists goals] in one tick, want exactly one per category
```

The second failure is the unconditional double replacement, reproduced: with a
mirror configured the goals board is written **twice in a single tick**. The
category order inside those slices varies run to run — `leaderCategories` is a
Go map — so match on the length and the repeated `goals`, not on the exact
sequence. `TestAbsentLeaderBoardIsNeverMemoised` passes already and must keep
passing.

- [x] **Step 4: Restructure the loop**

In `backend/ingester/runner.go`, inside `refreshLeaders`, replace the whole
`for espnName, category := range leaderCategories { … }` body with:

```go
	for espnName, category := range leaderCategories {
		board, mapErr := espn.MapLeaders(raw, espnName, topScorerLimit)
		if mapErr != nil {
			errs = append(errs, fmt.Errorf("%s: %w", category, mapErr))
			continue
		}
		// Mirror BEFORE fingerprinting and before writing. The old shape wrote
		// the board, mirrored its crests, then re-wrote the whole board when
		// leaderCrestsChanged(board, mirrored) reported a difference -- but
		// `board` is mapped fresh from ESPN on every tick and therefore ALWAYS
		// carries a.espncdn.com URLs while `mirrored` ALWAYS carries
		// cdn.scorearc.futbol ones, so that comparison was unconditionally true
		// and the second full replacement ran on every tick, forever. It also
		// left a window in which the table served provider hotlinks. Mirroring
		// first removes both, and costs nothing on a steady tick because
		// mirrorLeader answers from r.mirrored after the first mirror.
		board = r.mirrorLeaders(ctx, board)

		// The C3 guard (spec §4.1). A leader board is a pure function of the
		// goals and assists scored in its competition, so it can only move when
		// a match finalizes; content hashes over ten stored boards, captured
		// across three production tick boundaries, changed zero times.
		scope := leadersScope(comp.ID, season.ID, category)
		digest := leadersFingerprint(sourceESPN, category, board)
		if r.contentUnchanged(scope, len(board), digest) {
			r.log.Debug("leader board unchanged; replacement skipped",
				"comp", comp.ID, "category", category, "rows", len(board))
			continue
		}
		writeErr := r.repo.ReplaceLeaders(
			ctx, comp.ID, season.ID, sourceESPN, category, board,
		)
		if errors.Is(writeErr, store.ErrEmptyReplacement) {
			// Normal. Not every competition publishes every board, and an
			// absent assists table must not take the Golden Boot down with it.
			//
			// DELIBERATELY NOT MEMOISED: nothing was committed, and the rows
			// already in the table survive. contentUnchanged refuses a zero-row
			// set for the same reason, so this branch stays reachable on every
			// tick and keeps auditing the missing board.
			r.log.Info("leader board unavailable; preserving existing rows",
				"comp", comp.ID, "category", category)
			r.recordRun(ctx, comp.ID, "leaders_preserved", start, nil)
			continue
		}
		if writeErr != nil {
			errs = append(errs, fmt.Errorf("%s: %w", category, writeErr))
			continue
		}
		// Only after the transaction committed.
		r.markContentWritten(scope, digest)
	}
```

Then delete `leaderCrestsChanged` and `stringValue` entirely — the two functions
between `mirrorLeaders` and `mirrorLeader` in the same file.

- [x] **Step 5: Prove nothing else called them, then run everything**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
grep -rn "leaderCrestsChanged\|stringValue(" --include="*.go" .
go build ./... && go vet ./... && go test ./ingester/ -race
```

Expected: the `grep` prints **nothing** (exit code 1), the build and vet are
silent, and the suite reports
`ok  github.com/mcasillas17/scorearc-backend/ingester`.

Two existing mirror tests must stay green and are worth reading if they do not:
`TestLeaderCrestMirrorsOnceAcrossRefreshes` (mirror called once across two
cycles — the second tick mirrors from `r.mirrored` and then skips the write) and
`TestLeaderCrestOutageUsesSharedCircuit` (both boards still written when the
mirror is down, with provider URLs, which is what then gets memoised and
rewritten when the mirror recovers).

- [x] **Step 6: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/ingester/runner.go backend/ingester/runner_test.go
git commit -m "perf: mirror leader crests first, then write the board once

top_scorer moved 600 tuples per tick for a 300-row table because the
board was replaced twice: leaderCrestsChanged compared a freshly-mapped
board (always a.espncdn.com) against its mirrored copy (always
cdn.scorearc.futbol), so it was unconditionally true and the second full
replacement ran on every tick forever. Mirroring before the write
collapses it to one, and removes the window in which the table served
provider hotlinks.

The content memo then skips even that one when the board did not move.
An absent board is never memoised -- nothing was committed, the stored
rows survive, and leaders_preserved keeps auditing it on every tick.

345,600 tuple writes a day to keep 300 rows unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Lock the observability contract

**Files:**
- Test: `backend/ingester/runner_test.go`

A skipped write must remain invisible to everything except `pg_stat_user_tables`.
This is the assertion that stops a future refactor moving the guard *outside* the
operation — the change that would look like a further optimisation and would
silently make every healthy competition report stale.

- [x] **Step 1: Write the test**

Append to `backend/ingester/runner_test.go`:

```go
// T10.10's /v1/ingest-freshness reads ingest_run per competition per kind, with
// a 20-minute threshold for `standings` and `leaders` -- three missed slow
// ticks. A tick whose write the content memo skipped is a HEALTHY tick, so it
// must still record its run under the same kind. Recording nothing, or
// recording a new "…_unchanged" kind, would report every settled competition as
// stale within twenty minutes and trade a write-amplification bug for a
// monitoring one.
func TestSkippedReplacementsStillRecordFreshness(t *testing.T) {
	src := &fakeSource{}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	worker := testRunner(src, repo, comp)

	worker.runCycle(context.Background(), true)
	repo.mu.Lock()
	standingsBefore := len(loggedRunsForKind(repo.logged, "standings"))
	leadersBefore := len(loggedRunsForKind(repo.logged, "leaders"))
	repo.mu.Unlock()

	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.standingsCalls != 1 || len(repo.leaderCategories) != 2 {
		t.Fatalf("the second tick wrote: standings=%d leaders=%v",
			repo.standingsCalls, repo.leaderCategories)
	}
	standings := loggedRunsForKind(repo.logged, "standings")
	leaders := loggedRunsForKind(repo.logged, "leaders")
	if len(standings) != standingsBefore+1 || !standings[len(standings)-1].ok {
		t.Fatalf("standings runs = %v; a skipped tick must still record a successful run",
			standings)
	}
	if len(leaders) != leadersBefore+1 || !leaders[len(leaders)-1].ok {
		t.Fatalf("leaders runs = %v; a skipped tick must still record a successful run",
			leaders)
	}
	// And no new kind was invented for it: ingest_run is C5 and gets coarser,
	// never finer.
	for _, run := range repo.logged {
		if strings.HasSuffix(run.kind, "_unchanged") || strings.HasSuffix(run.kind, "_skipped") {
			t.Fatalf("a skip invented the ingest_run kind %q; T10.10 reads kinds by name",
				run.kind)
		}
	}
}
```

- [x] **Step 2: Run it**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend && go test ./ingester/ -race -run TestSkippedReplacementsStillRecordFreshness -v
```

Expected: `PASS`. This one passes on the first run by construction — the guard is
already inside the operation and `recordRun` already runs unconditionally. That
is the point: the test exists to make a future move of the guard fail loudly.

- [x] **Step 3: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/ingester/runner_test.go
git commit -m "test: a skipped replacement still records its ingest_run

T10.10 reads ingest_run per competition per kind with a 20-minute
threshold for standings and leaders. Moving the guard outside the
operation, or giving a skip its own kind, would report every settled
competition as stale. This fails if either happens.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Document the write policy where the schema is documented

**Files:**
- Modify: `docs/backend/ARCHITECTURE.md`

The `standing` and `top_scorer` bullets describe the columns and say nothing
about cadence, which is how "replace it every tick" survived unexamined for a
season.

- [ ] **Step 1: Amend the two schema bullets**

In `docs/backend/ARCHITECTURE.md`, append to the end of the **`standing`**
bullet (line ~118):

```
Replaced wholesale (DELETE the scope, INSERT every row) but **only when the row set changed**: the runner memoises an FNV-1a/64 fingerprint of the exact columns this table stores — canonical `team_id`, group, rank, the record, points, `advanced`, `source`, never `updated_at` — and skips the transaction when a tick reproduces it (`backend/ingester/memo.go`). A table is a pure function of its competition's finished matches, so it can only move when one finalizes: measured, nine tables changed zero times across three production tick boundaries while 131,328 tuple writes a day were being issued to keep them still. The memo is a **cost gate only** — the primary key is the guarantee, and a restart rewrites each competition once. `standing_snapshot` is **not** gated on it: that table is C4, where writing the same value twice is correct.
```

And to the end of the **`top_scorer`** bullet (line ~119):

```
Written **once** per category per change, not twice per tick. Crests are mirrored to R2 **before** the write, and the mirrored board is what is fingerprinted and stored — the previous shape wrote the freshly-mapped board, mirrored it, and re-wrote it whenever the URLs differed, which they always did (`a.espncdn.com` vs `cdn.scorearc.futbol`), so a 300-row table absorbed 600 tuple writes per tick and briefly served provider hotlinks between the two. The same content memo as `standing` then skips the remaining write when a board did not move. **An absent board is never memoised**: `ErrEmptyReplacement` means the store refused and the stored rows survive, so the `leaders_preserved` audit keeps firing on every tick.
```

- [ ] **Step 2: Verify and commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
grep -n "content memo\|memo.go" docs/backend/ARCHITECTURE.md
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: record the write cadence for standing and top_scorer

Both bullets described columns and said nothing about how often the rows
are rewritten, which is how 477,000 tuple writes a day went unexamined
for a season.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add the roadmap row

**Files:**
- Modify: `docs/PRODUCT_ROADMAP.md`

- [ ] **Step 1: Find the next free E7 task number — do not assume one**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc && grep -n "^| \*\*T7\." docs/PRODUCT_ROADMAP.md
```

Expected at the time of writing: the table ends at **T7.15** (odds line-movement
snapshots), so the next free number is **T7.16**. **Confirm it yourself** — five
sibling slices from the same spec are landing concurrently and one of them may
have taken it, and note that
`docs/superpowers/plans/2026-08-18-postgres-storage-reduction.md` proposes
"T7.14/T7.15" for storage work while those numbers are already occupied by
officials and odds. Use the first genuinely unused number, and if two plans race
for it, renumber yours rather than duplicating.

- [ ] **Step 2: Add the row**

Append to the E7 task table, using the number Step 1 confirmed:

```
| **T7.16** | Content-memo write guard for `standing` / `top_scorer` | [plan](superpowers/plans/2026-08-18-content-memo-write-guard.md) |
```

- [ ] **Step 3: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add docs/PRODUCT_ROADMAP.md
git commit -m "docs: add the content-memo write guard to the E7 task table

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full gate, and the PR

- [x] **Step 1: Backend gate**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./... && go test -race ./...
```

Expected: build clean, vet silent, every package `ok`. Docker must be running for
the testcontainers packages (`shared/store`, `reader`, `migrations`, `cmd/*`); a
`dial tcp … connection refused` from those means Docker is down, not that the
guard broke anything.

- [x] **Step 2: Frontend gate**

`ci.yml` runs the whole frontend gate on every PR, including a backend-only one.
Kill any running dev server first — `next dev` and `next build` both write
`.next/`, and the corrupted tree presents as an HTTP 500 that looks like your bug.

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
rm -rf .next
npm ci
npm run export:competitions && git diff --exit-code -- backend/config/competitions.json
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: the `git diff` is silent (no drift in the generated registry), suite
green, typecheck silent, lint clean, build succeeds. Nothing in this plan touches
`src/**`, so any failure here is pre-existing — say so rather than fixing it in
this PR.

- [x] **Step 3: Confirm no migration snuck in**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git diff --stat origin/main -- backend/migrations/
```

Expected: **no output.** This plan changes no schema. If there is output, the
number must be 0017 and the watermark re-checked — see the red box.

- [ ] **Step 4: Open the PR**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git push -u origin tweak/content-memo-write-guard
gh pr create --title "perf: stop rewriting standings and leader boards that did not change" --body "$(cat <<'EOF'
## What

`standing` and `top_scorer` are replaced wholesale — `DELETE` the scope, `INSERT`
every row, one `tx.Exec` at a time — on **every slow tick, for every
competition**, whether or not a single result moved.

Measured on production over a 298-second window with the backlog drained and no
live match:

| table | inserts | deletes | rows held | tuple writes / day |
|---|---:|---:|---:|---:|
| `top_scorer` | +600 | −600 | 300 | **345,600** |
| `standing` | +228 | −228 | 228 | **131,328** |

**~477,000 tuple writes a day to keep 528 rows exactly as they were**, plus
~830,000 pooler round trips, plus the WAL, plus the autovacuum that follows every
delete — `standing` and `top_scorer` are already the two most-autovacuumed tables
in the database despite being the smallest.

## The redundancy is measured, not inferred

Content hashes over the stored rows (`md5(to_jsonb(row) - 'updated_at' - 'id')`,
aggregated per competition and per category) were captured across **three windows
that `pg_stat_user_tables` confirms spanned full delete-and-reinsert ticks**.

**Nine standings tables. Ten leader boards. Zero changed, every time.**

And it generalises with an argument: a standings table is a pure function of the
finished matches in its competition, a leader board of the goals and assists
scored in it. Both can only move when a match finalizes — ~60 times a day across
nine competitions, against **2,592 competition-slow-ticks**.

## The fix

An in-process memo on the runner, `written map[string]uint64`, holding the
fingerprint of the row set **last committed** for each scope. It generalises the
`snapshotted` day marker that already gates the daily standings snapshot, and
inherits its contract verbatim: *a cost gate, not the idempotency guarantee.*

| | today | after |
|---|---:|---:|
| `standing` tuple writes / day | 131,328 | ~3,000 |
| `top_scorer` tuple writes / day | 345,600 | ~5,000 |
| replacement transactions / day | 5,184 | ~120 |

## It hashes the mapped rows, never the ESPN payload

`docs/research/2026-08-18-espn-payload-volatility.md` §3 makes a raw-body hash
unusable: `roster.timestamp` changes on **every single fetch** (confirmed at a
25-second gap), the per-event `statistics.timestamp` on a ~9–10 minute CDN cycle,
plus `summary.meta.lastUpdatedAt`, the whole `news.*` subtree, `videos[]` and the
secondary-market ticket counters. A `sha256(body)` would report "changed" on most
polls and this guard would never fire.

The fingerprint covers **exactly the columns the two replacements INSERT** —
canonical `team_id`, group, rank, record, points, `advanced`, `source` for
standings; rank, player, team, crest URL, value, matches for the boards — and
nothing else. Not `updated_at` (it is `now()`), and not `team.name` / `abbr` /
`crest`, which arrive on `model.Standing` but are owned by `team`; hashing those
would make one crest mirror rewrite 228 standings rows that did not change.

## `top_scorer` was written twice per tick, and now is not

That is why 600 tuples moved for a 300-row table. The old shape wrote the
freshly-mapped board, mirrored its crests to R2, then re-wrote the whole board
when `leaderCrestsChanged(board, mirrored)` reported a difference — but `board`
always carries `a.espncdn.com` URLs and `mirrored` always carries
`cdn.scorearc.futbol` ones, so **the comparison was unconditionally true and the
second replacement ran on every tick forever**. It also left a window in which the
table served provider hotlinks.

Mirror first, fingerprint the mirrored board, write once. `leaderCrestsChanged`
had no job left and is deleted.

## Two invariants the guard does not weaken

- **An absent board is never memoised.** `ErrEmptyReplacement` means the store
  refused and the stored rows survive — nothing was committed, so `contentUnchanged`
  refuses a zero-row set outright and the `leaders_preserved` audit keeps firing
  on every tick. The memo is written on exactly one line per refresh, on the
  success branch, after the transaction committed.
- **A skipped write still records its `ingest_run`.** T10.10's freshness endpoint
  reads `ingest_run` per competition per kind with a 20-minute threshold for
  `standings` and `leaders`. The guard sits *inside* the operation, so a healthy,
  unchanging competition keeps reporting fresh. No new `ingest_run` kind is
  introduced. `standing_snapshot` is untouched — it is C4, the one class where
  writing the same value twice is correct.

## Restart behaviour, stated rather than engineered around

A cold memo rewrites each scope once per deploy: **27 writes, ~530 tuples, once.**
That is 0.005% of a day's current volume and it is correct — the memo's only claim
is "this process committed these bytes". No warm-start read-back: reading the
table to avoid writing it pays a query to save a query, on the one tick per deploy
where it would help.

## Testing

- `go build ./... && go vet ./... && go test -race ./...` clean.
- Frontend gate green (`npm test`, `tsc --noEmit`, `lint`, `build`).
- New: 20 fingerprint sub-tests asserting every written column moves the
  fingerprint and every non-written field does not; `NULL` vs `''` and `NULL` vs
  `0`; scope isolation; the empty-set refusal.
- New: two identical refreshes → one write, for both tables; a changed table →
  two writes; a **failed** replacement is not memoised and is retried; a restart
  is cold; an absent board is preserved and audited on every tick and written
  once when it appears; a skipped tick still records `standings` and `leaders`
  runs.
- One existing test repaired: `TestStandingsSnapshotRetriesAfterFinalizationReplacementIsRejected`
  relied on an identical row set still reaching the store to be rejected. Its
  scenario now moves the content, which is what a shrinking post-finalization
  table actually looks like.

## Not in scope

No migration (the schema is untouched). The `match` upsert guard (§4.2), the
scheduled-detail TTL (§4.3), the commentary tail (§4.4), `ingest_run` coarsening
(§4.5) and the C1 triggers (§4.6) are separate slices. Batching
`ReplaceStandings`' 228 individual `tx.Exec` calls is deliberately left out: after
this guard only ~60 replacements a day survive, so batching would save ~1.6% of
the original round-trip volume and deserves its own measurement.

Spec: `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md` §4.1
Plan: `docs/superpowers/plans/2026-08-18-content-memo-write-guard.md`
EOF
)"
```

- [ ] **Step 5: Stop, and hand the verification over**

Do **not** merge. Merging — and therefore deploying, since `main` auto-deploys —
is the user's decision (`AGENTS.md`).

Give the user this, to run **after** the ingester has been redeployed and has run
for at least two slow ticks:

```bash
set -a; source ~/.scorearc-db.env; set +a
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
psql "$DIRECT_DSN" -X -c "SELECT now()::timestamptz(0), relname, n_tup_ins, n_tup_del
  FROM pg_stat_user_tables WHERE relname IN ('standing','top_scorer') ORDER BY relname;"
sleep 330
psql "$DIRECT_DSN" -X -c "SELECT now()::timestamptz(0), relname, n_tup_ins, n_tup_del
  FROM pg_stat_user_tables WHERE relname IN ('standing','top_scorer') ORDER BY relname;"
```

Expected after the deploy has settled: the delta across a slow tick with no match
finalizing is **0 inserts and 0 deletes on both tables**, against Task 1's
+228/−228 and +600/−600. The **first** tick after the deploy will show one full
replacement of each — that is the cold memo, and it is the design.

Also confirm freshness did not regress:

```bash
psql "$DIRECT_DSN" -X -c "SELECT competition_id, kind, max(started_at) AS last_run, bool_and(ok) AS all_ok
  FROM ingest_run WHERE kind IN ('standings','leaders','leaders_preserved')
    AND started_at > now() - interval '30 minutes'
  GROUP BY 1,2 ORDER BY 1,2;"
```

Expected: a `standings` and a `leaders` row per competition with `last_run` inside
the last five minutes and `all_ok = t`, exactly as before — a skip is a healthy
tick, and T10.10 must keep seeing it that way.

---

## Execution notes and corrections (2026-08-18)

- **Measured baseline reproduced with the least-privilege direct ingester
  login.** From `07:32:31Z` to `07:38:02Z`, `standing` moved from
  65,840/65,612 inserts/deletes to 66,068/65,840 (**+228/+228**) while
  holding 228 rows; `top_scorer` moved from 173,400/173,100 to
  174,000/173,700 (**+600/+600**) while holding 300 rows. Both autovacuum
  counters advanced once. The next slow-tick window kept every one of the nine
  standings hashes and ten leader-board hashes byte-identical. The migration
  watermark was `15 | f`. The configured `DIRECT_DSN` was the owner login, so
  execution deliberately substituted `INGESTER_LEASE_DSN`; no owner credential
  was used.
- **The separator premise in Task 2 was wrong.** `MapLeaders` copies provider
  names and abbreviations without sanitizing control characters, so raw
  `\x1f`/`\x1e` delimiters allowed two different stored rows to produce the
  same byte stream. Review round 1 supplied a concrete collision. A failing
  regression test reproduced it, then the implementation switched every text
  field to an 8-byte length prefix and kept explicit presence bytes for
  nullable values. The FNV-1a/64 choice and hashed columns are unchanged.
- **Task 4's red prediction undercounted failures.**
  `TestAbsentLeaderBoardIsNeverMemoised` also failed before the guard because
  the unchanged goals board was still written on each of its three ticks. That
  was the old behavior the test was supposed to reject; all three tests became
  green after the guard.
- **Task 4's helper grep cannot be silent.** The plan-prescribed explanatory
  comments themselves contain `leaderCrestsChanged` and `stringValue`, so the
  exact grep reports comment-only matches. `go build ./...` and `go vet ./...`
  proved the functions and all code callers were removed.
- **Review added two missing failure-path locks.** A failed leader replacement
  is not memoised and retries while the category that committed is skipped; a
  board written with provider URLs during a mirror outage is rewritten once
  with CDN URLs when the circuit recovers. Both pass under `-race`.
- **Documentation sequencing changed after implementation began.** Tasks 6-7
  are executed in the required separate shared-docs branch after both code
  reviewers clear the implementation branch. The implementation PR carries
  this plan and its execution record; shared architecture and roadmap edits do
  not share its branch. There is no `backend/ingester/README.md`, and this
  internal write-policy change does not alter the reader API or OpenAPI
  contract, so no package-local or API document exists that needs an update.
- **Independent review:** round 1 found the framing collision and missing
  leader failure/recovery coverage. Commit `b556854` resolved them. In round 2,
  both Claude Opus 5 and GPT-5.6 Terra reran the complete frontend and backend
  gates, including uncached real-Postgres Testcontainers suites, and reported
  **NO BLOCKING FINDINGS**.

---

## Self-review notes

- **The brief's five decisions, each answered from the code.** *Where the memo
  lives* → Decision 1: in-process, per §4.1, and the code agrees — `snapshotted`
  is the same pattern with the same comment, the advisory lease
  (`shared/store/lease.go`, enforced against unpooled DSNs and `fly.toml`'s
  `strategy = "immediate"`) guarantees one writer, and neither table's primary
  key has anywhere to hang a per-scope hash without migration 0017 and ~7,776
  writes a day to save ~27 per deploy. *What is hashed* → Decision 2: the mapped
  rows, column by column, with the excluded fields named and justified. *Restart*
  → Decision 1's closing paragraph: one write per scope per deploy, stated as
  acceptable, with an explicit instruction not to engineer around it.
  *`ErrEmptyReplacement`* → Decision 3, two rules, one test each.
  *Observability* → Decision 4, with the T10.10 threshold quoted and a test that
  fails if the guard is ever moved outside the operation.
- **The failing test the brief asked for is Task 3 Step 1 / Task 4 Step 2**, and
  its expected failure output is written down: `ReplaceStandings calls = 2 …
  want 1` and `ReplaceLeaders calls = [goals assists goals] … want exactly one
  per category`. The second is the double-write bug reproduced in a unit test.
- **One existing test genuinely breaks, and it is named, explained and repaired
  in the same task that breaks it** (Task 3 Step 4). Five other snapshot tests
  and both leader-mirror tests were traced by hand and stay green; Task 3 Step 5
  says which and why, so a green run is not mistaken for a lucky one.
- **`refreshStandings`' skip path deliberately keeps `err == nil`**, which is what
  keeps crest mirroring, the `standings` `ingest_run`, the C4 daily snapshot and
  the squad refresh running on a skipped tick. That is the single most
  load-bearing line in the diff and it is called out in the code comment, in
  Decision 4 and in the task.
- **Nothing here touches the store.** `ReplaceStandings` and `ReplaceLeaders`,
  their `ErrEmptyReplacement` / `ErrPartialReplacement` contracts and their SQL
  are byte-identical after this plan. The guard defers to them; it does not
  reimplement their judgement.
- **The one thing a compiler will not catch** is a column added to
  `ReplaceStandings`' or `ReplaceLeaders`' `INSERT` without a matching line in
  `memo.go` — a silent skipped write. The mutation tables in Task 2 Step 1 are
  the closest available guard, and they fail loudly for every column that exists
  today; a reviewer adding a column must add a mutation case with it.
