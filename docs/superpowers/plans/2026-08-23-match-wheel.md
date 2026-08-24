# Match Wheel + Home Digest Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the horizontal fixture band with the snap-scrolling match wheel (time-picker drum) everywhere it appears, and stop the home digest from promoting competitions whose season has concluded.

**Architecture:** A pure model module (`matchWheelModel.ts`) owns ordering, initial focus, and score-change detection; a client `MatchWheel` component owns the drum (CSS scroll-snap + rAF transforms) and reuses the ticker's polling/popup/telemetry machinery; `UpcomingBanner` swaps its child; the ticker and its CSS die. Config gains `Season.concluded`; the home page fans out over `ongoingCompetitions()`.

**Tech stack:** Next.js 14, TypeScript strict, Vitest, single globals.css.

**Spec:** `docs/superpowers/specs/2026-08-23-match-wheel-design.md` — the working prototype's tuning values live in `public/fixture-concepts.html` (which Task 3 deletes).

**Worktree:** `/Users/elopenmike/build/Apps/Futbol/scorearc-liguilla`, branch `feat/fixture-wheel`.

---

### Task 1: `matchWheelModel` — pure ordering/focus/diff (TDD)

**Files:** Create `src/components/matchWheelModel.ts` + `src/components/matchWheelModel.test.ts`.

Functions (exact signatures):

```ts
import type { Match } from '@/server/data/types';

/** Chronological, stable: the drum's single ordering. */
export function wheelOrder(matches: Match[]): Match[];

/** Where the drum opens: first live; else first scheduled; else the LAST
 *  finished (most recent real thing in a season gap); else 0. Index into the
 *  wheelOrder()ed array. Empty input -> 0. */
export function initialIndex(ordered: Match[]): number;

/** Ids whose home or away score changed between polls (goal-flash input).
 *  A match present in only one of the two lists is NOT a change. */
export function scoreChanges(prev: Match[], next: Match[]): Set<string>;
```

TDD: tests first (build small `Match` literals with a local factory — see `src/components/splitByCut.test.ts` style), expect FAIL, implement, expect PASS. Cover: mixed states order chronologically; initial index for live / no-live-but-upcoming / all-finished / empty; score change detected on either side; new/removed matches ignored; unchanged scores produce an empty set.

Run: `cd /Users/elopenmike/build/Apps/Futbol/scorearc-liguilla && npx vitest run src/components/matchWheelModel.test.ts && npx tsc --noEmit`

Commit: `feat: match wheel model — order, focus, goal diff` (repo trailer rules).

---

### Task 2: `MatchWheel` component + banner swap

**Files:**
- Create: `src/components/MatchWheel.tsx` (client)
- Modify: `src/components/UpcomingBanner.tsx` (swap `UpcomingTicker` → `MatchWheel`, same props)
- Modify: `src/app/globals.css` (append a `/* ---- Match wheel (mw-*) ---- */` block — namespaced `mw-*`, reuse tokens, ONE occurrence per selector; grep after editing)
- Modify: `src/i18n/messages/en.ts` + `es.ts` if any new copy is needed (expected: none — meta reuses `LocalTime`, "Final" exists as `match.final`-family keys; check before inventing)

