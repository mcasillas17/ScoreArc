# Postgres Storage Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ScoreArc's Neon Postgres footprint by ~33% on the two tables that
dominate it, **without losing a single fact**, and write down the retention policy
that keeps season two bounded.

**Architecture:** The whole plan rests on one fact that is already true and is what
makes pruning safe here when it would be reckless anywhere else: **R2 holds every
byte ESPN ever sent us, and `match_play_archive` records where.** Postgres is not
the record of the play stream — it is a queryable *projection* of it. So the rule
this plan applies is: **a column earns its place in Postgres only if it is (a) not
derivable from another column, (b) not stored identically in another table, and
(c) actually read.** Everything failing that test is dropped from the projection
and stays in the archive, where a re-process can promote it back.

Three mechanisms carry the work:

1. **A `play_type` dimension table.** `type_key → type_text` is a perfect 1:1 map
   over 54 values in `match_play` and 49 in `match_commentary` — 63 in the union,
   **zero conflicting labels**. Storing the English label on all 116,000 fact rows
   costs 1,125 kB to say 63 things. It moves to a 63-row table. Nothing is lost.
2. **One combined `ALTER TABLE` per table.** `DROP COLUMN` in Postgres reclaims
   **nothing** — it only hides the attribute; the bytes stay in every existing
   tuple forever. The space comes back only on a table rewrite. `ALTER COLUMN …
   TYPE` forces exactly that rewrite, inside a transaction, which `VACUUM FULL`
   cannot be. So the drops and the type changes go in **one statement** and the
   type change pays for the drops. This is measured in "Finding 4" below, not
   assumed.
3. **Three index drops on a stated rule**, not on a scan counter.

**Tech Stack:** Go 1.26, pgx v5.10.0, Postgres 17.10 (Neon production) / Postgres
16 (CI service container), golang-migrate, testcontainers-go.

**Spec:** none — this is a storage-engineering plan derived from direct
measurement. The one product spec it must not break is
`docs/superpowers/specs/2026-08-15-shot-log-design.md` (E6), analysed in
"Decision 1" below.
**Epic:** E7 (`docs/PRODUCT_ROADMAP.md`) — add **T7.14 (storage reduction)** and
**T7.15 (retention policy)** under it.
**Branch:** `tweak/postgres-storage-reduction` off latest `origin/main`

---

## 🔴 The migration watermark is 15. Your migration number is 0016. Nothing else.

```
$ psql "$DIRECT_DSN" -X -c 'SELECT * FROM schema_migrations;'
 version | dirty
---------+-------
      15 | f
```

`golang-migrate` applies files **strictly above** the recorded version. A file
numbered at or below 15 is **silently skipped forever** on production while
appearing to work perfectly in CI — because CI applies every `*.up.sql` in
lexical order against an empty database and therefore cannot see the difference.

**This project has shipped that defect twice.** Note also that `0008` and `0009`
do not exist: the directory jumps `0007 → 0010`. Do not "fill the gap"; do not
renumber; do not reuse. The only correct filenames are:

```
backend/migrations/0016_storage_reduction.up.sql
backend/migrations/0016_storage_reduction.down.sql
```

Every migration needs **both** files. CI applies every `*.down.sql` in reverse
order (`ci.yml:54`), so a missing or non-applying down file fails the build.

---

## What was measured, and when

Every number below came from the **live Neon production database** on
**2026-08-17 08:09 UTC**. The ingester is running continuously, so row counts
will be **higher** by the time you execute this. That does not change any
decision — the ratios are stable and the structural findings are not
quantitative. Task 1 re-measures and records your own baseline before you change
anything.

```
Database total                                                  68 MB

table              rows      total     heap        indexes
match_play        74,851     30 MB     18 MB       12 MB      (40% index)
match_commentary  41,794     12 MB     7,016 kB    5,272 kB   (44% index)
appearance        16,075     4,032 kB  2,328 kB    1,664 kB
match_detail         450     2,720 kB    784 kB       40 kB   (+1,648 kB TOAST)
match_event        9,165     1,872 kB    984 kB      848 kB
squad_membership    6,903     1,624 kB    712 kB      872 kB
```

`match_play` + `match_commentary` = **42 MB of a 68 MB database (62%)**. They are
the whole problem; every other table is rounding error and this plan does not
touch them.

`match_play` column bytes:

```
text        4,536,395 B  (4,430 kB)   ← largest column in the database
player_id     937,000 B
team_id       925,000 B
type_text     773,781 B    (756 kB)   ← 63 distinct strings, stored 74,851 times
type_key      681,000 B
source_id     593,000 B
coordinates 1,244,896 B  (1,216 kB) over 203,694 non-NULL values
wallclock     527,000 B
clock_display 284,000 B
type_id       232,000 B
```

Indexes, with scan counts since launch:

```
match_play_pkey              (match_id, source_id)                   74,851 scans  5,742,592 B
match_play_order_idx         (match_id, seq)                              5 scans  4,587,520 B
match_play_located_idx       (match_id, type_key) WHERE start_x NOT NULL  0 scans    966,656 B
match_play_type_idx          (type_key)                                  21 scans    704,512 B
match_play_player_idx        (player_id) WHERE player_id IS NOT NULL      0 scans    712,704 B
match_commentary_pkey        (match_id, seq)                         41,794 scans  2,506,752 B
match_commentary_order_idx   (match_id, seq)                        120,145 scans  2,506,752 B
match_commentary_type_idx    (play_type) WHERE play_type IS NOT NULL      0 scans    385,024 B
match_play_archive_touch_idx (touch_tier)  -- on a 368-row table           0 scans     16,384 B
```

---

## Four findings that change the candidate list

### Finding 1 — `match_commentary_order_idx` is a byte-for-byte duplicate of the primary key

```
CREATE UNIQUE INDEX match_commentary_pkey      ON match_commentary USING btree (match_id, seq)
CREATE INDEX        match_commentary_order_idx ON match_commentary USING btree (match_id, seq)
```

Identical column list, identical order, identical size (2,506,752 B each).
Migration `0013_match_commentary.up.sql` declares `PRIMARY KEY (match_id, seq)`
and then, twelve lines later, `CREATE INDEX match_commentary_order_idx ON
match_commentary (match_id, seq)`.

**Its 120,145 scans are not an argument for keeping it.** The planner picks
arbitrarily between two identical indexes; every one of those scans is served
just as well by the PK, which cannot be dropped. This is 2,448 kB of pure
duplication and the single largest free win in the plan. It was not on the
candidate list.

### Finding 2 — `clock_display` is **not** derivable from `clock_value`. This candidate is wrong.

```sql
SELECT clock_value, clock_display FROM match_play
WHERE clock_value > 0 AND clock_display <> ceil(clock_value/60.0)::int::text||'''' LIMIT 4;

 clock_value | clock_display
-------------+---------------
        2700 | 45'+1'
        2700 | 45'+2'
        2700 | 45'+3'
        2700 | 45'+3'
```

`clock_value` saturates at the end of a period. **9,767 rows in `match_play`
(13%) and 5,537 in `match_commentary` carry stoppage-time information that
`clock_value` does not encode at all.** Dropping `clock_display` would delete the
only record of which minute of added time a stoppage-time goal was scored in.

**`clock_display` stays, in both tables.** Do not touch it. It was on the
candidate list at 230 kB; that saving does not exist.

### Finding 3 — column compression settings are a **no-op** on both tables. This lever does not exist.

```sql
SELECT avg(pg_column_size(p.*))::int, max(pg_column_size(p.*)) FROM match_play p;
 avg | max
-----+-----
 240 | 469

SELECT avg(pg_column_size(c.*))::int, max(pg_column_size(c.*)) FROM match_commentary c;
 avg | max
-----+-----
 162 | 353
```

`TOAST_TUPLE_THRESHOLD` is ~2,000 bytes. **No row in either table is within 4× of
it.** Postgres compresses and out-of-lines a value only when the whole tuple
crosses that threshold, so `match_play.text` and `match_commentary.text` are
stored **raw and uncompressed**, inline, always. Confirmed directly: a 134-char
string in a narrow table reports `pg_column_size` = 135 (134 + the 1-byte short
varlena header) both before and after `ALTER COLUMN … SET COMPRESSION lz4`.

Therefore `SET COMPRESSION lz4`, `SET STORAGE EXTENDED` and `SET STORAGE MAIN`
would all change **nothing** on these tables. **Do not add them to the
migration**; they look like they are doing work and are not.

The corollary is the interesting part. `match_detail.commentary` — a jsonb array
of the *same* prose, one row per match — **is** TOASTed, and stores in **1,084 kB**
what `match_commentary` stores in **3,131 kB**. Aggregating prose per match to
cross the TOAST threshold is a real 3× lever. It is **out of scope here**: it
would destroy the per-line ordering, machine type and clock that `0013` exists to
capture. It is written down so nobody re-derives it as a surprise.

### Finding 4 — `DROP COLUMN` reclaims nothing; `ALTER COLUMN … TYPE` reclaims everything

Run against the live database in a rolled-back transaction (temp table, no schema
touched):

```
CREATE TEMP TABLE t_probe (a int, b numeric(5,2), c numeric(5,2), pad text);
INSERT 50,000 rows

 baseline                        8512 kB
 after DROP COLUMN pad           8512 kB     ← zero reclaimed
 after ALTER b,c TYPE real       2560 kB     ← rewrite reclaims everything
```

And the combined form, which is what the migration uses:

```
CREATE TEMP TABLE t3 (a int, k text, kt text, sx numeric(5,2), sy numeric(5,2), body text)
INSERT 50,000 rows + one index

 baseline                                    heap 9304 kB   idx 1992 kB
 DROP INDEX; ALTER TABLE t3
   DROP COLUMN body, DROP COLUMN kt,
   ALTER COLUMN sx TYPE real, ALTER COLUMN sy TYPE real
                                             heap 3072 kB   idx 0 bytes
```

One statement, one rewrite, everything reclaimed — **and it runs inside a
transaction**, which `VACUUM FULL` cannot:

```
ERROR:  VACUUM cannot run inside a transaction block
```

`golang-migrate` wraps every migration in a transaction, so a `VACUUM FULL` in a
`.up.sql` file **fails on production** while passing CI (CI uses `psql -f`, which
is in autocommit). **Never put `VACUUM FULL` in a migration file.**

This is why `match_commentary` — which has no coordinate column to convert — gets
`ALTER COLUMN period TYPE smallint`. That is not a trick: `period` is 1–5 (max
observed 5 in both tables) and `smallint` is the correct type for it. It also
happens to be the rewrite trigger, verified the same way:

