# Liga MX Standings Split View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain Liga MX standings table with a split view — a radial "Liguilla dial" beside a gold tier-banded table — that highlights the top-8 Liguilla cut, using real club crests and live data.

**Architecture:** Config drives the cut (`Season.qualification`). A pure helper splits standings into in/out tiers. Two presentational client components (`LeagueDial` SVG + `LeagueLadder` split) render through the existing `StandingsLive` seam; the page passes the config and opts the section into a wider canvas. No new data fetch call sites.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest, CSS in `src/app/globals.css` (namespaced classes).

## Global Constraints

- TypeScript strict; no `any` in new code.
- Reuse existing CSS tokens (`--gold`, `--gold-bright`, `--hairline`, `--surface`, `--surface-2`, `--text`, `--text-muted`) — do not hardcode colors.
- Namespaced CSS classes: `lld-*` (dial), `ll-*` (ladder/table).
- Dark-only (the app commits to a dark ground).
- No animated SVG blur filters (per bracket-tail perf lesson); any continuous motion uses transform/opacity on filter-free elements. Respect `prefers-reduced-motion`.
- Presentational components are verified by running the app + screenshots, not unit tests (repo convention). Pure logic (config, split helper) gets Vitest tests.
- `npx tsc --noEmit` clean and `npm test` green before a PR. Commit messages use conventional prefixes and end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- `src/server/data/competitions.ts` — add `Season.qualification`; thread through `leagueCompetition`; set for Liga MX.
- `src/server/data/competitions.test.ts` — assert the config.
- `src/components/leagueLadder.ts` — pure `splitByCut` helper.
- `src/components/leagueLadder.test.ts` — helper test.
- `src/components/LeagueDial.tsx` — radial SVG dial (presentational).
- `src/components/LeagueLadder.tsx` — split view (dial + tier table).
- `src/components/StandingsLive.tsx` — render `LeagueLadder` when `qualification` present.
- `src/app/c/[comp]/[season]/page.tsx` — pass `qualification`; wider-canvas class.
- `src/app/globals.css` — `lld-*`, `ll-*`, and wider-canvas styles.

---

### Task 1: Season `qualification` config + Liga MX wiring

**Files:**
- Modify: `src/server/data/competitions.ts`
- Test: `src/server/data/competitions.test.ts`

**Interfaces:**
- Produces: `Season.qualification?: { cut: number; label: string }`. `leagueCompetition(..., qualification?)` accepts an optional trailing param and puts it on the built season. Liga MX Apertura carries `{ cut: 8, label: 'Liguilla' }`.

- [ ] **Step 1: Write the failing test**

Add to `src/server/data/competitions.test.ts`, inside the `describe('competition registry', ...)` block:

```ts
it('Liga MX Apertura carries the Liguilla qualification cut; other leagues do not', () => {
  const ligaMx = COMPETITIONS['liga-mx'];
  const season = ligaMx.seasons[ligaMx.currentSeasonId];
  expect(season.qualification).toEqual({ cut: 8, label: 'Liguilla' });

  const pl = COMPETITIONS['premier-league'];
  expect(pl.seasons[pl.currentSeasonId].qualification).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/competitions.test.ts -t "Liguilla qualification"`
Expected: FAIL (`qualification` is `undefined`, and/or type error).

- [ ] **Step 3: Add the field to the `Season` interface**

In `src/server/data/competitions.ts`, add to `interface Season` (after `knockoutRounds?: string[];`):

```ts
  // Leagues only: highlight the top-N qualification cut in the standings view
  // (e.g. Liga MX top 8 → Liguilla). Absent for leagues with no such cut.
  qualification?: { cut: number; label: string };
```

- [ ] **Step 4: Thread it through `leagueCompetition`**

Replace the `leagueCompetition` signature and season block. Find:

