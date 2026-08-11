# ScoreArc

ScoreArc is a live, multi-competition fútbol platform built around the 2026
World Cup. The Next.js application is deployed at
[scorearc.futbol](https://scorearc.futbol); the Go backend owns the emerging
public data contract for the website, physical scoreboards, and third-party
consumers.

```mermaid
flowchart LR
  ESPN["ESPN keyless public API"] --> Web["Next.js data layer"]
  ESPN --> Ingester["Go ingester (always-on private worker)"]
  Ingester --> DB[("Neon Postgres")]
  Ingester --> R2["Cloudflare R2 crest CDN"]
  DB --> Reader["Go public reader API"]
  ESPN -->|"news only, 90 s internal TTL"| Reader
  Reader --> Consumers["Website cutover · LED boards · third parties"]
```

The frontend still uses the ESPN-backed `DataStore`. The reader API is now
implemented; switching the frontend seam to it is the next integration slice.

## Internal ingester

`backend/ingester` continuously reconciles the configured competitions from
ESPN into Postgres. It uses rolling scoreboard windows for normal polling,
daily full-season reconciliation, durable retries for unfinished finalization,
bracket-authoritative knockout metadata, and immutable final match history.
Team crests are validated and mirrored to R2.

The process uses a pooled writer DSN for normal work and a dedicated direct
connection for its singleton advisory lease. Run a complete one-shot
reconciliation with:

```bash
cd backend
set -a; . ./.env; set +a
go run ./ingester -once
```

`-once` has no fixed whole-cycle deadline; individual network and database
operations remain bounded. See `backend/.env.example` and
[`docs/backend/SETUP.md`](docs/backend/SETUP.md) for required variables.

## Public reader API

The reader lives in `backend/reader`, uses a SELECT-only Postgres role, and
publishes its complete OpenAPI 3.1 contract at
[`backend/reader/openapi.yaml`](backend/reader/openapi.yaml).

| Route | Source | Cache policy |
|---|---|---|
| `GET /healthz` | coalesced Postgres ping | `no-store`, rate-limit exempt |
| `GET /v1/competitions/{comp}/{season}/matches` | Postgres | 10 s live, otherwise 60 s |
| `GET /v1/competitions/{comp}/{season}/standings` | Postgres | 60 s |
| `GET /v1/competitions/{comp}/{season}/bracket` | Postgres read model | 10 s live, otherwise 60 s |
| `GET /v1/competitions/{comp}/{season}/top-scorers` | Postgres | 60 s |
| `GET /v1/competitions/{comp}/news` | live ESPN proxy, 90 s internal TTL | 60 s |
| `GET /v1/matches/{id}` | Postgres | 30 s |

Responses match the TypeScript models in `src/server/data/types.ts`. Empty
collections are JSON arrays, never `null`. Competition and season identifiers
are checked against the embedded registry before a query runs; every SQL value
uses a pgx parameter.

## Local development

Requirements: Node.js 20+, Go 1.26+, and Docker for the Postgres integration
tests.

```bash
npm install
npm run dev
npm test
npx tsc --noEmit

cd backend
go test -race ./...
go build ./...
go vet ./...
```

Run the reader against a migrated database using the SELECT-only login:

```bash
cd backend/reader
DATABASE_URL='postgres://scorearc_reader_user:…@…/scorearc?sslmode=require' \
PORT=8080 go run .
```

If Docker uses Colima, expose its active socket to Testcontainers:

```bash
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

See [`backend/reader/README.md`](backend/reader/README.md) for API behavior and
[`docs/backend/SETUP.md`](docs/backend/SETUP.md) for database provisioning.

## Repository map

- `src/app` — Next.js App Router pages and server routes.
- `src/components` — shared UI and colocated pure-logic tests.
- `src/server/data` — the `DataStore` seam, competition registry, ESPN mappers,
  fixtures, and frontend data contracts.
- `backend/config` — generated competition configuration embedded in Go.
- `backend/migrations` — current-state, snapshot, operations, and role schema.
- `backend/ingester` — private reconciliation worker, scheduler, and finalizer.
- `backend/shared/espn` — tested Go ESPN clients, domain types, and mappers.
- `backend/reader` — public Go REST API, SQL read models, middleware, OpenAPI,
  unit tests, and Testcontainers integration tests.
- `docs/backend` — system architecture and operator setup.
- `docs/superpowers/specs` / `plans` — design history and implementation plans.

## Delivery workflow

`main` auto-deploys the frontend to production. Work on a feature branch, run
the frontend and backend gates locally, and integrate through a pull request.
Merging remains a human decision.
