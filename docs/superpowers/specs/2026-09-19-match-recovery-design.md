# Automatic match recovery and freshness

## Objective and evidence

Initial baseline: `origin/main` at `803094e`, fetched September 19, 2026. The worktree
started clean. PRs #163, #171 and #172 are merged; they are not reimplemented.
The September 15 main run `34944474666` passed tests and all release jobs.
During this task, dependency-only PR #169 independently advanced main to
`2e79750`; the task branch was fast-forwarded without changing its owned edits.
GitHub recorded ingester publication for that SHA at 08:31 UTC September 19.
This task did not initiate that release. A subsequent public-reader request
timed out, so it is not evidence of either recovery or continued stale values.
Separate 15-second probes at 09:13--09:14 UTC also timed out for `/healthz`
and the matches route from this host. Current reachability is therefore
unverified; no worker or deployment cause is inferred from those timeouts.

Read-only observations at approximately 08:03 UTC September 19:

- The public reader still reports September 15 Rayo Vallecano--Espanyol live
  at 88 minutes, 2-1, and Alaves--Valencia live at 45 minutes, 0-0.
  Its database-only `/healthz` returns 200.
- The configured ESPN rolling and full-season date-range URLs return HTTP 400
  (`Failed to get events endpoint.`). Even a same-day hyphenated range fails,
  with and without `limit`; a single `dates=20260915` returns 200.
- That single-date response reports both matches complete (2-1 and 0-1).
  The existing per-event summary endpoint independently reports Alaves--Valencia
  complete at 0-1, with matching event/team/league/season identity.
- The local code reproduces the coverage gap: the durable backlog selects only
  already-finished rows; `Summary` cannot advance its caller's match state.

This establishes a locally reproducible source-request failure and a recovery
gap, not the production worker's complete failure history. Fly CLI has no
access token; no production database DSN is available. Vercel team access works,
but its integration listing exposes no database configuration. Machine events,
OOM/restart history, lease errors and `ingest_run` rows remain unverified.
No production writes, restarts, deployments or credential changes are authorized.

## Approach

Reuse the existing singleton worker, source client, identity crosswalk and
guarded match/finalization pipeline. Do not create a second ingester.

Three alternatives were considered:

1. **Selected:** bounded targeted recovery of stored nonfinal rows, separate
   observation bookkeeping, and an explicitly degraded single-date fallback.
2. Adding live rows to `UnfinalizedMatches` alone cannot obtain a fresh state and
   can merely rewrite stale facts. Rejected.
3. Expanding every failed range into daily requests would multiply a rolling
   poll into 38 calls (and a season into hundreds). Rejected.

## Source trust and degraded polling

Keep the normal 30-day-past/7-day-future range, full-season reconciliation,
season filtering, limits and existing retry limits. A typed HTTP 400 from the
range request permits one current-UTC-date lookup, within the season. Its
validated events may advance facts, but the call still returns an explicit
partial-coverage error. It cannot establish full-window emptiness, dormancy,
successful full-season reconciliation or healthy polling. Other failures remain
failures. This restores today's updates without hiding the upstream range fault.

Targeted recovery uses the existing summary endpoint, not an inferred score.
It validates event and competition IDs, home/away provider IDs, league slug,
season year, kickoff, status consistency and nonnegative scores. It returns a
new provider-shaped match and already-parsed summary so recovery need not fetch
the summary twice. Suspended/postponed states stay mutable; terminal cancellation,
abandonment and forfeiture use the existing terminal policy. Shootout totals
remain separate from regulation scores. No time-based finalization is allowed.
Scoreboard, bracket and summary observations share status validation. Novel
descriptive names can use unambiguous provider phase/completion flags; known
contradictions and ambiguous post/incomplete statuses remain explicit errors.

## Durable recovery

Migration 0023 adds source-observation and retry bookkeeping outside immutable
match facts, plus competition/season polling status. Existing finalized-data
triggers and correction privileges are unchanged.

Each slow tick selects at most five due nonfinal matches per competition,
ordered by last attempted time (never-attempted first), kickoff and canonical
ID. Live rows with missing/old observations, ordinary scheduled rows at least
15 minutes overdue, and suspended/postponed rows needing refresh are eligible.
Selection uses one provider crosswalk per canonical match; aliases never
multiply a batch.

Persist the attempt and next retry **before** the network call. Exponential
backoff starts at five minutes and caps at six hours. Successful nonfinal
observations clear failure state but retain a minimum retry interval; unresolved
provider-backed delays are not busy loops. Restarting cannot reset the queue or
backoff. Each lookup has a six-second deadline and each competition's recovery
pass a thirty-second budget. At most five lookups, each with the existing
three-attempt client bound: fifteen HTTP attempts per competition/slow tick.
That is the targeted-recovery budget; post-finalization play/official/odds
requests remain owned by their existing, separately bounded durable backlogs.
Recovery does not run those follow-up provider calls inline. Normal competition
concurrency remains three.

