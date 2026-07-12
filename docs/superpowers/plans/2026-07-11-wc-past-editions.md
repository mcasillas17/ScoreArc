# World Cup Past Editions (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse past World Cup editions (1998–2022) — knockout bracket + scores — served live from ESPN, with the existing animation replaying each finished tournament to its champion.

**Architecture:** Make the bracket **shape** (ring geometry + knockout rounds + seed order) come from the season config instead of module constants. The already depth-agnostic `RadialBracket` then renders a 4-ring (R16) or 5-ring (R32) bracket. Finished editions derive their bracket order from results; the live 2026 edition keeps its hardcoded order.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript strict, Vitest, ESPN keyless API.

## Global Constraints

- No new dependencies; no new data-fetch call sites (ESPN `fifa.world` scoreboard already serves every edition by date range — verified 1998–2022; the bracket mapper already buckets `round-of-16`…`final` and marks `/countries/` logos non-placeholder, so **the data layer is unchanged**).
- **2026 must render byte-for-byte as it does today** (same 5-ring geometry + 16-pair `OFFICIAL_R32_ORDER`).
- Past editions are **view-only**: no predict ("Build your bracket") tab, no live poll. Read-only is derived: `season.id !== competition.currentSeasonId`.
- Past editions show **bracket + scores** only (`sections: ['bracket','scores']`). No group standings / news.
- Editions: **1998, 2002, 2006, 2010, 2014, 2018, 2022** (all 32-team / Round-of-16 / 4 rings).
- TypeScript strict; `npx tsc --noEmit` clean before every commit. This repo's tsconfig has no `target`/`downlevelIteration` — use array methods / `.forEach`, never `for...of`/spread over Maps/Sets.
- Reduced-motion + existing bracket behaviors (connectors, `InnerHop`, popup, third-place mini) must keep working at any ring count.

## File Structure

- `src/server/data/competitions.ts` — add `knockoutRounds` to `Season`; add the 7 past seasons.
- `src/components/bracketShape.ts` **(new, pure)** — `BracketShape` type, tuned `RING_GEOMETRY_BY_COUNT` (4 & 5), `bracketShapeFor(season)`.
- `src/components/radialBracketModel.ts` — receives the moved pure bracket-model code (`buildRings` + helpers) and the new `deriveLeafOrder`.
- `src/components/RadialBracket.tsx` — consumes `shape` (prop), renders N rings; keeps only rendering/animation.
- `src/components/BracketInteractive.tsx` — threads `shape` + `readOnly`; hides predict tab + skips poll when read-only.
- `src/components/SeasonSwitcher.tsx` **(new)** — edition picker.
- `src/app/c/[comp]/[season]/page.tsx` — computes `shape`, passes `shape`/`readOnly`, renders the switcher.
- `src/server/data/__fixtures__/espn-bracket-2022.json` **(new)** — recorded 2022 knockout scoreboard for tests.

---

### Task 1: Season config — `knockoutRounds` + past editions

**Files:**
- Modify: `src/server/data/competitions.ts` (Season interface ~line 18–25; `world-cup` seasons ~line 57–65; `resolveSeason` exists at ~138)
- Test: `src/server/data/competitions.test.ts` (create if absent)

**Interfaces:**
- Produces: `Season.knockoutRounds: string[]`; `world-cup.seasons` gains `'2022'|'2018'|'2014'|'2010'|'2006'|'2002'|'1998'`. `Season.bracketOrder?` already exists.

- [ ] **Step 1: Write the failing test**

Create `src/server/data/competitions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSeason, COMPETITIONS } from './competitions';

describe('world-cup seasons', () => {
  it('resolves 2022 as a 4-round knockout without a hardcoded bracketOrder', () => {
    const rc = resolveSeason('world-cup', '2022');
    expect(rc).toBeTruthy();
    expect(rc!.season.knockoutRounds).toEqual([
      'round-of-16', 'quarterfinals', 'semifinals', 'final',
    ]);
    expect(rc!.season.bracketOrder).toBeUndefined();
    expect(rc!.season.bracketDatesRange).toBeTruthy();
    expect(rc!.season.sections).toEqual(['bracket', 'scores']);
  });

  it('keeps 2026 as a 5-round knockout with its hardcoded order', () => {
    const rc = resolveSeason('world-cup', '2026')!;
    expect(rc.season.knockoutRounds).toEqual([
      'round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final',
    ]);
    expect(rc.season.bracketOrder?.length).toBe(16);
  });

  it('exposes all seven past editions', () => {
    const ids = Object.keys(COMPETITIONS['world-cup'].seasons).sort();
    expect(ids).toEqual(['1998','2002','2006','2010','2014','2018','2022','2026']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/competitions.test.ts`
