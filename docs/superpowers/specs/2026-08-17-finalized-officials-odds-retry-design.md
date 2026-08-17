# Finalized Officials and Odds Retry Design

**Date:** 2026-08-17
**Scope:** Correct T7.14/T7.15 odds-domain validation and make finalized officials
and fixed-odds capture durable without changing match finalization.

## Problem

Two correctness gaps remain after the officials and odds ingestion merge:

1. `parseOddsDecimal` accepted every finite `float64`. PostgreSQL stores spreads
   and totals as `numeric(5,2)` after rounding to two decimals, so the real edge
   is the rounded value, not the raw input. A provider value such as `999.995`
   rounds to `1000.00`, PostgreSQL rejects it, and every valid row in that
   transactional multi-book write rolls back; `999.994` rounds to `999.99` and
   is accepted. Flattened current values bypass `parseOddsDecimal` and need the
   same boundary.
2. Officials and fixed opening/closing odds run only when `FinalizeMatch` returns
   `didFinalize=true`. A transient core-API or database failure after that edge is
   audited but never retried. Table absence cannot be treated as pending because
   an empty officials response and a match with no priced market are valid,
   completed outcomes.

## Goals

- Reject malformed, non-finite, and out-of-range spread/total values in the ESPN
  mapper while retaining every other valid field and provider.
- Record explicit durable completion for finalized officials and fixed odds,
  including valid empty responses.
- Persist failed attempts with a durable next retry time, survive process
  restarts, and stop selecting a capture after it succeeds.
- Preserve live current-odds sampling, final score/detail immutability, the
  no-DELETE crew policy, and existing `officials`/`odds` audit telemetry.
- Exercise migrations and runtime behavior as the least-privilege ingester role.

## Non-goals

- Positionless officials remain stored with `role=''`. That is a recorded
  non-blocking follow-up and is not required for retry correctness.
- No retry is added for live odds samples; a missed historical sample cannot be
  reconstructed.
- No DELETE permission is added to officials, fixed odds, sampled odds, or the
  completion ledger.

## Considered Approaches

### 1. Generic final-capture status table (selected)

Add one row per `(match_id, kind)` with attempt count, last attempt, next retry,
completion time, and last error. The two kinds are `officials` and `fixed_odds`.
Missing rows are initially due; completed rows are never due; failed rows become
due only at their persisted retry time.

This is the smallest design that shares retry mechanics, distinguishes valid
empty completion, survives restarts, and keeps operational state outside the
immutable match row.

### 2. Completion and retry columns on `match` (rejected)

This avoids a join, but it mixes optional enrichment state into the canonical
scoreline row and requires widening the finalized-row immutability trigger.
Changing that protection for additive captures creates unnecessary coupling and
risk.

### 3. Separate officials and odds ledgers, or data-row absence (rejected)

Separate ledgers duplicate identical scheduling and permission logic. Using
`match_official` or `match_odds` absence as the marker retries valid empty/no-market
responses forever and therefore cannot satisfy the completion contract.

## Persistence

Migration `0016_final_capture_status` creates:

```text
match_final_capture_status
  match_id             uuid FK match(id) ON DELETE CASCADE
  kind                 text CHECK kind IN ('officials', 'fixed_odds')
  attempt_count        int CHECK attempt_count >= 1
  last_attempted_at    timestamptz
  retry_at             timestamptz nullable
  completed_at         timestamptz nullable
  last_error           text
  PK (match_id, kind)
```

Exactly one of `retry_at` and `completed_at` is non-null. A partial index on
`retry_at` covers pending rows. The migration explicitly revokes inherited reader
access, grants the ingester only `SELECT`, `INSERT`, and `UPDATE`, and grants no
DELETE. The down migration drops only this table.

Store operations are:

- `CompleteFinalCapture`: upsert a monotonic completion row. A later failed
  duplicate attempt cannot reopen it.
- `ScheduleFinalCaptureRetry`: upsert a failed attempt and its next retry time,
  but preserve an already completed row.
- `PendingFinalCaptures`: return due capture kinds for finalized, played matches
  in one competition and season. It deterministically chooses one provider event
  id, excludes canceled/abandoned/forfeit statuses, orders oldest due work first,
  and applies a hard limit.

## Ingester Flow

The existing finalization edge still attempts officials and odds immediately:

1. Fetch officials.
2. Resolve and write a non-empty crew, or accept an explicit empty crew.
3. Mark `officials` complete only after the successful write/no-op; otherwise
   schedule a retry.
4. Fetch odds once.
5. Preserve the final current-line snapshot attempt.
6. Write fixed open/close rows, or accept an explicit no-provider response.
7. Mark `fixed_odds` complete only after the fixed write/no-op; otherwise
   schedule a retry.

Every slow tick also loads at most 10 due final-capture tasks per competition.
Retries use a 30-minute persisted interval. An officials retry fetches only
officials. A fixed-odds retry fetches and writes only fixed odds; it does not
append a post-match current-line sample. Live polling still samples current odds
exactly as before, and a completed kind is never selected again, even after a
restart.

Existing `officials` and `odds` ingest runs remain the per-attempt telemetry.
`final_capture_backlog` records backlog selection and aggregate retry health.
These additive errors remain off the score/detail finalization error path.

The cost bound is explicit: an initial finalized match uses at most two core API
requests, and a slow tick performs at most 10 retry requests per competition.
The same failed kind is eligible at most once per 30 minutes.

## Odds Boundary

Both nested string values and flattened numeric values pass through one
PostgreSQL-equivalent `numeric(5,2)` guard. The mapper rounds to two decimals
for validation only, then returns the original accepted value so the normal
database write performs its own scale normalization. Concretely, `±999.994` is
accepted because PostgreSQL stores `±999.99`, while `±999.995` becomes `nil`
because PostgreSQL rounds it to `±1000.00` and rejects it. Empty strings,
malformed numbers, NaN, and infinities also become `nil`.

Validation is field-local. One invalid spread or total does not drop its provider,
does not drop other valid fields from that provider, and cannot poison another
provider's PostgreSQL transaction.

## Failure Semantics

- Provider fetch, identity resolution, or fact write failure: audit the original
  contextual error and schedule a durable retry.
- Valid empty crew/no market: mark complete with no fact rows.
- Fact write succeeds but completion write fails: audit failure and leave the
  capture selectable; idempotent fact writes make the retry safe.
- Failure-state write also fails: preserve and audit both causes. A missing status
  row remains immediately selectable because no durable cadence can be recorded
  while persistence is unavailable.
- Context cancellation: propagate and audit it; never record false completion.
- Duplicate or out-of-order attempt: completion is monotonic and cannot be
  reopened by a later failure.

## Tests and Gate

Strict RED-GREEN tests cover:

- Mapper acceptance at the exact bounds and rounded-in-range edges
  (`±999.99`, `±999.994`), rejection at the rounded-overflow edge
  (`±999.995`), malformed/non-finite inputs, and flattened values.
- Mapper-to-store multi-book isolation against real PostgreSQL.
- Migration shape, grants, complete rollback, populated rollback, and no new
  DELETE privilege.
- Real-PostgreSQL due selection, least-role reads/writes, terminal-status
  exclusion, persisted cadence, restart durability, monotonic completion, and
  valid-empty completion.
- Runner transient fetch/write failures, no immediate retry, eventual success
  after the retry time, restart behavior, no reprocessing after success, and no
  current snapshot during a fixed-odds retry.

Before the PR: run the exact backend and repository gates, fresh migration
up/reverse-down, populated `0016` rollback, two independent final-diff reviews,
and hosted CI/Vercel checks.
