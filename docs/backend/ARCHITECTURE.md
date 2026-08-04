# ScoreArc Backend — Architecture

Self-contained design reference for the backend. The full original spec is
`docs/superpowers/specs/2026-07-22-backend-api-phase1-design.md` (its GCP infra
section is superseded by the Fly+Neon+R2 pivot; everything else here matches).

---

## 1. System diagram

```
 ESPN (upstream) ───▶ Ingester (Go, Fly, always-on, NO public HTTP)
                        poll ESPN → map → upsert current state;
                        freeze matches on finish; mirror logos → R2;
                        emitSnapshots()  [no-op in Phase 1]
                              │ writes (ingester DB user)
                              ▼
                        Neon Postgres  (pooled conn for apps; direct for migrations)
                              ▲ reads (reader DB user — SELECT-only)
                        Reader (Go, Fly, PUBLIC) ──/v1/…──▶ public consumers
                          REST/JSON; news = live ESPN proxy;         (frontend, LED board, 3rd parties)
                          parameterized queries; rate-limited; CDN-cacheable
                        Cloudflare R2 (scorearc-assets) + CDN  →  logos

 Next.js on Vercel ── DataStore(apiStore) ──▶ Reader /v1/…   (server-side; ESPN fallback via flag)
```

- **Live vs historical is a first-class axis.** Current state is hot/mutable
  (upserted). A finished match is frozen (`finalized_at`) and immutable →
  historical results accrue for free. Time-series snapshots are append-only
  (Phase 2). The ingester behaves accordingly (upsert while live; write-and-freeze
  on finish).

---

## 2. The seam (why this is low-risk)

The frontend reads through **one interface**, `DataStore` (`src/server/data/store.ts`):

```ts
interface DataStore {
  getMatches(rc): Promise<Match[]>
  getStandings(rc): Promise<Group[]>
  getBracket(rc): Promise<BracketRound[]>
  getMatchSummary(rc, eventId, homeId, awayId): Promise<MatchSummaryData>
  getTopScorers(rc): Promise<TopScorer[]>
  getNews(rc): Promise<NewsArticle[]>
}
```

Today it's ESPN read-through + TTL cache. Phase 1 adds a second implementation,
`apiStore`, that calls our reader. **No page or component changes** — only the
seam swaps (slice 1d, behind a `DATA_SOURCE` flag with ESPN fallback). The
reader's JSON must deserialize into the existing types in
`src/server/data/types.ts`.

---

## 3. Database schema (Neon Postgres)

`comp_id`/`season_id` are the **text config keys** from `competitions.ts` (config
stays the source of truth — no season table). `team.id`/`match.id` are **ESPN
ids** (idempotent upserts). Rich per-match detail is **jsonb** (lossless, serves
the existing frontend types verbatim). **No `news` table** (proxied live).
`team.crest_url` holds **our R2/CDN URL**.

> **Bracket note (important — the frontend does NOT derive brackets from the
> matches feed today).** Currently `DataStore.getBracket` fetches a *separate*
> ESPN bracket scoreboard (`bracketUrl(slug, season.bracketDatesRange)`) and runs
> `mapBracket` (`providers/espn-bracket.ts`), which has non-trivial winner +
> shootout logic. In our backend there is **no bracket table** — the reader
> rebuilds `BracketRound[]` from `match` rows — but that only works if the
> **ingester persists knockout matches with `match.round` set to the slug
> vocabulary in each season's `knockoutRounds`** (`round-of-32 … final`) plus
> `winner_id` and shootout. So: port `mapBracket` to Go, **fixture-test it against
> `src/server/data/__fixtures__/espn-bracket*.json`**, and have the reader group
> `match` rows by `round` into `BracketRound[]`. (Leaf ordering lives in
> `competitions.ts`/`radialBracketModel.ts` on the frontend — correctly not in
> the backend.) See §10.

Migrations: `backend/migrations/0001_init.*.sql` (Tier-1 + roles),
`0002_snapshots.*.sql` (Tier-3 + ops).

### Tier 1 — current state (hot, upserted by the ingester)
- **team**(id PK, name, abbr, crest_url, updated_at)
- **match**(id PK, comp_id, season_id, round, kickoff, state[`scheduled|live|finished`], home_team_id→team, away_team_id→team, home_score, away_score, minute, status_detail, status_name, winner_id, note, **finalized_at**, updated_at) — indexes on `(comp_id,season_id,kickoff)` and `state`.
- **match_detail**(match_id PK→match, scorers jsonb, cards jsonb, stats jsonb, win_probability jsonb, shootout jsonb, shootout_detail jsonb, lineups jsonb, videos jsonb, info jsonb, form jsonb, h2h jsonb, commentary jsonb, updated_at)
- **standing**(PK (comp_id,season_id,team_id), rank, played, wins, draws, losses, goals_for, goals_against, goal_difference, points, advanced, updated_at)
- **top_scorer**(PK (comp_id,season_id,rank), player, team_id→team, goals, matches)

