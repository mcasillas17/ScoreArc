# Team Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every crest on ScoreArc lead to a team page — identity, season record, form, next fixture, a full squad statistics table and the club's schedule — using three keyless ESPN endpoints verified live on 2026-08-15.

**Architecture:** A new `espn-team.ts` provider maps three payloads behind the existing `DataStore` seam. The squad table is the centrepiece: `/teams/{id}/roster` returns all 35 players, 28 of them *with season statistics inline*, so a complete sortable stat table costs one request. `TeamBadge` becomes the single place a crest turns into a link.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-team-pages-design.md`
**Epic:** E4 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `feat/team-pages` off latest `origin/main`

**Payload claims re-verified 2026-08-19.** Three of this plan's assertions had
drifted and are corrected inline below: 28 of 35 athletes carry statistics (not
all 35), `nextEvent` is empty, and `mapScoreboard` cannot be reused for the
schedule. **Since this plan was written, #100/#101 added English/Spanish
support**, so every string the team page introduces needs both languages — the
tasks below predate i18n and do not mention it.

## Global Constraints

- TypeScript strict; `any` only inside mappers on raw payloads, per convention.
- All new fetches go through the `DataStore` seam — **no fetch call sites in components** (`AGENTS.md`).
- Every stat is `number | null`. A stat the provider omits renders as a dash, never a zero — same rule as E1.
- Reuse `TeamBadge`, `MatchDetailPopup`, and E2's `LiveMatchCard` if it has landed.
- `npx tsc --noEmit` clean and `npm test` green before a PR.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run build` while `npm run dev` is running.

---

## File Structure

- `src/server/data/endpoints.ts` — three URL builders (append).
- `src/server/data/providers/espn-team.ts` — `mapTeamProfile`, `mapTeamRoster`, `mapTeamSchedule`.
- `src/server/data/providers/espn-team.test.ts` — mapper tests against recorded fixtures.
- `src/server/data/__fixtures__/espn-team-profile.json`, `espn-team-roster.json`, `espn-team-schedule.json`
- `src/server/data/types.ts` — `TeamProfile`, `SquadPlayer`, `PlayerSeasonStats`.
- `src/server/data/store.ts` — `getTeam(rc, teamId)`.
- `src/app/api/[comp]/[season]/team/[teamId]/route.ts`
- `src/components/SquadTable.tsx`, `src/components/TeamHeader.tsx`
- `src/app/c/[comp]/[season]/team/[teamId]/page.tsx`
- `src/components/TeamBadge.tsx` — optional link.
- `src/app/globals.css` — `tm-*` classes (append).

---

### Task 1: Record the three fixtures

**Files:**
- Create: `src/server/data/__fixtures__/espn-team-profile.json`
- Create: `src/server/data/__fixtures__/espn-team-roster.json`
- Create: `src/server/data/__fixtures__/espn-team-schedule.json`

- [ ] **Step 1: Record**

```bash
BASE="https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227"
curl -s "$BASE"          -o src/server/data/__fixtures__/espn-team-profile.json
curl -s "$BASE/roster"   -o src/server/data/__fixtures__/espn-team-roster.json
curl -s "$BASE/schedule" -o src/server/data/__fixtures__/espn-team-schedule.json
```

- [ ] **Step 2: Verify each captured what the mappers need**

```bash
node -e "
const p = require('./src/server/data/__fixtures__/espn-team-profile.json').team;
console.log('profile:', p.displayName, p.abbreviation, '| color', p.color, '| record', p.record.items[0].summary);
const r = require('./src/server/data/__fixtures__/espn-team-roster.json');
console.log('roster athletes:', r.athletes.length);
const a = r.athletes.find(x => x.statistics);
console.log('sample:', a.displayName, a.position.abbreviation, '| categories:', a.statistics.splits.categories.map(c => c.name).join(','));
console.log('injuries populated anywhere:', r.athletes.some(x => (x.injuries || []).length > 0));
const s = require('./src/server/data/__fixtures__/espn-team-schedule.json');
console.log('schedule events:', s.events.length);
"
```

Expected: América / AME with a record summary; 35 roster athletes of which
**28 carry statistics**; categories `general,offensive,goalKeeping`;
**`injuries populated anywhere: false`**; a non-zero event count.

Also expect **`nextEvent` to be empty**. It was on 2026-08-19, while the
schedule endpoint carried four fixtures — so the next-fixture block reads the
schedule, never `nextEvent`.

