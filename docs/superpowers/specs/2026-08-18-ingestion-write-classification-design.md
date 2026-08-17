# Ingestion write classification — design

**Status:** Design · 2026-08-18
**Scope:** the ingester's write paths and their cadence. Storage/schema reduction,
ESPN payload volatility and the reader API are separate documents.
**Companions:** `2026-08-17-ingester-and-api-improvements-design.md` (what the first
day revealed), `2026-08-10-internal-ingester-service-design.md` (the service).

## The question this answers

> "The ingester should query our data-dependency endpoints and break it into
> different types of metrics/events to store, and only depending on that should we
> store data. Maybe some stuff in the JSON payload from ESPN doesn't need to be
> saved every time the ingester processes — for instance the winning probability."

That is correct, and it is under-stated. The ingester today has **one** decision
about whether to write: *did the fetch succeed?* Every other question — has this
value changed, is this thing still moving, is this a fact or a sample — is answered
implicitly by whichever tick happened to run. The result is that 528 rows of
standings and leader boards absorb **477,000 tuple writes a day** to stay exactly as
they were, while a probability curve that genuinely changes minute to minute has
never been written at all.

This document proposes the missing vocabulary — a volatility class per entity —
states what each class implies for cadence and for history, and then proposes the
smallest set of guards that captures most of the cost.

---

## 0. What the numbers actually mean — read this first

The write-amplification figures circulating from `pg_stat_user_tables` are real but
they are **not steady state**, and building a design on them without saying so would
be wrong.

Measured today, 2026-08-17:

```
pg_postmaster_start_time()          2026-08-17 07:20:05 UTC
min(ingest_run.started_at)          2026-08-17 07:21:23 UTC
min(match_external_ref.first_seen_at) 2026-08-17 07:21:23 UTC
```

**Every row in the database was written in the preceding forty minutes.** The
counters therefore describe a *cold start* — nine competitions discovered from
scratch, 2,578 fixtures inserted, 368 finished matches finalized and their play
streams captured in a single sweep — not a normal day.

That cuts both ways, and both matter:

- Ratios like `match`: 2,578 inserts vs ~3,100 updates **understate** the steady-state
  amplification. In a cold start each match is inserted once by the resolver and
  updated roughly once. The per-tick rewriting has barely begun.
- The whole dataset was produced by a **single pass per match**. `appearance`,
  `match_commentary`, `match_event`, `match_play` all show inserts ≈ live rows and
  ~zero updates. That is not evidence that those paths are cheap — it is evidence
  that **no match has been ingested while live yet**, so the expensive path has
  never run. See §5.

So the audit below uses two kinds of number: a **measured slow-tick delta**, taken
over a real 298-second window with no live match, and a **projection** for a live
match, computed from this database's per-match content sizes. Projections are
labelled as such.

### The measured slow tick

`pg_stat_user_tables` sampled twice, 298 seconds apart, spanning exactly one slow
tick, with the finalization backlog drained and **no live match**. This is the idle
cost of running the ingester:

| table | inserts | updates | deletes | rows the table holds |
|---|---:|---:|---:|---:|
| `top_scorer` | **+600** | 0 | **−600** | 300 |
| `standing` | **+228** | 0 | **−228** | 228 |
| `match` | 0 | **+82** | 0 | 2,578 |
| `match_detail` | 0 | **+82** | 0 | 450 |
| `ingest_run` | +83 | 0 | 0 | — |
| `player_team_history` | +87 | 0 | 0 | 594 |
| `player` | 0 | +20 | 0 | 5,294 |

Nothing else moved. `player_team_history` and the 20 `player` stamps are the bio
sweep working exactly as designed (20 athletes per tick, 30-day TTL) and are not
discussed further.

An earlier 271-second window, taken while the finalization backlog was still
draining, additionally showed `match_play` +2,162, `match_commentary` +1,308,
`appearance` +438, `match_event` +273 and `match` +105 — those are one-time
per-match writes and are correct.

**Everything in the table above is recurring, and essentially all of it writes
values that did not change.**

---

## 1. Inventory of every write path

Twenty-two distinct writes. Grouped by what triggers them, because that is what the
redesign changes.

### Startup, once per process

| Write | Code | Semantics |
|---|---|---|
| `competition`, `season`, `competition_external_ref` | `store.ApplyCompetitionSeed` | upsert; `updated_at = now()` unconditionally |
| `team`, `team_external_ref`, provisional promotions | `store.ApplyTeamSeed` | upsert; crest preserved by `COALESCE(team.crest_url, EXCLUDED…)` |

