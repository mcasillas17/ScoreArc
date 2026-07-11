# Bracket Flag Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "flag per decided slot" bracket rendering with one traveling flag per team that walks inward round-by-round on load (and incrementally after), greying where it loses.

**Architecture:** A pure `teamJourney(rings)` helper derives each team's ring-by-ring positions + elimination depth from the existing `RingNode[][]`. A single `simRound` timeline state drives every traveling flag's position (`positions[min(simRound, deepest)]`) via a CSS transform transition; the messy per-slot `InnerFlag` loop is removed.

**Tech Stack:** React 18 (client component), SVG, CSS transitions, Vitest.

## Global Constraints

- No new dependencies (pure React state + CSS transitions; no animation library).
- The traveling flag is the ONLY moving element per team; the R32 twin badge (`OuterTeam`) stays put.
- One flag per team — no persistent flags at intermediate rings.
- Timeline: **~650 ms per round** on load; each glide **~500 ms ease**; greyscale via existing `.bracket-disc--eliminated`.
- Respect `prefers-reduced-motion`: skip the play-through, snap to final, no glide.
- Preserve connectors, junction dots, center trophy, `MatchDetailPopup`, `BracketZoom`, and predict-mode picking.
- `RingNode.index === node.depth` for a team's Nth journey stop (a team occupies contiguous depths 0..k).

---

### Task 1: `teamJourney` pure helper + `RingNode` extraction

**Files:**
- Create: `src/components/radialBracketModel.ts`
- Create: `src/components/radialBracketModel.test.ts`
- Modify: `src/components/RadialBracket.tsx` (remove the local `RingNode` interface at lines 128–143; import it from the new module)

**Interfaces:**
- Consumes: `BracketTeam`, `BracketMatch` from `@/server/data/types`.
- Produces: `RingNode` (interface, moved here), `TeamJourney` (interface), `teamJourney(rings: RingNode[][]): TeamJourney[]`.

- [ ] **Step 1: Write the failing test**

Create `src/components/radialBracketModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { teamJourney, type RingNode } from './radialBracketModel';

function node(depth: number, teamId: string, opts: Partial<RingNode> = {}): RingNode {
  return {
    depth, index: 0, angle: 0, match: null,
    team: { id: teamId, name: teamId, abbr: teamId, crestUrl: null, placeholder: teamId === 'PH' },
    isHome: true, x: depth * 10, y: depth * 100,
    crestX: 0, crestY: 0, discR: 30,
    isWinner: false, eliminated: false, clickable: false, ...opts,
  };
}

describe('teamJourney', () => {
  it('champion: full positions, no elimination, deepest at final', () => {
    const rings: RingNode[][] = [
      [node(0, 'CHA', { isWinner: true })],
      [node(1, 'CHA', { isWinner: true })],
      [node(2, 'CHA', { isWinner: true })],
      [node(3, 'CHA', { isWinner: true })],
      [node(4, 'CHA', { isWinner: true })],
    ];
    const j = teamJourney(rings).find((t) => t.teamId === 'CHA')!;
    expect(j.positions.map((p) => p.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(j.eliminatedAtDepth).toBeNull();
    expect(j.deepestNode.depth).toBe(4);
  });

  it('R32 loser: single position, eliminated at depth 0', () => {
    const rings: RingNode[][] = [[node(0, 'OUT', { eliminated: true })], [], [], [], []];
    const j = teamJourney(rings).find((t) => t.teamId === 'OUT')!;
    expect(j.positions).toHaveLength(1);
    expect(j.eliminatedAtDepth).toBe(0);
  });

  it('R16 loser: two positions, eliminated at depth 1', () => {
    const rings: RingNode[][] = [
      [node(0, 'MID', { isWinner: true })],
      [node(1, 'MID', { eliminated: true })],
      [], [], [],
    ];
    const j = teamJourney(rings).find((t) => t.teamId === 'MID')!;
    expect(j.positions.map((p) => p.depth)).toEqual([0, 1]);
    expect(j.eliminatedAtDepth).toBe(1);
  });

  it('still-alive team: no elimination, deepest = current frontier', () => {
    const rings: RingNode[][] = [
      [node(0, 'ALV', { isWinner: true })],
      [node(1, 'ALV', { isWinner: true })],
      [node(2, 'ALV', { isWinner: false, eliminated: false })],
      [], [],
    ];
    const j = teamJourney(rings).find((t) => t.teamId === 'ALV')!;
    expect(j.eliminatedAtDepth).toBeNull();
    expect(j.deepestNode.depth).toBe(2);
  });

  it('skips placeholder nodes', () => {
    const rings: RingNode[][] = [[node(0, 'PH')]];
    expect(teamJourney(rings)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/radialBracketModel.test.ts`
