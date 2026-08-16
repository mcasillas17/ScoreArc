# Assists & Per-Match Box Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the assist leaderboard and the per-player match box score, both of which already arrive in responses ScoreArc fetches today and discards, without adding a single network request.

**Architecture:** `TopScorer` generalises to `StatLeader` (metric-agnostic) and `TopScorersTable` to `LeaderTable`, so goals and assists are one component with a config, not two components with the same markup. The store fetches `/statistics` once and caches both boards under one key. `mapSummaryLineups` learns to read the `stats[]` array it already walks past, looking up **by name** because the stat set differs between goalkeepers and outfielders.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-assists-and-box-score-design.md`
**Epic:** E1 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `feat/assists-and-box-score` off latest `origin/main`

> ⚠️ **`main` has moved since this plan was written (2026-08-15).** PRs #33–#35
> added Vercel analytics and telemetry across the API routes and several
> components. Code quoted below is accurate **as of the plan's date**, not
> necessarily as of today.
>
> **Before replacing any block, open the file and diff it against the quote.**
> Where they differ, apply the plan's *intent* to the current code rather than
> pasting the quoted block — pasting would silently delete the telemetry calls
> (`trackAPIRequestFailure`, `trackFeedFailure`, `trackFeedRecovery`) that now
> live in these files. Deleting telemetry is invisible in review and only
> discovered when a dashboard goes quiet.

## Global Constraints

- TypeScript strict; `any` only inside ESPN mappers on raw payloads, per existing convention.
- Reuse existing CSS tokens and the `std-*` / `ls-*` class families. No new colours.
- **No new network requests.** If the Network tab shows two `/statistics` calls per render, the task is not done.
- `npx tsc --noEmit` clean and `npm test` green before a PR.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run build` while `npm run dev` is running.

---

## File Structure

- `src/server/data/types.ts` — `StatLeader` replaces `TopScorer`; `PlayerMatchStats` added; `LineupPlayer` gains `stats`.
- `src/server/data/providers/espn-stats.ts` — `mapLeaders(raw, category, limit)` replaces `mapTopScorers`.
- `src/server/data/providers/espn-stats.test.ts` — updated to the new name; assists cases added.
- `src/server/data/store.ts` — `getLeaders` fetches once, caches both boards; `getTopScorers` and `getTopAssists` read it.
- `src/app/api/[comp]/[season]/top-assists/route.ts` — new sibling route.
- `src/components/LeaderTable.tsx` — renamed from `TopScorersTable.tsx`, metric-driven.
- `src/components/StandingsLive.tsx` — polls both boards, renders both blocks.
- `src/app/c/[comp]/[season]/standings/page.tsx`, `src/app/c/[comp]/[season]/page.tsx` — type rename + assists in the server fetch.
- `src/server/data/providers/espn-summary.ts` — `mapSummaryLineups` reads `stats[]` and stops dropping substitutes.
- `src/components/MatchExtras.tsx` — box-score rendering.
- `src/app/globals.css` — `ls-box-*` classes (append).

---

### Task 1: `mapLeaders` — read any leader category, not just goals

**Files:**
- Modify: `src/server/data/types.ts:168-176`
- Modify: `src/server/data/providers/espn-stats.ts`
- Test: `src/server/data/providers/espn-stats.test.ts`

