# Match Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live match team-stats (possession, shots, shots on target, passes, corners, fouls) to ScoreArc's live-score cards from the ESPN summary endpoint's boxscore.

**Architecture:** Extend the `Match` type with `stats: MatchStats | null`, map stats in a new `mapSummaryStats` function in the existing ESPN summary provider, thread home/away IDs through the service's `getMatchSummary`, and render a possession bar + stat table in `MatchCard`.

**Tech Stack:** Next.js 14, TypeScript, Vitest, CSS custom properties (dark theme).

## Global Constraints

- No `any` in component code; `any` is acceptable in provider/mapper files (existing pattern).
- `npx tsc --noEmit` must be clean.
- `npm test` must show 58+ tests passing (58 existing must not regress).
- `npm run build` must succeed.
- Do not touch the bracket.
- CSS classes must be prefixed `ls-stat-`.
- Commit on branch `feat/match-stats` with message: `feat: live match stats (possession, shots, passes, corners, fouls) in live-score cards`.

---

## File Map

| File | Action |
|------|--------|
| `src/server/data/types.ts` | Add `TeamStats`, `MatchStats` interfaces; extend `Match.stats` |
| `src/server/data/providers/espn-matches.ts` | Add `stats: null` to mapped match object |
| `src/server/data/providers/espn-summary.ts` | Add `mapSummaryStats(raw, homeId, awayId)` |
| `src/server/data/providers/espn-summary.test.ts` | Add tests for `mapSummaryStats` |
| `src/server/data/service.ts` | Change `getMatchSummary` to accept `homeId, awayId`; return `stats` |
| `src/server/data/service.test.ts` | Update assertions to include `stats` field |
| `src/components/LiveScores.tsx` | Render possession bar and stat table in `MatchCard` |
| `src/app/globals.css` | Add `ls-stat-*` CSS classes |

---

### Task 1: Create the branch

- [ ] **Step 1: Create and checkout the feature branch**

```bash
git checkout -b feat/match-stats
```

Expected: `Switched to a new branch 'feat/match-stats'`

---

### Task 2: Extend `types.ts` with `TeamStats`, `MatchStats`, and `Match.stats`

**Files:**
- Modify: `src/server/data/types.ts`

**Interfaces:**
- Produces: `TeamStats`, `MatchStats` used by providers and UI

- [ ] **Step 1: Add the new types and extend Match**

Open `src/server/data/types.ts`. After the `Card` interface (after line 23) and before `Shootout`, add:

```ts
export interface TeamStats {
  possession: number | null; // percent, e.g. 47.1
  shots: number | null;
  shotsOnTarget: number | null;
  passes: number | null;
  corners: number | null;
  fouls: number | null;
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
}
```

Then in the `Match` interface, after `shootout: Shootout | null;`, add:

```ts
  stats: MatchStats | null;
```

- [ ] **Step 2: Verify TypeScript is still clean**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: errors about missing `stats` field on the mapped match object in `espn-matches.ts` — that's fine, we fix it next.

---

### Task 3: Add `stats: null` default to `espn-matches.ts`

**Files:**
- Modify: `src/server/data/providers/espn-matches.ts`

**Interfaces:**
- Consumes: `Match` from `types.ts` (now has `stats` field)
- Produces: `Match[]` with `stats: null` until enriched by service

- [ ] **Step 1: Add `stats: null` to the returned match object**

In `src/server/data/providers/espn-matches.ts`, inside the `return { ... }` of `mapScoreboard`, after `shootout: null,` add:

```ts
      stats: null,
```

- [ ] **Step 2: Run existing tests to confirm no regression**

```bash
npm test
```

Expected: 58 tests passing.

---

### Task 4: TDD `mapSummaryStats` in `espn-summary.ts`

**Files:**
- Modify: `src/server/data/providers/espn-summary.test.ts` (tests first)
- Modify: `src/server/data/providers/espn-summary.ts` (implementation)

**Interfaces:**
- Produces: `export function mapSummaryStats(raw: unknown, homeId: string, awayId: string): MatchStats | null`

