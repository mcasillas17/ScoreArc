# Match recovery and freshness

This runbook does not authorize a production change. The website still uses
its existing ESPN DataStore. Reader response bodies and the three match states
are unchanged; freshness is additive metadata.

T17.3 now implements independent resource metadata for all twelve data routes;
see the [resource contract](READER_CONTRACT.md#t173-resource-freshness-contract).
Its migration 0028 and production acceptance remain separately authorized work.
This adds no watchdog scheduling/delivery and changes none of the match
thresholds below. Broader resource metadata does not retroactively establish
complete detail, roster, player or archive capture.

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
reads each current season's complete `/matches?scope=season&detail=summary` read,
with stored detail (the parameterless default is one lightweight week since
T10.1), fails for stale/unavailable data,
active partial/failed polling, HTTP errors and invalid contracts, and persists
OPEN/RESOLVED transition deduplication. Every unhealthy run still fails, even
when its transition message is suppressed. Missing/corrupt state fails closed.
It neither calls ESPN nor writes match data.

## Durable match monitor (activation disabled)

**PREPARATION ONLY — production activation still disabled.** This T17.4 slice
provides offline acceptance and an operator handoff for the **current match
contract**. It does not complete T17.4 or the monitoring epic. Broader checks wait
for the separately owned T17.3 contract to settle; reader contract-registry,
news and safe-logging gaps remain with their owners. Production migration 0027
is already applied per the owner's October 30 report; this slice needs no reader schema
or release operation. The receiver's [not-running check](#not-running-check) needs its
own D1 migration `0002` and Worker redeploy, separately approved.

The workflow remains manual-only; its job and CLI require exact repository
variable `MATCH_FRESHNESS_ENABLED=true`. Absent/false means **zero reader checks
and zero webhook sends**. The receiver cannot see that variable: once scheduled runs
have armed its [not-running check](#not-running-check), it emails once after the
heartbeats stop unless the check is paused. Delivery additionally requires exact
`MATCH_FRESHNESS_DELIVERY_ENABLED=true` and the owner-approved secret
`MATCH_FRESHNESS_WEBHOOK_URL`. Neither variable nor secret is created by this
change. A commented five-minute cron recipe is provided; no active schedule is
installed. Only main first-attempt runs are trusted; use a new run, not rerun.

### Offline readiness acceptance

From the repository root with Node 26 and lockfile dependencies installed:

```bash
npm ci
npx vitest run scripts/match-freshness-watchdog.test.ts scripts/match-freshness-monitor.test.ts scripts/match-freshness-state.test.ts scripts/match-freshness-workflow.test.ts infra/alert-receiver/worker.test.ts
npm test
npx tsc --noEmit
npm run lint
```

The focused suites are the acceptance path: no new helper or service is
needed. They use synthetic reader responses, in-memory GitHub run/artifact/job
history, temporary local checkpoints and a receiver bound to `127.0.0.1` on an
ephemeral port. GitHub transport tests stub `fetch`; they do not call GitHub.
The workflow harness executes the real exported CLI phases and parsed YAML
conditions, replacing artifact transfers with local copies. It does **not**
exercise GitHub's hosted scheduler or the pinned artifact actions themselves.
Tests clean up their listeners and temporary files. No variables/secrets,
production reader or real notification destination are needed.

Do not use the standalone v1 watchdog CLI as a dry run: it defaults to the
production reader and is not governed by the v2 monitor's enablement variables.
Do not dispatch the production workflow to test code. A passing local suite
proves neither live delivery nor scheduled monitoring nor human receipt.

Existing acceptance evidence (test names are searchable within the linked files):

| Scenario | Test evidence |
|---|---|
| Absent/false enablement: zero monitor checks and webhook sends (an armed not-running check still emails once unless paused); delivery-only disablement retains events | [workflow tests](../../scripts/match-freshness-workflow.test.ts): `disabled ... CLI`, `disabled job`, `delivery gate`; [monitor tests](../../scripts/match-freshness-monitor.test.ts): `is disabled before filesystem, production checks or sends` |
| Healthy, genuinely empty and dormant do not open false incidents; invalid emptiness stays unhealthy | [watchdog tests](../../scripts/match-freshness-watchdog.test.ts): `uses existing scoped matches route`, `accepts explicit empty and dormant`, `suppresses expected dormant scope`, `rejects count contradictions`; monitor: `opens no incident for valid T16.2 nulls` |
| OPEN, repeat failure, RESOLVED and recurrence retain FIFO and deduplication | monitor: `preserves pending OPEN through recovery and orders recurrence with stable identifiers`; watchdog: `deduplicates openings, resolves once and reopens recurrence`; workflow: `executes checks and delivery only after successful pending upload` |
| Timeout, 429, redirect and wrong acknowledgment fail; reader/API/ack body sizes and body deadlines stay bounded | monitor: `retains retryable state for HTTP`, `rejects ... acknowledgment within the delivery bounds`; watchdog: `bounds response bytes`, `does not follow redirects`; [state tests](../../scripts/match-freshness-state.test.ts): `bounded GitHub JSON transport` |
| Acceptance followed by loss of the local acknowledged state replays the same event ID | monitor: `retries a successful-but-uncheckpointed acknowledgment with the same ID` simulates the crash boundary by restoring the pre-send checkpoint; workflow: `failed final upload restores pending and retries stable IDs after backoff` |
| Pending upload failure prevents sends; final upload failure preserves replay | workflow: `failed pending upload prohibits sends and blocks silent rollback`, `failed final upload restores pending` |
| Missing/corrupt/expired/incompatible newest history blocks rather than falling back or initializing | monitor: `rejects missing, corrupt, incompatible, wrong-origin/scope and rollback state`; state: `does not roll back past an invalid newest artifact`, `fails when the final checkpoint expired`, `treats preparation without upload as a barrier`, `rejects initialization when durable state already exists` |
| Receiver protocol with the real sender: OPEN, repeat, RESOLVED, recurrence, timeout, wrong acknowledgment, crash, ordering, cap | [receiver tests](../../infra/alert-receiver/worker.test.ts): `real monitor sender against the receiver`, `daily cap` |
| Not-running check: inert until armed, one down email after 60 minutes, one recovery, at-least-once retries, write floor, token gate; heartbeats only from scheduled runs with delivery and both checkpoints committed | receiver: `monitor heartbeat`; workflow: `scheduled heartbeat`, `disabled job` |
| Finite queues, history, bytes, attempts and execution | monitor: `backpressure keeps bounded queue`, `reserves attempts before sending ... exhausts at 20`; state: `fails closed at the three-page budget`; watchdog: `uses only configured current seasons`; workflow: job timeout/manual-only assertions |

Retain the focused test summary, full-suite/typecheck/lint results and reviewed
commit SHA with the later activation record. An expected incident/delivery error
inside a test is a passing assertion, not evidence of a live incident. No build
or backend gate is needed for changes confined to these tests and this runbook.
Changes under `infra/alert-receiver` also run `npm run build`, because the root
typecheck includes the Worker.

### Configuration inventory for later approval

| Setting | Source and required behavior |
|---|---|
| `MATCH_FRESHNESS_ENABLED` | Repository Actions variable. Only literal `true` enables the job and CLI; absent/false means zero checks/sends. Keep absent/false during preparation. An armed [not-running check](#not-running-check) still emails once after a disable unless paused with `DELETE FROM monitor_heartbeat`. |
| `MATCH_FRESHNESS_DELIVERY_ENABLED` | Repository Actions variable. Only literal `true` permits reservations/sends. Absent/false still allows checks and queued transitions when the main gate is true; it is **not** an offline dry run and pending events make the result exit 2. It also stops heartbeats, so pause an armed [not-running check](#not-running-check) the same way. |
| `MATCH_FRESHNESS_WEBHOOK_URL` | Repository Actions secret, supplied only to the delivery and result steps; the result step uses it only for the scheduled-run [heartbeat](#not-running-check). Owner-approved HTTPS receiver implementing the protocol below; do not put its URL/token in logs, PRs or acceptance records. |
| `initialize_state` | Sole manual input, boolean, default false. True only for proven first history; never a repair flag. |
| Run identity and API access | Actions supplies `GITHUB_*` provenance and its token with `contents: read` / `actions: read`. Do not substitute another repository/ref/run identity or a personal token to bypass validation. |
| Reader and scopes | Fixed CLI origin `https://scorearc-reader.fly.dev`; exact current seasons from `backend/config/competitions.json`. No workflow input overrides these. A changed origin/scope set requires a reviewed state migration, not initialization. |

The local harness injects its loopback origin directly into `runPhase`; that is
test wiring, not a configurable production endpoint. Production reader-origin
validation and redirect rejection stay in force. There is no approved incident
owner, recipient, receiver provider or independent observer selected by this
preparation work. The owner has since selected email and approved the
[alert receiver](#alert-receiver) design, which was deployed on November 3, 2026.
The owner also selected themselves as checkpoint backup owner (a weekly copy to a
private R2 bucket, not built yet) and the receiver's [not-running check](#not-running-check)
as the independent observer.

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

### Alert receiver

**Deployed, but the monitor is not connected to it yet.** On November 1, 2026 the
owner selected email to one owner-chosen address, named themselves incident owner,
and approved this design. On November 3, with separate approval, Email Routing was
enabled, the Worker and its D1 database were deployed, and one synthetic event sent
twice got two matching acknowledgments, one D1 row and one email that the owner
confirmed receiving. A wrong token got 404. The monitor's webhook secret and
variables are still unset.

[`infra/alert-receiver`](../../infra/alert-receiver/worker.ts) is a Cloudflare
Worker with D1. Once migration `0002` and its cron trigger are deployed, it also runs the
scheduled-run [not-running check](#not-running-check) on its own route and table. For each event the Worker:

1. Checks the secret token in the URL path (`/events/<token>`); a wrong token gets 404.
2. Accepts only a JSON body of at most 4 KiB with the exact expected fields, whose
   `Idempotency-Key` equals `eventId`. Strict patterns keep headers and markup out
   of the email.
3. Saves the event. The same ID with different content gets 409.
4. Sends the email unless that ID was already emailed, then records the send.
5. Returns 200 with `{"eventId":"<same ID>"}`. Any failure returns a non-200 with
   an empty body, so the sender keeps the event and retries the same ID in order.

A crash after the email goes out but before the send is recorded can produce a second
email with the same event ID in its body. That is the deliberate trade-off: a possible
duplicate instead of a possible lost alert. A sender timeout causes this only if the
send has not finished within the roughly 30 seconds `waitUntil` allows after the
disconnect; otherwise the Worker still records the send.
Once the send is recorded, retries are acknowledged without another email. Two simultaneous
deliveries of one ID could also both send, but the workflow serializes runs.

| Item | Decision |
|---|---|
| Recipient | Worker secret `ALERT_RECIPIENT`. Never commit it: this repository is public. |
| Reach | The sending domain is **not** onboarded to Email Sending, so the binding can reach verified destination addresses only. Do not run `wrangler email sending enable`: it also removes this limit. |
| Sender | `alerts@scorearc.futbol`, which requires Email Routing on the domain. |
| Flood bound | At most 300 new events per rolling 24 hours, enforced in the insert itself, then 503 with no acknowledgment. This bounds rows and D1 writes as well as email. A retry of an already accepted event is not capped, so an accepted alert still arrives. Refused events wait in order in the sender's queue, about 29 hours at worst with its retry backoff, and sustained flapping can fill that queue and pause checks (`queue-full`). Real transitions should stay far below this ceiling; if the cap trips during a real incident, raise it through a reviewed change. A cap with no matching incident means rotating the token. |
| Retention | D1 rows are kept with no automatic deletion: event ID, event content and timestamps, no personal data. Roughly one small row per transition. |
| Logs | Invocation logs stay off because request URLs contain the token. The Worker's own lines are kept and name only the failing stage, known `E_*` codes or a rejection status. Because the sender reports every non-200 as `delivery-failed`, check these lines first when the queue is stuck: a repeated `rejected` status means the sender and receiver disagree, not an outage. A wrong token writes no line, so with no lines at all, first check that `MATCH_FRESHNESS_WEBHOOK_URL` carries the current `RECEIVER_TOKEN`. After deployment, confirm in the Cloudflare log view that retained lines carry no URL. `wrangler tail` output can include the URL, so never paste it anywhere. |
| Cost | Expected $0 per Cloudflare's published terms, checked November 1, 2026: sends to verified addresses are free on all plans; Workers Free allows 100,000 requests/day and D1 Free 100,000 writes/day and 5 GB. Requests with a wrong token count toward that allowance, so a flood could block real deliveries until the daily reset; the sender keeps those events and retries them, but sustained blocking can exhaust an event's retry budget. No rate limit is configured. |

Emails may land in spam at first because the domain is new as a sender. Acceptance
must check the real inbox, not just the acknowledgment.

Tests are in [`worker.test.ts`](../../infra/alert-receiver/worker.test.ts): the real
monitor sender runs against the receiver on real SQLite using the real migrations,
covering OPEN, repeated failure, RESOLVED, recurrence, timeouts, wrong acknowledgments
and acceptance followed by a crash. D1 and the email service are stand-ins there. A
`wrangler@4.123.0 dev --local` smoke run confirmed the Worker starts on `workerd`,
deduplicates on local D1 and calls the local email simulator; it does not prove real
delivery. To repeat it, put test-only `RECEIVER_TOKEN` and `ALERT_RECIPIENT` values in
the gitignored `infra/alert-receiver/.dev.vars` (the token needs at least 32 characters,
or the Worker answers 500; `openssl rand -hex 32` works), then from that directory run
`npx wrangler@4.123.0 d1 migrations apply scorearc-alert-receiver --local` and
`npx wrangler@4.123.0 dev --local --test-scheduled`. Posting one event twice should return
two 200 acknowledgments and call the email simulator once. A POST to
`/heartbeat/<token>` should return 204 and write the `monitor_heartbeat` row, and a GET
of `/__scheduled` should return 200.

**Deployment steps, for a separately approved operator run** (from `infra/alert-receiver`,
after `npx wrangler@4.123.0 login` on the account that owns `scorearc.futbol`):

1. Enable Email Routing on the domain, reviewing the DNS records it adds, and verify
   the recipient as a destination address from that inbox.
2. `npx wrangler@4.123.0 d1 create scorearc-alert-receiver`, then put its ID in `wrangler.jsonc`.
3. `npx wrangler@4.123.0 d1 migrations apply scorearc-alert-receiver --remote`.
4. `npx wrangler@4.123.0 secret put ALERT_RECIPIENT` and `npx wrangler@4.123.0 secret put RECEIVER_TOKEN`,
   with the token from `openssl rand -hex 32`, which is URL-path safe. Use the
   interactive prompts, so values stay out of shell history and chat.
5. `npx wrangler@4.123.0 deploy`.
6. Store `https://<worker-host>/events/<token>` as the `MATCH_FRESHNESS_WEBHOOK_URL`
   repository secret, using the interactive `gh secret set` prompt.

The [not-running check](#not-running-check) adds migration `0002` and a cron
trigger: deploying it is step 3 then step 5 again, after separate approval.

To stop alerts, follow the disable procedure below, including the not-running
check's pause step. Rotating the token requires
updating both secrets together; deliveries fail and retry in between.

#### Not-running check

A monitor that never starts cannot report its own absence, so the receiver watches
for it. After each **scheduled** run whose checks, delivery and both checkpoint uploads
worked, including a data incident (exit 1), the result step posts to `/heartbeat/<token>` at the same
host and token as the webhook, expecting 204. A monitor failure (exit 2), a manual
run or delivery switched off sends no heartbeat, and a failed heartbeat only logs
a line without changing the run's result.

The receiver keeps the last heartbeat time in D1 (`monitor_heartbeat`). A cron
trigger every 15 minutes emails "Monitor not running" once no heartbeat has arrived
for 60 minutes, so the alert comes 60 to 75 minutes after the last good run. Scheduled
runs that keep ending with exit 2 (delivery, queue or state failure) or a failed
checkpoint upload send no heartbeat either, so they lead to the same email. A backlog
still pending after a run is also exit 2, so after a receiver outage the recovery email
follows the queue drain, about five minutes per ten pending transitions. Read the
newest run's step list and its `Match monitor: data_incident=... pending=... monitor=...`
line before concluding that GitHub stopped the schedule. The
five-minute schedule often starts late, which is why the limit is an hour. The next
heartbeat sends one "Monitor recovered" email. A failed down email is retried by the next
check, and a failed recovery by the next heartbeat more than a minute after the last. Each email is recorded after it is sent, so a database failure in
between repeats it once the database is back: at least once, like events. The receiver
writes the heartbeat at most once a minute, so a leaked token can spend at most 1,440
D1 writes a day through this route, about 1.4% of the free allowance. The 300-event
cap does not cover these emails: a token holder alternating heartbeats and hour-long
silences could cause about 40 down and recovery emails a day (one pair per 60 to 75 minutes), which also means the
token leaked and needs rotating. Any heartbeat after an alert ends that outage, even if
its recovery email failed, so a later outage always alerts again. A heartbeat that
lands while a down email is being sent gets its recovery from the next heartbeat, five
minutes later. One gap remains: if
recording a down email fails and the monitor recovers before the next check, that
email gets no recovery, so check the workflow page once. Claiming the alert before
sending would close this, but a failed send plus a failed un-claim would then lose
the alert entirely. Rarer combinations of failures can repeat a recovery email, never
drop an alert.

| Item | Decision |
|---|---|
| Arming | No row means no check. The first scheduled heartbeat arms it, so it cannot alarm before the schedule is enabled. |
| Pausing | To stop the monitor on purpose, first set `MATCH_FRESHNESS_ENABLED=false` (or `MATCH_FRESHNESS_DELIVERY_ENABLED=false`, which also stops heartbeats) and let any running job finish, then within 60 minutes of its last heartbeat run `npx wrangler@4.123.0 d1 execute scorearc-alert-receiver --remote --command "DELETE FROM monitor_heartbeat"` from `infra/alert-receiver`. Deleting first lets a run still in flight re-arm the check. Without the delete, one "not running" email follows, which is the correct signal for an unplanned stop. The next scheduled heartbeat re-arms it. |
| Independence | It catches GitHub not running or failing the monitor. It shares Cloudflare with the receiver, so a Cloudflare outage silences both. Anyone holding the webhook token can also keep it quiet by sending heartbeats; rotating the token restores it. |
| Owner | The owner is the incident owner and recipient. Deadline: 60 minutes without a scheduled heartbeat. |
| Cost | 96 cron runs a day, within Workers Free. |

Acceptance, after the schedule is enabled: confirm the `monitor_heartbeat` row
advances with scheduled runs, using `npx wrangler@4.123.0 d1 execute
scorearc-alert-receiver --remote --command "SELECT last_at, alerted_at FROM monitor_heartbeat"`
from `infra/alert-receiver`. The same command shows the state behind a "not running" email. The alert and recovery paths are covered by tests;
do not stop production to prove them.

### Explicit budgets and failure signals

| Resource | Bound |
|---|---|
| Reader | 32 sequential scopes maximum; current registry 10; 10 seconds, 8 MiB, 5,000 matches each; no retries |
| GitHub JSON API | At most 3 pages × 20 runs; 2 metadata + 3 run-list + 120 artifact/job reads = 125 requests; 10 seconds / 1 MiB each, no retries |
| Artifact transfer | One selected download, up to two uploads; state 256 KiB, artifact metadata size ceiling 256 KiB; action-internal transfer retries are governed by pinned actions and job timeout |
| State | 128 pending events, 32 receipts, one current incident ID per scope; 256 KiB |
| Notifications | At most 10 sequential sends per run, 5 seconds each, 1 KiB acknowledgment; 20 reserved attempts per event |
| Heartbeat | At most one POST per scheduled run, 5 seconds, 204 expected, never retried |
| Backoff | Across runs: 5 minutes doubled to maximum 6 hours; no in-run retry, untrusted Retry-After cannot enlarge bounds |
| Runtime | Entire Actions job 10 minutes; this may truncate API search/check/delivery before per-operation ceilings |
| Proposed cadence | Five minutes, 288 nominal runs/day; current registry ≤2,880 reader requests/day; worst-case ≤2,880 notification attempts/day plus ≤288 heartbeats; actual platform timing can delay/drop runs |

Normally selection requires only a few API requests, but worst-case nominal
cadence permits 36,000 API calls/day before the job deadline/rate limits. This is
a ceiling, not expected traffic; repeated history failures need intervention,
not a larger scan. Disabled workflows allocate no check runner. GitHub cron offers
no hard alert-latency SLA; thresholds, cadence, queue delay, backoff, platform
delays and network time all contribute.

For cadence approval, record measured job duration, response bytes, artifact
bytes and receiver requests from the later authorized acceptance. At the proposed
five-minute cadence, 30 days gives 8,640 nominal runs and up to 86,400 current-ten
reader requests. Two 256-KiB state files per run give at most 144 MiB/day of raw
checkpoint bytes, or about 12.66 GiB across 90 days before archive/billing
overhead; actual states are normally much smaller. The 8-MiB reader cap permits
up to 22.5 GiB/day of response bodies at 2,880 requests, not an expected load.
Runner usage is `runs × measured billable minutes per job`; the ten-minute job
ceiling can cause backlog under serialized execution and is not a five-minute
completion promise. Apply the owner's current Actions allowance/rates, artifact
retention charges and Fly/Neon read load; no dollar price or free tier is assumed.
The receiver's expected cost is recorded under [alert receiver](#alert-receiver). Checkpoint backups have
separate costs that the owner has not yet approved; the
[not-running check](#not-running-check) runs within Workers Free. None of these costs is approved by this document.

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
detect its own permanent stoppage: the receiver's
[not-running check](#not-running-check) covers that once the schedule feeds it. Native Actions failure
notifications may repeat and are not this transition transport.

### Disable and recover without losing history

These are procedures for a separately authorized operator, not actions performed
by this preparation PR. To stop checks **and** sends, clear/set
`MATCH_FRESHNESS_ENABLED=false`. Once the schedule feeds the receiver, then pause the
[not-running check](#not-running-check) after the last run finishes, or expect one
"Monitor not running" email 60 to 75 minutes later. This gates subsequent jobs; an already running
job has captured its environment. Normally let that serialized run finish and
retain its newest pending/final checkpoints. If urgent containment requires
cancellation, record the run and assume ambiguous delivery until reconciled;
cancellation is not a safe reset. Disabling only delivery leaves checks/queue
growth active, so it is not the full kill switch.

| Observed failure | Recovery boundary |
|---|---|
| Reader incident, exit 1 after delivery | Investigate competition/season/run context using the existing diagnostics. Do not modify scores or thresholds to clear it. Repeated failure stays nonzero without another OPEN. |
| Delivery failure, exit 2, valid retained checkpoint | Fix the approved receiver/configuration. Start a **new** authorized main run after backoff; retain IDs and let FIFO replay the pending head before later events. Do not rerun the old attempt or send a replacement event manually. |
| Final upload failure or crash after receiver acceptance | Preserve the pending snapshot and receiver acceptance ledger. The selector may replay it only with proven failed/skipped final upload; receiver deduplication must tolerate the same ID. A successful/ambiguous/cancelled final-upload record with missing state blocks automatic recovery. |
| Pending upload failed; no checkpoint survives | No sends occurred from that run, but newly observed transitions may be lost. Stop and reconcile that preparation barrier; never select an older run or initialize around it. |
| Missing/corrupt/expired/incompatible state, exhausted retry head or history-scan budget | Disable and preserve artifacts, run/job metadata, logs and receiver receipts. An owner-reviewed recovery/migration must preserve the latest epoch, sequence, incident IDs and ordered pending events. There is no backup-import, reset, retry-budget override or older-checkpoint switch in the current automation. Remain disabled until a reviewed procedure can establish continuity. |

Before activation, name who retains independently verified copies of the newest
checkpoint **and its run/artifact provenance**, where they are kept, the backup
interval, expiry margin, access policy and restore rehearsal. Retain both pending
and final evidence when delivery is ambiguous; a backup is not permission to
substitute stale state. The YAML requests 90-day retention, but the operator must
verify effective repository/account retention and actual `expires_at` values.
A pause approaching that expiry needs intervention before the checkpoint is lost.
The independent observer must also have a named owner, expected-run deadline,
escalation recipient and acceptance proof; a failed workflow can report an error,
but a workflow that never starts cannot report its own absence.

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
- [x] Select an incident owner and channel/recipient. The owner selected email and
  approved the [alert receiver](#alert-receiver) design on November 1, 2026.
- [x] Deploy the receiver, verify the recipient address, and confirm the deployed
  receiver satisfies the acknowledgment/dedup protocol. Done November 3, 2026 with
  one synthetic event; the owner confirmed receipt.
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
  five-minute schedule under `on:`. That PR must intentionally update the
  manual-only workflow test, retain both exact-true gates, main/attempt provenance,
  serialization and upload-before-send ordering, and link the signed-off
  activation evidence. Never use production dispatch for code tests.
- [ ] Disable by clearing/setting `MATCH_FRESHNESS_ENABLED=false`; allow the current
  serialized run to finish and retain its newest checkpoint. Then pause the not-running
  check with the command in its [Pausing row](#not-running-check). Never delete
  checkpoint artifacts or run history.

The activation record must identify the approving owner and reviewed SHA, incident
owner, confirmation that the verified recipient was used (never the address itself:
this repository is public), receiver compatibility/dedup evidence, **human receipt proof**
for the synthetic OPEN/RESOLVED/recurrence, checkpoint backup/recovery acceptance,
cadence/cost acceptance, independent not-running detection, approved variable and
secret changes (names only), and the first authorized manual run ID/initialization
choice/artifact IDs. Protocol HTTP 200 alone does not satisfy receipt proof.
Record unresolved decisions as blockers, not accepted defaults. Real acceptance
uses separately approved synthetic inputs/destination; this PR neither provisions
that setup nor authorizes changing the fixed production reader for a test.

This delivers code for the **match-endpoint slice only**. Scheduling, real delivery,
recipient verification, sustained operational acceptance and broader T17.4 coverage
remain open. No Postgres or reader database, ingester, T21.2 or release-pipeline behavior is
changed; the receiver's D1 gains the `monitor_heartbeat` table.

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
