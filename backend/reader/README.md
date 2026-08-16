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
