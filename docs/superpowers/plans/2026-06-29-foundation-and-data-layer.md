# Foundation & Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Next.js project and a tested data layer that serves normalized, live WC2026 data (matches + group standings) via REST and an SSE live stream.

**Architecture:** A single Next.js (App Router) + TypeScript app. A `src/server/data` module owns all contact with external feeds, maps them into our own provider-agnostic schema, caches with TTL, and is exposed through thin API routes plus an SSE endpoint. ESPN's keyless `fifa.world` scoreboard and standings endpoints are the verified primary source; football-data.org is a documented future cross-check (not in this plan).

**Tech Stack:** Next.js 14 (App Router), React 18, TypeScript, Vitest for tests, native `fetch`.

## Global Constraints

- Node 20+ (uses global `fetch`, `ReadableStream`, `TextEncoder`).
- TypeScript `strict: true`.
- No external HTTP in tests — all provider/mapper tests run against recorded JSON fixtures committed to the repo.
- Our schema is provider-agnostic: no ESPN-shaped object ever crosses out of `src/server/data/providers`.
- Path alias `@/*` → `src/*`.
- Data source (verified live 2026-06-29, keyless):
  - Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard`
  - Standings: `https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings`

---

### Task 1: Project scaffold, Vitest, recorded fixtures

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `src/server/data/__fixtures__/espn-scoreboard.json`, `src/server/data/__fixtures__/espn-standings.json`
- Test: `src/server/data/__fixtures__/fixtures.test.ts`

**Interfaces:**
- Produces: a runnable Next.js app, `npm test` wired to Vitest, and two committed fixture files used by every later task.

- [ ] **Step 1: Scaffold Next.js + TypeScript**

```bash
npx create-next-app@14 . --typescript --app --no-tailwind --eslint --src-dir --import-alias "@/*" --no-turbopack
```
Accept defaults. This creates `package.json`, `tsconfig.json`, `next.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`.

- [ ] **Step 2: Add Vitest**

```bash
npm install -D vitest
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
```

Add to `package.json` `"scripts"`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 3: Record the two fixtures**

```bash
mkdir -p src/server/data/__fixtures__
curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard" -o src/server/data/__fixtures__/espn-scoreboard.json
curl -s "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings" -o src/server/data/__fixtures__/espn-standings.json
```

- [ ] **Step 4: Write a fixture sanity test**

`src/server/data/__fixtures__/fixtures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import scoreboard from './espn-scoreboard.json';
import standings from './espn-standings.json';

describe('recorded fixtures', () => {
  it('scoreboard has events for fifa.world season 2026', () => {
    expect(scoreboard.leagues[0].slug).toBe('fifa.world');
    expect(scoreboard.leagues[0].season.year).toBe(2026);
    expect(Array.isArray(scoreboard.events)).toBe(true);
  });
  it('standings has 12 groups', () => {
    expect(standings.children).toHaveLength(12);
  });
});
```

Set `"resolveJsonModule": true` in `tsconfig.json` `compilerOptions` if not already present.

- [ ] **Step 5: Run the test — expect PASS**

Run: `npm test`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app, Vitest, and recorded ESPN fixtures"
```

---

### Task 2: Domain types + match-state mapper

**Files:**
- Create: `src/server/data/types.ts`, `src/server/data/state.ts`
- Test: `src/server/data/state.test.ts`

**Interfaces:**
- Produces:
  - Types `Team`, `MatchState`, `Match`, `Standing`, `Group` (shapes below).
  - `mapState(espnState: string, completed: boolean): MatchState`.

- [ ] **Step 1: Write the failing test**

`src/server/data/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapState } from './state';

describe('mapState', () => {
  it('maps pre -> scheduled', () => expect(mapState('pre', false)).toBe('scheduled'));
  it('maps in -> live', () => expect(mapState('in', false)).toBe('live'));
  it('maps post -> finished', () => expect(mapState('post', true)).toBe('finished'));
  it('treats completed as finished even if state lags', () => expect(mapState('in', true)).toBe('finished'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/state.test.ts`
Expected: FAIL — cannot find module `./state`.

- [ ] **Step 3: Write the types**

`src/server/data/types.ts`:

