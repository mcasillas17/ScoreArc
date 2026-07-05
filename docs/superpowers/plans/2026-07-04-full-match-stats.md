# Full Match Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the full high-value subset of ESPN's 28 per-match team stats (up from 6) as grouped diverging comparison bars behind a "Full match stats" expander, without crowding the match popup.

**Architecture:** Additive change to the existing summary provider seam. `TeamStats` grows from 6 to 20 fields; `buildTeamStats` maps each via the existing `parseStat` helper (plus a `parsePct` helper for fraction-scale accuracy stats). `MatchStatsBlock` is rewritten to render a possession bar + a headline stat tier (always visible) + four collapsible category groups. No new API calls, endpoints, or data sources.

**Tech Stack:** TypeScript (strict), React 18 (Next.js App Router), Vitest, plain CSS in `globals.css`.

## Global Constraints

- ESPN stat source names are exact `boxscore.teams[].statistics[].name` keys — copy verbatim.
- **Percentage scale gotcha (verified against fixture + live):** `possessionPct` is on a **0–100** scale (`47.1`); accuracy stats `passPct`/`shotPct`/`crossPct`/`tacklePct`/`longballPct` are on a **0–1 fraction** scale (`0.8`). Accuracy stats MUST be normalized ×100 at map time so `TeamStats` percentages are uniformly 0–100.
- Every `TeamStats` field is `number | null`. Missing/NaN stats map to `null` (never 0).
- Diverging bar semantics: `homeShare = home / (home + away)`; guard divide-by-zero → neutral 50/50.
- Reuse existing CSS tokens (`--gold` home, `--text-muted` away, `--surface-2` track, `--hairline`, `--text`) and the `<details>` disclosure pattern from `CommentaryFeed`.
- Fixture `src/server/data/__fixtures__/espn-summary.json` already contains all 28 stats (team ids `4789` home, `464` away) — no fixture edits needed.

---

### Task 1: Expand `TeamStats` type + `buildTeamStats` mapper

**Files:**
- Modify: `src/server/data/types.ts:25-32` (`TeamStats` interface)
- Modify: `src/server/data/providers/espn-summary.ts:230-239` (`buildTeamStats`, add `parsePct` helper)
- Test: `src/server/data/providers/espn-summary.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `parseStat(stats, name)` helper (returns `number | null`), `mapSummaryStats(raw, homeId, awayId)` (unchanged signature).
- Produces: expanded `TeamStats` with fields — `possession, shots, shotsOnTarget, shotAccuracy, corners, offsides, passes, passAccuracy, crosses, crossAccuracy, longBalls, tackles, tackleAccuracy, interceptions, clearances, blockedShots, saves, fouls, yellowCards, redCards` (all `number | null`; the five `*Accuracy` fields and `possession` are 0–100).

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/providers/espn-summary.test.ts`:

```ts
describe('mapSummaryStats — full stat set', () => {
  const stats = mapSummaryStats(raw, '4789', '464');

  it('maps count stats for both teams', () => {
    expect(stats).not.toBeNull();
    expect(stats!.home.shots).toBe(14);
    expect(stats!.away.shots).toBe(9);
    expect(stats!.home.offsides).toBe(2);
    expect(stats!.home.saves).toBe(1);
    expect(stats!.away.saves).toBe(4);
    expect(stats!.home.tackles).toBe(24);
    expect(stats!.away.tackles).toBe(19);
  });

  it('normalizes fraction-scale accuracy pcts to 0-100', () => {
    expect(stats!.home.passAccuracy).toBe(80); // 0.8 -> 80
    expect(stats!.away.passAccuracy).toBe(90); // 0.9 -> 90
  });

  it('keeps possession on the 0-100 scale', () => {
    expect(stats!.home.possession).toBeCloseTo(47.1, 1);
    expect(stats!.away.possession).toBeCloseTo(52.9, 1);
  });

  it('maps a stat missing from the payload to null (never 0)', () => {
    const partial = {
      boxscore: {
        teams: [
          { team: { id: '4789' }, statistics: [{ name: 'totalShots', displayValue: '5' }] },
          { team: { id: '464' }, statistics: [{ name: 'totalShots', displayValue: '3' }] },
        ],
      },
    };
    const s = mapSummaryStats(partial, '4789', '464');
    expect(s!.home.shots).toBe(5);
    expect(s!.home.saves).toBeNull();
    expect(s!.home.passAccuracy).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-summary.test.ts -t "full stat set"`
