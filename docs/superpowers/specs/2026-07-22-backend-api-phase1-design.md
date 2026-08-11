# Backend API — Phase 1: Own the data contract (Go on GCP)

**Status:** Design approved (brainstorming) · 2026-07-22
**Scope:** One implementation plan (large; built in ordered slices 1a–1d). Phase 1 of a multi-phase platform.

## Goal

Stop reading ESPN directly at request time. Stand up our own backend on Google
Cloud so **ScoreArc reads from our API** — a Cloud SQL Postgres fed by a Go
ingester and served by a public Go read API. ESPN becomes an upstream we ingest
from, not a per-request dependency. This is the foundation the rest of the
roadmap (time-series, historical/xG backfill, own ML, Claude language layer, the
LED board) builds on.

## Context & the seam

The frontend already reads through one interface — `DataStore` (in
`src/server/data/store.ts`), six methods: `getMatches`, `getStandings`,
`getBracket`, `getMatchSummary`, `getTopScorers`, `getNews`. All data fetching is
**server-side** (Next.js server components + `/api` routes). Today `DataStore` is
ESPN read-through with a TTL cache and no persistence. Phase 1 adds a second
`DataStore` implementation that calls our API; nothing else in the frontend
changes.

## Scope boundary (Phase 1 deliverable)

- **Cloud SQL Postgres** (private) with the Phase-1 schema.
- **Go ingester** (Cloud Run, always-on worker) — polls ESPN, upserts current
  state, freezes finished matches, mirrors logos to Cloud Storage.
- **Go reader** (Cloud Run) — a **public**, read-only, cacheable REST/JSON API
  serving the shapes the frontend needs; `news` is a live proxy to ESPN.
- **Cloud Storage + CDN** for self-hosted team/flag/emblem images.
- **Frontend cutover** — a new `apiStore` `DataStore` behind a `DATA_SOURCE`
  flag, with ESPN as fallback during rollout.
- **Infra + CI/CD** — monorepo, GitHub Actions + Workload Identity Federation →
  Artifact Registry → Cloud Run; infra as Terraform in `/infra`.

**Designed for, deferred:** BigQuery streaming and the time-series *writes*.
Their schema (`*_snapshot` tables) and the ingester's `emitSnapshots()` hook
exist in Phase 1 but are no-ops; Phase 2 fills them and streams immutable history
to BigQuery — no reshape required.

**Live vs historical** is a first-class axis: current state is hot/mutable
(upserted); a finished match is frozen (`finalized_at`) and immutable; time-series
snapshots are append-only (Phase 2). The ingester has two modes accordingly.

## Architecture

```
                      ┌──────────────── Google Cloud ────────────────┐
 ESPN (upstream) ───▶ │ Ingester (Go, Cloud Run, always-on, no ingress)│
                      │   poll ESPN → map → upsert; freeze on finish;   │
                      │   mirror logos → GCS; emitSnapshots() [no-op]    │
                      │        │ writes (ingester role)                  │
                      │        ▼                                         │
                      │  Cloud SQL Postgres (PRIVATE IP)                 │
                      │        ▲ reads (reader role, SELECT-only)        │
                      │  Reader (Go, Cloud Run, PUBLIC) ────────────────┼──▶ public consumers
                      │   REST/JSON /v1/…; news = live ESPN proxy;       │    (frontend, LED board, 3rd parties)
                      │   rate-limited; CDN-cacheable                    │
                      │  Cloud Storage (scorearc-assets) + Cloud CDN     │
                      └──────────────────────────────────────────────────┘
   Next.js on Vercel ── DataStore(apiStore) ──▶ Reader /v1/…   (server-side; ESPN fallback via flag)
```

- **Ingester:** always-on (min-instances 1); internal ticker polls fast (~15–30s)
  only during live windows, near-idle otherwise. **No public ingress.**
- **Reader:** public, autoscaling, scale-to-zero; the product's API surface.
- **Cloud SQL:** private IP, reached by both Go services via the Cloud SQL
  connector.

## Data model

`comp_id`/`season_id` are the **text config keys** from `competitions.ts` (config
stays the source of truth — no season table). `team.id`/`match.id` are **ESPN
ids** (idempotent upserts). `BracketRound[]` is a **read-model** computed from
`match` rows (round + winners) — no bracket table. Rich, variable per-match
detail is **jsonb** (lossless, serves the existing frontend types verbatim).
**No `news` table** (news is proxied live). `team.crest_url` holds **our CDN
URL** (GCS object is the source of truth).

### Tier 1 — current state (hot, upserted)

