# Finalization Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ScoreArc's **immutable-once-final** policy (C1) from a convention that
lives in the caller into an invariant the database enforces, for the six tables that
have no finalization guard today: `appearance`, `match_event`, `match_commentary`,
`match_play`, `match_official`, `match_odds`. `match` and `match_detail` already have
this. Nothing else in this plan changes: no ingester logic, no write cadence, no
write-skipping. Five sibling plans are changing *when* the ingester writes. This one
makes it impossible for any of them to get C1 wrong silently.

**Architecture:** The whole design turns on one fact you must internalise before you
write a line of SQL:

> **Three of the six tables are written AFTER `finalized_at` is set, on the normal
> path, by design.** `ingester/matches.go:293` finalizes the match; `:302` captures
> plays, `:311` captures officials, `:312` captures the settled odds — all against a
> match that is already finalized. A guard that says "reject any write when
> `match.finalized_at IS NOT NULL`" would break **production finalization itself**,
> not just a backfill.

So "final" is not one predicate. It is three, and each one is the marker that the
pipeline *already* treats as "this record is complete":

| Tables | Seal | Guarded operations | Why |
|---|---|---|---|
| `appearance`, `match_event`, `match_commentary` | `match.finalized_at IS NOT NULL` | INSERT, UPDATE, DELETE | Every write comes from the summary fetch, which runs **before** `FinalizeMatch` (`matches.go:252`, `:286` → `:293`). Nothing legitimately touches them afterwards. |
| `match_play` | a `match_play_archive` row exists for the match **and** the match row still exists | INSERT, UPDATE, DELETE | The archive ledger is *already* the completion marker: `capturePlays` writes it last, on purpose (`ingester/plays.go:137-140`), and `MatchesMissingPlays` selects exactly `a.match_id IS NULL`. Finalization is the wrong seal here — `capturePlays` runs after it, and `retryMissingPlayStreams` re-runs it on finalized matches for as many slow ticks as it takes. |
| `match_official`, `match_odds` | `match.finalized_at IS NOT NULL` | UPDATE, DELETE **only** | The single legitimate write is the INSERT at the finalization transition. Leaving INSERT open is what lets that write land; guarding UPDATE is what catches the re-poll, because the writers are `ON CONFLICT … DO UPDATE` and a second pass lands on the UPDATE branch. |

One mechanism (a `BEFORE … FOR EACH ROW` plpgsql trigger, matching the `match` /
`match_detail` precedent exactly), one function, six triggers, one SQLSTATE.

**Tech Stack:** Postgres 17.10 (Neon production) / Postgres 16 (CI service container
and testcontainers), golang-migrate, Go 1.26, pgx v5.10.0, testcontainers-go v0.44.0.

**Spec:** `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
— **§4.6 ("Make C1 an invariant, not a convention")** is the requirement; **§2's C1
definition** and the C1 row of §2's summary table are the scope.
**Epic:** E7 (`docs/PRODUCT_ROADMAP.md`). **New roadmap task: T7.16 · Finalization
invariants.** Five sibling plans are landing at once — if T7.16 is already taken when
you get there, take the next free number and do not renumber anyone else's.
**Branch:** `fix/finalization-invariants` off latest `origin/main`

---

## 🔴 The migration watermark is 15. Your migration number is 0021. Nothing else.

```
$ psql "$DIRECT_DSN" -X -c 'SELECT * FROM schema_migrations;'
 version | dirty
---------+-------
      15 | f