**Interfaces:**
- `StatLeader` — `{ rank: number; player: string; teamAbbr: string; teamName: string; teamCrestUrl: string | null; value: number; matches: number | null }`. Replaces `TopScorer`; the metric-specific field `goals` becomes `value`.
- `mapLeaders(raw: unknown, category: string, limit?: number): StatLeader[]` — `category` is an ESPN `stats[].name`, e.g. `'goalsLeaders'` or `'assistsLeaders'`. Returns `[]` for a missing category or malformed payload.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `src/server/data/providers/espn-stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapLeaders } from './espn-stats';
import raw from '../__fixtures__/espn-statistics.json';

describe('mapLeaders', () => {
  const scorers = mapLeaders(raw, 'goalsLeaders');

  it('returns a ranked list starting at 1', () => {
    expect(scorers.length).toBeGreaterThan(0);
    expect(scorers[0].rank).toBe(1);
    expect(scorers[1].rank).toBe(2);
  });

  it('is sorted by value descending', () => {
    for (let i = 1; i < scorers.length; i++) {
      expect(scorers[i - 1].value).toBeGreaterThanOrEqual(scorers[i].value);
    }
  });

  it('maps player, team abbreviation and value', () => {
    expect(scorers[0].player.length).toBeGreaterThan(0);
    expect(scorers[0].teamAbbr.length).toBeGreaterThan(0);
    expect(scorers[0].value).toBeGreaterThan(0);
  });

  it('parses matches played from the display value', () => {
    expect(scorers.every((s) => s.matches === null || s.matches > 0)).toBe(true);
    expect(scorers.some((s) => s.matches !== null)).toBe(true);
  });

  it('caps the list at the requested limit', () => {
    expect(mapLeaders(raw, 'goalsLeaders', 5)).toHaveLength(5);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapLeaders({}, 'goalsLeaders')).toEqual([]);
    expect(mapLeaders(null, 'goalsLeaders')).toEqual([]);
  });

  // The whole point of the generalisation: assistsLeaders ships in the same
  // response as goalsLeaders and was being discarded.
  it('reads a category other than goals from the same payload', () => {
    const assists = mapLeaders(raw, 'assistsLeaders');
    expect(assists.length).toBeGreaterThan(0);
    expect(assists[0].rank).toBe(1);
    expect(assists[0].value).toBeGreaterThan(0);
    expect(assists[0].matches).toBeGreaterThan(0);
  });

  it('returns [] for a category the payload does not carry', () => {
    expect(mapLeaders(raw, 'cleanSheetsLeaders')).toEqual([]);
  });

  it('sets teamCrestUrl to null when the fixture team has no logo', () => {
    expect(scorers.every((s) => s.teamCrestUrl === null)).toBe(true);
  });

  it('maps teamCrestUrl from team.logo when present', () => {
    const payload = {
      stats: [{
        name: 'goalsLeaders',
        leaders: [{
          value: 3,
          displayValue: 'Matches: 2, Goals: 3',
          athlete: {
            displayName: 'Test Player',
            team: { abbreviation: 'TST', displayName: 'Test FC', logo: 'https://a.espncdn.com/test.png' },
          },
        }],
      }],
    };
    expect(mapLeaders(payload, 'goalsLeaders')[0].teamCrestUrl).toBe('https://a.espncdn.com/test.png');
  });

  it('maps teamCrestUrl from team.logos[0].href when team.logo is absent', () => {
    const payload = {
      stats: [{
        name: 'goalsLeaders',
        leaders: [{
          value: 2,
          displayValue: 'Matches: 1, Goals: 2',
          athlete: {
            displayName: 'Another Player',
            team: {
              abbreviation: 'ANO',
              displayName: 'Another FC',
              logos: [{ href: 'https://a.espncdn.com/logos/team.png' }],
            },
          },
        }],
      }],
    };
    expect(mapLeaders(payload, 'goalsLeaders')[0].teamCrestUrl).toBe('https://a.espncdn.com/logos/team.png');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-stats.test.ts`
Expected: FAIL — `mapLeaders` is not exported from `./espn-stats`.

If `it('reads a category other than goals...')` fails on the *recorded fixture*
rather than on the missing export, the fixture predates `assistsLeaders`. Re-record
it:
`curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/statistics" -o src/server/data/__fixtures__/espn-statistics.json`
Verified live 2026-08-15: that URL returns both `goalsLeaders` and
`assistsLeaders`, 50 rows each.

- [ ] **Step 3: Rename the type**

In `src/server/data/types.ts`, replace the `TopScorer` interface:

```ts
// One row of any player leaderboard. The metric lives in `value` rather than a
// named field so goals, assists and every board E7 adds share one type and one
// component. ESPN ships them all in the same shape, in the same response.
export interface StatLeader {
  rank: number;
  player: string;
  teamAbbr: string;
  teamName: string;
  teamCrestUrl: string | null;
  value: number;
  matches: number | null;
}
```

- [ ] **Step 4: Generalise the mapper**

Replace the whole contents of `src/server/data/providers/espn-stats.ts`:

```ts
import type { StatLeader } from '../types';

// Parse the matches-played count out of ESPN's leader displayValue,
// e.g. "Matches: 4, Goals: 6" -> 4. Every category uses the same grammar
// ("Matches: 3, Assists: 3"), so this is metric-agnostic.
function parseMatches(displayValue: string | undefined): number | null {
  if (!displayValue) return null;
  const m = /Matches:\s*(\d+)/i.exec(displayValue);
  return m ? Number(m[1]) : null;
}

/**
 * One leaderboard from ESPN's `statistics` feed, already sorted by the provider.
 *
 * `category` is an entry in `stats[].name` — `goalsLeaders`, `assistsLeaders`.
 * Both arrive in the SAME response, which is why this takes a category instead
 * of hardcoding goals: the previous version fetched fifty assist rows on every
 * standings render and threw them away.
 *
 * Resilient: returns [] if the category or the shape is missing.
 */
export function mapLeaders(raw: unknown, category: string, limit = 20): StatLeader[] {
  try {
    const stats: any[] = (raw as any)?.stats ?? [];
    const board = stats.find((s: any) => s?.name === category);
    const leaders: any[] = board?.leaders ?? [];
    return leaders.slice(0, limit).map((l: any, i: number): StatLeader => {
      const athlete = l?.athlete ?? {};
      const team = athlete.team ?? {};
      return {
        rank: i + 1,
        player: athlete.displayName ?? '',
        teamAbbr: team.abbreviation ?? '',
        teamName: team.displayName ?? '',
        teamCrestUrl: team.logo ?? team.logos?.[0]?.href ?? null,
        value: Number(l?.value ?? 0),
        matches: parseMatches(l?.displayValue),
      };
    });
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run the mapper suite**

Run: `npx vitest run src/server/data/providers/espn-stats.test.ts`
Expected: PASS, all cases.

`npx tsc --noEmit` will still fail across the app — the consumers are renamed in
Task 2. That is expected; do not chase it here.

- [ ] **Step 6: Commit**

```bash
git add src/server/data/types.ts src/server/data/providers/espn-stats.ts src/server/data/providers/espn-stats.test.ts
git commit -m "refactor: generalise the leaders mapper to any stat category