Expected: FAIL — `stats.home.shots` etc. are `undefined` (fields don't exist yet on `TeamStats`, TypeScript error or assertion failure on `offsides`/`saves`/`tackles`/`passAccuracy`).

- [ ] **Step 3: Expand the `TeamStats` interface**

Replace `src/server/data/types.ts:25-32` with:

```ts
export interface TeamStats {
  possession: number | null; // percent 0-100
  shots: number | null;
  shotsOnTarget: number | null;
  shotAccuracy: number | null; // percent 0-100
  corners: number | null;
  offsides: number | null;
  passes: number | null;
  passAccuracy: number | null; // percent 0-100
  crosses: number | null;
  crossAccuracy: number | null; // percent 0-100
  longBalls: number | null;
  tackles: number | null;
  tackleAccuracy: number | null; // percent 0-100
  interceptions: number | null;
  clearances: number | null;
  blockedShots: number | null;
  saves: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
}
```

- [ ] **Step 4: Add `parsePct` helper and expand `buildTeamStats`**

In `src/server/data/providers/espn-summary.ts`, immediately after the existing `parseStat` function (ends at line 175), add:

```ts
// Accuracy stats (passPct, shotPct, …) arrive as 0–1 fractions from ESPN,
// unlike possessionPct which is already 0–100. Normalize to a 0–100 percent.
function parsePct(stats: any[], name: string): number | null {
  const v = parseStat(stats, name);
  return v == null ? null : Math.round(v * 100);
}
```

Replace the existing `buildTeamStats` (lines 230-239) with:

```ts
function buildTeamStats(statistics: any[]): TeamStats {
  return {
    possession: parseStat(statistics, 'possessionPct'),
    shots: parseStat(statistics, 'totalShots'),
    shotsOnTarget: parseStat(statistics, 'shotsOnTarget'),
    shotAccuracy: parsePct(statistics, 'shotPct'),
    corners: parseStat(statistics, 'wonCorners'),
    offsides: parseStat(statistics, 'offsides'),
    passes: parseStat(statistics, 'totalPasses'),
    passAccuracy: parsePct(statistics, 'passPct'),
    crosses: parseStat(statistics, 'totalCrosses'),
    crossAccuracy: parsePct(statistics, 'crossPct'),
    longBalls: parseStat(statistics, 'totalLongBalls'),
    tackles: parseStat(statistics, 'totalTackles'),
    tackleAccuracy: parsePct(statistics, 'tacklePct'),
    interceptions: parseStat(statistics, 'interceptions'),
    clearances: parseStat(statistics, 'totalClearance'),
    blockedShots: parseStat(statistics, 'blockedShots'),
    saves: parseStat(statistics, 'saves'),
    fouls: parseStat(statistics, 'foulsCommitted'),
    yellowCards: parseStat(statistics, 'yellowCards'),
    redCards: parseStat(statistics, 'redCards'),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/server/data/providers/espn-summary.test.ts`
Expected: PASS (new "full stat set" block + all existing tests green).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms no other consumer of `TeamStats` broke).

- [ ] **Step 7: Commit**

```bash
git add src/server/data/types.ts src/server/data/providers/espn-summary.ts src/server/data/providers/espn-summary.test.ts
git commit -m "feat: map full high-value set of ESPN match stats (6 -> 20)"
```

---

### Task 2: Rewrite `MatchStatsBlock` as headline tier + grouped diverging bars

**Files:**
- Modify: `src/components/MatchStats.tsx:209-255` (`MatchStatsBlock` + new `StatRow`/`StatRows`/`StatGroup` helpers)
- Modify: `src/app/globals.css` (add grouped-bar + expander styles near line 1716; remove now-unused `.ls-stat-table*` rules at 1677-1710)

**Interfaces:**
- Consumes: `MatchStats` with the 20-field `TeamStats` from Task 1; existing CSS classes `ls-stat-block`, `ls-stat-poss-*`, `ls-stat-val-home`, `ls-stat-val-away`, `ls-stat-higher`.
- Produces: no exported API change — `MatchStatsBlock({ stats })` keeps its signature; `MatchDetailPopup` needs no edit.

- [ ] **Step 1: Rewrite `MatchStatsBlock` and add row/group helpers**

