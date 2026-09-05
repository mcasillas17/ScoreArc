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

## Observability

Reader logs are JSON on stdout for Fly to collect. Every non-successful health
check and every non-health request emits an access record with `request_id`,
`method`, concrete `path`, normalized `route`, `status`, `outcome`, response
`bytes`, `duration_ms`, and `client_ip`. A recovered panic also includes its
request id, method, path, route, and stack trace. Healthy `/healthz` probes are
intentionally omitted to keep application traffic visible. Ingester logs
similarly record each cycle's live state, failure count, duration, and sleep.

## Team-profile failures and schema repair

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
to that same disposable database and requires HTTP 200 with all profile blocks
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