**Key fixture facts:**
- Fixture: `src/server/data/__fixtures__/espn-summary.json`
- `boxscore.teams[0]` = Ivory Coast, id `"4789"`, stats include: `possessionPct=47.1`, `totalShots=14`, `shotsOnTarget=5`, `totalPasses=401`, `wonCorners=14`, `foulsCommitted=6`
- `boxscore.teams[1]` = Norway, id `"464"`, stats include: `possessionPct=52.9`, `totalShots=9`, `shotsOnTarget=4`, `totalPasses=473`, `wonCorners=3`, `foulsCommitted=7`

- [ ] **Step 1: Write the failing tests**

Add to end of `src/server/data/providers/espn-summary.test.ts`:

```ts
import { mapSummaryStats } from './espn-summary';

describe('mapSummaryStats', () => {
  // Fixture: Ivory Coast (4789) is teams[0], Norway (464) is teams[1]
  // Pass Ivory Coast as home, Norway as away
  const result = mapSummaryStats(raw, '4789', '464');

  it('returns non-null for valid fixture input', () => {
    expect(result).not.toBeNull();
  });

  it('maps home team possession to a number', () => {
    expect(result!.home.possession).toBe(47.1);
  });

  it('maps home team shots to a number', () => {
    expect(result!.home.shots).toBe(14);
  });

  it('maps home team shotsOnTarget to a number', () => {
    expect(result!.home.shotsOnTarget).toBe(5);
  });

  it('maps home team passes to a number', () => {
    expect(result!.home.passes).toBe(401);
  });

  it('maps home team corners to a number', () => {
    expect(result!.home.corners).toBe(14);
  });

  it('maps home team fouls to a number', () => {
    expect(result!.home.fouls).toBe(6);
  });

  it('maps away team possession correctly', () => {
    expect(result!.away.possession).toBe(52.9);
  });

  it('maps away team stats correctly', () => {
    expect(result!.away.shots).toBe(9);
    expect(result!.away.shotsOnTarget).toBe(4);
    expect(result!.away.passes).toBe(473);
    expect(result!.away.corners).toBe(3);
    expect(result!.away.fouls).toBe(7);
  });

  it('swaps home/away when ids are reversed', () => {
    const reversed = mapSummaryStats(raw, '464', '4789');
    expect(reversed!.home.possession).toBe(52.9); // Norway as home
    expect(reversed!.away.possession).toBe(47.1); // Ivory Coast as away
  });

  it('returns null for empty object input', () => {
    expect(mapSummaryStats({}, 'a', 'b')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(mapSummaryStats(null, 'a', 'b')).toBeNull();
  });

  it('returns null when boxscore.teams is missing', () => {
    expect(mapSummaryStats({ boxscore: {} }, 'a', 'b')).toBeNull();
  });

  it('returns null when team ids do not match', () => {
    expect(mapSummaryStats(raw, 'x', 'y')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test 2>&1 | grep -E "FAIL|mapSummaryStats|Error" | head -20
```

Expected: Tests fail because `mapSummaryStats` is not exported from `espn-summary.ts`.

- [ ] **Step 3: Implement `mapSummaryStats` in `espn-summary.ts`**

Add to `src/server/data/providers/espn-summary.ts`, after the existing imports and before `mapSummaryScorers`:

```ts
import type { Scorer, Card, MatchStats, TeamStats } from '../types';

function parseStat(stats: any[], name: string): number | null {
  const s = stats.find((x: any) => x.name === name);
  if (s == null) return null;
  const n = parseFloat(s.displayValue);
  return isNaN(n) ? null : n;
}

function buildTeamStats(statistics: any[]): TeamStats {
  return {
    possession: parseStat(statistics, 'possessionPct'),
    shots: parseStat(statistics, 'totalShots'),
    shotsOnTarget: parseStat(statistics, 'shotsOnTarget'),
    passes: parseStat(statistics, 'totalPasses'),
    corners: parseStat(statistics, 'wonCorners'),
    fouls: parseStat(statistics, 'foulsCommitted'),
  };
}

export function mapSummaryStats(
  raw: unknown,
  homeId: string,
  awayId: string
): MatchStats | null {
  try {
    const teams: any[] = (raw as any)?.boxscore?.teams;
    if (!Array.isArray(teams) || teams.length < 2) return null;
    const homeEntry = teams.find((t: any) => String(t.team?.id) === homeId);
    const awayEntry = teams.find((t: any) => String(t.team?.id) === awayId);
    if (!homeEntry || !awayEntry) return null;
    return {
      home: buildTeamStats(homeEntry.statistics ?? []),
      away: buildTeamStats(awayEntry.statistics ?? []),
    };
  } catch {
    return null;
  }
}
```