### Tier 3 — time-series (created now, WRITTEN in Phase 2 via `emitSnapshots()`)
- **standing_snapshot**(id bigserial, comp_id, season_id, team_id, captured_at, rank, points, goal_difference, played) — append-only.
- **win_prob_snapshot**(id bigserial, match_id, captured_at, home, draw, away) — append-only.

### Ops
- **ingest_run**(id bigserial, comp_id, kind, started_at, finished_at, ok, error) — observability.

### Roles (least privilege — enforces the read-only public path)
- `scorearc_reader` → **SELECT only** (the public reader connects as this).
- `scorearc_ingester` → SELECT/INSERT/UPDATE (only it writes).
- `ALTER DEFAULT PRIVILEGES` mirrors these so future tables inherit them.

---

## 4. Ingester (slice 1b — Go worker on Fly)

- Always-on (Fly `min_machines_running = 1`), **no public HTTP**.
- **Cadence:** internal ticker — fast (~15–30 s) while any match in the current
  window is live; slow (minutes) otherwise. Which comps/seasons to poll comes from
  `backend/config/competitions.json`.
- **Mappers:** port the ESPN→domain mapping from `src/server/data/providers/espn-*.ts`
  to Go, and **test against the recorded fixtures** in
  `src/server/data/__fixtures__/` so the Go output matches the TS mappers.
- **Upsert** current state into Tier-1 tables (idempotent by ESPN id).
- **Freeze:** on `state → finished`, write finals + set `finalized_at`; stop
  upserting that match (immutable history).
- **Assets:** on first sight of a team/flag/emblem, download the image once →
  R2 (`teams/{id}.png` etc.) → set `crest_url` to the CDN URL. Skip if present.
  Use the AWS S3 SDK pointed at the R2 endpoint.
- **`emitSnapshots()`** — hook called each tick; **no-op in Phase 1** (Phase 2
  writes the snapshot tables and/or streams to the analytics store).
- Writes `ingest_run` rows; structured logs.

---

## 5. Reader (slice 1c — public Go REST API on Fly)

- Public, autoscaling, scale-to-zero. Versioned under `/v1`.
- Endpoints mirror the 6 `DataStore` methods:
  - `GET /v1/competitions/{comp}/{season}/matches`
  - `GET /v1/competitions/{comp}/{season}/standings`
  - `GET /v1/competitions/{comp}/{season}/bracket`  (computed read-model)
  - `GET /v1/competitions/{comp}/{season}/top-scorers`
  - `GET /v1/matches/{id}`  (summary/detail)
  - `GET /v1/competitions/{comp}/news`  → **live proxy to ESPN** (short TTL cache), NOT DB-served.
- **Response shapes match the frontend types.** Publish an **OpenAPI** doc as the
  shared contract.
- **Cacheable:** `Cache-Control` (short TTL for live, longer for finished/static)
  so Cloudflare/consumers cache and shield the DB.
- **Rate-limited** per IP (app-level to start). Open read tier now; API
  keys/quotas deferred until a consumer needs them.

---

## 6. Security model

- **Public:** only the reader (curated, read-only, versioned). **Private:** the
  DB (Neon, not exposed to the public — the reader is the only thing consumers
  reach) and the ingester (no public HTTP).
- **Injection-proof by construction:** parameterized queries only (**sqlc** or
  pgx placeholders) — no string-built SQL exists; typed/whitelisted inputs
  (`comp`/`season` validated against `competitions.json`; ids are opaque
  parameters); no free-form query surface. The reader DB user is **SELECT-only**,
  so the public path physically cannot write.
- **Secrets** (DB DSNs, R2 keys) live in **Fly secrets** / GitHub Actions
  secrets — never in code.
- **TLS everywhere** (Fly HTTPS; Neon requires `sslmode=require`).
- **Rate limiting + CDN caching** in front of the reader as defense-in-depth/scale.

---

## 7. Frontend cutover (slice 1d)

- Add `apiStore` implementing `DataStore` by calling the reader `/v1` endpoints
  and deserializing into the existing types.
- `DATA_SOURCE` env flag (`espn` | `api`) selects the implementation; default
  `espn` until parity is verified, then flip to `api`.
- During rollout, `apiStore` **falls back to the ESPN store on error** so a
  backend issue never dark-pages the site.