Replace `src/components/MatchStats.tsx:209-255` (the whole current `MatchStatsBlock`) with:

```tsx
type StatRowData = { label: string; home: number | null; away: number | null; pct?: boolean };

function StatRow({ row }: { row: StatRowData }) {
  const { home, away } = row;
  if (home == null && away == null) return null;
  const hv = home ?? 0;
  const av = away ?? 0;
  const total = hv + av;
  const homeShare = total > 0 ? (hv / total) * 100 : 50;
  const fmt = (v: number | null) => (v == null ? '–' : row.pct ? `${v}%` : `${v}`);
  return (
    <div className="ls-stat-row">
      <span className={`ls-stat-val-home${hv > av ? ' ls-stat-higher' : ''}`}>{fmt(home)}</span>
      <div className="ls-stat-mid">
        <span className="ls-stat-name">{row.label}</span>
        <div className="ls-stat-bar">
          <div className="ls-stat-bar-home" style={{ width: `${homeShare}%` }} />
          <div className="ls-stat-bar-away" />
        </div>
      </div>
      <span className={`ls-stat-val-away${av > hv ? ' ls-stat-higher' : ''}`}>{fmt(away)}</span>
    </div>
  );
}

function hasData(rows: StatRowData[]) {
  return rows.some((r) => r.home != null || r.away != null);
}

function StatRows({ rows }: { rows: StatRowData[] }) {
  return <>{rows.map((r) => <StatRow key={r.label} row={r} />)}</>;
}

function StatGroup({ title, rows }: { title: string; rows: StatRowData[] }) {
  if (!hasData(rows)) return null;
  return (
    <div className="ls-stat-group">
      <div className="ls-stat-group-title">{title}</div>
      <StatRows rows={rows} />
    </div>
  );
}

export function MatchStatsBlock({ stats }: { stats: MatchStats }) {
  const h = stats.home;
  const a = stats.away;
  const homePct = h.possession ?? 50;
  const awayPct = a.possession ?? 50;

  const headline: StatRowData[] = [
    { label: 'Shots', home: h.shots, away: a.shots },
    { label: 'On Target', home: h.shotsOnTarget, away: a.shotsOnTarget },
    { label: 'Pass Accuracy', home: h.passAccuracy, away: a.passAccuracy, pct: true },
    { label: 'Fouls', home: h.fouls, away: a.fouls },
  ];

  const groups: { title: string; rows: StatRowData[] }[] = [
    {
      title: 'Attacking',
      rows: [
        { label: 'Shots', home: h.shots, away: a.shots },
        { label: 'On Target', home: h.shotsOnTarget, away: a.shotsOnTarget },
        { label: 'Shot Accuracy', home: h.shotAccuracy, away: a.shotAccuracy, pct: true },
        { label: 'Corners', home: h.corners, away: a.corners },
        { label: 'Offsides', home: h.offsides, away: a.offsides },
      ],
    },
    {
      title: 'Passing',
      rows: [
        { label: 'Passes', home: h.passes, away: a.passes },
        { label: 'Pass Accuracy', home: h.passAccuracy, away: a.passAccuracy, pct: true },
        { label: 'Crosses', home: h.crosses, away: a.crosses },
        { label: 'Cross Accuracy', home: h.crossAccuracy, away: a.crossAccuracy, pct: true },
        { label: 'Long Balls', home: h.longBalls, away: a.longBalls },
      ],
    },
    {
      title: 'Defending',
      rows: [
        { label: 'Tackles', home: h.tackles, away: a.tackles },
        { label: 'Tackle %', home: h.tackleAccuracy, away: a.tackleAccuracy, pct: true },
        { label: 'Interceptions', home: h.interceptions, away: a.interceptions },
        { label: 'Clearances', home: h.clearances, away: a.clearances },
        { label: 'Blocked Shots', home: h.blockedShots, away: a.blockedShots },
        { label: 'Saves', home: h.saves, away: a.saves },
      ],
    },
    {
      title: 'Discipline',
      rows: [
        { label: 'Fouls', home: h.fouls, away: a.fouls },
        { label: 'Yellow Cards', home: h.yellowCards, away: a.yellowCards },
        { label: 'Red Cards', home: h.redCards, away: a.redCards },
      ],
    },
  ];

  const hasMore = groups.some((g) => hasData(g.rows));

  return (
    <div className="ls-stat-block">
      <div className="ls-stat-poss-bar-wrap">
        <span className="ls-stat-poss-label">{homePct.toFixed(0)}%</span>
        <div className="ls-stat-poss-bar">
          <div className="ls-stat-poss-home" style={{ width: `${homePct}%` }} />
          <div className="ls-stat-poss-away" />
        </div>
        <span className="ls-stat-poss-label">{awayPct.toFixed(0)}%</span>
      </div>

      <StatRows rows={headline} />

      {hasMore && (
        <details className="ls-stat-more">
          <summary className="ls-stat-more-summary">Full match stats</summary>
          <div className="ls-stat-groups">
            {groups.map((g) => <StatGroup key={g.title} title={g.title} rows={g.rows} />)}
          </div>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace the `.ls-stat-table*` CSS with grouped-bar styles**

In `src/app/globals.css`, delete the now-unused table rules (`.ls-stat-table`, `.ls-stat-table tr`, `.ls-stat-table td` at lines 1677-1690) but KEEP `.ls-stat-val-home`, `.ls-stat-label-cell`, `.ls-stat-val-away`, and the `.ls-stat-higher` rules (1692-1716 — still used). Then insert immediately after the `.ls-stat-higher` block (after line 1716):

```css
/* Grouped diverging stat bars */
.ls-stat-row {
  display: grid;
  grid-template-columns: 34px 1fr 34px;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-top: 1px solid var(--hairline);
  font-size: 11px;
}

