# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, GitHub Copilot, Cursor, etc.)
working in this repo. ScoreArc is a live World Cup 2026 → multi-competition fútbol
platform (Next.js on Vercel, deployed at scorearc.futbol). The frontend gets data
from ESPN's **keyless** public API today; we are building **our own Go backend**
to serve that data instead.

> **New to the project?** Read **`VISION.md`** (repo root) first — the vision, the
> signature arc-bracket identity, the roadmap (own the data → history → AI-powered
> stats), and fútbol domain knowledge future agents need.

> **Working on the backend / API?** Read **`BACKEND_HANDOFF.md`** (repo root) FIRST
> — it's the self-contained onboarding (stack, current state, what's next, setup).
> Start each backend slice from the latest `origin/main` on its own feature branch.
> This AGENTS.md's rules (never push to `main`, feature-branch, test before PR,
> conventional commits) apply to backend work too; the backend-specific commands
> and commit-trailer note are under **"Backend (Go)"** below.

## Workflow — non-negotiable

**`main` auto-deploys to production (scorearc.futbol) on every push.** Therefore:

1. **Never commit or merge directly to `main`.** Do all work on a feature branch
   (`feat/...`, `fix/...`, `tweak/...`).
2. **Test locally before opening a PR.** Run `npm run dev` and verify the change in the
   browser, plus `npm test` and `npx tsc --noEmit`. Only open a PR once it works locally.
3. Integrate via PR, not by pushing to `main`. Do not use `gh pr merge`/`--admin` to
   self-merge unless the user explicitly asks — merging is the user's decision.

## Commands

- `npm run dev` — local dev server (Next.js). Verify UI changes here before any PR.
- `npm test` — run the Vitest suite once (`vitest run`).
- `npm run test:watch` — watch mode.
- Single test: `npx vitest run <file> -t "<test name>"`.
- `npx tsc --noEmit` — typecheck (strict). Must be clean before a PR.
- `npm run lint` — ESLint (`next lint`).
- `npm run build` — production build; run it if a change could affect the build.

After hot-editing components/CSS, HMR can corrupt (`__webpack_require__.n is not a
function`). Fix: kill dev server, `rm -rf .next`, restart.

## Backend (Go) — the `/backend` API build

We are building a Go backend (an ESPN ingester + a public read API) on **Fly.io +
Neon Postgres (provisioned via Vercel) + Cloudflare R2**. Full detail:
**`BACKEND_HANDOFF.md`** → `docs/backend/SETUP.md` (tools + cloud setup) +
`docs/backend/ARCHITECTURE.md` (schema/endpoints/security).

- Go module: `github.com/mcasillas17/scorearc-backend` under `/backend` (Go 1.26+).
- `cd backend && go build ./...` — build. `cd backend && go test ./...` — test;
  use `cd backend && go test -race ./...` for the full backend gate, then
  `cd backend && go vet ./...` — static checks
  (some packages use testcontainers → **Docker must be running**).
- The ingester requires `POOLED_DSN` for normal writes and
  `INGESTER_LEASE_DSN` for a dedicated direct/unpooled advisory-lock session.
  Both must use the least-privilege ingester login; never use the DB owner.
- `npm run export:competitions` — regenerate `backend/config/competitions.json`
  from `src/server/data/competitions.ts` (the single source of truth — never
  hand-edit the JSON).
- Vercel ignores `/backend`, `/infra`, and `/docs` (`.vercelignore`).
- **Agent identity in commits:** this repo's history uses a `Co-Authored-By:`
  trailer. Substitute **your own** agent identity — e.g. Codex:
  `Co-Authored-By: Codex <noreply@openai.com>`; Copilot:
  `Co-Authored-By: Copilot <noreply@github.com>`. Do **not** attribute commits to
  another agent.
- **No Superpowers?** The `docs/superpowers/plans/*.md` are plain, bite-sized TDD
  checklists — execute them top-to-bottom (run each step's command, confirm its
  "expect:" output, commit at the commit step). Ignore any "REQUIRED SUB-SKILL"
  header; it only names the tool the humans used to *produce* the plan.

## Architecture

- `src/app/` — Next.js App Router (pages, `layout.tsx`, `api/` routes, `globals.css`).
- `src/components/` — React components (one `.tsx` each).
- `src/server/data/` — the data layer. ESPN read-through lives behind a `DataStore`
  seam: `store.ts` (public API), `providers/` (ESPN mappers, e.g. `espn-summary.ts`),
  `cache.ts`, `types.ts`, and `__fixtures__/` (recorded ESPN JSON for tests).
  **Add data by extending a mapper + type + component through this seam — don't add new
  fetch call sites in components.**
- `@/` path alias maps to `src/` (e.g. `@/server/data/types`).

## Conventions

- **TypeScript strict.** No `any` in new code unless matching existing mapper patterns
  (the ESPN mappers use `any` on raw payloads deliberately, then return typed shapes).
- **DRY / shared components** — reuse existing components; never duplicate markup. When
  something renders in two places, factor it into one component.
- **Styling** is a single `src/app/globals.css` with namespaced classes (`ls-stat-*`,
  `md-*`, etc.). Reuse existing CSS tokens (`--gold`, `--text-muted`, `--surface-2`,
  `--hairline`, `--text`) rather than hardcoding colors.
- Commit messages: conventional prefixes (`feat:`, `fix:`, `tweak:`, `polish:`,
  `chore:`, `docs:`).

## Testing

- Vitest, colocated `*.test.ts` next to source. Mappers are tested against recorded
  fixtures in `src/server/data/__fixtures__/`.
- Presentational components are verified by running the app, not unit tests.

## Specs & plans

Design specs live in `docs/superpowers/specs/`, implementation plans in
`docs/superpowers/plans/`. For non-trivial features, write a spec → plan first as
plain markdown files (the "Superpowers" skill names are just how these were
authored — any agent can write the same markdown by hand). A plan is a
task-by-task, TDD, checkbox checklist with exact code and `expect:` outputs;
execute it linearly and commit per task.
