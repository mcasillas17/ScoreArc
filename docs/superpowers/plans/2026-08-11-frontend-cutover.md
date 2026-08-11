# Plan — Frontend Cutover (Slice 1d): read from our Reader API behind a flag

## Goal

Make the ScoreArc Next.js website read match/standings/bracket/summary/top-scorer/news
data from **our own merged Reader API** (`/v1/...`) instead of calling ESPN directly,
gated behind a server-only `DATA_SOURCE` flag. Default stays `espn` (today's behavior);
setting `DATA_SOURCE=api` routes every `DataStore` call to the reader, with an automatic
**per-call fallback to the ESPN store** if the reader errors during rollout.

This is a **frontend-only** change. No backend, no reader, no ingester, no schema, no
Terraform edits. We add one new file (`apiStore.ts` + its test) and change the final
store selection in `store.ts`. **Zero call-site changes** — every page and API route
already imports the `dataStore` singleton from `@/server/data/store`, so swapping what
that singleton points to cuts the whole app over at once.

## Architecture

- The data layer sits behind a `DataStore` interface (6 methods) in
  `src/server/data/store.ts`. Callers import the `dataStore` **singleton**; they never
  construct a store. That singleton is the switch point.
- Today `dataStore = createDataStore({ fetchJson, cache })` — the ESPN read-through store
  (fetches ESPN JSON, runs mappers, caches). We keep it as `espnStore`.
- New `createApiStore()` returns a `DataStore` whose 6 methods `fetch()` the reader's
  `/v1` endpoints and JSON-parse the response **directly** into the existing return types.
  The reader already emits exactly the `types.ts` shapes (verified against
  `backend/reader/openapi.yaml`), so there is **no mapping** — parse and return.
- `withFallback(primary, fallback)` wraps two `DataStore`s and, per method, tries
  `primary` and falls back to `fallback` on any thrown error.
- `selectDataStore()` reads `process.env.DATA_SOURCE`: `'api'` →
  `withFallback(createApiStore(), espnStore)`, anything else (incl. unset) → `espnStore`.

```
callers ──▶ dataStore (singleton in store.ts)
                       │
        DATA_SOURCE=api│ else (default 'espn')
             ┌─────────┴──────────┐
             ▼                    ▼
   withFallback(api, espn)    espnStore
        │        └──on error──▶ espnStore
        ▼
   createApiStore() ──fetch()──▶  https://<SCOREARC_API_BASE>/v1/...
```

## Tech Stack

- Next.js App Router (server components + `route.ts` handlers) — these run **server-side**,
  so `fetch()` and `process.env` reads are safe and never reach the browser.
- TypeScript strict (no `any`). Vitest for tests (`vitest run`).
- Node global `fetch` (Node 18+ / Next server runtime).

## Global Constraints

- **TypeScript strict, no `any`.** The reader returns typed shapes; cast the parsed JSON
  to the exact `types.ts` type via a typed `getJson<T>()` helper (a single generic type
  assertion on `res.json()`, not `any`).
- **`DATA_SOURCE` and `SCOREARC_API_BASE` are SERVER-ONLY.** Never prefix either with
  `NEXT_PUBLIC_`. Never import `apiStore.ts` or `store.ts` into a client component
  (`'use client'`). These env vars must never be passed as props to a client component or
  serialized into HTML. `apiStore.ts` reads `process.env.SCOREARC_API_BASE` only inside
  server-executed methods.
- **DRY / reuse the seam.** Do not add new fetch call sites in components. All data still
  flows through the single `dataStore` singleton.
- **`main` auto-deploys to production.** Do all work on a branch (`feat/...`). Do not
  commit to `main`, do not merge. Merging is the user's call.
- Every method must map to the correct `/v1` endpoint and deserialize into the correct
  type (see the mapping table in Task 1).

## Current state

- The Reader API is **already merged on `main`** (`backend/reader/`, live routes in
  `handlers.go`, contract in `openapi.yaml`). This plan does not touch it.
- `src/server/data/store.ts` defines the `DataStore` interface and exports the
  `dataStore` ESPN singleton at the bottom (`createDataStore({ fetchJson: defaultFetchJson,
  cache: new TtlCache() })`).
- `src/server/data/types.ts` holds the exact return types.
- `src/server/data/competitions.ts` defines `CompetitionSeason` (`{ competition, season }`);
  callers pass an `rc` where `rc.competition.id` (`'world-cup'`) and `rc.season.id`
  (`'2026'`) equal the reader's `{comp}`/`{season}` path params (verified: the reader's
  `competitions.json` is generated from this same config, keys match 1:1).