Expected: FAIL — `knockoutRounds` undefined; past seasons missing.

- [ ] **Step 3: Add `knockoutRounds` to the `Season` interface**

In `src/server/data/competitions.ts`, inside `interface Season` (after `bracketOrder?`):

```ts
  // Knockout round slugs, outer->inner (leaf first, final last). Drives the
  // bracket's ring count + geometry. 2026 starts at round-of-32; 1998-2022 at
  // round-of-16.
  knockoutRounds?: string[];
```

- [ ] **Step 4: Give 2026 its `knockoutRounds`**

In the `world-cup` → `seasons['2026']` object, add alongside `bracketOrder: OFFICIAL_R32_ORDER`:

```ts
        knockoutRounds: ['round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final'],
```

- [ ] **Step 5: Add the seven past seasons**

In `world-cup.seasons`, after `'2026': { ... }`, add (dates are each edition's knockout window; verified against ESPN's `fifa.world` scoreboard):

```ts
      '2022': pastWcSeason('2022', '20221203-20221218'),
      '2018': pastWcSeason('2018', '20180630-20180715'),
      '2014': pastWcSeason('2014', '20140628-20140713'),
      '2010': pastWcSeason('2010', '20100626-20100711'),
      '2006': pastWcSeason('2006', '20060624-20060709'),
      '2002': pastWcSeason('2002', '20020615-20020630'),
      '1998': pastWcSeason('1998', '19980627-19980712'),
```

And add this helper near `leagueCompetition` (a past 32-team WC edition — R16 knockout, view-only, no seed order → derived):

```ts
function pastWcSeason(id: string, bracketDatesRange: string): Season {
  return {
    id,
    label: id,
    sections: ['bracket', 'scores'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
    bracketDatesRange,
    knockoutRounds: ['round-of-16', 'quarterfinals', 'semifinals', 'final'],
    // bracketOrder intentionally omitted -> derived from finished results
  };
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `npx vitest run src/server/data/competitions.test.ts && npx tsc --noEmit`
Expected: 3 tests PASS; 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/data/competitions.ts src/server/data/competitions.test.ts
git commit -m "feat: add World Cup past-edition season configs (1998-2022)"
```

---

### Task 2: `bracketShape` module

**Files:**
- Create: `src/components/bracketShape.ts`
- Test: `src/components/bracketShape.test.ts`

**Interfaces:**
- Consumes: `Season` (Task 1) — reads `knockoutRounds`, `bracketOrder`.
- Produces: `interface RingGeom { slug: string; rx: number; ry: number; discR: number }`; `interface BracketShape { ringGeometry: RingGeom[]; knockoutRounds: string[]; bracketOrder?: [string,string][] }`; `bracketShapeFor(season: Season): BracketShape`.

- [ ] **Step 1: Write the failing test**

Create `src/components/bracketShape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bracketShapeFor } from './bracketShape';
import type { Season } from '@/server/data/competitions';

const season = (over: Partial<Season>): Season => ({
  id: 'x', label: 'x', sections: ['bracket'],
  format: { hasBracket: true, hasGroups: false, hasThirdPlaceRace: false },
  ...over,
});

describe('bracketShapeFor', () => {
  it('5 rings + 16-pair order for a round-of-32 season', () => {
    const s = bracketShapeFor(season({
      knockoutRounds: ['round-of-32','round-of-16','quarterfinals','semifinals','final'],
      bracketOrder: Array(16).fill(['A','B']) as [string,string][],
    }));
    expect(s.ringGeometry).toHaveLength(5);
    expect(s.ringGeometry[0].slug).toBe('round-of-32');
    expect(s.ringGeometry[0].rx).toBe(400);
    expect(s.bracketOrder).toHaveLength(16);
  });

  it('4 rings + no seed order for a round-of-16 season', () => {
    const s = bracketShapeFor(season({
      knockoutRounds: ['round-of-16','quarterfinals','semifinals','final'],
    }));
    expect(s.ringGeometry).toHaveLength(4);
    expect(s.ringGeometry.map((g) => g.slug)).toEqual([
      'round-of-16','quarterfinals','semifinals','final',
    ]);
    expect(s.ringGeometry[0].rx).toBe(400); // outer ring is always the flag ring
    expect(s.bracketOrder).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/bracketShape.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/components/bracketShape.ts`:

```ts
import type { Season } from '@/server/data/competitions';

export interface RingGeom {
  slug: string;
  rx: number;
  ry: number;
  discR: number;
}

export interface BracketShape {
  ringGeometry: RingGeom[]; // depth 0 (outer flag ring) .. N-1 (final)
  knockoutRounds: string[]; // slugs, outer->inner; parallel to ringGeometry
  bracketOrder?: [string, string][]; // present -> use as seeds; absent -> derive
}

// Tuned radii/disc sizes per ring COUNT (hand-tuned reads better than computed
// spacing; only 4 and 5 occur). rx===ry (true circles). Outer is always 400.
const RADII: Record<number, { rx: number; discR: number }[]> = {
  5: [
    { rx: 400, discR: 30 }, { rx: 312, discR: 26 }, { rx: 224, discR: 27 },
    { rx: 138, discR: 29 }, { rx: 66, discR: 33 },
  ],
  4: [
    { rx: 400, discR: 32 }, { rx: 288, discR: 30 }, { rx: 176, discR: 31 },
    { rx: 74, discR: 34 },
  ],
};

export function bracketShapeFor(season: Season): BracketShape {
  const knockoutRounds = season.knockoutRounds ?? [
    'round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final',
  ];
  const preset = RADII[knockoutRounds.length] ?? RADII[5];
  const ringGeometry: RingGeom[] = knockoutRounds.map((slug, i) => ({
    slug,
    rx: preset[i].rx,
    ry: preset[i].rx,
    discR: preset[i].discR,
  }));
  return { ringGeometry, knockoutRounds, bracketOrder: season.bracketOrder };
}

// The 2026 5-ring shape — used as the default when no `shape` prop is passed,
// so callers not yet updated keep compiling and rendering 2026 unchanged.
import { OFFICIAL_R32_ORDER } from '@/server/data/competitions';
export const DEFAULT_SHAPE: BracketShape = bracketShapeFor({
  id: '', label: '', sections: [],
  format: { hasBracket: true, hasGroups: false, hasThirdPlaceRace: false },
  knockoutRounds: ['round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final'],
  bracketOrder: OFFICIAL_R32_ORDER,
});
```

