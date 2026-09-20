# Match recovery and freshness

This runbook does not authorize a production change. The website still uses
its existing ESPN DataStore. Reader response bodies and the three match states
are unchanged; freshness is additive metadata.

## Incident evidence: September 19, 2026

Initial inspection used `803094e`. Dependency-only #169 independently advanced
main to `2e79750`; GitHub recorded its ingester publication successful at
08:31 UTC. This recovery task did not initiate that merge or release.

At approximately 08:00 UTC, the reader still reported September 15
Rayo Vallecano--Espanyol live at 88 minutes/2-1 and Alaves--Valencia live at
45 minutes/0-0. `/healthz` returned 200. Exact configured ESPN rolling and
full-season date-range requests returned HTTP 400. Even a same-day hyphenated
range failed. A single September 15 date returned completed results; the
existing per-event summary independently confirmed Alaves--Valencia at 0-1,
with matching event, teams, league and season.

Later reader requests timed out from the investigation host, including separate
15-second `/healthz` and matches probes at 09:13--09:14 UTC; a later secondary
fetch also timed out. These do not prove a stopped worker or a deployment cause.
Fly had no usable local token and no production database connection was available.
Current image/machine state, OOM/restarts, lease errors and `ingest_run` rows
remain unverified.

The source-request failure and local recovery gap are established; the complete
production cause is not. Needed diagnosis access is read-only Fly
app/machine/event/log access and SQL SELECT on matches, crosswalks, ingest audit
and the schema ledger. Do not print credentials, full configuration or DSNs,
restart/deploy merely to test a theory, or manually edit scores.

## Recovery contract

The existing singleton worker owns all work. Normal range polling and full-season
reconciliation remain. Only HTTP 400 permits one current-UTC-date fallback;
validated events may advance facts, but the result remains **partial**, never
successful full-window emptiness or completed reconciliation. There is no
daily fan-out, new provider or second scheduler.

Each slow tick selects at most five due nonfinal matches per configured current
competition/season. Canonical/provider crosswalks address the existing summary
endpoint. Event, teams, league, season, kickoff, status/completion and scores are
validated before the returned match enters normal write/finalization safeguards.
Malformed supplied scores and shootout totals fail explicitly. Decisive shootout
totals take precedence over missing or incorrect winner flags; regulation scores
remain separate. Knockout bracket confirmation is not bypassed.

Attempts persist **before** the lookup. Never-attempted/oldest-attempted rows go
first; aliases cannot multiply a canonical match. Backoff starts at five minutes,
doubles and caps at six hours. Accepted nonfinal observations reset the next
attempt to five minutes after attempt start, even if an additive capture fails.
Explicit postponed/suspended observations independently wait six hours before
targeted refresh. Eligibility and deadlines survive restart.

The recovery pass allows 30 seconds of provider work, six seconds per lookup,
and five logical summaries: at most fifteen HTTP attempts under the existing
three-attempt client. Bounded bookkeeping may finish for up to two seconds after
cancellation. Ordinary scoreboard fallback permits at most two logical calls
(six HTTP attempts in the worst retry sequence). Existing bracket/detail/capture
paths keep their bounds. Recovery leaves ancillary provider calls to their
existing durable backlogs.

Elapsed time never establishes a score or finality. Canceled, abandoned and
forfeited provider results can retain omitted last-known scores without inventing
a result; supplied contradictory scores still fail. Global finalized-fact seals,
the singleton lease and graceful shutdown remain intact.

## Freshness and independent detection

Accepted observations have separate timestamps; unchanged facts need no
`match.updated_at` rewrite. Metadata statements are batched. Stored backlog rows,
invalid payloads and rejected regressions cannot renew source evidence. Additive
participation/capture failures remain visible in audit/cycle errors without
masquerading as failed core match polling.

