# ScoreArc public reader API

`backend/reader` is a public, read-only Go HTTP service. It reconstructs the
frontend's existing JSON models from Postgres, except news, which remains a
short-lived ESPN proxy. The authoritative machine-readable contract is
[`openapi.yaml`](openapi.yaml).

Every id it serves is a **canonical ScoreArc id** — slugs for competitions,
seasons, and teams; UUIDs for matches — not a provider's. Provider ids live only
in the `*_external_ref` crosswalk tables, which the reader never joins. Ids stay
opaque strings to consumers.

## Runtime configuration

| Variable | Required | Meaning |
|---|---:|---|
| `DATABASE_URL` | yes | Pooled Postgres DSN for a login that belongs only to `scorearc_reader` |
| `PORT` | no | Listen port; defaults to `8080` |

Production must use TLS to Neon (`sslmode=require`). The process verifies the
database on startup, uses bounded HTTP timeouts, and shuts down gracefully on
`SIGINT` or `SIGTERM`.

Before opening the HTTP listener, the reader also runs a column-specific
`SELECT ... WHERE false` against `match_sync_status` and `match_poll_status`
within the existing ten-second startup deadline. Missing required freshness
columns, tables, or reader SELECT grants fail startup without reading match
observations. The failure log contains only the operation, error type and
SQLSTATE; the returned error is a constant safe for the top-level logger, not a
wrapped DSN or PostgreSQL message/detail. Empty bookkeeping tables pass this
schema check and still yield `unavailable` for active scopes at request time.
This is only a migration-0023 dependency check, not general T21.2 readiness;
the existing `/healthz` connectivity behavior is unchanged.

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run .
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/v1/competitions/world-cup/2026/matches
```

## Request behavior

- CORS permits public `GET` and preflight requests.
- A token bucket allows 10 requests/second with a burst of 30 per client. Its
  least-recently-used client table is capped at 10,000 entries.
- `/healthz` bypasses rate limiting so platform checks remain reliable, but DB
  pings are singleflight-coalesced and cached for two seconds. Responses always
  use `Cache-Control: no-store`.
- On Fly's direct HTTP deployment, the limiter uses the valid
  platform-provided `Fly-Client-IP`; otherwise it uses the TCP peer. It ignores
  `X-Forwarded-For`. If another CDN/proxy is added in front of Fly, revisit this
  trust model before launch so the proxy address does not collapse all clients
  into one bucket.
- Database and upstream errors are logged server-side but returned as generic
  JSON errors. The API never exposes DSNs or raw dependency errors.
- Every `/v1` request gets a ten-second dependency deadline. News uses a
  service-owned 15-second fetch context, a 90-second internal TTL, and
  singleflight coalescing. One disconnected client therefore cannot cancel the
  upstream fetch for other waiters.
- All failures, unknown routes, unsupported methods, and recovered panics use a
  sanitized JSON error with `Cache-Control: no-store`.

## Match freshness (additive, no body changes)

The match list, bracket, match summary and team profile routes retain their exact
existing JSON shapes (including bare list arrays and `scheduled|live|finished`).
They add CORS-exposed response headers:

| Header | Contract |
|---|---|
| `X-ScoreArc-Freshness` | `fresh`, `empty`, `dormant`, `stale`, `unavailable` |
| `X-ScoreArc-Observed-At` | Optional ISO instant: oldest known successful selected observation or full competition poll; not proof of health on its own |
| `X-ScoreArc-Poll-Status` | Latest ESPN poll: `ok`, `partial`, `failed`, or `unknown` |
| `X-ScoreArc-Stale-Matches` | Nonnegative selected-match count, including overdue, missing/expired observations and unhealthy polling for unfinalized rows |
| `X-ScoreArc-Overdue-Matches` | Nonnegative subset of stale matches overdue by kickoff |

Freshness is computed at request time with the **reader clock**, from
`match_sync_status.observed_at` and `match_poll_status.succeeded_at` (`source=espn`).
A successful accepted observation counts even if scores/state did not change.
Retry attempts and `match.updated_at` never establish freshness. The ingester
records full poll success only after validated results have persisted; failed
or partial polls retain prior success timestamps but expose the latest outcome.

At **equality or beyond**, a live observation expires after **2 minutes**, a
competition poll after **20 minutes**, a scheduled match is overdue at
**kickoff + 15 minutes**, and a live match at **kickoff + 4 hours**. Overdue rows
stay stale even immediately after re-observation. Only explicit
`STATUS_POSTPONED` / `STATUS_SUSPENDED` exclude clock-based overdue and retain a
**24-hour** observation TTL. Ordinary scheduled rows have a **25-hour** TTL:
24-hour full-season reconciliation cadence plus one hour of allowance for
five-minute slow-tick alignment and up to four minutes thirty seconds of bounded
processing. This avoids predictable daily false alarms for matches beyond the
seven-day rolling horizon. Equality at 25 hours is stale. Finished but
unfinalized rows can have current core facts (24-hour TTL), but this does not
claim final-detail capture is complete. Sealed/finalized rows never expire.
None of this edits stored scores, states, kickoff, or finalization.

An active scope with missing observations or no successful full poll is
`unavailable`, unless overdue supplies stronger `stale` evidence. Failed/partial
polls are not healthy: with successful bookkeeping they produce `stale`.
An empty active collection is `empty` only after a recent successful full poll;
stopped polling becomes `stale`/`unavailable`, not empty-success.
`dormant` requires time outside valid shared `source.SeasonBounds` **and no
unfinalized rows anywhere in that competition season**. Empty team/bracket
subsets cannot conceal unresolved work. An explicit single finalized match
(the summary route) and genuine dormancy need no new heartbeat, but the last
poll outcome remains visible. **Active list/team/bracket collections always
require discovery polling**, even if every stored match is finalized: a stopped
worker could otherwise hide newly scheduled matches indefinitely. Expired polls
produce `stale`; absent successful polls produce `unavailable`. Counts remain
zero when the stored rows are all sealed, because those facts themselves have
not expired.

All four match-bearing routes read their body, summary identity scope where
needed, and freshness metadata inside one **read-only repeatable-read
transaction**. Concurrent recovery cannot pair an older overdue body with newer
finalized/healthy metadata. Queries share the existing ten-second request
deadline; rollback has a separate one-second cleanup deadline even after request
cancellation. All response paths release the transaction before JSON encoding
or network response writes, including query/metadata errors, missing records and
recovered panics. Slow clients cannot retain a database snapshot. Failure to begin a snapshot
returns sanitized 500, never an unprotected fallback read.

Every route reuses one indexed scoped metadata query, without re-reading match
detail/body projections or per-match queries. Bracket metadata uses the same
recognized rounds as the body. Team/bracket subsets retain the competition poll.
Summary adds one UUID-validated primary-key lookup to resolve competition and
season; malformed/missing IDs keep their 404. Unknown stored scope, invalid
season bounds, missing schema/SELECT grants, or query failures return sanitized
**500**, never a default `fresh`. Deploy migration **0023** before this reader.
Missing bookkeeping *rows* are valid unknown evidence, not schema failure.
Existing HTTP cache policies remain; consumers checking freshness must revalidate,
as the watchdog does. `src/lib/matchFreshness.ts` is the strict reusable parser;
no frontend DataStore cutover is included.

### Independent watchdog and incident state

`scripts/match-freshness-watchdog.mjs` runs **outside the ingester**, uses the
configured current seasons in `backend/config/competitions.json`, and only GETs
the existing public `/matches` route. It never calls ESPN or changes data rights.
It rejects HTTP/redirect failures, missing/invalid/contradictory freshness
headers, non-JSON or invalid match arrays, active-scope partial/failed polls,
stale and unavailable responses. Valid `dormant` scopes are non-alerting even
when their retained poll status is `partial`, `failed` or `unknown`; off-season
source errors do not create incidents. Dormancy resolves a prior active incident
once. It never excuses missing/invalid headers, HTTP errors or a body containing
unresolved matches. Network errors cannot be mistaken for empty success.

Bounds per invocation: at most **32** sequential scopes, **10 seconds** per
request (including streaming body), **8 MiB** and **5,000 matches** per response,
no retries. This makes a stopped ingester observable without an ingester health
endpoint. Defaults are tested with Node **26**; no dependency installation or
notification credentials are required. Native TypeScript loading may emit a
module-type warning for this repository's package layout.

After separately approving an initial public-endpoint check, run from the root:

```bash
# Explicit first initialization only; parent directory must already exist.
node scripts/match-freshness-watchdog.mjs --state-file /durable/path/state.json --init-state
# Subsequent runs: absence/corruption is an error, never an automatic reset.
node scripts/match-freshness-watchdog.mjs --state-file /durable/path/state.json
```

State is JSON version 1, bound to the reader origin and exact current-scope set,
with one incident boolean per scope (maximum 32 KiB on read). Writes use an
exclusive temporary file then atomic rename, under a local directory lock.
Corrupt, oversized, missing or mismatched state fails closed. A scope change
requires an operator-reviewed state transition; do not silently discard open
incidents. A stale lock likewise requires verifying no active run before removal.
Lock cleanup uses `rmdir` on the empty directory; unexpected contents cause an
error and are left intact rather than recursively deleted.
Use a persistent local filesystem, not separate ephemeral files per invocation.

Only transitions emit `OPEN` / `RESOLVED`, with competition/season, returned match
count, stale/overdue counts and reason/status. An unresolved incident exits **1
every run**, even with no repeated message. Recovery emits one resolution;
recurrence opens again. Healthy runs exit **0**; state/config/persistence failures
exit **2**. State is persisted before messages are printed, so this is bounded
incident deduplication, **not an exactly-once delivered notification service**.
No actual messages are sent to external notification services.

`.github/workflows/match-freshness.yml` is **manual `workflow_dispatch` only**.
After separately approving the public-endpoint check, open **Actions → Match
freshness watchdog (manual) → Run workflow**, choose the reviewed ref, and use
these exact inputs:

| Manual invocation | `initialize_state` | `state_run_id` |
|---|---|---|
| First run, explicitly creating incident history | `true` | Leave blank |
| Every subsequent run, restoring incident history | `false` (default) | Run ID holding the latest valid `match-freshness-state` artifact |

Exactly one mode is required. Both bootstrap and a run ID, neither mode, or a
non-positive/non-numeric restore ID fail input validation before the check.
Only explicit bootstrap passes `--init-state`; restore never initializes or
resets state if the artifact/file is missing, expired, or corrupt. Repeating
bootstrap on a later fresh runner **starts new history** and may repeat openings
or lose incident continuity: it is not a routine retry or a silent repair path.

The workflow checks the production public reader and serializes its runs.
After an atomic valid state write, the script reports `state_written=true`
through `GITHUB_OUTPUT`, including when an incident makes the check exit 1 or
later lock cleanup fails. An `always()` upload preserves that newly produced
`state.json` as `match-freshness-state`. Failures before the write do not republish
an unchanged restored file or a corrupt file as a new state artifact. Inspect the
upload step and artifact even when the overall run is red; a failed upload means
the local state was not durably carried to the next run.

**No automatic latest selection exists.** The owner must manually select the
latest state-bearing run, including failed incident runs, and carry its run ID
into the next invocation. Selecting an older artifact rolls back deduplication
history and can repeat openings or omit resolutions. Rolling back workflow/code
does not roll state back safely; use the latest compatible state, and handle
scope/origin/version mismatches explicitly rather than silently resetting.
Artifacts expire after 90 days and are not permanent storage. Loss/expiry
requires an explicit owner decision about lost incident history before any new
bootstrap.

Checkout, setup-node, download-artifact and upload-artifact use immutable commit
pins. The checkout/download/upload pins were verified against their official
GitHub tag refs on 2026-09-19, not inferred from remembered version tags.

**Not activated here:** the owner must separately approve a cadence (for example
every **5 minutes**) and a durable latest-state mechanism before adding a schedule.
Expected alert latency includes cadence, request time, and platform scheduling
delay; it is not a hard real-time SLA. Configure and verify GitHub Actions
workflow-failure notifications for the intended recipients and, if desired,
an explicitly approved transition-aware notifier. Native workflow-failure
notifications may repeat despite console transition deduplication. Verify an
opening, continued failure, recovery, recurrence and state-loss failure in the
chosen delivery channel before claiming alerts are delivered. This change
does not configure recipients, send a real alert, enable a service or activate
a production schedule.

Focused local checks (Docker environment as below):

```bash
cd backend
go test -count=1 ./reader -run 'TestFreshness|TestOpenAPIFreshness|TestTeamProfile'
cd ..
npx vitest run src/lib/matchFreshness.test.ts scripts/match-freshness-watchdog.test.ts
```

## Observability

Reader logs are JSON on stdout for Fly to collect. Every non-successful health
check and every non-health request emits an access record with `request_id`,
`method`, concrete `path`, normalized `route`, `status`, `outcome`, response
`bytes`, `duration_ms`, and `client_ip`. A recovered panic also includes its
request id, method, path, route, and stack trace. Healthy `/healthz` probes are
intentionally omitted to keep application traffic visible. Ingester logs
similarly record each cycle's live state, failure count, duration, and sleep.

## Team-profile failures and schema repair

The 0022 colour repair below is a historical prerequisite, not sufficient schema
for this version. Current binaries also require 0023 match synchronization.
Follow the separately approved
[0023 migration/release sequence](../../docs/backend/MATCH_FRESHNESS.md#schema-and-separately-approved-release-order)
before deploying them; general migration-head readiness remains T21.2.

`GET /v1/competitions/{comp}/{season}/teams/{teamId}` reads identity and standing,
then squad/statistics, then the team's schedule. Every block must succeed before
HTTP 200. A missing team is 404; an invalid competition/season is 400. Existing
teams with empty squad/schedule return arrays; absent statistics rows return
`stats: null`, and individual unknown statistics stay null. The reader does not
omit a failed block or convert a query error into an empty profile.

A successful `/healthz` tests connectivity, not these SQL projections. Capture
UTC time and `X-Request-Id` from both the health and actual team requests. Look up
the corresponding request and team error records in restricted Fly logs. Team
errors include request_id, competition, season, team, operation (`identity`,
`squad`, `schedule`), error_type, and sqlstate (empty for non-Postgres errors).
They omit raw dependency messages and detail, which can contain credentials or
row values. Use the operation to locate the query in [`store.go`](store.go) and
investigate with authorized read-only diagnostics; keep DSNs and raw logs out of tickets.

An identity error `column t.color does not exist` (42703) occurs before squad
or schedule is read. Existing [migration 0022](../migrations/0022_team_colours.up.sql)
adds `color` and `alternate_color`; changing UUID scanning does not address this
error. See [CURRENT_STATE](../../docs/CURRENT_STATE.md#3-verification-evidence-this-pass-2026-09-01)
for production evidence and unresolved operational status.

### Local reproduction

From `backend/`, with Docker running and the active Colima socket configured as
in [AGENTS.md](../../AGENTS.md#backend-go--the-backend-api-build):

```bash
go test -count=1 -v ./reader -run '^TestTeamProfile'
```

The [integration tests](store_integration_test.go) exercise the complete HTTP path.
The migration test applies migrations through 0021 to disposable Postgres 16,
seeds a representative Liga MX team, and
checks health=200 versus team=500/42703. It then applies existing migration 0022
to that same disposable database, verifies the current reader still refuses
success without freshness schema, applies 0023, and requires HTTP 200 with all profile blocks
validated against [OpenAPI](openapi.yaml). Colour values remain null until actually
supplied. The other cases cover populated/null/empty data, UUID players, validation,
scoped schedules, permission failures at each query, and malformed schedule JSON.

### Operator verification and repair

Use an authorized SELECT-only connection to the same database and schema as the
running reader. Do not substitute an owner connection to the public service.
Inspect resolved relations and column metadata without reading private rows:

```sql
BEGIN READ ONLY;
SELECT current_database(), current_schema(), current_schemas(false);
SELECT to_regclass('team'), to_regclass('public.team');
SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull
FROM pg_attribute
WHERE attrelid = 'team'::regclass AND attnum > 0 AND NOT attisdropped
  AND attname IN ('color', 'alternate_color')