.ls-stat-mid {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ls-stat-name {
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ls-stat-bar {
  height: 5px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface-2);
  display: flex;
}

.ls-stat-bar-home {
  background: var(--gold);
  height: 100%;
  transition: width 0.3s ease;
}

.ls-stat-bar-away {
  flex: 1;
  background: var(--text-muted);
  opacity: 0.55;
  height: 100%;
}

.ls-stat-more {
  margin-top: 6px;
}

.ls-stat-more-summary {
  cursor: pointer;
  list-style: none;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  padding: 7px 4px;
  border-top: 1px solid var(--hairline);
}

.ls-stat-more-summary::-webkit-details-marker {
  display: none;
}

.ls-stat-more-summary:hover {
  color: var(--text);
}

.ls-stat-group {
  margin-top: 8px;
}

.ls-stat-group-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text);
  padding: 4px;
}
```

- [ ] **Step 3: Typecheck + existing tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass (no test imports `MatchStatsBlock` directly, so this confirms nothing else broke).

- [ ] **Step 4: Visual verification in the running app**

Start the dev server (`npm run dev`), open a **finished World Cup match** in the bracket, click it to open the popup, scroll to the stats section. Confirm:
- Possession bar renders at top; 4 headline rows (Shots, On Target, Pass Accuracy, Fouls) show proportional bars.
- "Full match stats" toggle appears; expanding reveals Attacking / Passing / Defending / Discipline groups with bars.
- Pass/Shot/Cross/Tackle accuracy rows show whole-number percents with `%` (e.g. `80%`, not `0.8`).
- Resize to mobile width (~380px): rows stay single-line, values don't overflow, bars scale.
- Open an **upcoming/preseason match** (no stats): the stats block is absent or shows only what data exists, with no empty group headers and no stray "Full match stats" toggle.

- [ ] **Step 5: Commit**

```bash
git add src/components/MatchStats.tsx src/app/globals.css
git commit -m "feat: grouped diverging match-stat bars with headline tier + expander"
```

---

## Self-Review Notes

- **Spec coverage:** data-layer expansion (Task 1) ✓; 19 grouped stats + possession ✓; headline tier + `<details>` expander ✓; empty-row/empty-group/empty-expander hiding ✓ (`hasData`, `hasMore`); percent `%` suffix ✓; CSS in `ls-stat-*` namespace ✓; tests for new fields + null case ✓.
- **Percent-scale gotcha** (fraction vs 0–100) is captured in Global Constraints + `parsePct` + a dedicated test.
- **No new stat referenced without a mapper field:** every `StatRowData` in Task 2 reads a `TeamStats` field defined in Task 1 (cross-checked names: `shotAccuracy`, `passAccuracy`, `crossAccuracy`, `tackleAccuracy`, `clearances`, `blockedShots`, `longBalls`, etc.).
- **Diverging bar** uses the single-track proportional fill (matches the existing possession bar), consistent with the approved preview mock.