See the [reader contract](../../backend/reader/README.md#match-freshness-additive-no-body-changes)
for all five CORS-visible headers, response examples and exact boundaries:

| Signal | Stale/overdue at equality |
|---|---|
| Live observation | 2 minutes: six nominal 20-second ticks |
| Competition poll | 20 minutes: four nominal five-minute ticks |
| Ordinary scheduled kickoff | 15 minutes overdue; detection only |
| Live kickoff | 4 hours overdue; never time-based finalization |
| Future scheduled observation | 25 hours: daily reconciliation plus processing/alignment margin |
| Suspended/postponed observation | 24 hours; explicit hiatus stays mutable |

Reader time detects a stopped worker. Active collections still require their
discovery heartbeat even if every stored match is final; an explicit single
finalized summary does not expire. A verified empty poll is distinct from missing
evidence. Off-season scopes are dormant only without unresolved matches. Body
and metadata share a bounded read-only repeatable-read snapshot, released before
any response write.

The [external watchdog](../../backend/reader/README.md#independent-watchdog-and-incident-state)
reads existing current-season match routes, fails for stale/unavailable data,
active partial/failed polling, HTTP errors and invalid contracts, and persists
OPEN/RESOLVED transition deduplication. Every unhealthy run still fails, even
when its transition message is suppressed. Missing/corrupt state fails closed.
It neither calls ESPN nor writes match data.

The workflow is **manual only**. Follow the reader README's explicit first-run
bootstrap and subsequent latest-state restore instructions. No cron, recipient,
paid service or external notification was activated. Logs are not delivered
alerts; native Actions failure notifications may repeat despite transition
deduplication.

Before enabling a five-minute cadence, separately approve the scheduler,
durable latest-state selection/retention and incident owner. Configure Actions
failure notifications or an explicitly approved transition-aware notifier, then
verify actual receipt for opening, continued failure, recovery and recurrence.
Detection/notification latency includes the next check, request/cache time and
platform scheduling; the mathematical threshold is not instantaneous delivery.

## Schema and separately approved release order

Migration `0023_match_sync` adds bookkeeping tables and indexes without weakening
fact seals. Existing binaries remain compatible with this additive migration.
New binaries check its tables, columns and SELECT access before listening/polling.
This narrow prerequisite check is **not** the full T21.2 head/dirty-ledger gate.

1. Obtain separate authorization for migration and releases selected by merge,
   or verify suitable approval holds first. Shared backend changes select both
   Fly services; TypeScript/package changes can select frontend publication too.
   A failed frontend does not hold Fly.
2. Read-only verify the intended database/schema, clean version-22 ledger and
   role grants; arrange approved backup/rollback precautions. A different,
   missing or dirty ledger requires reconciliation, not a forced version.
3. Only with explicit approval, use the operator's direct connection:
   `migrate -path backend/migrations -database "$DIRECT_DSN" goto 23`.
   Use the reviewed feature-branch/PR commit containing 0023, not an older main
   checkout that lacks it; confirm the migration files match the reviewed commit.
   Read back version 23, `dirty=false`, both tables and least-privilege grants.
   Do not place an owner connection in app configuration or auto-migrate.
4. Then authorize the reviewed normal main-CI release, preserving singleton and
   shutdown settings. Do not deploy a local tree or bypass the release workflow.
5. Complete live acceptance below before describing production as repaired.

Rollback is separately approved: revert dependent binaries through the normal
release path before schema rollback. Never drop bookkeeping while dependent
binaries run. Removing it loses observation/retry evidence, not match facts;
reapplying starts unknown until genuine source observations arrive.

## Post-deployment acceptance

- Compare affected matches with fresh verified provider data. Initial diagnostic
  examples are `01a00e9c-0ab5-76ec-a78f-fe12c3c455dd` and
  `01a00e9c-0d0d-7c09-8111-c05161ceee43`; recovery code does not hardcode them.
- Observe at least three normal cycles for affected active scopes and continuing
  accepted timestamps. Inspect cycle/audit errors and retry deadlines, not just
  machine count or `/healthz`. Keep unrelated T7.21 capture work separate.
- Confirm unchanged data renews observation evidence without fact rewrites.
  A continuing range failure remains partial/failed, not complete reconciliation.
- Run a synthetic freshness failure, repeated failure, recovery and recurrence
  through the external check. Verify failure exits, persistent deduplication and
  separately configured notification delivery without stopping production to test.
- Verify dormant suppression, stopped-worker expiry for active empty/all-final
  collections, and immutable finalized facts.

This is the match-specific slice of T17.3/T17.4, not every E17 endpoint.
Fly/SQL access, production migration, release, scheduling and notification
acceptance remain separately approved operations.