assistsLeaders ships in the same /statistics response as goalsLeaders,
50 rows each, and mapTopScorers discarded it. Generalising now costs one
rename; generalising after a second board is copy-pasted costs a
duplicate component.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: One fetch, two boards, through the store

**Files:**
- Modify: `src/server/data/store.ts` (lines 1, 11, 27, 230-239)
- Create: `src/app/api/[comp]/[season]/top-assists/route.ts`
- Test: `src/server/data/store.test.ts`

**Interfaces:**
- `getLeaders(rc: CompetitionSeason, ttlMs?: number): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }>` — fetches `/statistics` **once**, maps both categories, caches the pair under one key.
- `getTopScorers(rc)` and `getTopAssists(rc)` keep returning `StatLeader[]` and both read `getLeaders`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/store.test.ts`, inside the top-level `describe`:

```ts
  // Both boards live in one response. Fetching it twice to render two tables
  // would double our request volume against a keyless public API for data we
  // already hold.
  it('fetches /statistics once to serve both leaderboards', async () => {
    const calls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => {
        calls.push(url);
        return {
          stats: [
            { name: 'goalsLeaders', leaders: [{ value: 5, displayValue: 'Matches: 3, Goals: 5', athlete: { displayName: 'Striker', team: { abbreviation: 'AAA', displayName: 'A FC' } } }] },
            { name: 'assistsLeaders', leaders: [{ value: 3, displayValue: 'Matches: 3, Assists: 3', athlete: { displayName: 'Playmaker', team: { abbreviation: 'BBB', displayName: 'B FC' } } }] },
          ],
        };
      },
    });

    const scorers = await store.getTopScorers(RC);
    const assists = await store.getTopAssists(RC);

    expect(calls.filter((u) => u.includes('/statistics'))).toHaveLength(1);
    expect(scorers[0].player).toBe('Striker');
    expect(scorers[0].value).toBe(5);
    expect(assists[0].player).toBe('Playmaker');
    expect(assists[0].value).toBe(3);
  });
```

If `store.test.ts` does not already define `RC` and a `MemoryCache` test double,
reuse whatever names the existing tests in that file use for the resolved
competition-season and the cache — match the file, do not introduce a second
convention.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/store.test.ts -t "both leaderboards"`
Expected: FAIL — `store.getTopAssists is not a function`.

- [ ] **Step 3: Implement in the store**

In `src/server/data/store.ts`:

Line 1 — change the type import `TopScorer` to `StatLeader`.
Line 11 — change `import { mapTopScorers } from './providers/espn-stats';` to
`import { mapLeaders } from './providers/espn-stats';`.

In the `DataStore` interface, replace line 27 with:

```ts
  getTopScorers(rc: CompetitionSeason): Promise<StatLeader[]>;
  getTopAssists(rc: CompetitionSeason): Promise<StatLeader[]>;
```

Replace the whole `getTopScorers` implementation (lines 230-239) with:

```ts
    // Both leaderboards arrive in ONE /statistics response. Fetch it once,
    // map both, cache the pair — rendering two tables must not mean two
    // requests for a payload we already hold.
    async getLeaders(rc, ttlMs = 60_000): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }> {
      const k = key(rc, 'leaders');
      const cached = deps.cache.get(k) as { scorers: StatLeader[]; assists: StatLeader[] } | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(statisticsUrl(slug(rc)));
      // Ten is the Golden Boot race; twenty is a list nobody scrolls. The
      // mapper keeps its wider default for any caller that wants the tail.
      const boards = {
        scorers: mapLeaders(raw, 'goalsLeaders', TOP_SCORERS_SHOWN),
        assists: mapLeaders(raw, 'assistsLeaders', TOP_SCORERS_SHOWN),
      };
      deps.cache.set(k, boards, ttlMs);
      return boards;
    },

    async getTopScorers(rc): Promise<StatLeader[]> {
      return (await this.getLeaders(rc)).scorers;
    },

    async getTopAssists(rc): Promise<StatLeader[]> {
      return (await this.getLeaders(rc)).assists;
    },
```