Note: Update the import at the top of the file from:
```ts
import type { Scorer, Card } from '../types';
```
to:
```ts
import type { Scorer, Card, MatchStats, TeamStats } from '../types';
```

- [ ] **Step 4: Run tests to verify new tests pass**

```bash
npm test
```

Expected: 58 + ~13 new tests = 71+ tests passing.

---

### Task 5: Update `service.ts` to pass home/away ids and return `stats`

**Files:**
- Modify: `src/server/data/service.ts`

**Interfaces:**
- Consumes: `mapSummaryStats(raw, homeId, awayId)` from `espn-summary.ts`
- Produces: `getMatchSummary(eventId, homeId, awayId, ttlMs?)` returning `{ scorers, cards, stats }`

- [ ] **Step 1: Update `service.ts`**

In `src/server/data/service.ts`, make these changes:

1. Add `mapSummaryStats` to the import from `./providers/espn-summary`:
```ts
import { mapSummaryScorers, mapSummaryCards, mapSummaryStats } from './providers/espn-summary';
```

2. Add `MatchStats` to the type imports:
```ts
import type { Match, Group, BracketRound, Scorer, Card, Shootout, MatchStats } from './types';
```

3. Change `getMatchSummary`'s signature and body:
```ts
  async function getMatchSummary(
    eventId: string,
    homeId: string,
    awayId: string,
    ttlMs = 12_000
  ): Promise<{ scorers: Scorer[]; cards: Card[]; stats: MatchStats | null }> {
    const key = `summary:${eventId}`;
    const cached = deps.cache.get(key) as
      | { scorers: Scorer[]; cards: Card[]; stats: MatchStats | null }
      | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(SUMMARY_URL(eventId));
    const summary = {
      scorers: mapSummaryScorers(raw),
      cards: mapSummaryCards(raw),
      stats: mapSummaryStats(raw, homeId, awayId),
    };
    deps.cache.set(key, summary, ttlMs);
    return summary;
  }
```

4. Update the `getMatches` enrichment call to pass home/away ids and attach stats:
```ts
      const summaries = await Promise.all(
        enrichable.map((m) =>
          getMatchSummary(m.id, m.home.id, m.away.id).catch(() => ({
            scorers: [] as Scorer[],
            cards: [] as Card[],
            stats: null as MatchStats | null,
          }))
        )
      );
      enrichable.forEach((m, i) => {
        m.scorers = summaries[i].scorers;
        m.cards = summaries[i].cards;
        m.stats = summaries[i].stats;
      });
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All tests pass. The service test for scorer enrichment will now also populate `stats` (the summary fixture has boxscore data with Ivory Coast id `4789` and Norway id `464`; these won't match the scoreboard's match home/away ids, so `stats` may be null for those matches — that is correct and acceptable behavior).

- [ ] **Step 3: Run type check**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

### Task 6: UI — Render stats block in `MatchCard` and add CSS

**Files:**
- Modify: `src/components/LiveScores.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `match.stats: MatchStats | null` from `Match`

- [ ] **Step 1: Add CSS to `globals.css`**

Append to the end of `src/app/globals.css`:

```css
/* ===== Match Stats (ls-stat-*) ===== */
.ls-stat-block {
  margin-top: 10px;
  padding: 0 4px;
}

.ls-stat-poss-bar-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.ls-stat-poss-label {
  font-size: 10px;
  color: var(--text-muted);
  min-width: 32px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.ls-stat-poss-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface-2);
  display: flex;
}

.ls-stat-poss-home {
  background: var(--gold);
  height: 100%;
  transition: width 0.3s ease;
}

.ls-stat-poss-away {
  flex: 1;
  background: var(--text-muted);
  height: 100%;
  opacity: 0.55;
}

.ls-stat-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.ls-stat-table tr {
  border-top: 1px solid var(--hairline);
}

.ls-stat-table td {
  padding: 3px 4px;
  color: var(--text-muted);
}

.ls-stat-val-home {
  text-align: right;
  width: 30%;
  font-variant-numeric: tabular-nums;
}

.ls-stat-label-cell {
  text-align: center;
  width: 40%;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ls-stat-val-away {
  text-align: left;
  width: 30%;
  font-variant-numeric: tabular-nums;
}

.ls-stat-val-home.ls-stat-higher,
.ls-stat-val-away.ls-stat-higher {
  color: var(--text);
  font-weight: 600;
}
```