```ts
function leagueCompetition(
  id: string,
  name: string,
  shortName: string,
  espnSlug: string,
  emblem: string,
  seasonId: string,
  seasonLabel: string,
): Record<string, Competition> {
  return {
    [id]: {
      id,
      name,
      shortName,
      espnSlug,
      kind: 'club',
      teamStyle: 'crest',
      emblem,
      currentSeasonId: seasonId,
      seasons: {
        [seasonId]: {
          id: seasonId,
          label: seasonLabel,
          sections: ['standings', 'scores', 'news'],
          format: { hasBracket: false, hasGroups: true, hasThirdPlaceRace: false },
        },
      },
    },
  };
}
```

Replace with (adds the optional `qualification` param, spread onto the season):

```ts
function leagueCompetition(
  id: string,
  name: string,
  shortName: string,
  espnSlug: string,
  emblem: string,
  seasonId: string,
  seasonLabel: string,
  qualification?: { cut: number; label: string },
): Record<string, Competition> {
  return {
    [id]: {
      id,
      name,
      shortName,
      espnSlug,
      kind: 'club',
      teamStyle: 'crest',
      emblem,
      currentSeasonId: seasonId,
      seasons: {
        [seasonId]: {
          id: seasonId,
          label: seasonLabel,
          sections: ['standings', 'scores', 'news'],
          format: { hasBracket: false, hasGroups: true, hasThirdPlaceRace: false },
          ...(qualification ? { qualification } : {}),
        },
      },
    },
  };
}
```

- [ ] **Step 5: Set it for Liga MX**

In the `COMPETITIONS` object, find the Liga MX line:

```ts
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', '2026-apertura', 'Apertura 2026'),
```

Replace with:

```ts
  ...leagueCompetition('liga-mx', 'Liga MX', 'Liga MX', 'mex.1', '🇲🇽', '2026-apertura', 'Apertura 2026', { cut: 8, label: 'Liguilla' }),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/server/data/competitions.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Commit**

```bash
git add src/server/data/competitions.ts src/server/data/competitions.test.ts
git commit -m "feat: add Liga MX Liguilla qualification cut (top 8) to season config"
```

---

### Task 2: `splitByCut` pure helper

**Files:**
- Create: `src/components/leagueLadder.ts`
- Test: `src/components/leagueLadder.test.ts`

**Interfaces:**
- Produces: `splitByCut(standings: Standing[], cut: number): { inCut: Standing[]; out: Standing[] }`. Splits by `rank <= cut` (ordered as given), clamping `cut` to `[1, standings.length - 1]`.

- [ ] **Step 1: Write the failing test**

Create `src/components/leagueLadder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitByCut } from './leagueLadder';
import type { Standing } from '@/server/data/types';

function s(rank: number, points: number, gd = 0): Standing {
  return {
    team: { id: String(rank), name: `T${rank}`, abbr: `T${rank}`, crestUrl: null },
    rank, played: 1, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: gd, points, advanced: false,
  };
}

