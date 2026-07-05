# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, etc.) working in this repo.
ScoreArc is a live World Cup 2026 → multi-competition fútbol platform (Next.js on
Vercel, deployed at scorearc.futbol). Data comes from ESPN's **keyless** public API.

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

## Architecture

- `src/app/` — Next.js App Router (pages, `layout.tsx`, `api/` routes, `globals.css`).
- `src/components/` — React components (one `.tsx` each).
- `src/server/data/` — the data layer. ESPN read-through lives behind a `DataStore`
  seam: `service.ts` (public API), `providers/` (ESPN mappers, e.g. `espn-summary.ts`),
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
`docs/superpowers/plans/`. For non-trivial features, write the spec → plan first.