- Callers (`src/app/page.tsx`, `src/app/c/[comp]/[season]/**`, `src/app/api/**`) all import
  `{ dataStore }`. None construct a store. Changing the singleton cuts them all over.

### DataStore method → Reader endpoint → return type

| DataStore method | Reader endpoint (`{comp}`=`rc.competition.id`, `{season}`=`rc.season.id`) | Returns |
|---|---|---|
| `getMatches(rc)` | `GET /v1/competitions/{comp}/{season}/matches` | `Match[]` |
| `getStandings(rc)` | `GET /v1/competitions/{comp}/{season}/standings` | `Group[]` |
| `getBracket(rc)` | `GET /v1/competitions/{comp}/{season}/bracket` | `BracketRound[]` |
| `getTopScorers(rc)` | `GET /v1/competitions/{comp}/{season}/top-scorers` | `TopScorer[]` |
| `getNews(rc)` | `GET /v1/competitions/{comp}/news` (**no season** — reader ignores it) | `NewsArticle[]` |
| `getMatchSummary(rc, eventId, homeId, awayId)` | `GET /v1/matches/{eventId}` (**homeId/awayId unused** — reader precomputed) | `MatchSummaryData` |

---

### Task 1 — Add `apiStore.ts` (reader-backed `DataStore` + fallback wrapper)

- [ ] Create `src/server/data/apiStore.ts` with the **complete** content below.

```ts
import type { DataStore } from './store';
import type { CompetitionSeason } from './competitions';
import type {
  Match,
  Group,
  BracketRound,
  MatchSummaryData,
  TopScorer,
  NewsArticle,
} from './types';

// Server-only reader origin. Read at call time (not module load) so tests and
// deploys can set it via env. NEVER expose this to the client: no NEXT_PUBLIC_
// prefix, and this module must never be imported by a 'use client' component.
function baseUrl(): string {
  const base = process.env.SCOREARC_API_BASE;
  if (!base) {
    throw new Error('SCOREARC_API_BASE is not set (required when DATA_SOURCE=api)');
  }
  return base.replace(/\/+$/, ''); // trim trailing slashes so path joins are clean
}

// GET the reader and parse the JSON body into the caller-declared type. The
// reader emits exactly the types.ts shapes (see backend/reader/openapi.yaml),
// so no mapping is needed. `cache: 'no-store'` — the reader owns caching via
// Cache-Control; the store must not double-cache stale live data.
async function getJson<T>(path: string): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`reader ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

// A DataStore backed by our own /v1 Reader API instead of ESPN. Same interface,
// same return types — callers can't tell the difference.
export function createApiStore(): DataStore {
  return {
    getMatches(rc: CompetitionSeason): Promise<Match[]> {
      return getJson<Match[]>(
        `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/matches`,
      );
    },

    getStandings(rc: CompetitionSeason): Promise<Group[]> {
      return getJson<Group[]>(
        `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/standings`,
      );
    },

    getBracket(rc: CompetitionSeason): Promise<BracketRound[]> {
      return getJson<BracketRound[]>(
        `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/bracket`,
      );
    },

    getTopScorers(rc: CompetitionSeason): Promise<TopScorer[]> {
      return getJson<TopScorer[]>(
        `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/top-scorers`,
      );
    },

    // The reader's news route is season-agnostic: /v1/competitions/{comp}/news.
    getNews(rc: CompetitionSeason): Promise<NewsArticle[]> {
      return getJson<NewsArticle[]>(`/v1/competitions/${enc(rc.competition.id)}/news`);
    },

    // The reader serves a fully-precomputed summary keyed only by match id;
    // homeId/awayId (needed by the ESPN mapper) are unused here but kept in the
    // signature to satisfy the DataStore interface.
    getMatchSummary(
      _rc: CompetitionSeason,
      eventId: string,
      _homeId: string,
      _awayId: string,
    ): Promise<MatchSummaryData> {
      return getJson<MatchSummaryData>(`/v1/matches/${enc(eventId)}`);
    },
  };
}