### Identity, once per newly seen entity

| Write | Code | Semantics |
|---|---|---|
| `team` + `team_external_ref` (provisional mint) | `Store.Team` → `createProvisionalTeam` | insert; the crosswalk claim deliberately **loses** the conflict so curation wins |
| `match` (INSERT) + `match_external_ref` | `Store.Match` → `resolveMatch` | insert, or adopt an existing row on the natural key |
| `player` + `player_external_ref` | `Store.Player` | insert; loser of a race adopts the winner |
| `official` + `official_external_ref` | `Store.Official` | same shape as `Player` |

### Per match, per cycle — the hot path

| Write | Code | Trigger | Cadence | Semantics |
|---|---|---|---|---|
| `match` (UPDATE) | `UpsertMatch` | every scoreboard/bracket candidate whose stored row is not finalized | 20 s fast tick in an active competition, else 5 min | **Blind UPDATE.** The `WHERE` carries the finalization and state-regression guards only — nothing compares content. `updated_at = now()` guarantees a new tuple version every time. |
| `match_detail` | `UpsertMatchDetail` | any summary fetch on a non-finished match | same | Upsert; the **whole** JSONB row is rewritten (stats, lineups, form, h2h, commentary, win probability) |
| `appearance`, `match_event` | `WriteParticipation` | same summary fetch | same | Upsert **every** row, then a tail `DELETE`. `COALESCE` on the box-score columns so a statless poll cannot erase numbers. |
| `match_commentary` | `WriteCommentary` | same summary fetch | same | Upsert **every** line in the payload, then `DELETE … WHERE seq > max` |
| `win_prob_snapshot` | `WriteWinProbSnapshot` | `state == live` **and** `detail.WinProbability != nil` | every 20 s poll, bucketed to the minute | Insert; on conflict update if `observed_at` is newer |
| `odds_snapshot` | `captureOdds` → `WriteOddsSnapshot` | `state == live` (every poll) **and** once at finalization | same bucket | same |

`needsSummary` is what gates the summary fetch. Its scheduled-match branch is
`existing == nil || !existing.HasDetail || slowTick` — so **every scheduled fixture in
the rolling window is re-fetched and its detail row rewritten on every slow tick,
forever.**

### At the finalization transition — once per match

| Write | Code | Semantics |
|---|---|---|
| `match` + `match_detail` | `FinalizeMatch` | one transaction, guarded `finalized_at IS NULL`; after it commits the `protect_match_history` trigger makes the row immutable |
| `match_odds` | `WriteMatchOdds` | upsert on `(match, provider, phase)`; open/close only |
| `match_official` | `captureOfficials` → `WriteMatchOfficials` | upsert, **no tail delete** by design |
| `match_play`, `match_play_archive` (+ R2 object) | `capturePlays` | upsert on `(match_id, source_id)`, no tail delete; the archive ledger is the completion marker |

### Competition-level, per slow tick

| Write | Code | Trigger | Semantics |
|---|---|---|---|
| `standing` | `ReplaceStandings` | every slow tick per competition, **plus** any cycle where a match finalized | `DELETE` the whole competition's table, then `INSERT` every row. Refuses an empty or shrinking replacement. |
| `standing_snapshot` | `WriteStandingSnapshot` | after an accepted replacement; gated by an in-process per-day marker unless a match finalized | upsert on `(comp, season, team, captured_on)`, newer observation wins |
| `top_scorer` | `ReplaceLeaders` | every slow tick × 9 competitions × 2 categories | `DELETE` by category, then `INSERT` every row. Written **twice** when crest mirroring changed a URL. |
| `squad_membership`, `player_season_stat`, `player` | `ReplaceSquad` | slow tick, once per team per UTC day; 30-minute retry on failure | upsert + prune. Also issues **one unconditional `UPDATE player`** per squad member. |
| `player_team_history`, `player.bio_fetched_at` | `ReplaceTeamHistory` | slow tick, 20 players per tick, 30-day TTL | upsert + prune |

### Assets and audit

| Write | Code | Cadence |
|---|---|---|
| `team.crest_url` | `SetTeamCrest` | once per team per process, after an R2 mirror |
| `ingest_run` | `LogIngestRun` | once per operation — including **once per live poll per match** for `win_prob_snapshot` and `odds` |
| `ingest_run` prune | `PruneIngestRuns` | every slow tick, 30-day retention |