Add `getLeaders` to the `DataStore` interface beside the two getters:

```ts
  getLeaders(rc: CompetitionSeason): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }>;
```

Replace every other `TopScorer` in the file with `StatLeader`.

- [ ] **Step 4: Run the store suite**

Run: `npx vitest run src/server/data/store.test.ts`
Expected: PASS, including the new case asserting exactly one `/statistics` call.

- [ ] **Step 5: Add the API route**

Create `src/app/api/[comp]/[season]/top-assists/route.ts`:

```ts
import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return Response.json({ error: 'unknown competition or season' }, { status: 404 });
  try {
    const assists = await dataStore.getTopAssists(rc);
    return Response.json(assists, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
```

- [ ] **Step 6: Verify the route**

```bash
npm run dev
curl -s "http://localhost:3000/api/liga-mx/2026-27/top-assists" | head -c 400
```

Expected: a JSON array whose first element is Robert Morales (UNAM) with
`"value": 3`. Verified live 2026-08-15.

- [ ] **Step 7: Commit**

```bash
git add src/server/data/store.ts src/server/data/store.test.ts "src/app/api/[comp]/[season]/top-assists/route.ts"
git commit -m "feat: serve the assists leaderboard from the statistics fetch we already make

getLeaders fetches /statistics once and caches both boards, so adding the
assists table costs zero additional requests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `LeaderTable` — one component, two boards

**Files:**
- Rename: `src/components/TopScorersTable.tsx` → `src/components/LeaderTable.tsx`
- Modify: `src/components/StandingsLive.tsx`
- Modify: `src/app/c/[comp]/[season]/standings/page.tsx`, `src/app/c/[comp]/[season]/page.tsx`

**Interfaces:**
- `LeaderTable({ leaders, metric, teamStyle })` where
  `metric: { abbr: string; title: string }` — e.g. `{ abbr: 'G', title: 'Goals' }`.

- [ ] **Step 1: Create the component**

```bash
git mv src/components/TopScorersTable.tsx src/components/LeaderTable.tsx
```

Replace its whole contents:

```tsx
import type { StatLeader } from "@/server/data/types";
import TeamBadge from "./TeamBadge";