```

`golang-migrate` applies files **strictly above** the recorded version. A file
numbered at or below 15 is **silently skipped forever** on production while appearing
to work perfectly in CI — because CI applies every `*.up.sql` in lexical order against
an empty database (`ci.yml:45-46`) and therefore cannot see the difference. **This
project has shipped that defect twice.**

`0016`–`0020` are **reserved by sibling plans running right now**. Do not take one
even if it is still free when you look. Note also that `0008` and `0009` do not
exist — the directory jumps `0007 → 0010`, because those two were renumbered to
`0014`/`0015` after being merged below the watermark. Gaps are harmless:
`golang-migrate` requires monotonicity, not contiguity. Do not "fill" them, do not
renumber, do not reuse.

The only correct filenames are:

```
backend/migrations/0021_finalization_invariants.up.sql
backend/migrations/0021_finalization_invariants.down.sql
```

Both files are required. CI applies every `*.down.sql` in reverse order
(`ci.yml:53-54`: `find backend/migrations -name '*.down.sql' | sort -r`), so **0021's
down runs first**, while every table it names still exists. The rollback must
genuinely reverse — a `DROP TRIGGER IF EXISTS … ON <table>` still errors if the
*table* is gone, so the ordering is load-bearing and it is already correct as long as
your number is the highest.

---

## The write inventory that decides each guard

Read this table against the code before you accept any of it. Every line was verified
in the working tree at the time of writing.

| Table | Written by | Called from | Relative to `FinalizeMatch` |
|---|---|---|---|
| `appearance` | `Store.WriteParticipation` (upsert + tail `DELETE`) | `ingester/matches.go:252` | **before** |
| `match_event` | `Store.WriteParticipation` (upsert + tail `DELETE`) | `ingester/matches.go:252` | **before** |
| `match_commentary` | `Store.WriteCommentary` (upsert + tail `DELETE`) | `ingester/matches.go:286` | **before** |
| `match_play` | `Store.WritePlays` (upsert, **no** tail delete) | `capturePlays` ← `matches.go:302` and `retryMissingPlayStreams` ← `plays.go:192` | **after**, repeatedly, until the ledger lands |
| `match_official` | `Store.WriteMatchOfficials` (upsert, no tail delete) | `captureOfficials` ← `matches.go:311` | **after**, once |
| `match_odds` | `Store.WriteMatchOdds` (upsert) | `captureOdds(…, finalized=true)` ← `matches.go:312` | **after**, once |

Two further facts from that read that the guards depend on:

- **`captureOdds` writes `match_odds` only when `finalized` is true** (`ingester/odds.go:57`).
  The live path writes `odds_snapshot`, which is C4 and out of scope. So `match_odds`
  is genuinely write-once and a second UPDATE is always a bug.
- **`cmd/play-backfill` never calls `WritePlays`.** Its `backfillRepository` interface
  is exactly `MatchesMissingPlays` + `RecordPlayArchive` (`cmd/play-backfill/main.go`):
  it archives raw bytes to R2 and writes the ledger. `match_play_archive` is **not**
  one of the six tables and is deliberately left unguarded, so backfill is unaffected
  by construction. The thing that *does* write plays for already-finalized matches is
  the ingester's own `retryMissingPlayStreams`, and the ledger seal is precisely what
  keeps it working. See "Decision 3".

---

## Decision 1 — a trigger, not a CHECK constraint, not a RULE

**Trigger.** `BEFORE … FOR EACH ROW EXECUTE FUNCTION`, exactly the shape
`scorearc_protect_match_history` and `scorearc_protect_finalized_detail` already use
in `0001_init.up.sql:271` and `:287`. The spec asks for "the same
`finalized_at IS NOT NULL → reject` trigger `match_detail` already has", and following
the precedent is not deference — the alternatives are both actually wrong here:

- **A `CHECK` constraint cannot express any of these three seals.** A CHECK expression
  may only reference columns of the row being checked; it may not run a subquery. Every
  seal here is a fact about *another table* (`match.finalized_at`, or the presence of a
  `match_play_archive` row). The usual workaround — an `IMMUTABLE`-lying wrapper
  function around a query — is a documented foot-gun: it is evaluated inconsistently,
  is not re-checked when the referenced row changes, and survives `pg_dump`/restore in
  a state the planner is entitled to disbelieve. It also cannot see `OLD`, so the
  curation carve-out (Decision 2) is inexpressible.
- **A `RULE` is the wrong tool and is discouraged for exactly this.** Rules rewrite the
  query tree before execution; a rule that suppresses a write makes the statement
  report success having done nothing, which is the *opposite* of the requirement in
  "Decision 5" (a rejected write must be loud). Rules also interact badly with
  `ON CONFLICT`, which every writer in scope uses.

**`BEFORE`, not `AFTER`.** A `BEFORE` trigger rejects before the tuple is written and
before any index is touched; an `AFTER` trigger pays the full write cost and then
aborts. Both existing guards are `BEFORE`.

**Not `DEFERRABLE` / not a constraint trigger.** Deferring to commit would mean the
ingester learns about the rejection at `tx.Commit`, detached from the statement that
caused it, and would lose the per-row context (`"play 412 (401877043-217)"`) that every
writer's error wrapping already provides.

---

## Decision 2 — the curation carve-out, which is the subtlest part of this task

`0001_init.up.sql:218-265` permits **identity repointing on a finalized match**: a
provisional team id (`prov-espn-9999`) is a placeholder *we* minted, and folding it into
its curated row corrects a pointer to the same real-world club — it does not rewrite
history. Blocking it "would make routine curation fail against any team that has
already played a finished match, which is the normal lifecycle, not an exception."

**That carve-out is not theoretical for the six tables. Curation already repoints one
of them.** `shared/store/seed.go:308`:

```go
`UPDATE match_play SET team_id=$2 WHERE team_id=$1`,
```

That statement runs inside `promoteProvisionalTeam`, on finalized *and* already-ledgered
matches. A naive `match_play` guard breaks team curation on day one.

So the new guard reproduces 0001's structure exactly, generalised:

1. Compare the whole row with the identity columns **projected out**
   (`to_jsonb(NEW) - 'team_id' - 'player_id'`). If anything else differs → reject. This
   is what stops a legal repoint smuggling a fact rewrite alongside it — the exact hole
   `TestFinalizedMatchStillRefusesResultRewrites` was written to close for `match`.
2. Then narrow the carve-out: a changed `team_id` is accepted **only when the id being
   replaced belongs to a provisional team**. Merging two curated teams stays blocked.
   `promoteProvisionalTeam` runs its `UPDATE match_play` *before*
   `DELETE FROM team WHERE id=$1` (`seed.go:308` then `:321`), so the provisional row is
   still present and still flagged when the guard evaluates it.
3. A changed `player_id` is **always** rejected. `player` has no `provisional` column,
   so there is no equivalent "this id was a placeholder we minted" test to make, and
   inventing one here would be guessing at a design
   (`docs/superpowers/specs/2026-08-12-player-identity-design.md`) that has not landed.
   Task 6 asserts this behaviour deliberately, so that when player curation is built it
   trips over an explicit test rather than a silent hole.

**Do the comparison in jsonb, not with `NEW.team_id`.** One function serves six tables
and three of them have no `team_id` column at all. `NEW.team_id` on a
`match_commentary` row raises `record "new" has no field "team_id"` at execution time;
`to_jsonb(NEW)->>'team_id'` is simply `NULL`, and `NULL IS DISTINCT FROM NULL` is false,
so the branch is skipped. This is why the guard is written the way it is; do not
"simplify" it into field references.

**On `updated_at`-style columns.** 0001 projects `match.updated_at` out of its
comparison because it "carries no history of its own". Do **not** do the same for
`match_odds.observed_at`. That column records *when the line was observed*, and the
upsert sets `observed_at = now()`; a changed `observed_at` therefore means the row was
re-written, which is precisely the event this guard exists to refuse. None of the other
five tables has a bookkeeping timestamp.

**On the `kickoff_date` trap.** 0001's comment (lines 220-227) warns that a `STORED
GENERATED` column is `NULL` in `NEW` inside a `BEFORE UPDATE` trigger, so a bare
`NEW IS DISTINCT FROM OLD` would reject *every* update instead of every *changing*
update. **None of the six tables has a generated column** — verified against `0003`,
`0006`, `0007`, `0013`, `0014`, `0015`. The trap therefore does not bite today, and the
migration carries the warning in a comment so that the first person to add a generated
column to one of these tables projects it out rather than discovering this in
production.

---

## Decision 3 — `play-backfill` and the play backlog: the ledger is the seal

This is the single most likely way this plan breaks production, so it gets its own
section.

`match_play` is written **after** finalization, and re-written on subsequent slow ticks
until it succeeds. `capturePlays` (`ingester/plays.go`) does, in order: fetch from the
core API → put the raw bytes in R2 → resolve athletes → `WritePlays` → **`RecordPlayArchive`
last**, with this comment at `:137`:

> The ledger is the retry-completion marker, so it is written only after both
> irreversible bytes and rebuildable rows are durable. If row writing fails, the
> missing ledger keeps this match in the slow-tick backlog.

And `MatchesMissingPlays` (`shared/store/plays.go:294-301`) selects
`m.state='finished' AND a.match_id IS NULL`.

**The completion marker already exists, the pipeline already trusts it, and it is not
`finalized_at`.** So the guard uses it:

```
sealed  ⟺  EXISTS (SELECT 1 FROM match_play_archive a JOIN match m ON m.id = a.match_id
                   WHERE a.match_id = <the row's match_id>)
```

What this buys, concretely:

- The finalization-time `capturePlays` at `matches.go:302` writes freely — no ledger
  row exists yet.
- A retry after an R2 outage (`archived == false` → no ledger) re-issues the same
  `ON CONFLICT … DO UPDATE` batch and is allowed, for as many ticks as it takes.
- The moment the ledger lands, the stream is sealed. A second `capturePlays` on a
  ledgered match — an operator `-once` run, a mis-wired write-skipping branch, a new
  caller — raises instead of quietly rewriting an archived stream.
- **`cmd/play-backfill` is untouched**: it only ever calls `MatchesMissingPlays` and
  `RecordPlayArchive`, and `match_play_archive` is deliberately not guarded (backfill
  re-records the ledger for matches whose rows landed but whose ledger write failed,
  and that must keep working).

The `JOIN match` in the seal is not decoration. `match_play` and `match_play_archive`
are **both** `ON DELETE CASCADE` children of `match`, and Postgres does not define which
child's cascade fires first. Without the join, deleting a match would succeed or fail
depending on cascade order. With it, a vanished match row means an unsealed record and
the cascade always passes. See Decision 5.

---

## Decision 4 — the `ON CONFLICT DO UPDATE` trap

Every writer in scope is `INSERT … ON CONFLICT … DO UPDATE`. Postgres fires **row-level
`BEFORE INSERT` triggers for the proposed row before conflict detection**, and then,
if a conflict occurs, **row-level `BEFORE UPDATE` triggers on the existing row**. Both
fire. This changes two things:

1. **You cannot guard `INSERT` on `match_official` or `match_odds`.** Their one
   legitimate write is an INSERT against an already-finalized match. A `BEFORE INSERT`
   guard would reject it and break finalization. Their triggers are
   `BEFORE UPDATE OR DELETE` only.
2. **That is not a hole**, because a re-poll of a finalized match writes the *same*
   crew and the *same* settled lines, so every statement lands on the conflict branch
   and every one is refused — the whole batch aborts and the bug surfaces. The only
   thing an unguarded INSERT lets through is an *additive* row (a crew member the first
   capture did not have), which `0014_match_officials.up.sql` already declares
   intentional: "No DELETE: removing a crew entry must be an explicit future retention
   rule." Adding an appointment is not rewriting one.

For `appearance`, `match_event`, `match_commentary` and `match_play` the INSERT guard
**is** wired, and this Postgres behaviour is what makes it effective: a re-poll's
upsert is rejected on the INSERT trigger before conflict detection even runs.

---

## Decision 5 — cascade deletes must still work, and the phrasing that makes that free

All six tables are `ON DELETE CASCADE` children of `match`. `DELETE FROM match` issues
child DELETEs from an RI trigger that runs *after* the parent row is gone. Phrase the
seal as

```sql
EXISTS (SELECT 1 FROM match WHERE id = target AND finalized_at IS NOT NULL)
```

and not as

```sql
NOT EXISTS (SELECT 1 FROM match WHERE id = target AND finalized_at IS NULL)
```

The two are equivalent while the match exists and opposite when it does not. The first
form returns *unsealed* for a vanished match, so the cascade passes; the second would
make a finalized match permanently undeletable. `scorearc_protect_finalized_detail`
already uses the first form, and `store_test.go:263` already asserts that
`DELETE FROM match` cascades. Task 6 adds the same assertion for all six tables.

**Two consequences you must accept and document, not work around:**

- `appearance.player_id` is `ON DELETE CASCADE` and `match_event.player_id` /
  `match_play.player_id` are `ON DELETE SET NULL`. Deleting a **player** who appeared in
  a sealed match is therefore refused. That is a correct C1 statement — you cannot erase
  who did what in a finished match — and nothing can do it today anyway: `0001` grants
  `DELETE` on `standing`, `top_scorer`, `ingest_run` and `team`, and on nothing else.
  An operator correction goes through the escape hatch.
- The guard function is `SECURITY INVOKER`. It reads `match`, `team` and
  `match_play_archive`, all of which `scorearc_ingester` has `SELECT` on. If a future
  migration revoked one of those, the guard would raise `42501` and the write would
  fail — **closed**, which is the right direction for a safety guard.

---

## Decision 6 — the error surface: SQLSTATE `SA001`

The requirement is that "a rejected write must be distinguishable from a connection
failure so the ingester can log it as a bug rather than retry forever."

**How the existing guards are detected in `shared/store` today:** they mostly are not,
because both are backstops behind a Go-side pre-check.

- `UpsertMatch` puts the guard in the statement's `WHERE` clause and treats zero rows
  as success (`matches.go:106-130`), distinguishing it from a missing row via
  `ErrMatchMissing`.
- `UpsertMatchDetail` and `FinalizeMatch` `SELECT finalized_at … FOR UPDATE` first and
  return `ErrMatchFinalized` (`matches.go:185`, `:276`). The trigger only fires if that
  check is bypassed, and its rejection surfaces as a raw pgx error with the default
  `P0001` (`raise_exception`) — indistinguishable from any other `RAISE`.

The six new guards have **no** Go-side pre-check, so their rejection is the only signal.
Give it a code:

```sql
RAISE EXCEPTION '…' USING ERRCODE = 'SA001', HINT = '…';
```

`SA001` is in a **user-definable class** — the SQL standard reserves classes beginning
with digits `0`–`4` and letters `A`–`H` for itself, and Postgres uses `P0`, `XX`, `HV`,
`F0`, `72` and the numeric classes. Nothing Postgres generates can ever collide with a
class starting `S`. Compare `23505` (`uniqueViolation`), which `shared/store/identity.go:37`
already keys on — this is the same technique, with a code we own.

Go side, mirroring `isUniqueViolation` but exported:

```go
func IsImmutableViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == finalizedImmutable
}
```

**No writer needs to change.** Every error path in `participation.go`, `commentary.go`,
`plays.go`, `officials.go` and `odds.go` already wraps with `%w`
(`fmt.Errorf("upsert appearance: %w", err)`, `fmt.Errorf("play %d (%s): %w", …)`,
`fmt.Errorf("commit commentary: %w", err)`, …), so `errors.As` reaches the
`*pgconn.PgError` through the whole chain untouched. Task 5's test proves that against
the real writers rather than assuming it.

A connection failure carries no `*pgconn.PgError` at all (it surfaces as a
`*pgconn.ConnectError` / `*net.OpError`), and a server-side connection error carries
class `08`. Both return `false`. Task 5 asserts both.

The existing `scorearc_protect_match_history` / `scorearc_protect_finalized_detail`
are **deliberately not retrofitted** with `SA001`. Copying a 70-line function body into
0021 and its rollback, to add a five-character annotation to two guards that are already
backstopped by `ErrMatchFinalized` and a `WHERE` clause, buys no behaviour and creates a
real drift hazard the moment someone edits 0001. The migration records that they should
adopt `SA001` the next time they are edited for some other reason.

---

## Decision 7 — the operator escape hatch

§4.6 asks for "a session GUC, or simply an owner-only path — the ingester role is
least-privilege already." Take **both**, because the GUC alone is not a privilege: any
role may `SET` a custom GUC, including `scorearc_ingester`, so a GUC-only hatch is a
switch the buggy writer can flip on itself.

```sql
scorearc_final_writes_allowed(target) ⟺
    current_setting('scorearc.allow_final_writes', true) = 'on'
    AND has_table_privilege(current_user, target, 'TRUNCATE')