---

## 2. The classification

Five classes. The test for each is a single question, and every entity has exactly
one answer.

### C1 — Immutable once final

*"Has this already happened?"*

A finished match's scoreline, its box score, its events, its commentary, its play
stream, its crew, its settled opening and closing lines. Once the whistle goes these
are recorded history. There is no correct reason to write them a second time other
than a deliberate operator-driven correction.

- **Cadence:** exactly one write, at the finalize transition.
- **History:** none needed — there is only ever one version.
- **Guard:** `finalized_at IS NULL`, enforced in the database.

`match` and `match_detail` already have this, in both the `WHERE` clause and the
`protect_match_history` / `protect_finalized_detail` triggers. **`appearance`,
`match_event`, `match_commentary`, `match_play`, `match_official` and `match_odds` do
not.** They are protected today only by the accident that nothing re-polls a
finalized match. That is a policy living in the caller instead of the schema, and it
is one `-once` run or one backfill flag away from being wrong.

### C2 — Live-volatile

*"Is this thing still moving?"*

The scoreline, minute, status and detail of a live match; the running box score; the
commentary tail. These change on the timescale of the fast tick and only while the
match is in play. The stored value is the *current* value; nothing needs the previous
one.

- **Cadence:** as fast as the subject changes — the 20-second tick is right.
- **History:** none. Last write wins.
- **Guard:** write only when the content differs from what is stored. The cost of a
  no-op write is a full tuple version; the cost of the comparison is nothing, because
  `ExistingMatches` already runs.

### C3 — Slow-changing reference

*"Does this change on the scale of a day or a season?"*

Teams, competitions, seasons, squads, shirt numbers, player demographics, career
history, crests, the standings table, the leader boards, and a **scheduled** match's
detail — its lineup projections, its form, its head-to-head, its pre-match market.

- **Cadence:** a TTL, plus an event that is known to invalidate it (a match
  finalizing invalidates a table; a transfer window invalidates a squad).
- **History:** none in the live table. Where the history matters it is a separate
  C4 table — which is exactly what `standing_snapshot` is *for*.
- **Guard:** content hash or `IS DISTINCT FROM`. A TTL alone is not enough: the TTL
  bounds how often we *look*, the guard bounds how often we *write*.

This is the class the ingester currently gets most wrong. Standings and leader
boards are treated as if they were C2.

### C4 — Time-series, append-only

*"Is the sequence of values the point?"*

`standing_snapshot`, `win_prob_snapshot`, `odds_snapshot`.

These are the only tables where writing the same value twice is *correct*: a flat
probability curve is a finding, and a table that did not move for a week is a
finding. They also carry the one irrecoverable risk in the system — ESPN publishes
the current value, never yesterday's, so a sample not taken is gone.

- **Cadence:** a **sampling policy**, deliberately chosen, decoupled from the poll
  interval. Currently the sampling policy is "whatever the poll loop does", which is
  why the minute bucket exists to undo it.
- **History:** retained indefinitely. This is the archive.
- **Guard:** the bucket key, enforced by a unique index (already correct in
  migrations 0004 and 0005). The *writer* should additionally skip a statement whose
  bucket and value both match the last one it wrote.

### C5 — Operational

*"Would we miss this in ninety days?"*

`ingest_run`. Append-only, bounded retention, no analytical value beyond the
monitoring window. It should be cheap and it should be **coarse**: one row per
operation per cycle, not one row per match per poll.

### Summary

| Class | Write when | History | Guard | Tables |
|---|---|---|---|---|
| **C1** immutable-once-final | at the finalize transition, once | single version | `finalized_at IS NULL`, in the DB | `match`, `match_detail`, `appearance`, `match_event`, `match_commentary`, `match_play`, `match_official`, `match_odds` |
| **C2** live-volatile | content differs | last wins | `IS DISTINCT FROM` | `match`, `match_detail` (live), `appearance` (live) |
| **C3** slow reference | content differs, looked at on a TTL | last wins | content hash + TTL | `team`, `season`, `standing`, `top_scorer`, `squad_membership`, `player_season_stat`, `player`, `player_team_history`, `match_detail` (scheduled) |
| **C4** time-series | on a sampling schedule, while the subject moves | **kept forever** | bucket key | `standing_snapshot`, `win_prob_snapshot`, `odds_snapshot` |
| **C5** operational | always | 30 days | retention prune | `ingest_run` |

