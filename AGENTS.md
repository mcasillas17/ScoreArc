# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, GitHub Copilot, Cursor, etc.)
working in this repo. ScoreArc is a live World Cup 2026 → multi-competition fútbol
platform (Next.js on Vercel, deployed at scorearc.futbol). The frontend gets data
from ESPN's **keyless** public API today; we are building **our own Go backend**
to serve that data instead.

> **New to the project?** Read **`VISION.md`** (repo root) first — the vision, the
> signature arc-bracket identity, the roadmap (own the data → history → AI-powered
> stats), and fútbol domain knowledge future agents need.

> **Picking up feature work?** Read **`docs/PRODUCT_ROADMAP.md`** — the epic and
> task index (E0–E10), what is gated on the backend and what is not, and what we
> have decided *not* to build. Every epic links to its design spec and, where the
> work is ready to execute, a task-by-task implementation plan. Work is assigned
> by task id (`T0.1`, `T3.2`, …).

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
3. **Leave the dev server running and hand over the URLs.** Verifying it yourself
   is not the same as showing it. For any user-visible change, end your turn with
   a running server and the specific paths to look at — and say what to look
   *for* on each one, not just that it works. Do not wait to be asked; being
   asked "can I see it locally?" means this step was skipped.
4. Integrate via PR, not by pushing to `main`. Do not use `gh pr merge`/`--admin` to
   self-merge unless the user explicitly asks — merging is the user's decision.
5. **Verify what a merge actually contains**, not that the PR says `MERGED`.
   `git show --stat --oneline origin/main`. This has bitten twice: PR #85 merged
   only the first of three commits and PR #89 only its first slice, both because
   later commits had not been pushed when the merge happened. Nothing was lost
   either time — the remote branch still had them — but the follow-on work was
   built on a `main` that was missing half the change.

6. **Verify a responsive change across the breakpoint range, not at one width.**
   A fix checked at a single viewport is not checked. PR #97 widened the phone
   masthead to `min(100%, 340px)`, which meets the content edge at 390px and
   nowhere else -- 42px short at 430px, 172px at 560px. It was verified at 390px,
   shipped, and reached production still showing the bug it claimed to fix, now
   with an oversized logo as well. Render at a low, a middle and a high width
   inside the media query before opening the PR.

   And a zero-sized element is not necessarily a broken one. A redesign in this
   repo was justified by measuring nav links at `width: 0` on a phone and
   concluding the nav was broken; those links were deliberately hidden behind a
   working bottom tab bar, with a comment in `globals.css` saying so. Before
   calling something broken because it does not render, grep for what replaced
   it.

   Sticky is the other silent failure. `overflow` of anything but `visible`
   makes an element a scroll container, and `position: sticky` sticks to its
   nearest scrolling ancestor — so `overflow-x: hidden` on `html, body` turns
   every sticky descendant into `position: relative` with no error and no
   warning. That shipped here: the phone nav measured `top: -900` after a 900px
   scroll, leaving phone readers with no navigation past the first screenful.
   Use `overflow-x: clip`, which clips without creating a scroll container.

   Also confirm the rule you edited is the one that wins. `globals.css` is one
   long file and the same selector can appear in two media queries thousands of
   lines apart; the later one takes every conflict. The masthead had exactly
   that, and three fixes in a row appeared to do nothing because only the one
   property the winning block left undeclared ever got through. `grep -n` the
   selector across the file before editing it.

## Wording

**Say "match", not "fixture".** The site is US/Mexico-facing and the term reads
as British sportswriting. `/fixtures` was renamed to `/matches` for this reason,
and the team page shipped saying "Fixtures and results" anyway -- the rename is
the rule, not a one-off. Section headings, empty states and metadata all say
match.

Two exceptions, both meaning something else entirely: `__fixtures__` (recorded
test payloads) and ESPN's own `?fixture=true` parameter.

## Commands