- Set `SCOREARC_API_BASE` (the reader's public URL) in Vercel env.

---

## 8. Testing strategy

- **Go mappers:** unit tests against the recorded ESPN JSON fixtures (parity with
  the TS mappers) — copy/reference `src/server/data/__fixtures__/`.
- **Repository layer:** Go tests against ephemeral Postgres via **testcontainers**
  (Docker) — upsert, freeze-on-finish, asset-skip-if-present.
- **Reader handlers:** table-driven (DB rows → expected JSON).
- **Contract:** the `apiStore` (TS) parses real reader output into the TS types;
  OpenAPI as the shared contract.
- **Frontend:** `apiStore` unit test against a mocked reader response.

---

## 9. Deferred to later phases (do NOT build in Phase 1)

- **Phase 2** — time-series *writes* + an analytics store. Options when we get
  there: **BigQuery** (usable cross-cloud via API even off GCP), **R2 + DuckDB /
  MotherDuck** (data-lake on the object storage we already have — natural fit),
  **ClickHouse Cloud**, or just partitioned Neon/Postgres until it outgrows it.
  The `emitSnapshots()` hook + snapshot tables are the seam; whatever we pick
  attaches there without reshaping Phase 1.
- **Phase 3** — historical + xG backfill (scraping / open data: football-data.co.uk,
  StatsBomb open data; FBref/Understat are ToS-gray, rate-limit).
- **Phase 4** — own ML precomputed into the DB (xG=gradient boosting,
  odds=Dixon-Coles, season sim=Monte Carlo, similarity=clustering→pgvector).
- **Phase 5** — Claude language layer (auto match summaries via Haiku + Batch API;
  conversational Q&A via **tool-use over our own endpoints**, not text-to-SQL;
  "matches like this" via embeddings + pgvector). Don't train an LLM.
- **LED board** — a physical scoreboard (Adafruit Matrix Portal S3 + HUB75
  panels) that just polls a compact `/v1/…` endpoint when built.

---

## 10. Contracts to pin BEFORE writing the 1b/1c/1d plans

The prose above is not enough to implement directly — nail these down (in each
slice's plan) so the Go output matches the frontend verbatim. The **source of
truth is the TS**: `src/server/data/types.ts` (shapes), `providers/espn-*.ts`
(mapping), `endpoints.ts` (ESPN URLs), `store.ts` (how each method is assembled),
`__fixtures__/` (recorded ESPN JSON to test against).

**1b — Ingester**
- **Mapper → table map:** `espn-matches.ts` → `match`; `espn-summary.ts`
  (scorers/cards/stats/winProb/lineups/videos/info/form/h2h/commentary/shootout) →
  `match_detail` **jsonb** columns; `espn-standings.ts` → `standing`;
  `espn-stats.ts` → `top_scorer`; `espn-bracket.ts` → knockout `match` rows (see
  the bracket note in §3). `espn-news.ts` is **not** ingested (reader proxies it).
- **ESPN URLs to port:** `endpoints.ts` — `scoreboardUrl(slug, datesRange)`,
  `standingsUrl`, `summaryUrl`, `bracketUrl`, `statisticsUrl`, `newsUrl`. Which
  comps/seasons + date ranges to poll come from `backend/config/competitions.json`.
- **jsonb payloads must equal the `types.ts` shapes** so the reader can hand them
  back unchanged — fixture-test the Go mappers against `__fixtures__/`.
- **`emitSnapshots()`** — define now as a no-op method,
  `func (i *Ingester) emitSnapshots(ctx context.Context, tick Snapshot) error { return nil }`,
  called once per tick. Phase 2 fills it.
- **"Live" detection** for the fast/slow cadence: any polled `match.state == 'live'`.
- **Freeze predicate:** on `state → finished`, write finals, set `finalized_at`,
  and skip re-upsert while `finalized_at IS NOT NULL`.
- **Asset idempotency:** skip the download if the object already exists in R2
  (HEAD) or `team.crest_url` already points at our CDN.

**1c — Reader**
- **Endpoint → type map:** each `/v1/…` response must deserialize into exactly
  `Match[]` / `Group[]` / `BracketRound[]` / `MatchSummaryData` / `TopScorer[]` /
  `NewsArticle[]` from `types.ts`. Write a field-by-field map in the plan.
- **`/news` drops season:** `newsUrl(slug)` is comp-only; the endpoint is
  `/v1/competitions/{comp}/news` and `apiStore.getNews` builds it from
  `rc.competition`, ignoring season.
- **Query layer:** pick **sqlc** (recommended — compile-checked, parameterized) or
  `pgx` placeholders; either way, no string-built SQL.
- Add a `/healthz` route (used by the deploy check in SETUP §7).

**1d — Cutover**
- `apiStore` lives at `src/server/data/apiStore.ts`, implementing `DataStore`.
- Selection happens where the concrete store is chosen in `src/server/data/store.ts`
  (find where the ESPN store is instantiated); switch on `process.env.DATA_SOURCE`
  (`espn` default | `api`), reading the reader base from `SCOREARC_API_BASE`.
- `apiStore` wraps each call in try/catch and **falls back to the ESPN store on
  error** during rollout.