```ts
export type MatchState = 'scheduled' | 'live' | 'finished';

export interface Team {
  id: string;
  name: string;       // ESPN displayName, e.g. "Brazil"
  abbr: string;       // ESPN abbreviation, e.g. "BRA"
  crestUrl: string | null;
}

export interface Match {
  id: string;
  kickoff: string;          // ISO date string
  state: MatchState;
  minute: string | null;    // displayClock while live, else null
  statusDetail: string;     // e.g. "FT", "90'+11'"
  home: Team;
  away: Team;
  homeScore: number | null;
  awayScore: number | null;
  winnerId: string | null;
  note: string | null;      // e.g. "Paraguay advance 4-3 on penalties"
}

export interface Standing {
  team: Team;
  rank: number;             // 1-based order within the group
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  advanced: boolean;
}

export interface Group {
  id: string;               // "A".."L"
  name: string;             // "Group A"
  standings: Standing[];
}
```

- [ ] **Step 4: Write the mapper**

`src/server/data/state.ts`:

```ts
import type { MatchState } from './types';

export function mapState(espnState: string, completed: boolean): MatchState {
  if (completed) return 'finished';
  if (espnState === 'pre') return 'scheduled';
  if (espnState === 'post') return 'finished';
  return 'live';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/server/data/state.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/data/types.ts src/server/data/state.ts src/server/data/state.test.ts
git commit -m "feat: add data-layer domain types and match-state mapper"
```

---

### Task 3: ESPN scoreboard → Match[] mapper

**Files:**
- Create: `src/server/data/providers/espn-matches.ts`
- Test: `src/server/data/providers/espn-matches.test.ts`

**Interfaces:**
- Consumes: `mapState` (Task 2), types (Task 2), `espn-scoreboard.json` fixture (Task 1).
- Produces: `mapScoreboard(raw: unknown): Match[]`.

- [ ] **Step 1: Write the failing test**

`src/server/data/providers/espn-matches.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapScoreboard } from './espn-matches';
import raw from '../__fixtures__/espn-scoreboard.json';

describe('mapScoreboard', () => {
  const matches = mapScoreboard(raw);

  it('returns one match per event', () => {
    expect(matches.length).toBe((raw as any).events.length);
  });

  it('extracts home/away teams with crest urls', () => {
    const m = matches[0];
    expect(m.home.abbr).toMatch(/^[A-Z]{3}$/);
    expect(m.away.abbr).toMatch(/^[A-Z]{3}$/);
    expect(m.home.crestUrl).toContain('espncdn.com');
  });

  it('parses numeric scores', () => {
    const finished = matches.find((m) => m.state === 'finished');
    expect(finished).toBeDefined();
    expect(typeof finished!.homeScore).toBe('number');
  });

  it('captures penalty/advance note when present', () => {
    const withNote = matches.find((m) => m.note);
    if (withNote) expect(withNote.note).toMatch(/advance|penalties/i);
  });

  it('sets winnerId to a competing team id when there is a winner', () => {
    const decided = matches.find((m) => m.winnerId);
    if (decided) {
      expect([decided.home.id, decided.away.id]).toContain(decided.winnerId);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-matches.test.ts`
Expected: FAIL — cannot find module `./espn-matches`.

- [ ] **Step 3: Write the mapper**

`src/server/data/providers/espn-matches.ts`:

```ts
import type { Match, Team } from '../types';
import { mapState } from '../state';

function mapTeam(t: any): Team {
  return {
    id: String(t.id),
    name: t.displayName,
    abbr: t.abbreviation,
    crestUrl: t.logo ?? t.logos?.[0]?.href ?? null,
  };
}

export function mapScoreboard(raw: unknown): Match[] {
  const events: any[] = (raw as any)?.events ?? [];
  return events.map((ev) => {
    const comp = ev.competitions[0];
    const competitors: any[] = comp.competitors;
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    const status = ev.status;
    const state = mapState(status.type.state, status.type.completed);
    const note = comp.notes?.[0]?.text ?? null;
    const winnerId = home.winner
      ? String(home.team.id)
      : away.winner
      ? String(away.team.id)
      : null;
    return {
      id: String(ev.id),
      kickoff: ev.date,
      state,
      minute: state === 'live' ? status.displayClock : null,
      statusDetail: status.type.shortDetail,
      home: mapTeam(home.team),
      away: mapTeam(away.team),
      homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
      awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
      winnerId,
      note,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/providers/espn-matches.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/providers/espn-matches.ts src/server/data/providers/espn-matches.test.ts
git commit -m "feat: map ESPN scoreboard to normalized Match[]"
```

---