Expected: FAIL — cannot resolve `./radialBracketModel` (module not created yet).

- [ ] **Step 3: Create the module**

Create `src/components/radialBracketModel.ts`:

```ts
import type { BracketMatch, BracketTeam } from '@/server/data/types';

// Moved out of RadialBracket.tsx so the pure model logic is unit-testable
// without pulling the React component tree into the test.
export interface RingNode {
  depth: number; // 0 (outer, 32 teams) .. 4 (inner, final pair)
  index: number; // slot index within the ring
  angle: number; // degrees on the circle
  match: BracketMatch | null;
  team: BracketTeam;
  isHome: boolean;
  x: number; // flag (or inner disc) position
  y: number;
  crestX: number; // outer crest position (depth 0 only)
  crestY: number;
  discR: number;
  isWinner: boolean; // team is the decided/effective winner of its match
  eliminated: boolean; // team lost its match here (decided, not the winner) -> greyed
  clickable: boolean; // predict mode: match undecided + both participants known
}

export interface JourneyStop {
  depth: number;
  x: number;
  y: number;
}

export interface TeamJourney {
  teamId: string;
  positions: JourneyStop[]; // depth-ascending; positions[0] is the R32 home
  eliminatedAtDepth: number | null; // ring depth where it lost; null if alive / champion
  deepestNode: RingNode; // node at the deepest ring reached (for click + match)
}

/**
 * Derive each real team's inward journey from the built rings. A team occupies
 * a contiguous run of depths 0..k (it only advances to depth d after winning
 * depth d-1), so positions are contiguous and depth === array index.
 */
export function teamJourney(rings: RingNode[][]): TeamJourney[] {
  const byTeam = new Map<string, RingNode[]>();
  for (const ring of rings) {
    for (const n of ring) {
      if (n.team.placeholder) continue;
      const arr = byTeam.get(n.team.id) ?? [];
      arr.push(n);
      byTeam.set(n.team.id, arr);
    }
  }
  const journeys: TeamJourney[] = [];
  for (const [teamId, nodes] of byTeam) {
    nodes.sort((a, b) => a.depth - b.depth);
    const lost = nodes.find((n) => n.eliminated);
    journeys.push({
      teamId,
      positions: nodes.map((n) => ({ depth: n.depth, x: n.x, y: n.y })),
      eliminatedAtDepth: lost ? lost.depth : null,
      deepestNode: nodes[nodes.length - 1],
    });
  }
  return journeys;
}
```

- [ ] **Step 4: Point RadialBracket at the shared `RingNode`**

In `src/components/RadialBracket.tsx`, delete the local `interface RingNode { ... }` block (lines ~128–143) and add to the imports at the top:

```ts
import { teamJourney, type RingNode, type TeamJourney } from './radialBracketModel';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/components/radialBracketModel.test.ts && npx tsc --noEmit`
Expected: 5 tests PASS; tsc reports 0 errors (RadialBracket still compiles against the imported `RingNode`).

- [ ] **Step 6: Commit**

```bash
git add src/components/radialBracketModel.ts src/components/radialBracketModel.test.ts src/components/RadialBracket.tsx
git commit -m "refactor: extract RingNode + add pure teamJourney helper"
```

---

### Task 2: Drive traveling flags from a `simRound` timeline

**Files:**
- Modify: `src/components/RadialBracket.tsx` (add `simRound` state + timeline effects; replace the inner-ring `InnerFlag` loop at lines ~657–700 with a per-team traveling-flag render; add a `TravelingFlag` component; delete the old `InnerFlag` component + `TravelPath` interface)
- Modify: `src/app/globals.css` (remove `.bracket-advance` keyframes; add `.bracket-travel` transition + reduced-motion override)