// One leaderboard, any metric. Goals and assists ship in the same shape from
// the same response, so they get the same table rather than two files that
// drift apart the first time a column changes.
export default function LeaderTable({
  leaders,
  metric,
  teamStyle = 'flag',
}: {
  leaders: StatLeader[];
  metric: { abbr: string; title: string };
  teamStyle?: 'flag' | 'crest';
}) {
  if (leaders.length === 0) {
    return <p className="empty-text">{metric.title} data is unavailable right now.</p>;
  }
  return (
    <div className="std-panel">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col">Player</th>
            <th className="team-col">Team</th>
            <th title="Matches played">MP</th>
            <th className="pts-col" title={metric.title}>
              {metric.abbr}
            </th>
          </tr>
        </thead>
        <tbody>
          {leaders.map((s) => (
            <tr key={`${s.rank}-${s.player}`} className={s.rank === 1 ? "row-qualify" : ""}>
              <td className="rank-cell">{s.rank}</td>
              <td className="team-cell">
                <span className="team-name">{s.player}</span>
              </td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge
                    team={{ id: s.teamAbbr, name: s.teamName, abbr: s.teamAbbr, crestUrl: s.teamCrestUrl }}
                    size={20}
                    style={teamStyle}
                  />
                  <span className="team-name std-muted">{s.teamAbbr}</span>
                </div>
              </td>
              <td>{s.matches ?? "–"}</td>
              <td className="pts-cell">{s.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Render both boards in `StandingsLive`**

In `src/components/StandingsLive.tsx`:

Replace the import line 7 `import TopScorersTable from './TopScorersTable';`
with `import LeaderTable from './LeaderTable';`, and change the type import on
line 4 from `TopScorer` to `StatLeader`.

Replace the props and state:

```tsx
  initialScorers: StatLeader[];
  initialAssists: StatLeader[];
```

```tsx
  const [scorers, setScorers] = useState<StatLeader[]>(initialScorers);
  const [assists, setAssists] = useState<StatLeader[]>(initialAssists);
```

Add `initialAssists` to the destructured parameter list beside `initialScorers`.

In the polling effect, replace the `Promise.all` body:

```tsx
        const [g, s, a] = await Promise.all([
          fetch(`${apiBase}/standings`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
          fetch(`${apiBase}/top-scorers`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
          fetch(`${apiBase}/top-assists`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!mounted) return;
        if (Array.isArray(g) && g.length) setGroups(g);
        if (Array.isArray(s)) setScorers(s);
        if (Array.isArray(a)) setAssists(a);
```

Both leaderboard routes read the same 60s-cached store entry, so this is three
HTTP calls to our own server but still **one** upstream `/statistics` fetch.

Replace the `topScorersBlock` definition:

```tsx
  const topScorersBlock = (
    <div className="std-block">
      <h2 className="std-block-title">Golden Boot · Top Scorers</h2>
      <LeaderTable leaders={scorers} metric={{ abbr: 'G', title: 'Goals' }} teamStyle={teamStyle} />
    </div>
  );

  const topAssistsBlock = (
    <div className="std-block">
      <h2 className="std-block-title">Playmakers · Top Assists</h2>
      <LeaderTable leaders={assists} metric={{ abbr: 'A', title: 'Assists' }} teamStyle={teamStyle} />
    </div>
  );
```

Finally, render the assists block. In the league branch at the bottom of the
component, replace:

```tsx
      {scorers.length > 0 ? topScorersBlock : null}
```

with:

```tsx
      {scorers.length > 0 ? topScorersBlock : null}
      {assists.length > 0 ? topAssistsBlock : null}
```

and in the `showThirdPlace` branch, add `{assists.length > 0 ? topAssistsBlock : null}`
immediately after `{standingsBlock}`.

Empty boards render nothing — a competition ESPN publishes no statistics for is a
real state, and an empty table is worse than no table.

- [ ] **Step 3: Feed the pages**

In both `src/app/c/[comp]/[season]/standings/page.tsx` and
`src/app/c/[comp]/[season]/page.tsx`:

- change the `TopScorer` type import to `StatLeader` and the local
  `let scorers: TopScorer[] = []` to `let scorers: StatLeader[] = []`;
- add `let assists: StatLeader[] = [];` beside it;
- replace the `dataStore.getTopScorers(rc)` call with a single store call that
  fills both, keeping each file's existing try/catch style:

```tsx
    const boards = await dataStore.getLeaders(rc);
    scorers = boards.scorers;
    assists = boards.assists;
```

- pass `initialAssists={assists}` to `<StandingsLive />` alongside `initialScorers`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output. Any remaining error naming `TopScorer` is a rename site
missed in Task 2 Step 3 or this step — fix it there, do not re-add the old type.

- [ ] **Step 5: Verify in the browser, including the request count**

```bash
npm run dev
```

Open `http://localhost:3000/c/liga-mx/2026-27/standings`.

Expected: a **Playmakers · Top Assists** block under the Golden Boot, ten rows,
Robert Morales (UNAM) top with 3.

Open DevTools → Network, filter `statistics`, and hard-reload.
Expected: **one** upstream `/statistics` request, not two. This is the constraint
the whole task exists to respect.

- [ ] **Step 6: Commit**

```bash
git add src/components/LeaderTable.tsx src/components/StandingsLive.tsx "src/app/c/[comp]/[season]/standings/page.tsx" "src/app/c/[comp]/[season]/page.tsx"
git commit -m "feat: render the top-assists leaderboard

TopScorersTable becomes LeaderTable, driven by a metric config, so goals
and assists share one component instead of two copies of the same markup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Per-match player box score

**Files:**
- Modify: `src/server/data/types.ts` (`LineupPlayer`, new `PlayerMatchStats`)
- Modify: `src/server/data/providers/espn-summary.ts:318-350` (`mapSummaryLineups`)
- Test: `src/server/data/providers/espn-summary.test.ts`

**Interfaces:**
- `PlayerMatchStats` — every field `number | null`:
  `appearances, subIns, totalGoals, goalAssists, totalShots, shotsOnTarget, offsides, foulsCommitted, foulsSuffered, yellowCards, redCards, ownGoals, saves, goalsConceded, shotsFaced`.
- `LineupPlayer` gains `starter: boolean` and `stats: PlayerMatchStats | null`.
- `mapSummaryLineups` keeps its signature but **stops filtering out substitutes**.

**Why nullable, and why by name.** Verified live 2026-08-15 on event 401863609:
goalkeeper Alec Smir carries `saves`, `goalsConceded` and `shotsFaced` but no
`offsides`; outfielder Jefferson Díaz carries `offsides` but no `saves`. Reading
by array index would silently mis-assign every value the moment a position
changes the set. A missing stat is `null` — "not applicable" — never `0`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/providers/espn-summary.test.ts`:

```ts
describe('mapSummaryLineups box score', () => {
  const lineups = mapSummaryLineups(ownGoalFixture, '17362', '226')!;

  it('includes substitutes, not only the starting eleven', () => {
    expect(lineups.home.players.length).toBeGreaterThan(11);
    expect(lineups.home.players.some((p) => p.starter === false)).toBe(true);
    expect(lineups.home.players.filter((p) => p.starter).length).toBe(11);
  });

  it('reads per-player stats by name', () => {
    const padelford = lineups.home.players.find((p) => p.name === 'Devin Padelford')!;
    expect(padelford.stats).not.toBeNull();
    expect(padelford.stats!.ownGoals).toBe(1);
    expect(padelford.stats!.appearances).toBe(1);
  });

  // Goalkeepers and outfielders carry different stat sets. A stat ESPN does
  // not send is null -- not applicable -- never zero.
  it('distinguishes a missing stat from a zero', () => {
    const keeper = lineups.home.players.find((p) => p.name === 'Alec Smir')!;
    expect(keeper.stats!.saves).toBe(3);
    expect(keeper.stats!.offsides).toBeNull();

    const outfielder = lineups.home.players.find((p) => p.name === 'Jefferson Díaz')!;
    expect(outfielder.stats!.offsides).toBe(0);
    expect(outfielder.stats!.saves).toBeNull();
  });
});
```

This reuses the `espn-summary-own-goal.json` fixture recorded in **E0 Task 3**. If
E0 has not landed on your branch, record it first with the command in that plan.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-summary.test.ts -t "box score"`
Expected: FAIL — `p.starter` and `p.stats` do not exist, and the roster is
filtered to 11 starters so the substitutes assertion fails.

- [ ] **Step 3: Add the types**

In `src/server/data/types.ts`, replace the `LineupPlayer` line:

```ts
// One player's line in a single match. Every field is nullable because ESPN's
// stat set varies by position -- goalkeepers carry saves and no offsides,
// outfielders the reverse -- so an absent stat means "not applicable to this
// player", which is a different fact from zero.
export interface PlayerMatchStats {
  appearances: number | null;
  subIns: number | null;
  totalGoals: number | null;
  goalAssists: number | null;
  totalShots: number | null;
  shotsOnTarget: number | null;
  offsides: number | null;
  foulsCommitted: number | null;
  foulsSuffered: number | null;
  yellowCards: number | null;
  redCards: number | null;
  ownGoals: number | null;
  saves: number | null;
  goalsConceded: number | null;
  shotsFaced: number | null;
}

export interface LineupPlayer {
  name: string;
  number: number | null;
  position: string;
  jersey: string | null;
  starter: boolean;
  stats: PlayerMatchStats | null;
}
```

- [ ] **Step 4: Read the stats array in the mapper**

In `src/server/data/providers/espn-summary.ts`, add the import of
`PlayerMatchStats` to the existing type import on line 1, then insert this helper
immediately above `mapSummaryLineups`:

```ts
// ESPN sends each player's match stats as a name/value array whose membership
// depends on position. Look up by name and default to null: an outfielder has
// no `saves` entry, and recording that as 0 would claim they faced shots and
// stopped none.
function statFor(entry: any, name: string): number | null {
  const found = (entry?.stats ?? []).find((s: any) => s?.name === name);
  if (!found) return null;
  const n = Number(found.value ?? found.displayValue);
  return Number.isFinite(n) ? n : null;
}

function toPlayerStats(entry: any): PlayerMatchStats | null {
  if (!Array.isArray(entry?.stats) || entry.stats.length === 0) return null;
  return {
    appearances: statFor(entry, 'appearances'),
    subIns: statFor(entry, 'subIns'),
    totalGoals: statFor(entry, 'totalGoals'),
    goalAssists: statFor(entry, 'goalAssists'),
    totalShots: statFor(entry, 'totalShots'),
    shotsOnTarget: statFor(entry, 'shotsOnTarget'),
    offsides: statFor(entry, 'offsides'),
    foulsCommitted: statFor(entry, 'foulsCommitted'),
    foulsSuffered: statFor(entry, 'foulsSuffered'),
    yellowCards: statFor(entry, 'yellowCards'),
    redCards: statFor(entry, 'redCards'),
    ownGoals: statFor(entry, 'ownGoals'),
    saves: statFor(entry, 'saves'),
    goalsConceded: statFor(entry, 'goalsConceded'),
    shotsFaced: statFor(entry, 'shotsFaced'),
  };
}
```

Then replace the `toTeamLineup` body inside `mapSummaryLineups`:

```ts
    const toTeamLineup = (entry: any): TeamLineup => {
      const formation: string = entry.formation ?? '';
      // Substitutes were dropped here. A box score that omits the player who
      // came on and scored is not a box score.
      const players: LineupPlayer[] = (entry.roster ?? []).map((p: any): LineupPlayer => ({
        name: p.athlete?.displayName ?? '',
        number: p.jersey ? Number(p.jersey) : null,
        position: p.position?.abbreviation ?? '',
        jersey: jerseyImage(p.athlete?.jerseyImages),
        starter: p.starter === true,
        stats: toPlayerStats(p),
      }));
      return { formation, players };
    };
```

And replace the emptiness guard, which counted starters:

```ts
    // Rosters can be present before lineups are published (no starters yet) —
    // treat that as "no lineup" so the UI doesn't render an empty XI.
    if (!home.players.some((p) => p.starter) || !away.players.some((p) => p.starter)) return null;
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

**Watch for a formation-view regression.** Any component rendering a starting XI
previously received starters only and now receives the whole squad. Grep for
consumers and filter at the render site:

```bash
grep -rn "lineups" src/components/
```

Every place that draws the XI must now use `.filter((p) => p.starter)`. Fix them
in this step, then re-run `npm test` and `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add src/server/data/types.ts src/server/data/providers/espn-summary.ts src/server/data/providers/espn-summary.test.ts src/components
git commit -m "feat: map per-player match stats and stop dropping substitutes

rosters[].roster[].stats carries goals, assists, shots, fouls and cards
for every player in every match; mapSummaryLineups walked past it and
kept only name, number and position.

Stats are looked up by name and default to null -- goalkeepers carry
saves and no offsides, outfielders the reverse, and a missing stat is
not a zero.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Render the box score

**Files:**
- Modify: `src/components/MatchExtras.tsx`
- Modify: `src/app/globals.css` (append)

Presentational — verified by running the app, per repo convention.

- [ ] **Step 1: Add the table**

In `src/components/MatchExtras.tsx`, add a box-score section rendered for each
team when at least one player has non-null `stats`. Columns, in order:
`#`, Player, Pos, `MIN`-less — use `G`, `A`, `SH`, `SOT`, `FC`, `FA`, and a card
chip. Add `SV` and `GA` **only** when the row is a goalkeeper (its `saves` is
non-null), so outfield rows do not carry two permanently blank columns.

Render `–` for a `null` stat and `0` for a real zero. That distinction is the
whole reason the type is nullable; collapsing it in the view throws the fix away.

Sort starters first, then substitutes, each by shirt number. Mark substitutes
with a subtle `sub` chip so the eleven still reads as the eleven.

Reuse the existing `standings-table std-wide` classes for the table itself and add
only what is genuinely new:

```css
/* Per-player match box score. Starters then substitutes; a dash means the
   provider sent no such stat for that position, which is not the same as a
   zero and must not render as one. */
.ls-box { margin-top: 12px; }
.ls-box-sub { color: var(--text-muted); font-size: 10px; margin-left: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
.ls-box td.ls-box-na { color: var(--text-muted); }
```

- [ ] **Step 2: Verify in the browser**

```bash
npm run dev
```

Open the Leagues Cup Minnesota United v Atlante match popup.

Expected:
- More than eleven rows per team, substitutes marked and sorted after starters.
- Devin Padelford's row shows an own goal.
- Alec Smir (GK) shows `SV 3` and a dash under offsides.
- Jefferson Díaz shows `0` under offsides and no saves column value.

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchExtras.tsx src/app/globals.css
git commit -m "feat: render the per-player match box score

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Recompute derived percentages from the raw counts

**Files:**
- Modify: `src/server/data/providers/espn-summary.ts` (`mapSummaryStats`)
- Test: `src/server/data/providers/espn-summary.test.ts`
- Modify: `src/components/MatchStats.tsx`

ESPN sends `shotAccuracy` pre-rounded to a whole number. We hold `shots` and
`shotsOnTarget`, so we can be more accurate than the field we are copying.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/providers/espn-summary.test.ts`:

```ts
describe('derived percentages', () => {
  // ESPN rounds shotAccuracy to a whole number. We hold both counts, so
  // echoing their rounding is choosing to be less accurate than our own data.
  it('computes shot accuracy from the raw counts rather than echoing the provider', () => {
    const payload = {
      boxscore: {
        teams: [
          { team: { id: '1' }, statistics: [
            { name: 'totalShots', displayValue: '11' },
            { name: 'shotsOnTarget', displayValue: '3' },
            { name: 'shotAccuracy', displayValue: '30' },
          ] },
          { team: { id: '2' }, statistics: [] },
        ],
      },
    };
    const stats = mapSummaryStats(payload, '1', '2');
    expect(stats!.home.shotAccuracy).toBeCloseTo(27.3, 1);
  });

  it('leaves accuracy null when there were no shots, rather than reporting 0%', () => {
    const payload = {
      boxscore: {
        teams: [
          { team: { id: '1' }, statistics: [
            { name: 'totalShots', displayValue: '0' },
            { name: 'shotsOnTarget', displayValue: '0' },
          ] },
          { team: { id: '2' }, statistics: [] },
        ],
      },
    };
    expect(mapSummaryStats(payload, '1', '2')!.home.shotAccuracy).toBeNull();
  });
});
```

Adjust the payload shape in Step 1 to match however `mapSummaryStats` actually
reads the boxscore in this repo — open the function first and mirror its access
path exactly. The two assertions are the contract; the fixture shape is not.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-summary.test.ts -t "derived percentages"`
Expected: FAIL — `shotAccuracy` comes back as `30`.

- [ ] **Step 3: Compute in the mapper**

In `mapSummaryStats`, after the raw stats are read, override the accuracy fields
where both operands are present:

```ts
// A percentage we can derive is more accurate than the one the provider
// rounded. Null when the denominator is zero: 0-of-0 is "no shots", not 0%.
const pct = (num: number | null, den: number | null): number | null =>
  num === null || den === null || den === 0 ? null : Math.round((num / den) * 1000) / 10;
```

Apply it to `shotAccuracy` from `shotsOnTarget / shots`. Leave `passAccuracy`,
`crossAccuracy` and `tackleAccuracy` as ESPN sends them **unless** the payload
carries both operands for them too — check before assuming, and do not invent a
denominator.

- [ ] **Step 4: Show the fraction**

In `src/components/MatchStats.tsx`, render the accuracy row as `27.3%` with
`3/11` beside it in `--text-muted`. The fraction is what makes the percentage
checkable.

- [ ] **Step 5: Run and verify**

Run: `npm test` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.

```bash
npm run dev
```

Find a finished match and confirm the accuracy row shows one decimal place and
the raw fraction.

- [ ] **Step 6: Commit**

```bash
git add src/server/data/providers/espn-summary.ts src/server/data/providers/espn-summary.test.ts src/components/MatchStats.tsx
git commit -m "fix: derive shot accuracy from raw counts instead of echoing rounding

ESPN sends 30 where the counts are 3-of-11 (27.3%). We hold both
operands. Shows the fraction beside the percentage so it is checkable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Full gate and PR

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

- [ ] **Step 2: Verify the no-new-requests constraint one final time**

```bash
npm run dev
```

DevTools → Network, filter `statistics`, hard-reload
`/c/liga-mx/2026-27/standings`.

Expected: **one** upstream `/statistics` request while two leaderboards render.
If there are two, `getTopScorers` and `getTopAssists` are not both going through
`getLeaders`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/assists-and-box-score
gh pr create --title "feat: assists leaderboard and per-match player box score" --body "$(cat <<'EOF'
## What

Renders player data ScoreArc already fetches and discards. **No new endpoints, no
new providers, and no additional upstream requests.**

- **Assists leaderboard.** `assistsLeaders` ships in the same `/statistics`
  response as `goalsLeaders` — 50 rows each, verified live 2026-08-15 — and
  `mapTopScorers` dropped it on every render.
- **Per-match box score.** `rosters[].roster[].stats` carries goals, assists,
  shots, fouls and cards per player; `mapSummaryLineups` walked past it and kept
  only name, number and position. It also dropped every substitute.
- **Derived percentages** are computed from the raw counts instead of echoing
  ESPN's rounding (30% → 27.3%, shown with `3/11` beside it).

## Approach

`TopScorer` → `StatLeader` and `TopScorersTable` → `LeaderTable` with a metric
config, so goals and assists are one component rather than two copies. The store's
new `getLeaders` fetches `/statistics` once and caches both boards, which a store
test asserts directly.

Player stats are looked up **by name** and default to `null`: goalkeepers carry
`saves` and no `offsides`, outfielders the reverse, so index-based reads would
mis-assign values and a `0` default would claim a keeper faced shots and saved
none.

## Testing

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- Store test asserts exactly one `/statistics` fetch serves both boards.
- Verified in the browser: Robert Morales tops the Liga MX assists on 3; the
  Minnesota–Atlante box score shows substitutes, Padelford's own goal, and a
  dash rather than a zero for a keeper's offsides.

Plan: `docs/superpowers/plans/2026-08-15-assists-and-box-score.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** "Half the statistics payload" → Tasks 1–3. "Every per-player
  match statistic" → Tasks 4–5. "Derived percentages get recomputed" → Task 6.
  The spec's five verification bullets are Task 7 Step 2 plus Tasks 3/5/6 browser steps.
- **Type consistency.** `StatLeader.value` is defined in Task 1 Step 3 and read in
  Task 3 Step 1. `PlayerMatchStats` is defined in Task 4 Step 3 and consumed in
  Task 5. `getLeaders` returns `{ scorers, assists }` in Task 2 and is destructured
  under those names in Task 3 Step 3.
- **Known ordering hazards, both called out inline.** Task 1 leaves the app
  un-typechecking until Task 2 finishes the rename. Task 4 changes what
  `mapSummaryLineups` returns, so any existing starting-XI view must add a
  `.filter(p => p.starter)` — Task 4 Step 5 greps for them.
- **Cross-epic dependency.** Task 4's test reuses the fixture recorded in E0
  Task 3, noted at the point of use.
