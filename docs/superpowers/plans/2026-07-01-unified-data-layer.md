# Unified Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hardcoded-`fifa.world` data layer into a competition-parameterized, unified data-access layer driven by a competition registry and exposed through one `DataStore` seam — with no UI regression and zero new infrastructure.

**Architecture:** A `competitions.ts` registry describes each competition (ESPN slug, team style, sections, bracket order). URL builders in `endpoints.ts` take a slug. A `DataStore` interface in `store.ts` (implemented by `EspnReadThroughStore`, a competition-parameterized refactor of today's `service.ts`) is the only thing the app reads from; caches are scoped per competition. New `/api/[comp]/…` routes are added; existing routes keep working by delegating to the store with the `world-cup-2026` competition.

**Tech Stack:** Next.js 14 App Router, TypeScript (strict), Vitest. Data: keyless ESPN soccer endpoints. No new dependencies.

## Global Constraints

- No new runtime dependencies; $0 infrastructure (no KV/DB/cron in this sub-project).
- Mappers (`espn-matches`, `-standings`, `-bracket`, `-summary`, `-stats`, `-news`) are NOT modified — ESPN's JSON shape is competition-agnostic.
- `cache: 'no-store'` on all ESPN fetches; API responses keep `Cache-Control: no-store` + `export const dynamic = 'force-dynamic'`.
- Cache keys MUST be competition-scoped: `` `${comp.id}:<key>` ``.
- No UI/visual change; all 108 existing tests keep passing; existing routes keep returning World Cup data throughout.
- `providers/**` and `**/*.test.ts` keep the `@typescript-eslint/no-explicit-any` override (already in `.eslintrc.json`).

## File Structure

- **Create** `src/server/data/competitions.ts` — `Competition` types, `COMPETITIONS` registry (world-cup-2026 + leagues-cup), `getCompetition`, `listCompetitions`, and `OFFICIAL_R32_ORDER` (moved here from `RadialBracket.tsx`).
- **Create** `src/server/data/endpoints.ts` — slug-taking URL builders.
- **Create** `src/server/data/store.ts` — `DataStore` interface, `DataDeps`, `createDataStore(deps)`, `EspnReadThroughStore` logic (comp-parameterized refactor of `service.ts`), `dataStore` singleton, `parseShootout`, `defaultFetchJson`.
- **Modify** `src/components/RadialBracket.tsx` — import `OFFICIAL_R32_ORDER` from `competitions.ts` instead of defining it locally.
- **Create** `src/app/api/[comp]/{matches,bracket,standings,top-scorers,news}/route.ts` and `src/app/api/[comp]/match/[id]/route.ts` — competition-scoped routes.
- **Modify** existing routes `src/app/api/{matches,bracket,standings,top-scorers,news}/route.ts` and `src/app/api/match/[id]/route.ts` — delegate to `dataStore` with the `world-cup-2026` competition.
- **Modify** `src/app/page.tsx`, `src/app/standings/page.tsx`, `src/app/news/page.tsx` — call `dataStore.*(worldCup)`.
- **Delete** `src/server/data/service.ts` after `store.ts` replaces it (its last consumers move in Tasks 5–6).
- **Modify** `src/app/api/routes.test.ts` — mock `dataStore` instead of `dataService`.
- **Create** `src/server/data/__fixtures__/espn-leagues-cup-scoreboard.json` — recorded Leagues Cup fixture.

---

### Task 1: Competition registry

**Files:**
- Create: `src/server/data/competitions.ts`
- Test: `src/server/data/competitions.test.ts`
- Modify: `src/components/RadialBracket.tsx` (import `OFFICIAL_R32_ORDER` from the registry)

**Interfaces:**
- Produces: `Competition`, `CompetitionKind`, `TeamStyle`, `Section` types; `COMPETITIONS: Record<string, Competition>`; `getCompetition(id: string): Competition | undefined`; `listCompetitions(): Competition[]`; `OFFICIAL_R32_ORDER: [string, string][]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/data/competitions.test.ts
import { describe, it, expect } from 'vitest';
import { COMPETITIONS, getCompetition, listCompetitions, OFFICIAL_R32_ORDER } from './competitions';

describe('competition registry', () => {
  it('has world-cup-2026 and leagues-cup with correct ESPN slugs', () => {
    expect(COMPETITIONS['world-cup-2026'].espnSlug).toBe('fifa.world');
    expect(COMPETITIONS['leagues-cup'].espnSlug).toBe('concacaf.leagues.cup');
  });

  it('world cup uses flags + a bracket order; leagues cup uses crests + none', () => {
    const wc = COMPETITIONS['world-cup-2026'];
    const lc = COMPETITIONS['leagues-cup'];
    expect(wc.teamStyle).toBe('flag');
    expect(wc.bracketOrder).toHaveLength(16);
    expect(lc.teamStyle).toBe('crest');
    expect(lc.bracketOrder).toBeUndefined();
  });

  it('ids are unique and match their keys', () => {
    for (const [key, comp] of Object.entries(COMPETITIONS)) expect(comp.id).toBe(key);
  });

  it('getCompetition / listCompetitions work', () => {
    expect(getCompetition('leagues-cup')?.name).toBe('Leagues Cup');
    expect(getCompetition('nope')).toBeUndefined();
    expect(listCompetitions().length).toBe(Object.keys(COMPETITIONS).length);
  });

  it('OFFICIAL_R32_ORDER lists 16 team pairs', () => {
    expect(OFFICIAL_R32_ORDER).toHaveLength(16);
    expect(OFFICIAL_R32_ORDER[0]).toEqual(['RSA', 'CAN']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/competitions.test.ts`
Expected: FAIL — "Failed to resolve import './competitions'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/data/competitions.ts
export type CompetitionKind = 'national' | 'club';
export type TeamStyle = 'flag' | 'crest';
export type Section = 'bracket' | 'standings' | 'scores' | 'news';

export interface Competition {
  id: string;
  name: string;
  shortName: string;
  espnSlug: string;
  kind: CompetitionKind;
  teamStyle: TeamStyle;
  emblem: string;
  sections: Section[];
  format: { hasBracket: boolean; hasGroups: boolean; hasThirdPlaceRace: boolean };
  bracketDatesRange?: string;
  bracketOrder?: [string, string][];
}

// Fixed official WC2026 R32 leaf order (identity-based). Data, not UI — moved
// here from RadialBracket so the bracket builder can receive it per-competition.
export const OFFICIAL_R32_ORDER: [string, string][] = [
  ['RSA', 'CAN'], ['NED', 'MAR'], ['GER', 'PAR'], ['FRA', 'SWE'],
  ['ESP', 'AUT'], ['POR', 'CRO'], ['BEL', 'SEN'], ['USA', 'BIH'],
  ['BRA', 'JPN'], ['CIV', 'NOR'], ['MEX', 'ECU'], ['ENG', 'COD'],
  ['AUS', 'EGY'], ['ARG', 'CPV'], ['SUI', 'ALG'], ['COL', 'GHA'],
];

export const COMPETITIONS: Record<string, Competition> = {
  'world-cup-2026': {
    id: 'world-cup-2026',
    name: 'World Cup 2026',
    shortName: 'World Cup',
    espnSlug: 'fifa.world',
    kind: 'national',
    teamStyle: 'flag',
    emblem: '🌍',
    sections: ['bracket', 'standings', 'scores', 'news'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
    bracketDatesRange: '20260628-20260719',
    bracketOrder: OFFICIAL_R32_ORDER,
  },
  'leagues-cup': {
    id: 'leagues-cup',
    name: 'Leagues Cup',
    shortName: 'Leagues Cup',
    espnSlug: 'concacaf.leagues.cup',
    kind: 'club',
    teamStyle: 'crest',
    emblem: '🏆',
    sections: ['bracket', 'standings', 'scores', 'news'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
  },
};

export function getCompetition(id: string): Competition | undefined {
  return COMPETITIONS[id];
}

export function listCompetitions(): Competition[] {
  return Object.values(COMPETITIONS);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/competitions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Point RadialBracket at the registry's OFFICIAL_R32_ORDER**

In `src/components/RadialBracket.tsx`, delete the local `const OFFICIAL_R32_ORDER: [string, string][] = [ … ];` block and add to the imports at the top:

```ts
import { OFFICIAL_R32_ORDER } from '@/server/data/competitions';
```

- [ ] **Step 6: Verify no regression**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "Tests "`
Expected: tsc clean; `Tests  113 passed (113)` (108 existing + 5 new).

- [ ] **Step 7: Commit**

```bash
git add src/server/data/competitions.ts src/server/data/competitions.test.ts src/components/RadialBracket.tsx
git commit -m "feat(data): competition registry + move OFFICIAL_R32_ORDER out of the bracket"
```

---

### Task 2: Slug-parameterized endpoint builders

**Files:**
- Create: `src/server/data/endpoints.ts`
- Test: `src/server/data/endpoints.test.ts`

**Interfaces:**
- Produces: `scoreboardUrl(slug)`, `standingsUrl(slug)`, `summaryUrl(slug, event)`, `bracketUrl(slug, range?)`, `statisticsUrl(slug)`, `newsUrl(slug)` — all `(…) => string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/data/endpoints.test.ts
import { describe, it, expect } from 'vitest';
import { scoreboardUrl, standingsUrl, summaryUrl, bracketUrl, statisticsUrl, newsUrl } from './endpoints';

describe('endpoint builders', () => {
  it('build fifa.world URLs', () => {
    expect(scoreboardUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard');
    expect(standingsUrl('fifa.world')).toBe('https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings');
    expect(summaryUrl('fifa.world', '760490')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=760490');
    expect(bracketUrl('fifa.world', '20260628-20260719')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260719');
    expect(bracketUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard');
    expect(statisticsUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/statistics');
    expect(newsUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news');
  });

  it('build Leagues Cup URLs from a different slug', () => {
    expect(scoreboardUrl('concacaf.leagues.cup')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/scoreboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/endpoints.test.ts`
Expected: FAIL — cannot resolve `./endpoints`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/data/endpoints.ts
const site = (slug: string) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}`;

export const scoreboardUrl = (slug: string) => `${site(slug)}/scoreboard`;
export const standingsUrl = (slug: string) =>
  `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
export const summaryUrl = (slug: string, event: string) => `${site(slug)}/summary?event=${event}`;
export const bracketUrl = (slug: string, range?: string) =>
  `${site(slug)}/scoreboard${range ? `?dates=${range}` : ''}`;
export const statisticsUrl = (slug: string) => `${site(slug)}/statistics`;
export const newsUrl = (slug: string) => `${site(slug)}/news`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/endpoints.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/data/endpoints.ts src/server/data/endpoints.test.ts
git commit -m "feat(data): slug-parameterized ESPN endpoint builders"
```

---

### Task 3: DataStore seam + EspnReadThroughStore

**Files:**
- Create: `src/server/data/store.ts`
- Test: `src/server/data/store.test.ts`

**Interfaces:**
- Consumes: `Competition` (Task 1); endpoint builders (Task 2); all mappers (unchanged); `TtlCache` from `./cache`; domain types from `./types`.
- Produces: `DataStore` interface with methods `getMatches(comp)`, `getStandings(comp)`, `getBracket(comp)`, `getMatchSummary(comp, eventId, homeId, awayId)`, `getTopScorers(comp)`, `getNews(comp)`; `DataDeps` (`{ fetchJson: (url: string) => Promise<unknown>; cache: TtlCache<unknown> }`); `createDataStore(deps): DataStore`; `dataStore: DataStore` singleton.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/data/store.test.ts
import { describe, it, expect } from 'vitest';
import { createDataStore } from './store';
import { COMPETITIONS } from './competitions';
import { TtlCache } from './cache';
import sb from './__fixtures__/espn-scoreboard.json';

const wc = COMPETITIONS['world-cup-2026'];
const lc = COMPETITIONS['leagues-cup'];

function fakeDeps() {
  const urls: string[] = [];
  const deps = {
    fetchJson: async (url: string) => {
      urls.push(url);
      return sb; // any scoreboard-shaped payload; content not asserted here
    },
    cache: new TtlCache<unknown>(),
  };
  return { deps, urls };
}

describe('EspnReadThroughStore', () => {
  it('getMatches uses each competition’s ESPN slug', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(lc);
    expect(urls[0]).toContain('/soccer/concacaf.leagues.cup/scoreboard');
  });

  it('scopes cache keys per competition (no cross-contamination)', async () => {
    const { deps } = fakeDeps();
    const store = createDataStore(deps);
    await store.getMatches(wc);
    await store.getMatches(lc);
    expect(deps.cache.get('world-cup-2026:matches')).toBeDefined();
    expect(deps.cache.get('leagues-cup:matches')).toBeDefined();
  });

  it('getBracket applies the competition date range when present', async () => {
    const { deps, urls } = fakeDeps();
    const store = createDataStore(deps);
    await store.getBracket(wc);
    expect(urls.some((u) => u.includes('?dates=20260628-20260719'))).toBe(true);
    urls.length = 0;
    await store.getBracket(lc);
    expect(urls.some((u) => u.includes('concacaf.leagues.cup/scoreboard') && !u.includes('?dates'))).toBe(true);
  });
});
```

> Note: `getMatches` enriches via `getMatchSummary`, which will fetch summary URLs too; the test only asserts the *first* URL and the cache keys, so the fake returning a scoreboard payload for every call is fine (enrichment maps to empty and is swallowed by the per-match `.catch`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/data/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 3: Write the store**

Create `src/server/data/store.ts` as a competition-parameterized port of `service.ts`. Every method takes `comp: Competition` first, builds URLs from `comp.espnSlug` via `endpoints.ts`, and scopes cache keys as `` `${comp.id}:<key>` ``.

```ts
import type { Match, BracketRound, Shootout, MatchSummaryData, TopScorer, NewsArticle, Group } from './types';
import type { Competition } from './competitions';
import { COMPETITIONS } from './competitions';
import { scoreboardUrl, standingsUrl, summaryUrl, bracketUrl, statisticsUrl, newsUrl } from './endpoints';
import { mapScoreboard } from './providers/espn-matches';
import { mapNews } from './providers/espn-news';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { mapTopScorers } from './providers/espn-stats';
import {
  mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups,
  mapSummaryVideos, mapSummaryShootout, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H,
} from './providers/espn-summary';
import { TtlCache } from './cache';

export interface DataStore {
  getMatches(comp: Competition): Promise<Match[]>;
  getStandings(comp: Competition): Promise<Group[]>;
  getBracket(comp: Competition): Promise<BracketRound[]>;
  getMatchSummary(comp: Competition, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getTopScorers(comp: Competition): Promise<TopScorer[]>;
  getNews(comp: Competition): Promise<NewsArticle[]>;
}

export interface DataDeps {
  fetchJson: (url: string) => Promise<unknown>;
  cache: TtlCache<unknown>;
}

// Penalty shootout aggregate parsed from a match note, e.g.
// "Paraguay advance 4-3 on penalties".
function parseShootout(note: string | null, homeName: string, awayName: string): Shootout | null {
  if (!note) return null;
  const m = note.match(/(\d+)\s*[-–]\s*(\d+)\s+on penalties/i);
  if (!m) return null;
  const aNum = Number(m[1]);
  const bNum = Number(m[2]);
  const winnerScore = Math.max(aNum, bNum);
  const loserScore = Math.min(aNum, bNum);
  const noteLower = note.toLowerCase();
  if (noteLower.includes(homeName.toLowerCase())) return { homeScore: winnerScore, awayScore: loserScore };
  if (noteLower.includes(awayName.toLowerCase())) return { homeScore: loserScore, awayScore: winnerScore };
  return { homeScore: aNum, awayScore: bNum };
}

const EMPTY_SUMMARY: MatchSummaryData = {
  scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
  videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [],
};

export function createDataStore(deps: DataDeps): DataStore {
  const key = (comp: Competition, k: string) => `${comp.id}:${k}`;

  async function getMatchSummary(
    comp: Competition, eventId: string, homeId: string, awayId: string, ttlMs = 12_000,
  ): Promise<MatchSummaryData> {
    const k = key(comp, `summary:${eventId}`);
    const cached = deps.cache.get(k) as MatchSummaryData | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(summaryUrl(comp.espnSlug, eventId));
    const summary: MatchSummaryData = {
      scorers: mapSummaryScorers(raw),
      cards: mapSummaryCards(raw),
      stats: mapSummaryStats(raw, homeId, awayId),
      winProbability: mapWinProbability(raw, homeId, awayId),
      lineups: mapSummaryLineups(raw, homeId, awayId),
      videos: mapSummaryVideos(raw),
      shootoutDetail: mapSummaryShootout(raw, homeId, awayId),
      info: mapSummaryInfo(raw),
      form: mapSummaryForm(raw, homeId, awayId),
      commentary: mapSummaryCommentary(raw),
      h2h: mapSummaryH2H(raw),
    };
    deps.cache.set(k, summary, ttlMs);
    return summary;
  }

  return {
    getMatchSummary,

    async getMatches(comp, ttlMs = 10_000): Promise<Match[]> {
      const k = key(comp, 'matches');
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(scoreboardUrl(comp.espnSlug));
      const matches = mapScoreboard(raw);
      const summaries = await Promise.all(
        matches.map((m) => getMatchSummary(comp, m.id, m.home.id, m.away.id).catch(() => EMPTY_SUMMARY)),
      );
      matches.forEach((m, i) => {
        m.scorers = summaries[i].scorers;
        m.cards = summaries[i].cards;
        m.stats = summaries[i].stats;
        m.winProbability = summaries[i].winProbability;
        m.shootoutDetail = summaries[i].shootoutDetail;
      });
      for (const m of matches) m.shootout = parseShootout(m.note, m.home.name, m.away.name);
      deps.cache.set(k, matches, ttlMs);
      return matches;
    },

    async getStandings(comp, ttlMs = 60_000): Promise<Group[]> {
      const k = key(comp, 'groups');
      const cached = deps.cache.get(k) as Group[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(standingsUrl(comp.espnSlug));
      const groups = mapStandings(raw);
      deps.cache.set(k, groups, ttlMs);
      return groups;
    },

    async getBracket(comp, ttlMs = 8_000): Promise<BracketRound[]> {
      const k = key(comp, 'bracket');
      const cached = deps.cache.get(k) as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(bracketUrl(comp.espnSlug, comp.bracketDatesRange));
      const rounds = mapBracket(raw);
      deps.cache.set(k, rounds, ttlMs);
      return rounds;
    },

    async getTopScorers(comp, ttlMs = 60_000): Promise<TopScorer[]> {
      const k = key(comp, 'topscorers');
      const cached = deps.cache.get(k) as TopScorer[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(statisticsUrl(comp.espnSlug));
      const scorers = mapTopScorers(raw);
      deps.cache.set(k, scorers, ttlMs);
      return scorers;
    },

    async getNews(comp, ttlMs = 90_000): Promise<NewsArticle[]> {
      const k = key(comp, 'news');
      const cached = deps.cache.get(k) as NewsArticle[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(newsUrl(comp.espnSlug));
      const news = mapNews(raw);
      deps.cache.set(k, news, ttlMs);
      return news;
    },
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': 'scorearc' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

export const dataStore: DataStore = createDataStore({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});

// Convenience re-export so route/page code can resolve a competition + store together.
export { COMPETITIONS };
```

> The `getMatchSummary` signature on the returned object omits the optional `ttlMs` from the `DataStore` interface intentionally — callers use the 4-arg form; the extra optional param is implementation detail and still type-compatible.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/data/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/data/store.ts src/server/data/store.test.ts
git commit -m "feat(data): DataStore seam + competition-parameterized EspnReadThroughStore"
```

---

### Task 4: Leagues Cup fixture + mapping smoke test

**Files:**
- Create: `src/server/data/__fixtures__/espn-leagues-cup-scoreboard.json`
- Test: add a case to `src/server/data/store.test.ts`

**Interfaces:**
- Consumes: `createDataStore` (Task 3), `COMPETITIONS` (Task 1).

- [ ] **Step 1: Record the fixture**

Run:
```bash
curl -s --max-time 20 "https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/scoreboard" \
  -o src/server/data/__fixtures__/espn-leagues-cup-scoreboard.json
node -e "const d=require('./src/server/data/__fixtures__/espn-leagues-cup-scoreboard.json');console.log('events',d.events.length)"
```
Expected: prints `events <n>` (n ≥ 1). If the feed is empty (off-window), keep the recorded file anyway — the mapper test below tolerates 0 events but asserts shape.

- [ ] **Step 2: Write the failing test (append to `store.test.ts`)**

```ts
import lcFixture from './__fixtures__/espn-leagues-cup-scoreboard.json';

describe('Leagues Cup through the store', () => {
  it('maps club matches from the Leagues Cup fixture', async () => {
    const deps = { fetchJson: async () => lcFixture, cache: new TtlCache<unknown>() };
    const store = createDataStore(deps);
    const matches = await store.getMatches(COMPETITIONS['leagues-cup']);
    expect(Array.isArray(matches)).toBe(true);
    for (const m of matches) {
      expect(typeof m.home.abbr).toBe('string');
      expect(m.home.abbr.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails then passes**

Run: `npx vitest run src/server/data/store.test.ts`
Expected: initially FAIL if the fixture import path is wrong; after Step 1 recorded the file, PASS. (The assertion holds for any non-empty match set; empty set trivially passes the loop.)

- [ ] **Step 4: Commit**

```bash
git add src/server/data/__fixtures__/espn-leagues-cup-scoreboard.json src/server/data/store.test.ts
git commit -m "test(data): Leagues Cup scoreboard fixture + store mapping smoke test"
```

---

### Task 5: Competition-scoped API routes (+ keep legacy WC routes)

**Files:**
- Create: `src/app/api/[comp]/matches/route.ts`, `.../bracket/route.ts`, `.../standings/route.ts`, `.../top-scorers/route.ts`, `.../news/route.ts`, `src/app/api/[comp]/match/[id]/route.ts`
- Modify: `src/app/api/matches/route.ts`, `.../bracket/route.ts`, `.../groups/route.ts`, `.../top-scorers/route.ts`, `.../news/route.ts`, `.../match/[id]/route.ts`
- Modify: `src/app/api/routes.test.ts`

**Interfaces:**
- Consumes: `dataStore` + `getCompetition` (Tasks 1, 3).

- [ ] **Step 1: Write the failing test (rewrite `routes.test.ts` to the store)**

```ts
// src/app/api/routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataStore } from '@/server/data/store';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

describe('competition-scoped + legacy routes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('GET /api/[comp]/matches resolves the competition', async () => {
    const spy = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/matches/route');
    const res = await GET(new Request('http://x/api/leagues-cup/matches'), { params: { comp: 'leagues-cup' } });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'leagues-cup' }));
  });

  it('GET /api/[comp]/matches 404s an unknown competition', async () => {
    const { GET } = await import('./[comp]/matches/route');
    const res = await GET(new Request('http://x/api/nope/matches'), { params: { comp: 'nope' } });
    expect(res.status).toBe(404);
  });

  it('legacy GET /api/matches still returns World Cup data', async () => {
    const spy = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const { GET } = await import('./matches/route');
    await GET();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'world-cup-2026' }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/routes.test.ts`
Expected: FAIL — `./[comp]/matches/route` does not exist.

- [ ] **Step 3: Create the scoped route (matches) — repeat the pattern for the others**

```ts
// src/app/api/[comp]/matches/route.ts
import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { comp: string } }) {
  const comp = getCompetition(params.comp);
  if (!comp) return Response.json({ error: 'unknown competition' }, { status: 404 });
  try {
    const matches = await dataStore.getMatches(comp);
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
```

Create the sibling scoped routes identically, swapping the store call and (for `match/[id]`) reading query params:
- `bracket/route.ts` → `dataStore.getBracket(comp)`
- `standings/route.ts` → `dataStore.getStandings(comp)`
- `top-scorers/route.ts` → `dataStore.getTopScorers(comp)`
- `news/route.ts` → `dataStore.getNews(comp)`
- `match/[id]/route.ts`:

```ts
// src/app/api/[comp]/match/[id]/route.ts
import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { comp: string; id: string } }) {
  const comp = getCompetition(params.comp);
  if (!comp) return Response.json({ error: 'unknown competition' }, { status: 404 });
  try {
    const { searchParams } = new URL(req.url);
    const home = searchParams.get('home') ?? '';
    const away = searchParams.get('away') ?? '';
    const summary = await dataStore.getMatchSummary(comp, params.id, home, away);
    return Response.json(summary, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
```

- [ ] **Step 4: Point the legacy routes at the store (World Cup)**

For each existing route, replace `dataService.X()` with `dataStore.X(getCompetition('world-cup-2026')!)`. Example:

```ts
// src/app/api/matches/route.ts
import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WC = getCompetition('world-cup-2026')!;

export async function GET() {
  try {
    const matches = await dataStore.getMatches(WC);
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
```

Apply the same swap to `bracket`, `groups` (→ `getStandings`), `top-scorers`, `news`, and `match/[id]` (keep its `home`/`away` query parsing).

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/api/routes.test.ts && npm run build 2>&1 | tail -3`
Expected: routes tests PASS; `BUILD OK` with `/api/[comp]/matches`, `/api/[comp]/bracket`, etc. listed as routes.

- [ ] **Step 6: Commit**

```bash
git add src/app/api
git commit -m "feat(api): competition-scoped /api/[comp]/* routes; legacy routes delegate to the store (WC)"
```

---

### Task 6: Wire server components to the store; delete service.ts

**Files:**
- Modify: `src/app/page.tsx`, `src/app/standings/page.tsx`, `src/app/news/page.tsx`
- Delete: `src/server/data/service.ts`

**Interfaces:**
- Consumes: `dataStore`, `getCompetition` (Tasks 1, 3).

- [ ] **Step 1: Update the server components**

In each page, replace `dataService` calls with the store scoped to World Cup. Example for `src/app/page.tsx`:

```ts
import { dataStore } from '@/server/data/store';
import { getCompetition } from '@/server/data/competitions';
// ...
const WC = getCompetition('world-cup-2026')!;
// matches = await dataService.getMatches();  ->
matches = await dataStore.getMatches(WC);
// bracket = await dataService.getBracket();  ->
bracket = await dataStore.getBracket(WC);
```

`standings/page.tsx`: `dataStore.getStandings(WC)` (was `getGroups`) and `dataStore.getTopScorers(WC)`.
`news/page.tsx`: `dataStore.getNews(WC)`.

- [ ] **Step 2: Delete the obsolete service and verify nothing imports it**

Run:
```bash
git rm src/server/data/service.ts
grep -rn "data/service" src || echo "no references remain"
```
Expected: `no references remain`.

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npm run build 2>&1 | tail -2 && npm test 2>&1 | grep -E "Tests |Test Files "`
Expected: tsc clean; `BUILD OK`; all tests pass (existing 108 + registry 5 + endpoints 2 + store 4 = **119**), 0 failures.

- [ ] **Step 4: Manual smoke (no visual regression)**

Run: `npx next start -p 3200` (after build) and confirm the home page, `/standings`, and `/news` still render World Cup data exactly as before; and `curl -s localhost:3200/api/leagues-cup/matches | head -c 80` returns JSON (array or `{"error":...}` if the LC window is empty). Stop the server.

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx src/app/standings/page.tsx src/app/news/page.tsx
git commit -m "refactor: server components read from dataStore (WC); remove service.ts"
```

---

## Self-Review

**1. Spec coverage:**
- Competition registry → Task 1 ✅
- Parameterized endpoints/providers → Task 2 (URLs) + Task 3 (store threads `comp.espnSlug`) ✅
- `DataStore` seam + `EspnReadThroughStore` + per-competition cache keys → Task 3 ✅
- Competition-scoped API routes + legacy back-compat → Task 5 ✅
- Server components on the store → Task 6 ✅
- Leagues Cup fixture + mapping test; per-competition cache isolation test → Tasks 3, 4 ✅
- Non-goals (UI, storage infra, generic bracket, accounts) — none introduced ✅

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step has complete code. ✅

**3. Type consistency:** `DataStore` methods, `Competition` fields (`espnSlug`, `bracketDatesRange`, `bracketOrder`, `teamStyle`), cache-key helper `${comp.id}:<k>`, and the mapper names all match across Tasks 1→6. `getStandings` (store) replaces the old `getGroups` name everywhere it's consumed (Tasks 5, 6). ✅