**Interfaces:**
- Consumes: `teamJourney`, `TeamJourney` from `radialBracketModel` (Task 1); existing `ImageDisc`, `FallbackDisc`, `flagUrl`, `crestSrc`, `activate`, `handleView`, `handleDiscClick`.
- Produces: none (internal component behavior).

- [ ] **Step 1: Add the `simRound` timeline to the component body**

In `RadialBracket.tsx`, immediately after `const rings = buildRings(rounds, picks, mode);` (line ~368), add:

```tsx
  const journeys = teamJourney(rings);
  const maxReached = journeys.reduce((m, j) => Math.max(m, j.positions.length - 1), 0);

  // simRound walks the tournament inward: 0 -> maxReached on first mount, then
  // stays pinned so live refreshes / predict picks only glide the newly-deepened
  // flag one ring further (never a full replay).
  const [simRound, setSimRound] = useState(0);
  const initDone = useRef(false);
  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || maxReached === 0) {
      setSimRound(maxReached);
      initDone.current = true;
      return;
    }
    setSimRound(0);
    let d = 0;
    const id = setInterval(() => {
      d += 1;
      setSimRound(d);
      if (d >= maxReached) {
        clearInterval(id);
        initDone.current = true;
      }
    }, 650);
    return () => clearInterval(id);
    // mount only — captures the initial maxReached
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After the intro, keep up with newly-decided rounds (glide, don't replay).
  useEffect(() => {
    if (initDone.current) setSimRound((s) => Math.max(s, maxReached));
  }, [maxReached]);
```

Add `useRef` to the React import at line 3:

```ts
import { useEffect, useRef, useState, type CSSProperties } from 'react';
```

- [ ] **Step 2: Replace the inner-ring `InnerFlag` loop with traveling flags**

Replace the entire block that starts with the comment `{/* Inner rings (depth 1-4): single flag when decided...` and its `{rings.slice(1).map((ring, ri) => { ... })}` mapping (lines ~657–700) with:

```tsx
        {/* Traveling flags: one per team, gliding inward as simRound advances.
            The R32 twin badge stays put; this is the only MOVING element. */}
        {journeys
          .filter((j) => j.positions.length > 1)
          .map((j) => (
            <TravelingFlag
              key={`travel-${j.teamId}`}
              journey={j}
              simRound={simRound}
              mode={mode}
              teamStyle={teamStyle}
              onView={(m) => handleView(m)}
              onPick={(node) => handleDiscClick(node)}
            />
          ))}
```

- [ ] **Step 3: Delete the old `InnerFlag` component and `TravelPath`**

Remove the `interface TravelPath { ... }` block (lines ~924–929) and the entire `function InnerFlag(...) { ... }` (lines ~931–1026). They are now unused.

- [ ] **Step 4: Add the `TravelingFlag` component**

Add this at the end of `RadialBracket.tsx` (where `InnerFlag` used to be):