`match` and `match_detail` appear twice on purpose. **A row's class is a function of
its subject's lifecycle, not of its table.** The same `match` row is C2 while the
match is live and C1 the moment it finalizes. That transition is already the most
important event in the ingester; classification just makes it the thing that decides
the write policy too.

---

## 3. Redundant writes, measured

### 3.1 `standing` and `top_scorer` — the delete-and-reinsert pattern

`ReplaceStandings` and `ReplaceLeaders` do not upsert. They `DELETE` the whole
scope and `INSERT` every row back, inside a transaction, on **every slow tick, for
every competition**, whether or not a single result has changed.

Measured over one slow tick:

```
standing     +228 inserts  −228 deletes   (table holds 228 rows)
top_scorer   +600 inserts  −600 deletes   (table holds 300 rows)
```

At 288 slow ticks per day:

| table | rows held | tuple writes / day | ratio |
|---|---:|---:|---:|
| `standing` | 228 | **131,328** | 576× the table, every day |
| `top_scorer` | 300 | **345,600** | 1,152× the table, every day |

**`top_scorer` is replaced twice per tick, not once — and always will be.**
That is why 600 rows move for a 300-row table. `refreshLeaders` writes the board,
mirrors its crests to R2, and then re-writes the whole board if
`leaderCrestsChanged(board, mirrored)`. But `board` is mapped fresh from ESPN on
every tick and therefore always carries `a.espncdn.com` URLs, while `mirrored`
always carries `cdn.scorearc.futbol` ones. **The comparison is unconditionally true,
so the second full replacement runs on every tick forever.** Verified: all 300
stored rows carry CDN hosts, which is only reachable through that second write.

There is a correctness edge hiding in it too. The first replacement stores provider
hotlinks and the second overwrites them, so between the two the table serves
`espncdn.com` URLs. The guard should compare *stored* crests against mirrored ones,
not the freshly-mapped payload against them — or, once §4.1 lands, mirror first and
write once.

**How much of that is unchanged?** Directly measured, not inferred. Content hashes
over the sorted row set — `md5(to_jsonb(row) - 'updated_at' - 'id')` aggregated per
competition and per category — were captured twice, 426 seconds apart, spanning a
slow-tick boundary that `pg_stat_user_tables` confirms performed the full
delete-and-reinsert. **Nine standings tables, ten leader boards: zero changed.**
Every one of that tick's 1,656 tuple writes (228 + 228 + 600 + 600) reproduced the
bytes it had just destroyed.

That result generalises with an argument, not just a sample. A standings table is a
pure function of the finished matches in its competition; a leader board is a pure
function of goals and assists scored. Both can only move when a match finalizes.
On a heavy day roughly 60 matches finalize across all nine competitions, against
2,592 competition-slow-ticks (9 × 288). **At least 97.7% of these replacements
rewrite byte-identical content, and on most days well over 99%.** For `top_scorer`
the floor is higher still, because half of every tick's writes are the second,
crest-only pass described above and that one is *always* redundant.

A guard is trivial because both writes already build the complete row set in memory
before touching the database. Hashing the mapped `[]model.Standing` and comparing it
to the last hash this process wrote eliminates the transaction entirely. A restart
loses the memo and rewrites once, which is harmless.

**Why this costs more than storage.** Neon bills compute time, and every one of
these is a transaction: `BEGIN`, a count, a `DELETE` touching 228 rows and their
indexes, 228 single-row `INSERT`s issued individually (not batched — `ReplaceStandings`
loops `tx.Exec`), `COMMIT`. That is ~230 round trips through the pooler per
competition per tick; with the leader boards' two passes on top, ~2,900 per tick
across the registry and **~830,000 a day**, plus the WAL, plus the autovacuum that
follows the deletes. `top_scorer` and `standing` are
already the two most-autovacuumed tables in the database (10 and 7 cycles in the
first forty minutes, against zero for tables ten times their size). That vacuum load
is the cost showing up.

### 3.2 `match_detail` for scheduled matches — the largest avoidable fetch

`needsSummary` returns true for **every** scheduled match on **every** slow tick.
Measured: **82 `match_detail` updates per slow tick**, with zero inserts once the
backlog drained. Content hashes over those same 82 rows across a 426-second window:
**0 of 82 changed.** A scheduled fixture's detail row is 824 bytes and it is
rewritten, byte for byte, 288 times a day.

