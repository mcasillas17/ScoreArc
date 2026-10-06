# Match recovery and freshness

This runbook does not authorize a production change. The website still uses
its existing ESPN DataStore. Reader response bodies and the three match states
are unchanged; freshness is additive metadata.

## Current release evidence — October 2, 2026

#173 recovery is merged and released; #183's monthly scoreboard repair
(`969e512`, September 26) and cancellation fix are also merged and released.
October 2 at 06:42:54 UTC, all ten reader current-season match scopes returned
200 with `poll=ok`, nine fresh / World Cup dormant, and zero stale/overdue
counts. These are bounded match-contract observations, not full sustained
completeness, archive/squad/player coverage or notification acceptance.
T17.4 scheduling/notification activation remains open. See
[CURRENT_STATE](../CURRENT_STATE.md#october-2-reconciliation) for exact release
records, the distinct October 2 Fly eligibility failure before publication,
and remaining limits. Do not repeat completed migration/recovery operations.

## September 21 historical status and scoreboard repair

**Completed operations, reported by the owner:** the Neon quota issue was
resolved; migration `0023_match_sync` was applied and verified clean at version
23 with application grants on September 20; reader and ingester recovery releases
succeeded. The original September 15 incidents automatically finalized as
Rayo--Espanyol 2-1 and Alaves--Valencia 0-1, independently checked against provider
summaries. Do not reapply that migration or repeat deployment recovery.

At approximately 07:25 UTC September 21, the reader was healthy and those
incidents were no longer overdue/live, but LaLiga still reported poll `partial`
and freshness `unavailable`. At that capture the repair had **local validation
only**; the September 26 release above supersedes its undeployed status, not
the remaining sustained reconciliation/transient-failure acceptance.

Bounded probes at 07:34--07:39 UTC reproduced the exact configured hyphenated
date-range 400, including same-day ranges. Removing/changing the limit, adding
the season, encoding the hyphen and trying Premier League did not fix it.
The response was `{"code":400,"message":"Failed to get events endpoint."}`.
Compact `dates=YYYYMM&limit=1000` worked across LaLiga, MLS, Liga MX and World Cup.
LaLiga September's 39 IDs equaled September's subset of the year selector and
included all three September 15 single-date IDs. `page=2&limit=2` repeated page
1's two IDs, so pagination is not assumed. The provider's internal cause and
permanence of this undocumented contract are unknown.

### Complete-window source contract

The adapter issues each required compact month selector once, sequentially.
Provider calendar dates are not UTC: the recorded Liga MX January response
contains February 1 01:00/01:10 UTC events that are absent from February's
response. The adapter includes the months touched by one extra UTC day at each
window edge, then filters to the original half-open UTC interval. It does not
invent a timezone query parameter. Rolling windows retain days -30 through +7;
full windows retain calendar/split-season and configured tournament bounds.

Every partition must have the requested league, an explicit events array, fewer
than 1,000 raw events, no incomplete count/page metadata, and valid
identity/date/status/score data. Event dates must fit the queried month's
one-day calendar envelope; retained events must match the configured season
year. Exact UTC bounds separate apertura/clausura and padding seasons.
Duplicate conflicts are checked **before** window filtering, including a
reschedule with one copy outside the window. Identical duplicates merge in
deterministic provider-ID order.

Only a completely validated set can establish an empty window, successful poll
or completed reconciliation. Truncation, malformed data or any failed month
cannot renew complete success or delete known matches. Only HTTP 400 permits
the existing current-UTC-date partial fallback while inside the season. The
fallback uses the same league, explicit season-year and duplicate-conflict
guards, plus its provider-day envelope and requested UTC window. It cannot
establish completeness, even when empty. Targeted summary recovery remains independent.

The endpoint publishes no authoritative total or pagination cursor. This
coverage claim means every required selector passed the observed contract,
**not** proof that ESPN knows every real-world match. Silent omissions below the
cap remain a limitation; compare representative dates/events after release.
Do not turn cap failures into success, widen freshness thresholds, or scan every
day of a season to make the signal green.

### Request, memory and write budgets

| Discovery operation | Maximum logical requests | Maximum physical HTTP attempts |
|---|---:|---:|
| One rolling scoreboard, live or ordinary slow | 3 months + 1 possible fallback = 4 | 12 |
| One full-season scoreboard | 14 months + 1 possible fallback = 15 | 45 |
| One rolling bracket without explicit range | 3 months | 9 |
| Configured World Cup bracket | 2 months | 6 |
| One full-season bracket without explicit range | 14 months | 42 |
| Ten configured competitions, live/ordinary slow discovery including brackets | <=45 | <=135 |
| All ten current-season sweeps including brackets | <=154 | <=462 |

The last two rows are conservative ceilings with no cache hits and every
scoreboard taking its fallback; inactive competitions may be skipped. Current
full-season counts are 128 scoreboard month selectors plus 16 bracket selectors
plus at most ten fallbacks. Each logical request has at most three physical
attempts: a final 400 can itself follow two retryable failures. Failure stops
the current window; there is no page loop or daily subdivision.

These are **discovery** budgets, not a claim that ancillary ESPN traffic is
zero. Each slow recovery pass additionally allows five logical summaries per
competition (15 attempts), at most 50/150 across the registry. Existing ordinary
summary, play, officials, odds, standings, roster and bio paths keep their
separate limits and costs; discovery does not add a second scheduler.

Windows have a 45-second total ceiling including fallback. The existing
18-second live / 270-second slow whole-cycle deadlines can shorten it. Requests
are sequential within a window, with at most three competitions active; client
attempt timeout remains 15 seconds, Retry-After is capped at 30 seconds. Each
attempt checks caller cancellation before starting, even if a retry timer and
cancellation become ready together; expired contexts cannot start another attempt.
Each response, accumulated window bytes and the shared short scoreboard cache are
bounded to 16 MiB each. New scoreboard polls discard the same competition's
cached bytes; the five-second cache only saves subsequent bracket reads, not
later poll evidence. Budget calculations never rely on a cache hit.

Successful season sweeps remain daily; failed sweeps retry no more than every
30 minutes. A restart may repeat one bounded sweep. Rolling month overfetch
adds calendar-edge bytes, not extra retained matches or historical DB writes.
No persistent partition progress or new schema is needed.

For `M` accepted nonfinal matches, observation metadata costs at most `M` rows
in one batch plus one competition poll upsert; unchanged `match` facts have
zero upserts. Changed facts/finalization retain the existing guarded writes,
crosswalk resolution and ancillary work. The raw event ceilings are 2,997 for
three monthly selectors and 13,986 for fourteen (before deduplication/window
filtering and the 16 MiB window cap); they are bounds, not expected workloads.
Already-finalized matches are not rewritten or re-observed.

Local real-adapter read-only evidence: LaLiga rolling 61 matches/2 requests;
LaLiga full 2026-27 season 380 matches/14 requests; Liga MX rolling 52 matches/2
requests, all `err=nil`, one HTTP attempt per request. Synthetic/recorded tests
and real Postgres exercise complete empty polls, unknown discovery, unchanged
facts, reschedules, normal finalization, failure preservation and targeted
recovery. None of these local checks constitute production acceptance.

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

The existing singleton worker owns all work. Complete monthly-window polling and
full-season reconciliation use the source contract above. Only HTTP 400 permits one current-UTC-date fallback;
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
cancellation. Scoreboard and bracket request ceilings are listed above;
detail/capture paths keep their existing bounds. Recovery leaves ancillary provider calls to their
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

## Durable match monitor (activation disabled)

The workflow remains manual-only; its job and CLI require exact repository
variable `MATCH_FRESHNESS_ENABLED=true`. Absent/false means **zero reader checks
and zero webhook sends**. Delivery additionally requires exact
`MATCH_FRESHNESS_DELIVERY_ENABLED=true` and the owner-approved secret
`MATCH_FRESHNESS_WEBHOOK_URL`. Neither variable nor secret is created by this
change. A commented five-minute cron recipe is provided; no active schedule is
installed. Only main first-attempt runs are trusted; use a new run, not rerun.

### State restoration and ordering

The version-2 envelope binds repository, workflow, main ref, run ID/number/attempt,
SHA, reader origin, exact scope set, epoch, monotonically increasing event sequence
and timestamps. It separates active incidents, FIFO pending events and the most
recent 32 acknowledged event IDs. Recurrence has a new incident ID; recovery
references its opening ID. A pending OPEN remains ahead of its later RESOLVED and
recurrence. Valid empty/dormant results keep their existing reader semantics;
timeouts, malformed payloads, unknown emptiness and active partial/failed polls
cannot resolve an incident. No reader threshold changes are made.

The selector uses the repository's trusted workflow metadata and authenticated
GitHub API. It considers failed state-bearing runs, never just successful runs.
Within the newest eligible run it prefers `match-freshness-state` (acknowledged)
to `match-freshness-pending` (before send). It validates artifact/run provenance,
expiry, sizes, ordering and bounded API results before download, then validates
the JSON envelope before checks. A newer preparation attempt without a checkpoint
is a lost-state barrier. Missing, corrupt, expired, ambiguous, incompatible or
unreadable newest state never causes fallback to an older artifact or bootstrap.
Only proven disabled/pre-preparation skipped runs may be passed over.

`initialize_state=true` is for the first history only, after complete bounded
history enumeration proves no prior state or uncertain preparation. Otherwise use
false (default). The former `state_run_id` override is removed. Legacy version-1
state, changed origin/scopes, exhausted retries and incompatible code versions
require an owner-reviewed migration/reconciliation; the automation has no reset,
drop-event or forced older-state switch. Preserve old incident IDs and pending
ordering when designing such a migration. Do not describe resetting as recovery.

### Delivery and crash boundaries

1. Prepare uses the existing bounded checker, queues transitions, reserves attempts
   and atomically saves local state under an exclusive lock.
2. Upload `match-freshness-pending`. Failure prevents **all sends**. The next run
   sees the attempted preparation and refuses rollback if no checkpoint survives.
3. Send up to ten reserved events sequentially, stopping on the first unsuccessful
   acknowledgment. The body contains only `eventId`, `incidentId`, competition,
   season, OPEN/RESOLVED status, occurrence timestamp, original diagnostic run URL,
   match/stale/overdue counts, freshness/poll enums and sanitized error category.
   No payload, team/player values, dependency messages or credentials are sent.
4. Save acknowledgments and upload `match-freshness-state`. If the process crashes
   or this upload fails after the receiver accepted a message, the next run uses
   the pending snapshot and may resend the **same event ID**.

The one transport is HTTP POST to an owner-controlled HTTPS webhook (HTTP is
accepted only for loopback tests). It sends `Content-Type: application/json` and
`Idempotency-Key: <eventId>`. The receiver must return **HTTP 200** with JSON
`{"eventId":"<same ID>"}` after durable acceptance. A generic Slack/Discord webhook
is not automatically compatible with this acknowledgment contract. Redirects,
timeouts, 429, all other status codes, malformed or mismatched acknowledgment are
explicit delivery failures; response contents and secret URL are never logged.
The receiver should deduplicate by event ID and preserve acceptance ordering.

This is bounded **at-least-once retry**, subject to retained state and eventual
receiver success within the retry budget, not guaranteed eventual delivery or
exactly-once delivery. Without receiver deduplication, ambiguous outcomes produce
duplicates. Even a valid webhook acknowledgment proves protocol acceptance, not
human receipt. Workflow success alone is weaker still.

Reservations persist before send, so a crash can consume an attempt without a
send. Events behind a failed event may likewise consume their reserved attempt;
this conservative accounting prevents crash-driven retry storms. No pending event
is silently removed. Exhausted head events block FIFO until owner reconciliation.

### Explicit budgets and failure signals

| Resource | Bound |
|---|---|
| Reader | 32 sequential scopes maximum; current registry 10; 10 seconds, 8 MiB, 5,000 matches each; no retries |
| GitHub JSON API | At most 3 pages × 20 runs; 2 metadata + 3 run-list + 120 artifact/job reads = 125 requests; 10 seconds / 1 MiB each, no retries |
| Artifact transfer | One selected download, up to two uploads; state 256 KiB, artifact metadata size ceiling 256 KiB; action-internal transfer retries are governed by pinned actions and job timeout |
| State | 128 pending events, 32 receipts, one current incident ID per scope; 256 KiB |
| Notifications | At most 10 sequential sends per run, 5 seconds each, 1 KiB acknowledgment; 20 reserved attempts per event |
| Backoff | Across runs: 5 minutes doubled to maximum 6 hours; no in-run retry, untrusted Retry-After cannot enlarge bounds |
| Runtime | Entire Actions job 10 minutes; this may truncate API search/check/delivery before per-operation ceilings |
| Proposed cadence | Five minutes, 288 nominal runs/day; current registry ≤2,880 reader requests/day; worst-case ≤2,880 notification attempts/day; actual platform timing can delay/drop runs |

Normally selection requires only a few API requests, but worst-case nominal
cadence permits 36,000 API calls/day before the job deadline/rate limits. This is
a ceiling, not expected traffic; repeated history failures need intervention,
not a larger scan. Disabled workflows allocate no check runner. GitHub cron offers
no hard alert-latency SLA; thresholds, cadence, queue delay, backoff, platform
delays and network time all contribute.

If there is not room for one transition per scope, preparation pauses all checks
and drains the existing queue; it does not report skipped observations as healthy.
Events occurring entirely while monitoring is blocked cannot be reconstructed.
Data incidents alone exit **1**; monitor/state/config/API/persistence/queue or
pending/delivery failures exit **2**; clean healthy completion exits **0**.
Upload failure independently fails Actions even when the final status step is
healthy. Local stale locks fail closed; verify no process runs before repair.

Artifacts expire after 90 days and are not permanent storage. Keep an independently
retained checkpoint and operational owner for loss recovery. Deleting an artifact
while its run remains is detected; deletion of the entire run or malicious edits
by a repository administrator cannot be detected from this repository's history
alone. Workflow/code rollback does not safely roll back incident history: disable
execution first and validate the latest envelope against the rollback version;
never choose an older state just because its code can read it. A monitor cannot
detect its own permanent stoppage: a separately approved heartbeat/independent
observer is still needed for monitor-not-running detection. Native Actions failure
notifications may repeat and are not this transition transport.

### Disabled-to-enabled owner checklist

- [ ] Review/merge the exact PR SHA through normal CI (this change does not merge).
- [ ] Confirm T16.2 compatibility with its owner. The watchdog accepts the merged
  T16.2 reader shape (#203): scorer and card `teamId:string|null` (null: the stored
  reference names neither side) and scorer `ownGoal:boolean|null` (null: unknown, a
  legacy row without aligned events), passed through without coercion. Pre-T16.2
  scorers that omit `ownGoal`, `athleteId` and `playerSlug` stay accepted, and
  `athleteId`/`playerSlug` remain optional `string|null`. `teamId` must still be
  present, and required-field, type and unknown-key rejection remain. Any further
  nullable/card/DTO changes need explicit tested agreement.
- [ ] Select an incident owner, channel/recipient and HTTPS receiver satisfying the
  acknowledgment/dedup protocol. No approved channel was found in repository config;
  a local stub is the implementation acceptance destination only.
- [ ] Approve checkpoint retention/backup, recovery procedure, cost/cadence and
  independent monitor-not-running detection. Reconcile any existing v1 history
  without resetting it; incompatible history deliberately blocks activation.
- [ ] After external-configuration approval, configure the webhook secret and
  delivery variable. Leave the main enablement variable false until authorized
  manual check/delivery acceptance is ready.
- [ ] With separate approval, set `MATCH_FRESHNESS_ENABLED=true`; run the reviewed
  main workflow once with explicit initialization **only if no history exists**.
  Subsequent new runs use false. Inspect pending/final artifacts and exact run SHA.
- [ ] Verify real recipient receipt and stable-ID deduplication for opening,
  continued failure, recovery, recurrence, ambiguous send and state/delivery failure
  using an approved synthetic acceptance setup; do not disrupt production data.
- [ ] Only after that acceptance, approve a follow-up PR enabling the commented
  five-minute schedule under `on:`. Never use production dispatch for code tests.
- [ ] Disable by clearing/setting `MATCH_FRESHNESS_ENABLED=false`; allow the current
  serialized run to finish and retain its newest checkpoint. Do not delete history.

This delivers code for the **match-endpoint slice only**. Scheduling, real delivery,
recipient decisions, sustained operational acceptance and broader T17.4 coverage
remain open. No database, ingester, T21.2 or release-pipeline behavior is changed.

## Schema and separately approved release order

**Existing production:** migration 0023 and the recovery releases were completed
September 20 as reported above. The scoreboard repair #183 subsequently shipped
September 26 without a new migration, grant or startup dependency. Neither
release was a frontend cutover. Do not repeat these completed operations;
the remaining live acceptance and notification work is described below.

The following sequence is retained for a **new/unmigrated environment only**,
not as instructions to repeat completed production recovery:

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
- After an authorized rollout, observe at least three complete normal polls for
  representative active European and Americas competitions, plus one complete
  current-season sweep. Compare known event IDs, reschedules, dates and counts
  against sampled provider days/summaries, not merely a 200 or green header.
  Inspect audit errors, persisted poll success/count and accepted observations.
  Keep unrelated T7.21 capture work separate.
- Confirm unchanged data renews observation evidence without fact rewrites.
  A failed/truncated month remains partial/failed, not complete reconciliation.
  Observe recovery through an actual transient provider failure when available;
  use the local synthetic path to exercise it without disrupting production.
  Do not claim live transient-failure acceptance before it has been observed.
- Run a synthetic freshness failure, repeated failure, recovery and recurrence
  through the external check. Verify failure exits, persistent deduplication and
  separately configured notification delivery without stopping production to test.
- Verify dormant suppression, stopped-worker expiry for active empty/all-final
  collections, and immutable finalized facts.

This is the match-specific slice of T17.3/T17.4, not every E17 endpoint.
Fly/SQL access, production migration, release, scheduling and notification
acceptance remain separately approved operations.