// Wrap a primary store so any thrown error transparently falls back to a
// secondary store, per call. Used during rollout: reader first, ESPN as a
// safety net. Fully typed — no `any`.
async function runWithFallback<R>(
  label: string,
  primary: () => Promise<R>,
  fallback: () => Promise<R>,
): Promise<R> {
  try {
    return await primary();
  } catch (err) {
    console.error(`[data] ${label} via reader failed; falling back to ESPN`, err);
    return fallback();
  }
}

export function withFallback(primary: DataStore, fallback: DataStore): DataStore {
  return {
    getMatches: (rc) =>
      runWithFallback('getMatches', () => primary.getMatches(rc), () => fallback.getMatches(rc)),
    getStandings: (rc) =>
      runWithFallback('getStandings', () => primary.getStandings(rc), () => fallback.getStandings(rc)),
    getBracket: (rc) =>
      runWithFallback('getBracket', () => primary.getBracket(rc), () => fallback.getBracket(rc)),
    getTopScorers: (rc) =>
      runWithFallback('getTopScorers', () => primary.getTopScorers(rc), () => fallback.getTopScorers(rc)),
    getNews: (rc) =>
      runWithFallback('getNews', () => primary.getNews(rc), () => fallback.getNews(rc)),
    getMatchSummary: (rc, eventId, homeId, awayId) =>
      runWithFallback(
        'getMatchSummary',
        () => primary.getMatchSummary(rc, eventId, homeId, awayId),
        () => fallback.getMatchSummary(rc, eventId, homeId, awayId),
      ),
  };
}
```

Notes for the agent:
- `import type { DataStore } from './store'` is **type-only** — it is erased at compile
  time, so even though `store.ts` will import values from this file, there is **no runtime
  circular import**.
- Do not add caching here. The ESPN store caches because it does expensive multi-fetch
  enrichment; the reader is a single cheap call and already sets `Cache-Control`.

- [ ] Verify it typechecks in isolation.

```bash
npx tsc --noEmit
```

expect: (no output; exit code 0)

- [ ] Commit.

```bash
git add src/server/data/apiStore.ts
git commit -m "feat(data): reader-backed apiStore + ESPN fallback wrapper

Co-Authored-By: Codex <noreply@openai.com>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 2 — Wire the `DATA_SOURCE` switch into the `dataStore` singleton

- [ ] Edit `src/server/data/store.ts`. Add the import near the other local imports at the
  top of the file (just after the `import { TtlCache } from './cache';` line):

```ts
import { createApiStore, withFallback } from './apiStore';
```

- [ ] Replace the **final export** at the bottom of `store.ts`. Find this exact block:

```ts
export const dataStore: DataStore = createDataStore({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});
```

and replace it with:

```ts
// The ESPN read-through store: the historical default and the rollout fallback.
const espnStore: DataStore = createDataStore({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});

// Pick the active store from the server-only DATA_SOURCE flag. 'api' routes every
// call to our Reader API (with a per-call ESPN fallback); anything else — including
// unset — keeps today's direct-ESPN behavior. Parameters are injected for testing;
// production calls it with no args. NOTE: DATA_SOURCE / SCOREARC_API_BASE are
// server-only env vars — never prefix with NEXT_PUBLIC_, never send to the client.
export function selectDataStore(
  source: string | undefined = process.env.DATA_SOURCE,
  makeApiStore: () => DataStore = createApiStore,
  fallback: DataStore = espnStore,
): DataStore {
  if (source === 'api') {
    return withFallback(makeApiStore(), fallback);
  }
  return fallback;
}

export const dataStore: DataStore = selectDataStore();
```