Per day: **23,616 rewrites of a 450-row table — and 23,616 ESPN summary requests**
against a keyless public API, to learn nothing.

This is the single largest avoidable cost in the system, because it is not only
database writes. It is also the majority of our outbound request volume in the idle
case, and request volume against a keyless API is the resource with the least
headroom.

### 3.3 `match` — a blind UPDATE per candidate per tick

`matchUpsertSQL` compares nothing. Its `WHERE` enforces the finalization and
state-regression invariants and then writes, setting `updated_at = now()`
unconditionally. Measured in the idle window: **82 `match` updates per slow tick**,
23,616 a day against a 2,578-row table (105 while the backlog was still finalizing).

Of the 2,578 matches, 2,210 are scheduled and 77 sit inside the −30/+7-day rolling
scoreboard window. A scheduled fixture's kickoff, state, status and score do not
change from tick to tick; these updates are almost entirely no-ops that still
produce a full tuple version each.

The fix is unusually cheap here because **the comparison data is already loaded**.
`ExistingMatches` runs once per competition per cycle and returns a `MatchRow` for
every candidate. It just does not currently carry kickoff, score, minute or status.

### 3.4 `ReplaceSquad`'s unconditional `UPDATE player`

Each squad member triggers

```sql
UPDATE player SET birth_date=COALESCE($2,birth_date),
                  nationality=COALESCE(NULLIF($3,''),nationality),
                  updated_at=now() WHERE id=$1
```

with no `IS DISTINCT FROM`. `COALESCE` means the values almost never change; `now()`
means the row is rewritten anyway. Measured: **7,023 `player` updates against 5,294
players and 6,903 squad memberships** — one rewrite per member per daily refresh,
essentially all no-ops. Small in absolute terms, and a one-line fix.

### 3.5 The live path — projected, not yet measured

Nothing here has run yet (§0). Projected for one 2-hour match at the 20-second fast
tick — 360 polls — using this database's measured per-match content sizes (114
commentary lines, 44 appearances, ~24 events, `match_detail` averaging 5,069 bytes
once populated):

| write | statements | durable rows produced |
|---|---:|---:|
| `match` UPDATE | 360 | 1 |
| `match_detail` UPDATE (~5 KB row) | 360 | 1 |
| `appearance` upserts + tail deletes | ~16,200 | 44 |
| `match_event` upserts | ~8,600 | 24 |
| `match_commentary` upserts + tail deletes | ~20,900 | 114 |
| `win_prob_snapshot` | 360 | 120 |
| `odds_snapshot` | 360 | 120 |
| `ingest_run` | 720 | 720 (audit, C5) |
| **total** | **≈ 47,000** | **≈ 420 rows of match content** |

**Roughly 110 statements written for every durable row of football.**
`WriteCommentary` alone
re-upserts the entire accumulated commentary list every 20 seconds; by the 80th
minute that is 100+ lines rewritten to append one. On a Saturday with ten
simultaneous matches this is ~470,000 writes in two hours, all through one pooled
connection set, and it has never been exercised.

The commentary path is the one to fix before the next matchday, not after.

---

## 4. The redesign

The principle: **the ingester should decide what to write from the subject's class
and state, not from which tick fired.** Concretely, four guards and one cadence
change. All of them are surgical; none requires restructuring the runner.

### 4.1 A content memo in the runner (C3 guard)

The runner already carries exactly this pattern — `snapshotted map[string]time.Time`
gates the daily standings snapshot, with a comment saying it is "a cost gate, not the
idempotency guarantee". Generalise it:

```go
// written maps a write-scope key to the fingerprint last committed for it.
// Purely a cost gate: the database's own constraints remain the guarantee, and
// a restart empties the map and re-writes once, which is correct and cheap.
written map[string]uint64
```

Apply it to `ReplaceStandings` and `ReplaceLeaders`: fingerprint the mapped row set
(FNV over the canonical field order — these are already sorted by rank), skip the
call when it matches. **~20 lines. Removes ~480,000 tuple writes and ~800,000 round
trips per day, and the autovacuum load that follows them.**

For `ReplaceLeaders` the fingerprint must be taken over the **mirrored** board, after
`mirrorLeaders` has run, not over the freshly-mapped one. That single choice also
collapses the unconditional second replacement from §3.1: mirror, fingerprint, write
once or not at all. `leaderCrestsChanged` then has no job left and should go.