ORDER BY attname;
COMMIT;
```

Confirm the migration operator's database target/search path matches the reader.
Inspect migration history through an authorized read-only connection. First
check whether the configured migration ledger exists (the default is
`schema_migrations`); if it does, inspect its version and dirty flag. Do not
create a ledger to make this check pass:

```sql
BEGIN READ ONLY;
SELECT to_regclass('schema_migrations');
-- Run only if the configured ledger exists and SELECT is authorized:
SELECT version, dirty FROM schema_migrations;
COMMIT;
```

Only a verified clean migration-21 ledger plus the expected pre-0022 schema
justifies applying 0022 directly. A migration operator uses the existing
direct/unpooled owner connection and reviewed migrations, from the repository
root. This connection must never be substituted into the public service.

Only after explicit production-change authorization, with a clean version 21
ledger and the expected pre-0022 schema confirmed on that same target:

```bash
migrate -path backend/migrations -database "$DIRECT_DSN" goto 22
migrate -path backend/migrations -database "$DIRECT_DSN" version
# expect: version 22, not dirty
```

The migration adds nullable text columns and hex checks; no data backfill is required
to restore this projection. A missing/dirty ledger, an earlier version, version
22 with missing columns, a shadow relation, or partial schema state requires
reconciliation first. Do not replay bootstrap SQL, force a migration version,
remove profile blocks, or grant the reader write privileges.

After an authorized repair, require health=200 and the exact Liga MX team
request=200 with the documented profile shape. Also check unknown team=404,
invalid scope=400, legitimate empty arrays, null statistics, and request-linked
logs. Investigate any newly exposed downstream error separately. A local passing
test and a merged diagnostics change do not prove production repaired; record
its acceptance timestamp and request ID in [CURRENT_STATE](../../docs/CURRENT_STATE.md)
only after verification.

For this release, that acceptance requires both the colour projection and the
0023 freshness schema. Applying 0022 alone can restore an older reader but does
not satisfy the current binary's startup requirements.

## Verification

From `backend/`:

```bash
go test -race ./reader
go test ./...
go build ./...
go vet ./...
```

Reader integration tests apply the real migrations to Postgres 16 in
Testcontainers, seed representative rows, exercise every SQL shape, and verify
that `scorearc_reader` cannot insert, update, delete, or create tables.

## Production delivery

The reader releases through the `CI` workflow after the complete `test` job
succeeds on the exact `main` SHA. The release uses the `backend` build context,
`reader/fly.toml`, and `reader/Dockerfile`, with an app-scoped token held only in
the main-only `production-reader` environment.

Use a main CI dispatch with `release=reader` for a deliberate redeploy. Rollback
requires a revert PR and fresh main CI. Do not deploy a local working tree or
an old image directly. See the [release runbook](../../docs/backend/RELEASES.md)
for activation, concurrency, interrupted-release recovery and health acceptance.

If the token name exists but the release reports an empty value, use the
authorized main-only **Production credential preflight (no deployment)** with
`service=reader`. It checks ordinary environment-bound credential presence without
deploying or creating a release record; the direct/reusable comparison was the
historical diagnosis. Follow the
[diagnostic runbook](../../docs/backend/RELEASES.md#non-deploying-credential-preflight);
do not infer empty storage from a missing value or add broad secret inheritance.
An earlier eligibility failure instead reports constant failed-check names;
follow the [eligibility diagnosis](../../docs/backend/RELEASES.md#eligibility-rejection-diagnostics)
without relaxing the exact-SHA/current-attempt gate.