```sql
CREATE TABLE team (
  id text PRIMARY KEY, name text NOT NULL, abbr text NOT NULL,
  crest_url text, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  id text PRIMARY KEY, comp_id text NOT NULL, season_id text NOT NULL,
  round text, kickoff timestamptz NOT NULL, state text NOT NULL,
  home_team_id text NOT NULL REFERENCES team(id),
  away_team_id text NOT NULL REFERENCES team(id),
  home_score int, away_score int, minute text,
  status_detail text NOT NULL DEFAULT '', status_name text NOT NULL DEFAULT '',
  winner_id text, note text, finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_comp_season_idx ON match (comp_id, season_id, kickoff);
CREATE INDEX match_state_idx ON match (state);

CREATE TABLE match_detail (
  match_id text PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  scorers jsonb NOT NULL DEFAULT '[]', cards jsonb NOT NULL DEFAULT '[]',
  stats jsonb, win_probability jsonb, shootout jsonb, shootout_detail jsonb,
  lineups jsonb, videos jsonb NOT NULL DEFAULT '[]', info jsonb, form jsonb,
  h2h jsonb NOT NULL DEFAULT '[]', commentary jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE standing (
  comp_id text NOT NULL, season_id text NOT NULL,
  team_id text NOT NULL REFERENCES team(id),
  rank int NOT NULL, played int NOT NULL DEFAULT 0, wins int NOT NULL DEFAULT 0,
  draws int NOT NULL DEFAULT 0, losses int NOT NULL DEFAULT 0,
  goals_for int NOT NULL DEFAULT 0, goals_against int NOT NULL DEFAULT 0,
  goal_difference int NOT NULL DEFAULT 0, points int NOT NULL DEFAULT 0,
  advanced bool NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comp_id, season_id, team_id)
);

CREATE TABLE top_scorer (
  comp_id text NOT NULL, season_id text NOT NULL, rank int NOT NULL,
  player text NOT NULL, team_id text REFERENCES team(id),
  goals int NOT NULL, matches int,
  PRIMARY KEY (comp_id, season_id, rank)
);
```

### Tier 3 — time-series (created now, written Phase 2)

```sql
CREATE TABLE standing_snapshot (
  id bigserial PRIMARY KEY, comp_id text NOT NULL, season_id text NOT NULL,
  team_id text NOT NULL, captured_at timestamptz NOT NULL,
  rank int NOT NULL, points int NOT NULL, goal_difference int NOT NULL, played int NOT NULL
);
CREATE INDEX standing_snapshot_key_idx ON standing_snapshot (comp_id, season_id, captured_at);

CREATE TABLE win_prob_snapshot (
  id bigserial PRIMARY KEY, match_id text NOT NULL, captured_at timestamptz NOT NULL,
  home numeric(5,2) NOT NULL, draw numeric(5,2) NOT NULL, away numeric(5,2) NOT NULL
);
CREATE INDEX win_prob_snapshot_match_idx ON win_prob_snapshot (match_id, captured_at);
```

### Ops

```sql
CREATE TABLE ingest_run (
  id bigserial PRIMARY KEY, comp_id text, kind text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  ok bool, error text
);
```

### Roles (least privilege)

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA public TO scorearc_reader;             -- public API path
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO scorearc_ingester;
```

## Ingester

- Go worker, always-on Cloud Run (min-instances 1), no public ingress.
- **Cadence:** internal ticker; fast (~15–30s) while any match is live in the
  current window, slow (minutes) otherwise. Which competitions/seasons to poll
  comes from `competitions.ts` (shared config; see Repo).
- **Mappers:** re-implement the ESPN→domain mapping in Go, verified against the
  same recorded ESPN JSON fixtures the TS mappers use.
- **Upsert:** current state into Tier-1 tables (idempotent by ESPN id).
- **Freeze:** on `state → finished`, write finals + set `finalized_at`; skip
  further upserts of that match.
- **Assets:** on first sight of a team/flag/emblem, download the image once →
  `gs://scorearc-assets/…` → set `crest_url` to our CDN URL. Skip if present.
- **`emitSnapshots()`** — a hook called on each ingest tick; **no-op in Phase 1**
  (Phase 2 writes the snapshot tables + streams to BigQuery).
- **Observability:** write `ingest_run` rows; structured logs to Cloud Logging.

## Reader API

- Go REST/JSON, public, autoscaling, scale-to-zero. Versioned under `/v1`.
- Endpoints mirror the six `DataStore` methods, e.g.:
  - `GET /v1/competitions/{comp}/{season}/matches`
  - `GET /v1/competitions/{comp}/{season}/standings`
  - `GET /v1/competitions/{comp}/{season}/bracket` (computed read-model)
  - `GET /v1/competitions/{comp}/{season}/top-scorers`
  - `GET /v1/matches/{id}` (summary/detail)
  - `GET /v1/competitions/{comp}/news` — **live proxy to ESPN** (short TTL
    cache), not DB-served.
- **Inputs are typed + whitelisted:** `comp`/`season` validated against known
  config; ids are opaque query parameters only.
- **Response shapes** match the frontend's existing types; an **OpenAPI** doc is
  the shared contract source of truth.
- **Cacheable:** `Cache-Control` on responses so Cloud CDN / consumers cache
  (short TTL for live, longer for finished/static).
- **Rate-limited** per IP (Cloud Armor or app-level). Open read tier now; API
  keys/quotas deferred until a consumer needs them.