Deliberately in the ingester and not in SQL: the SQL version needs either a
`content_hash` column (a migration, and a second thing to keep in sync) or a
read-back of the whole table before every write (which pays a query to avoid a
query). The in-process memo costs one map.

### 4.2 Extend `MatchRow` and skip the no-op `UpsertMatch` (C2 guard)

Add `Kickoff`, `HomeScore`, `AwayScore`, `Minute`, `StatusDetail`, `StatusName` to
`store.MatchRow` and to the `ExistingMatches` query — the query already joins the
row. Then in `processMatches`, after the existing preservation rules have produced
the final intended values, compare against `current` and skip `UpsertMatch` when
nothing differs.

The comparison must happen **after** the preservation rules, not before, or a
preserved round or winner will look like a change. `skipMatchUpsert` already exists
as a concept in that loop; this is a second reason to set it.

Not done as `AND (…) IS DISTINCT FROM (…)` in the SQL, because `UpsertMatch` treats
zero rows affected as "prove the row exists" and issues a second query. Adding a
content predicate would make that probe fire on the *common* path and cost more than
it saves.

### 4.3 Put a scheduled match's detail on a TTL (C3 cadence)

Change `needsSummary`'s scheduled branch from `|| slowTick` to a proximity ladder:

| time to kickoff | summary refresh |
|---|---|
| > 24 h | every 6 h |
| 24 h → 1 h | hourly |
| 1 h → kickoff | every 5 min (current slow tick) |
| live | every fast tick |

`ExistingMatches` must return `match_detail.updated_at` for this — one more column on
a query that already `LEFT JOIN`s the table for `HasDetail`. Combine with the §4.1
memo so an unchanged payload does not rewrite the row even when the TTL says to look.

**Removes ~23,000 rewrites and ~23,000 ESPN requests a day**, and it is the change
that most directly answers the original question: the pre-match win probability
living inside `match_detail` stops being rewritten every five minutes for every
fixture on the calendar.

### 4.4 Write the commentary tail, not the transcript (C1/C2 guard)

`WriteCommentary` currently upserts every line it is given. Two changes:

1. Track the highest `seq` committed per match in the runner and upsert only lines
   above it, **plus a fixed re-check window** of the last ~10 lines — commentary
   text is revised shortly after publication, and a pure high-water mark would miss
   that.
2. Keep the tail `DELETE`, which is what handles a retraction, but issue it only
   when the incoming `max(seq)` is lower than the stored one.

Same shape for `WriteParticipation`'s appearance loop: skip a row whose box score and
lineup fields are unchanged.

**Removes ~35,000 of the ~47,000 projected statements per live match.**

### 4.5 Make `ingest_run` coarse on the live path (C5)

Stop writing an `ingest_run` row per match per poll for `win_prob_snapshot` and
`odds`. Aggregate to one row per kind per competition per cycle, carrying counts.
Idle rate is 83 rows per slow tick — ~24,000 a day, ~720,000 at the 30-day
retention, and that is *before* any live match adds two rows per poll per match.

### 4.6 Make C1 an invariant, not a convention

`appearance`, `match_event`, `match_commentary`, `match_play`, `match_official` and
`match_odds` are immutable-once-final in policy and unguarded in the schema. Add the
same `finalized_at IS NOT NULL → reject` trigger `match_detail` already has, with a
deliberate operator escape hatch (a session GUC, or simply an owner-only path — the
ingester role is least-privilege already).

This is the one item that is about correctness rather than cost, and it is the reason
to do the classification at all: **the class should be enforced where the data lives,
so a future writer cannot violate it by accident.**

### Order

1. **§4.1** standings/leaders memo — largest idle saving, smallest diff, no schema change.
2. **§4.4** commentary tail — must land before the next matchday, because §3.5 has never run.
3. **§4.3** scheduled-detail TTL — largest saving overall once request volume is counted.
4. **§4.2** match no-op guard — needs a `MatchRow` change, so it rides with §4.3.
5. **§4.5**, **§3.4** — one-liners.
6. **§4.6** C1 triggers — correctness, own migration, no hurry but no drift either.

---

## 5. Win probability — the specific question

### It is not broken

`win_prob_snapshot` holds zero rows and has taken zero inserts. That is not a bug in
the write path. The path is:

```
processMatches → state == live → summary fetched
              → detail.WinProbability != nil → WriteWinProbSnapshot
```