- [ ] **Step 2: Update `LiveScores.tsx` to import `MatchStats` and add the `MatchStatsBlock` component**

In `src/components/LiveScores.tsx`:

1. Update the import line at the top:
```ts
import type { Match, Scorer, Card, Team, MatchStats } from "@/server/data/types";
```

2. Add the `MatchStatsBlock` component before `MatchCard`:

```tsx
function MatchStatsBlock({ stats }: { stats: MatchStats }) {
  const homePct = stats.home.possession ?? 50;
  const awayPct = stats.away.possession ?? 50;

  type StatRow = { label: string; home: number | null; away: number | null };
  const rows: StatRow[] = [
    { label: "Shots", home: stats.home.shots, away: stats.away.shots },
    { label: "On Target", home: stats.home.shotsOnTarget, away: stats.away.shotsOnTarget },
    { label: "Passes", home: stats.home.passes, away: stats.away.passes },
    { label: "Corners", home: stats.home.corners, away: stats.away.corners },
    { label: "Fouls", home: stats.home.fouls, away: stats.away.fouls },
  ];

  return (
    <div className="ls-stat-block">
      <div className="ls-stat-poss-bar-wrap">
        <span className="ls-stat-poss-label">{homePct.toFixed(0)}%</span>
        <div className="ls-stat-poss-bar">
          <div
            className="ls-stat-poss-home"
            style={{ width: `${homePct}%` }}
          />
          <div className="ls-stat-poss-away" />
        </div>
        <span className="ls-stat-poss-label">{awayPct.toFixed(0)}%</span>
      </div>
      <table className="ls-stat-table">
        <tbody>
          {rows.map((row) => {
            const hVal = row.home ?? 0;
            const aVal = row.away ?? 0;
            const homeHigher = hVal > aVal;
            const awayHigher = aVal > hVal;
            return (
              <tr key={row.label}>
                <td className={`ls-stat-val-home${homeHigher ? " ls-stat-higher" : ""}`}>
                  {row.home ?? "–"}
                </td>
                <td className="ls-stat-label-cell">{row.label}</td>
                <td className={`ls-stat-val-away${awayHigher ? " ls-stat-higher" : ""}`}>
                  {row.away ?? "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

3. Inside `MatchCard`, after the `{started && hasCards && (...)}` block and before `<div className="match-status">`, add:

```tsx
      {started && match.stats && (
        <MatchStatsBlock stats={match.stats} />
      )}
```

- [ ] **Step 3: Run type check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: 71+ tests passing (58 original + ~13 new).

- [ ] **Step 5: Run build**

```bash
npm run build 2>&1 | tail -20
```

Expected: Build succeeds with no type errors.

---

### Task 7: Write report and commit

**Files:**
- Create: `/Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket/.superpowers/sdd/stats-report.md`

- [ ] **Step 1: Create the report directory and file**

```bash
mkdir -p /Users/elopenmike/build/Apps/Soccer/WorldCup2026Bracket/.superpowers/sdd
```

Write the report to `.superpowers/sdd/stats-report.md` with sections: schema, mapping, service change, UI, verification.

- [ ] **Step 2: Commit**

```bash
git add \
  src/server/data/types.ts \
  src/server/data/providers/espn-matches.ts \
  src/server/data/providers/espn-summary.ts \
  src/server/data/providers/espn-summary.test.ts \
  src/server/data/service.ts \
  src/components/LiveScores.tsx \
  src/app/globals.css \
  docs/superpowers/plans/2026-06-30-match-stats.md \
  .superpowers/sdd/stats-report.md

git commit -m "feat: live match stats (possession, shots, passes, corners, fouls) in live-score cards"
```

Expected: Commit created on `feat/match-stats`.