(Put the `import` at the top of the file with the other imports — shown here for locality.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/components/bracketShape.test.ts && npx tsc --noEmit`
Expected: 2 tests PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/bracketShape.ts src/components/bracketShape.test.ts
git commit -m "feat: bracketShapeFor - ring geometry per knockout-round count"
```

---

### Task 3: Move the pure bracket-model code into `radialBracketModel.ts`

Pure relocation, no behavior change — makes `buildRings` unit-testable and separates model from rendering.

**Files:**
- Modify: `src/components/RadialBracket.tsx` (remove the moved functions; import them)
- Modify: `src/components/radialBracketModel.ts` (receive them)

**Interfaces:**
- Produces (now exported from `radialBracketModel.ts`): `buildRings(rounds, picks?, mode?)` (signature unchanged **this task**), plus `RINGS`, `C`, `CREST_SCALE`, `ellipse`, `colorFor` stays in RadialBracket (rendering).

- [ ] **Step 1: Move the functions**

Cut these from `src/components/RadialBracket.tsx` and paste them into `src/components/radialBracketModel.ts` (append), **verbatim**, adding `export` to `buildRings`:
- `const C = { x: 500, y: 500 }` (line ~23)
- `const RINGS = [...]` (lines ~27–33)
- `const CREST_SCALE` (line ~37)
- `function toRad` (line ~115) — if not already present in the model
- `function ellipse` (line ~129)
- `function makePlaceholder` (line ~134)
- `function winnerTeam` (line ~139)
- `function effectiveWinner` (lines ~152–172)
- `function isDecidable` (lines ~174–183)
- `function findMatch` (lines ~198–207)
- `interface Slot` (lines ~209–217)
- `function officialLeafOrder` (lines ~223–249) — it references `OFFICIAL_R32_ORDER`; import that into the model from `@/server/data/competitions`
- `function buildRings` (lines ~251–~350) — add `export`

Add to the model's imports: `import { OFFICIAL_R32_ORDER, type BracketMode } from ...` — **no**, `BracketMode` lives in RadialBracket; instead widen the model to import the `BracketRound`/`BracketMatch`/`BracketTeam` types it needs (already imported there) and `OFFICIAL_R32_ORDER` from competitions. Define `type BracketMode = 'live' | 'predict'` locally in the model (buildRings uses it) OR export `BracketMode` from the model and have RadialBracket import it.

**Decision:** move the `BracketMode` type to `radialBracketModel.ts` and re-export it from `RadialBracket.tsx` (`export type { BracketMode } from './radialBracketModel'`) so existing importers (`BracketInteractive`) are unaffected.

- [ ] **Step 2: Fix imports in `RadialBracket.tsx`**

Replace the removed local defs with:

```ts
import {
  teamJourney, buildRings, ellipse, colorFor, C, RINGS, CREST_SCALE,
  type RingNode, type JourneyStop, type BracketMode,
} from './radialBracketModel';
```

Keep `colorFor`/`ellipse`/`C`/`RINGS`/`CREST_SCALE` exported from the model since the render code (connectors, discs) uses them. (Move `colorFor` + `TEAM_COLOR` too if `buildRings`/connectors need it — `colorFor` is used by connectors in RadialBracket, so **export it from the model** and import it back.)

- [ ] **Step 3: Typecheck + full suite (behavior unchanged)**

Run: `npx tsc --noEmit && npm test`
Expected: 0 type errors; all existing tests pass (this is a pure move — the app renders identically).

- [ ] **Step 4: Commit**

```bash
git add src/components/RadialBracket.tsx src/components/radialBracketModel.ts
git commit -m "refactor: move pure bracket-model logic into radialBracketModel"
```

---

### Task 4: `deriveLeafOrder` — reconstruct bracket order from finished results

**Files:**
- Modify: `src/components/radialBracketModel.ts`
- Test: `src/components/radialBracketModel.test.ts` (extend)

**Interfaces:**
- Consumes: `BracketRound[]`, `knockoutRounds: string[]`.
- Produces: `deriveLeafOrder(rounds: BracketRound[], knockoutRounds: string[]): number[]` — leaf-round match indices in bracket order (falls back to `[0,1,2,…]` if the bracket isn't fully decided).

- [ ] **Step 1: Write the failing test**

Add to `src/components/radialBracketModel.test.ts`:

```ts
import { deriveLeafOrder } from './radialBracketModel';
import type { BracketRound, BracketMatch } from '@/server/data/types';

function m(id: string, home: string, away: string, winner: string): BracketMatch {
  const team = (a: string) => ({ id: a, name: a, abbr: a, crestUrl: null, placeholder: false });
  return {
    id, round: '', kickoff: '', home: team(home), away: team(away),
    homeScore: null, awayScore: null, state: 'finished', statusDetail: 'FT',
    statusName: '', minute: null, winnerId: winner, note: null,
  };
}

describe('deriveLeafOrder', () => {
  // A finished 4-team-ish tree: leaf=SF-of-4 style. Use a minimal 2-round tree:
  // R16 (2 matches) -> Final (1). Final = winners of the two R16 matches.
  it('orders leaf matches so adjacent pairs feed the parent, from results', () => {
    // leaf indices returned in ESPN order [A-B(A), C-D(C)]; final = A vs C.
    const rounds: BracketRound[] = [
      { slug: 'round-of-16', name: '', matches: [m('l0','A','B','A'), m('l1','C','D','C')] },
      { slug: 'final', name: '', matches: [m('f','A','C','A')] },
    ];
    // final home=A -> its leaf is l0 (index 0); final away=C -> leaf l1 (index 1)
    expect(deriveLeafOrder(rounds, ['round-of-16','final'])).toEqual([0, 1]);
  });

  it('reverses when the final home team came from the second leaf match', () => {
    const rounds: BracketRound[] = [
      { slug: 'round-of-16', name: '', matches: [m('l0','A','B','A'), m('l1','C','D','C')] },
      { slug: 'final', name: '', matches: [m('f','C','A','C')] }, // home=C first
    ];
    expect(deriveLeafOrder(rounds, ['round-of-16','final'])).toEqual([1, 0]);
  });

  it('falls back to event order when a winner is missing', () => {
    const bad = m('f','A','C',''); bad.winnerId = null;
    const rounds: BracketRound[] = [
      { slug: 'round-of-16', name: '', matches: [m('l0','A','B','A'), m('l1','C','D','C')] },
      { slug: 'final', name: '', matches: [bad] },
    ];
    expect(deriveLeafOrder(rounds, ['round-of-16','final'])).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/radialBracketModel.test.ts -t deriveLeafOrder`
Expected: FAIL — `deriveLeafOrder` not exported.

- [ ] **Step 3: Implement `deriveLeafOrder`**

Append to `src/components/radialBracketModel.ts`:

```ts
/**
 * Reconstruct the leaf-round match order for a FINISHED bracket by unfolding the
 * tree from the final outward: a match at depth d has home/away teams that each
 * WON a match one round below; recurse and emit leaf indices left-to-right.
 * `knockoutRounds` is outer->inner (leaf first, final last). Falls back to plain
 * event order (0,1,2,...) if the bracket isn't fully/consistently decided.
 */
export function deriveLeafOrder(rounds: BracketRound[], knockoutRounds: string[]): number[] {
  const N = knockoutRounds.length;
  const leaf = rounds.find((r) => r.slug === knockoutRounds[0]);
  const fallback = leaf ? leaf.matches.map((_, i) => i) : [];
  const finalRound = rounds.find((r) => r.slug === knockoutRounds[N - 1]);
  if (!leaf || N < 1 || !finalRound || finalRound.matches.length !== 1) return fallback;

  const key = (m: BracketMatch) => [m.home.id, m.away.id].sort().join('|');
  const leafIndex = new Map<string, number>();
  leaf.matches.forEach((m, i) => leafIndex.set(key(m), i));

  const winnerOf = (m: BracketMatch): string | null =>
    m.winnerId === m.home.id ? m.home.id : m.winnerId === m.away.id ? m.away.id : null;

  const childWinnerMatch = (depth: number, teamId: string): BracketMatch | null => {
    const r = rounds.find((x) => x.slug === knockoutRounds[depth]);
    return r ? r.matches.find((mm) => winnerOf(mm) === teamId) ?? null : null;
  };

  const order: number[] = [];
  let ok = true;
  const unfold = (match: BracketMatch, depth: number): void => {
    if (!ok) return;
    if (depth === 0) {
      const idx = leafIndex.get(key(match));
      if (idx === undefined) { ok = false; return; }
      order.push(idx);
      return;
    }
    [match.home, match.away].forEach((team) => {
      const child = childWinnerMatch(depth - 1, team.id);
      if (!child) { ok = false; return; }
      unfold(child, depth - 1);
    });
  };
  unfold(finalRound.matches[0], N - 1);

  if (!ok || order.length !== leaf.matches.length || new Set(order).size !== leaf.matches.length) {
    return fallback;
  }
  return order;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/components/radialBracketModel.test.ts && npx tsc --noEmit`
Expected: all model tests PASS (existing + 3 new); 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/radialBracketModel.ts src/components/radialBracketModel.test.ts
git commit -m "feat: deriveLeafOrder - bracket order from finished results"
```

---

### Task 5: Generalize `buildRings` + `RadialBracket` to a `shape`

**Files:**
- Modify: `src/components/radialBracketModel.ts` (`buildRings`, `officialLeafOrder`)
- Modify: `src/components/RadialBracket.tsx` (accept `shape` prop; use it for champion/finalists/connectors/simRound)
- Test: `src/components/radialBracketModel.test.ts` (extend); `src/server/data/__fixtures__/espn-bracket-2022.json` (record)

**Interfaces:**
- Consumes: `BracketShape` (Task 2), `deriveLeafOrder` (Task 4).
- Produces: `buildRings(rounds, shape, picks?, mode?): RingNode[][]` (adds required `shape` param, 2nd position); `leafOrderFromSeeds(leafRound, seeds): number[]` (generalized `officialLeafOrder`).

- [ ] **Step 1: Record the 2022 fixture**

Run (writes the real recorded scoreboard used by the test):

```bash
curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20221203-20221218" \
  -o src/server/data/__fixtures__/espn-bracket-2022.json
```

- [ ] **Step 2: Write the failing test**

Add to `src/components/radialBracketModel.test.ts`:

```ts
import { buildRings } from './radialBracketModel';
import { bracketShapeFor } from './bracketShape';
import { mapBracket } from '@/server/data/providers/espn-bracket';
import raw2022 from '@/server/data/__fixtures__/espn-bracket-2022.json';

describe('buildRings — 2022 (4 rings, derived order)', () => {
  const rounds = mapBracket(raw2022);
  const shape = bracketShapeFor({
    id: '2022', label: '2022', sections: ['bracket'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
    knockoutRounds: ['round-of-16','quarterfinals','semifinals','final'],
  });

  it('builds 4 rings: 16 leaves -> 8 -> 4 -> 2', () => {
    const rings = buildRings(rounds, shape);
    expect(rings).toHaveLength(4);
    expect(rings[0]).toHaveLength(16);
    expect(rings[3]).toHaveLength(2);
  });

  it('crowns Argentina (2022 champion) in the final ring', () => {
    const rings = buildRings(rounds, shape);
    const champ = rings[3].find((n) => n.isWinner)?.team.abbr;
    expect(champ).toBe('ARG');
  });

  it('places quarterfinal pairings adjacently (Netherlands + Argentina share a QF)', () => {
    const rings = buildRings(rounds, shape);
    // NED and ARG met in a QF; in bracket order their R16 slots are adjacent (2k,2k+1)
    const idxNED = rings[0].findIndex((n) => n.team.abbr === 'NED');
    const idxARG = rings[0].findIndex((n) => n.team.abbr === 'ARG');
    expect(Math.floor(idxNED / 2)).toBe(Math.floor(idxARG / 2));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/components/radialBracketModel.test.ts -t 2022`
Expected: FAIL — `buildRings` takes `(rounds, picks, mode)`, not `(rounds, shape)`.

- [ ] **Step 4: Generalize `officialLeafOrder` → `leafOrderFromSeeds`**

In `radialBracketModel.ts`, replace `officialLeafOrder` with a version taking the seed array and using its length (works for 8 or 16):

```ts
export function leafOrderFromSeeds(
  leaf: BracketRound | undefined,
  seeds: [string, string][],
): number[] {
  const fallback = leaf ? leaf.matches.map((_, i) => i) : [];
  if (!leaf || leaf.matches.length !== seeds.length) return fallback;
  const findPair = (a: string, b: string): number =>
    leaf.matches.findIndex((m) => {
      const x = (m.home.abbr ?? '').toUpperCase();
      const y = (m.away.abbr ?? '').toUpperCase();
      return (x === a && y === b) || (x === b && y === a);
    });
  const order: number[] = [];
  seeds.forEach(([a, b]) => {
    const idx = findPair(a.toUpperCase(), b.toUpperCase());
    if (idx >= 0) order.push(idx);
  });
  if (order.length !== seeds.length || new Set(order).size !== seeds.length) return fallback;
  return order;
}
```

- [ ] **Step 5: Generalize `buildRings`**

Change `buildRings` in `radialBracketModel.ts` to take `shape` (import `BracketShape` from `./bracketShape`):

```ts
export function buildRings(
  rounds: BracketRound[],
  shape: BracketShape,
  picks: Record<string, string> = {},
  mode: BracketMode = 'live',
): RingNode[][] {
  const geom = shape.ringGeometry;
  const leaf = rounds.find((r) => r.slug === shape.knockoutRounds[0]);
  const leafOrder = shape.bracketOrder
    ? leafOrderFromSeeds(leaf, shape.bracketOrder)
    : deriveLeafOrder(rounds, shape.knockoutRounds);

  const ringSlots: Slot[][] = [];
  const d0: Slot[] = [];
  if (leaf) {
    leafOrder.forEach((origIdx, pos) => {
      const mm = leaf.matches[origIdx];
      if (!mm) return;
      const eff = effectiveWinner(mm, 0, pos, picks, mode, mm.home, mm.away);
      const clickable = mode === 'predict' && isDecidable(mm, mm.home, mm.away);
      d0.push({ team: mm.home, match: mm, isHome: true,
        isWinner: eff?.id === mm.home.id, eliminated: eff != null && eff.id !== mm.home.id, clickable });
      d0.push({ team: mm.away, match: mm, isHome: false,
        isWinner: eff?.id === mm.away.id, eliminated: eff != null && eff.id !== mm.away.id, clickable });
    });
  }
  ringSlots.push(d0);

  for (let depth = 1; depth < geom.length; depth++) {
    const round = rounds.find((r) => r.slug === shape.knockoutRounds[depth]);
    const prev = ringSlots[depth - 1];
    const nSlots = Math.floor(prev.length / 2);
    const advancing: (BracketTeam | null)[] = [];
    for (let k = 0; k < nSlots; k++) {
      const a = prev[2 * k]; const b = prev[2 * k + 1];
      advancing.push(a.isWinner ? a.team : b.isWinner ? b.team : null);
    }
    const slots: Slot[] = [];
    for (let k = 0; k < nSlots; k++) {
      const pair = Math.floor(k / 2);
      const tA = advancing[2 * pair] ?? null;
      const tB = advancing[2 * pair + 1] ?? null;
      const matchR = tA && tB ? findMatch(round, tA.id, tB.id) : null;
      const team = advancing[k] ?? makePlaceholder(depth, k);
      const eff = effectiveWinner(matchR, depth, pair, picks, mode, tA, tB);
      slots.push({ team, match: matchR, isHome: k % 2 === 0,
        isWinner: eff != null && eff.id === team.id,
        eliminated: !team.placeholder && eff != null && eff.id !== team.id,
        clickable: mode === 'predict' && isDecidable(matchR, tA, tB) });
    }
    ringSlots.push(slots);
  }

  return ringSlots.map((slots, depth) => {
    const cfg = geom[depth];
    const total = slots.length || 1;
    return slots.map((slot, index) => {
      const angle = -90 + (index + 0.5) * (360 / total);
      const flag = ellipse(cfg.rx, cfg.ry, angle);
      const crest = ellipse(cfg.rx * CREST_SCALE, cfg.ry * CREST_SCALE, angle);
      return {
        depth, index, angle, match: slot.match, team: slot.team, isHome: slot.isHome,
        x: flag.x, y: flag.y, crestX: crest.x, crestY: crest.y, discR: cfg.discR,
        isWinner: slot.isWinner, eliminated: slot.eliminated, clickable: slot.clickable,
      };
    });
  });
}
```

(This is the current `buildRings` with `RINGS`→`geom`, the hardcoded `round-of-32` leaf → `shape.knockoutRounds[0]`, and the leaf-order branch. Remove the old `officialLeafOrder`.)

- [ ] **Step 6: Thread `shape` into `RadialBracket.tsx`**

In `RadialBracket.tsx`:
1. Add `shape?: BracketShape` (optional) to `Props`; import `{ DEFAULT_SHAPE, type BracketShape } from './bracketShape'`. At the top of the component: `const shape = shapeProp ?? DEFAULT_SHAPE;` (destructure the prop as `shape: shapeProp`). Optional-with-default keeps `BracketInteractive`'s current call compiling and 2026 rendering unchanged until Task 6 passes an explicit shape.
2. Replace `const rings = buildRings(rounds, picks, mode);` → `const rings = buildRings(rounds, shape, picks, mode);`.
3. Replace every render use of module `RINGS` with `shape.ringGeometry`:
   - champion: `const champion = rings[shape.ringGeometry.length - 1]?.find((n) => n.isWinner)?.team ?? null;` (was `rings[4]`).
   - connectors: `shape.ringGeometry.slice(0, -1).map((cfg, depth) => { ... RINGS[depth+1] → shape.ringGeometry[depth+1] ... })`.
   - finalists block: `rings[shape.ringGeometry.length - 1]?.map(...)` and `simRound >= shape.ringGeometry.length` (was `RINGS.length`).
   - any other `RINGS`/`RINGS.length` in render → `shape.ringGeometry`/`shape.ringGeometry.length`.
4. `RadialBracket` no longer imports `RINGS` from the model for rendering (uses `shape`); keep importing `C`, `ellipse`, `colorFor`, `CREST_SCALE`, `buildRings`, `teamJourney`, types.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx tsc --noEmit && npm test`
Expected: new 2022 buildRings tests PASS (4 rings, ARG champion, NED/ARG adjacency); all prior tests still pass; **0 type errors** — because `shape` is optional-with-`DEFAULT_SHAPE`, `BracketInteractive`'s existing call still compiles and 2026 renders unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/components/radialBracketModel.ts src/components/RadialBracket.tsx src/server/data/__fixtures__/espn-bracket-2022.json
git commit -m "feat: buildRings + RadialBracket render N rings from a shape"
```

---

### Task 6: Wire shape + read-only through the page; season switcher

**Files:**
- Create: `src/components/SeasonSwitcher.tsx`
- Modify: `src/components/BracketInteractive.tsx` (props `shape`, `readOnly`; hide predict tab + skip poll when read-only; pass `shape` to `RadialBracket`)
- Modify: `src/app/c/[comp]/[season]/page.tsx` (compute `shape`, pass `shape`/`readOnly`, render switcher)

**Interfaces:**
- Consumes: `bracketShapeFor` (Task 2), `BracketShape` (Task 2), `resolveSeason`/`Competition` (config).

- [ ] **Step 1: Add `SeasonSwitcher`**

Create `src/components/SeasonSwitcher.tsx`:

```tsx
import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';

// Edition picker — shown only when a competition has more than one season.
// Newest first; the current season id is highlighted.
export default function SeasonSwitcher({
  competition, activeSeasonId,
}: { competition: Competition; activeSeasonId: string }) {
  const ids = Object.keys(competition.seasons).sort((a, b) => b.localeCompare(a));
  if (ids.length < 2) return null;
  return (
    <nav className="season-switcher" aria-label={`${competition.shortName} editions`}>
      {ids.map((id) => (
        <Link
          key={id}
          href={`/c/${competition.id}/${id}`}
          className={`season-chip${id === activeSeasonId ? ' season-chip--active' : ''}`}
          aria-current={id === activeSeasonId ? 'page' : undefined}
        >
          {competition.seasons[id].label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Add switcher styles**

In `src/app/globals.css` append:

```css
.season-switcher { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 4px 0 14px; }
.season-chip {
  padding: 5px 12px; border-radius: 999px; font-size: 0.85rem; font-weight: 600;
  color: var(--text-muted); border: 1px solid var(--hairline); text-decoration: none;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.season-chip:hover { color: var(--text); border-color: var(--gold); }
.season-chip--active { color: #0b0b0d; background: var(--gold); border-color: var(--gold); }
```

- [ ] **Step 3: Update `BracketInteractive`**

In `src/components/BracketInteractive.tsx`:
1. Add to `Props`: `shape: BracketShape;` and `readOnly?: boolean;` (import `type { BracketShape } from './bracketShape'`).
2. Gate the mode tabs + poll on read-only:
   - The 15s poll effect: `if (readOnly) return;` at the top of the effect (finished editions never change).
   - The `<div className="bracket-modes">` tablist and the predict controls: render only when `!readOnly`. When `readOnly`, force `mode='live'` (a finished edition is view-only; `useState<BracketMode>(readOnly ? 'live' : 'live')` stays 'live' and the predict tab is hidden so it can't change).
3. Pass `shape` to `<RadialBracket ... shape={shape} />`.

- [ ] **Step 4: Update the page**

In `src/app/c/[comp]/[season]/page.tsx`:
1. Import: `import { bracketShapeFor } from '@/components/bracketShape'; import SeasonSwitcher from '@/components/SeasonSwitcher';`
2. After `const rc = resolveSeason(...)` (and the `notFound()` guard), compute:
   ```ts
   const readOnly = rc.season.id !== rc.competition.currentSeasonId;
   ```
3. In the bracket branch, render the switcher above the bracket and compute the shape:
   ```tsx
   <header className="bracket-head">
     <p className="bracket-eyebrow">{rc.competition.name}</p>
     <h1 className="bracket-title">Knockout Bracket</h1>
     <SeasonSwitcher competition={rc.competition} activeSeasonId={rc.season.id} />
   </header>
   {bracket.length > 0
     ? <BracketInteractive rounds={bracket} apiBase={apiBase} teamStyle={teamStyle}
         compId={rc.competition.id} seasonId={rc.season.id}
         compShortName={rc.competition.shortName} seasonLabel={rc.season.label}
         shape={bracketShapeFor(rc.season)} readOnly={readOnly} />
     : <div className="empty-section"><p className="empty-text">Bracket data is unavailable right now.</p></div>}
   ```

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: 0 type errors; full suite green.

- [ ] **Step 6: Visual verification (required)**

`rm -rf .next && npm run dev`, then:
- `/c/world-cup/2026` — renders the 5-ring bracket exactly as before; predict tab present; live poll works.
- `/c/world-cup/2022` — renders a **4-ring** bracket; teams sit on the right rings; the replay plays R16 → Final and **crowns Argentina**; **no predict tab**; no console errors; the third-place mini still shows (CRO). Click a flag → correct won-match popup.
- `/c/world-cup/2014` — 4-ring bracket, replays to **Germany**.
- Season switcher navigates between editions; active chip highlighted.
- Narrow width (~390px): 4-ring bracket reads correctly.
- Reduced motion: past edition snaps to the completed bracket.

- [ ] **Step 7: Commit**

```bash
git add src/components/SeasonSwitcher.tsx src/components/BracketInteractive.tsx src/app/c/[comp]/[season]/page.tsx src/app/globals.css
git commit -m "feat: season switcher + read-only past editions wired end-to-end"
```

---

## Self-Review

- **Spec coverage:** season configs for 1998–2022 (Task 1); config-driven shape + tuned geometry (Task 2); derive-from-results order (Task 4); generalized `buildRings`/`RadialBracket` (Tasks 3+5); season switcher (Task 6); read-only past editions — no predict, no poll (Task 6); bracket+scores only via `sections` (Task 1); replay reuses the timeline (no change; verified Task 6). Data layer unchanged (confirmed 2022 slugs + `/countries/` logos). ✓
- **Non-goals honored:** no persistence, no stats, no historical standings/news, no pre-1998, no other competitions' past seasons. ✓
- **Placeholder scan:** none — all steps carry concrete code or exact move/edit instructions.
- **Type consistency:** `BracketShape`/`RingGeom`/`bracketShapeFor` (Task 2) consumed unchanged in Tasks 5–6; `buildRings(rounds, shape, picks?, mode?)` signature consistent across Tasks 5–6; `deriveLeafOrder`/`leafOrderFromSeeds` names consistent; `knockoutRounds`/`bracketOrder` field names match Task 1 config.
- **Ordering note for the implementer:** `buildRings` gains a required `shape` param (Task 5), but `RadialBracket`'s `shape` prop is **optional-with-`DEFAULT_SHAPE`**, so every task's commit stays `tsc`-clean and 2026 renders unchanged throughout. Task 6 passes the explicit per-season shape. The full-app visual check runs in Task 6.
