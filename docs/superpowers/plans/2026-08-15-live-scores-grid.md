# Live Scores Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a live matchday page — a grid where every simultaneous kickoff is visible at once — by salvaging the polling and card rendering from `LiveScores.tsx`, a finished component that has never been imported anywhere.

**Architecture:** Extract one match card into `LiveMatchCard`, keep the 15s poll / `connOk` / `sortMatches` logic, and delete every line of carousel machinery. A new `/c/[comp]/[season]/live` route server-renders the first paint from `dataStore.getMatches(rc)` and hands off to the client component, reusing the existing `/matches` API route and `MatchDetailPopup` untouched.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest, CSS in `src/app/globals.css` (`ls-*` / `lg-*` namespaces).

**Spec:** `docs/superpowers/specs/2026-08-15-live-scores-grid-design.md`
**Epic:** E2 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `feat/live-scores` off latest `origin/main`

## Global Constraints

- TypeScript strict; no `any` in new code.
- Reuse existing CSS tokens (`--gold`, `--surface-1`, `--surface-2`, `--hairline`, `--text`, `--text-muted`). No new colours.
- Reuse `MatchStats` exports (`ScorersRow`, `CardsRow`, `WinProbBar`, `PenaltyShootout`, `liveStatus`, `isBeforeKickoff`) and `MatchDetailPopup`. Do not build a second detail view.
- `prefers-reduced-motion: reduce` disables the live pulse.
- `npx tsc --noEmit` clean and `npm test` green before a PR.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run build` while `npm run dev` is running.

## Coordination with E0

E0 Task 6 removes the dead sidebar "Live Scores" link. This plan's Task 4 adds it
back against the real route. **If E0 has not landed yet, that is fine** — Task 4
writes the item from scratch either way. If E0 has landed, Task 4 re-adds it. If
E2 lands first, tell whoever runs E0 to skip its Task 6.

---

## File Structure

- `src/components/liveOrder.ts` — pure sort helper, extracted so it can be tested.
- `src/components/liveOrder.test.ts` — its tests.
- `src/components/LiveMatchCard.tsx` — one match card, state-aware.
- `src/components/LiveScores.tsx` — rewritten: poll + grid, no carousel.
- `src/app/c/[comp]/[season]/live/page.tsx` — the route.
- `src/components/Sidebar.tsx` — real nav item.
- `src/app/globals.css` — `lg-*` grid classes (append).

---

### Task 1: Extract and test the ordering rule

**Files:**
- Create: `src/components/liveOrder.ts`
- Test: `src/components/liveOrder.test.ts`

The existing `sortMatches` lives inside `LiveScores.tsx` and is untested. It is
pure, and the spec adds a rule to it (live matches order by descending minute), so
it moves out where a test can reach it.

**Interfaces:**
- `sortMatches(matches: Match[]): Match[]` — returns a new array. Live first, then
  finished, then scheduled. Within live, the match furthest into the game leads.
  Within scheduled, earliest kickoff leads. Stable for everything else.

- [ ] **Step 1: Write the failing test**

Create `src/components/liveOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sortMatches } from './liveOrder';
import type { Match, MatchState } from '@/server/data/types';

function match(id: string, state: MatchState, opts: { minute?: string; kickoff?: string } = {}): Match {
  return {
    id,
    state,
    kickoff: opts.kickoff ?? '2026-08-15T20:00:00Z',
    minute: opts.minute ?? '',
    home: { id: `${id}h`, name: `${id} Home`, abbr: 'HOM', crestUrl: null },
    away: { id: `${id}a`, name: `${id} Away`, abbr: 'AWY', crestUrl: null },
    homeScore: null,
    awayScore: null,
    note: null,
    shootout: null,
  } as unknown as Match;
}