That last line is the point of checking: the `injuries` array exists on every
athlete and is empty on all of them. The field being present is not the data
being present — do not build an injuries panel on it.

- [ ] **Step 3: Commit**

```bash
git add src/server/data/__fixtures__/espn-team-*.json
git commit -m "test: record team profile, roster and schedule fixtures

Liga MX América (227). The roster payload carries each player's full
season statistics inline -- a whole squad stat table for one request.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Endpoints and types

**Files:**
- Modify: `src/server/data/endpoints.ts`
- Modify: `src/server/data/types.ts`
- Test: `src/server/data/endpoints.test.ts`

**Interfaces:**
- `teamUrl(slug, teamId)`, `teamRosterUrl(slug, teamId)`, `teamScheduleUrl(slug, teamId)`
- `PlayerSeasonStats` — every field `number | null`.
- `SquadPlayer` — `{ id, name, jersey, position, age, nationality, headshotUrl, stats }`.
- `TeamProfile` — `{ team, location, record, standingSummary, color, altColor, squad, schedule }`.

- [ ] **Step 1: Write the failing endpoint test**

Append to `src/server/data/endpoints.test.ts`, following the assertion style
already used there:

```ts
describe('team endpoints', () => {
  it('builds the team profile, roster and schedule urls', () => {
    expect(teamUrl('mex.1', '227')).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227');
    expect(teamRosterUrl('mex.1', '227')).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227/roster');
    expect(teamScheduleUrl('mex.1', '227')).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227/schedule');
  });

  it('encodes a team id rather than interpolating it raw', () => {
    expect(teamUrl('mex.1', '../secret')).not.toContain('../');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/endpoints.test.ts`
Expected: FAIL — the three builders are not exported.

- [ ] **Step 3: Add the builders**

Append to `src/server/data/endpoints.ts`:

```ts
// A single club within one competition. Verified keyless and HTTP 200 on
// 2026-08-15 for mex.1/teams/227.
//
// Team ids reach these from a route parameter, so they are encoded rather than
// interpolated raw.
export const teamUrl = (slug: string, teamId: string) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}`;

// The whole squad WITH each player's season statistics inline -- one request
// for a complete squad stat table, not one per player.
export const teamRosterUrl = (slug: string, teamId: string) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}/roster`;

export const teamScheduleUrl = (slug: string, teamId: string) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}/schedule`;
```

- [ ] **Step 4: Add the types**

Append to `src/server/data/types.ts`:

```ts
// A player's season totals, as carried inline on the team roster payload under
// statistics.splits.categories[].stats[]. Nullable throughout for the same
// reason as PlayerMatchStats: a goalkeeper has no offsides entry and an
// outfielder no saves entry, and recording either as 0 asserts something the
// provider never said.
export interface PlayerSeasonStats {
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
  shotsFaced: number | null;
  goalsConceded: number | null;
}

export interface SquadPlayer {
  id: string;
  name: string;
  jersey: number | null;
  position: string;
  age: number | null;
  nationality: string | null;
  headshotUrl: string | null;
  stats: PlayerSeasonStats | null;
}

export interface TeamRecord {
  summary: string;          // e.g. "2-1-0"
  gamesPlayed: number | null;
  points: number | null;
  goalDifference: number | null;
}

export interface TeamProfile {
  team: Team;
  location: string | null;
  color: string | null;
  altColor: string | null;
  record: TeamRecord | null;
  standingSummary: string | null;
  squad: SquadPlayer[];
  schedule: Match[];
}
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run src/server/data/endpoints.test.ts` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/server/data/endpoints.ts src/server/data/endpoints.test.ts src/server/data/types.ts
git commit -m "feat: add team endpoint builders and team profile types

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The team mappers

**Files:**
- Create: `src/server/data/providers/espn-team.ts`
- Test: `src/server/data/providers/espn-team.test.ts`

**Interfaces:**
- `mapTeamProfile(raw): Omit<TeamProfile, 'squad' | 'schedule'> | null`
- `mapTeamRoster(raw): SquadPlayer[]`
- `mapTeamSchedule(raw): Match[]`

**Shape warning.** The roster nests stats as
`statistics.splits.categories[].stats[]` — a two-level structure — where the
match summary (E1) puts them in a **flat** `stats[]`. The category a stat lives
in varies by position. Flatten across all categories and look up by `name`; do
not index into a category by position.

- [ ] **Step 1: Write the failing test**

Create `src/server/data/providers/espn-team.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapTeamProfile, mapTeamRoster, mapTeamSchedule } from './espn-team';
import profileRaw from '../__fixtures__/espn-team-profile.json';
import rosterRaw from '../__fixtures__/espn-team-roster.json';
import scheduleRaw from '../__fixtures__/espn-team-schedule.json';

describe('mapTeamProfile', () => {
  const p = mapTeamProfile(profileRaw)!;

  it('maps identity and club colours', () => {
    expect(p.team.name).toBe('América');
    expect(p.team.abbr).toBe('AME');
    expect(p.color).toBeTruthy();
  });

  // Derive these from the recorded fixture rather than pasting the numbers
  // below: the record moves every matchday. On the 2026-08-19 capture it is
  // '3-1-0', 4 played, 10 points; on the 2026-08-15 capture it was '2-1-0',
  // 3 played, 7 points. Assert the shape and the arithmetic, not a scoreline.
  it('maps the season record', () => {
    expect(p.record!.summary).toMatch(/^\d+-\d+-\d+$/);
    expect(p.record!.gamesPlayed).toBeGreaterThan(0);
    expect(p.record!.points).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a malformed payload', () => {
    expect(mapTeamProfile({})).toBeNull();
    expect(mapTeamProfile(null)).toBeNull();
  });
});

describe('mapTeamRoster', () => {
  const squad = mapTeamRoster(rosterRaw);

  it('maps the whole squad', () => {
    expect(squad).toHaveLength(35);
    expect(squad.every((p) => p.id && p.name)).toBe(true);
  });

  // Seven of the 35 have no statistics block at all. They must still appear in
  // the squad -- with stats null, which is what the table renders as "has not
  // appeared" rather than as zeroes.
  it('keeps players who have no statistics block, with stats null', () => {
    const statless = squad.filter((p) => p.stats === null);
    expect(statless.length).toBeGreaterThan(0);
    expect(statless.every((p) => p.id && p.name)).toBe(true);
  });

  // The headline capability: season stats arrive inline, so a squad stat table
  // costs one request rather than 35.
  it('reads season stats inline from the roster payload', () => {
    const borja = squad.find((p) => p.name === 'Cristian Borja')!;
    expect(borja.stats!.appearances).toBe(3);
    expect(borja.stats!.totalGoals).toBe(1);
    expect(borja.stats!.totalShots).toBe(2);
    expect(borja.stats!.foulsSuffered).toBe(6);
  });

  // Stats are spread across general/offensive/goalKeeping categories and the
  // set differs by position, so lookup is by name across a flattened list.
  it('finds a stat regardless of which category it sits in', () => {
    const borja = squad.find((p) => p.name === 'Cristian Borja')!;
    expect(borja.stats!.yellowCards).toBe(0);   // general
    expect(borja.stats!.offsides).toBe(1);      // offensive
    expect(borja.stats!.goalsConceded).toBe(1); // goalKeeping
  });

  it('returns [] for a malformed payload', () => {
    expect(mapTeamRoster({})).toEqual([]);
    expect(mapTeamRoster(null)).toEqual([]);
  });
});

describe('mapTeamSchedule', () => {
  it('maps events to matches in kickoff order', () => {
    const s = mapTeamSchedule(scheduleRaw);
    expect(s.length).toBeGreaterThan(0);
    for (let i = 1; i < s.length; i++) {
      expect(new Date(s[i - 1].kickoff).getTime()).toBeLessThanOrEqual(new Date(s[i].kickoff).getTime());
    }
  });

  it('returns [] for a malformed payload', () => {
    expect(mapTeamSchedule({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-team.test.ts`
Expected: FAIL — cannot resolve `./espn-team`.

- [ ] **Step 3: Implement**

Create `src/server/data/providers/espn-team.ts`. The stat extractor:

```ts
// The roster nests stats two levels deep -- statistics.splits.categories[].stats[]
// -- and which category a stat lives in depends on the player's position. Flatten
// across every category and look up by name; indexing into a category would
// silently mis-assign the moment a position changes the shape.
function seasonStats(athlete: any): PlayerSeasonStats | null {
  const categories: any[] = athlete?.statistics?.splits?.categories ?? [];
  if (categories.length === 0) return null;
  const flat = new Map<string, number | null>();
  for (const c of categories) {
    for (const s of c?.stats ?? []) {
      const n = Number(s?.value ?? s?.displayValue);
      flat.set(s?.name, Number.isFinite(n) ? n : null);
    }
  }
  const get = (name: string) => (flat.has(name) ? flat.get(name)! : null);
  return {
    appearances: get('appearances'),
    subIns: get('subIns'),
    totalGoals: get('totalGoals'),
    goalAssists: get('goalAssists'),
    totalShots: get('totalShots'),
    shotsOnTarget: get('shotsOnTarget'),
    offsides: get('offsides'),
    foulsCommitted: get('foulsCommitted'),
    foulsSuffered: get('foulsSuffered'),
    yellowCards: get('yellowCards'),
    redCards: get('redCards'),
    ownGoals: get('ownGoals'),
    saves: get('saves'),
    shotsFaced: get('shotsFaced'),
    goalsConceded: get('goalsConceded'),
  };
}
```

Write `mapTeamProfile`, `mapTeamRoster` and `mapTeamSchedule` around it, each
wrapped in try/catch returning `null` / `[]` on a malformed payload, matching the
defensive style of the existing mappers in `providers/`.

For `mapTeamSchedule`: **checked on 2026-08-19, and `mapScoreboard` cannot be
reused as-is.** Two differences in the schedule payload break it:

- status lives on `competitions[0].status`, not on `ev.status`, which
  `mapScoreboard` dereferences unconditionally — it throws on this payload;
- `competitor.score` is a `$ref` stub pointing at the core API
  (`{"$ref": "http://sports.core.api.espn.pvt/..."}`), not a value, so
  `Number(score)` yields NaN rather than a goal count.

Write the accessors so both shapes work and extract the shared core, or give the
schedule its own mapper. Do not call `mapScoreboard` on this payload.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/data/providers/espn-team.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/providers/espn-team.ts src/server/data/providers/espn-team.test.ts
git commit -m "feat: map team profile, squad and schedule

Season stats arrive inline on the roster payload, spread across
general/offensive/goalKeeping categories whose membership varies by
position -- so lookup flattens across categories and matches by name.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Store and API route

**Files:**
- Modify: `src/server/data/store.ts`
- Create: `src/app/api/[comp]/[season]/team/[teamId]/route.ts`
- Test: `src/server/data/store.test.ts`

**Interfaces:**
- `getTeam(rc: CompetitionSeason, teamId: string, ttlMs?: number): Promise<TeamProfile | null>`
  — three fetches in parallel, one cache entry, `null` if the profile fetch fails.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/store.test.ts`:

```ts
describe('getTeam', () => {
  it('fetches profile, roster and schedule in parallel and caches the result', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => {
        urls.push(url);
        if (url.endsWith('/roster')) return rosterRaw;
        if (url.endsWith('/schedule')) return scheduleRaw;
        return profileRaw;
      },
    });

    const first = await store.getTeam(RC, '227');
    expect(first!.squad).toHaveLength(35);
    expect(urls).toHaveLength(3);

    await store.getTeam(RC, '227');
    expect(urls).toHaveLength(3); // served from cache
  });

  it('caches per team id, not per competition', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => { urls.push(url); return profileRaw; },
    });
    await store.getTeam(RC, '227');
    await store.getTeam(RC, '228');
    expect(urls.some((u) => u.includes('/228'))).toBe(true);
  });

  it('returns null when the profile fetch fails', async () => {
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async () => { throw new Error('502'); },
    });
    expect(await store.getTeam(RC, '227')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/store.test.ts -t "getTeam"`
Expected: FAIL — `store.getTeam is not a function`.

- [ ] **Step 3: Implement in the store**

Add `getTeam` to the `DataStore` interface and implement it beside `getStandings`:

```ts
    // A club within one competition. Three payloads, fetched in parallel and
    // cached as one: the page is useless without the profile, so a failed
    // profile fetch is null, while a failed roster or schedule degrades to an
    // empty block rather than losing the whole page.
    async getTeam(rc, teamId: string, ttlMs = 120_000): Promise<TeamProfile | null> {
      const k = key(rc, `team:${teamId}`);
      const cached = deps.cache.get(k) as TeamProfile | undefined;
      if (cached) return cached;

      const [rawProfile, rawRoster, rawSchedule] = await Promise.all([
        deps.fetchJson(teamUrl(slug(rc), teamId)),
        deps.fetchJson(teamRosterUrl(slug(rc), teamId)).catch(() => null),
        deps.fetchJson(teamScheduleUrl(slug(rc), teamId)).catch(() => null),
      ]);

      const base = mapTeamProfile(rawProfile);
      if (!base) return null;
      const profile: TeamProfile = {
        ...base,
        squad: rawRoster ? mapTeamRoster(rawRoster) : [],
        schedule: rawSchedule ? mapTeamSchedule(rawSchedule) : [],
      };
      deps.cache.set(k, profile, ttlMs);
      return profile;
    },
```

Wrap the whole body so a throwing profile fetch returns `null` rather than
propagating — the test above requires it.

- [ ] **Step 4: Add the API route**

Create `src/app/api/[comp]/[season]/team/[teamId]/route.ts`, modelled on the
existing `standings/route.ts`, returning 404 for an unknown competition **or** an
unknown team, and 502 on a provider failure.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/server/data/store.test.ts` — expected PASS.

```bash
npm run dev
curl -s "http://localhost:3000/api/liga-mx/2026-27/team/227" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['team']['name'], '| squad', len(d['squad']), '| record', d['record']['summary'])"
```

Expected: `América | squad 35 | record 2-1-0`.

- [ ] **Step 6: Commit**

```bash
git add src/server/data/store.ts src/server/data/store.test.ts "src/app/api/[comp]/[season]/team/[teamId]/route.ts"
git commit -m "feat: serve team profiles through the data store

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The team page

**Files:**
- Create: `src/components/TeamHeader.tsx`, `src/components/SquadTable.tsx`
- Create: `src/app/c/[comp]/[season]/team/[teamId]/page.tsx`
- Modify: `src/app/globals.css` (append)

Presentational — verified by running the app.

- [ ] **Step 1: Build the header**

`TeamHeader` renders crest, name, location, record summary and `standingSummary`.
Tint it with the club's own `color` / `altColor` by injecting CSS custom properties
on the header element, mirroring the per-competition accent injection already done
on `.app-shell` — reuse that pattern rather than inventing a second one.

Guard against a missing or unreadable club colour by falling back to the
competition accent. A black-on-black header is worse than a generic one.

- [ ] **Step 2: Build the squad table**

`SquadTable` renders one row per player: number, name, position, age, then
appearances, goals, assists, shots, shots on target, fouls, cards.

- Sortable by any stat column, defaulting to appearances descending.
- Show `SV` / `GA` columns **only** for goalkeeper rows, as E1's box score does.
- Render `–` for `null` and `0` for a real zero. This distinction is the reason
  the type is nullable; collapsing it in the view discards the fix.
- Player names link to `/c/[comp]/[season]/player/[id]` **only if E5 has landed**.
  If it has not, render plain text — a link to a 404 is worse than no link.

- [ ] **Step 3: Assemble the page**

Create `src/app/c/[comp]/[season]/team/[teamId]/page.tsx`, mirroring
`standings/page.tsx`. Call `notFound()` when `getTeam` returns `null`. Render, in
order: header, form + next fixture, squad table, fixtures & results.

For the fixtures block, reuse E2's `LiveMatchCard` if present; otherwise a simple
row. Do not write a second match card.

- [ ] **Step 4: Verify in the browser**

```bash
npm run dev
```

`http://localhost:3000/c/liga-mx/2026-27/team/227`:

- América, 35 players, record `2-1-0`, club colours in the header.
- Cristian Borja's row: 3 appearances, 1 goal, 2 shots, 6 fouls suffered.
- A goalkeeper row shows saves; Borja's saves column shows a value and an
  outfielder with no `saves` entry shows a dash — **not** a zero.
- Sorting by goals reorders the table.
- Schedule block lists the club's matches and each opens the match popup.

Check a team with no matches played yet on a not-yet-started competition — the
record and stat columns should read as dashes or zeros honestly, and the page must
not error.

- [ ] **Step 5: Commit**

```bash
git add src/components/TeamHeader.tsx src/components/SquadTable.tsx "src/app/c/[comp]/[season]/team/[teamId]/page.tsx" src/app/globals.css
git commit -m "feat: add the team page with squad statistics

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Make crests clickable

**Files:**
- Modify: `src/components/TeamBadge.tsx`
- Modify: call sites as needed
- Test: `src/components/TeamBadge.test.tsx`

- [ ] **Step 1: Survey the call sites before editing anything**

```bash
grep -rn "TeamBadge" src/
```

For each call site, decide whether it has the competition, season and a **real**
team id in scope. Write the list down before changing code — the goal is one
change in `TeamBadge`, not six scattered ones.

**The bracket is the case to get right.** `RadialBracket` and `BracketInteractive`
render placeholder teams for undecided slots (`placeholder: true`, no real id).
Those must stay unlinked. A link to `/team/undefined` is a 404 with a crest on it.

- [ ] **Step 2: Write the failing test**

Append to `src/components/TeamBadge.test.tsx`, matching the render/assert style
already used in that file:

```tsx
it('renders a link when a href is supplied', () => {
  // assert an anchor wraps the badge and points at the team page
});

it('renders no link when href is absent', () => {
  // assert there is no anchor -- placeholder bracket slots must not link
});
```

- [ ] **Step 3: Add the optional link**

Give `TeamBadge` an optional `href?: string`. When present it wraps the badge in a
`next/link`; when absent the markup is byte-identical to today. Optional, not
required, so every existing call site keeps working untouched and placeholders
stay inert by default.

- [ ] **Step 4: Thread the href from the call sites that have context**

Pass `href` from the standings tables, the leaderboards and the match popup. Leave
bracket placeholders alone.

- [ ] **Step 5: Verify**

Run: `npm test` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.

```bash
npm run dev
```

- Standings crests navigate to the right team page.
- Golden Boot / Assists team crests navigate.
- Match popup crests navigate.
- **Bracket placeholder slots do not navigate** and show no pointer cursor.

- [ ] **Step 6: Commit**

```bash
git add src/components/TeamBadge.tsx src/components/TeamBadge.test.tsx src/components
git commit -m "feat: link crests to team pages

TeamBadge takes an optional href, so placeholder bracket slots -- which
have no real team id -- stay inert by default rather than linking to a
404 with a crest on it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Full gate and PR

- [ ] **Step 1: Gate**

Kill the dev server first.

```bash
rm -rf .next
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: green, silent, clean, succeeds.

- [ ] **Step 2: Check the request count**

DevTools → Network on a team page.
Expected: **three** upstream ESPN requests for the whole page — profile, roster,
schedule. Not one per player.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/team-pages
gh pr create --title "feat: team pages" --body "$(cat <<'EOF'
## What

Every crest on ScoreArc was a dead end. This adds
`/c/[comp]/[season]/team/[teamId]` and makes badges link to it.

The page carries identity and club colours, season record and standing summary,
form and next fixture, **a full squad statistics table**, and the club's schedule.

## What the provider actually gives us

Verified live 2026-08-15, all keyless, all HTTP 200. The find that shaped the
design: `/teams/{id}/roster` returns all 35 players **with their season statistics
inline**, so a complete sortable squad stat table costs one request rather than 35.

Also noted and deliberately unused: every athlete carries an `injuries` array and
it is empty for all 35. The field existing is not the data existing, so there is
no injuries panel — an empty one would imply we checked and found none.

## Notes

- Stats nest as `statistics.splits.categories[].stats[]` and which category a stat
  falls in depends on position, so the mapper flattens across categories and looks
  up by name. Indexing into a category would mis-assign values silently.
- Every stat is nullable and renders as a dash. A goalkeeper has no offsides entry
  and an outfielder no saves entry; a `0` there asserts something ESPN never said.
- `TeamBadge`'s `href` is optional so bracket placeholder slots, which have no real
  team id, stay inert rather than linking to a 404.

## Testing

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- Mapper tests against three recorded fixtures, including a case asserting a stat
  is found regardless of which category it sits in.
- Store tests cover parallel fetch, caching per team id, and a null profile.
- Verified in the browser: three upstream requests per page, sorting works, and
  bracket placeholders do not link.

Plan: `docs/superpowers/plans/2026-08-15-team-pages.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** Page structure blocks 1–4 → Task 5. Reuse → Tasks 3 and 5.
  Linking → Task 6. The `injuries` non-decision is enforced by an assertion in
  Task 1 Step 2. All five spec verification bullets appear in Tasks 5–7.
- **Type consistency.** `PlayerSeasonStats`, `SquadPlayer`, `TeamRecord` and
  `TeamProfile` are defined in Task 2 Step 4 and consumed under those names in
  Tasks 3, 4 and 5. `getTeam` is declared in Task 4 and called in Task 5.
- **Cross-epic dependencies, both handled without blocking.** Task 5 links player
  names only if E5 has landed; the fixtures block uses E2's `LiveMatchCard` if
  present.