- [ ] Typecheck and run the full suite (the existing `store.test.ts` must stay green —
  `createDataStore` and `parseShootout` are unchanged).

```bash
npx tsc --noEmit && npm test
```

expect: `npx tsc --noEmit` prints nothing (exit 0); `npm test` ends with a passing summary,
e.g. `Test Files  N passed (N)` / `Tests  M passed (M)` and exit code 0.

- [ ] Commit.

```bash
git add src/server/data/store.ts
git commit -m "feat(data): select reader vs ESPN store via DATA_SOURCE flag

Co-Authored-By: Codex <noreply@openai.com>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 3 — Tests: `apiStore.test.ts` (deserialization + switch + fallback)

- [ ] Create `src/server/data/apiStore.test.ts` with the **complete** content below. It
  mocks the global `fetch` with reader-shaped JSON (grounded in `openapi.yaml`) and asserts
  each method hits the right URL and deserializes into the right type; then it tests
  `selectDataStore` and the `withFallback` path.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiStore, withFallback } from './apiStore';
import { selectDataStore } from './store';
import { resolveSeason } from './competitions';
import type { DataStore } from './store';
import type {
  Match,
  Group,
  BracketRound,
  TopScorer,
  NewsArticle,
  MatchSummaryData,
} from './types';

const wc = resolveSeason('world-cup')!; // competition.id 'world-cup', season.id '2026'

// ---- Reader-shaped sample payloads (match backend/reader/openapi.yaml) ----

const sampleMatch: Match = {
  id: '401',
  kickoff: '2026-06-11T16:00:00Z',
  state: 'finished',
  minute: null,
  statusDetail: 'FT',
  statusName: 'STATUS_FULL_TIME',
  home: { id: '1', name: 'Mexico', abbr: 'MEX', crestUrl: 'https://cdn/mex.png' },
  away: { id: '2', name: 'Canada', abbr: 'CAN', crestUrl: null },
  homeScore: 2,
  awayScore: 1,
  winnerId: '1',
  note: null,
  scorers: [{ teamId: '1', player: 'A. Vega', minute: "23'", penalty: false, shootout: false }],
  cards: [],
  shootout: null,
  shootoutDetail: null,
  stats: null,
  winProbability: null,
};

const sampleGroup: Group = {
  id: 'A',
  name: 'Group A',
  standings: [
    {
      team: { id: '1', name: 'Mexico', abbr: 'MEX', crestUrl: null },
      rank: 1,
      played: 1,
      wins: 1,
      draws: 0,
      losses: 0,
      goalsFor: 2,
      goalsAgainst: 1,
      goalDifference: 1,
      points: 3,
      advanced: true,
    },
  ],
};

const sampleRound: BracketRound = {
  slug: 'round-of-32',
  name: 'Round of 32',
  matches: [
    {
      id: '501',
      round: 'round-of-32',
      kickoff: '2026-06-28T16:00:00Z',
      home: { id: '1', name: 'Mexico', abbr: 'MEX', crestUrl: null, placeholder: false },
      away: { id: '0', name: 'TBD', abbr: 'TBD', crestUrl: null, placeholder: true },
      homeScore: null,
      awayScore: null,
      state: 'scheduled',
      statusDetail: '',
      statusName: 'STATUS_SCHEDULED',
      minute: null,
      winnerId: null,
      note: null,
    },
  ],
};

const sampleScorer: TopScorer = {
  rank: 1,
  player: 'Star Striker',
  teamAbbr: 'MEX',
  teamName: 'Mexico',
  teamCrestUrl: null,
  goals: 5,
  matches: 4,
};

const sampleNews: NewsArticle = {
  id: 'n1',
  headline: 'Matchday recap',
  description: 'What happened',
  published: '2026-06-11T00:00:00Z',
  image: null,
  url: 'https://espn/story',
  byline: 'ESPN',
};

const sampleSummary: MatchSummaryData = {
  scorers: [],
  cards: [],
  stats: null,
  winProbability: null,
  lineups: null,
  videos: [],
  shootoutDetail: null,
  info: null,
  form: null,
  commentary: [],
  h2h: [],
};

// Route a mocked fetch by URL path to the matching payload. Records URLs so the
// endpoint-mapping assertions can inspect them.
function mockReader() {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    let body: unknown;
    if (url.endsWith('/matches')) body = [sampleMatch];
    else if (url.endsWith('/standings')) body = [sampleGroup];
    else if (url.endsWith('/bracket')) body = [sampleRound];
    else if (url.endsWith('/top-scorers')) body = [sampleScorer];
    else if (url.endsWith('/news')) body = [sampleNews];
    else if (url.includes('/v1/matches/')) body = sampleSummary;
    else throw new Error(`unexpected url ${url}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, fetchMock };
}

