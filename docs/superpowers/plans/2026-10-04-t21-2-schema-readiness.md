# T21.2 Fail-Closed Schema Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reader and ingester refuse to start (no listener; no lease-protected
seed, polling or writes) unless the migration ledger is readable, clean and at
exactly the version their embedded migrations declare, and their required
objects are readable by their own least-privilege role.

**Architecture:** One function, `migrations.CheckReady(ctx, db, probes...)`, next
to `migrations.Latest()`. It reads `schema_migrations` with `LIMIT 2` (so a
multi-row ledger is detected rather than silently sampled), compares against
`Latest()`, then runs each service's existing zero-row object probe. Every
failure is a `*ReadinessError` carrying only category, expected/applied version,
dirty flag, SQLSTATE and Go error type — never a driver message — so it is safe
for the top-level logger. No migration is needed: golang-migrate creates the
ledger before `0001`, whose `GRANT ... ON ALL TABLES` therefore already gives
both application roles `SELECT` on it (verified against real Postgres; an
initial guess that a `0024` grant was required was disproved by the test).

**Tech Stack:** Go 1.26, pgx v5, testcontainers Postgres 16, golang-migrate ledger layout.

## Policy decisions

- **Version policy is exact equality.** A binary cannot know whether a migration
  it does not carry is additive, so "ahead" is refused like "behind". Cost: an
  old binary that (re)starts between `migrate up` and its replacement's release
  refuses to start. On this Fly topology that is routine, not rare: the reader
  autostarts stopped spare machines on load (`auto_stop_machines = "stop"`,
  `min_machines_running = 1`), so any autostart — or a warm-machine restart —
  in the window fails `ahead`; the ingester (`strategy = "immediate"`, restart
  `always`) has no overlap, so a release against an unready schema stops the
  old worker and the new one crash-loops, halting play-stream capture, the one
  dataset ESPN prunes. That is the deliberate trade: fail closed over
  degraded writes. Mitigation is operational: apply migrations immediately
  before merge and let the merge release follow at once. A rollback build
  must keep every applied migration file (revert code, never an applied
  migration). Upgrade path if this bites: a DB-recorded compatibility floor
  written by migrations.
- **Absent/empty ledger is refused.** The psql bootstrap path (SETUP §5.3) is no
  longer valid for an environment that runs the services.
- **No bypass flag, no auto-migrate, no ledger writes.** The check is read-only.

## Failure matrix

| Ledger / object state | Category | SQLSTATE |
| --- | --- | --- |
| at `Latest()`, clean, probes pass | ready (nil) | — |
| `version < Latest()` | `behind` | — |
| `version > Latest()` | `ahead` | — |
| `dirty = true` | `dirty` | — |
| table missing | `ledger_absent` | 42P01 |
| zero rows | `ledger_empty` | — |
| >1 row, negative version, NULL/wrong-typed columns | `ledger_malformed` | 42703 when a column is missing |
| role cannot read ledger or a probed object | `permission_denied` | 42501 |
| probed table/column missing | `objects_missing` | 42P01 / 42703 |
| deadline exceeded | `timeout` | — |
| context cancelled | `canceled` | — |
| anything else | `query_failed` | when a PgError |
| binary embeds no readable migrations (build defect) | `embedded_migrations_invalid` | — |

## Files

- Create `backend/migrations/readiness.go`, `readiness_test.go` (fakes:
  sanitization), `readiness_integration_test.go` (real roles, full matrix).
- Modify `backend/shared/store/match_sync.go`: `CheckMatchSyncSchema` →
  `CheckSchemaReady` (policy + existing probe). Delete `schema_version.go` and
  its test (superseded).
- Modify `backend/ingester/main.go`: replace `reportSchemaDrift` +
  `CheckMatchSyncSchema` with `repo.CheckSchemaReady`, before the lease.
- Modify `backend/reader/main.go`: `checkFreshnessSchema` → `checkSchemaReadiness`.
- Test harnesses (store, reader, ingester) create the ledger before `0001`, as
  golang-migrate does, and record the last applied version.
- Docs: SETUP §5, RELEASES (schema readiness section, rollback), MATCH_FRESHNESS,
  reader README, CURRENT_STATE, PRODUCT_ROADMAP T21.2.

## Tasks

- [ ] **1. Policy, failing first.** Write `readiness_test.go` (fake querier:
  each category, no driver text in `Error()`, `errors.Unwrap == nil`) and
  `readiness_integration_test.go` (both roles × matrix, timeout via an owner
  holding `ACCESS EXCLUSIVE` on the ledger, cancellation mid-wait, full
  ledger readable by both roles without extra grants). Run `go test
  ./migrations` → FAIL (undefined `CheckReady`). Implement `readiness.go`.
  Run → PASS. Commit.
- [ ] **2. Ingester wiring.** Failing test in `ingester` calling `run()` against a
  behind ledger: exit 1, no competition rows seeded, advisory lock free.
  Compatible ledger: seeds, then stops on an invalid R2 URL, lock free. Wire
  `CheckSchemaReady`; delete `reportSchemaDrift`, `schema_version.go`. PASS. Commit.
- [ ] **3. Reader wiring.** Failing test calling `run()`: behind ledger returns a
  `*ReadinessError` and the port was never bound; compatible serves `/healthz`
  200 and returns nil on SIGTERM. Wire `checkSchemaReadiness`. PASS. Commit.
- [ ] **4. Gate.** `go build ./... && go test -race -count=1 ./... && go vet ./...`.
- [ ] **5. Docs** per the list above, including the pre-merge owner activation:
  read-only verify a clean ledger at the embedded head and role access before
  merging, because merge releases both services.