Recovery re-enters `processMatches` with the canonical identity from the
crosswalk. Existing state-preservation and bracket-confirmation rules still
apply; recovery does not freeze an unconfirmed bracket. A verified provider
regression that the normal guards reject is an explicit failed recovery.

## Freshness contract

Successful validated observations renew separate timestamps even when the
no-change guard skips fact writes. Stored backlog rows and failed/contradictory
payloads never renew them. `updated_at`, API response time and process liveness
are not source freshness. Metadata statements are batched per competition pass,
not one additional network round trip per unchanged match.
Polling health covers accepted match facts, not unrelated participation,
play-stream or other additive capture failures; those remain explicit in their
existing cycle/audit errors and do not masquerade as failed match polling.

Preserve all existing body shapes and the three-value match-state enum. Existing
match-bearing reader routes expose additive, CORS-visible headers:

- `X-ScoreArc-Freshness`: `fresh`, `empty`, `dormant`, `stale`, or `unavailable`.
- `X-ScoreArc-Observed-At`: oldest available relevant successful observation,
  when known; a conservative aggregate, not response time.
- `X-ScoreArc-Poll-Status`: `ok`, `partial`, `failed`, or `unknown`.
- `X-ScoreArc-Stale-Matches` and `X-ScoreArc-Overdue-Matches`: affected counts.

The collection contract remains a bare array. TypeScript parses these headers
without switching the site's DataStore to the reader. OpenAPI documents the
headers. Missing schema/bookkeeping does not silently claim freshness.

Thresholds use an injectable clock; age equal to a threshold is stale:

| Signal | Threshold | Reason |
|---|---|---|
| Live observation | 2 minutes | Six nominal 20-second ticks |
| Competition poll | 20 minutes | Four nominal five-minute ticks |
| Ordinary scheduled kickoff without progression | 15 minutes | Detection, never inference of finality |
| Live kickoff still unconfirmed | 4 hours | Includes normal extra time/shootouts; only marks overdue |
| Suspended/postponed observation | 24 hours | Explicit provider hiatus, with bounded retry |
| Future scheduled observation | 25 hours | Daily reconciliation plus an hour for tick/processing margin; poll heartbeat still applies |

Finalized facts do not expire, but an active collection still requires its
discovery/poll heartbeat even if all currently stored matches are final.
A known successful empty in-season poll is
`empty`, not `unavailable`; its heartbeat still expires. Expected off-season
inactivity is `dormant` only outside the configured season window and without
unresolved nonfinal matches. Missing observations in an active scope are
`unavailable`. Partial/failed polling is visible even when individual facts were
successfully recovered. Freshness is computed in the reader, so a stopped
ingester is detectable.

## Independent watchdog

A bounded external check reads the existing match route for configured current
seasons, validates the new headers and fails for stale, unavailable, partial or
failed polling in active scopes. Verified dormant scopes suppress expected
off-season polling inactivity. It reports competition/season and counts, not secrets or raw
provider payloads. A durable state file deduplicates incident transitions;
recovery emits one resolution and a later recurrence opens a new incident.
State corruption and HTTP/contract failures fail closed.

Provide a manually dispatchable GitHub Actions check and runbook. No production
cron or external notification destination is activated. The runbook describes
the separately authorized cadence, durable-state location and Actions
notification setup; a log alone is not called a delivered alert.

## Compatibility, rollout and acceptance

Migration apply is manual and separately approved. Apply 0023 before deploying
dependent binaries; verify the ledger and least-privilege grants. No automatic
migration. General schema-readiness enforcement remains T21.2; this slice must
document and guard its own dependency rather than assume it exists.

The website remains ESPN-backed. T7.21 participation retries, provider changes,
historical backfill expansion, AI/MCP and new sports-data distribution are out
of scope.

After separately approved migration/release: confirm the incident examples
reach independently verified provider states; observe at least three successful
poll cycles and continuing observation timestamps; verify unchanged facts do not
rewrite; test a simulated stale response through the watchdog, including
deduplication and recovery; activate any schedule/notification only with approval.
An unresolved provider date-range failure remains explicitly degraded.

## Required evidence

Deterministic source and runner regressions; real PostgreSQL queue, restart,
observation and immutability tests; reader/Go/TypeScript/OpenAPI contract tests;
watchdog transition tests; backend build/race/vet and frontend tests/typecheck.
Then the configured four-model Knights implementation loop and separate final
documented-state review precede a normal commit/push and active PR. No merge.