describe('splitByCut', () => {
  it('splits standings into inCut (rank <= cut) and out, order preserved', () => {
    const rows = [s(1, 3), s(2, 3), s(3, 0), s(4, 0)];
    const { inCut, out } = splitByCut(rows, 2);
    expect(inCut.map((r) => r.rank)).toEqual([1, 2]);
    expect(out.map((r) => r.rank)).toEqual([3, 4]);
  });

  it('keeps a rank-9 team just below an 8-team cut even when tied on points', () => {
    // Nine teams on 3 pts; cut = 8 → the 9th (Puebla-style) is out.
    const rows = Array.from({ length: 18 }, (_, i) => s(i + 1, i < 9 ? 3 : 0));
    const { inCut, out } = splitByCut(rows, 8);
    expect(inCut).toHaveLength(8);
    expect(out[0].rank).toBe(9);
    expect(out[0].points).toBe(3); // a winner, still out
  });

  it('clamps an out-of-range cut', () => {
    const rows = [s(1, 3), s(2, 0)];
    expect(splitByCut(rows, 0).inCut).toHaveLength(1);
    expect(splitByCut(rows, 99).out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/leagueLadder.test.ts`
Expected: FAIL ("Failed to resolve import './leagueLadder'").

- [ ] **Step 3: Write the helper**

Create `src/components/leagueLadder.ts`:

```ts
import type { Standing } from '@/server/data/types';

// Split a league table into the teams inside the qualification cut and the rest.
// Order is preserved (the caller passes rows already ranked by the provider).
// `cut` is clamped to [1, n-1] so the dial/table always show both tiers.
export function splitByCut(
  standings: Standing[],
  cut: number,
): { inCut: Standing[]; out: Standing[] } {
  const n = standings.length;
  const c = Math.max(1, Math.min(cut, Math.max(1, n - 1)));
  return {
    inCut: standings.filter((s) => s.rank <= c),
    out: standings.filter((s) => s.rank > c),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/leagueLadder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/leagueLadder.ts src/components/leagueLadder.test.ts
git commit -m "feat: add splitByCut helper for league qualification tiers"
```

---

### Task 3: `LeagueDial.tsx` — radial SVG dial

**Files:**
- Create: `src/components/LeagueDial.tsx`
- Modify: `src/app/globals.css` (append `lld-*` block)

**Interfaces:**
- Consumes: `Standing` (from types), `TeamStyle` (from competitions).
- Produces: `export default function LeagueDial({ standings, cut, teamStyle }: { standings: Standing[]; cut: number; teamStyle: TeamStyle }): JSX.Element`.

Presentational; verified by `tsc` now and visually at Task 5.

- [ ] **Step 1: Create the component**

Create `src/components/LeagueDial.tsx`:

```tsx
'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';

// Full-ring standings dial: rank 1 at 12 o'clock, clockwise; a glowing gold arc
// sweeps over the teams inside the qualification cut; the leader is crowned in
// the centre hub. Geometry is self-contained (fixed 500x500 viewBox).
const C = 250;
const R = 192;      // team-chip ring radius
const CHIP = 19;    // team-chip radius
const ARC_R = R + 26;
const HUB_R = 26;

function angleRad(rank: number, n: number): number {
  return ((-90 + (rank - 1) * (360 / n)) * Math.PI) / 180;
}
function pt(rank: number, n: number, radius: number): { x: number; y: number } {
  const a = angleRad(rank, n);
  return { x: C + radius * Math.cos(a), y: C + radius * Math.sin(a) };
}

// A crest clipped into a circle, with a fallback coloured disc + abbreviation.
function CrestDisc({
  s, teamStyle, x, y, r, ring, ringWidth, dim,
}: {
  s: Standing; teamStyle: TeamStyle; x: number; y: number; r: number;
  ring: string; ringWidth: number; dim: boolean;
}) {
  const src = teamStyle === 'crest' ? s.team.crestUrl : s.team.crestUrl; // ESPN crest
  const clip = `lld-clip-${s.team.id}`;
  return (
    <g opacity={dim ? 0.4 : 1}>
      <defs>
        <clipPath id={clip}>
          <circle cx={x} cy={y} r={r} />
        </clipPath>
      </defs>
      <circle cx={x} cy={y} r={r} fill="#f4f4f6" />
      {src ? (
        <image
          href={src}
          x={x - r}
          y={y - r}
          width={r * 2}
          height={r * 2}
          clipPath={`url(#${clip})`}
          preserveAspectRatio="xMidYMid meet"
        />
      ) : (
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
          fontSize={r * 0.6} fontWeight={800} fill="#20223a">{s.team.abbr}</text>
      )}
      <circle cx={x} cy={y} r={r} fill="none" stroke={ring} strokeWidth={ringWidth} />
    </g>
  );
}

export default function LeagueDial({
  standings, cut, teamStyle,
}: {
  standings: Standing[];
  cut: number;
  teamStyle: TeamStyle;
}) {
  const n = standings.length;
  if (n === 0) return null;
  const leader = standings[0];
  const inCut = (rank: number) => rank <= cut;

  // gold Liguilla arc over ranks 1..cut
  const a0 = pt(1, n, ARC_R);
  const a1 = pt(Math.min(cut, n), n, ARC_R);

  return (
    <svg className="lld" viewBox="0 0 500 500" role="img" aria-label="Standings dial">
      <defs>
        <radialGradient id="lld-hub" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#40340f" />
          <stop offset="70%" stopColor="#1a1408" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#0b0b0d" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={C} cy={C} r={150} fill="url(#lld-hub)" />

      {/* Liguilla arc: a soft wide underlay (no blur filter) + a crisp line. */}
      <path className="lld-arc-glow"
        d={`M ${a0.x} ${a0.y} A ${ARC_R} ${ARC_R} 0 0 1 ${a1.x} ${a1.y}`}
        fill="none" stroke="var(--gold)" strokeWidth={9} strokeLinecap="round" opacity={0.28} />
      <path className="lld-arc"
        d={`M ${a0.x} ${a0.y} A ${ARC_R} ${ARC_R} 0 0 1 ${a1.x} ${a1.y}`}
        fill="none" stroke="var(--gold-bright)" strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={a0.x} cy={a0.y} r={3.2} fill="var(--gold-bright)" />
      <circle cx={a1.x} cy={a1.y} r={3.2} fill="var(--gold-bright)" />

      {/* spokes + team chips */}
      {standings.map((s) => {
        const p = pt(s.rank, n, R);
        const inner = pt(s.rank, n, 150);
        const outerStub = pt(s.rank, n, R - CHIP - 3);
        const lig = inCut(s.rank);
        return (
          <g key={s.team.id}>
            <line x1={inner.x} y1={inner.y} x2={outerStub.x} y2={outerStub.y}
              stroke={lig ? '#5a4a22' : '#20202a'} strokeWidth={1} />
            <CrestDisc s={s} teamStyle={teamStyle} x={p.x} y={p.y} r={CHIP}
              ring={lig ? 'var(--gold-bright)' : '#33333d'} ringWidth={lig ? 2 : 1} dim={!lig} />
          </g>
        );
      })}

      {/* centre hub: leader */}
      <text x={C} y={C - 30} fill="var(--text-muted)" fontSize={10} letterSpacing={3} textAnchor="middle">LEADER</text>
      <CrestDisc s={leader} teamStyle={teamStyle} x={C} y={C + 2} r={HUB_R}
        ring="var(--gold-bright)" ringWidth={2.5} dim={false} />
      <text x={C} y={C + 44} fill="var(--text)" fontSize={13} fontWeight={700} textAnchor="middle">
        {leader.team.name}
      </text>
    </svg>
  );
}
```

- [ ] **Step 2: Append the dial CSS**

Append to `src/app/globals.css`:

```css
/* ===== League standings dial (Liga MX Liguilla) ===== */
.lld { width: 100%; height: auto; display: block; }
/* Arc draw-in on first paint (transform/opacity only — no filter animation). */
@keyframes lld-arc-in { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.lld-arc { stroke-dasharray: 1; pathLength: 1; animation: lld-arc-in 0.9s ease both; }
@media (prefers-reduced-motion: reduce) { .lld-arc { animation: none; stroke-dashoffset: 0; } }
```

Note: set `pathLength={1}` on the `.lld-arc` path so the dash animation normalizes. Update the `<path className="lld-arc" ...>` in `LeagueDial.tsx` to include `pathLength={1}`.

- [ ] **Step 3: Add `pathLength` to the arc path**

In `LeagueDial.tsx`, change the crisp arc path to include `pathLength={1}`:

```tsx
      <path className="lld-arc"
        d={`M ${a0.x} ${a0.y} A ${ARC_R} ${ARC_R} 0 0 1 ${a1.x} ${a1.y}`}
        fill="none" stroke="var(--gold-bright)" strokeWidth={2.5} strokeLinecap="round" pathLength={1} />
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/components/LeagueDial.tsx src/app/globals.css
git commit -m "feat: add LeagueDial radial standings component"
```

---

### Task 4: `LeagueLadder.tsx` — split view (dial + tier table)

**Files:**
- Create: `src/components/LeagueLadder.tsx`
- Modify: `src/app/globals.css` (append `ll-*` block)

**Interfaces:**
- Consumes: `splitByCut` (Task 2), `LeagueDial` (Task 3), `TeamBadge` (existing), `Standing`, `TeamStyle`.
- Produces: `export default function LeagueLadder({ standings, qualification, teamStyle }: { standings: Standing[]; qualification: { cut: number; label: string }; teamStyle: TeamStyle }): JSX.Element`.

- [ ] **Step 1: Create the component**

Create `src/components/LeagueLadder.tsx`:

```tsx
'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import TeamBadge from './TeamBadge';
import LeagueDial from './LeagueDial';
import { splitByCut } from './leagueLadder';

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

function Row({ s, teamStyle, lig }: { s: Standing; teamStyle: TeamStyle; lig: boolean }) {
  return (
    <div className={`ll-row${lig ? ' ll-row--in' : ''}`}>
      <span className="ll-rank">{s.rank}</span>
      <TeamBadge team={s.team} size={26} style={teamStyle} />
      <span className="ll-name">{s.team.name}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}

export default function LeagueLadder({
  standings, qualification, teamStyle,
}: {
  standings: Standing[];
  qualification: { cut: number; label: string };
  teamStyle: TeamStyle;
}) {
  if (standings.length === 0) {
    return <div className="empty-section"><p className="empty-text">Standings are unavailable right now.</p></div>;
  }
  const { inCut, out } = splitByCut(standings, qualification.cut);

  return (
    <div className="ll-card">
      <div className="ll-split">
        <div className="ll-left">
          <LeagueDial standings={standings} cut={qualification.cut} teamStyle={teamStyle} />
          <div className="ll-legend">
            <span><i className="ll-dot ll-dot--in" />{qualification.label} · top {qualification.cut}</span>
            <span><i className="ll-dot ll-dot--out" />Out</span>
          </div>
        </div>
        <div className="ll-right">
          <div className="ll-band">
            <div className="ll-band-label ll-band-label--in">
              <span>◆ {qualification.label}</span><span className="ll-band-n">Quarterfinals</span><span className="ll-rule" />
            </div>
            {inCut.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig />)}
          </div>
          <div className="ll-cutline"><span className="ll-rule" /><span>{qualification.label} cut</span><span className="ll-rule" /></div>
          <div className="ll-band ll-band--out">
            <div className="ll-band-label">
              <span>Out</span><span className="ll-band-n">{qualification.cut + 1}–{standings.length}</span><span className="ll-rule" />
            </div>
            {out.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig={false} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append the ladder CSS**

Append to `src/app/globals.css`:

```css
/* ===== League standings ladder (split: dial + tier table) ===== */
.ll-card { background: var(--surface); border: 1px solid var(--hairline); border-radius: 16px; overflow: hidden; }
.ll-split { display: grid; grid-template-columns: 44% 1fr; align-items: stretch; }
.ll-left { border-right: 1px solid var(--hairline); padding: 16px 14px; display: flex; flex-direction: column; justify-content: center; }
.ll-right { padding: 14px 16px 16px; }
@media (max-width: 720px) {
  .ll-split { grid-template-columns: 1fr; }
  .ll-left { border-right: none; border-bottom: 1px solid var(--hairline); }
}
.ll-legend { display: flex; gap: 18px; justify-content: center; margin-top: 8px; font-size: 12px; color: var(--text-muted); }
.ll-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.ll-dot--in { background: var(--gold); }
.ll-dot--out { background: #3a3a44; }

.ll-band-label { display: flex; align-items: center; gap: 10px; font-size: 10.5px; letter-spacing: 2.5px; text-transform: uppercase; font-weight: 700; margin: 8px 2px; color: var(--text-muted); }
.ll-band-label--in { color: var(--gold-bright); }
.ll-band-n { color: var(--text-muted); letter-spacing: 1px; font-weight: 600; }
.ll-rule { flex: 1; height: 1px; background: var(--hairline); }

.ll-row { display: grid; grid-template-columns: 20px 26px 1fr auto 22px; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 9px; }
.ll-row--in { background: linear-gradient(90deg, rgba(232,184,75,0.10), rgba(232,184,75,0.02)); box-shadow: inset 2px 0 0 var(--gold); margin-bottom: 3px; }
.ll-band--out .ll-row { opacity: 0.5; }
.ll-rank { color: var(--text-muted); font-variant-numeric: tabular-nums; text-align: right; font-size: 12.5px; }
.ll-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ll-gd { color: var(--text-muted); font-variant-numeric: tabular-nums; font-size: 12.5px; text-align: right; }
.ll-pts { font-weight: 800; font-variant-numeric: tabular-nums; text-align: right; }
.ll-cutline { display: flex; align-items: center; gap: 10px; margin: 8px 2px; color: var(--gold); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; font-weight: 800; }
.ll-cutline .ll-rule { border-top: 1.5px dashed rgba(232,184,75,0.5); height: 0; background: none; }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/LeagueLadder.tsx src/app/globals.css
git commit -m "feat: add LeagueLadder split view (dial + tier-banded table)"
```

---

### Task 5: Wire into `StandingsLive` + page + wider canvas; verify live

**Files:**
- Modify: `src/components/StandingsLive.tsx`
- Modify: `src/app/c/[comp]/[season]/page.tsx`
- Modify: `src/app/globals.css` (wider-canvas rule)

**Interfaces:**
- Consumes: `LeagueLadder` (Task 4), `Season.qualification` (Task 1).
- `StandingsLive` gains an optional prop `qualification?: { cut: number; label: string }`.

- [ ] **Step 1: Add the prop + branch to `StandingsLive`**

In `src/components/StandingsLive.tsx`:

1. Add the import at the top (after the other component imports):

```tsx
import LeagueLadder from './LeagueLadder';
```

2. Extend the `Props` interface — add:

```tsx
  // League qualification cut (e.g. Liga MX top 8 → Liguilla). When set, the
  // standings render as the split dial+tier ladder instead of a plain table.
  qualification?: { cut: number; label: string };
```

3. Add `qualification` to the destructured props in the function signature:

```tsx
export default function StandingsLive({ initialGroups, initialScorers, apiBase, teamStyle = 'flag', showThirdPlace = true, qualification }: Props) {
```

4. Replace the final standings block (the `<div className="std-block">` that renders `Group Stage Results` / `Standings` with the `groups-grid`) with a branch that uses `LeagueLadder` when `qualification` is set. Find:

```tsx
      <div className="std-block">
        <h2 className="std-block-title">{showThirdPlace ? 'Group Stage Results' : 'Standings'}</h2>
        {groups.length > 0 ? (
          <div className="groups-grid">
            {groups.map((group) => (
              <GroupTable key={group.id} group={group} teamStyle={teamStyle} />
            ))}
          </div>
        ) : (
          <div className="empty-section">
            <p className="empty-text">Group data is unavailable right now.</p>
          </div>
        )}
      </div>
```

Replace with:

```tsx
      <div className="std-block">
        <h2 className="std-block-title">{showThirdPlace ? 'Group Stage Results' : 'Standings'}</h2>
        {qualification && !showThirdPlace ? (
          <LeagueLadder
            standings={groups[0]?.standings ?? []}
            qualification={qualification}
            teamStyle={teamStyle}
          />
        ) : groups.length > 0 ? (
          <div className="groups-grid">
            {groups.map((group) => (
              <GroupTable key={group.id} group={group} teamStyle={teamStyle} />
            ))}
          </div>
        ) : (
          <div className="empty-section">
            <p className="empty-text">Group data is unavailable right now.</p>
          </div>
        )}
      </div>
```

- [ ] **Step 2: Pass `qualification` from the page + wider-canvas class**

In `src/app/c/[comp]/[season]/page.tsx`, find the league branch's `table` section:

```tsx
    const table = (
      <section id="table">
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">League Table</h1>
        </header>
        <StandingsLive initialGroups={groups} initialScorers={scorers} apiBase={apiBase} teamStyle={teamStyle} showThirdPlace={false} />
      </section>
    );
```

Replace with (adds the wider-canvas class when a qualification cut exists, and passes it through):

```tsx
    const table = (
      <section id="table" className={rc.season.qualification ? 'std-wide' : undefined}>
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title">League Table</h1>
        </header>
        <StandingsLive initialGroups={groups} initialScorers={scorers} apiBase={apiBase} teamStyle={teamStyle} showThirdPlace={false} qualification={rc.season.qualification} />
      </section>
    );
```

- [ ] **Step 3: Add the wider-canvas CSS**

Append to `src/app/globals.css`:

```css
/* Standings with a qualification ladder opt into a wider canvas on desktop so
   the dial + tier split has room; it still stacks below the split breakpoint. */
.std-wide { width: 100%; max-width: 960px; }
```

- [ ] **Step 4: Typecheck + unit tests**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 5: Verify live in the browser**

Start the dev server if not running (`PORT=3210 npm run dev`), then load `http://localhost:3210/c/liga-mx/2026-apertura`.

Confirm:
- The standings render as the split: dial on the left (real crests, gold Liguilla arc over the top 8, Pachuca crowned in the hub), tier table on the right (gold Liguilla band of 8, "Liguilla cut", dimmed Out band with Puebla 9th).
- Real club crests appear in both the dial and the table rows.
- At a narrow width (≤720px) the split stacks (dial above table).
- The Golden Boot / Top Scorers and Live Scores sections are unchanged.
- A non–Liga MX league (e.g. `http://localhost:3210/c/premier-league/2026-27`) still shows the plain table (no regression).

Capture desktop (e.g. 1100px) and mobile (430px) screenshots for the PR.

- [ ] **Step 6: Production build (guard)**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/StandingsLive.tsx 'src/app/c/[comp]/[season]/page.tsx' src/app/globals.css
git commit -m "feat: render Liga MX standings as the dial + tier ladder split view"
```

---

## Self-Review

**Spec coverage:**
- Goal / split view → Tasks 3–5. ✓
- Format + config-driven cut (top 8, no play-in/relegation) → Task 1. ✓
- Real crests (dial + table) → Task 3 (`CrestDisc` via `crestUrl`), Task 4 (`TeamBadge`). ✓
- `splitByCut` helper + focused test incl. Puebla-9th case → Task 2. ✓
- Seam wiring, Golden Boot untouched, other leagues unchanged → Task 5. ✓
- Wider canvas (option B) → Task 5 (`.std-wide`, max-width 960). ✓
- Perf: no animated blur filters; arc uses filter-free stroke + dash draw-in → Task 3. ✓
- Edge cases: empty standings (LeagueLadder guard + LeagueDial `n===0`), missing crest (fallback disc/TeamBadge), cut clamp (`splitByCut`), n≠18 (dial `360/n`) → Tasks 2–4. ✓
- Testing: config test, helper test, visual verification, tsc/test/build → Tasks 1,2,5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `qualification: { cut: number; label: string }` identical across Task 1 (config), Task 4 (`LeagueLadder` prop), Task 5 (`StandingsLive` prop). `splitByCut(standings, cut)` signature matches between Task 2 and Task 4. `LeagueDial` prop names (`standings`, `cut`, `teamStyle`) match Task 4's usage. `CrestDisc` is internal to `LeagueDial`. ✓

Note: `CrestDisc`'s `src` expression is intentionally `crestUrl` for both styles (Liga MX is `crest`; the national branch is unused here but kept type-consistent).