describe('sortMatches', () => {
  it('orders live, then finished, then scheduled', () => {
    const out = sortMatches([
      match('s', 'scheduled'),
      match('f', 'finished'),
      match('l', 'live', { minute: "12'" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['l', 'f', 's']);
  });

  // On a matchday the game closest to full time is the one about to produce
  // news, so it leads.
  it('puts the later minute first among live matches', () => {
    const out = sortMatches([
      match('early', 'live', { minute: "12'" }),
      match('late', 'live', { minute: "78'" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['late', 'early']);
  });

  it('handles added time in the minute', () => {
    const out = sortMatches([
      match('ninety', 'live', { minute: "90'" }),
      match('added', 'live', { minute: "90'+3" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['added', 'ninety']);
  });

  it('orders scheduled matches by earliest kickoff', () => {
    const out = sortMatches([
      match('late', 'scheduled', { kickoff: '2026-08-15T22:00:00Z' }),
      match('early', 'scheduled', { kickoff: '2026-08-15T18:00:00Z' }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['early', 'late']);
  });

  it('does not mutate its input', () => {
    const input = [match('s', 'scheduled'), match('l', 'live')];
    const copy = [...input];
    sortMatches(input);
    expect(input).toEqual(copy);
  });

  it('returns an empty array unchanged', () => {
    expect(sortMatches([])).toEqual([]);
  });
});
```

Before running this, open `src/server/data/types.ts` and check the real field
names on `Match` — the `as unknown as Match` cast above exists so the helper
builds a valid object without listing every field, but `minute`, `kickoff` and
`state` must match the real interface exactly or the test asserts nothing useful.
Fix the helper to match; do not weaken the cast further.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/liveOrder.test.ts`
Expected: FAIL — cannot resolve `./liveOrder`.

- [ ] **Step 3: Implement**

Create `src/components/liveOrder.ts`:

```ts
import type { Match } from '@/server/data/types';

const STATE_ORDER: Record<string, number> = { live: 0, finished: 1, scheduled: 2 };

// "90'+3" -> 93, "12'" -> 12, "" -> 0. Added time has to count, or a match in
// the 93rd minute sorts below one in the 90th.
function minuteValue(minute: string): number {
  const m = /(\d+)(?:'?\s*\+\s*(\d+))?/.exec(minute ?? '');
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
}

/**
 * Matchday order: live first, then finished, then scheduled.
 *
 * Within live, the match furthest into the game leads — it is the one about to
 * produce a result. Within scheduled, the earliest kickoff leads. Returns a new
 * array; callers hold this in React state and must not have it mutated
 * underneath them.
 */
export function sortMatches(matches: Match[]): Match[] {
  return [...matches].sort((a, b) => {
    const byState = (STATE_ORDER[a.state] ?? 2) - (STATE_ORDER[b.state] ?? 2);
    if (byState !== 0) return byState;
    if (a.state === 'live') return minuteValue(b.minute) - minuteValue(a.minute);
    if (a.state === 'scheduled') return a.kickoff.localeCompare(b.kickoff);
    return 0;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/liveOrder.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/liveOrder.ts src/components/liveOrder.test.ts
git commit -m "refactor: extract and test matchday ordering

sortMatches was untested inside LiveScores. Adds minute ordering within
live matches so the game closest to full time leads.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `LiveMatchCard` — one match, state-aware

**Files:**
- Create: `src/components/LiveMatchCard.tsx`
- Modify: `src/app/globals.css` (append)

Presentational — verified by running the app, per repo convention.

- [ ] **Step 1: Build the card**

Create `src/components/LiveMatchCard.tsx`. Move `FullFlag` and `formatKickoff`
across from `LiveScores.tsx` verbatim — they work and the crest/flag fallback in
`FullFlag` respects `teamStyle` correctly, which is easy to get wrong on a rewrite.

```tsx
'use client';

import type { Match } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { ScorersRow, CardsRow, WinProbBar, PenaltyShootout, liveStatus, isBeforeKickoff } from './MatchStats';

export default function LiveMatchCard({
  match, teamStyle, onOpen,
}: {
  match: Match;
  teamStyle: TeamStyle;
  onOpen: (m: Match) => void;
}) {
  // A scheduled card and a live card must not look alike. Before kickoff there
  // is no score to show and the useful thing is the odds; during the match the
  // useful thing is the minute and who scored.
  const pre = isBeforeKickoff(match);
  return (
    <button type="button" className={`lg-card lg-card--${match.state}`} onClick={() => onOpen(match)}>
      <div className="lg-card-head">
        <span className={`lg-status lg-status--${match.state}`}>{liveStatus(match)}</span>
      </div>
      {/* teams, crests and score go here, reusing FullFlag moved from LiveScores */}
      {pre ? (
        <WinProbBar match={match} />
      ) : (
        <>
          <ScorersRow match={match} />
          <CardsRow match={match} />
          <PenaltyShootout match={match} />
        </>
      )}
    </button>
  );
}
```

Check the real prop signatures of `ScorersRow`, `CardsRow`, `WinProbBar`,
`PenaltyShootout`, `liveStatus` and `isBeforeKickoff` in
`src/components/MatchStats.tsx` and call them exactly as `LiveScores.tsx` does
today — copy those call sites rather than guessing at them.

- [ ] **Step 2: Add the grid and card CSS**

Append to `src/app/globals.css`:

```css
/* ---- Live matchday grid ---- */
/* auto-fill rather than a breakpoint list: the column count should follow the
   viewport, because the number of simultaneous kickoffs is what varies. Liga MX
   routinely plays seven at once and a 3pm Premier League Saturday is ten. */
.lg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.lg-card {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: var(--surface-1); border: 1px solid var(--hairline);
  border-radius: 10px; padding: 12px; color: var(--text);
}
.lg-card:hover { border-color: var(--gold); }
.lg-card--live { border-color: color-mix(in srgb, var(--gold) 55%, var(--hairline)); }
.lg-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.lg-status { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
.lg-status--live { color: var(--gold); }
.lg-status--live::before {
  content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--gold); margin-right: 6px; animation: lg-pulse 1.6s ease-in-out infinite;
}
@keyframes lg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) {
  .lg-status--live::before { animation: none; }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/LiveMatchCard.tsx src/app/globals.css
git commit -m "feat: add the live match card

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rewrite `LiveScores` as a grid

**Files:**
- Modify: `src/components/LiveScores.tsx`

**What survives** the rewrite, and must not be reinvented:

- the 15s poll of `${apiBase}/matches` with its `mounted` guard;
- `connOk` — a failed tick sets the flag and the **next tick retries**, and the
  grid is never blanked on a transient failure;
- the empty state copy, "No matches in the live window right now."

**What is deleted:** `dragX`, `slideTo`, `animating`, `startX`, `startY`, `axis`,
`dragRef`, `index`, `interacted`, `firstLiveIndex`, `ROTATE_MS`,
`SWIPE_THRESHOLD`, and the prev/current/next track.

- [ ] **Step 1: Rewrite the component**

Replace `src/components/LiveScores.tsx` with a component that:

1. holds `matches` state seeded from `sortMatches(initialMatches)`, importing
   `sortMatches` from `./liveOrder` (the local copy is deleted);
2. keeps the existing 15s polling effect and `connOk` behaviour verbatim;
3. holds `selected: Match | null` plus the summary/loading state that
   `MatchDetailPopup` needs — mirror how `UpcomingTicker` does it rather than
   inventing a second pattern;
4. renders `<div className="lg-grid">` mapping every match to `<LiveMatchCard>`;
5. renders `<MatchDetailPopup>` when `selected` is set;
6. renders the empty-state paragraph when `matches.length === 0`.

Delete `FullFlag`, `formatKickoff` and `sortMatches` from this file — they now
live in `LiveMatchCard.tsx` and `liveOrder.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output. An error about an unused import is a leftover carousel
symbol — delete it rather than silencing it.

- [ ] **Step 3: Commit**

```bash
git add src/components/LiveScores.tsx
git commit -m "refactor: replace the live-scores carousel with a grid

A carousel shows one match every 30s. Liga MX kicks off seven at once and
a 3pm Premier League Saturday is ten -- glancing across every score at
once is the one thing a live viewer does, and it was the one thing the
component prohibited.

Keeps the polling, connOk recovery and card rendering; drops the drag,
slide and auto-advance machinery entirely.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The route and the nav

**Files:**
- Create: `src/app/c/[comp]/[season]/live/page.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Add the page**

Create `src/app/c/[comp]/[season]/live/page.tsx`, modelled on the existing
`standings/page.tsx` — open that file and mirror its `resolveSeason` guard,
`notFound()` handling, metadata export and shell markup rather than inventing a
new page shape:

```tsx
import { notFound } from 'next/navigation';
import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import type { Match } from '@/server/data/types';
import LiveScores from '@/components/LiveScores';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LivePage({ params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();

  // Server-render the first paint so the grid is populated before hydration;
  // the client component takes over polling from there. A failed fetch renders
  // the empty state rather than an error page -- no fixtures today is a normal
  // state and must not look like a broken site.
  let matches: Match[] = [];
  try {
    matches = await dataStore.getMatches(rc);
  } catch {}

  const apiBase = `/api/${params.comp}/${params.season}`;
  return (
    <section className="page-section">
      <h1 className="page-title">Live Scores</h1>
      <LiveScores
        initialMatches={matches}
        apiBase={apiBase}
        teamStyle={rc.competition.teamStyle}
      />
    </section>
  );
}
```

Check `rc.competition.teamStyle` is the real accessor by comparing with how
`standings/page.tsx` passes `teamStyle` today, and match the section/heading
classes that page uses.

- [ ] **Step 2: Reinstate the sidebar item, pointing somewhere real**

In `src/components/Sidebar.tsx`, replace the `liveItem` declaration (or add it
back if E0 removed it):

```tsx
  const liveItem = {
    href: `${base}/live`,
    label: 'Live Scores',
    match: (path: string) => path.endsWith('/live'),
    icon: liveIcon,
  };
```

Match the `match` predicate's signature to the other items in the same file — open
them and copy the shape rather than guessing. Keep `liveIcon` (restore it if E0
removed it) and keep `liveItem` in both nav arrays.

- [ ] **Step 3: Verify in the browser**

```bash
npm run dev
```

Open `http://localhost:3000/c/liga-mx/2026-27/live`.

Expected:
- Every match of the current week rendered as a grid, all visible at once with no
  swiping and no waiting for a rotation.
- Live matches above finished, finished above scheduled.
- A live card shows a pulsing dot and a minute; a scheduled card shows kickoff
  time and the win-probability bar, and no score.
- Clicking any card opens the same `MatchDetailPopup` used by the ticker.
- The sidebar "Live Scores" item navigates here **and highlights as active**.

Then, with DevTools open, switch to offline for ~20 seconds.

Expected: the grid stays populated — it must not blank — and repopulates when the
network returns. This is the `connOk` behaviour that survived from the original.

Finally, in DevTools → Rendering, enable "Emulate prefers-reduced-motion".
Expected: the live dot stops pulsing and stays visible.

- [ ] **Step 4: Commit**

```bash
git add "src/app/c/[comp]/[season]/live/page.tsx" src/components/Sidebar.tsx
git commit -m "feat: add the live scores route and wire the sidebar link

The nav item pointed at a #live fragment no page rendered, with
match: () => false so it could never highlight. It now points at a real
route with a real active predicate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full gate and PR

- [ ] **Step 1: Gate**

Kill the dev server first — `next dev` and `next build` both write `.next/`.

```bash
rm -rf .next
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: green, silent, clean, succeeds.

- [ ] **Step 2: Check the other competitions**

Visit `/live` on a competition that is mid-week with nothing scheduled.

Expected: the empty state, not an error and not an empty grid frame.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/live-scores
gh pr create --title "feat: live scores grid" --body "$(cat <<'EOF'
## What

ScoreArc has had no live matchday page. `LiveScores.tsx` — 378 lines, finished —
has never been imported anywhere, and the sidebar's "Live Scores" item pointed at
a `#live` fragment no page renders, with `match: () => false` so it could never
show as active.

This ships the page and wires the link.

## Approach

Salvage over rewrite. The 15s poll, the `connOk` recovery (a failed tick retries
instead of blanking the grid), the crest/flag fallback and the `MatchStats` row
components all survive unchanged.

The carousel does not. It showed one match and auto-rotated every 30s; Liga MX
routinely kicks off seven simultaneously and a 3pm Premier League Saturday is ten,
so seeing every score would have taken three and a half minutes of watching a
panel rotate. The drag/slide/axis machinery — the most fragile code in the file —
is deleted with it.

`sortMatches` moves to `liveOrder.ts` where it can be tested, and gains minute
ordering within live matches so the game closest to full time leads.

## Testing

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- Six unit cases on the ordering rule, including added time (`90'+3` sorts above
  `90'`) and non-mutation.
- Verified in the browser: grid renders all concurrent matches, cards open the
  existing popup, going offline for 20s does not blank the grid, and
  `prefers-reduced-motion` stops the pulse.

Plan: `docs/superpowers/plans/2026-08-15-live-scores-grid.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** "Keep" list → Task 3 Step 1. "Throw away" list → Task 3 Step 1.
  Card contents by state → Task 2. Empty state → Task 3 and Task 5 Step 2. Ordering
  → Task 1. Click-through → Task 3. Reduced motion → Task 2 Step 2, verified Task 4
  Step 3. Route and nav → Task 4.
- **Type consistency.** `sortMatches` is defined in Task 1 Step 3 and imported
  under that name in Task 3. `LiveMatchCard`'s props (`match`, `teamStyle`,
  `onOpen`) are defined in Task 2 Step 1 and supplied in Task 3 Step 1.
- **Deliberate omission.** The spec's cross-competition live view and push updates
  are listed out of scope and have no task, by design.
- **Coordination.** The E0 overlap on the sidebar item is called out at the top and
  again in Task 4 Step 2, and works in either landing order.