```

`TRUNCATE` is the probe because **no migration has ever granted it to
`scorearc_ingester`** — `0001` grants `SELECT, INSERT, UPDATE` broadly and `DELETE` on a
named four; `0003`, `0007`, `0011`–`0015` each grant `SELECT, INSERT, UPDATE` and
sometimes `DELETE`. `TRUNCATE` appears nowhere. The schema owner has it implicitly. So
the hatch requires **an explicit statement of intent AND a session that is not the
ingester**, and it is testable in both directions (Task 6, Step 5).

The GUC check comes first so the common path costs one hash lookup and never touches
the catalog.

---

## Cost on the hot path

This fires per row on `appearance`, `match_event`, `match_commentary` and `match_play`,
which is the write-heaviest path in the system. Reason about it before measuring it,
then measure it.

**Per-row work on the unsealed (normal) path:** one plpgsql function invocation, one
field read, and one `EXISTS` against `match_pkey` — or two primary-key probes for
`match_play`. `match` holds 2,578 rows; its primary key is a handful of pages and both
it and the heap are permanently in `shared_buffers`. `to_jsonb(NEW)` — the expensive
part of the function — is **only** reached once the seal has already tested true, which
on the hot path never happens.

**Against the heaviest real burst measured on this system.** Spec §0's 271-second
window, taken while the finalization backlog was draining, recorded
`match_play` +2,162, `match_commentary` +1,308, `appearance` +438, `match_event` +273 —
**4,181 guarded rows**. At a deliberately pessimistic 20 µs per row that is **84 ms**,
spread across 271 seconds of ingest.

**Against the projected live match.** Spec §3.5 projects ~47,000 statements per live
match across these tables; §4.4 removes ~35,000 of them. At the same 20 µs the guard
costs **~0.9 s across a two-hour match** before §4.4, ~0.24 s after.

**Against what the same statement already costs.** Every one of those statements is a
separate round trip from Fly (iad) to Neon, at roughly 1 ms. The guard is on the order
of **half a percent** of the write it protects, and it removes an entire class of silent
data corruption. There is no version of this trade that is close.

**A statement-level trigger with a transition table would not help.** `WriteCommentary`,
`WritePlays`, `WriteMatchOfficials` and `WriteMatchOdds` all use `pgx.Batch`, which sends
one statement per row; `WriteParticipation` loops `tx.Exec` per row. A statement-level
trigger would fire once per statement over a one-row transition table — strictly more
setup for the same number of seal evaluations.

**Task 8 measures the real number** on this exact schema, in-database, isolated from
round-trip cost, and fails the build if it exceeds 25 µs per row.

---

## Global Constraints

- **The migration is `0021`. The watermark is 15. `0016`–`0020` are reserved.** Re-read
  the red box above.
- Both `0021_finalization_invariants.up.sql` and `0021_finalization_invariants.down.sql`
  must exist and apply cleanly to an **empty** database (`ci.yml:45-46` forward,
  `:53-54` in reverse). The down must genuinely reverse: after it runs, `pg_trigger` and
  `pg_proc` hold nothing this migration created.
- **Scope is the schema invariants only.** Do **not** touch
  `backend/ingester/**`, `backend/cmd/**`, or the bodies of the five writers in
  `shared/store` (`participation.go`, `commentary.go`, `plays.go`, `officials.go`,
  `odds.go`). Sibling agents own the ingester's write-skipping paths; a conflict there
  is a merge problem for a human.
- Schema guards cannot be unit-tested meaningfully. Every behavioural assertion in this
  plan runs against **real Postgres via testcontainers** (Docker must be running).
- Backend gate, all three, from `backend/`:
  `go build ./... && go vet ./... && go test -race ./...`
- Frontend gate, unchanged and still required by `ci.yml`: `npm test`,
  `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Never print a DSN or a credential into a commit, a log or a PR body.
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.
- **Never push to `main`.** Feature branch, PR, and the merge is the user's call.
- **Applying the migration to production Neon is the user's call**, not yours. Task 9
  stops and asks.

---

## File Structure

**New:**
- `backend/migrations/0021_finalization_invariants.up.sql`
- `backend/migrations/0021_finalization_invariants.down.sql`
- `backend/shared/store/finalization_integration_test.go` — every behavioural
  assertion, against real Postgres.

**Modified:**
- `backend/migrations/migrations_test.go` — text assertions for 0021 up and down.
- `backend/shared/store/store.go` — `finalizedImmutable` const + exported
  `IsImmutableViolation`.
- `docs/backend/ARCHITECTURE.md` — §3 gains the C1 invariant and the escape hatch.
- `docs/PRODUCT_ROADMAP.md` — T7.16 under E7.

**Deliberately NOT modified** — checked, and the reason for each:
- `backend/ingester/**` — sibling agents own it, and nothing there needs to change:
  every legitimate write already lands on the allowed side of every seal.
- `backend/cmd/play-backfill/main.go` — writes `match_play_archive` only
  (`backfillRepository` is `MatchesMissingPlays` + `RecordPlayArchive`); that table is
  unguarded by design.
- `backend/cmd/play-retention/main.go` — reads the live ESPN API, never the database.
- `backend/shared/store/{participation,commentary,plays,officials,odds}.go` — every
  error path already wraps with `%w`, so `IsImmutableViolation` reaches the `PgError`
  with no change. Task 5 proves it.
- `backend/reader/**` — the reader connects as `scorearc_reader` and holds `SELECT`
  only.
- `src/**` — no frontend surface reads these tables yet.

---

## Implementation record

Executed on `mcasillas17-feat/finalization-invariants` with migration **0021**.
The TDD checklist below was followed in order. Two independent review rounds
were run; both required reviewers reported **NO BLOCKING FINDINGS** in round 2.

The implementation corrected these plan defects without changing the assigned
migration number or expanding the code scope:

1. **The Task 2 trigger-count query has the wrong expected output.**
   `LIKE 'protect_final_%'` matches seven triggers because it also includes the
   pre-existing `protect_finalized_detail`. Verification instead asserted the
   six migration-owned trigger names exactly and separately proved
   `protect_finalized_detail` was unchanged.
2. **The generated-column grep has more than the stated one hit.** Migration
   `0004` also contains generated-column SQL. None of the six C1 tables has a
   generated column, which is the invariant this check was meant to establish.
3. **Task 6's staged source did not compile before Task 8.** The quoted fixture
   imports `time` before the first use appears. The import was introduced with
   the Task 8 measurement instead.
4. **Task 7's full curation fixture contradicted a known schema gap.** After
   adding the omitted `team_external_ref` setup, full promotion failed exactly
   at the final `team` delete with FK SQLSTATE `23503`: the pre-existing
   `promoteProvisionalTeam` path does not repoint `appearance.team_id` or
   `match_event.team_id`. The test was narrowed to the migration-owned
   requirement: a finalized, ledgered `match_play` may repoint only a
   provisional `team_id`, preserving `type_key`. The broader promotion gap is
   explicitly **OUT OF SCOPE** for this slice.
5. **Migration 0016 invalidated the claim that every finalized odds update is a
   bug.** Its durable completion backlog can retry after the odds row commits
   but before its ledger does. Migration 0021 therefore treats an update whose
   only difference is `observed_at` as an idempotent retry, returns `OLD`, and
   preserves the original observation time. Changed facts, provider metadata,
   enrichment, and deletes still raise `SA001`.
6. **The one-pair cost assertion was sensitive to runner scheduling.** Two CI
   runs of the same commit finished at the same time: one passed, while the
   other measured 32.409 µs per row because its single guarded sample stalled.
   The 25 µs budget is unchanged. The test now takes the median of three
   interleaved guarded/bare pairs, truncating between samples so table growth
   cannot favor either side.

The final post-CI-correction hot-path measurement was **5.633 µs per guarded
row** over three 50,000-row pairs (guarded: 585/617/581 ms; unguarded:
306/317/299 ms), below the unchanged 25 µs budget.

Shared architecture, roadmap, and backend handoff documentation is isolated in
[PR #73](https://github.com/mcasillas17/ScoreArc/pull/73), based directly on
`main`.

The implementation is [PR #76](https://github.com/mcasillas17/ScoreArc/pull/76).

---

### Task 1: Confirm the watermark and re-verify the write inventory

**Files:** none — this task produces evidence, not code.

- [x] **Step 1: Confirm the watermark yourself**

```bash
set -a; source ~/.scorearc-db.env; set +a
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
psql "$DIRECT_DSN" -X -c 'SELECT * FROM schema_migrations;'
```

Expected:

```
 version | dirty
---------+-------
      15 | f
```

If `version` is **not** 15, **stop and ask the user** — a sibling plan landed, and your
number may no longer be free. If `dirty` is `t`, the last migration failed halfway and
must be resolved (`migrate force <n>`) before anything else happens.

- [x] **Step 2: Re-verify that three of the six tables are written after finalization**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
sed -n '292,313p' ingester/matches.go
```

Expected: `FinalizeMatch` at line 293, then inside `if didFinalize`, `capturePlays`
at 302, `captureOfficials` at 311, `captureOdds(…, true)` at 312. **If this ordering has
changed, stop and re-derive Decision 2's table before writing any SQL** — the whole
design rests on it.

- [x] **Step 3: Re-verify that curation repoints `match_play`**

```bash
grep -n "UPDATE match_play\|UPDATE match SET home_team_id\|DELETE FROM team WHERE id" shared/store/seed.go
```

Expected:

```
301:	`UPDATE match SET home_team_id=$2, updated_at=now() WHERE home_team_id=$1`,
308:	`UPDATE match_play SET team_id=$2 WHERE team_id=$1`,
321:	if _, err := tx.Exec(ctx, `DELETE FROM team WHERE id=$1`, provisionalID); err != nil {
```

The `UPDATE match_play` at 308 running **before** the `DELETE FROM team` at 321 is what
makes the provisional carve-out evaluable. If a sibling plan has reordered these, the
carve-out must be re-derived.

- [x] **Step 4: Re-verify that `play-backfill` does not write plays**

```bash
grep -n "backfillRepository\|WritePlays\|RecordPlayArchive" cmd/play-backfill/main.go
```

Expected: a `backfillRepository` interface containing exactly `MatchesMissingPlays` and
`RecordPlayArchive`, and **no** `WritePlays` anywhere in the file.

- [x] **Step 5: Confirm no generated column exists on any of the six tables**

```bash
grep -n "GENERATED" migrations/*.up.sql
```

Expected: exactly one hit, `0001_init.up.sql:61` (`kickoff_date`, on `match`). If any of
the six tables has gained one, project it out of the comparison in Task 2 and say so in
the comment.

- [x] **Step 6: Branch**

```bash
git fetch origin && git checkout -b fix/finalization-invariants origin/main
```

---

### Task 2: Write migration 0021 (up)

**Files:**
- Create: `backend/migrations/0021_finalization_invariants.up.sql`

**Interfaces:**
- `scorearc_final_writes_allowed(regclass) → boolean` — the operator escape hatch.
- `scorearc_protect_final_records() → trigger` — one function, seal chosen by
  `TG_ARGV[0] ∈ {'match','archive'}`.
- Six triggers: `protect_final_appearance`, `protect_final_match_event`,
  `protect_final_match_commentary`, `protect_final_match_play`,
  `protect_final_match_official`, `protect_final_match_odds`.
- New SQLSTATE `SA001`.

- [x] **Step 1: Write the up migration**

Create `backend/migrations/0021_finalization_invariants.up.sql`:

```sql
-- C1 -- immutable once final -- becomes an invariant instead of a convention.
--
-- Six tables are immutable-once-final in policy and unguarded in the schema:
-- appearance, match_event, match_commentary, match_play, match_official and
-- match_odds. Today they are protected only by the accident that nothing
-- re-polls a finalized match. `match` and `match_detail` have had real guards
-- since 0001; this extends the same mechanism to the other six.
--
-- Spec: docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
-- §4.6 ("Make C1 an invariant, not a convention") and §2's C1 definition.
--
-- READ THIS BEFORE CHANGING ANY PREDICATE BELOW.
--
-- "FINAL" IS NOT ONE THING. Three of the six tables are written AFTER
-- match.finalized_at is set, on the normal path, by design:
--
--     ingester/matches.go:293   FinalizeMatch          <- finalized_at = now()
--     ingester/matches.go:302   capturePlays           -> match_play
--     ingester/matches.go:311   captureOfficials       -> match_official
--     ingester/matches.go:312   captureOdds(final)     -> match_odds
--
-- So a guard reading "reject when finalized_at IS NOT NULL" on all six would
-- break production finalization itself, not merely a backfill. Each table is
-- sealed by the marker the pipeline ALREADY treats as completion:
--
--   appearance          match.finalized_at   INSERT/UPDATE/DELETE
--   match_event         match.finalized_at   INSERT/UPDATE/DELETE
--   match_commentary    match.finalized_at   INSERT/UPDATE/DELETE
--   match_play          match_play_archive   INSERT/UPDATE/DELETE
--   match_official      match.finalized_at   UPDATE/DELETE only
--   match_odds          match.finalized_at   UPDATE/DELETE only
--
-- WHY match_play IS SEALED BY THE ARCHIVE LEDGER AND NOT BY FINALIZATION.
-- capturePlays writes match_play_archive LAST, deliberately (plays.go:137):
-- the ledger is the retry-completion marker, and MatchesMissingPlays selects
-- exactly `a.match_id IS NULL`. retryMissingPlayStreams therefore re-runs
-- WritePlays against ALREADY FINALIZED matches, on every slow tick, until the
-- ledger lands -- which is the whole point of that backlog. Sealing on
-- finalization would break it on the first R2 outage. Sealing on the ledger
-- makes the guard agree with the design that already exists.
--
-- cmd/play-backfill is unaffected either way: it writes the R2 object and the
-- LEDGER, never match_play (its backfillRepository is MatchesMissingPlays +
-- RecordPlayArchive). match_play_archive is deliberately NOT guarded, because
-- re-recording a ledger for a match whose rows landed but whose ledger write
-- failed is exactly what that command is for.
--
-- WHY match_official AND match_odds GUARD UPDATE BUT NOT INSERT.
-- Postgres fires row-level BEFORE INSERT triggers for the proposed row BEFORE
-- conflict detection, and then BEFORE UPDATE triggers if a conflict occurs. Both
-- writers are INSERT ... ON CONFLICT DO UPDATE, and their single legitimate
-- write is an INSERT against an already-finalized match. Guarding INSERT would
-- reject it. Guarding UPDATE still catches every re-poll, because a re-poll
-- writes the same crew and the same settled lines and therefore lands on the
-- conflict branch. What stays possible is an ADDITIVE row -- a crew member the
-- first capture lacked -- which 0014 already declares intentional ("No DELETE:
-- removing a crew entry must be an explicit future retention rule"). Adding an
-- appointment is not rewriting one.
--
-- NOT A CHECK CONSTRAINT: a CHECK expression may not run a subquery and may not
-- see OLD, so it can express neither seal and not the curation carve-out below.
-- NOT A RULE: a rule that suppresses a write reports success having done
-- nothing, which is the opposite of the requirement.

-- Fail fast rather than queue behind the ingester's 20-second write cycle.
-- CREATE TRIGGER takes ACCESS EXCLUSIVE; it is metadata-only and instant, but it
-- still has to get the lock. If this fires, the transaction aborts,
-- golang-migrate marks version 21 dirty, and recovery is `migrate force 20`
-- followed by a retry -- NOT `migrate force 21`, which would skip this migration
-- permanently. (Under `psql -f`, which is what CI uses, SET LOCAL outside a
-- transaction block emits a harmless WARNING and is ignored.)
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- The operator escape hatch.
-- ---------------------------------------------------------------------------
-- A deliberate operator-driven correction is the ONE legitimate reason to write
-- a sealed record (spec §2, C1). It needs two things at once, because either
-- alone is not enough:
--
--   1. An explicit statement of intent -- the session GUC. Nobody flips this by
--      accident.
--   2. A session that is not the ingester. A custom GUC is settable by ANY role,
--      so a GUC-only hatch is a switch the buggy writer can flip on itself.
--
-- TRUNCATE is the privilege probe because no migration has ever granted it to
-- scorearc_ingester -- 0001 grants SELECT/INSERT/UPDATE broadly and DELETE on a
-- named four; 0003, 0007 and 0011-0015 each grant SELECT/INSERT/UPDATE and
-- sometimes DELETE. TRUNCATE appears nowhere. The schema owner has it
-- implicitly. So this reads as "the owner said so, on purpose".
--
-- The GUC test comes first so the common path costs one hash lookup and never
-- touches the catalog.
CREATE FUNCTION scorearc_final_writes_allowed(target regclass)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF coalesce(current_setting('scorearc.allow_final_writes', true), 'off') <> 'on' THEN
    RETURN false;
  END IF;
  RETURN has_table_privilege(current_user, target, 'TRUNCATE');
END
$$;

COMMENT ON FUNCTION scorearc_final_writes_allowed(regclass) IS
  'Operator escape hatch for the C1 guards. Requires BOTH '
  '`SET scorearc.allow_final_writes = ''on''` and a session holding TRUNCATE on '
  'the target table, which scorearc_ingester deliberately never has.';

-- ---------------------------------------------------------------------------
-- The guard.
-- ---------------------------------------------------------------------------
-- One function, six triggers. TG_ARGV[0] picks the seal; the trigger's event
-- list picks which operations are guarded.
CREATE FUNCTION scorearc_protect_final_records() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- The rejection is a BUG IN THE WRITER, not a transient failure. Whoever reads
  -- this in a log must not be tempted to retry it.
  advice constant text :=
    'This is a bug in the writer, not a transient failure: the record is already '
    'recorded history. A deliberate operator correction must SET '
    'scorearc.allow_final_writes = ''on'' in a session that holds TRUNCATE on the '
    'table (the schema owner, never scorearc_ingester).';
  target_match uuid;
  sealed       boolean;
  old_row      jsonb;
  new_row      jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_match := OLD.match_id;
  ELSE
    target_match := NEW.match_id;
  END IF;

  -- The seal.
  --
  -- Phrased as EXISTS(... IS NOT NULL) and NOT as NOT EXISTS(... IS NULL). The
  -- two are equivalent while the match exists and OPPOSITE when it does not.
  -- All six tables are ON DELETE CASCADE children of `match`, and the RI trigger
  -- that issues the child DELETE runs with the parent row already gone. This
  -- form returns "unsealed" for a vanished match, so the cascade passes. The
  -- inverted form would make a finalized match permanently undeletable.
  -- scorearc_protect_finalized_detail already uses this form; do not "simplify"
  -- either of them.
  --
  -- The 'archive' seal joins `match` for the same reason: match_play and
  -- match_play_archive are BOTH cascade children of `match` and Postgres does
  -- not define which cascade fires first, so without the join a match delete
  -- would succeed or fail depending on ordering.
  IF TG_ARGV[0] = 'archive' THEN
    SELECT EXISTS (
      SELECT 1
      FROM match_play_archive a
      JOIN match m ON m.id = a.match_id
      WHERE a.match_id = target_match
    ) INTO sealed;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM match WHERE id = target_match AND finalized_at IS NOT NULL
    ) INTO sealed;
  END IF;

  -- The hot path leaves here. Everything below -- to_jsonb of the whole row, the
  -- catalog probe in the escape hatch -- is reached only once a record is
  -- already sealed, which in normal ingestion never happens.
  IF NOT sealed OR scorearc_final_writes_allowed(TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION '% is immutable once its record is sealed', TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  -- CURATION CARVE-OUT. 0001 carves identity columns out of `match`'s
  -- immutability comparison because a provisional team id (`prov-espn-9999`) is
  -- a placeholder WE minted, and folding it into its curated row corrects a
  -- pointer to the same real-world club rather than rewriting a result.
  --
  -- That is not hypothetical here: promoteProvisionalTeam already issues
  -- `UPDATE match_play SET team_id=$2 WHERE team_id=$1` (seed.go:308) against
  -- finalized, ledgered matches. Blocking it would break routine team curation
  -- against any club that has already played -- the normal lifecycle, not an
  -- exception. The same carve-out is extended to appearance and match_event so
  -- that adding their repoints later is a one-line change and not a schema
  -- rollback.
  --
  -- ALL OF THIS IS DONE IN JSONB, NOT VIA NEW.team_id. One function serves six
  -- tables and three of them have no team_id column at all: `NEW.team_id` on a
  -- match_commentary row raises `record "new" has no field "team_id"` at
  -- execution time, while `new_row->>'team_id'` is simply NULL and the branch is
  -- skipped. Do not turn these into field references.
  --
  -- NOTE FOR WHOEVER ADDS A GENERATED COLUMN TO ONE OF THESE TABLES: 0001's
  -- comment on kickoff_date applies. A STORED GENERATED column is NULL in NEW
  -- inside a BEFORE UPDATE trigger, so it must be subtracted here or this guard
  -- becomes "reject every write". None of these six tables has one today
  -- (verified against 0003, 0006, 0007, 0013, 0014, 0015).
  --
  -- match_odds.observed_at is deliberately NOT subtracted, unlike match.updated_at.
  -- It records WHEN THE LINE WAS OBSERVED and the upsert sets it to now(), so a
  -- changed observed_at means the row was re-written -- exactly the event this
  -- guard refuses.
  new_row := to_jsonb(NEW);
  old_row := to_jsonb(OLD);
  IF (new_row - 'team_id' - 'player_id')
     IS DISTINCT FROM (old_row - 'team_id' - 'player_id') THEN
    RAISE EXCEPTION '% is immutable once its record is sealed', TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  -- The carve-out releases only ids that belonged to a PROVISIONAL team. Without
  -- this narrowing, projecting team_id out of the comparison would let anyone
  -- re-attribute a goal in a finished match from one curated club to another --
  -- a result, not a pointer. promoteProvisionalTeam runs its repoints BEFORE
  -- `DELETE FROM team` (seed.go:308 then :321), so the provisional row is still
  -- present and still flagged when this evaluates.
  IF new_row->>'team_id' IS DISTINCT FROM old_row->>'team_id'
     AND NOT EXISTS (
       SELECT 1 FROM team WHERE id = old_row->>'team_id' AND provisional
     ) THEN
    RAISE EXCEPTION
      '% may repoint a team id on a sealed record only off a provisional team',
      TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  -- No player equivalent. `player` has no `provisional` column, so there is no
  -- "this id was a placeholder we minted" test to make, and inventing one here
  -- would be guessing at a design that has not landed
  -- (specs/2026-08-12-player-identity-design.md). Whoever builds player curation
  -- adds the flag and the carve-out together, and the test in
  -- finalization_integration_test.go is what will make them notice.
  IF new_row->>'player_id' IS DISTINCT FROM old_row->>'player_id' THEN
    RAISE EXCEPTION
      '% may not repoint a player id on a sealed record', TG_TABLE_NAME
      USING ERRCODE = 'SA001', HINT = advice;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION scorearc_protect_final_records() IS
  'C1 guard (spec 2026-08-18 §4.6). TG_ARGV[0] is the seal: ''match'' uses '
  'match.finalized_at, ''archive'' uses the match_play_archive ledger. Raises '
  'SQLSTATE SA001, which shared/store.IsImmutableViolation classifies.';

-- ---------------------------------------------------------------------------
-- The triggers.
-- ---------------------------------------------------------------------------
-- Written before FinalizeMatch (matches.go:252, :286 -> :293), so nothing
-- legitimately touches them once the match is sealed. All three operations are
-- guarded: WriteParticipation and WriteCommentary both upsert and then issue a
-- tail DELETE.
CREATE TRIGGER protect_final_appearance
BEFORE INSERT OR UPDATE OR DELETE ON appearance
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

CREATE TRIGGER protect_final_match_event
BEFORE INSERT OR UPDATE OR DELETE ON match_event
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

CREATE TRIGGER protect_final_match_commentary
BEFORE INSERT OR UPDATE OR DELETE ON match_commentary
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

-- Sealed by the archive ledger, not by finalization: see the header.
CREATE TRIGGER protect_final_match_play
BEFORE INSERT OR UPDATE OR DELETE ON match_play
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('archive');

-- UPDATE and DELETE only. The one legitimate write to each of these is an INSERT
-- against an already-finalized match (matches.go:311, :312) and a BEFORE INSERT
-- guard would reject it. See the header for why that is not a hole.
CREATE TRIGGER protect_final_match_official
BEFORE UPDATE OR DELETE ON match_official
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

CREATE TRIGGER protect_final_match_odds
BEFORE UPDATE OR DELETE ON match_odds
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_final_records('match');

-- NO GRANTS ARE NEEDED OR ADDED. A trigger fires regardless of the writer's
-- privileges, and the function is SECURITY INVOKER: it reads `match`, `team` and
-- `match_play_archive`, all of which scorearc_ingester holds SELECT on (0001,
-- 0007). If a future migration revoked one, this guard would raise 42501 and the
-- write would fail CLOSED, which is the correct direction for a safety guard.
--
-- 0001's scorearc_protect_match_history and scorearc_protect_finalized_detail
-- still raise the default P0001. They are backstops behind a Go-side pre-check
-- (ErrMatchFinalized) and a WHERE clause, so nothing classifies them today.
-- Copying their bodies here to add ERRCODE would buy no behaviour and create a
-- drift hazard; they should adopt SA001 the next time they are edited for some
-- other reason.
```

- [x] **Step 2: Verify it parses and applies to an empty database**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
docker run --rm -d --name pg-0021 -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
sleep 4
for m in migrations/*.up.sql; do
  PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -q -f "$m" || echo "FAILED $m"
done
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -X -c \
  "SELECT tgrelid::regclass::text AS tbl, tgname FROM pg_trigger
   WHERE NOT tgisinternal AND tgname LIKE 'protect_final_%' ORDER BY 1;"
```

Expected exactly six rows:

```
       tbl        |            tgname
------------------+-------------------------------
 appearance       | protect_final_appearance
 match_commentary | protect_final_match_commentary
 match_event      | protect_final_match_event
 match_odds       | protect_final_match_odds
 match_official   | protect_final_match_official
 match_play       | protect_final_match_play
(6 rows)
```

(A `WARNING: SET LOCAL can only be used in transaction blocks` from `psql` is
expected and harmless — see the comment in the file. Leave the container running;
Task 3 Step 2 uses it.)

---

### Task 3: Write migration 0021 (down)

**Files:**
- Create: `backend/migrations/0021_finalization_invariants.down.sql`

- [x] **Step 1: Write the down migration**

Create `backend/migrations/0021_finalization_invariants.down.sql`:

```sql
-- Reverse of 0021. Triggers first, then the functions they depend on.
--
-- CI applies every *.down.sql in reverse sort order (ci.yml:53-54), so this runs
-- BEFORE 0015/0014/0013/0007/0003 drop these tables -- which is what makes the
-- `ON <table>` clauses valid. `DROP TRIGGER IF EXISTS x ON y` still errors if Y
-- itself is missing; IF EXISTS covers the trigger, not the table. Keeping 0021
-- as the highest-numbered migration is therefore load-bearing for the rollback,
-- not just for the watermark.
DROP TRIGGER IF EXISTS protect_final_match_odds ON match_odds;
DROP TRIGGER IF EXISTS protect_final_match_official ON match_official;
DROP TRIGGER IF EXISTS protect_final_match_play ON match_play;
DROP TRIGGER IF EXISTS protect_final_match_commentary ON match_commentary;
DROP TRIGGER IF EXISTS protect_final_match_event ON match_event;
DROP TRIGGER IF EXISTS protect_final_appearance ON appearance;

-- No argument list: a trigger function takes none (TG_ARGV is not part of the
-- signature). The escape hatch does, and it must be named or the DROP is
-- ambiguous.
DROP FUNCTION IF EXISTS scorearc_protect_final_records();
DROP FUNCTION IF EXISTS scorearc_final_writes_allowed(regclass);
```

- [x] **Step 2: Prove the rollback genuinely reverses**

Against the container from Task 2:

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 \
  -f migrations/0021_finalization_invariants.down.sql
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -X -c \
  "SELECT count(*) AS triggers_left FROM pg_trigger
     WHERE NOT tgisinternal AND tgname LIKE 'protect_final_%';" \
  -c "SELECT count(*) AS functions_left FROM pg_proc
     WHERE proname IN ('scorearc_protect_final_records','scorearc_final_writes_allowed');"
```

Expected:

```
 triggers_left
---------------
             0
(1 row)

 functions_left
----------------
              0
(1 row)
```

- [x] **Step 3: Prove the whole reverse chain still runs**

```bash
for m in $(find migrations -name '*.down.sql' | sort -r); do
  PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -q -f "$m" || echo "FAILED $m"
done
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -X -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
```

Expected: no `FAILED` lines (0021's down is idempotent — it already ran in Step 2 and
every statement is `IF EXISTS`) and a count of `0`. Then clean up:

```bash
docker rm -f pg-0021
```

- [x] **Step 4: Commit**

```bash
git add backend/migrations/0021_finalization_invariants.up.sql \
        backend/migrations/0021_finalization_invariants.down.sql
git commit -m "$(cat <<'EOF'
feat(db): seal the six C1 tables against post-finalization writes

appearance, match_event, match_commentary, match_play, match_official and
match_odds were immutable-once-final in policy and unguarded in the schema.
Migration 0021 adds the same BEFORE-trigger mechanism match and match_detail
have had since 0001, with three different seals because three of the six are
written AFTER finalization on the normal path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Lock the migration's invariants into `migrations_test.go`

**Files:**
- Modify: `backend/migrations/migrations_test.go`

These are cheap text assertions that stop the file being edited into something that
looks similar and behaves differently. The behavioural proof is Tasks 5–8.

- [x] **Step 1: Append the tests**

Append to `backend/migrations/migrations_test.go`:

```go
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
```

- [x] **Step 2: Run them**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./migrations/ -run TestFinalizationInvariants -v 2>&1 | tail -15
```

Expected: four `--- PASS` lines and `ok  	github.com/mcasillas17/scorearc-backend/migrations`.

- [x] **Step 3: Commit**

```bash
git add backend/migrations/migrations_test.go
git commit -m "$(cat <<'EOF'
test(db): pin 0021's seals, its INSERT carve-outs and its rollback

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Make the rejection classifiable in Go

**Files:**
- Modify: `backend/shared/store/store.go`

**Interfaces:**
- `store.IsImmutableViolation(err error) bool` — exported, mirrors the existing
  unexported `isUniqueViolation`.

No writer changes. Every error path in the five writers already wraps with `%w`, so
`errors.As` reaches the `*pgconn.PgError` unchanged; Task 6 Step 4 proves that against
the real writers rather than assuming it.

- [x] **Step 1: Add the const and the helper**

In `backend/shared/store/store.go`, add `"github.com/jackc/pgx/v5/pgconn"` to the
imports, and append:

```go
// finalizedImmutable is the SQLSTATE migration 0021 raises when a write would
// mutate a record that is already sealed as history: a finalized match's
// appearances, events or commentary, an archived play stream, or a finished
// match's crew and settled lines.
//
// It is in a user-definable class. The SQL standard reserves classes beginning
// with 0-4 and A-H for itself, and Postgres uses P0, XX, HV, F0, 72 and the
// numeric classes, so nothing the server generates can ever collide with a class
// starting 'S'. That is the whole point: this must be distinguishable from a
// connection failure, because a rejected write is a BUG IN THE WRITER and
// retrying it forever is the wrong response.
const finalizedImmutable = "SA001"

// IsImmutableViolation reports a write the schema refused because its target is
// already recorded history.
//
// Exported, unlike isUniqueViolation, because the caller that needs to act on it
// is the ingester rather than the store: a unique violation is a normal race the
// store resolves by itself, while this one is a defect the store cannot fix and
// must surface. Log it, count it, page on it -- do not retry it.
//
// It works through the writers' existing error wrapping without any change,
// because every one of them wraps with %w.
func IsImmutableViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == finalizedImmutable
}
```

- [x] **Step 2: Build and vet**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./...
```

Expected: no output.

---

### Task 6: Integration tests — every guard rejects a post-finalization mutation

**Files:**
- Create: `backend/shared/store/finalization_integration_test.go`

Schema guards cannot be unit-tested meaningfully, so all of this runs against real
Postgres through the existing `newIntegrationStoreDSN` harness, which boots a container
and applies every `*.up.sql` in order — including 0021.

- [x] **Step 1: Write the fixture**

Create `backend/shared/store/finalization_integration_test.go`:

```go
package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// sealFixture owns one Postgres and mints matches whose C1 tables are already
// populated, so each test only has to answer "may this write land?".
//
// It populates the tables in PRODUCTION ORDER: appearance, match_event and
// match_commentary before FinalizeMatch; match_play, match_official and
// match_odds after it. A fixture that seeded everything up front would be
// testing a sequence the ingester never performs.
type sealFixture struct {
	store  *Store
	pool   *pgxpool.Pool
	dsn    string
	player uuid.UUID
	day    int
}

func newSealFixture(t *testing.T) *sealFixture {
	t.Helper()
	store, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store) // eng-arsenal, eng-chelsea (curated)
	mustSeedSeason(t, pool)
	if _, err := pool.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr, provisional) VALUES
	('prov-espn-9999','club','Luton Town','LUT',true),
	('eng-luton-town','club','Luton Town','LUT',false)`); err != nil {
		t.Fatal(err)
	}
	player, err := store.Player(ctx, testSource,
		PlayerRef{SourceID: "seal-1", FullName: "Seal Player"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO official (id, full_name) VALUES ($1, 'Seal Referee')`,
		uuid.MustParse("0198d0d5-0000-7000-8000-0000000000ff")); err != nil {
		t.Fatal(err)
	}
	return &sealFixture{store: store, pool: pool, dsn: dsn, player: player, day: 1}
}

const sealOfficialID = "0198d0d5-0000-7000-8000-0000000000ff"

// unfinalized creates a finished-but-unfrozen match, each on its own date so the
// natural key never collides.
func (f *sealFixture) unfinalized(t *testing.T, homeTeam string) uuid.UUID {
	t.Helper()
	f.day++
	id := uuid.New()
	if _, err := f.pool.Exec(context.Background(), `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, home_score, away_score, winner_id, source)
VALUES ($1,'premier-league','2026-27',$2,'eng-chelsea',$3,'finished',2,1,$2,'espn')`,
		id, homeTeam, fmt.Sprintf("2026-09-%02dT14:00:00Z", f.day)); err != nil {
		t.Fatal(err)
	}
	return id
}

// preFinalRows writes the three tables the summary fetch fills in before
// FinalizeMatch runs.
func (f *sealFixture) preFinalRows(t *testing.T, id uuid.UUID, teamID string) {
	t.Helper()
	ctx := context.Background()
	for _, stmt := range []string{
		`INSERT INTO appearance (match_id, player_id, team_id, starter, goals)
		 VALUES ($1, $2, $3, true, 1)`,
		`INSERT INTO match_event (match_id, seq, player_id, team_id, type, minute)
		 VALUES ($1, 0, $2, $3, 'goal', '17')`,
	} {
		if _, err := f.pool.Exec(ctx, stmt, id, f.player, teamID); err != nil {
			t.Fatalf("seed pre-final rows: %v", err)
		}
	}
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_commentary (match_id, seq, clock_display, text)
VALUES ($1, 1, '17''', 'Goal.')`, id); err != nil {
		t.Fatalf("seed commentary: %v", err)
	}
}

func (f *sealFixture) finalize(t *testing.T, id uuid.UUID) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE match SET finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
}

// postFinalRows writes the three tables captured AFTER finalization. That these
// statements succeed at all is half the point of the test suite: a guard that
// rejected them would break production finalization.
func (f *sealFixture) postFinalRows(t *testing.T, id uuid.UUID, teamID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_play (match_id, source_id, seq, type_id, type_key, type_text,
	team_id, player_id, clock_display)
VALUES ($1, 'p-1', 1, '70', 'goal', 'Goal', $2, $3, '17''')`,
		id, teamID, f.player); err != nil {
		t.Fatalf("plays must be writable on a finalized, unledgered match: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_official (match_id, official_id, role, ord)
VALUES ($1, $2, 'Referee', 1)`, id, sealOfficialID); err != nil {
		t.Fatalf("the crew must be writable at the finalization transition: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
INSERT INTO match_odds (match_id, provider_id, provider_name, phase, home_moneyline)
VALUES ($1, '58', 'Bet365', 'close', -140)`, id); err != nil {
		t.Fatalf("settled lines must be writable at the finalization transition: %v", err)
	}
}

func (f *sealFixture) ledger(t *testing.T, id uuid.UUID) {
	t.Helper()
	if err := f.store.RecordPlayArchive(
		context.Background(), id, "espn/eng.1/2026-27/1.json", 1, 100, true,
	); err != nil {
		t.Fatal(err)
	}
}

// sealed builds the full end-state: every C1 table populated, the match
// finalized and the play stream ledgered.
func (f *sealFixture) sealed(t *testing.T, homeTeam string) uuid.UUID {
	t.Helper()
	id := f.unfinalized(t, homeTeam)
	f.preFinalRows(t, id, homeTeam)
	f.finalize(t, id)
	f.postFinalRows(t, id, homeTeam)
	f.ledger(t, id)
	return id
}

func mustBeImmutableViolation(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: the write was ACCEPTED against a sealed record", what)
	}
	if !IsImmutableViolation(err) {
		t.Fatalf("%s: rejected, but not classifiably: %v", what, err)
	}
	t.Logf("%s: rejected with SA001 -- %v", what, err)
}
```

- [x] **Step 2: The rejection tests**

Append:

```go
// Every guarded operation on every sealed record, and the classification that
// tells the caller it is a bug rather than a blip.
func TestSealedRecordsRejectEveryMutation(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name string
		stmt string
	}{
		// appearance / match_event / match_commentary: sealed by finalization,
		// all three operations guarded.
		{"appearance UPDATE", `UPDATE appearance SET goals=99 WHERE match_id=$1`},
		{"appearance DELETE", `DELETE FROM appearance WHERE match_id=$1`},
		{"match_event UPDATE", `UPDATE match_event SET type='own_goal' WHERE match_id=$1`},
		{"match_event DELETE", `DELETE FROM match_event WHERE match_id=$1`},
		{"match_commentary UPDATE", `UPDATE match_commentary SET text='revised' WHERE match_id=$1`},
		{"match_commentary DELETE", `DELETE FROM match_commentary WHERE match_id=$1`},
		// match_play: sealed by the archive ledger, all three guarded.
		{"match_play UPDATE", `UPDATE match_play SET type_key='shot-saved' WHERE match_id=$1`},
		{"match_play DELETE", `DELETE FROM match_play WHERE match_id=$1`},
		{"match_play INSERT", `INSERT INTO match_play
			(match_id, source_id, seq, type_id, type_key, type_text, clock_display)
			VALUES ($1, 'p-late', 2, '70', 'goal', 'Goal', '90''')`},
		// match_official / match_odds: UPDATE and DELETE only.
		{"match_official UPDATE", `UPDATE match_official SET role='Assistant' WHERE match_id=$1`},
		{"match_official DELETE", `DELETE FROM match_official WHERE match_id=$1`},
		{"match_odds UPDATE", `UPDATE match_odds SET home_moneyline=100 WHERE match_id=$1`},
		{"match_odds DELETE", `DELETE FROM match_odds WHERE match_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := f.sealed(t, "eng-arsenal")
			_, err := f.pool.Exec(ctx, tc.stmt, id)
			mustBeImmutableViolation(t, tc.name, err)
		})
	}
}

// The three tables written before FinalizeMatch must refuse a LATE insert too --
// that is what a re-poll of a finished match looks like, and Postgres fires the
// BEFORE INSERT trigger for the proposed row before conflict detection, so an
// `ON CONFLICT DO UPDATE` upsert is caught here rather than on the update.
func TestSealedRecordsRejectLateInserts(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")

	for _, tc := range []struct {
		name string
		stmt string
		args []any
	}{
		{"appearance", `INSERT INTO appearance (match_id, player_id, team_id, starter)
			VALUES ($1, $2, 'eng-chelsea', false)`, []any{id, f.player}},
		{"match_event", `INSERT INTO match_event (match_id, seq, team_id, type, minute)
			VALUES ($1, 9, 'eng-chelsea', 'yellow', '88')`, []any{id}},
		{"match_commentary", `INSERT INTO match_commentary (match_id, seq, clock_display, text)
			VALUES ($1, 99, '90''', 'Late line.')`, []any{id}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.pool.Exec(ctx, tc.stmt, tc.args...)
			mustBeImmutableViolation(t, tc.name+" late INSERT", err)
		})
	}
}

// The finalization transition itself must keep working. This is the assertion
// that would have caught a naive `finalized_at IS NOT NULL` guard on all six
// tables: ingester/matches.go writes plays, officials and odds AFTER
// FinalizeMatch commits.
func TestFinalizationTransitionStillWrites(t *testing.T) {
	f := newSealFixture(t)
	id := f.unfinalized(t, "eng-arsenal")
	f.preFinalRows(t, id, "eng-arsenal")
	f.finalize(t, id)
	// Panics via t.Fatalf inside if any of the three is refused.
	f.postFinalRows(t, id, "eng-arsenal")

	var plays, crew, lines int
	if err := f.pool.QueryRow(context.Background(), `
SELECT (SELECT count(*) FROM match_play     WHERE match_id=$1),
       (SELECT count(*) FROM match_official WHERE match_id=$1),
       (SELECT count(*) FROM match_odds     WHERE match_id=$1)`,
		id).Scan(&plays, &crew, &lines); err != nil {
		t.Fatal(err)
	}
	if plays != 1 || crew != 1 || lines != 1 {
		t.Fatalf("post-finalization capture wrote plays=%d crew=%d lines=%d, want 1/1/1",
			plays, crew, lines)
	}
}
```

- [x] **Step 3: Cascade, player identity, and the escape hatch**

Append:

```go
// Deleting a match must still cascade through every sealed child. The seal is
// phrased EXISTS(... IS NOT NULL) precisely so that a vanished parent reads as
// unsealed; the inverted phrasing would make a finalized match undeletable.
func TestSealedRecordsStillCascadeWhenTheMatchIsDeleted(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")

	if _, err := f.pool.Exec(ctx, `DELETE FROM match WHERE id=$1`, id); err != nil {
		t.Fatalf("a sealed match could not be deleted: %v", err)
	}
	var left int
	if err := f.pool.QueryRow(ctx, `
SELECT (SELECT count(*) FROM appearance       WHERE match_id=$1)
     + (SELECT count(*) FROM match_event      WHERE match_id=$1)
     + (SELECT count(*) FROM match_commentary WHERE match_id=$1)
     + (SELECT count(*) FROM match_play       WHERE match_id=$1)
     + (SELECT count(*) FROM match_official   WHERE match_id=$1)
     + (SELECT count(*) FROM match_odds       WHERE match_id=$1)
     + (SELECT count(*) FROM match_play_archive WHERE match_id=$1)`,
		id).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatalf("cascade left %d rows behind a deleted sealed match", left)
	}
}

// A player who appeared in a sealed match cannot be erased. `player` has no
// `provisional` column, so there is no "this id was a placeholder we minted"
// test to make and the guard refuses outright.
//
// WHOEVER BUILDS PLAYER CURATION: this test is the tripwire. Add the flag to
// `player`, extend the carve-out in 0021 the way it already handles team_id, and
// change this assertion deliberately -- do not delete it.
func TestSealedRecordsRefusePlayerRepointing(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")
	other, err := f.store.Player(ctx, testSource,
		PlayerRef{SourceID: "seal-2", FullName: "Other Player"})
	if err != nil {
		t.Fatal(err)
	}

	_, err = f.pool.Exec(ctx,
		`UPDATE match_event SET player_id=$2 WHERE match_id=$1`, id, other)
	mustBeImmutableViolation(t, "match_event player repoint", err)

	_, err = f.pool.Exec(ctx, `DELETE FROM player WHERE id=$1`, f.player)
	mustBeImmutableViolation(t, "deleting a player who appeared in a sealed match", err)
}

// The escape hatch needs BOTH halves. A custom GUC is settable by any role, so a
// GUC-only hatch is a switch the ingester could flip on itself.
func TestOperatorEscapeHatchNeedsIntentAndPrivilege(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")
	roleStore, roleName := newIngesterRoleStore(t, f.pool, f.dsn)

	// 1. The ingester sets the GUC and is still refused.
	ingesterConn, err := roleStore.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer ingesterConn.Release()
	if _, err := ingesterConn.Exec(ctx,
		`SET scorearc.allow_final_writes = 'on'`); err != nil {
		t.Fatalf("%s could not even SET the GUC: %v", roleName, err)
	}
	_, err = ingesterConn.Exec(ctx,
		`UPDATE match_commentary SET text='ingester override' WHERE match_id=$1`, id)
	mustBeImmutableViolation(t, roleName+" with the GUC set", err)

	// 2. The owner sets the GUC and gets through.
	ownerConn, err := f.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerConn.Release()
	if _, err := ownerConn.Exec(ctx,
		`SET scorearc.allow_final_writes = 'on'`); err != nil {
		t.Fatal(err)
	}
	if _, err := ownerConn.Exec(ctx,
		`UPDATE match_commentary SET text='operator correction' WHERE match_id=$1`,
		id); err != nil {
		t.Fatalf("the operator escape hatch did not open: %v", err)
	}

	// 3. And it closes again when the intent is withdrawn.
	if _, err := ownerConn.Exec(ctx,
		`SET scorearc.allow_final_writes = 'off'`); err != nil {
		t.Fatal(err)
	}
	_, err = ownerConn.Exec(ctx,
		`UPDATE match_commentary SET text='oops' WHERE match_id=$1`, id)
	mustBeImmutableViolation(t, "owner with the GUC back off", err)
}
```

- [x] **Step 4: The error surface, through the real writers**

Append:

```go
// The rejection must reach the caller through each writer's own error wrapping,
// unchanged. Every one of them wraps with %w; this is the test that says so out
// loud, so a future `fmt.Errorf("...: %v", err)` breaks the build instead of
// silently turning a bug into an unclassifiable string.
func TestWritersSurfaceTheRejectionClassifiably(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "eng-arsenal")

	_, err := f.store.WriteCommentary(ctx, id, []model.CommentaryLine{
		{Seq: 1, ClockDisplay: "17'", Text: "Revised."},
	})
	mustBeImmutableViolation(t, "WriteCommentary", err)

	_, err = f.store.WriteParticipation(ctx, testSource, id,
		"eng-arsenal", "eng-chelsea", &model.MatchParticipation{
			HomeTeamSourceID: "359", AwayTeamSourceID: "363",
			Home: []model.SquadPlayer{{SourceID: "seal-1", Name: "Seal Player", Starter: true}},
		})
	mustBeImmutableViolation(t, "WriteParticipation", err)

	_, err = f.store.WritePlays(ctx, id,
		[]model.Play{{SourceID: "p-1", Seq: 1, TypeID: "70", TypeKey: "goal", TypeText: "Goal"}},
		map[string]string{}, map[string]uuid.UUID{})
	mustBeImmutableViolation(t, "WritePlays", err)

	err = f.store.WriteMatchOfficials(ctx, id,
		[]model.MatchOfficial{{SourceID: "ref-1", FullName: "Seal Referee", Role: "Assistant", Order: 1}},
		map[string]uuid.UUID{"ref-1": uuid.MustParse(sealOfficialID)})
	mustBeImmutableViolation(t, "WriteMatchOfficials", err)

	home := -150
	err = f.store.WriteMatchOdds(ctx, id, []model.ProviderOdds{{
		ProviderID: "58", ProviderName: "Bet365",
		Close: &model.OddsLine{HomeMoneyline: &home},
	}})
	mustBeImmutableViolation(t, "WriteMatchOdds", err)
}

// A rejected write and a broken connection must not look the same, or the
// ingester retries a bug forever.
func TestImmutableViolationIsNotAConnectionFailure(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"the guard", &pgconn.PgError{Code: "SA001", Message: "sealed"}, true},
		{"wrapped guard", fmt.Errorf("upsert appearance: %w",
			&pgconn.PgError{Code: "SA001"}), true},
		{"connection_failure", &pgconn.PgError{Code: "08006"}, false},
		{"unique violation", &pgconn.PgError{Code: "23505"}, false},
		{"a plain RAISE", &pgconn.PgError{Code: "P0001"}, false},
		{"context deadline", context.DeadlineExceeded, false},
		{"nil", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsImmutableViolation(tc.err); got != tc.want {
				t.Fatalf("IsImmutableViolation(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
	// Guards against someone "simplifying" the helper into a string match.
	var pgErr *pgconn.PgError
	if !errors.As(fmt.Errorf("a: %w", fmt.Errorf("b: %w",
		&pgconn.PgError{Code: finalizedImmutable})), &pgErr) {
		t.Fatal("errors.As no longer reaches a doubly-wrapped PgError")
	}
}
```

- [x] **Step 5: Run them**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./shared/store/ -run 'TestSealed|TestFinalizationTransition|TestOperatorEscape|TestWritersSurface|TestImmutableViolation' -v 2>&1 | tail -60
```

Expected: every subtest `--- PASS`, and in the log output an `SA001` line for each
rejection, e.g.

```
    finalization_integration_test.go:NNN: appearance UPDATE: rejected with SA001 -- ERROR: appearance is immutable once its record is sealed (SQLSTATE SA001)
```

If `TestFinalizationTransitionStillWrites` fails, you have sealed a table on
finalization that the ingester writes after it — go back to Decision 2's table.

- [x] **Step 6: Commit**

```bash
git add backend/shared/store/store.go backend/shared/store/finalization_integration_test.go
git commit -m "$(cat <<'EOF'
test(db): prove every C1 guard rejects a post-final mutation, classifiably

Adds store.IsImmutableViolation over SQLSTATE SA001 so a rejected write is
distinguishable from a connection failure, and proves the rejection reaches the
caller through each writer's existing %w wrapping.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Integration tests — backfill and curation still work

**Files:**
- Modify: `backend/shared/store/finalization_integration_test.go`

This is the half that stops the guard being a production outage. Both of these paths
write to sealed-looking records *legitimately*, today, in production.

- [x] **Step 1: The play-stream backlog**

Append:

```go
// The play stream is sealed by the ARCHIVE LEDGER, not by finalization, because
// capturePlays runs after FinalizeMatch and retryMissingPlayStreams re-runs it on
// finalized matches for as many slow ticks as it takes. This is the test that
// stops someone "fixing" the seal to finalized_at.
func TestPlayStreamStaysWritableUntilItIsArchived(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.unfinalized(t, "eng-arsenal")
	f.finalize(t, id)

	plays := []model.Play{
		{SourceID: "p-1", Seq: 1, TypeID: "70", TypeKey: "goal", TypeText: "Goal"},
	}

	// 1. capturePlays at the finalization transition (matches.go:302).
	if _, err := f.store.WritePlays(ctx, id, plays, nil, nil); err != nil {
		t.Fatalf("plays refused on a finalized match with no ledger: %v", err)
	}

	// 2. The R2 put failed, so no ledger was written. The next slow tick's
	//    retryMissingPlayStreams re-runs the same batch: an ON CONFLICT DO UPDATE
	//    against rows that already exist, which must still be allowed.
	plays[0].TypeText = "Goal!"
	if _, err := f.store.WritePlays(ctx, id, plays, nil, nil); err != nil {
		t.Fatalf("the play backlog retry was refused: %v", err)
	}

	// 3. The ledger lands. From here the stream is history.
	f.ledger(t, id)
	_, err := f.store.WritePlays(ctx, id, plays, nil, nil)
	mustBeImmutableViolation(t, "WritePlays after the ledger landed", err)

	// 4. And the ledger itself stays writable, because that is exactly what
	//    cmd/play-backfill re-records for a match whose rows landed but whose
	//    ledger write did not.
	if err := f.store.RecordPlayArchive(
		ctx, id, "espn/eng.1/2026-27/1.json", 1, 200, true,
	); err != nil {
		t.Fatalf("re-recording the archive ledger was refused: %v", err)
	}
}

// cmd/play-backfill's two store calls, in order, as the least-privilege role it
// runs as in production, against an already-finalized match. If this fails, the
// backfill is broken.
func TestPlayBackfillPathSurvivesTheGuards(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	roleStore, roleName := newIngesterRoleStore(t, f.pool, f.dsn)

	id := f.unfinalized(t, "eng-arsenal")
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO match_external_ref (source, source_id, match_id)
		 VALUES ('espn', 'backfill-1', $1)`, id); err != nil {
		t.Fatal(err)
	}
	f.finalize(t, id)

	pending, err := roleStore.MatchesMissingPlays(
		ctx, testCompetition, testSeason, testSource, 10)
	if err != nil {
		t.Fatalf("MatchesMissingPlays as %s: %v", roleName, err)
	}
	if len(pending) != 1 || pending[0].MatchID != id {
		t.Fatalf("pending = %+v, want the one finalized unledgered match", pending)
	}
	if err := roleStore.RecordPlayArchive(
		ctx, pending[0].MatchID, "espn/eng.1/2026-27/backfill-1.json", 0, 42, false,
	); err != nil {
		t.Fatalf("RecordPlayArchive as %s: %v", roleName, err)
	}

	pending, err = roleStore.MatchesMissingPlays(
		ctx, testCompetition, testSeason, testSource, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("the backfill did not converge: %d matches still pending", len(pending))
	}
}
```

- [x] **Step 2: Curation across sealed records**

Append:

```go
// Curating a club that has already played finished matches is the NORMAL
// lifecycle. promoteProvisionalTeam repoints match_play.team_id (seed.go:308) on
// matches that are finalized AND ledgered, so the carve-out 0001 gave `match`
// has to exist here too or team curation breaks on day one.
func TestCurationRepointsTeamIdsAcrossSealedRecords(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.sealed(t, "prov-espn-9999")
	roleStore, roleName := newIngesterRoleStore(t, f.pool, f.dsn)

	if err := roleStore.ApplyTeamSeed(ctx, []config.SeedTeam{{
		ID: "eng-luton-town", Kind: "club", Name: "Luton Town", Abbr: "LUT",
		Country: "eng", Refs: map[string]string{"espn": "9999"},
	}}); err != nil {
		t.Fatalf("ApplyTeamSeed as %s refused to curate across a sealed record: %v",
			roleName, err)
	}

	var playTeam, matchHome string
	var goals int
	if err := f.pool.QueryRow(ctx, `
SELECT (SELECT team_id FROM match_play WHERE match_id=$1),
       (SELECT home_team_id FROM match WHERE id=$1),
       (SELECT goals FROM appearance WHERE match_id=$1)`,
		id).Scan(&playTeam, &matchHome, &goals); err != nil {
		t.Fatal(err)
	}
	if playTeam != "eng-luton-town" || matchHome != "eng-luton-town" {
		t.Fatalf("curation left play team=%q match home=%q, want eng-luton-town",
			playTeam, matchHome)
	}
	// The carve-out moves pointers, not history.
	if goals != 1 {
		t.Fatalf("curation changed the box score: goals=%d, want 1", goals)
	}
}

// The carve-out releases only ids that belonged to a PROVISIONAL team, and it
// releases nothing else. These are the two ways it could have been a hole.
func TestCurationCarveOutIsNarrow(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()

	t.Run("curated to curated is refused", func(t *testing.T) {
		id := f.sealed(t, "eng-arsenal")
		_, err := f.pool.Exec(ctx,
			`UPDATE match_play SET team_id='eng-chelsea' WHERE match_id=$1`, id)
		mustBeImmutableViolation(t, "repointing between two curated teams", err)
	})

	t.Run("a legal repoint may not smuggle a fact rewrite", func(t *testing.T) {
		id := f.sealed(t, "prov-espn-9999")
		_, err := f.pool.Exec(ctx, `
UPDATE match_play SET team_id='eng-luton-town', type_key='shot-saved'
WHERE match_id=$1`, id)
		mustBeImmutableViolation(t, "repoint carrying a type rewrite", err)
	})
}
```

Add `"github.com/mcasillas17/scorearc-backend/config"` to the file's imports.

- [x] **Step 3: Run them**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./shared/store/ -run 'TestPlayStream|TestPlayBackfill|TestCuration' -v 2>&1 | tail -40
```

Expected: all `--- PASS`. If `TestCurationRepointsTeamIdsAcrossSealedRecords` fails
with `SA001` on `match_play`, the carve-out is missing or is checking `NEW.team_id`
instead of `new_row->>'team_id'`.

- [x] **Step 4: Commit**

```bash
git add backend/shared/store/finalization_integration_test.go
git commit -m "$(cat <<'EOF'
test(db): prove the play backlog, play-backfill and team curation still write

The play stream is sealed by the archive ledger rather than by finalization, so
retryMissingPlayStreams keeps working; the curation carve-out repoints team ids
on sealed records and refuses everything else.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Measure the guard on the hot path

**Files:**
- Modify: `backend/shared/store/finalization_integration_test.go`

The reasoning in "Cost on the hot path" says this is ~0.5% of the round trip it rides
on. Measure it rather than assert it, in-database, so the number is trigger overhead
and not network latency.

- [x] **Step 1: Write the measurement**

Append:

```go
// The guard fires per row on the write-heaviest tables in the system, so the
// per-row cost is a real number and not a hand-wave.
//
// Measured in ONE statement so the number is trigger overhead rather than the
// ~1 ms Fly->Neon round trip each of these statements already pays. The match is
// deliberately UNFINALIZED: that is the hot path, where the guard evaluates one
// EXISTS against match_pkey and returns before it ever builds to_jsonb(NEW).
//
// match_commentary is the subject because its only foreign key is match_id, so
// 50,000 rows need no other setup and the measurement is not diluted by FK
// checks the guard is not responsible for.
func TestFinalizationGuardCostOnTheHotPath(t *testing.T) {
	f := newSealFixture(t)
	ctx := context.Background()
	id := f.unfinalized(t, "eng-arsenal")

	const rows = 50_000
	insert := func(base int) time.Duration {
		t.Helper()
		start := time.Now()
		if _, err := f.pool.Exec(ctx, `
INSERT INTO match_commentary (match_id, seq, clock_display, text)
SELECT $1, $2 + g, '45''', 'commentary line ' || g
FROM generate_series(1, $3) g`, id, base, rows); err != nil {
			t.Fatal(err)
		}
		return time.Since(start)
	}

	insert(0) // warm the plan cache, the buffers and the WAL segment
	guarded := insert(10_000_000)

	if _, err := f.pool.Exec(ctx,
		`ALTER TABLE match_commentary DISABLE TRIGGER protect_final_match_commentary`,
	); err != nil {
		t.Fatal(err)
	}
	insert(20_000_000)
	bare := insert(30_000_000)

	overhead := (guarded - bare) / rows
	t.Logf("guard cost: %d rows guarded in %v, unguarded in %v -> %v per row",
		rows, guarded.Round(time.Millisecond), bare.Round(time.Millisecond), overhead)

	// The heaviest real burst this system has produced is 4,181 guarded rows in
	// a 271-second window (spec §0). At this ceiling that burst costs ~105 ms.
	// The ceiling is absolute rather than a ratio because a ratio is unstable on
	// a loaded CI runner.
	if overhead > 25*time.Microsecond {
		t.Fatalf("guard costs %v per row, over the 25µs budget -- "+
			"the seal is doing more work than one primary-key probe", overhead)
	}
	if overhead < 0 {
		t.Logf("guard cost measured below noise; treat as free")
	}
}
```

- [x] **Step 2: Run it and record the number**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go test ./shared/store/ -run TestFinalizationGuardCostOnTheHotPath -v 2>&1 | grep -E "guard cost|PASS|FAIL"
```

Expected shape (your absolute numbers depend on the machine; a single-digit
microsecond per-row cost is what the design predicts):

```
    finalization_integration_test.go:NNN: guard cost: 50000 rows guarded in 412ms, unguarded in 268ms -> 2.88µs per row
--- PASS: TestFinalizationGuardCostOnTheHotPath
```

**Write the measured per-row number into your notes.** Task 9's PR body quotes it, and
it is the answer to "what does this cost on the hot path?".

If it comes out above 25 µs, do not raise the budget. Check that the seal is a plain
`EXISTS` on the primary key and that `to_jsonb(NEW)` is genuinely below the
`IF NOT sealed …` early return — building the jsonb on the hot path is the one way this
gets expensive.

- [x] **Step 3: Commit**

```bash
git add backend/shared/store/finalization_integration_test.go
git commit -m "$(cat <<'EOF'
test(db): measure the C1 guard's per-row cost on the hot path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Document, full gate, PR

**Files:**
- Modify: `docs/backend/ARCHITECTURE.md`
- Modify: `docs/PRODUCT_ROADMAP.md`

- [x] **Step 1: Document the invariant where the schema is described**

In `docs/backend/ARCHITECTURE.md`, under **§3 Database schema (Neon Postgres)** and
after the Tier 1 list, add:

```markdown
### C1 — immutable once final (enforced, migration 0021)

Eight tables are recorded history once a match is complete, and the database
refuses to rewrite them. `match` and `match_detail` have been guarded since
`0001`; `appearance`, `match_event`, `match_commentary`, `match_play`,
`match_official` and `match_odds` since `0021`.

**"Final" is three different markers**, because three of those tables are written
*after* `match.finalized_at` is set, on the normal path:

| Tables | Seal | Guarded |
|---|---|---|
| `appearance`, `match_event`, `match_commentary` | `match.finalized_at` | INSERT, UPDATE, DELETE |
| `match_play` | a `match_play_archive` ledger row | INSERT, UPDATE, DELETE |
| `match_official`, `match_odds` | `match.finalized_at` | UPDATE, DELETE |

- **Curation still works.** A repoint of `team_id` off a *provisional* team is
  allowed on a sealed record — the same carve-out `0001` gives `match`. Anything
  else about the row changing in the same statement is refused. `player_id`
  repointing is refused outright until `player` gains a provisional flag.
- **A rejection is SQLSTATE `SA001`**, classified by
  `store.IsImmutableViolation(err)`. It means a bug in the writer, not a
  transient failure: log it, do not retry it.
- **Operator corrections** need both `SET scorearc.allow_final_writes = 'on'`
  *and* a session holding `TRUNCATE` on the table — which the schema owner has
  and `scorearc_ingester` deliberately never does.
- **Cost:** one primary-key probe per guarded row on the unsealed path,
  measured at single-digit microseconds. See
  `TestFinalizationGuardCostOnTheHotPath`.
```

In `docs/PRODUCT_ROADMAP.md`, add to the E7 table:

```markdown
| **T7.16** | Finalization invariants — C1 enforced in the schema | [plan](superpowers/plans/2026-08-18-finalization-invariants.md) |
```

- [x] **Step 2: Full backend gate**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
go build ./... && go vet ./... && go test -race ./...
```

Expected: `ok` for every package, no `FAIL`. Docker must be running — several packages
use testcontainers, and the `-race` run of `shared/store` is the long pole.

- [x] **Step 3: Frontend gate**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all four clean. Nothing in this plan touches `src/`, so a failure here means
a dirty tree, not your change.

- [x] **Step 4: Prove the reverse chain one more time, exactly as CI does it**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
docker run --rm -d --name pg-ci -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scorearc -p 55433:5432 postgres:16-alpine
sleep 4
export DIRECT_DSN="postgres://postgres:postgres@localhost:55433/scorearc?sslmode=disable"
for m in backend/migrations/*.up.sql; do psql "$DIRECT_DSN" -v ON_ERROR_STOP=1 -q -f "$m" || echo "FAILED UP $m"; done
for m in $(find backend/migrations -name '*.down.sql' | sort -r); do psql "$DIRECT_DSN" -v ON_ERROR_STOP=1 -q -f "$m" || echo "FAILED DOWN $m"; done
psql "$DIRECT_DSN" -X -c "SELECT count(*) AS tables_left FROM pg_tables WHERE schemaname='public';" \
  -c "SELECT count(*) AS roles_left FROM pg_roles WHERE rolname IN ('scorearc_reader','scorearc_ingester');"
docker rm -f pg-ci
```

Expected: no `FAILED` lines, `tables_left` `0`, `roles_left` `0`.

- [x] **Step 5: Open the PR**

```bash
git push -u origin fix/finalization-invariants
gh pr create --title "Make immutable-once-final an enforced database invariant" --body "$(cat <<'EOF'
## What

Six tables were immutable-once-final in policy and unguarded in the schema:
`appearance`, `match_event`, `match_commentary`, `match_play`, `match_official`,
`match_odds`. They were protected only by the accident that nothing re-polls a
finalized match. Migration `0021` adds the same `BEFORE … FOR EACH ROW` guard
`match` and `match_detail` have had since `0001`.

Implements §4.6 of `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`.

## "Final" is three markers, not one

Three of the six are written **after** `finalized_at` is set, on the normal path
(`ingester/matches.go:293` finalizes; `:302`, `:311`, `:312` then write plays,
officials and odds). A single `finalized_at IS NOT NULL` guard would have broken
production finalization, not just a backfill.

| Tables | Seal | Guarded |
|---|---|---|
| `appearance`, `match_event`, `match_commentary` | `match.finalized_at` | INSERT/UPDATE/DELETE |
| `match_play` | the `match_play_archive` ledger | INSERT/UPDATE/DELETE |
| `match_official`, `match_odds` | `match.finalized_at` | UPDATE/DELETE only |

`match_play` uses the ledger because that is already the pipeline's completion
marker (`plays.go:137`, `MatchesMissingPlays`): `retryMissingPlayStreams` re-runs
`WritePlays` on finalized matches until it lands. `cmd/play-backfill` writes the
ledger and the R2 object, never `match_play`, so it is unaffected — and
`match_play_archive` is deliberately left unguarded so re-recording keeps working.

`match_official` / `match_odds` guard UPDATE but not INSERT because Postgres fires
`BEFORE INSERT` for the proposed row *before* conflict detection, so an INSERT
guard would reject the finalization write while the UPDATE guard still catches
every re-poll.

## Curation is preserved

`promoteProvisionalTeam` already repoints `match_play.team_id` on finalized,
ledgered matches (`seed.go:308`). The guard reproduces `0001`'s carve-out: the
whole row is compared with `team_id`/`player_id` projected out, and a changed
`team_id` is accepted only when the id being replaced belonged to a *provisional*
team. Curated→curated is refused, and a legal repoint carrying a fact rewrite
alongside it is refused.

## Error surface

Rejections raise SQLSTATE `SA001` (a user-definable class Postgres can never
generate), classified by the new `store.IsImmutableViolation(err)`. No writer
changed — all five already wrap with `%w`, so `errors.As` reaches the `PgError`.
A connection failure returns `false`.

## Operator escape hatch

`SET scorearc.allow_final_writes = 'on'` **and** a session holding `TRUNCATE` on
the table. `scorearc_ingester` has never been granted `TRUNCATE` by any
migration, so it cannot switch off its own guard.

## Cost

Measured per-row overhead on the unsealed (hot) path: **<MEASURED VALUE FROM TASK 8>**
per row, from `TestFinalizationGuardCostOnTheHotPath` (50,000 rows in one
statement, trigger enabled vs disabled). The heaviest real burst this system has
produced is 4,181 guarded rows in a 271-second window; every one of those
statements already pays ~1 ms of Fly→Neon round trip.

## Testing

`shared/store/finalization_integration_test.go`, all against real Postgres via
testcontainers: 13 rejected mutations, 3 rejected late inserts, the finalization
transition still writing, the cascade still deleting, the play backlog and
`play-backfill` still writing, curation across sealed records, the carve-out's two
narrowing cases, the escape hatch in both directions, and the per-row cost.
`migrations_test.go` pins the seals, the INSERT carve-outs and the rollback.

## Migration

`0021`, above the watermark of 15 and above the `0016`–`0020` reserved by sibling
plans. Up and down both verified against an empty database in CI's exact order.
**Applying it to production is the user's call.**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [x] **Step 6: Stop and hand back**

Report to the user: the measured per-row cost, the PR link, and that **applying `0021`
to production Neon is their call**. Do not run `migrate up` against production, and do
not merge.

---

## Self-review notes — what nearly went wrong

Recorded so a reviewer can check the reasoning rather than re-derive it.

1. **The first draft of this plan sealed all six tables on `match.finalized_at`.** That
   is what §4.6 literally says and it would have broken production finalization the
   first time a match ended — `capturePlays`, `captureOfficials` and `captureOdds` all
   run after `FinalizeMatch` commits. The inventory in "The write inventory that decides
   each guard" is the only reason this plan does not ship that bug. Re-derive it (Task 1
   Step 2) before changing any predicate.

2. **The brief says `cmd/play-backfill` "writes plays for already finalized matches".**
   It does not — its `backfillRepository` is `MatchesMissingPlays` + `RecordPlayArchive`,
   and it never calls `WritePlays`. The path that really writes plays for finalized
   matches is the ingester's own `retryMissingPlayStreams`. The ledger seal resolves
   both, but do not go looking for a `WritePlays` call in `cmd/` and conclude the plan
   is wrong.

3. **`appearance` and `match_event` have a latent curation bug this plan does not
   fix.** `promoteProvisionalTeam` repoints `match`, `standing`, `standing_snapshot`,
   `squad_membership`, `player_season_stat` and `match_play` — but **not** `appearance`
   or `match_event`, both of which carry `team_id REFERENCES team(id)` with no cascade.
   A provisional club with appearances would fail the final `DELETE FROM team`. That is
   pre-existing, out of scope here, and the reason the carve-out is wired for those two
   tables anyway: adding their repoints later must be a one-line change to `seed.go`, not
   a schema rollback.

4. **`RETURN COALESCE(NEW, OLD)` was rejected.** `NEW` and `OLD` are plpgsql record
   variables and `COALESCE` over them is not reliably valid; the function branches on
   `TG_OP` and returns explicitly instead.

5. **`NEW.team_id` was rejected** in favour of `to_jsonb(NEW)->>'team_id'`. One function
   serves six tables and three have no such column; a field reference raises at execution
   time on those tables even when the branch would be false.

6. **The seal's `EXISTS` phrasing is load-bearing, twice** — once for the `match`
   cascade, once for the `JOIN match` inside the `archive` seal, because `match_play` and
   `match_play_archive` are sibling cascade children and Postgres does not order them.
