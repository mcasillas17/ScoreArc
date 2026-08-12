# ScoreArc Backend — Handoff

This document is the entry point for building the **ScoreArc backend API**. It's
written so an agent (or engineer) with **no prior context** can pick this up on a
fresh machine and continue. Read this file first, then `docs/backend/SETUP.md`
(tools + cloud setup) and `docs/backend/ARCHITECTURE.md` (the design).

> **Branching:** `main` is the integration baseline and auto-deploys. Start each
> backend slice on its own feature branch and merge only through a reviewed PR.
> Every backend slice starts from the latest `origin/main`; the reader and
> ingester now coexist on the same shared backend foundation.

> ⚠️ **Some steps need a human at a browser — an unattended agent cannot do
> them.** Account creation + these OAuth logins each open a browser:
> `gh auth login`, `fly auth login`, `vercel login`, `wrangler login`. Also human-only:
> putting a card on Fly, creating the **Cloudflare R2 API token** in the
> dashboard, and pointing `scorearc.futbol` DNS at Cloudflare for the logo CDN.
> When you hit one of these, **pause and hand back to the human** rather than
> getting stuck. Everything else (writing code, migrations, `fly deploy`, tests)
> an agent can do once those credentials exist.

---

## 1. What we're building (one paragraph)

ScoreArc is a live-football web app (Next.js, hosted on Vercel at
`scorearc.futbol`) that currently reads **ESPN's keyless public API directly at
request time** through a clean seam called `DataStore`. We are building **our own
backend** so the app — and other consumers like a physical LED scoreboard and
third parties — read from **our public API** instead of ESPN. ESPN becomes an
upstream we *ingest* from, not a per-request dependency. This is **Phase 1: "own
the data contract."** Everything else (time-series history, xG/ML, an AI language
layer) builds on it later.

## 2. The stack (DECIDED — this supersedes the GCP references in the spec)

> ⚠️ **Important:** the committed spec/plan under `docs/superpowers/` describe a
> **GCP** implementation (Cloud Run + Cloud SQL + GCS/CDN + Terraform). We have
> since **switched the hosting target** to the stack below. The **application
> design is unchanged** (same architecture, schema, endpoints, security model) —
> only the *infrastructure/host* changed. The GCP Terraform in `/infra` is
> **superseded and must be replaced** (see §5, next task).

```
Vercel        → hosts the Next.js frontend  +  provisions/manages the Postgres (Neon) via its Storage tab
Fly.io        → runs the two Go services (ingester + reader) as containers
Neon          → the Postgres database (managed through Vercel; pooled conn for the app, direct conn for migrations)
Cloudflare R2 → self-hosted team/flag/emblem logos + CDN (zero egress — important for a public API/CDN)
GitHub        → the monorepo + CI/CD (GitHub Actions → deploy to Fly)
```

Why this stack: cheapest at low/idle usage (Neon scales to zero), **zero egress**
on R2 (a public API + logo CDN otherwise racks up egress cost), and far simpler
to run solo than GCP. The Go code is provider-neutral — only `/infra` + deploy
are host-specific.

## 3. Repository layout

This is a **monorepo**. The frontend and backend live together; Vercel ignores
`/backend`, `/infra`, and `/docs` (via `.vercelignore`).

```
/                         Next.js frontend (unchanged; deploys to Vercel)
  src/server/data/        the DataStore seam (store.ts) + ESPN mappers (providers/) + types.ts
  src/app/                Next.js App Router pages + /api routes (all data-fetching is SERVER-SIDE)
/backend/                 the Go backend (module github.com/mcasillas17/scorearc-backend)
  config/                 loads competitions.json (generated from competitions.ts) → shared config
  migrations/             Postgres schema, hardening, roles, and rollback files
  ingester/               [IMPLEMENTED] private worker/store/cadence/assets
  reader/                 [IMPLEMENTED — slice 1c] public REST API serving the 6 shapes
  shared/espn/            tested Go ESPN client, domain types, and mappers
/infra/                   [SUPERSEDED — GCP Terraform; replace with Fly+Neon+R2, slice 1a-rev]
/docs/
  backend/                THIS handoff package (SETUP.md, ARCHITECTURE.md)
  superpowers/specs/      the full design spec (GCP-flavoured infra; app design still valid)
  superpowers/plans/      the implementation plans (task-by-task)
/scripts/export-competitions.mjs   regenerates backend/config/competitions.json from competitions.ts
```