- `npm run dev` — local dev server (Next.js). Verify UI changes here before any PR.
- `npm test` — run the Vitest suite once (`vitest run`).
- `npm run test:watch` — watch mode.
- Single test: `npx vitest run <file> -t "<test name>"`.
- `npx tsc --noEmit` — typecheck (strict). Must be clean before a PR.
- `npm run lint` — ESLint (`next lint`).
- `npm run build` — production build; run it if a change could affect the build.
- `npm run export:competitions` — **required** after any edit to
  `src/server/data/competitions.ts`. `backend/config/competitions.json` is
  generated from it and CI fails if the two drift. `npm test`/`tsc`/`lint`/`build`
  all pass while it is stale, so nothing local catches this — run the exporter and
  commit the JSON.

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
- **On Colima, `docker info` succeeding is not enough.** testcontainers looks for
  the socket at Docker Desktop's path and fails with
  `rootless Docker not found, failed to create Docker provider` — which looks like
  eleven test failures rather than a misconfigured environment. Export these first:

  ```bash
  export DOCKER_HOST="unix://$HOME/.colima/<profile>/docker.sock"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  ```

  Check which runtime you have with `docker context ls`, and take `<profile>`
  from the row marked `*` — it is not always `default`. Pointing at a profile
  that exists but is not running fails the same way as having no Docker at all,
  so the eleven failures look identical whether the socket path is wrong or the
  daemon is down.
- **PRs here are squash-merged, which breaks stacked branches.** After a base
  branch merges, the branch stacked on it still shows every one of the base's
  commits as unmerged — the content is in `main` but the SHAs are not. Do not
  open that PR; rebase off the already-merged commits first:

  ```bash
  git fetch origin
  git rebase --onto origin/main <merged-base-branch> <your-branch>
  ```

  Verify with `git rev-list --count origin/main..<your-branch>` — it should equal
  the number of commits that are genuinely yours.
- The ingester requires `POOLED_DSN` for normal writes and
  `INGESTER_LEASE_DSN` for a dedicated direct/unpooled advisory-lock session.
  Both must use the least-privilege ingester login; never use the DB owner.
- `npm run export:competitions` — regenerate `backend/config/competitions.json`
  from `src/server/data/competitions.ts` (the single source of truth — never
  hand-edit the JSON).
- **Team identity is curated, not generated.** `backend/config/teams.seed.json` is
  **hand-authored and reviewed** — the opposite of `competitions.json`. It assigns each
  team its canonical id (`eng-manchester-united`, `nat-mex`) plus the provider ids that
  map to it. `cd backend && go run ./cmd/seed-teams` proposes an updated seed on stdout;
  it merges with the committed file so curated slugs and countries survive. Regenerate
  **only** through a temp file:

  ```bash
  cd backend && go run ./cmd/seed-teams > /tmp/teams.seed.json && \
    mv /tmp/teams.seed.json config/teams.seed.json
  ```

  Never `> config/teams.seed.json`: the seed is embedded (`//go:embed`) as the
  generator's own merge base, so the shell truncates it before the command compiles —
  the generator refuses to run rather than reverting every hand-made correction. Review
  the diff before committing. An unseeded team does **not** break ingestion: it becomes
  a `provisional` row (`SELECT * FROM team WHERE provisional`) until curated. The weekly
  `.github/workflows/seed-drift.yml` reports teams ESPN knows that the seed lacks.
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

## Plans quote code as of the day they were written

A plan under `docs/superpowers/plans/` shows exact "replace this with that" blocks.
Those quotes are a snapshot, and `main` moves. **Open the file and diff it against
the quote before replacing anything.** Where they differ, apply the plan's
*intent* to the current code instead of pasting the quoted block.

This is not hypothetical: within a day of the 2026-08-15 plans being written,
telemetry was added across the API routes and several components. An agent
pasting a quoted block would have silently deleted `trackAPIRequestFailure` /
`trackFeedFailure` calls — a deletion that is invisible in review and only shows
up when a dashboard goes quiet.

If a plan's *premise* has changed (not just its quoted code), stop and say so
rather than improvising around it.

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