```
 baseline                        6904 kB
 after DROP COLUMN pad           6904 kB
 after ALTER p TYPE smallint     2048 kB
```

---

## Decision 1 — `match_play.text` is dropped entirely

This is the load-bearing decision and it was tested against E6, not asserted.

**(a) 52% of the column is boilerplate with zero information content.**

```sql
SELECT count(*) FILTER (WHERE text ~ ' at [0-9]+''$') AS boilerplate,
       count(*) FILTER (WHERE text <> '' AND text !~ ' at [0-9]+''$') AS prose
FROM match_play;

 boilerplate | prose
-------------+-------
       37,683 | 34,333       -- 1,682 kB vs 2,731 kB
```

Samples:

```
Kim Seung-Gyu (South Korea) Goal Kick at 3'
Lee Jae-Sung (South Korea) Assists Shot at 12'
Emmanuel Latte Lath (Atlanta United FC) Shot On Target at 21'
```

That is `{player} ({team}) {type_text} at {clock_display}'` — reconstructible
character-for-character from `player_id`, `team_id`, `type_key` and
`clock_display`, all of which stay. 1,682 kB to store a `printf` format string
75,000 times.

**(b) Every prose line E6 needs is already stored verbatim in `match_commentary.text`.**

```sql
SELECT type_key, count(*) AS plays,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM match_commentary c WHERE c.match_id = p.match_id AND c.text = p.text
  )) AS found_verbatim_in_commentary
FROM match_play p WHERE p.text <> '' GROUP BY 1;

 type_key           | plays | found
--------------------+-------+-------
 shot-off-target    | 3,421 | 3,401     99.4%
 shot-blocked       | 2,492 | 2,450     98.3%
 shot-on-target     | 2,144 | 2,133     99.5%
 goal               |   778 |   778    100.0%
 goal---header      |   163 |   163    100.0%
 penalty---scored   |   166 |   166    100.0%
 own-goal           |    31 |    31    100.0%
 goal---free-kick   |    20 |    20    100.0%
 ...
 assists-shot       | 6,436 |     0     ← boilerplate, see (a)
 goal-kick          | 3,963 |     0     ← boilerplate, see (a)
```

Both tables cover **exactly the same 368 matches**. Every shot-family type — the
only types E6 reads — is 98–100% present, character-identical, in
`match_commentary`. The 0% rows are precisely the generated boilerplate from (a).

**(c) E6's spec already names commentary, not the play stream, as the prose source.**
`2026-08-15-shot-log-design.md`, T6.2, verbatim:

> - **from `match_play`** (T7.12): shooter id, `fieldPositionX/Y`, outcome type,
>   penalty flag, `goalPositionY/Z` where present;
> - **from commentary** (T7.11): body part and assist type, matched to a shot by
>   minute and shooter.

The premise that dropping this column costs E6 its body part and assist type is
false. E6 was never going to read it. The join it will use —
`(match_id, period, clock_display, play_type = type_key)` plus shooter — is
exactly the "matched to a shot by minute and shooter" the spec specifies, and
every column that join needs survives this plan.

**(d) And the whole raw stream is in R2 regardless**, ledgered per match in
`match_play_archive.object_key`. Even the ~11% of non-shot Opta prose (fouls,
throw-ins, substitutions) that commentary omits is one re-process away.

**Rejected alternatives, for the record:**

- *Keep `text` only for shot-type plays.* Costs a `CHECK`-shaped invariant nobody
  can enforce on upsert, leaves 1,705 kB of duplication in place, and buys
  nothing — the prose is already in `match_commentary` at 98–100%.
