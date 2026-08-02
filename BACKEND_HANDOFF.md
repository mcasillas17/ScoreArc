# ScoreArc Backend — Handoff

This document is the entry point for building the **ScoreArc backend API**. It's
written so an agent (or engineer) with **no prior context** can pick this up on a
fresh machine and continue. Read this file first, then `docs/backend/SETUP.md`
(tools + cloud setup) and `docs/backend/ARCHITECTURE.md` (the design).

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
`/backend` and `/infra` (via `.vercelignore`).

```
/                         Next.js frontend (unchanged; deploys to Vercel)
  src/server/data/        the DataStore seam (store.ts) + ESPN mappers (providers/) + types.ts
  src/app/                Next.js App Router pages + /api routes (all data-fetching is SERVER-SIDE)
/backend/                 the Go backend (module github.com/mcasillas17/scorearc-backend)
  config/                 loads competitions.json (generated from competitions.ts) → shared config
  migrations/             Postgres schema migrations (0001_init, 0002_snapshots)
  ingester/               [NOT YET BUILT — slice 1b] Go worker: poll ESPN → upsert → freeze → mirror logos
  reader/                 [NOT YET BUILT — slice 1c] Go public REST API serving the 6 shapes
  shared/                 [NOT YET BUILT] ESPN mappers (Go port) + db repo layer
/infra/                   [SUPERSEDED — GCP Terraform; replace with Fly+Neon+R2, slice 1a-rev]
/docs/
  backend/                THIS handoff package (SETUP.md, ARCHITECTURE.md)
  superpowers/specs/      the full design spec (GCP-flavoured infra; app design still valid)
  superpowers/plans/      the implementation plans (task-by-task)
/scripts/export-competitions.mjs   regenerates backend/config/competitions.json from competitions.ts
```

The authoritative design detail is `docs/superpowers/specs/2026-07-22-backend-api-phase1-design.md`
(read it — only its GCP *infra* section is outdated; schema/endpoints/security stand).

## 4. What's already done ✅ (slice 1a, tasks 1–4)

All committed on this branch. Verified: `cd backend && go build ./... && go test ./...` pass.

1. **Go module scaffold** — `backend/go.mod` (module `github.com/mcasillas17/scorearc-backend`, Go 1.26), `.vercelignore` excludes `/backend` `/infra` `/docs`.
2. **Config export** — `scripts/export-competitions.mjs` generates `backend/config/competitions.json` from the frontend's `src/server/data/competitions.ts` (single source of truth); `backend/config/config.go` loads it (`//go:embed`), with tests. Run `npm run export:competitions` to regenerate.
3. **Postgres migrations** — `backend/migrations/000{1,2}_*.sql`: the schema (Tier-1 current-state + Tier-3 snapshot skeleton + ops) and the **least-privilege roles** (`scorearc_reader` = SELECT-only; `scorearc_ingester` = SELECT/INSERT/UPDATE). See ARCHITECTURE.md for the full schema.
4. **Infra (GCP Terraform)** — `infra/*.tf`. ⚠️ **Superseded** by the Fly+Neon+R2 pivot; keep for reference but the next task replaces it.

**Known minor follow-up:** Go struct field `config.Competition.CurrentSeasonId` should be renamed `CurrentSeasonID` (Go initialism lint, ST1003) when a linter is added.

## 5. What's next (in order)

Each slice is its own spec-lite → plan → build cycle (see §6 for how we work).

- **1a-rev — Replace `/infra` for Fly + Neon + R2.** Delete the GCP Terraform; add:
  - `backend/reader/fly.toml` + `backend/ingester/fly.toml` + Dockerfiles.
  - Neon provisioning notes (provision via Vercel Storage; capture pooled + direct connection strings; create the `scorearc_reader`/`scorearc_ingester` roles + login users per the migrations).
  - Cloudflare R2 bucket + access keys for the logo mirror.
  - GitHub Actions workflows to deploy each Go service to Fly (`flyctl deploy`), path-filtered to `/backend`.
  - `docs/backend/SETUP.md` already contains the exact provisioning steps.
- **1b — Ingester** (`backend/ingester/`): port the ESPN mappers to Go (test against the recorded fixtures in `src/server/data/__fixtures__/`), poll ESPN on an always-on ticker (fast while matches are live), upsert current state, freeze finished matches (`finalized_at`), mirror logos to R2, and stub `emitSnapshots()` (no-op in Phase 1).
- **1c — Reader** (`backend/reader/`): a public REST/JSON API under `/v1` serving the 6 shapes from Postgres (+ a live ESPN **proxy** for `/news`, which is NOT persisted). Injection-proof: parameterized queries only, typed/whitelisted inputs, SELECT-only DB role. Publish an OpenAPI doc.
- **1d — Frontend cutover**: add an `apiStore` implementation of `DataStore` (in `src/server/data/`) that calls the reader; select it via a `DATA_SOURCE=api|espn` env flag with ESPN fallback; verify parity; flip to `api`.
- **Phase 2+** (later): time-series snapshot writes + an analytics store (BigQuery cross-cloud, or R2+DuckDB, or defer and use Neon); historical/xG backfill; own ML; Claude language layer; the LED board consumer.

## 6. How we work (the workflow these docs assume)

This project is built with the **Superpowers** agent workflow. For each slice:

1. **Brainstorm** the slice → a short **spec** in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
2. **Write a plan** → `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` — bite-sized, TDD, exact code.
3. **Execute** via subagent-driven development — a fresh subagent per task, a spec+quality review after each, a whole-branch review at the end.

Hard rules (from `AGENTS.md` at the repo root — read it):
- **`main` auto-deploys the frontend to production. Never commit/merge to `main`.** Branch for all work (`feat/…`, `fix/…`).
- **Test before a PR:** `npx tsc --noEmit`, `npm test`, and for the backend `cd backend && go build ./... && go test ./...`. Merging is the human's decision.
- Conventional commit prefixes (`feat:`/`fix:`/`docs:`/`chore:`). End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- TypeScript strict; no `any`. Go: idiomatic, tested.

## 7. Key facts an agent needs

- **The seam:** the frontend reads everything through `DataStore` (6 methods) in `src/server/data/store.ts`. Phase 1 adds a second implementation (`apiStore`) that calls our reader. Nothing else in the frontend changes.
- **The 6 methods / shapes:** `getMatches`, `getStandings`, `getBracket`, `getMatchSummary`, `getTopScorers`, `getNews`. Types are in `src/server/data/types.ts` — the reader's JSON must deserialize into these.
- **ESPN mapping already exists in TS** under `src/server/data/providers/espn-*.ts`, tested against recorded JSON in `src/server/data/__fixtures__/`. The Go ingester re-implements these; **test the Go port against the same fixtures** for parity.
- **All frontend data-fetching is server-side** (Next.js server components + `/api` routes) — so the reader can be public without the browser ever holding a DB credential.
- **Competitions/seasons** are config in `src/server/data/competitions.ts` (9 competitions). The Go side reads the generated `backend/config/competitions.json` — never hand-edit it; run `npm run export:competitions`.

---

**Start here:** read `docs/backend/SETUP.md` to install tools + provision the
cloud, then `docs/backend/ARCHITECTURE.md` for the schema/endpoints/security, then
pick up **slice 1a-rev** (replace `/infra` for Fly+Neon+R2).