describe('createApiStore — endpoint mapping + deserialization', () => {
  beforeEach(() => {
    vi.stubEnv('SCOREARC_API_BASE', 'https://reader.test');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('getMatches -> /v1/competitions/world-cup/2026/matches, parses Match[]', async () => {
    const { urls } = mockReader();
    const matches = await createApiStore().getMatches(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/matches');
    expect(matches).toEqual([sampleMatch]);
    expect(matches[0].home.abbr).toBe('MEX');
  });

  it('getStandings -> /standings, parses Group[]', async () => {
    const { urls } = mockReader();
    const groups = await createApiStore().getStandings(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/standings');
    expect(groups).toEqual([sampleGroup]);
    expect(groups[0].standings[0].points).toBe(3);
  });

  it('getBracket -> /bracket, parses BracketRound[]', async () => {
    const { urls } = mockReader();
    const rounds = await createApiStore().getBracket(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/bracket');
    expect(rounds).toEqual([sampleRound]);
    expect(rounds[0].matches[0].away.placeholder).toBe(true);
  });

  it('getTopScorers -> /top-scorers, parses TopScorer[]', async () => {
    const { urls } = mockReader();
    const scorers = await createApiStore().getTopScorers(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/top-scorers');
    expect(scorers).toEqual([sampleScorer]);
  });

  it('getNews -> season-agnostic /v1/competitions/world-cup/news, parses NewsArticle[]', async () => {
    const { urls } = mockReader();
    const news = await createApiStore().getNews(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/news');
    expect(news).toEqual([sampleNews]);
  });

  it('getMatchSummary -> /v1/matches/{id} (ignores home/away ids), parses MatchSummaryData', async () => {
    const { urls } = mockReader();
    const summary = await createApiStore().getMatchSummary(wc, '401', 'home-1', 'away-2');
    expect(urls[0]).toBe('https://reader.test/v1/matches/401');
    expect(summary).toEqual(sampleSummary);
  });

  it('throws when SCOREARC_API_BASE is unset', async () => {
    vi.stubEnv('SCOREARC_API_BASE', '');
    mockReader();
    await expect(createApiStore().getMatches(wc)).rejects.toThrow(/SCOREARC_API_BASE/);
  });

  it('throws on a non-2xx reader response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(createApiStore().getMatches(wc)).rejects.toThrow(/-> 500/);
  });
});

// A DataStore stub whose methods all resolve to a tagged sentinel, so tests can
// assert *which* store served a call.
function stubStore(tag: string): DataStore {
  const tagged = <T>(v: T) => Promise.resolve(v);
  return {
    getMatches: () => tagged([{ ...sampleMatch, note: tag }] as Match[]),
    getStandings: () => tagged([] as Group[]),
    getBracket: () => tagged([] as BracketRound[]),
    getTopScorers: () => tagged([] as TopScorer[]),
    getNews: () => tagged([] as NewsArticle[]),
    getMatchSummary: () => tagged(sampleSummary),
  };
}

describe('selectDataStore — DATA_SOURCE switch', () => {
  it("returns the fallback (ESPN) store when DATA_SOURCE is unset", async () => {
    const espn = stubStore('espn');
    const store = selectDataStore(undefined, () => stubStore('api'), espn);
    const matches = await store.getMatches(wc);
    expect(matches[0].note).toBe('espn');
  });

  it("returns the fallback store for any non-'api' value", async () => {
    const espn = stubStore('espn');
    const store = selectDataStore('espn', () => stubStore('api'), espn);
    const matches = await store.getMatches(wc);
    expect(matches[0].note).toBe('espn');
  });

  it("returns the api store (wrapped in fallback) when DATA_SOURCE=api", async () => {
    const store = selectDataStore('api', () => stubStore('api'), stubStore('espn'));
    const matches = await store.getMatches(wc);
    expect(matches[0].note).toBe('api'); // primary served it, no error
  });
});

describe('withFallback — per-call ESPN fallback on reader error', () => {
  it('falls back to ESPN when the primary method throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const primary: DataStore = {
      ...stubStore('api'),
      getMatches: () => Promise.reject(new Error('reader down')),
    };
    const store = withFallback(primary, stubStore('espn'));
    const matches = await store.getMatches(wc);
    expect(matches[0].note).toBe('espn');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('uses the primary result when it succeeds (no fallback)', async () => {
    const espnSpy = vi.fn(() => Promise.resolve([] as Group[]));
    const fallback: DataStore = { ...stubStore('espn'), getStandings: espnSpy };
    const store = withFallback(stubStore('api'), fallback);
    await store.getStandings(wc);
    expect(espnSpy).not.toHaveBeenCalled();
  });
});
```

Notes for the agent:
- `vi.stubEnv` / `vi.stubGlobal` are built into Vitest; `Response` is a Node global on the
  test runtime. If the runtime lacks `Response`, replace the mock body with
  `{ ok: true, status: 200, json: async () => body } as Response` (typed cast, no `any`).
- The switch/fallback tests inject stores directly into `selectDataStore` /`withFallback`,
  so they do **not** depend on `process.env.DATA_SOURCE` and don't need module resets.

- [ ] Run the new test file, then the whole suite + typecheck.

```bash
npx vitest run src/server/data/apiStore.test.ts
```

expect: `Test Files  1 passed (1)` and all its tests passing (exit 0).

```bash
npx tsc --noEmit && npm test
```

expect: `npx tsc --noEmit` silent (exit 0); `npm test` ends `Tests  M passed (M)` with the
new apiStore tests included, exit 0.

- [ ] Commit.

```bash
git add src/server/data/apiStore.test.ts
git commit -m "test(data): apiStore deserialization, DATA_SOURCE switch, ESPN fallback

Co-Authored-By: Codex <noreply@openai.com>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 4 — Document env vars + local cutover instructions (no code)

- [ ] Append the following section to `AGENTS.md`, under `## Architecture` (do not
  reformat the rest of the file). This documents the two **server-only** env vars.

````markdown
### Data source flag (frontend ⇄ reader)

The website reads data through the `dataStore` singleton (`src/server/data/store.ts`),
selected at server start by a **server-only** env var:

- `DATA_SOURCE` — `espn` (default, unset ⇒ espn) or `api`. `api` routes all data calls to
  our Reader API, with an automatic per-call fallback to the direct-ESPN store on error.
- `SCOREARC_API_BASE` — the reader origin (no trailing slash), e.g.
  `https://scorearc-reader.fly.dev`. Required only when `DATA_SOURCE=api`.

**These are server-only. Never prefix with `NEXT_PUBLIC_`, never pass them (or any secret)
to a client component.** In Vercel, add them as plain (non-`NEXT_PUBLIC_`) Environment
Variables for the target environment. Locally, put them in `.env.local`.

Cut over locally against a running reader:

```bash
# terminal 1: run the reader (see backend/reader)
# terminal 2:
DATA_SOURCE=api SCOREARC_API_BASE=http://localhost:8080 npm run dev
```

Open the app and confirm scores/standings/bracket/news load from the reader. Unset
`DATA_SOURCE` (or set `espn`) to revert instantly.
````

- [ ] Verify the doc mentions server-only and no `NEXT_PUBLIC_` (guard against a leak).

```bash
grep -n "NEXT_PUBLIC_" AGENTS.md
```

expect: a line stating the vars must **never** be prefixed with `NEXT_PUBLIC_` (the warning
above). There must be **no** occurrence of `NEXT_PUBLIC_DATA_SOURCE` or
`NEXT_PUBLIC_SCOREARC_API_BASE` anywhere in the repo:

```bash
grep -rn "NEXT_PUBLIC_DATA_SOURCE\|NEXT_PUBLIC_SCOREARC_API_BASE" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json"
```

expect: (no output; exit code 1)

- [ ] Commit.

```bash
git add AGENTS.md
git commit -m "docs: document DATA_SOURCE / SCOREARC_API_BASE server-only env vars

Co-Authored-By: Codex <noreply@openai.com>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

## Verification (run all before opening a PR)

- [ ] Typecheck clean:

```bash
npx tsc --noEmit
```

expect: (no output; exit 0)

- [ ] Full test suite green (existing + new):

```bash
npm test
```

expect: ends with a passing summary (`Test Files  N passed (N)` / `Tests  M passed (M)`),
exit 0. No failures, no unhandled rejections.

- [ ] Lint clean:

```bash
npm run lint
```

expect: `✔ No ESLint warnings or errors` (or equivalent clean output), exit 0.

- [ ] Default behavior unchanged — with `DATA_SOURCE` unset, the app still uses ESPN:

```bash
npm run dev
```

expect: dev server boots; the site loads exactly as before (still direct-ESPN). No reader
calls occur (nothing hits `SCOREARC_API_BASE`).

- [ ] Manual reader cutover (requires a locally-running reader on `:8080`):

```bash
DATA_SOURCE=api SCOREARC_API_BASE=http://localhost:8080 npm run dev
```

expect: the home page, standings, bracket, and news render from the reader. If the reader
is stopped mid-session, pages still render (per-call fallback to ESPN) and the server log
shows `[data] <method> via reader failed; falling back to ESPN`.

- [ ] Do **not** merge or push to `main`. Leave the branch for the user to review/merge.

---

## Self-review checklist

- **Each method → correct endpoint + type** (verify against `openapi.yaml` + `types.ts`):
  - `getMatches` → `/v1/competitions/{comp}/{season}/matches` → `Match[]` ✓
  - `getStandings` → `/v1/competitions/{comp}/{season}/standings` → `Group[]` ✓
  - `getBracket` → `/v1/competitions/{comp}/{season}/bracket` → `BracketRound[]` ✓
  - `getTopScorers` → `/v1/competitions/{comp}/{season}/top-scorers` → `TopScorer[]` ✓
  - `getNews` → `/v1/competitions/{comp}/news` (season ignored) → `NewsArticle[]` ✓
  - `getMatchSummary` → `/v1/matches/{eventId}` (home/away ids ignored) → `MatchSummaryData` ✓
- **`{comp}` = `rc.competition.id`, `{season}` = `rc.season.id`**, both `encodeURIComponent`'d;
  base URL from `process.env.SCOREARC_API_BASE` with trailing slashes trimmed. ✓
- **Fallback**: `withFallback` tries reader first, falls back to ESPN per call on any throw,
  logs the failure. Tested for both the throw→fallback and success→no-fallback paths. ✓
- **Switch**: `selectDataStore` returns ESPN for unset / any non-`'api'` value, reader
  (wrapped in fallback) for `'api'`. Default export `dataStore` unchanged for callers. ✓
- **No `NEXT_PUBLIC_` leak**: env vars are read only in server-executed code; docs forbid
  the prefix; a grep guard asserts the prefixed names never appear in the repo. `apiStore.ts`
  / `store.ts` are never imported by a `'use client'` component. ✓
- **No `any`**: `getJson<T>` uses a single generic assertion on `res.json()`; the fallback
  runner is generic `<R>`; test stubs are typed. Grep to confirm:

```bash
grep -n ": any\|<any>\|as any" src/server/data/apiStore.ts src/server/data/apiStore.test.ts
```

expect: (no output; exit code 1)
- **No new fetch call sites in components**; all data still flows through the single
  `dataStore` seam. Zero call-site edits. ✓
- **No backend changes**: `git diff --stat main` touches only `src/server/data/apiStore.ts`,
  `src/server/data/apiStore.test.ts`, `src/server/data/store.ts`, and `AGENTS.md`. ✓