Component contract (mirror `UpcomingTicker`'s props so `UpcomingBanner` barely changes): `{ initialMatches, apiBase, teamBase, teamStyle, weekOnly }`.

Reuse VERBATIM from `UpcomingTicker.tsx` (read it first): the 15s poll effect incl. `weekOnly` query split and `trackFeedFailure/Recovery('upcoming')`, the mount-gating for client-clock rendering, the reduced-motion listener, the `MatchDetailPopup` open flow (`trackEvent('Match details opened', { surface: 'match-wheel' })`).

The drum (tuning from the prototype):
- Wrap: fixed height 330px (300px ≤760px), edge fade gradients, green-tinted center slot (`rgba(34,197,94,0.06)` bg, `0.25` border).
- Scroller: `overflow-y:auto; scroll-snap-type:y mandatory; overscroll-behavior:contain;` hidden scrollbar; vertical padding = (height − rowHeight)/2 so first/last rows can center.
- Rows: grid `1fr auto 1fr auto`; `scroll-snap-align:center`; full club names only ≥900px; the live-only green arc over the score (inline SVG `M3 11 Q28 -8 53 11`); meta = live minute chip / Final / `LocalTime` day+time.
- rAF scroll handler: per row, distance from center d ∈ [-1,1] → `rotateX(-38deg·d) scale(1−0.14|d|)`, opacity `1−0.65|d|`. Skip entirely under reduced motion.
- Initial scroll: `initialIndex()` row `scrollIntoView({block:'center'})` after mount.
- Live pulse (CSS keyframes on the arc+dot, ~2.4s), goal flash (row score scales + green flash ~1.2s when `scoreChanges()` includes the id), entrance cascade ≤400ms — ALL disabled under reduced motion.
- Rows are `<button type="button">` with an aria-label "HOME vs AWAY".

Verify in the browser (dev server port 3121): `/es/c/liga-mx/2026-apertura/standings` and the Liguilla root — drum renders, snaps, opens centered on live/next match, popup opens on click. Then `npm test && npx tsc --noEmit`.

Commit: `feat: the fixture band becomes the match wheel`.

---

### Task 3: ticker cleanup + prototype deletion

**Files:**
- Delete: `src/components/UpcomingTicker.tsx` (confirm no remaining imports: `grep -rn "UpcomingTicker" src/`)
- Delete its CSS: the `tick-*` marquee block in globals.css (`grep -n "tick-" src/app/globals.css` — confirm each class is unreferenced outside the deleted file before removing; `MatchDetailPopup` styles are separate and STAY)
- Delete: `public/fixture-concepts.html`
- Update any tests referencing the ticker (`grep -rn "UpcomingTicker\|tick-" src --include="*.test.*"`) — retarget assertions to the wheel where the behavior moved, delete where the behavior died with the marquee.

Run the full suite + `npx tsc --noEmit` + `npm run lint`.

Commit: `chore: retire the horizontal ticker and the wheel prototype`.

---

### Task 4: home digest drops concluded competitions

**Files:**
- Modify: `src/server/data/competitions.ts` — `Season` gains:

```ts
  /** The season is over: its final is played, its table is history. A
   *  concluded current season keeps every page browsable but contributes
   *  nothing to the home digest. */
  concluded?: boolean;
```

  Set `concluded: true` on `world-cup` season `2026` ONLY (Leagues Cup's final
  is still ahead as of 2026-08-23). Then add next to `listCompetitions()`:

```ts
/** Competitions whose current season is still being played — the home
 *  digest's universe. Everything else stays browsable, just not promoted. */
export function ongoingCompetitions(): Competition[] {
  return listCompetitions().filter((c) => !c.seasons[c.currentSeasonId]?.concluded);
}
```

- Modify: `src/app/[locale]/page.tsx` — the fan-out uses `ongoingCompetitions()` instead of `listCompetitions()` (both the matches/scorers fan-out AND the news fan-out — read the file; they may share the list).
- Test: extend `src/server/data/competitions.test.ts` — `ongoingCompetitions()` excludes world-cup and includes liga-mx/premier-league; add a home page test only if `page.test.tsx` for the home already exists (check `src/app/[locale]/page.test.tsx`) asserting no World Cup board renders.
- Run `npm run export:competitions`; commit the JSON only if the exporter changes it.

Run full gates. Commit: `feat: the home digest drops concluded competitions`.

---

### Task 5: final review, browser verification, PR

Controller-run (not a subagent): full gates (`npm test`, `tsc`, `lint`, then STOP the dev server → `npm run build` → restart dev server — the shared `.next` corrupts otherwise); wheel verified at 390/768/1280 on `/es` + `/en` (snap, popup, reduced-motion via CDP emulation, goal flash if a live match cooperates); home page shows no World Cup board; Opus+Sonnet review loop on the diff until clean; push `feat/fixture-wheel`; PR (do not merge).