```tsx
/** One flag per team that glides inward along its journey as simRound advances. */
function TravelingFlag({
  journey,
  simRound,
  mode,
  teamStyle,
  onView,
  onPick,
}: {
  journey: TeamJourney;
  simRound: number;
  mode: BracketMode;
  teamStyle: TeamStyle;
  onView: (m: BracketMatch) => void;
  onPick: (node: RingNode) => void;
}) {
  const deep = journey.positions.length - 1;
  const stop = journey.positions[Math.min(simRound, deep)];
  const node = journey.deepestNode;
  const arrived = simRound >= deep;
  const greyed = journey.eliminatedAtDepth != null && simRound >= journey.eliminatedAtDepth;

  // Only interactive once it has arrived at its resting ring.
  const viewable = arrived && mode !== 'predict' && node.match != null;
  const clickable = arrived && mode === 'predict' && node.clickable;
  const interactive = viewable || clickable;

  const r = node.discR;
  const ringStroke = node.isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = node.isWinner ? 2.4 : 1;
  const { team } = journey.deepestNode;

  let disc: React.ReactNode;
  if (teamStyle === 'crest') {
    const img = team.crestUrl ?? crestSrc(team.abbr);
    disc = img ? (
      <ImageDisc id={`travel-${journey.teamId}`} x={0} y={0} r={r} href={img} fit="meet" bg="#f4f4f6" ringStroke={ringStroke} ringWidth={ringWidth} />
    ) : (
      <FallbackDisc x={0} y={0} r={r} abbr={team.abbr} ringStroke={ringStroke} ringWidth={ringWidth} />
    );
  } else {
    const flag = flagUrl(team.abbr);
    disc = flag ? (
      <ImageDisc id={`travel-${journey.teamId}`} x={0} y={0} r={r} href={flag} fit="slice" bg={null} ringStroke={ringStroke} ringWidth={ringWidth} />
    ) : (
      <FallbackDisc x={0} y={0} r={r} abbr={team.abbr} ringStroke={ringStroke} ringWidth={ringWidth} />
    );
  }

  const style = { transform: `translate(${stop.x}px, ${stop.y}px)` } as CSSProperties;
  const cls = `bracket-disc bracket-travel${interactive ? ' bracket-disc--clickable' : ''}${greyed ? ' bracket-disc--eliminated' : ''}`;

  const handleClick = () => {
    if (clickable) onPick(node);
    else if (viewable && node.match) onView(node.match);
  };

  return (
    <g
      className={cls}
      style={style}
      aria-label={team.name}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? activate(handleClick) : undefined}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
    >
      {disc}
    </g>
  );
}
```

- [ ] **Step 5: Swap the CSS — remove `.bracket-advance`, add `.bracket-travel`**

In `src/app/globals.css`, find the `.bracket-advance` rule and its `@keyframes` (the per-slot travel animation using `--x0..--y2`) and delete them. Then, next to the `.bracket-disc--eliminated` rule (around line 469), add:

```css
/* Traveling flag: glides between ring positions via a transform transition. */
.bracket-travel {
  transition: transform 0.5s ease;
}
@media (prefers-reduced-motion: reduce) {
  .bracket-travel {
    transition: none;
  }
}
```

- [ ] **Step 6: Typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: 0 type errors; full suite passes (no test imports `RadialBracket`, so this confirms nothing else broke and Task 1's tests still pass).

- [ ] **Step 7: Visual verification (required — this is an animation)**

Start the dev server (`npm run dev`, `rm -rf .next` first if HMR is stale) and open the World Cup bracket. Confirm:
- On load, flags **walk inward round-by-round** — one flag per team, starting from the outer ring.
- Exactly **one moving flag per team** (no swarm of flags between levels).
- Eliminated teams **grey out** at the ring where they lost; R32 losers grey their home badge (no traveling flag).
- The champion's flag ends at the center; still-alive teams rest at the current frontier.
- Clicking a flag still opens its match; predict mode still lets you pick (a pick glides that flag one ring further).
- Narrow width (~380px): still reads correctly.
- With OS "reduce motion" on: flags appear at final positions instantly, no glide.

- [ ] **Step 8: Commit**

```bash
git add src/components/RadialBracket.tsx src/app/globals.css
git commit -m "feat: one traveling flag per team walking the bracket inward"
```

---

## Self-Review Notes

- **Spec coverage:** one flag per team (Task 2 render + `positions.length > 1` filter) ✓; starts at outer ring, walks inward (`simRound` timeline + `positions[min(simRound, deep)]`) ✓; greyscale on elimination (`greyed` + `.bracket-disc--eliminated`) ✓; once-on-load-then-incremental (`initDone` ref + the two effects) ✓; reduced-motion (skip + CSS override) ✓; twin badge stays as home (`OuterTeam` untouched) ✓; preserve connectors/popup/zoom/predict (kept; traveling flag carries `clickable`/`match`) ✓; `teamJourney` unit-tested (Task 1) ✓.
- **Placeholder scan:** none — all code is concrete.
- **Type consistency:** `RingNode`, `TeamJourney`, `teamJourney` names match across Task 1 (defined) and Task 2 (consumed); `deepestNode`, `positions`, `eliminatedAtDepth` used consistently.
- **Note for the implementer:** at `simRound === 0` a traveling flag renders at its R32 home position (overlapping the twin badge's flag roundel) for the split second before the intro starts — this is the intended "emerges from home" behavior, not a bug.
