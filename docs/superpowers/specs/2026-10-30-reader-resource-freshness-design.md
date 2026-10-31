# T17.3: resource freshness and availability

This is implementation design, not production acceptance or authorization. The
website stays on ESPN. JSON bodies, football facts, identities, query validation,
cache policies and the five existing match headers keep their contracts.

## Coverage inventory before implementation

`C/S` means `/v1/competitions/{comp}/{season}`. All twelve data routes are in
scope; `/healthz` is process/database health, not data evidence.

| Route | Existing metadata actually covers | Independent resources to disclose |
|---|---|---|
| C/S/matches | returned core matches and season discovery | core matches; identities; optional retained detail |
| C/S/calendar | season core matches | derived UTC calendar |
| C/S/bracket | recognized knockout core matches | reconstructed bracket; identities/placeholders |
| C/S/standings | nothing | provider tables; identities |
| C/S/leaders | nothing | requested goals/assists board; identity crosswalks |
| C/S/top-scorers | nothing | goals board projected to legacy shape |
| C/S/teams/{id} | core team schedule only | identity; standing/record; squad; season totals; schedule/detail |
| C/S/teams/{id}/squad | nothing | roster membership; identity; independently refreshed totals |
| C/S/players/{id} | nothing | identity/context; season totals; career; bounded game log |
| /v1/matches/{id} | single core match only | retained detail; participation/lineup derivation |
| /v1/matches/{id}/box-score | JSON capture availability only | participation observation/completion; identity |
| /v1/competitions/{comp}/news | nothing | ESPN proxy fetch (including cache hits) |

## Evidence and approach

Chosen approach: reuse durable resource-specific evidence where its writer can
prove the meaning, add collection observations where it cannot, and explicitly
declare unknown evidence. An audit-derived heartbeat is rejected: `ingest_run`
has no season/category/entity scope, is pruned after thirty days, is best effort,
and can report successful leader preservation. Row existence, request time,
`match.updated_at` and retry attempts are not observations. Changing response
bodies or implementing a frontend data store would exceed this task.

An additive migration after 0027 creates `resource_observation`, keyed by
competition, season, source, resource and subject, with accepted observation
time and row count. Resources are `standings`, `leaders` (subject goals/assists)
and `squad` (subject canonical team). No timestamps are backfilled from legacy
rows or migration time. Replacement writers stamp evidence in the same
transaction as accepted facts. Standings/leader memo hits renew only metadata;
the memo still records only committed facts. A validated empty source can
establish zero only if the stored collection is also empty. Retained nonempty
collections survive missing/empty/malformed/partial/truncated source input and
their last accepted observation does not advance. Failed attempts do not renew
the clock. Shrink/validation guards remain conservative.

Statistics validation distinguishes an explicit empty category from an absent
category and validates the supplied collection before selecting its first thirty
rows. Standings keep their strict mapper and season validation. Supplied
truncation/pagination metadata must not establish completeness. Silent upstream
omission without a count or contradictory prior collection remains unknowable.

Squad observations cover membership only. The upstream roster URL is current,
not season-addressable; provenance must say current roster attributed to the
ingester's configured season. Player totals use their own accepted-write
`player_season_stat.observed_at`: omitted stats do not update that row, including
when memberships refresh or players depart. Career uses `player.bio_observed_at`,
atomically written with history, including validated empty history. These nullable
columns are added without defaults or backfill in 0028: review exposed malformed
inputs that could previously renew `updated_at`/`bio_fetched_at`, so those older
clocks cannot certify validated evidence. Existing refresh eligibility is unchanged;
availability remains unknown until the next normally scheduled accepted write. Identity
has mixed curated/provider origins and no complete observation clock.

The participation view adds `completed_at` to its existing two columns, exposing
no retry internals. Completed final participation has durable non-expiring
accepted evidence; pending/partial/legacy captures remain distinct. Match seals
never attest participation. Retained detail blobs preserve individual missing
sections, so their `updated_at` cannot attest the complete blob; metadata states
partial/unavailable rather than inventing observation times.

## Additive wire contract

Every successful data route sends CORS-visible `X-ScoreArc-Resources`: bounded
compact JSON `{"version":1,"resources":{...}}`, with fixed component names,
never one header item per player/match. Each component has `status`
(`fresh|empty|stale|unavailable|dormant`), `availability`
(`complete|empty|partial|pending|unavailable`), `source`, `derivation`, `scope`,
and nullable RFC3339 `observedAt` and `finalizedAt`. Resource status is not a
claim that every nullable measurement is known. Existing match headers remain
unchanged; consumers use the new component map for composite responses.

Missing/invalid/future observation time is unavailable. A complete successful
zero observation is empty until its expiry boundary. Expiry is inclusive.
Nonempty stale facts remain in the unchanged body. Unknown legacy evidence is
200 with explicit unavailable metadata; failure to read metadata is sanitized
500/no-store, never a healthy default. Existing team/squad child degradation
remains 200/no-store with that component unavailable. Cancellation is fatal.

| Resource | Expiry | Cadence/rationale |
|---|---|---|
| standings and each leader metric | 20 minutes | four nominal five-minute slow ticks; independent of match polling |
| current roster membership and supplied season totals | 25 hours | one UTC-day roster refresh plus tick/processing margin |
| career history | 32 days | thirty-day eligibility plus bounded twenty-player/five-minute sweep (~30h for 6,300 players) |
| news proxy | 90 seconds | existing process cache TTL; original successful fetch observation retained |
| core matches | unchanged | existing match contract, including exact boundaries |
| completed sealed participation | no expiry | atomic terminal capture, not a mutable heartbeat |

Season-scoped renewable resources may be dormant only outside the requested
season and with no unresolved match/participation work; missing evidence must
remain visible in availability. Career/global identity/news are not made
dormant by a season flag. Unknown detail is never made fresh by dormancy.

All database body and metadata reads share the existing bounded read-only
repeatable-read snapshot. Standings/leaders/top-scorers/squad join that seam.
One set-based metadata read per request uses the exact requested scope/returned
selection, bounded aggregate probes and no per-entity SQL. It must not repeat a
full-season match projection for a filtered response. Release snapshots before
any response write, including errors, with cancellation-independent cleanup.
Use savepoints for degradable squad queries inside snapshots.

News remains a proxy with its current singleflight, timeout, cancellation,
cloning and failure behavior. Fetch age is the successful provider fetch age,
not publication time or cache-hit request time. T16.6's rights/ownership decision
and unrelated T21.4 work are not closed here.

## Validation and rollout

Failing-first tests cover exact boundaries, invalid times, healthy empty versus
failed empty, stale retained rows, partial category refresh, restart/stopped
worker, season isolation, dormant/unresolved work, composite scope, news cache
hits, metadata failures, snapshot interleaving/release/cancellation, query
bounds/counts and least-privilege Postgres reads. Replace the registered gap
only with positive shared TS/Go/OpenAPI/Postgres assertions.

Run all repository gates and the installed Knights panel, including a separate
fresh final documented-state review. Reconcile the logging-only T21.4 change
after it merges and rerun affected checks. Do not change watchdog delivery.

Migration-before-merge warning belongs at the top of the PR. Production 0027
and Teams/Players/Leaders are already deployed per the owner; do not repeat
them. Applying the next migration and the exact-head binary transition need
separate owner authorization. Keep schema gates, grants and owner credentials
unchanged in principle; no application/CI owner connection or auto-migration.
