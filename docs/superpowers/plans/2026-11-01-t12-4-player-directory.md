# T12.4 Player Directory Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this single integrated task.

**Goal:** Browse/search current roster players within one competition and season.
**Architecture:** Extend the existing player index inside its source operation;
render a lightweight local-search component and localized page using existing UI.
**Tech Stack:** Next.js, TypeScript, React, Vitest; no additional dependencies.
**Spec:** `docs/superpowers/specs/2026-11-01-t12-4-player-directory-design.md`

## Global constraints

Preserve slug/collision rules, singular profile URLs, grouped fallback, bounded
reader concurrency, cancellation and strict failures. No backend or activation
work. Metadata must describe current rosters and historical limitations honestly.
No per-keystroke requests, profile prefetch or all-leagues roster fetches.

## Review focus

Partially missing rosters cannot claim complete historical coverage. Duplicate
athletes must keep the same team/slug pairing as existing profiles. Fallback must
rebuild displayed rows and links together. Exhausted failures must stay unavailable.
Phone navigation and EN/ES labels must remain usable with the sixth section.

### Task 1: Directory from index through browser and delivery

**Files:** `src/server/data/playerIndex.ts` and tests; new
`src/components/PlayerSearch.tsx` and tests; `PlayerName.tsx`; `SiteNav.tsx` and tests;
new `src/app/[locale]/c/[comp]/[season]/players/page.tsx` and tests;
`src/app/globals.css`; EN/ES message catalogs; related roadmap/evidence docs.

**Interfaces:** Index retains `bySlug` and `byProvider` and adds `directory` with
`players: { name, slug: string | null, teamName, teamAbbr }[]`, `totalTeams`,
`teamsWithRoster`. `PlayerSearch` receives those rows and a localized `playerBase`.
Page guards historical scopes before any index read. Existing consumers continue
using their original maps; directory derives all fields in the same callback.

- [x] Add index/source tests asserting roster coverage, deduplication, collisions,
  zero profile calls, homogeneous fallback rows/slugs and propagated failures.
- [x] Run `npx vitest run src/server/data/playerIndex.test.ts`.
  Expect new assertions to fail before implementation.
- [x] Extend index without changing the slug builder or source selection.
- [x] Add EN/ES search, historical/metadata/error and nav assertions; run the
  focused files and observe failures before implementing their corresponding UI.
- [x] Implement page, search and navigation using existing components/tokens.
- [x] Run focused tests. Expect all pass including existing index/profile tests.
- [x] Verify default ESPN and synthetic reader in browser, low/middle/high widths,
  keyboard profile navigation, standings forms and cold/warm measurements.
- [x] Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.
  Expect exit 0; retain the baseline's five lint warnings without unrelated edits.
- [x] Converge Knights implementation review and update materially affected docs.
  Round 1 found inherited social metadata; fixed with shared helpers and EN/ES
  regression tests. Round 2 returned no findings from all three reviewers.
- Delivery gate: rerun final checks and converge a fresh final three-model review.
- Delivery gate: re-evaluate before staging; commit task-owned files with conventional title
  and Codex trailer, push normally and open the non-draft PR. Do not merge/deploy.
- [x] Leave isolated local preview running and hand over exact URLs and evidence.

Pre-flight: one task; no cross-task interfaces. Commits follow Knights publication
gates; the single task's implementation and docs are reviewed together.