The authoritative design detail is `docs/superpowers/specs/2026-07-22-backend-api-phase1-design.md`
(read it — only its GCP *infra* section is outdated; schema/endpoints/security stand).

## 4. What's already done ✅

All committed on this branch. Verified: `cd backend && go build ./... && go test ./...` pass.

1. **Go module scaffold** — `backend/go.mod` (module `github.com/mcasillas17/scorearc-backend`, Go 1.26), `.vercelignore` excludes `/backend` `/infra` `/docs`.
2. **Config export** — `scripts/export-competitions.mjs` generates `backend/config/competitions.json` from the frontend's `src/server/data/competitions.ts` (single source of truth); `backend/config/config.go` loads it (`//go:embed`), with tests. Run `npm run export:competitions` to regenerate.
3. **Postgres migrations** — `backend/migrations/000{1,2}_*.sql`: the canonical
   schema (entities, `*_external_ref` crosswalk, current state, operations
   tables, replacement/retention grants, finalization guards) plus the snapshot
   skeleton, and the **least-privilege roles**
   (`scorearc_reader` = SELECT-only; `scorearc_ingester` = writer with narrowly
   scoped replacement deletes). See ARCHITECTURE.md for the full schema.
4. **Infra (GCP Terraform)** — `infra/*.tf`. ⚠️ **Superseded** by the Fly+Neon+R2 pivot; keep for reference but the next task replaces it.
5. **Shared ESPN layer** — Go endpoint builders, response models, and fixture-tested
   mappers for scoreboard, standings, bracket, summary, statistics, and news.
6. **Public reader API (slice 1c)** — six versioned `/v1` routes plus `/healthz`,
   parameterized pgx read models, registry validation, SELECT-only role
   enforcement, CORS, per-client limiting, defensive process timeouts, a
   stampede-safe news cache, OpenAPI 3.1, unit tests, and real-Postgres
   Testcontainers coverage. See `backend/reader/README.md`.
7. **Internal ingester (slice 1b)** — production wiring, bounded ESPN client,
   canonical mappers, transactional pgx writes, durable finalization backlog,
   monotonic state guards, bracket reconciliation, strict replacement safety,
   R2 crest mirroring, advisory-lock singleton lease, audit retention,
   graceful shutdown, and `-once` operation.
8. **Canonical identity** — ScoreArc mints its own entity ids (slugs for the
   curated sets, UUIDv7 for `match`/`player`); provider ids live in per-source
   `*_external_ref` crosswalk tables. `match` carries a natural-key unique
   constraint so the same fixture from a second source resolves to one row.
   Team identity is curated in `backend/config/teams.seed.json`; an unseeded
   team becomes a `provisional` row instead of blocking ingestion. See
   `docs/superpowers/specs/2026-08-12-canonical-identity-design.md`.

**Known minor follow-up:** Go struct field `config.Competition.CurrentSeasonId` should be renamed `CurrentSeasonID` (Go initialism lint, ST1003) when a linter is added.

## 5. What's next (in order)

Each slice is its own spec-lite → plan → build cycle (see §6 for how we work).

- **1a-rev — Replace `/infra` for Fly + Neon + R2** ("-rev" = the revised infra
  for the new host). The existing plan `docs/superpowers/plans/2026-07-23-backend-1a-infra-schema.md`
  has 5 tasks: **tasks 1–3 (Go scaffold, config export, migrations) are DONE and
  stand; tasks 4–5 (GCP Terraform + GCP runbook) are SUPERSEDED — do not
  execute.** This slice writes a *new* plan and replaces the GCP Terraform:
  - `backend/reader/fly.toml` + `backend/ingester/fly.toml` + Dockerfiles.
  - Neon provisioning notes (provision via Vercel Storage; capture pooled + direct connection strings; create the `scorearc_reader`/`scorearc_ingester` roles + login users per the migrations).
  - Cloudflare R2 bucket + access keys for the logo mirror.
  - GitHub Actions workflows to deploy each Go service to Fly (`flyctl deploy`), path-filtered to `/backend`.
  - `docs/backend/SETUP.md` already contains the exact provisioning steps.