### Task 4: ESPN standings → Group[] mapper

**Files:**
- Create: `src/server/data/providers/espn-standings.ts`
- Test: `src/server/data/providers/espn-standings.test.ts`

**Interfaces:**
- Consumes: types (Task 2), `espn-standings.json` fixture (Task 1).
- Produces: `mapStandings(raw: unknown): Group[]`.

- [ ] **Step 1: Write the failing test**

`src/server/data/providers/espn-standings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapStandings } from './espn-standings';
import raw from '../__fixtures__/espn-standings.json';

describe('mapStandings', () => {
  const groups = mapStandings(raw);

  it('returns 12 groups A..L', () => {
    expect(groups).toHaveLength(12);
    expect(groups[0].id).toBe('A');
    expect(groups[0].name).toBe('Group A');
  });

  it('ranks 4 teams per group starting at 1', () => {
    expect(groups[0].standings).toHaveLength(4);
    expect(groups[0].standings[0].rank).toBe(1);
    expect(groups[0].standings[3].rank).toBe(4);
  });

  it('maps stat fields with correct names', () => {
    const s = groups[0].standings[0];
    expect(s.played).toBeGreaterThanOrEqual(0);
    expect(s.points).toBe(s.wins * 3 + s.draws);
    expect(s.goalDifference).toBe(s.goalsFor - s.goalsAgainst);
    expect(typeof s.advanced).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-standings.test.ts`
Expected: FAIL — cannot find module `./espn-standings`.

- [ ] **Step 3: Write the mapper**

`src/server/data/providers/espn-standings.ts`:

```ts
import type { Group, Standing } from '../types';

function statMap(stats: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of stats ?? []) out[st.name] = st.value;
  return out;
}

export function mapStandings(raw: unknown): Group[] {
  const children: any[] = (raw as any)?.children ?? [];
  return children.map((grp) => {
    const entries: any[] = grp.standings?.entries ?? [];
    const standings: Standing[] = entries.map((entry, i) => {
      const s = statMap(entry.stats);
      return {
        team: {
          id: String(entry.team.id),
          name: entry.team.displayName,
          abbr: entry.team.abbreviation,
          crestUrl: entry.team.logos?.[0]?.href ?? null,
        },
        rank: i + 1,
        played: s.gamesPlayed ?? 0,
        wins: s.wins ?? 0,
        draws: s.ties ?? 0,
        losses: s.losses ?? 0,
        goalsFor: s.pointsFor ?? 0,
        goalsAgainst: s.pointsAgainst ?? 0,
        goalDifference: s.pointDifferential ?? 0,
        points: s.points ?? 0,
        advanced: (s.advanced ?? 0) === 1,
      };
    });
    return { id: grp.name.replace('Group ', ''), name: grp.name, standings };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/providers/espn-standings.test.ts`
Expected: PASS.

> Note: the `points === wins*3 + draws` assertion documents the expected FIFA points rule and validates field mapping against the recorded fixture. If a future fixture includes deductions this can be relaxed, but for WC2026 group play it holds.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/providers/espn-standings.ts src/server/data/providers/espn-standings.test.ts
git commit -m "feat: map ESPN standings to normalized Group[]"
```

---

### Task 5: TTL cache

**Files:**
- Create: `src/server/data/cache.ts`
- Test: `src/server/data/cache.test.ts`

**Interfaces:**
- Produces: `class TtlCache<T>` with `get(key): T | undefined`, `set(key, value, ttlMs): void`, constructor taking an injectable `now: () => number`.

- [ ] **Step 1: Write the failing test**

`src/server/data/cache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TtlCache } from './cache';