## Assets (self-hosted logos)

- **Cloud Storage bucket** `scorearc-assets`, public-read objects, fronted by
  **Cloud CDN** on our domain (`cdn.scorearc.futbol` or similar).
- Layout: `teams/{teamId}.png`, `flags/{code}.png`, `emblems/{compId}.png`.
- The ingester mirrors each asset **once** on first sight; the API returns our
  URLs. The frontend can drop its hardcoded `CREST_MAP` / `FLAG_MAP`.

## Security

- **Public:** only the Reader (curated, read-only, versioned). **Private:** Cloud
  SQL (private IP, never exposed), Ingester (no ingress).
- **Injection-proof by construction:** parameterized queries only (sqlc or pgx
  placeholders) — no string-built SQL; typed/whitelisted inputs; no free-form
  query surface. The **reader DB role is SELECT-only**, so the public path
  physically cannot write.
- Secrets (DB creds, tokens) in **Secret Manager**, injected at deploy.
- **Per-service service accounts**, least-privilege IAM.
- TLS end-to-end (Cloud Run HTTPS; Cloud SQL connector encrypts).
- Rate limiting + CDN in front of the Reader as defense-in-depth/scale.

## Frontend cutover

- New `apiStore` implementing `DataStore` by calling the Reader `/v1` endpoints
  and deserializing into the existing types (`Match`, `Group`, `BracketRound`,
  `MatchSummaryData`, `TopScorer`, `NewsArticle`).
- `DATA_SOURCE` env flag (`espn` | `api`) selects the implementation; default
  `espn` until parity is verified, then flip to `api`.
- During rollout, `apiStore` **falls back to the ESPN store on error** so a
  backend issue never dark-pages the site.
- No page/component changes — only the seam swaps.

## Repo & deploy

- **Monorepo.** Go services under `/backend` (`/backend/ingester`,
  `/backend/reader`, `/backend/shared` for schema + mappers + config).
  Infra under `/infra` (Terraform). Frontend unchanged; Vercel ignores
  `/backend` + `/infra`.
- **Config sharing:** the competition/season list (`competitions.ts`) is the
  source of truth for what to ingest. Phase 1 exports it to a language-neutral
  form (a generated JSON committed to the repo, or a small codegen step) that the
  Go services read — so frontend and backend agree on comps/seasons without
  duplicated hand-maintained lists.
- **CI/CD:** GitHub Actions, **Workload Identity Federation** (keyless) → build
  container → **Artifact Registry** → deploy **Cloud Run**. Two path-filtered
  workflows (`deploy-reader`, `deploy-ingester`) so a change to one doesn't
  redeploy the other.
- **Infra provisioning:** Cloud SQL, Artifact Registry, GCS bucket + CDN, WIF
  pool, service accounts, IAM — **Terraform in `/infra`**, applied manually
  (not from app pushes). Phase-1 may bootstrap with a documented `gcloud` script
  and convert to Terraform as we go.

## Build order (for the plan) & manual GCP work

Ordered, each independently verifiable:
1. **1a — Infra + schema:** GCP project/APIs, Cloud SQL instance + roles, GCS
   bucket + CDN, Artifact Registry, WIF, service accounts; SQL migrations
   (Tier-1 + Tier-3 skeleton + ops).
2. **1b — Ingester:** Go worker + ESPN mappers (fixture-tested) + upsert/freeze +
   asset mirroring; deployed; populates the DB.
3. **1c — Reader:** Go API serving all endpoints (+ news proxy) from the DB;
   OpenAPI; deployed public.
4. **1d — Cutover:** `apiStore` behind the flag with ESPN fallback; verify parity
   page-by-page; flip `DATA_SOURCE=api`.

**Manual/authorized by the user (not code):** creating the GCP project +
billing, running `terraform apply` / `gcloud` for infra, setting the WIF trust to
this GitHub repo, and holding any Vercel env vars. The plan interleaves "code to
write" with "commands you run."

## Testing

- **Go mappers:** unit tests against the recorded ESPN JSON fixtures (parity with
  the TS mappers).
- **Repository:** Go tests against ephemeral Postgres (testcontainers) — upsert,
  freeze-on-finish, asset-skip-if-present.
- **Reader handlers:** table-driven (DB rows → expected JSON).
- **Contract:** `apiStore` parses real Reader output into the TS types; OpenAPI as
  shared contract; a parity check the JSON deserializes cleanly.
- **Frontend:** `apiStore` unit test against a mocked Reader response.
- **Infra:** `terraform validate` / plan in CI.

## Out of scope (future phases)

- Phase 2 — time-series *writes* + BigQuery streaming (schema/hook exist now).
- Phase 3 — historical + xG backfill (scraping / open data).
- Phase 4 — own ML (xG, odds, season sim, similarity) precomputed.
- Phase 5 — Claude language layer (summaries, Q&A via tool-use over our API).
- LED board consumer (just polls `/v1/…` when built).
- API keys/quotas, a truly public unauthenticated write path (never), light theme.