- **1b — Ingester**: **implemented.** Deployment configuration remains part of
  1a-rev. Production requires a pooled writer DSN and a direct/unpooled lease
  DSN using the same least-privilege login.
- **1c — Reader**: **implemented.** Deployment configuration remains part of
  1a-rev; production rollout must use the SELECT-only reader DSN.
- **1d — Frontend cutover**: add an `apiStore` implementation of `DataStore` (in `src/server/data/`) that calls the reader; select it via a `DATA_SOURCE=api|espn` env flag with ESPN fallback; verify parity; flip to `api`.
- **Phase 2+** (later): time-series snapshot writes + an analytics store (BigQuery cross-cloud, or R2+DuckDB, or defer and use Neon); historical/xG backfill; own ML; Claude language layer; the LED board consumer.

## 6. How we work

These docs were **produced** with the "Superpowers" Claude-Code workflow (brainstorm
→ spec → plan → subagent-driven execution). **You do not need Superpowers to
execute them** — and Codex / Copilot don't have it. The artifacts are plain markdown:

- A **spec** (`docs/superpowers/specs/…-design.md`) describes the *what*.
- A **plan** (`docs/superpowers/plans/…-<slice>.md`) is a task-by-task, TDD,
  checkbox checklist with **exact code and `expect:` outputs**.

**Workflow-agnostic execution (do this):**
1. If the slice has **no plan yet**, first check `docs/superpowers/plans/` (1b and
   1c now have plans). If none exists,
   first **write one** as a markdown file in `docs/superpowers/plans/` following
   the 1a plan's shape (tasks → steps → code → `expect:` → commit). Pin the
   contracts in `docs/backend/ARCHITECTURE.md §10` before coding.
2. Execute the plan **top-to-bottom**: for each step run its command, confirm the
   stated `expect:` output, and commit at the task's commit step.
3. If you *do* have a subagent/task primitive, one-subagent-per-task + a review
   between tasks is nice-to-have, not required.
4. Ignore any `REQUIRED SUB-SKILL` header in a plan — it only names the tool the
   humans used to author it.

Hard rules (also in `AGENTS.md` — read it; Codex auto-loads it):
- **`main` auto-deploys the frontend to production. Never commit/merge to `main`.** Branch for all work (`feat/…`, `fix/…`).
- **Test before a PR:** `npx tsc --noEmit`, `npm test`, and for the backend `cd backend && go build ./... && go test ./...` (Docker running for testcontainers). Merging is the human's decision.
- Conventional commit prefixes (`feat:`/`fix:`/`docs:`/`chore:`). End commit messages with a `Co-Authored-By:` trailer using **your own** agent identity — e.g. `Co-Authored-By: Codex <noreply@openai.com>` or `Co-Authored-By: Copilot <noreply@github.com>`. Do **not** attribute commits to another agent.
- TypeScript strict; no `any`. Go: idiomatic, tested.

## 7. Key facts an agent needs

- **The seam:** the frontend reads everything through `DataStore` (6 methods) in `src/server/data/store.ts`. Phase 1 adds a second implementation (`apiStore`) that calls our reader. Nothing else in the frontend changes.
- **The 6 methods / shapes:** `getMatches`, `getStandings`, `getBracket`, `getMatchSummary`, `getTopScorers`, `getNews`. Types are in `src/server/data/types.ts` — the reader's JSON must deserialize into these.
- **Ingester durability:** final match/detail writes are atomic; finalized rows
  are database-protected from mutation; unresolved finals remain in a durable
  backlog; bracket classification is persisted so retries remain safe after a
  restart.
- **ESPN mapping already exists in TS** under `src/server/data/providers/espn-*.ts`, tested against recorded JSON in `src/server/data/__fixtures__/`. The Go ingester re-implements these; **test the Go port against the same fixtures** for parity.
- **All frontend data-fetching is server-side** (Next.js server components + `/api` routes) — so the reader can be public without the browser ever holding a DB credential.
- **Competitions/seasons** are config in `src/server/data/competitions.ts` (9 competitions). The Go side reads the generated `backend/config/competitions.json` — never hand-edit it; run `npm run export:competitions`.

---

**Start here:** read `docs/backend/SETUP.md` to install tools + provision the
cloud, then `docs/backend/ARCHITECTURE.md` for the schema/endpoints/security.
For API work, also read `backend/reader/README.md` and its `openapi.yaml`.