Three pieces of evidence say every link works and the trigger simply never fired:

1. **The mapper works.** 427 of 450 `match_detail` rows carry a win probability, and
   **368 of 368 finished matches do**. `mapWinProbability` is producing values across
   every competition that publishes a three-way moneyline.
2. **The sibling write in the same branch shows the same silence.** `captureOdds` is
   called from the identical `state == live` block, and again once at finalization.
   `odds_snapshot` holds **363 rows for 363 distinct `(match, provider)` pairs** —
   exactly one apiece, matching `match_odds`' 363 open and 363 close rows. Every
   snapshot row is a finalization write. **Not one live poll has ever occurred.**
3. **The process is forty minutes old** (§0) and every match in the database is
   `scheduled` or `finished`. There has been nothing live to poll.

A mapper bug would show as odds present and probabilities absent. A store bug would
show as errors in `ingest_run` under `win_prob_snapshot` — there are none. What we
have is an untested path, which is a different and lesser problem, and the correct
response is a synthetic live-match test rather than a fix.

**One caveat to carry forward:** `detail.WinProbability` is derived from the
*summary* payload's `odds[]` block, whereas `odds_snapshot` comes from a separate
core-API call. If ESPN drops or reshapes `odds[]` in-play — which it may — the curve
will silently be `nil` for the entire match while `odds_snapshot` keeps filling. The
first live match must be watched for exactly this, and a `nil` probability on a live
match with a non-empty odds fetch deserves a warning, not silence.

### What the sampling policy should be

The instinct in the question is right, and it splits cleanly along the
classification.

**Not live → do not write it, and do not fetch it every five minutes.** A scheduled
match's win probability is C3: it drifts over days as the market forms. Today it is
written on every slow tick as part of the `match_detail` blob — 59 scheduled matches
carry one — and §3.2 measured that content as unchanged across a tick. §4.3 fixes
this by cadence, and it is precisely the waste the question named.

**Pre-match market movement is still worth keeping — as C4, not as a rewritten
column.** The drift from opening line to kickoff is genuinely interesting and is
lost entirely today, because `match_detail.win_probability` keeps no history. The
right answer is not to write it more often; it is to write it to the *right table*:
sample `win_prob_snapshot` and `odds_snapshot` **hourly from T−24 h**, which costs
24 rows per match and preserves the whole approach to kickoff.

**Live → sample at the minute, and only when the bucket or the value moves.** The
schema already decided this: migration 0005 buckets `captured_at` to the minute with
a unique index, precisely so a 20-second poll yields one row a minute. But the
*writer* still issues a statement every poll, so two of every three are conflict
updates rewriting the row just written. Keep the last `(matchID → bucket, value)` in
the runner and skip when both match. **~120 statements per match instead of ~360,
producing the same 120 rows.**

Do **not** skip on unchanged value alone. A flat curve is a real observation, and an
even one-row-per-minute x-axis is what makes two matches comparable. Write on bucket
change *or* value change, whichever comes first.

**Retention: forever.** This is C4. ESPN publishes the price now, never the price ten
minutes ago; a minute not sampled is a minute that no provider can return. Of every
write in the system only this class and `standing_snapshot` have that property, and
they are the two that should never be optimised away.

### The policy, stated

| match state | fetch | write to |
|---|---|---|
| > 24 h to kickoff | every 6 h | nothing unless the value changed |
| 24 h → 1 h | hourly | one `win_prob_snapshot` + `odds_snapshot` row per hour |
| 1 h → kickoff | every 5 min | one row per 5-minute bucket |
| live | every 20 s | one row per **minute** bucket, statement skipped when bucket and value both unchanged |
| finished | once | `match_odds` open/close, then never again |

### One thing the reader must never do

`win_prob_snapshot` is a **market-implied** probability: one bookmaker's three-way
moneyline with the margin divided out, per `mapWinProbability`. It is not a ScoreArc
forecast and nothing in the product may present it as one. That constraint is
written on `Store.WriteWinProbSnapshot` today; it belongs in the API contract too,
before anything renders a curve.

---

## What this document does not cover

Storage and schema reduction (whether `match_detail.commentary` should exist at all
now that `match_commentary` does), ESPN payload volatility field by field, and the
reader's view of any of this are three separate audits running in parallel. Where
they disagree with this one, the classification in §2 is the thing to reconcile
against — it is the vocabulary, not the conclusions, that has to be shared.