describe('TtlCache', () => {
  it('returns a value before it expires', () => {
    let t = 0;
    const c = new TtlCache<number>(() => t);
    c.set('k', 42, 100);
    t = 50;
    expect(c.get('k')).toBe(42);
  });

  it('returns undefined after expiry', () => {
    let t = 0;
    const c = new TtlCache<number>(() => t);
    c.set('k', 42, 100);
    t = 150;
    expect(c.get('k')).toBeUndefined();
  });

  it('returns undefined for an unknown key', () => {
    const c = new TtlCache<number>(() => 0);
    expect(c.get('missing')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/cache.test.ts`
Expected: FAIL — cannot find module `./cache`.

- [ ] **Step 3: Write the cache**

`src/server/data/cache.ts`:

```ts
export class TtlCache<T> {
  private store = new Map<string, { value: T; expires: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/cache.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/cache.ts src/server/data/cache.test.ts
git commit -m "feat: add injectable-clock TTL cache"
```

---

### Task 6: Data service (fetch + map + cache)

**Files:**
- Create: `src/server/data/service.ts`
- Test: `src/server/data/service.test.ts`

**Interfaces:**
- Consumes: `mapScoreboard` (Task 3), `mapStandings` (Task 4), `TtlCache` (Task 5).
- Produces:
  - `createDataService(deps: { fetchJson: (url: string) => Promise<unknown>; cache: TtlCache<unknown> }): { getMatches(ttlMs?: number): Promise<Match[]>; getGroups(ttlMs?: number): Promise<Group[]> }`
  - `dataService` — default singleton using global `fetch`.
  - Constants `SCOREBOARD_URL`, `STANDINGS_URL`.

- [ ] **Step 1: Write the failing test**

`src/server/data/service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createDataService } from './service';
import { TtlCache } from './cache';
import scoreboard from './__fixtures__/espn-scoreboard.json';
import standings from './__fixtures__/espn-standings.json';

function svcWith(fetchJson: (url: string) => Promise<unknown>) {
  return createDataService({ fetchJson, cache: new TtlCache(() => 0) });
}

describe('createDataService', () => {
  it('getMatches maps the scoreboard', async () => {
    const svc = svcWith(async () => scoreboard);
    const matches = await svc.getMatches();
    expect(matches.length).toBe((scoreboard as any).events.length);
  });

  it('getGroups maps the standings', async () => {
    const svc = svcWith(async () => standings);
    const groups = await svc.getGroups();
    expect(groups).toHaveLength(12);
  });

  it('caches within TTL (one fetch for two calls)', async () => {
    const fetchJson = vi.fn(async () => scoreboard);
    const svc = createDataService({ fetchJson, cache: new TtlCache(() => 0) });
    await svc.getMatches();
    await svc.getMatches();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/service.test.ts`
Expected: FAIL — cannot find module `./service`.

- [ ] **Step 3: Write the service**

`src/server/data/service.ts`:

```ts
import type { Match, Group } from './types';
import { mapScoreboard } from './providers/espn-matches';
import { mapStandings } from './providers/espn-standings';
import { TtlCache } from './cache';

export const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
export const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';

export interface DataDeps {
  fetchJson: (url: string) => Promise<unknown>;
  cache: TtlCache<unknown>;
}

export function createDataService(deps: DataDeps) {
  return {
    async getMatches(ttlMs = 20_000): Promise<Match[]> {
      const cached = deps.cache.get('matches') as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(SCOREBOARD_URL);
      const matches = mapScoreboard(raw);
      deps.cache.set('matches', matches, ttlMs);
      return matches;
    },
    async getGroups(ttlMs = 60_000): Promise<Group[]> {
      const cached = deps.cache.get('groups') as Group[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(STANDINGS_URL);
      const groups = mapStandings(raw);
      deps.cache.set('groups', groups, ttlMs);
      return groups;
    },
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': 'wc2026-bracket' } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

export const dataService = createDataService({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/service.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/service.ts src/server/data/service.test.ts
git commit -m "feat: add cached data service over ESPN feeds"
```

---

### Task 7: REST API routes (`/api/groups`, `/api/matches`)

**Files:**
- Create: `src/app/api/groups/route.ts`, `src/app/api/matches/route.ts`
- Test: `src/app/api/routes.test.ts`

**Interfaces:**
- Consumes: `dataService` (Task 6).
- Produces: `GET` handlers returning `Response.json(...)` of `Group[]` and `Match[]`.

- [ ] **Step 1: Write the failing test**

`src/app/api/routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/data/service', () => ({
  dataService: {
    getGroups: vi.fn(async () => [{ id: 'A', name: 'Group A', standings: [] }]),
    getMatches: vi.fn(async () => [{ id: '1' }]),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('api routes', () => {
  it('GET /api/groups returns groups json', async () => {
    const { GET } = await import('./groups/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].id).toBe('A');
  });

  it('GET /api/matches returns matches json', async () => {
    const { GET } = await import('./matches/route');
    const res = await GET();
    const body = await res.json();
    expect(body[0].id).toBe('1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/routes.test.ts`
Expected: FAIL — cannot find module `./groups/route`.

- [ ] **Step 3: Write the route handlers**

`src/app/api/groups/route.ts`:

```ts
import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  const groups = await dataService.getGroups();
  return Response.json(groups);
}
```

`src/app/api/matches/route.ts`:

```ts
import { dataService } from '@/server/data/service';

export const revalidate = 0;

export async function GET() {
  const matches = await dataService.getMatches();
  return Response.json(matches);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/routes.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/groups/route.ts src/app/api/matches/route.ts src/app/api/routes.test.ts
git commit -m "feat: add /api/groups and /api/matches routes"
```

---

### Task 8: SSE live stream (`/api/live`)

**Files:**
- Create: `src/server/data/sse.ts`, `src/app/api/live/route.ts`
- Test: `src/server/data/sse.test.ts`

**Interfaces:**
- Consumes: `dataService` (Task 6).
- Produces:
  - `formatSse(event: string, data: unknown): string` — pure SSE frame formatter.
  - `GET` handler streaming `text/event-stream` that pushes matches every 15s.

- [ ] **Step 1: Write the failing test**

`src/server/data/sse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatSse } from './sse';

describe('formatSse', () => {
  it('formats an event with JSON data and a blank-line terminator', () => {
    const frame = formatSse('matches', [{ id: '1' }]);
    expect(frame).toBe('event: matches\ndata: [{"id":"1"}]\n\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/sse.test.ts`
Expected: FAIL — cannot find module `./sse`.

- [ ] **Step 3: Write the formatter**

`src/server/data/sse.ts`:

```ts
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the SSE route (uses the tested formatter)**

`src/app/api/live/route.ts`:

```ts
import { dataService } from '@/server/data/service';
import { formatSse } from '@/server/data/sse';

export const dynamic = 'force-dynamic';

const PUSH_INTERVAL_MS = 15_000;

export async function GET() {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          const matches = await dataService.getMatches();
          controller.enqueue(encoder.encode(formatSse('matches', matches)));
        } catch (err) {
          controller.enqueue(
            encoder.encode(formatSse('error', { message: String(err) })),
          );
        }
      };
      await push();
      timer = setInterval(push, PUSH_INTERVAL_MS);
    },
    cancel() {
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 6: Manually verify the stream end-to-end**

Run: `npm run dev`, then in another terminal:
```bash
curl -N http://localhost:3000/api/live
```
Expected: an immediate `event: matches` frame with JSON, then another every ~15s. Ctrl-C to stop.

> Note: Vercel serverless caps streaming response duration. If the deployed stream is cut short, the client (Plan 3) reconnects automatically via `EventSource`; revisit a hosted-with-longer-limits runtime only if reconnects prove disruptive. This is the SSE risk flagged in the spec.

- [ ] **Step 7: Commit**

```bash
git add src/server/data/sse.ts src/server/data/sse.test.ts src/app/api/live/route.ts
git commit -m "feat: add SSE live match stream at /api/live"
```

---

## Self-Review

**Spec coverage (data-layer portions):**
- Providers (ESPN adapters) → Tasks 3, 4. ✓
- Normalized provider-agnostic schema → Task 2. ✓
- Cache with TTL → Tasks 5, 6. ✓
- API routes serving normalized data → Task 7. ✓
- SSE live push → Task 8. ✓
- Data spike to confirm feeds → done during planning (endpoints verified live 2026-06-29; fixtures recorded in Task 1). ✓
- football-data fallback/cross-check → intentionally deferred; spec lists it as secondary, and ESPN proved sufficient and keyless for v1. Documented as future work below. ✓

**Deferred to later plans (not gaps):**
- Bracket structure assembly (R32→Final tree) → **Plan 2 (radial bracket UI)**, which also needs the knockout match graph; ESPN scoreboard `notes`/bracket endpoint to be probed at the start of Plan 2.
- Standings UI, radial bracket UI, Live Info strip, predict layer → **Plans 2 & 3**.
- Curated 48-team crest asset set → its own asset task in **Plan 2** (ESPN crest URLs from this layer are the baseline/fallback).
- football-data.org cross-check provider → **v2**.

**Placeholder scan:** No TBD/TODO/"handle errors appropriately" — every code step is complete. ✓

**Type consistency:** `Team`, `Match`, `Group`, `Standing` defined in Task 2 are used unchanged in Tasks 3–8. `createDataService`/`dataService`/`getMatches`/`getGroups` names are consistent across Tasks 6–8. `formatSse` consistent across Task 8. ✓