- *Extract body part and assist type into columns at ingest.* This is parsing
  English prose in the ingester, which `0013_match_commentary.up.sql` explicitly
  forbids ("**NOTHING HERE IS PARSED** — E6's shot-log parser is downstream and is
  gated on T6.1's per-competition coverage probe"). It would also pre-empt T6.1,
  the blocking coverage gate, on the strength of two samples — the exact failure
  that task exists to prevent.

**Saving: 4,430 kB today; ~31 MB per season.**

---

## Decision 2 — the unused indexes: drop three, keep five

"Zero scans" is not a sufficient reason. Three of these were built for **E10's
`T10.8` play-stream reads, which do not exist yet**; a zero counter for an
endpoint nobody has written proves nothing. The rule this plan applies instead is
about *what the query would scan without the index*:

> **Drop an index iff it has effectively no scans AND either (a) its leading
> column is `match_id`, so the primary key already provides that locality over a
> ~200-row partition, or (b) it exactly duplicates another index. Keep every
> index whose leading column is not `match_id`, because its query scans the whole
> table.**

At 74,851 rows over 368 matches, a match holds **203 plays**. Sorting or filtering
203 rows in memory after a PK lookup on `match_id` is sub-millisecond and always
will be. An index cannot beat that; it can only cost write amplification and
bytes. A query anchored on `player_id` or `type_key`, by contrast, has no
`match_id` to anchor on and degrades to a sequential scan of the whole table —
half a million rows by season's end.

| Index | Bytes | Scans | Verdict | Reason |
|---|---|---|---|---|
| `match_play_order_idx (match_id, seq)` | 4,587,520 | 5 | **DROP** | Leads with `match_id`. PK gives the same locality; 203 rows sort in memory. Do **not** re-add with E10 — this index cannot pay for itself at this table's shape. |
| `match_play_located_idx (match_id, type_key) WHERE start_x IS NOT NULL` | 966,656 | 0 | **DROP** | Same: the shot-map query is per match. |
| `match_commentary_order_idx (match_id, seq)` | 2,506,752 | 120,145 | **DROP** | Exact duplicate of the PK (Finding 1). Scans transfer to the PK. |
| `match_play_archive_touch_idx (touch_tier)` | 16,384 | 0 | **DROP** | A btree on a boolean over a **368-row** table. A seq scan wins by construction. Correctness, not size. |
| `match_play_player_idx (player_id) WHERE NOT NULL` | 712,704 | 0 | **KEEP** | E10/E6's "every shot by this player this season" is cross-match. Without it that is a full scan of ~525,000 rows. 696 kB is cheap insurance, and `CREATE INDEX` on a half-million-row table later is an operation with a lock, not a free choice. |
| `match_play_type_idx (type_key)` | 704,512 | 21 | **KEEP** | Non-zero scans, and cross-match. |
| `match_commentary_type_idx (play_type) WHERE NOT NULL` | 385,024 | 0 | **KEEP** | Cross-match; E6's parser and E8's recap prompt both open by selecting a type subset. |
| `appearance_team_idx`, `match_event_type_idx`, `match_event_player_idx`, `squad_membership_player_idx` | 672,000 total | 0 | **KEEP** | All cross-match access paths for named epics; 656 kB combined is below the noise floor of this exercise. |

Note the honest consequence: this leaves ~2.3 MB of never-scanned index in the
database on purpose. That is 3% of the database and it is the price of not
guessing about queries nobody has written yet. The three that go are the three
that are *provably* dominated by an index that must exist anyway.

**Saving: 8,077,312 B = 7,888 kB ≈ 7.7 MB today; ~33 MB per season.**

---

## Decision 3 — `type_text` / `play_type_text` move to a `play_type` dimension table

```sql
WITH p AS (SELECT DISTINCT type_key k, type_text t FROM match_play),
     c AS (SELECT DISTINCT play_type k, play_type_text t FROM match_commentary WHERE play_type IS NOT NULL)
SELECT (SELECT count(*) FROM p) play_keys,
       (SELECT count(*) FROM c) comm_keys,
       (SELECT count(*) FROM c JOIN p USING (k) WHERE c.t IS DISTINCT FROM p.t) conflicting_labels,
       (SELECT count(*) FROM (SELECT k FROM p UNION SELECT k FROM c) u) union_keys;

 play_keys | comm_keys | conflicting_labels | union_keys
-----------+-----------+--------------------+------------
        54 |        49 |                  0 |         63
```

One shared vocabulary, 63 values, **zero label conflicts**. The label is a
property of the *type*, not of the *play*. `type_key → type_text` is a total
function (no `type_key` maps to two labels), so a lookup table is lossless.

It is not derivable by an algorithm — `shield-ball-opp → "Shield ball opp"`,
`foul-throw-in → "Foul throw-in"`, `var---referee-decision-cancelled → "VAR -
Referee decision cancelled"` — which is exactly why this is a table and not a
`initcap(replace(...))` in Go.

**No foreign key.** ESPN adds play types without notice; a FK would make an
unknown type an ingest failure. The ingester upserts the dimension before it
writes the facts, in the same transaction. That matches this codebase's standing
rule that an unrecognised-but-real event is stored, not dropped
(`0007_play_stream.up.sql`: "an unattributed play that happened beats a dropped
one").

**`match_play.type_id` stays.** It is *not* 1:1 with `type_key` — 58 distinct ids
map to 54 keys (`free-kick` has two, and each of `penalty---scored`,
`penalty---saved`, `penalty---missed` has two). Folding it into the dimension
would lose a provider distinction to save 232 kB. Not worth it.

**Saving: 756 kB + 369 kB = 1,125 kB today; ~7 MB per season.**

---

## Decision 4 — `numeric(5,2) → real` on the six coordinate columns

1,244,896 B across 203,694 non-NULL values = 6.11 B each (short-header varlena
`numeric`). `real` is 4 bytes flat → 814,776 B. **Saving ~420 kB**, plus it is the
rewrite trigger that reclaims everything in Decisions 1 and 3 (Finding 4).

Precision is not a concern, and this was checked rather than assumed:

```sql
SELECT max(abs(start_x::real::numeric - start_x)) FROM match_play;
 max
------
 0.00
```

**Every one of the 74,851 stored coordinates round-trips through `real` exactly.**
Values live in 0.00–100.00 with two decimals; `float4` carries ~7 significant
decimal digits, so the representable spacing near 100 is ~7.6e-6 — three orders
of magnitude finer than the provider's own precision.

**One consequence you must handle (Task 4):** `pgx` reads `float4` in binary and
widens to `float64`, so Go sees `77.19999694824219`, not `77.2`. The exact
equality in `shared/store/plays_integration_test.go:146` and `:201` will fail.
That is the conversion working correctly, not a bug — the assertions become
tolerance comparisons.

---

## Total

**Today (measured 2026-08-17, 68 MB database):**

| Lever | Saving |
|---|---|
| Drop `match_play.text` | 4,430 kB |
| Drop `match_play_order_idx` | 4,480 kB |
| Drop `match_commentary_order_idx` (duplicate PK) | 2,448 kB |
| Drop `match_play_located_idx` | 944 kB |
| Move `type_text` to `play_type` | 756 kB |
| `numeric(5,2) → real` ×6 | 420 kB |
| Move `play_type_text` to `play_type` | 369 kB |
| Drop `match_play_archive_touch_idx` | 16 kB |
| **Total** | **13,863 kB ≈ 13.5 MB** |
| *plus* accumulated bloat reclaimed by the two rewrites | measured in Task 6 |

**13.5 MB of a 68 MB database = 20%. Of the 42 MB those two tables occupy = 33%.**

**Per season.** 2,578 matches are scheduled across the nine competitions this
season (`SELECT count(*) FROM match` = 2,578). At the measured 203.4 plays and
113.6 commentary lines per match:

| Table | Rows/season | Bytes/row before → after | Season before → after |
|---|---|---|---|
| `match_play` | 524,363 | 420 B → 269 B (**−36%**) | 220 MB → **141 MB** |
| `match_commentary` | 292,861 | 301 B → 232 B (**−23%**) | 88 MB → **68 MB** |
| everything else | — | unchanged | ~65 MB |
| **Total** | | | **~373 MB → ~274 MB** |

**~99 MB saved per season, a 27% cut**, and after this plan the remaining growth
is spread across tables where no single lever is worth pulling. That is why
**Task 7 writes the retention policy**: levers of this kind are now exhausted, and
season two is bounded by deletion, not by column design.

---

## Global Constraints

- **The migration is `0016`. The watermark is 15.** Re-read the red box above.
- Both `0016_storage_reduction.up.sql` and `0016_storage_reduction.down.sql` must
  exist and must apply cleanly to an **empty** database, because that is what CI
  does (`ci.yml:45-46` forward, `:53-54` in reverse).
- **No `VACUUM FULL` in any migration file** — Finding 4.
- Backend gate, all four, from `backend/`:
  `go build ./... && go vet ./... && go test -race ./...`
  (testcontainers packages need **Docker running**).
- Frontend gate unchanged and still required by `ci.yml`: `npm test`,
  `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Never print a DSN or a credential into a commit, a log or a PR body.
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.
- **Never push to `main`.** Feature branch, PR, and the merge is the user's call.
- **Applying the migration to production Neon is the user's call**, not yours.
  Task 6 stops and asks.

---

## File Structure

**New:**
- `backend/migrations/0016_storage_reduction.up.sql`
- `backend/migrations/0016_storage_reduction.down.sql`
- `docs/backend/RETENTION.md` — the retention policy (Task 7)

**Modified:**
- `backend/migrations/migrations_test.go` — assertions for 0016.
- `backend/shared/store/plays.go` — `playTypeUpsertSQL` (new const), `WritePlays`
  upserts the dimension, `playUpsertSQL` loses `type_text` and `text` (29 → 27
  params).
- `backend/shared/store/commentary.go` — same dimension upsert,
  `commentaryUpsertSQL` loses `play_type_text` (9 → 8 params).
- `backend/shared/store/plays_integration_test.go` — float tolerance at `:146`
  and `:201`; the `type_text` assertion at `:197` moves to `play_type.label`.
- `backend/shared/store/commentary_integration_test.go` — a `play_type` assertion.
- `backend/shared/model/plays.go` — `Play.Text` removed. `Play.TypeText` **stays**
  (it feeds `play_type.label`).
- `backend/shared/espn/plays.go:171` — stop mapping `Text: item.Text`.
- `docs/backend/ARCHITECTURE.md` — `match_play` has no schema bullet at all
  (only `match_commentary` does, at line 117); add one, amend the other, and
  document the storage policy.

**Deliberately NOT modified** — checked, and no call site exists:
- `backend/reader/**` — no reader endpoint touches `match_play` or
  `match_commentary`. Verified: `grep -rn "match_play" backend --include="*.go"`
  returns only `shared/store/**` and `shared/assets/archive.go` (a comment).
- `backend/cmd/play-retention/main.go` — reads the **live ESPN API**, never the
  database. Its `play.TypeText` use at `:103` is against a fetched payload and is
  unaffected. (It is also **not** a Postgres retention tool — see Task 7.)
- `src/**` — the frontend still reads ESPN directly; the reader cutover has not
  happened for these surfaces.

---

### Task 1: Record the baseline before changing anything

**Files:** none — this task produces evidence, not code.

You cannot report a saving without a before. The database grows continuously, so
the numbers in this plan are **not** your baseline; yours is.

- [ ] **Step 1: Capture the baseline**

```bash
set -a; source ~/.scorearc-db.env; set +a
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
psql "$DIRECT_DSN" -X -c "SELECT now()::timestamptz(0) AS measured_at,
  pg_size_pretty(pg_database_size(current_database())) AS db_total;" \
  -c "SELECT c.relname,
        (SELECT count(*) FROM match_play)       AS mp_rows,
        (SELECT count(*) FROM match_commentary) AS mc_rows,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
        pg_size_pretty(pg_relation_size(c.oid))       AS heap,
        pg_size_pretty(pg_indexes_size(c.oid))        AS idx
      FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace
        AND c.relname IN ('match_play','match_commentary')
      ORDER BY pg_total_relation_size(c.oid) DESC;"
```

Expected: a `db_total` of roughly 68–90 MB (it grows), `match_play` around
30–40 MB and `match_commentary` around 12–16 MB. Write the exact output into your
scratch notes — Task 6 Step 3 diffs against it and the PR body quotes both.

- [ ] **Step 2: Confirm the watermark yourself**

```bash
psql "$DIRECT_DSN" -X -c 'SELECT * FROM schema_migrations;'
```

Expected:

```
 version | dirty
---------+-------
      15 | f
```

If `version` is **not** 15, **stop and ask the user.** Someone applied a migration
between this plan being written and you executing it, and your file number is no
longer 0016. If `dirty` is `t`, the last migration failed halfway and must be
resolved (`migrate force <n>`) before anything else happens.

- [ ] **Step 3: Confirm the three structural findings still hold**

```bash
psql "$DIRECT_DSN" -X -c "
WITH p AS (SELECT DISTINCT type_key k, type_text t FROM match_play),
     c AS (SELECT DISTINCT play_type k, play_type_text t FROM match_commentary WHERE play_type IS NOT NULL)
SELECT (SELECT count(*) FROM (SELECT k FROM p UNION SELECT k FROM c) u) AS union_keys,
       (SELECT count(*) FROM c JOIN p USING (k) WHERE c.t IS DISTINCT FROM p.t) AS conflicting_labels;" \
 -c "SELECT count(*) AS stoppage_time_rows FROM match_play WHERE clock_display LIKE '%+%';" \
 -c "SELECT indexdef FROM pg_indexes
     WHERE tablename='match_commentary' AND indexname IN ('match_commentary_pkey','match_commentary_order_idx');"
```

Expected: `conflicting_labels` is **0** (Decision 3 is safe — if it is not,
stop: two labels for one key means the dimension table would lose data);
`stoppage_time_rows` is in the thousands (Finding 2 holds, `clock_display`
stays); and the two `indexdef` rows differ only by `UNIQUE` and the index name
(Finding 1 holds).

- [ ] **Step 4: Branch**

```bash
git fetch origin && git checkout -b tweak/postgres-storage-reduction origin/main
```

---

### Task 2: Write migration 0016

**Files:**
- Create: `backend/migrations/0016_storage_reduction.up.sql`
- Create: `backend/migrations/0016_storage_reduction.down.sql`

**Interfaces:**
- New table `play_type(key text PRIMARY KEY, label text NOT NULL)`, granted
  `SELECT` to `scorearc_reader` and `SELECT, INSERT, UPDATE` to
  `scorearc_ingester`. No `DELETE` — a play type that has ever been seen is a
  fact about the provider's vocabulary.
- `match_play` loses `text` and `type_text`; its six coordinate columns become
  `real`.
- `match_commentary` loses `play_type_text`; `period` becomes `smallint`.
- Four indexes are dropped.

- [ ] **Step 1: Write the up migration**

Create `backend/migrations/0016_storage_reduction.up.sql`:

```sql
-- Storage reduction for the two tables that are 62% of the database.
--
-- THE PREMISE. R2 holds every byte ESPN ever sent, ledgered per match in
-- match_play_archive.object_key. Postgres holds a queryable PROJECTION of that
-- stream, not the record of it. So a column earns its place here only if it is
-- (a) not derivable, (b) not stored identically elsewhere, and (c) read.
-- Everything dropped below fails that test and is one re-process away.
--
-- MEASURED 2026-08-17 on production (74,851 plays / 41,794 commentary lines /
-- 368 matches / 68 MB database). Saving: ~13.5 MB today, ~99 MB per season.
--
-- WHAT IS DELIBERATELY *NOT* HERE, so nobody re-proposes it:
--
--   * clock_display stays. It is NOT derivable from clock_value: the clock
--     saturates at the end of a period, so 9,767 match_play rows and 5,537
--     match_commentary rows carry "45'+2'" against a clock_value of 2700.
--     Dropping it would delete which minute of added time a goal was scored in.
--   * SET COMPRESSION / SET STORAGE are absent because they are no-ops here.
--     Average tuple width is 240 bytes (match_play) and 162 (match_commentary)
--     against a ~2,000-byte TOAST_TUPLE_THRESHOLD, so no value in either table
--     is ever compressed or out-of-lined, and no setting changes that.
--   * VACUUM FULL is absent because golang-migrate runs each migration inside a
--     transaction and VACUUM cannot. The rewrites below do the same job.
--   * type_id stays: 58 provider ids map to 54 type_keys (free-kick and each
--     penalty--- variant carry two), so folding it into play_type would lose a
--     distinction to save 232 kB.

-- Fail fast rather than queue behind the ingester's 20-second write cycle. If
-- this fires, the transaction aborts, golang-migrate marks version 16 dirty,
-- and recovery is `migrate force 15` followed by a retry -- NOT `migrate force
-- 16`, which would skip this migration permanently.
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1. The play-type dimension.
-- ---------------------------------------------------------------------------
-- type_key -> type_text is a total function: 54 keys in match_play, 49 in
-- match_commentary, 63 in the union, and ZERO conflicting labels. Storing the
-- English label on 116,000 fact rows costs 1,125 kB to say 63 things.
--
-- The label is not derivable by an algorithm -- "shield-ball-opp" is
-- "Shield ball opp", "foul-throw-in" is "Foul throw-in", and
-- "var---referee-decision-cancelled" is "VAR - Referee decision cancelled".
-- That is exactly why this is a table and not an initcap() in Go.
--
-- NO FOREIGN KEY from the fact tables. ESPN adds play types without notice and
-- a FK would turn an unknown type into an ingest failure. The ingester upserts
-- this dimension inside the same transaction as the facts. An unrecognised but
-- real event is stored, not dropped -- the rule 0007 already states.
CREATE TABLE play_type (
  key   text PRIMARY KEY,
  label text NOT NULL
);

INSERT INTO play_type (key, label)
SELECT key, min(label)
FROM (
  SELECT type_key AS key, type_text AS label
  FROM match_play
  WHERE type_key <> '' AND type_text <> ''
  UNION
  SELECT play_type, play_type_text
  FROM match_commentary
  WHERE play_type IS NOT NULL AND play_type_text IS NOT NULL
) src
-- min() is defensive, not expected: conflicting_labels measured 0. It makes the
-- backfill deterministic if a future label ever diverges, rather than failing
-- the migration on a duplicate key.
GROUP BY key
ON CONFLICT (key) DO NOTHING;

GRANT SELECT ON play_type TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON play_type TO scorearc_ingester;

-- ---------------------------------------------------------------------------
-- 2. Indexes.
-- ---------------------------------------------------------------------------
-- Dropped BEFORE the rewrites below, so the rewrite does not rebuild an index
-- that is about to disappear.
--
-- The rule: drop an index only when its leading column is match_id (the primary
-- key already gives that locality over a ~203-row partition, and 203 rows sort
-- in memory faster than any index can be probed) or when it exactly duplicates
-- another index. Every index whose leading column is NOT match_id is KEPT --
-- match_play_player_idx, match_play_type_idx and match_commentary_type_idx all
-- serve cross-match queries that would otherwise scan half a million rows, and
-- E10/E6/E8 name those queries.

-- (match_id, seq). 5 scans against the primary key's 74,851. A match holds 203
-- plays; the PK finds them and an in-memory sort orders them. E10's T10.8 must
-- NOT re-add this -- it cannot pay for itself at this table's shape.
DROP INDEX IF EXISTS match_play_order_idx;

-- (match_id, type_key) WHERE start_x IS NOT NULL. Zero scans. The shot-map
-- query is per match, so the same argument applies.
DROP INDEX IF EXISTS match_play_located_idx;

-- (match_id, seq) -- BYTE-FOR-BYTE IDENTICAL to match_commentary_pkey, which
-- 0013 declared twelve lines earlier as PRIMARY KEY (match_id, seq). Its
-- 120,145 scans are not an argument to keep it: the planner picks arbitrarily
-- between two identical indexes and the PK serves every one of them.
DROP INDEX IF EXISTS match_commentary_order_idx;

-- A btree on a boolean over a 368-row table. A sequential scan wins by
-- construction. Dropped on correctness, not on size.
DROP INDEX IF EXISTS match_play_archive_touch_idx;

-- ---------------------------------------------------------------------------
-- 3. match_play: drop two columns and narrow the geometry, in ONE statement.
-- ---------------------------------------------------------------------------
-- ONE statement is the point. ALTER TABLE ... DROP COLUMN reclaims NOTHING in
-- Postgres -- it hides the attribute and leaves the bytes in every existing
-- tuple forever. Space returns only on a table rewrite, and ALTER COLUMN ...
-- TYPE forces exactly one. Splitting these into separate statements would cost
-- two rewrites and reclaim the same bytes; splitting the DROPs out entirely
-- would reclaim nothing at all.
--
-- text: 4,430 kB, the largest column in the database, and every byte of it is
--   duplicated or derivable.
--   - 52% (37,683 rows, 1,682 kB) is generated boilerplate of the form
--     "{player} ({team}) {type_text} at {clock}'" -- reconstructible from
--     player_id, team_id, type_key and clock_display, all of which stay.
--   - Of the real Opta prose, 98-100% of EVERY shot-family type is stored
--     character-identical in match_commentary.text, over the same 368 matches.
--     Measured: shot-off-target 3,401/3,421; shot-blocked 2,450/2,492;
--     shot-on-target 2,133/2,144; goal 778/778; penalty---scored 166/166.
--   - E6 was never going to read this column anyway. Its spec (T6.2) reads the
--     stream for shooter/location/outcome and COMMENTARY for body part and
--     assist type.
--   - And the raw stream is in R2 regardless.
--
-- type_text: 756 kB to store 63 strings 74,851 times. Now in play_type.
--
-- coordinates: numeric(5,2) is a 6.11-byte varlena; real is 4 bytes flat, and
--   every one of the 74,851 stored values round-trips through real EXACTLY
--   (max(abs(start_x::real::numeric - start_x)) = 0.00). Values are 0.00-100.00
--   with two decimals; float4 resolves ~7 significant digits.
ALTER TABLE match_play
  DROP COLUMN text,
  DROP COLUMN type_text,
  ALTER COLUMN start_x TYPE real,
  ALTER COLUMN start_y TYPE real,
  ALTER COLUMN end_x   TYPE real,
  ALTER COLUMN end_y   TYPE real,
  ALTER COLUMN goal_y  TYPE real,
  ALTER COLUMN goal_z  TYPE real;

-- ---------------------------------------------------------------------------
-- 4. match_commentary: same shape, different rewrite trigger.
-- ---------------------------------------------------------------------------
-- This table has no numeric column to narrow, and VACUUM FULL cannot run inside
-- golang-migrate's transaction. period -> smallint is the trigger, and it is
-- also simply the correct type: a football period is 1..5 (max observed 5 in
-- both tables) and smallint holds 32,767.
--
-- text STAYS. After this migration it is the ONLY home of the match prose, and
-- E6's body-part and assist-type extraction reads it.
-- clock_display STAYS -- see the stoppage-time note at the top.
ALTER TABLE match_commentary
  DROP COLUMN play_type_text,
  ALTER COLUMN period TYPE smallint;
```

- [ ] **Step 2: Write the down migration**

Create `backend/migrations/0016_storage_reduction.down.sql`:

```sql
-- Reverses 0016. CI applies every down file in reverse order, so this must
-- restore the SCHEMA exactly.
--
-- WHAT COMES BACK AND WHAT DOES NOT. type_text and play_type_text are restored
-- WITH THEIR DATA, from play_type, which is why play_type is dropped last.
-- match_play.text comes back EMPTY: its content lives in R2 and in
-- match_commentary.text, and rematerialising it is a re-process, not a
-- migration. That is the deliberate design, not an oversight -- see the up
-- file's premise.

SET LOCAL lock_timeout = '30s';

-- 1. match_commentary: widen period, restore the label column, refill it.
ALTER TABLE match_commentary
  ADD COLUMN play_type_text text,
  ALTER COLUMN period TYPE int;

UPDATE match_commentary c
SET play_type_text = t.label
FROM play_type t
WHERE t.key = c.play_type;

CREATE INDEX match_commentary_order_idx ON match_commentary (match_id, seq);

-- 2. match_play: widen the geometry, restore both columns, refill type_text.
ALTER TABLE match_play
  ADD COLUMN type_text text NOT NULL DEFAULT '',
  ADD COLUMN text text NOT NULL DEFAULT '',
  ALTER COLUMN start_x TYPE numeric(5,2),
  ALTER COLUMN start_y TYPE numeric(5,2),
  ALTER COLUMN end_x   TYPE numeric(5,2),
  ALTER COLUMN end_y   TYPE numeric(5,2),
  ALTER COLUMN goal_y  TYPE numeric(5,2),
  ALTER COLUMN goal_z  TYPE numeric(5,2);

UPDATE match_play p
SET type_text = t.label
FROM play_type t
WHERE t.key = p.type_key;

-- 0007 declared type_text NOT NULL with no default; text NOT NULL DEFAULT ''.
ALTER TABLE match_play ALTER COLUMN type_text DROP DEFAULT;

CREATE INDEX match_play_order_idx ON match_play (match_id, seq);
CREATE INDEX match_play_located_idx
  ON match_play (match_id, type_key)
  WHERE start_x IS NOT NULL;
CREATE INDEX match_play_archive_touch_idx ON match_play_archive (touch_tier);

-- 3. Last, because steps 1 and 2 read it.
DROP TABLE IF EXISTS play_type;
```

- [ ] **Step 3: Prove both files apply, forward and back, on an empty database**

This is exactly what CI does, so run it locally first. Use a **throwaway**
Postgres — never the production DSN.

```bash
docker run --rm -d --name sa-mig -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scorearc -p 55432:5432 postgres:16
sleep 5
export MIG_DSN='postgres://postgres:postgres@localhost:55432/scorearc?sslmode=disable'
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
for m in backend/migrations/*.up.sql;   do psql "$MIG_DSN" -v ON_ERROR_STOP=1 -q -f "$m" || break; done
psql "$MIG_DSN" -X -c '\d match_play' -c '\d play_type'
for m in $(find backend/migrations -name '*.down.sql' | sort -r); do psql "$MIG_DSN" -v ON_ERROR_STOP=1 -q -f "$m" || break; done
docker rm -f sa-mig
```

Expected: every file applies without error. `\d match_play` shows **no `text`
column and no `type_text` column**, the six coordinate columns as `real`, and
exactly **three** indexes — `match_play_pkey`, `match_play_type_idx` and
`match_play_player_idx` (`match_play_order_idx` and `match_play_located_idx` are
gone). `\d play_type` shows `key text not null` / `label text not null` with
`play_type_pkey`. The reverse pass completes with no error and no output.

If the forward pass errors on `GRANT ... TO scorearc_reader`, the roles were not
created — that means an earlier `.up.sql` failed; read the first error, not the
last.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/0016_storage_reduction.up.sql backend/migrations/0016_storage_reduction.down.sql
git commit -m "feat: add migration 0016 to shrink match_play and match_commentary

Drops match_play.text (4,430 kB; 52% generated boilerplate, and 98-100%
of every shot-family prose line is stored character-identical in
match_commentary over the same 368 matches), moves the play-type label to
a 63-row dimension table, narrows the six coordinate columns to real, and
drops four indexes -- one of which was a byte-for-byte duplicate of
match_commentary's primary key.

The drops and the type changes share ONE ALTER TABLE per table on
purpose: DROP COLUMN reclaims nothing in Postgres, and ALTER COLUMN TYPE
is the only rewrite that runs inside golang-migrate's transaction.

~13.5 MB of 68 MB today; ~99 MB per season.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Lock the migration's invariants into `migrations_test.go`

**Files:**
- Modify: `backend/migrations/migrations_test.go`

`migrations_test.go` asserts the *text* of each migration, which is how this repo
stops a later edit quietly removing a grant or a guard. 0016 needs the same
treatment, plus one invariant that outlives it (Task 7 depends on it).

- [ ] **Step 1: Write the failing test**

Append to `backend/migrations/migrations_test.go`:

```go
// Storage reduction is only safe because R2 holds the full raw stream and
// match_play_archive ledgers where. These assertions guard the parts a later
// edit is most likely to break without anyone noticing.
func TestStorageReductionKeepsTheReprocessablePath(t *testing.T) {
	up := readMigration(t, "0016_storage_reduction.up.sql")
	for _, required := range []string{
		"CREATE TABLE play_type",
		// One statement per table, because DROP COLUMN reclaims nothing and
		// ALTER COLUMN TYPE is the rewrite that does. Splitting them costs a
		// second rewrite for the same result.
		"ALTER TABLE match_play\n  DROP COLUMN text,\n  DROP COLUMN type_text,",
		"ALTER COLUMN start_x TYPE real",
		"ALTER TABLE match_commentary\n  DROP COLUMN play_type_text,\n  ALTER COLUMN period TYPE smallint",
		"DROP INDEX IF EXISTS match_commentary_order_idx",
		"GRANT SELECT, INSERT, UPDATE ON play_type TO scorearc_ingester",
	} {
		if !strings.Contains(up, required) {
			t.Fatalf("0016_storage_reduction.up.sql missing %q", required)
		}
	}

	// VACUUM cannot run inside a transaction and golang-migrate wraps every
	// migration in one. A VACUUM FULL here passes CI (psql -f is autocommit)
	// and fails on production. The rewrites above already reclaim the space.
	if strings.Contains(up, "VACUUM") {
		t.Fatal("0016 must not contain VACUUM: golang-migrate runs migrations in a transaction")
	}

	// clock_display is NOT derivable from clock_value. The clock saturates at
	// the end of a period, so "45'+2'" and "45'+3'" both carry clock_value
	// 2700; 9,767 match_play rows and 5,537 match_commentary rows depend on it.
	if strings.Contains(up, "DROP COLUMN clock_display") {
		t.Fatal("clock_display carries stoppage time that clock_value does not encode")
	}

	// match_commentary.text is the only surviving home of the match prose and
	// E6's body-part and assist-type extraction reads it.
	if strings.Contains(up, "ALTER TABLE match_commentary\n  DROP COLUMN text") {
		t.Fatal("match_commentary.text must survive: E6 reads it")
	}

	// Retention (T7.15) deletes plays for seasons R2 already holds. It must run
	// as the owner, never as the ingester -- 0007 withheld DELETE deliberately,
	// because the cost of a buggy ingester erasing a stream ESPN will not serve
	// again is unbounded. See docs/backend/RETENTION.md.
	if strings.Contains(up, "GRANT DELETE ON match_play") {
		t.Fatal("match_play must not grant DELETE to the ingester; retention runs as owner")
	}

	down := readMigration(t, "0016_storage_reduction.down.sql")
	for _, required := range []string{
		// The labels come back from play_type, so play_type is dropped LAST.
		"SET play_type_text = t.label",
		"SET type_text = t.label",
		"CREATE INDEX match_commentary_order_idx",
		"CREATE INDEX match_play_order_idx",
		"CREATE INDEX match_play_located_idx",
		"CREATE INDEX match_play_archive_touch_idx",
		"DROP TABLE IF EXISTS play_type",
	} {
		if !strings.Contains(down, required) {
			t.Fatalf("0016_storage_reduction.down.sql missing %q", required)
		}
	}
	if strings.Index(down, "DROP TABLE IF EXISTS play_type") < strings.Index(down, "SET type_text = t.label") {
		t.Fatal("down migration drops play_type before reading it")
	}
}
```

- [ ] **Step 2: Run it**

```bash
cd backend && go test ./migrations/ -run TestStorageReduction -v
```

Expected: `PASS`. If a `strings.Contains` on a multi-line literal fails, your
whitespace in the `.sql` file differs from the literal — fix the **test literal**
to match the file, not the file to match the test. The point of these assertions
is the statement being combined, not its exact indentation.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/migrations_test.go
git commit -m "test: assert 0016's invariants, including the two it must never do

No VACUUM (golang-migrate runs in a transaction, so it would pass CI and
fail production) and no DELETE grant on match_play (0007 withheld it
deliberately; retention runs as owner).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Teach the play store to write the dimension instead of the label

**Files:**
- Modify: `backend/shared/store/plays.go`
- Test: `backend/shared/store/plays_integration_test.go`

**Interfaces:**
- New unexported const `playTypeUpsertSQL`.
- `playUpsertSQL` drops `type_text` and `text`: **29 → 27 placeholders**. Renumber
  every one; an off-by-one here surfaces as a type error at runtime, not at
  compile time.
- `Store.WritePlays` signature is unchanged. `model.Play.TypeText` is still read —
  it is what populates `play_type.label`.

- [ ] **Step 1: Write the failing test**

The existing test at `plays_integration_test.go:169-204`
(`TestWritePlaysCorrectionDoesNotEraseKnownIdentityOrGeometry`) already exercises
a corrected label; it should keep testing that, against the new location.
Replace its final block — from `var storedPlayer uuid.UUID` to the closing brace
of the function — with:

```go
	var storedPlayer uuid.UUID
	var x *float64
	if err := pool.QueryRow(ctx, `
SELECT player_id, start_x FROM match_play WHERE source_id='50929900'`).
		Scan(&storedPlayer, &x); err != nil {
		t.Fatal(err)
	}
	// start_x is real now, and pgx widens float4 to float64, so 77.2 arrives as
	// 77.19999694824219. The value round-trips exactly IN POSTGRES
	// (max(abs(start_x::real::numeric - start_x)) = 0.00 over every stored row);
	// it is the widening to float64 in Go that needs a tolerance. 1e-4 is four
	// orders of magnitude finer than the provider's two-decimal precision.
	if storedPlayer != playerID || x == nil || math.Abs(*x-77.2) > 1e-4 {
		t.Fatalf("corrected row player/x = %s/%v, want %s/~77.2", storedPlayer, x, playerID)
	}

	// The English label is a property of the TYPE, not of the play. 63 distinct
	// labels stored on 74,851 rows cost 756 kB to say 63 things, so they live in
	// play_type now -- and a corrected label must still land there.
	var label string
	if err := pool.QueryRow(ctx,
		`SELECT label FROM play_type WHERE key='shot-on-target'`).Scan(&label); err != nil {
		t.Fatal(err)
	}
	if label != "Shot Corrected" {
		t.Fatalf("play_type label = %q, want the corrected label", label)
	}
}
```

In the same file, fix the other exact float comparison. Replace, at
`TestWritePlaysStoresGeometry` (~line 146):

```go
	if x == nil || *x != 77.2 || y == nil || *y != 25 {
		t.Fatalf("coordinates = %v/%v, want 77.2/25", x, y)
	}
```

with:

```go
	if x == nil || math.Abs(*x-77.2) > 1e-4 || y == nil || math.Abs(*y-25) > 1e-4 {
		t.Fatalf("coordinates = %v/%v, want ~77.2/~25", x, y)
	}
```

and add `"math"` to that file's import block.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./shared/store/ -run TestWritePlays -race
```

Expected: FAIL, with

```
ERROR: column "type_text" of relation "match_play" does not exist (SQLSTATE 42703)
```

from `playUpsertSQL`, because Task 2 dropped the column and the SQL still names
it. The suite builds its schema by globbing and applying `migrations/*.up.sql`
(`identity_integration_test.go:60`), so 0016 is already in effect and `play_type`
already exists — the only failure is the stale `INSERT`.

If instead you see `dial tcp ... connection refused`, **Docker is not running** —
these are testcontainers tests. Start Docker and re-run.

- [ ] **Step 3: Add the dimension upsert**

In `backend/shared/store/plays.go`, add below `playUpsertSQL`:

```go
// playTypeUpsertSQL keeps the play-type dimension current.
//
// The WHERE clause is not a micro-optimisation. Without it every match would
// issue ~20 no-op UPDATEs against a 63-row table -- roughly 50,000 dead tuples a
// season on a table that should never exceed one page.
const playTypeUpsertSQL = `
INSERT INTO play_type (key, label) VALUES ($1,$2)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label
WHERE play_type.label IS DISTINCT FROM EXCLUDED.label`
```

- [ ] **Step 4: Write the dimension before the facts**

In `WritePlays`, immediately after `defer rollback(opCtx, tx)` and **before**
`batch := &pgx.Batch{}`, insert:

```go
	// The dimension goes first, in the same transaction as the facts: a play
	// whose type has no label is legible; a label with no play is harmless.
	// There is deliberately no foreign key -- ESPN adds play types without
	// notice, and a FK would turn an unknown type into an ingest failure rather
	// than into a stored row with an unfamiliar key.
	labels := make(map[string]string, 8)
	for _, play := range plays {
		if play.TypeKey != "" && play.TypeText != "" {
			labels[play.TypeKey] = play.TypeText
		}
	}
	if len(labels) > 0 {
		typeBatch := &pgx.Batch{}
		for key, label := range labels {
			typeBatch.Queue(playTypeUpsertSQL, key, label)
		}
		if err := tx.SendBatch(opCtx, typeBatch).Close(); err != nil {
			return 0, fmt.Errorf("upsert play types: %w", err)
		}
	}
```

- [ ] **Step 5: Drop the two columns from the upsert**

Still in `backend/shared/store/plays.go`, replace the `batch.Queue(...)` call —
which currently passes `play.TypeID, play.TypeKey, play.TypeText` and ends with
`play.Text` — with:

```go
		batch.Queue(playUpsertSQL,
			matchID, play.SourceID, play.Seq,
			play.TypeID, play.TypeKey,
			teamID, playerID,
			play.Period, play.ClockValue, play.ClockDisplay, play.Wallclock,
			play.HomeScore, play.AwayScore, play.ScoringPlay, play.ScoreValue,
			play.OwnGoal, play.PenaltyKick, play.YellowCard, play.RedCard,
			play.Substitution, play.Shootout,
			startX, startY, endX, endY, goalY, goalZ)
```

and replace the whole `playUpsertSQL` const with:

```go
const playUpsertSQL = `
INSERT INTO match_play (
	match_id, source_id, seq, type_id, type_key,
	team_id, player_id, period, clock_value, clock_display, wallclock,
	home_score, away_score, scoring_play, score_value,
	own_goal, penalty_kick, yellow_card, red_card, substitution, shootout,
	start_x, start_y, end_x, end_y, goal_y, goal_z)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27)
ON CONFLICT (match_id, source_id) DO UPDATE SET
	seq = EXCLUDED.seq,
	type_id = EXCLUDED.type_id, type_key = EXCLUDED.type_key,
	-- COALESCE on identity: a later poll that fails to resolve an athlete
	-- already resolved must not un-attribute the play.
	team_id   = COALESCE(EXCLUDED.team_id,   match_play.team_id),
	player_id = COALESCE(EXCLUDED.player_id, match_play.player_id),
	period = COALESCE(EXCLUDED.period, match_play.period),
	clock_value = COALESCE(EXCLUDED.clock_value, match_play.clock_value),
	clock_display = EXCLUDED.clock_display,
	wallclock = COALESCE(EXCLUDED.wallclock, match_play.wallclock),
	home_score = COALESCE(EXCLUDED.home_score, match_play.home_score),
	away_score = COALESCE(EXCLUDED.away_score, match_play.away_score),
	scoring_play = EXCLUDED.scoring_play,
	score_value = COALESCE(EXCLUDED.score_value, match_play.score_value),
	own_goal = EXCLUDED.own_goal, penalty_kick = EXCLUDED.penalty_kick,
	yellow_card = EXCLUDED.yellow_card, red_card = EXCLUDED.red_card,
	substitution = EXCLUDED.substitution, shootout = EXCLUDED.shootout,
	start_x = COALESCE(EXCLUDED.start_x, match_play.start_x),
	start_y = COALESCE(EXCLUDED.start_y, match_play.start_y),
	end_x   = COALESCE(EXCLUDED.end_x,   match_play.end_x),
	end_y   = COALESCE(EXCLUDED.end_y,   match_play.end_y),
	goal_y  = COALESCE(EXCLUDED.goal_y,  match_play.goal_y),
	goal_z  = COALESCE(EXCLUDED.goal_z,  match_play.goal_z)`
```

Count them: 27 columns, 27 placeholders, 27 arguments. `pgx` will not catch a
mismatch at compile time.

- [ ] **Step 6: Run the store suite**

```bash
cd backend && go test ./shared/store/ -race
```

Expected: PASS, all cases. If `TestWritePlaysCorrection…` reports
`play_type label = "Shot On Target"`, your dimension upsert is running before
`shot.TypeText` was changed — check that the `labels` map is built from `plays`,
the argument, and not from a stale slice.

If you see `ERROR: column "text" of relation "match_play" does not exist` from a
different test, another call site still writes it; `grep -rn "match_play" backend
--include="*.go"` and fix it.

- [ ] **Step 7: Commit**

```bash
git add backend/shared/store/plays.go backend/shared/store/plays_integration_test.go
git commit -m "feat: write the play-type dimension instead of a label per row

playUpsertSQL loses type_text and text (29 -> 27 params) and WritePlays
upserts play_type in the same transaction. No foreign key: ESPN adds play
types without notice and a FK would make an unknown type an ingest
failure rather than a stored row.

The geometry assertions gain a 1e-4 tolerance -- start_x is real now and
pgx widens float4 to float64, so 77.2 arrives as 77.19999694824219. The
value round-trips exactly in Postgres; only Go needs the tolerance.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Same change for commentary, and delete `Play.Text`

**Files:**
- Modify: `backend/shared/store/commentary.go`
- Modify: `backend/shared/model/plays.go`
- Modify: `backend/shared/espn/plays.go`
- Test: `backend/shared/store/commentary_integration_test.go`

**Interfaces:**
- `commentaryUpsertSQL`: **9 → 8 placeholders**.
- `model.Play` loses `Text string`. It keeps `TypeText` — that feeds
  `play_type.label`.
- `model.CommentaryLine` keeps **both** `PlayType` and `PlayTypeText`, for the
  same reason.

- [ ] **Step 1: Write the failing test**

Append to `backend/shared/store/commentary_integration_test.go`:

```go
// Commentary shares the play-type vocabulary with match_play -- 63 keys across
// both tables, zero conflicting labels -- so it writes the same dimension
// rather than repeating the English label on every line.
func TestWriteCommentaryPopulatesThePlayTypeDimension(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	// mustCommentaryMatch already calls mustSeedTwoTeams and mustSeedSeason --
	// see commentary_integration_test.go:25. Do not seed them again here.
	matchID := mustCommentaryMatch(t, store, pool)

	if _, err := store.WriteCommentary(ctx, matchID, []model.CommentaryLine{
		{Seq: 1, PlayType: "goal", PlayTypeText: "Goal", Text: "Goal!"},
		{Seq: 2, Text: "Lineups are announced."},
	}); err != nil {
		t.Fatal(err)
	}

	var label string
	if err := pool.QueryRow(ctx,
		`SELECT label FROM play_type WHERE key='goal'`).Scan(&label); err != nil {
		t.Fatal(err)
	}
	if label != "Goal" {
		t.Fatalf("play_type label = %q, want Goal", label)
	}

	// A line with no play object carries no type at all. It must not mint a
	// dimension row keyed on the empty string.
	var blanks int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM play_type WHERE key=''`).Scan(&blanks); err != nil {
		t.Fatal(err)
	}
	if blanks != 0 {
		t.Fatalf("play_type has %d empty-key rows, want 0", blanks)
	}
}
```

The helper is `mustCommentaryMatch(t *testing.T, store *Store, pool *pgxpool.Pool)
uuid.UUID` at `commentary_integration_test.go:25`. Reuse it; do not add a second
seeding helper.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./shared/store/ -run TestWriteCommentaryPopulates -race
```

Expected: FAIL — `no rows in result set` scanning `play_type WHERE key='goal'`,
because nothing writes the dimension yet.

- [ ] **Step 3: Implement**

In `backend/shared/store/commentary.go`, replace `commentaryUpsertSQL`:

```go
const commentaryUpsertSQL = `
INSERT INTO match_commentary (
    match_id, seq, period, clock_value, clock_display,
    play_type, wallclock, text)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (match_id, seq) DO UPDATE SET
    period         = EXCLUDED.period,
    clock_value    = EXCLUDED.clock_value,
    clock_display  = EXCLUDED.clock_display,
    play_type      = EXCLUDED.play_type,
    wallclock      = EXCLUDED.wallclock,
    text           = EXCLUDED.text`
```

In `WriteCommentary`, after `defer rollback(opCtx, tx)` and before
`maxSeq := lines[0].Seq`, insert:

```go
	// Same shared dimension match_play writes. 63 keys across both tables with
	// zero conflicting labels, so one table serves both.
	labels := make(map[string]string, 8)
	for _, line := range lines {
		if line.PlayType != "" && line.PlayTypeText != "" {
			labels[line.PlayType] = line.PlayTypeText
		}
	}
	if len(labels) > 0 {
		typeBatch := &pgx.Batch{}
		for key, label := range labels {
			typeBatch.Queue(playTypeUpsertSQL, key, label)
		}
		if err := tx.SendBatch(opCtx, typeBatch).Close(); err != nil {
			return 0, fmt.Errorf("upsert commentary play types: %w", err)
		}
	}
```

and drop `nullIfEmpty(line.PlayTypeText),` from the `batch.Queue(...)` argument
list, leaving:

```go
		batch.Queue(commentaryUpsertSQL,
			matchID, line.Seq, line.Period, line.ClockValue, line.ClockDisplay,
			nullIfEmpty(line.PlayType),
			line.Wallclock, line.Text)
```

- [ ] **Step 4: Delete the now-dead `Play.Text`**

In `backend/shared/model/plays.go`, delete the last field of `Play`:

```go
	Text string
```

and its preceding blank line. Then in `backend/shared/espn/plays.go`, delete line
171 from the `model.Play{...}` literal:

```go
			Text:         item.Text,
```

Leave `rawPlay.Text` in `shared/espn/plays.go:74` alone — it documents the
payload shape and costs nothing. `TypeText` stays in both files.

- [ ] **Step 5: Build, vet and run the whole backend suite**

```bash
cd backend && go build ./... && go vet ./... && go test -race ./...
```

Expected: build clean, vet silent, all packages PASS.

`go build` is the step that finds any remaining reader of `Play.Text` —
`play.Text undefined (type model.Play has no field or method Text)`. There should
be exactly zero; `grep -rn "play.Text\|\.Text," backend --include="*.go"` before
you start if you want to confirm. Note that `cmd/play-retention/main.go:103`
reads `play.TypeText`, which **still exists** — do not "fix" it.

- [ ] **Step 6: Commit**

```bash
git add backend/shared/store/commentary.go backend/shared/store/commentary_integration_test.go backend/shared/model/plays.go backend/shared/espn/plays.go
git commit -m "feat: share the play-type dimension with commentary, drop Play.Text

commentaryUpsertSQL loses play_type_text (9 -> 8 params). model.Play
loses Text, which nothing reads now that match_play.text is gone -- the
prose lives in match_commentary.text and, in full, in R2.

model.Play.TypeText and CommentaryLine.PlayTypeText both stay: they are
what populate play_type.label.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Apply to production and measure the result

**Files:** none — this task produces the numbers the PR body quotes.

> ⚠️ **Applying a migration to production Neon is the user's decision, not
> yours.** Step 1 is a question, and it is not optional. Steps 2–4 run only after
> the user says yes.

- [ ] **Step 1: Ask**

Report to the user, before running anything:

- what 0016 does, in one paragraph;
- that it takes an `ACCESS EXCLUSIVE` lock on `match_play` and
  `match_commentary` for the duration of two table rewrites — seconds at 18 MB
  and 7 MB, with `lock_timeout` set to 30s;
- that the ingester is **self-healing** across that window: a failed
  `WritePlays` leaves the match without its `match_play_archive` ledger row, so
  `retryMissingPlayStreams` picks it up on the next slow tick, and a failed
  `WriteCommentary` leaves the match unfinalized so the next cycle retries before
  freezing its detail. **The ingester does not need to be stopped.**
- that recovery from a `lock_timeout` abort is `migrate force 15` and retry —
  **never** `migrate force 16`, which would mark 0016 applied without having
  applied it and put the schema and the ledger permanently out of sync.

Wait for an explicit yes.

- [ ] **Step 2: Apply**

```bash
set -a; source ~/.scorearc-db.env; set +a
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
migrate -path migrations -database "$DIRECT_DSN" up
```

Expected: `16/u storage_reduction (…ms)`. Then confirm the ledger:

```bash
psql "$DIRECT_DSN" -X -c 'SELECT * FROM schema_migrations;'
```

Expected:

```
 version | dirty
---------+-------
      16 | f
```

If `dirty` is `t`, the migration aborted mid-way. Read the error, fix it,
`migrate force 15`, and retry.

- [ ] **Step 3: Measure the result**

```bash
psql "$DIRECT_DSN" -X -c "SELECT now()::timestamptz(0) AS measured_at,
    pg_size_pretty(pg_database_size(current_database())) AS db_total;" \
  -c "SELECT c.relname,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
        pg_size_pretty(pg_relation_size(c.oid))       AS heap,
        pg_size_pretty(pg_indexes_size(c.oid))        AS idx
      FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace
        AND c.relname IN ('match_play','match_commentary','play_type');" \
  -c "SELECT count(*) AS play_types FROM play_type;" \
  -c "SELECT attname, format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid='match_play'::regclass AND attname IN ('start_x','goal_z');"
```

Expected, against your Task 1 baseline:

- `db_total` **down by 13–15 MB**, allowing for whatever the ingester wrote in
  between. It should be roughly **55 MB** if your baseline was 68 MB.
- `match_play` total down ~30% (30 MB → ~20 MB at the measured row count).
- `match_commentary` total down ~23% (12 MB → ~9 MB).
- `play_type` present with **63 rows** (a few more if new types have appeared) and
  a total size of `16 kB` — one page plus its index.
- `start_x` and `goal_z` both report `real`.

Record the exact numbers. If `db_total` did **not** drop, the rewrites did not
happen — check that the `DROP COLUMN`s and `ALTER COLUMN … TYPE`s really are in
one statement per table (Finding 4), then re-read Task 2 Step 1.

- [ ] **Step 4: Verify the ingester still writes**

Watch one full ingest cycle and confirm the dimension is being maintained:

```bash
psql "$DIRECT_DSN" -X -c "SELECT kind, started_at, ok FROM ingest_run
  WHERE kind IN ('play_stream','play_stream_backlog')
  ORDER BY started_at DESC LIMIT 5;" \
  -c "SELECT count(*) AS types, max(label) FROM play_type;"
```

Expected: recent `play_stream` runs with `ok = true`, and `play_type` holding
its rows. A run with `ok = false` immediately after the migration is the
expected transient if a write collided with the lock — the next tick should be
green. Two consecutive failures is a real problem: read the ingester logs.

---

### Task 7: Write the retention policy

**Files:**
- Create: `docs/backend/RETENTION.md`
- Modify: `docs/backend/ARCHITECTURE.md`

**`backend/cmd/play-retention` is not a starting point for this.** Read it: it is
a **probe against the live ESPN API** that measures how long *ESPN* keeps the
touch tier, and it never opens a database connection. Nothing in it is reusable
here. That misconception is why this task starts by saying so out loud.

Column-level levers are now exhausted (Task 6 spent them). Season two is bounded
by **deletion**, and deletion is safe here for exactly one reason:
`match_play_archive` records, per match, the R2 object key and whether the touch
tier was still intact when it was captured. **A row whose match has no archive
ledger entry must never be deleted**, because nothing could rebuild it.

This task writes the policy and its guarded SQL. It does **not** run it — the
database is ~55 MB against a 10 GB tier and the first season is not over.

- [ ] **Step 1: Write the policy**

Create `docs/backend/RETENTION.md`:

````markdown
# Postgres retention policy

**Status:** written 2026-08-18, **not yet triggered**. Do not run the SQL below
until a trigger in §3 fires.

## 1. Why deletion is safe here and is not safe in general

R2 holds every byte ESPN ever sent for a match's play stream, gzipped and
immutable, and `match_play_archive` records the object key per match plus
`touch_tier` — whether the perishable pass/touch tier was still present when we
captured it. Postgres holds a **projection** of that stream: the ~200 analysable
events per match that a shot map, an xG model, a game log or a recap reads.

So deleting `match_play` rows for an old season deletes a *derived* artifact. A
re-process of the R2 object rebuilds it exactly. Deleting rows for a match with
**no** archive ledger entry deletes the only copy. That distinction is the whole
policy, and it is enforced as a `NOT EXISTS`-free `JOIN` in §4 rather than as a
comment.

## 2. What is retained, and for how long

| Table | Hot in Postgres | Older | Rebuildable from |
|---|---|---|---|
| `match_play` | current + previous season | delete | R2 (`match_play_archive.object_key`) |
| `match_commentary` | current + previous season | delete | R2 raw summary + ESPN re-fetch while the season is current |
| `match_play_archive` | **forever** | — | nothing — it *is* the ledger |
| `match`, `match_detail`, `match_event`, `appearance`, `standing*`, `player*` | **forever** | — | these are the history E7 exists to build |

Two seasons hot, because E7's history and trends compare a season against the one
before it. One season would make every year-on-year query a re-process.

`match_play_archive` is never pruned. It is a few hundred bytes per match and it
is the only thing that makes any of the above reversible.

## 3. Triggers — run the prune when any of these is true

- `pg_database_size` exceeds **400 MB**; or
- a third season opens for any competition (so a third season of plays exists); or
- Neon reports the plan's storage limit within 20%.

Check with:

```sql
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT season_id, count(DISTINCT m.id) AS matches, count(p.match_id) AS plays
FROM match m LEFT JOIN match_play p ON p.match_id = m.id
GROUP BY 1 ORDER BY 1;
```

## 4. The prune, and its guard

**Run as the database owner, from a psql session on `$DIRECT_DSN`. Never as
`scorearc_ingester`.**

`0007_play_stream.up.sql` deliberately withheld `DELETE` on `match_play` from the
ingester role — "A play retracted upstream is vanishingly rare, and the cost of
being wrong about that is a stream ESPN will not serve again." That reasoning is
unchanged, and this policy does **not** relax it. Retention is a deliberate
operator action, not something a running service can do by accident. The
invariant is asserted in `backend/migrations/migrations_test.go`
(`TestStorageReductionKeepsTheReprocessablePath`).

Always run the count first. It is the same predicate as the delete.

```sql
-- DRY RUN. Replace the season list with the seasons being retired.
SELECT count(*) AS rows_to_delete, count(DISTINCT m.id) AS matches
FROM match_play p
JOIN match m ON m.id = p.match_id
JOIN match_play_archive a ON a.match_id = m.id   -- THE GUARD
WHERE m.season_id IN ('2026-27', '2026', '2026-apertura');
```

The `JOIN match_play_archive` is the guard: an inner join deletes only matches R2
demonstrably holds. Never rewrite it as a `LEFT JOIN`, and never drop it "because
everything is archived by now" — the ledger exists precisely because that
assumption cannot be verified any other way.

Cross-check that the guard is excluding something, or nothing:

```sql
SELECT count(DISTINCT m.id) AS unarchived_matches_with_plays
FROM match_play p
JOIN match m ON m.id = p.match_id
LEFT JOIN match_play_archive a ON a.match_id = m.id
WHERE a.match_id IS NULL
  AND m.season_id IN ('2026-27', '2026', '2026-apertura');
```

If that is non-zero, **archive those matches before pruning anything** — run the
ingester's play-stream backlog, which is exactly what `retryMissingPlayStreams`
does, and re-check.

Then, in batches, so a single statement never holds a long transaction against a
live ingester:

```sql
DELETE FROM match_play p
USING match m, match_play_archive a
WHERE m.id = p.match_id
  AND a.match_id = m.id
  AND m.season_id IN ('2026-27', '2026', '2026-apertura')
  AND p.ctid = ANY (ARRAY(
    SELECT p2.ctid FROM match_play p2
    JOIN match m2 ON m2.id = p2.match_id
    JOIN match_play_archive a2 ON a2.match_id = m2.id
    WHERE m2.season_id IN ('2026-27', '2026', '2026-apertura')
    LIMIT 50000));
```

Repeat until it reports `DELETE 0`.

`DELETE` marks tuples dead; it does not return pages to the operating system.
After the last batch, and **outside** any transaction and any migration:

```sql
VACUUM (ANALYZE) match_play;
```

`VACUUM` (not `FULL`) makes the space reusable by the table, which is what you
want for a table that keeps growing. Use `VACUUM FULL` only if the goal is to
return the space to Neon's billed total, and only during a maintenance window —
it takes an `ACCESS EXCLUSIVE` lock and needs free space equal to the table.

## 5. Rebuilding a pruned season

`match_play_archive.object_key` points at the gzipped raw payload in the private
R2 bucket. A re-process reads it, runs `espn.Analysable`, and writes the rows
back through `Store.WritePlays` — the identical path the ingester uses, so a
rebuilt season is byte-equivalent to a live-ingested one.

`match_play_archive.touch_tier = false` means ESPN had already pruned the touch
tier when we captured it, so **no** re-process of that object will ever yield a
pass network. Recording that at capture time is what stops a future agent
concluding the parser is broken.
````

- [ ] **Step 2: Document the two tables in ARCHITECTURE.md**

`match_play` has **no** schema bullet in `docs/backend/ARCHITECTURE.md` at all —
only `match_commentary` does, at line 117. Add one immediately before that line:

```markdown
- **match_play**(PK (match_id→match, **source_id** = ESPN's own play id), seq, type_id, type_key→`play_type.key` (no FK), team_id→team NULL, player_id→player NULL, period, clock_value, clock_display, wallclock, home_score, away_score, scoring_play, score_value, own_goal, penalty_kick, yellow_card, red_card, substitution, shootout, start_x/start_y/end_x/end_y/goal_y/goal_z `real` NULL) — the **analysable tier** of ESPN's core-host play stream (T7.12): ~203 of the ~1,540 events a match returns. The remaining touch tier (pass, ball touch, tackle, take-on, aerial, clear, cross, dispossessed, interception, blocked pass, out) is archived to R2 in full and deliberately not rowed here. **This table is a projection, not a record** — R2 holds every byte, ledgered per match in `match_play_archive.object_key`, which is what makes both the 0016 column drops and the retention policy in `RETENTION.md` reversible. Keyed on ESPN's play id rather than an ordinal because a live match is re-fetched and an ordinal renumbers on any upstream insertion. Coordinates are `real` on a 0–100 scale and `(0,0)` from the provider is stored as `NULL` — ESPN uses 0 as its unset sentinel, and writing it would put every unlocated play on the corner flag. `clock_display` is **not** derivable from `clock_value`: the clock saturates at the end of a period, so `"45'+2'"` and `"45'+3'"` share `clock_value` 2700. There is no `text` column — 52% of it was generated boilerplate and 98–100% of every shot-family prose line is stored character-identical in `match_commentary.text`; E6 reads it there, per its spec.
- **play_type**(PK key, label) — the shared play-type vocabulary for `match_play.type_key` and `match_commentary.play_type`: 63 values across both tables with **zero conflicting labels**, so one dimension serves both. **No foreign key from either fact table**, because ESPN adds play types without notice and a FK would turn an unknown type into an ingest failure rather than a stored row with an unfamiliar key. The ingester upserts it inside the same transaction as the facts, and only when the label actually changed.
```

Then in the existing `match_commentary` bullet at line 117, remove
`play_type_text,` from the column list and append to the end of the bullet:

```
Since 0016 the English play-type label lives in `play_type` rather than on every line, and `period` is `smallint`. **`text` is now the only home of the match prose** — `match_play.text` was dropped as duplicated and derivable, so E6's body-part and assist-type extraction reads this column and nothing else.
```

- [ ] **Step 3: Verify the docs render and commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
npx markdownlint-cli2 docs/backend/RETENTION.md 2>/dev/null || echo "no markdownlint configured — skipping"
git add docs/backend/RETENTION.md docs/backend/ARCHITECTURE.md
git commit -m "docs: write the Postgres retention policy and document match_play

cmd/play-retention is a probe against ESPN's live API and never opens a
database connection -- it is not a Postgres retention tool and the policy
does not build on it.

Two seasons hot, older seasons deleted only where match_play_archive
proves R2 holds them, run as owner because 0007 withheld DELETE from the
ingester on purpose.

match_play had no schema bullet in ARCHITECTURE.md at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full gate and PR

- [ ] **Step 1: Backend gate**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./... && go test -race ./...
```

Expected: build clean, vet silent, every package `ok`. Docker must be running for
the testcontainers packages.

- [ ] **Step 2: Frontend gate**

`ci.yml` runs the whole frontend gate on every PR, including backend-only ones.
Kill any running dev server first — `next dev` and `next build` both write
`.next/` and the corrupted tree presents as an HTTP 500 that looks like your bug.

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
green, typecheck silent, lint clean, build succeeds.

- [ ] **Step 3: Re-run the migration round trip one last time**

The down file is only exercised by CI, which means a broken one is discovered by
a red build rather than by you. Run Task 2 Step 3 again against a fresh
throwaway container, now that the up file is final.

Expected: forward pass and reverse pass both complete with no error.

- [ ] **Step 4: Open the PR**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git push -u origin tweak/postgres-storage-reduction
gh pr create --title "tweak: cut Postgres storage 33% on the two tables that are 62% of it" --body "$(cat <<'EOF'
## What

Neon is the storage constraint; R2 is not. R2 holds the full raw play stream
(~106 KB gzipped per match, ~290 MB projected per season against a 10 GB tier)
and `match_play_archive` ledgers where. **Postgres holds a queryable projection
of that stream, not the record of it** — which is what makes dropping from it
safe here when it would be reckless anywhere else.

`match_play` + `match_commentary` were **42 MB of a 68 MB database (62%)**. This
cuts them by a third.

| Lever | Saving |
|---|---|
| Drop `match_play.text` | 4,430 kB |
| Drop `match_play_order_idx` | 4,480 kB |
| Drop `match_commentary_order_idx` — a **byte-for-byte duplicate of the primary key** | 2,448 kB |
| Drop `match_play_located_idx` | 944 kB |
| Move `type_text` to a 63-row `play_type` dimension | 756 kB |
| `numeric(5,2) → real` on the six coordinate columns | 420 kB |
| Move `play_type_text` to the same dimension | 369 kB |
| Drop `match_play_archive_touch_idx` — a btree on a boolean over 368 rows | 16 kB |
| **Total** | **~13.5 MB of 68 MB (20%)** |

Per season: **~373 MB → ~274 MB**, a 27% cut, with `match_play` down 36% per row
and `match_commentary` down 23%.

## Dropping `match_play.text` does not cost E6 anything

- **52% of the column is generated boilerplate** — `{player} ({team}) {type} at
  {clock}'`, 37,683 rows, reconstructible from four columns that all stay.
- Of the real Opta prose, **98–100% of every shot-family type is stored
  character-identical in `match_commentary.text`**, over the same 368 matches:
  shot-off-target 3,401/3,421 · shot-blocked 2,450/2,492 · shot-on-target
  2,133/2,144 · goal 778/778 · penalty scored 166/166.
- E6's own spec already reads commentary for body part and assist type, not the
  play stream: *"from commentary (T7.11): body part and assist type, matched to a
  shot by minute and shooter."*
- And R2 holds the lot regardless.

## Three candidates turned out to be wrong

- **`clock_display` is not derivable from `clock_value`.** The clock saturates at
  the end of a period: `"45'+1'"`, `"45'+2'"` and `"45'+3'"` all carry
  `clock_value` 2700. 9,767 `match_play` rows and 5,537 commentary rows depend on
  it. **Kept.**
- **Column compression settings are a no-op here.** Average tuple width is 240 B
  (`match_play`) and 162 B (`match_commentary`) against a ~2,000 B TOAST
  threshold, so no value in either table is ever compressed or out-of-lined. `SET
  COMPRESSION lz4` changes nothing. **Not added.**
- **`cmd/play-retention` is not a Postgres retention tool.** It probes the live
  ESPN API for how long *ESPN* keeps the touch tier and never opens a database
  connection.

## Why the drops and the type changes share one statement

`ALTER TABLE ... DROP COLUMN` reclaims **nothing** in Postgres — measured, 8512 kB
before and after. The space returns only on a rewrite, and `ALTER COLUMN ... TYPE`
is the only rewrite that runs inside `golang-migrate`'s transaction (`VACUUM
cannot run inside a transaction block`). One statement per table, one rewrite,
everything reclaimed — including index bloat, since a rewrite rebuilds every
index.

## On the unused indexes

Not "zero scans, therefore delete". Three of them were built for E10's `T10.8`
play-stream reads, which do not exist yet. The rule applied instead:

> Drop an index iff it has effectively no scans **and** either its leading column
> is `match_id` — the primary key already gives that locality over a 203-row
> partition, and 203 rows sort in memory faster than any index can be probed — or
> it exactly duplicates another index.

So `match_play_player_idx`, `match_play_type_idx` and `match_commentary_type_idx`
all **stay** despite zero or near-zero scans: their queries are cross-match and
would otherwise scan half a million rows by season's end, and `CREATE INDEX` on a
table that size later is an operation with a lock rather than a free choice. That
deliberately leaves ~2.3 MB of never-scanned index in place.

## Retention

`docs/backend/RETENTION.md`: two seasons hot, older seasons deleted **only** where
an inner join to `match_play_archive` proves R2 holds them, run as the owner
because `0007` withheld `DELETE` from the ingester on purpose and this does not
relax that. Written, not triggered — the database is ~55 MB.

## Migration

**0016**, against watermark 15. Up and down both present; the down restores
`type_text` and `play_type_text` **with their data** from `play_type` (dropped
last, for that reason) and restores `match_play.text` empty, since its content is
in R2 and in `match_commentary`.

## Testing

- `go build ./... && go vet ./... && go test -race ./...` all clean.
- Frontend gate green (`npm test`, `tsc --noEmit`, `lint`, `build`).
- Migration round trip verified against a throwaway Postgres 16: every `.up.sql`
  forward, every `.down.sql` in reverse.
- `migrations_test.go` asserts 0016 contains no `VACUUM`, no `DROP COLUMN
  clock_display`, and no `GRANT DELETE ON match_play`.

Plan: `docs/superpowers/plans/2026-08-18-postgres-storage-reduction.md`
EOF
)"
```

- [ ] **Step 5: Stop**

Do **not** merge. Merging is the user's decision — see `AGENTS.md`.

---

## Self-review notes

- **Every candidate from the brief is resolved, including the two that were
  wrong.** Unused indexes → Decision 2 (drop three, keep five, on a stated rule).
  `match_play.text` → Decision 1 (dropped, with the E6 analysis). `type_text` →
  Decision 3. `clock_display` → **rejected**, Finding 2. `numeric → real` →
  Decision 4. `match_commentary` vs `match_detail.commentary` → Finding 3 (a
  *subset*, not a duplicate; the relational table survives; removing the jsonb is
  a reader-API change worth ~1 MB and is not this plan's to make). Index overhead
  on `appearance` / `match_event` / `squad_membership` → Decision 2's table (all
  kept, 656 kB combined, cross-entity access paths). TOAST → Finding 3
  (compression settings are no-ops; the interesting corollary is documented and
  not acted on). Retention → Task 7.
- **Two candidates in the brief were wrong and one estimate was low.**
  `clock_display` is not derivable (230 kB saving does not exist);
  `cmd/play-retention` is not a Postgres tool. The unused-index total was 4.2 MB
  at the brief's measurement and is 7.7 MB at mine, because the duplicate
  `match_commentary_order_idx` was not on the list.
- **Ordering hazards, all handled.** `play_type` is created and backfilled
  **before** `type_text` is dropped (Task 2 Step 1). The down migration reads
  `play_type` **before** dropping it, and Task 3 asserts that ordering with an
  index comparison. Indexes are dropped **before** the rewrites, so the rewrite
  does not rebuild an index that is about to disappear.
- **Naming consistency.** `playTypeUpsertSQL` is defined in Task 4 Step 3 and
  reused by name in Task 5 Step 3 — it lives in `plays.go`, and `commentary.go`
  is the same package, so no export and no import is needed.
- **Known breakage, called out where it happens.** The exact float comparisons at
  `plays_integration_test.go:146` and `:201` fail after `numeric → real` because
  `pgx` widens `float4` to `float64`. Task 4 Steps 1 and 2 own it, and the
  distinction that matters is stated: the value round-trips exactly *in
  Postgres* (`max(abs(start_x::real::numeric - start_x)) = 0.00` over all 74,851
  rows); only Go needs the tolerance.
- **Placeholder counts are the one thing a compiler will not catch.**
  `playUpsertSQL` goes 29 → 27 and `commentaryUpsertSQL` 9 → 8; both replacement
  blocks are given in full rather than as diffs, for exactly that reason.
