# Plan — Frontend Cutover (Slice 1d): read from our Reader API behind a flag

> **Reviewed and corrected 2026-08-12 against `origin/main`** (after PR #21 reader,
> #22 VISION.md, #23 internal ingester). The original draft claimed the reader emits
> *exactly* the `types.ts` shapes so "there is no mapping — parse and return." **The
> shapes match; the semantics do not.** See "Contract verification" below. Executing
> the original draft would have shipped a working-looking site with the wrong data.

## Goal

Make the ScoreArc Next.js website read match/standings/bracket/summary/top-scorer/news
data from **our own Reader API** (`/v1/...`) instead of calling ESPN directly, gated
behind a server-only `DATA_SOURCE` flag. Default stays `espn` (today's behavior).

This is the moment the frontend stops being shaped by ESPN's payload and starts being
shaped by **our** model (VISION.md §3, §8 "own the contract first"). After this slice,
`src/server/data/types.ts` — not ESPN's JSON — is the contract of record, and the reader
can start adding fields ESPN never gave us (our own xG, win probability, trends,
valuations) without a frontend release.

This is a **frontend-only** change. No backend, no reader, no ingester, no schema, no
Terraform edits. We add one new file (`apiStore.ts` + its test) and change the final
store selection in `store.ts`. **Zero call-site changes** — every page and API route
already imports the `dataStore` singleton from `@/server/data/store`, so swapping what
that singleton points to cuts the whole app over at once.

## Before you start

- [ ] This branch was cut from PR #21. **Rebase onto the latest `origin/main` first** —
  #22 (VISION.md) and #23 (internal ingester + `shared/model` + `shared/store`) have
  landed since, and #23 changed both `backend/reader/store.go` and
  `src/server/data/providers/espn-bracket.ts`.

```bash
git fetch origin --prune && git rebase origin/main
```

expect: `Successfully rebased and updated refs/heads/<branch>.`

- [ ] Read `VISION.md` §3 (the arc from reader → platform), §5 (target architecture),
  and §8 ("Never break the site to build the backend").

---

## Contract verification — the load-bearing check

The original draft's central claim was: *"The reader already emits exactly the `types.ts`
shapes, so there is **no mapping** — parse and return."* Verified field by field against
`origin/main`. **Verdict: the JSON shapes are correct; three semantic differences make
"parse and return" unsafe.**

### What is genuinely correct (do not re-litigate)

- **Every field name, casing, and nullability matches.** `backend/shared/model/types.go`
  carries the same JSON tags as the TS property names, and `backend/reader/types.go`
  mirrors `Match` / `MatchSummaryData`.
- **There is no `omitempty` anywhere** in `backend/shared/` or `backend/reader/`
  (`grep -rn omitempty backend/` → no matches), and every property in
  `backend/reader/openapi.yaml` is listed under `required:`. So there is **no
  `undefined`-vs-`null` ambiguity and no "0 vs missing" falsy-check hazard**: a Go
  `*int` that is nil serializes as `null`, never as an absent key, and a real `0`
  serializes as `0`. This is the strongest part of the original claim and it holds.
- **Arrays are never `null`.** `normalizeMatch` / `normalizeMatchSummary`
  (`backend/reader/types.go:70-127`) plus the seeded slices in
  `backend/reader/store.go:59,61,235-241` guarantee `[]`.
- **Enum values agree**: `scheduled|live|finished`
  (`backend/shared/model/types.go:22-24` ↔ `src/server/data/types.ts:1`).
- **Path params agree**: `{comp}` = `rc.competition.id`, `{season}` = `rc.season.id`;
  `backend/config/competitions.json` is generated from `src/server/data/competitions.ts`
  and the season keys match 1:1 (world-cup has `1998…2026`, leagues `2026-27`, etc.).

| Method | TS type | Go type | Verdict |
|---|---|---|---|
| `getMatches` | `Match[]` (`types.ts:78-97`) | `Match` (`reader/types.go:7-26`) | 18/18 fields identical. **Window differs — see (A).** |
| `getStandings` | `Group[]` (`types.ts:113-117`) | `Group` (`reader/types.go:42-46`) | Fields identical. **Group naming/order differs — see (C).** |
| `getBracket` | `BracketRound[]` (`types.ts:145-149`) | `BracketRound` (`reader/types.go:48-52`) | Fields identical. `placeholder` now comes from real DB columns (`reader/store.go:197-198`, added by #23), not the old crest heuristic. **Round set is a fixed allowlist — see (D).** |
| `getTopScorers` | `TopScorer[]` (`types.ts:161-169`) | `model.TopScorer` (`shared/model/types.go:114-122`) | Identical, incl. nullable `matches`. ✓ |
| `getNews` | `NewsArticle[]` (`types.ts:151-159`) | `espn.NewsArticle` (`shared/espn/news.go:11-19`) | Identical. **But it is a live ESPN proxy — see (E).** |
| `getMatchSummary` | `MatchSummaryData` (`types.ts:213-225`) | `MatchSummary` (`reader/types.go:56-68`) | 11/11 fields identical. **404 on missing detail — see (F).** |

### (A) `getMatches` returns a different set of matches — the critical defect

- ESPN store: `src/server/data/store.ts:107-109` fetches **only the current Monday→Sunday
  week** (`currentWeekRange`, `store.ts:35-44`).
- Reader: `backend/reader/store.go:39-50` selects **every match row for the season** —
  there is no date predicate. The ingester accumulates a rolling `now-30d … now+7d`
  window (`backend/shared/source/espn.go:102-110`, `rollingSeasonRange`) plus a
  full-season backfill.

Same type, wildly different content. Consumers that read `matches` in aggregate break:

- `src/app/page.tsx:54` — `count: matches.length` renders as `"{count} matches"` on every
  hub tile (`src/components/HubTiles.tsx:42,46`). A World Cup tile would read
  "104 matches" instead of this week's fixtures.
- `src/lib/hubStatus.ts:16` — `matches.length > 0 && matches.every(scheduled)` decides
  `upcoming` vs `ongoing`.
- `src/app/c/[comp]/[season]/page.tsx:58` — `const hasMatches = matches.length > 0`
  flips the league page's section order; the deliberate "off-season keeps the table on
  top" rule (`page.tsx:55-57`) would never fire again.
- `src/app/api/[comp]/[season]/matches/route.ts:11` is polled by the client
  (`UpcomingTicker`); the payload would grow from a handful of matches to a whole season
  of matches *with* scorers/cards/stats on every poll.

**Fix (Task 2):** `apiStore.getMatches` narrows to the same Monday→Sunday local week
using the already-tested `isThisWeek` helper (`src/components/upcomingWindow.ts:5-16`),
so the two stores are genuinely interchangeable. This is a *mapping step*, and the plan
now has one.

### (B) `kickoff` string format differs (benign, but know it)

- ESPN store passes ESPN's `date` through verbatim: `2026-08-04T23:30Z` — no seconds
  (`src/server/data/providers/espn-matches.ts:31`; see
  `src/server/data/__fixtures__/espn-leagues-cup-scoreboard.json`).
- Reader renders `time.RFC3339` in UTC: `2026-08-04T23:30:00Z`
  (`backend/reader/store.go:30`).

Every consumer parses with `new Date(...)` — `src/components/upcomingWindow.ts:6`,
`src/components/MatchStats.tsx:8`, `src/components/UpcomingTicker.tsx:22,29`,
`src/components/RadialBracket.tsx:139`. No code slices, compares, or `===`-matches a
kickoff string in production. **Safe.** Do not write a test that asserts string equality
of `kickoff` across the two stores — it will fail for a non-bug.

### (C) `Group.id` / `Group.name` and group ordering differ for ungrouped competitions

- ESPN store: `id: grp.name.replace('Group ', '')`, `name: grp.name` verbatim
  (`src/server/data/providers/espn-standings.ts:34`), preserving ESPN's `children` order.
- Reader: substitutes the competition short name when the stored group name is
  NULL/empty (`backend/reader/store.go:127-134`) and orders groups **alphabetically** by
  group name (`backend/reader/store.go:104`).

For World Cup groups A–L both agree (alphabetical == payload order). For a single-table
league the reader will render a `<h2 class="group-name">` of e.g. "Premier League"
(`src/components/GroupTable.tsx:22`) where ESPN may supply a different or empty heading.
Cosmetic, but it is a visible difference — verify it in the manual gate (Task 6).

### (D) Bracket rounds are a fixed allowlist on the reader

`backend/reader/store.go:147-158` hardcodes six slugs and **silently drops any round not
in that list**. The ESPN mapper builds from the payload with alias normalization for old
editions (`src/server/data/providers/espn-bracket.ts:4-33`, incl. the
`second-round → round-of-16` alias and the `EVENT_SLUG_OVERRIDE` for event `264118`).
The six slugs currently line up, so this is a **latent** divergence — record it, don't
fix it here (it is a backend concern).

### (E) News is still a live ESPN proxy — `DATA_SOURCE=api` does not "own" news

`backend/reader/handlers.go:140` → `backend/reader/news.go:93` fetches ESPN per request
(90s in-process TTL). So the news path moves the ESPN dependency behind our origin
rather than removing it, and it adds a **502** failure mode
(`backend/reader/handlers.go:143`). Note it in the exit criteria: news is the one
endpoint that does not satisfy VISION.md §3 "own the data" after this slice.

### (F) `getMatchSummary` 404s where the ESPN store would answer

`backend/reader/handlers.go:156-158` returns 404 when there is no `match_detail` row.
The ESPN store fetches ESPN live and answers. Under `withFallback` this becomes a silent
ESPN fallback — which is exactly the id-space hazard in the next section.

### (G) The reader can return `200 []` where the ESPN store returns real data

An unpopulated season — a historic edition the ingester does not cover
(`world-cup/2018`, `world-cup/2022`, …), a competition the ingester has not yet reached,
or a fresh database — yields `200` with an empty array. **This does not throw, so
`withFallback` never fires.** The site renders blank ("Bracket data is unavailable right
now.", empty tables) with no error anywhere. This is the failure mode most likely to
reach production, and the reason Task 6's parity gate is mandatory rather than advisory.

---

## The mixed-id-space hazard (read before touching `withFallback`)

There is a large, reviewed, not-yet-merged branch (`feat/canonical-identity-impl`) that
replaces provider ids with a **canonical identity layer**: team ids become curated slugs
(`eng-manchester-united`, `nat-mex`) and match ids become UUIDv7, with per-source
crosswalk tables. **Today** both stores share one id space — VISION.md §9 states ESPN
ids are reused as primary keys — so `withFallback` is safe *right now*. **After that
branch lands it is not**, and the failure is silent.

Concretely, with `withFallback(api, espn)` and canonical ids live:

1. `src/app/c/[comp]/[season]/page.tsx:39` renders `getMatches` from the reader →
   canonical team ids and canonical match ids in the HTML.
2. The client opens a match popup and fetches
   `${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`
   (`src/components/UpcomingTicker.tsx:174`, `src/components/RadialBracket.tsx:249,269`).
3. That hits `src/app/api/[comp]/[season]/match/[id]/route.ts:14`. If the reader errors
   or 404s for that one call, the fallback serves **ESPN's** summary — whose
   `scorer.teamId` / `card.teamId` are ESPN numeric ids.
4. `src/components/MatchDetailPopup.tsx:64-69` joins `s.teamId === home.id`. The join
   silently produces **zero** matches. Goals and cards vanish from the popup. No error,
   no log, nothing red — the popup just looks like a 0-0 with no bookings.

The same class of break exists for `matches.length`/id keys in
`src/components/BracketInteractive.tsx:69-79` (`decided.set(m.id, m)` across polls) and
for the shared-bracket links: `src/components/BracketInteractive.tsx:83-102,167` base64s
a `{slot: teamId}` map into `?b=…` on Twitter/X share URLs, decoded at `:146-156` and
compared to live team ids in `src/components/radialBracketModel.ts:145-148`. Existing
share links in the wild carry **ESPN** team ids; after canonical ids they decode fine
and match nothing — every pick silently disappears. That is a pre-existing consequence
of the identity branch, not of this plan, but this plan must not make it worse by
letting two id spaces coexist inside one render.

**Conclusion — the rule this plan adopts:** *two stores with different id spaces must
never sit behind one interface.* Therefore:

- `withFallback` is a **rollout aid with an expiry**, not an architecture. It is legal
  only while both stores serve the same id space.
- The flag gains a third value, **`api-only`** (no fallback), and the exit criterion
  below makes `api-only` the terminal state.
- The plan documents this as a hard dependency on `feat/canonical-identity-impl`: **that
  branch must not be merged while any environment runs `DATA_SOURCE=api`.** It is
  `espn` or `api-only` by then.
- No frontend code in this plan may parse, format, compare against a literal, or
  otherwise assume the *shape* of an id — ids stay opaque strings end to end.

### Fallback exit criteria (must be met before the flag is removed)

1. 7 consecutive days with `DATA_SOURCE=api` and **zero** `[data] source=espn-fallback`
   log lines in production.
2. The Task 6 parity gate passes for every competition × season the site can route to.
3. The reader's per-IP rate limit accommodates Vercel's shared egress (see Risks).
4. Then: flip to `api-only`, watch for 7 more days, then delete `withFallback`,
   `apiStore`'s fallback wiring, and the `api` (fallback) flag value in a follow-up PR.

---

## Architecture

- The data layer sits behind a `DataStore` interface (6 methods) in
  `src/server/data/store.ts:18-25`. Callers import the `dataStore` **singleton**
  (`store.ts:174`); they never construct a store. That singleton is the switch point.
- `createApiStore()` returns a `DataStore` whose 6 methods `fetch()` the reader's `/v1`
  endpoints, **structurally validate** the parsed body, apply the one semantic mapping
  (the current-week narrowing on `getMatches`), and cache with the **same TTLs the ESPN
  store uses today**.
- `withFallback(primary, fallback)` wraps two `DataStore`s and, per method, tries
  `primary` and falls back on a thrown error — logging a stable, greppable line and
  incrementing an in-process counter.
- `selectDataStore()` reads `process.env.DATA_SOURCE`: `'api'` →
  `withFallback(createApiStore(), espnStore)`; `'api-only'` → `createApiStore()` bare;
  anything else (incl. unset) → `espnStore`. It **fails fast at boot** if an api mode is
  selected without `SCOREARC_API_BASE`.

```
callers ──▶ dataStore (singleton in store.ts)
                       │
   DATA_SOURCE=  api   │  api-only        else (default 'espn')
             ┌─────────┼──────────┬────────────┐
             ▼         ▼          ▼            ▼
   withFallback(api,espn)   createApiStore()  espnStore
        │        └──on throw──▶ espnStore
        ▼
   createApiStore() ──fetch()──▶  $SCOREARC_API_BASE/v1/...
     · validate structure (loud on drift)
     · narrow getMatches to the current Mon→Sun week
     · TtlCache, same TTLs as the ESPN store
```

## Tech Stack

- Next.js 14.2 App Router (server components + `route.ts` handlers) — these run
  **server-side**, so `fetch()` and `process.env` reads never reach the browser.
- TypeScript strict (no `any`). Vitest 4 (`vitest run`), default node environment;
  `Response`, `AbortSignal.timeout`, `vi.stubEnv`, `vi.stubGlobal` are all available.

## Global Constraints

- **TypeScript strict, no `any`.** Parse to `unknown`, validate structurally, then
  narrow with a single generic assertion. No `as any`.
- **`DATA_SOURCE` and `SCOREARC_API_BASE` are SERVER-ONLY.** Never prefix either with
  `NEXT_PUBLIC_`. Never import `apiStore.ts` or `store.ts` into a `'use client'`
  component. These values must never be passed as props to a client component or
  serialized into HTML.
- **Ids are opaque.** No code added by this plan may parse, slice, number-coerce, or
  compare an id against a literal.
- **Additive-forward.** The validator checks that required keys are *present*; it must
  **not** reject unknown extra keys. The reader will grow fields (our own xG, computed
  win probability, form trends) ahead of the UI, and an older frontend must keep working.
  This is the mechanism that keeps VISION.md §3 reachable.
- **DRY / reuse the seam.** No new fetch call sites in components. All data still flows
  through the single `dataStore` singleton.
- **`main` auto-deploys to production.** Work on a branch. Do not commit to `main`, do
  not merge. Merging is the user's call.
- **Commit trailer:** use *your own* agent identity per AGENTS.md — e.g.
  `Co-Authored-By: Codex <noreply@openai.com>`,
  `Co-Authored-By: Claude <noreply@anthropic.com>`. Do not attribute to another agent.
  The commands below write `<YOUR AGENT IDENTITY>`; substitute it.

## Current state (verified on `origin/main`, 2026-08-12)

- **Reader API merged** (#21): `backend/reader/`, contract in `openapi.yaml`.
- **Internal ingester merged** (#23): `backend/ingester/`, `backend/shared/store/`,
  `backend/shared/source/`, `backend/shared/model/`. The `shared/espn` types are now
  aliases of `shared/model` (`backend/shared/espn/types.go`).
- **VISION.md merged** (#22).
- The database (Neon) is still being provisioned — an unpopulated DB is the default
  state, which is exactly hazard (G).
- `src/server/data/store.ts:174-177` exports the ESPN singleton; `types.ts` holds the
  return types; all 18 call sites import `{ dataStore }` and none construct a store.

### DataStore method → Reader endpoint → return type

| DataStore method | Reader endpoint | Returns | Notes |
|---|---|---|---|
| `getMatches(rc)` | `GET /v1/competitions/{comp}/{season}/matches` | `Match[]` | **narrow to current week** |
| `getStandings(rc)` | `GET /v1/competitions/{comp}/{season}/standings` | `Group[]` | |
| `getBracket(rc)` | `GET /v1/competitions/{comp}/{season}/bracket` | `BracketRound[]` | |
| `getTopScorers(rc)` | `GET /v1/competitions/{comp}/{season}/top-scorers` | `TopScorer[]` | |
| `getNews(rc)` | `GET /v1/competitions/{comp}/news` (**no season**) | `NewsArticle[]` | live ESPN proxy |
| `getMatchSummary(rc, eventId, homeId, awayId)` | `GET /v1/matches/{eventId}` (home/away unused) | `MatchSummaryData` | 404 when no detail row |

---

### Task 1 — Failing test first: `apiStore.test.ts`

TDD: the test file lands before the implementation and must fail to compile/run.

- [ ] Create `src/server/data/apiStore.test.ts` with the **complete** content below.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createApiStore,
  withFallback,
  readFallbackCounts,
  resetFallbackCounts,
} from './apiStore';
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

// Fixed "now" so the current-week narrowing is deterministic.
// 2026-06-10 is a Wednesday → its Mon→Sun week is 2026-06-08 .. 2026-06-14.
const NOW = new Date('2026-06-10T12:00:00Z');

// ---- Reader-shaped payloads (every key required by openapi.yaml is present) ----

function matchAt(id: string, kickoff: string): Match {
  return {
    id,
    kickoff,
    state: 'finished',
    minute: null,
    statusDetail: 'FT',
    statusName: 'STATUS_FULL_TIME',
    home: { id: 'nat-mex', name: 'Mexico', abbr: 'MEX', crestUrl: 'https://cdn/mex.png' },
    away: { id: 'nat-can', name: 'Canada', abbr: 'CAN', crestUrl: null },
    homeScore: 2,
    awayScore: 1,
    winnerId: 'nat-mex',
    note: null,
    scorers: [{ teamId: 'nat-mex', player: 'A. Vega', minute: "23'", penalty: false, shootout: false }],
    cards: [],
    shootout: null,
    shootoutDetail: null,
    stats: null,
    winProbability: null,
  };
}

// Inside the 2026-06-08..2026-06-14 week, and outside it.
const inWeek = matchAt('m-in', '2026-06-11T16:00:00Z');
const outOfWeek = matchAt('m-out', '2026-07-19T16:00:00Z');

// A finished 0-0 with a zero-valued stat: guards against a falsy-check bug that
// would drop a real 0. Reader always emits the key, never omits it.
const zeroMatch: Match = {
  ...matchAt('m-zero', '2026-06-12T16:00:00Z'),
  homeScore: 0,
  awayScore: 0,
  winnerId: null,
  scorers: [],
};

const sampleGroup: Group = {
  id: 'A',
  name: 'Group A',
  standings: [
    {
      team: { id: 'nat-mex', name: 'Mexico', abbr: 'MEX', crestUrl: null },
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
      id: 'k-1',
      round: 'round-of-32',
      kickoff: '2026-06-28T16:00:00Z',
      home: { id: 'nat-mex', name: 'Mexico', abbr: 'MEX', crestUrl: null, placeholder: false },
      away: { id: 'ph-1', name: 'Round of 32 Winner 5', abbr: 'TBD', crestUrl: null, placeholder: true },
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

// goals: 0 and matches: 0 — both legitimate values that a falsy check would eat.
const sampleScorer: TopScorer = {
  rank: 1,
  player: 'Star Striker',
  teamAbbr: 'MEX',
  teamName: 'Mexico',
  teamCrestUrl: null,
  goals: 0,
  matches: 0,
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

// Route a mocked fetch by URL path. Records URLs so endpoint-mapping assertions
// can inspect them. `override` lets a test swap one endpoint's body.
function mockReader(override: Record<string, unknown> = {}) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    let key: string;
    if (url.endsWith('/matches')) key = 'matches';
    else if (url.endsWith('/standings')) key = 'standings';
    else if (url.endsWith('/bracket')) key = 'bracket';
    else if (url.endsWith('/top-scorers')) key = 'top-scorers';
    else if (url.endsWith('/news')) key = 'news';
    else if (url.includes('/v1/matches/')) key = 'summary';
    else throw new Error(`unexpected url ${url}`);
    const defaults: Record<string, unknown> = {
      matches: [inWeek, outOfWeek, zeroMatch],
      standings: [sampleGroup],
      bracket: [sampleRound],
      'top-scorers': [sampleScorer],
      news: [sampleNews],
      summary: sampleSummary,
    };
    const body = key in override ? override[key] : defaults[key];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, fetchMock };
}

describe('createApiStore — endpoint mapping, validation, semantics', () => {
  beforeEach(() => {
    vi.stubEnv('SCOREARC_API_BASE', 'https://reader.test/');
    resetFallbackCounts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('getMatches hits the right URL and narrows to the current Mon→Sun week', async () => {
    const { urls } = mockReader();
    const matches = await createApiStore({ now: () => NOW }).getMatches(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/matches');
    // The reader returns the whole season; the store must return this week only.
    expect(matches.map((m) => m.id)).toEqual(['m-in', 'm-zero']);
  });

  it('preserves a legitimate 0 score and 0-length scorer list', async () => {
    mockReader();
    const matches = await createApiStore({ now: () => NOW }).getMatches(wc);
    const zero = matches.find((m) => m.id === 'm-zero')!;
    expect(zero.homeScore).toBe(0);
    expect(zero.awayScore).toBe(0);
    expect(zero.winnerId).toBeNull();
    expect(zero.scorers).toEqual([]);
  });

  it('accepts unknown extra fields (forward compatibility with our own stats)', async () => {
    const future = { ...inWeek, xg: { home: 1.7, away: 0.4 }, momentum: 12 };
    mockReader({ matches: [future] });
    const matches = await createApiStore({ now: () => NOW }).getMatches(wc);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('m-in');
  });

  it('throws loudly when a required field is missing (drift must not render)', async () => {
    const broken = { ...inWeek } as Record<string, unknown>;
    delete broken.winnerId;
    mockReader({ matches: [broken] });
    await expect(createApiStore({ now: () => NOW }).getMatches(wc)).rejects.toThrow(/winnerId/);
  });

  it('throws when the body is not an array', async () => {
    mockReader({ standings: { oops: true } });
    await expect(createApiStore().getStandings(wc)).rejects.toThrow(/expected an array/);
  });

  it('getStandings -> /standings, parses Group[]', async () => {
    const { urls } = mockReader();
    const groups = await createApiStore().getStandings(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/standings');
    expect(groups).toEqual([sampleGroup]);
    expect(groups[0].standings[0].points).toBe(3);
  });

  it('getBracket -> /bracket, parses BracketRound[] incl. placeholder legs', async () => {
    const { urls } = mockReader();
    const rounds = await createApiStore().getBracket(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/bracket');
    expect(rounds).toEqual([sampleRound]);
    expect(rounds[0].matches[0].away.placeholder).toBe(true);
  });

  it('getTopScorers -> /top-scorers, keeps goals: 0 and matches: 0', async () => {
    const { urls } = mockReader();
    const scorers = await createApiStore().getTopScorers(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/2026/top-scorers');
    expect(scorers[0].goals).toBe(0);
    expect(scorers[0].matches).toBe(0);
  });

  it('getNews -> season-agnostic /v1/competitions/world-cup/news', async () => {
    const { urls } = mockReader();
    const news = await createApiStore().getNews(wc);
    expect(urls[0]).toBe('https://reader.test/v1/competitions/world-cup/news');
    expect(news).toEqual([sampleNews]);
  });

  it('getMatchSummary -> /v1/matches/{id}, ignores home/away ids', async () => {
    const { urls } = mockReader();
    const summary = await createApiStore().getMatchSummary(wc, 'k-1', 'home-1', 'away-2');
    expect(urls[0]).toBe('https://reader.test/v1/matches/k-1');
    expect(summary).toEqual(sampleSummary);
  });

  it('treats ids as opaque — a slug/uuid id round-trips unchanged in the URL', async () => {
    const { urls } = mockReader();
    await createApiStore().getMatchSummary(wc, '0191f2a0-7c3d-7b2e-9a10-1f2b3c4d5e6f', '', '');
    expect(urls[0]).toBe(
      'https://reader.test/v1/matches/0191f2a0-7c3d-7b2e-9a10-1f2b3c4d5e6f',
    );
  });

  it('caches within the TTL: two getStandings calls fetch once', async () => {
    const { fetchMock } = mockReader();
    const store = createApiStore();
    await store.getStandings(wc);
    await store.getStandings(wc);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scopes the cache per competition + season', async () => {
    const { fetchMock } = mockReader();
    const store = createApiStore();
    await store.getStandings(wc);
    await store.getStandings(resolveSeason('world-cup', '2022')!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when SCOREARC_API_BASE is unset', async () => {
    vi.stubEnv('SCOREARC_API_BASE', '');
    mockReader();
    await expect(createApiStore().getMatches(wc)).rejects.toThrow(/SCOREARC_API_BASE/);
  });

  it('throws on a non-2xx reader response (incl. 429 and 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })));
    await expect(createApiStore().getMatches(wc)).rejects.toThrow(/429/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(createApiStore().getMatchSummary(wc, 'x', '', '')).rejects.toThrow(/404/);
  });

  it('does not cache a failed response', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', failing);
    const store = createApiStore();
    await expect(store.getStandings(wc)).rejects.toThrow();
    await expect(store.getStandings(wc)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

// A DataStore stub whose getMatches carries a tag, so tests can assert *which*
// store served a call.
function stubStore(tag: string): DataStore {
  return {
    getMatches: () => Promise.resolve([{ ...inWeek, note: tag }]),
    getStandings: () => Promise.resolve([] as Group[]),
    getBracket: () => Promise.resolve([] as BracketRound[]),
    getTopScorers: () => Promise.resolve([] as TopScorer[]),
    getNews: () => Promise.resolve([] as NewsArticle[]),
    getMatchSummary: () => Promise.resolve(sampleSummary),
  };
}

describe('selectDataStore — DATA_SOURCE switch', () => {
  const api = () => stubStore('api');

  it('returns the ESPN store when DATA_SOURCE is unset', async () => {
    const store = selectDataStore({
      source: undefined,
      makeApiStore: api,
      espn: stubStore('espn'),
      base: undefined,
    });
    expect((await store.getMatches(wc))[0].note).toBe('espn');
  });

  it("returns the ESPN store for any unrecognised value", async () => {
    const store = selectDataStore({
      source: 'espn',
      makeApiStore: api,
      espn: stubStore('espn'),
      base: undefined,
    });
    expect((await store.getMatches(wc))[0].note).toBe('espn');
  });

  it("DATA_SOURCE=api returns the api store wrapped in a fallback", async () => {
    const store = selectDataStore({
      source: 'api',
      makeApiStore: api,
      espn: stubStore('espn'),
      base: 'https://reader.test',
    });
    expect((await store.getMatches(wc))[0].note).toBe('api');
  });

  it("DATA_SOURCE=api-only returns the api store with NO fallback", async () => {
    const failing: DataStore = {
      ...stubStore('api'),
      getMatches: () => Promise.reject(new Error('reader down')),
    };
    const store = selectDataStore({
      source: 'api-only',
      makeApiStore: () => failing,
      espn: stubStore('espn'),
      base: 'https://reader.test',
    });
    await expect(store.getMatches(wc)).rejects.toThrow(/reader down/);
  });

  it('fails fast at selection time when an api mode has no SCOREARC_API_BASE', () => {
    expect(() =>
      selectDataStore({
        source: 'api',
        makeApiStore: api,
        espn: stubStore('espn'),
        base: undefined,
      }),
    ).toThrow(/SCOREARC_API_BASE/);
  });
});

describe('withFallback — per-call ESPN fallback, loudly counted', () => {
  beforeEach(() => resetFallbackCounts());

  it('falls back to ESPN when the primary throws, logs and counts it', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const primary: DataStore = {
      ...stubStore('api'),
      getMatches: () => Promise.reject(new Error('reader down')),
    };
    const store = withFallback(primary, stubStore('espn'));
    expect((await store.getMatches(wc))[0].note).toBe('espn');
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain('[data] source=espn-fallback');
    expect(readFallbackCounts().getMatches).toBe(1);
    errSpy.mockRestore();
  });

  it('uses the primary result when it succeeds and never touches the fallback', async () => {
    const espnSpy = vi.fn(() => Promise.resolve([] as Group[]));
    const fallback: DataStore = { ...stubStore('espn'), getStandings: espnSpy };
    const store = withFallback(stubStore('api'), fallback);
    await store.getStandings(wc);
    expect(espnSpy).not.toHaveBeenCalled();
    expect(readFallbackCounts().getStandings ?? 0).toBe(0);
  });

  it('falls back independently per method', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const primary: DataStore = {
      ...stubStore('api'),
      getMatchSummary: () => Promise.reject(new Error('404')),
    };
    const store = withFallback(primary, stubStore('espn'));
    await store.getStandings(wc);
    await store.getMatchSummary(wc, 'k-1', '', '');
    expect(readFallbackCounts().getMatchSummary).toBe(1);
    expect(readFallbackCounts().getStandings ?? 0).toBe(0);
    errSpy.mockRestore();
  });
});
```

Notes for the agent:
- `resolveSeason('world-cup', '2022')` exists (`src/server/data/competitions.ts:78`);
  the cache-scoping test relies on it.
- `vi.stubEnv` / `vi.stubGlobal` are built into Vitest 4; `Response` is a Node global.
- The switch/fallback tests inject stores, so they never read `process.env.DATA_SOURCE`
  and need no module resets.

- [ ] Confirm the test fails (module does not exist yet).

```bash
npx vitest run src/server/data/apiStore.test.ts
```

expect: failure — `Failed to resolve import "./apiStore"` (or `Cannot find module`),
exit code 1. **Do not proceed until you have seen this fail.**

- [ ] Commit the failing test.

```bash
git add src/server/data/apiStore.test.ts
git commit -m "test(data): specify reader-backed apiStore, DATA_SOURCE switch, fallback

Co-Authored-By: <YOUR AGENT IDENTITY>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 2 — `apiStore.ts`: reader-backed `DataStore`, validated + cached

- [ ] Create `src/server/data/apiStore.ts` with the **complete** content below.

```ts
import type { DataStore } from './store';
import type { CompetitionSeason } from './competitions';
import { TtlCache } from './cache';
import { isThisWeek } from '@/components/upcomingWindow';
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
    throw new Error('SCOREARC_API_BASE is not set (required when DATA_SOURCE=api|api-only)');
  }
  return base.replace(/\/+$/, ''); // trim trailing slashes so path joins are clean
}

// The reader's own server timeout is 10s; bail earlier so a hung reader can't
// stall an SSR render (and, under DATA_SOURCE=api, so the ESPN fallback still
// has time to answer).
const REQUEST_TIMEOUT_MS = 6_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Structural gate. We assert that every field types.ts declares is PRESENT —
// `in`, not truthiness, so a legitimate 0 / '' / false / null passes. Unknown
// extra keys are deliberately ALLOWED: the reader will serve fields we haven't
// built UI for yet (our own xG, computed win probability, trends), and an older
// frontend must keep working. Drift in the other direction — a field the UI
// needs going missing — throws, so it fails loudly instead of rendering blanks.
function requireKeys(path: string, where: string, item: unknown, keys: readonly string[]): void {
  if (!isRecord(item)) {
    throw new Error(`reader ${path}${where}: expected an object`);
  }
  for (const key of keys) {
    if (!(key in item)) {
      throw new Error(`reader ${path}${where}: missing required field "${key}"`);
    }
  }
}

function asArray<T>(path: string, body: unknown, keys: readonly string[]): T[] {
  if (!Array.isArray(body)) {
    throw new Error(`reader ${path}: expected an array, got ${typeof body}`);
  }
  // Re-type as unknown[] so element access is `unknown`, not the implicit `any`
  // that Array.isArray's narrowing would otherwise hand us.
  const items: unknown[] = body;
  items.forEach((item, index) => requireKeys(path, `[${index}]`, item, keys));
  return items as T[];
}

function asObject<T>(path: string, body: unknown, keys: readonly string[]): T {
  requireKeys(path, '', body, keys);
  return body as T;
}

// Field lists mirror the `required:` arrays in backend/reader/openapi.yaml.
const MATCH_KEYS = [
  'id', 'kickoff', 'state', 'minute', 'statusDetail', 'statusName', 'home', 'away',
  'homeScore', 'awayScore', 'winnerId', 'note', 'scorers', 'cards', 'shootout',
  'shootoutDetail', 'stats', 'winProbability',
] as const;
const GROUP_KEYS = ['id', 'name', 'standings'] as const;
const ROUND_KEYS = ['slug', 'name', 'matches'] as const;
const TOP_SCORER_KEYS = [
  'rank', 'player', 'teamAbbr', 'teamName', 'teamCrestUrl', 'goals', 'matches',
] as const;
const NEWS_KEYS = ['id', 'headline', 'description', 'published', 'image', 'url', 'byline'] as const;
const SUMMARY_KEYS = [
  'scorers', 'cards', 'stats', 'winProbability', 'lineups', 'videos', 'shootoutDetail',
  'info', 'form', 'commentary', 'h2h',
] as const;

// GET the reader and return the parsed body as `unknown` — callers validate.
// `cache: 'no-store'` because we own freshness through TtlCache below (the same
// arrangement the ESPN store uses today).
async function getJson(path: string): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`reader ${path} -> ${res.status}`);
  }
  return res.json();
}

const enc = encodeURIComponent;

export interface ApiStoreDeps {
  // Injected for deterministic tests of the current-week narrowing.
  now?: () => Date;
}

// A DataStore backed by our own /v1 Reader API instead of ESPN. Same interface,
// same return types — callers can't tell the difference.
//
// TTLs deliberately mirror src/server/data/store.ts's ESPN store. Dropping the
// cache here would be a regression, not a simplification: every SSR render and
// every client poll would hit the reader, and the reader rate-limits at 10 rps
// per IP (backend/reader/main.go:56) while all Vercel SSR traffic shares a small
// pool of egress IPs.
export function createApiStore(deps: ApiStoreDeps = {}): DataStore {
  const now = deps.now ?? (() => new Date());
  const cache = new TtlCache<unknown>();
  const key = (rc: CompetitionSeason, k: string) => `${rc.competition.id}:${rc.season.id}:${k}`;

  async function cached<T>(cacheKey: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(cacheKey) as T | undefined;
    if (hit !== undefined) return hit;
    const value = await load(); // a rejection propagates — failures are never cached
    cache.set(cacheKey, value, ttlMs);
    return value;
  }

  return {
    // The reader serves EVERY match row for the season
    // (backend/reader/store.go:39-50 has no date predicate), whereas the ESPN
    // store fetches only the current Monday→Sunday week (store.ts:107-109).
    // Narrow here so the two stores are interchangeable — otherwise the hub's
    // "{n} matches" tile, hubStatus(), and the league page's `hasMatches`
    // section ordering all silently change meaning.
    getMatches(rc: CompetitionSeason): Promise<Match[]> {
      return cached(key(rc, 'matches'), 10_000, async () => {
        const path = `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/matches`;
        const all = asArray<Match>(path, await getJson(path), MATCH_KEYS);
        const today = now();
        return all.filter((m) => isThisWeek(m.kickoff, today));
      });
    },

    getStandings(rc: CompetitionSeason): Promise<Group[]> {
      return cached(key(rc, 'standings'), 60_000, async () => {
        const path = `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/standings`;
        return asArray<Group>(path, await getJson(path), GROUP_KEYS);
      });
    },

    getBracket(rc: CompetitionSeason): Promise<BracketRound[]> {
      return cached(key(rc, 'bracket'), 8_000, async () => {
        const path = `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/bracket`;
        return asArray<BracketRound>(path, await getJson(path), ROUND_KEYS);
      });
    },

    getTopScorers(rc: CompetitionSeason): Promise<TopScorer[]> {
      return cached(key(rc, 'topscorers'), 60_000, async () => {
        const path = `/v1/competitions/${enc(rc.competition.id)}/${enc(rc.season.id)}/top-scorers`;
        return asArray<TopScorer>(path, await getJson(path), TOP_SCORER_KEYS);
      });
    },

    // The reader's news route is season-agnostic: /v1/competitions/{comp}/news.
    // NOTE: this endpoint is a live ESPN proxy inside the reader
    // (backend/reader/news.go:93), not data we own yet.
    getNews(rc: CompetitionSeason): Promise<NewsArticle[]> {
      return cached(key(rc, 'news'), 90_000, async () => {
        const path = `/v1/competitions/${enc(rc.competition.id)}/news`;
        return asArray<NewsArticle>(path, await getJson(path), NEWS_KEYS);
      });
    },

    // The reader serves a fully-precomputed summary keyed only by match id;
    // homeId/awayId (needed by the ESPN mapper to orient home/away) are unused
    // here but kept in the signature to satisfy the DataStore interface. The id
    // is opaque — never parsed, only URL-encoded.
    getMatchSummary(
      rc: CompetitionSeason,
      eventId: string,
      _homeId: string,
      _awayId: string,
    ): Promise<MatchSummaryData> {
      return cached(key(rc, `summary:${eventId}`), 12_000, async () => {
        const path = `/v1/matches/${enc(eventId)}`;
        return asObject<MatchSummaryData>(path, await getJson(path), SUMMARY_KEYS);
      });
    },
  };
}

// ---- Fallback wrapper + observability ------------------------------------

// In-process counters so tests can assert fallback behavior and so a future
// debug surface can report it. The log line is the production signal: grep
// Vercel logs for `[data] source=espn-fallback`.
const fallbackCounts = new Map<string, number>();

export function readFallbackCounts(): Record<string, number> {
  return Object.fromEntries(fallbackCounts);
}

export function resetFallbackCounts(): void {
  fallbackCounts.clear();
}

async function runWithFallback<R>(
  label: string,
  primary: () => Promise<R>,
  fallback: () => Promise<R>,
): Promise<R> {
  try {
    return await primary();
  } catch (err) {
    fallbackCounts.set(label, (fallbackCounts.get(label) ?? 0) + 1);
    // Stable, greppable, one line. A cutover that fails open and invisibly is
    // worse than one that fails loudly.
    console.error(
      `[data] source=espn-fallback method=${label} reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return fallback();
  }
}

// Wrap a primary store so any thrown error transparently falls back to a
// secondary store, per call. ROLLOUT AID ONLY — see the plan's "mixed-id-space
// hazard": this is only sound while both stores serve the SAME id space. It
// must be deleted before canonical ids (curated team slugs / UUIDv7 match ids)
// ship, or a single failed call will mix id spaces inside one render and break
// the scorer/card ↔ team joins silently.
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
- `import type { DataStore } from './store'` is **type-only** — erased at compile time,
  so even though `store.ts` imports values from this file there is **no runtime circular
  import**.
- `isThisWeek` (`src/components/upcomingWindow.ts:5-16`) is a pure, already-unit-tested
  function with no React import; reusing it is the DRY choice over re-deriving week
  bounds. Its Monday→Sunday *local* window is a superset-safe narrowing of ESPN's
  `dates=` range, and `UpcomingTicker` applies the identical filter on the client.
- Do **not** delete the cache "because the reader is cheap". The ESPN store caches
  standings, bracket, top scorers and news too, and those are single fetches — the
  original draft's justification ("only because of expensive multi-fetch enrichment")
  was wrong.

- [ ] Typecheck.

```bash
npx tsc --noEmit
```

expect: (no output; exit code 0)

- [ ] Commit.

```bash
git add src/server/data/apiStore.ts
git commit -m "feat(data): reader-backed apiStore with validation, TTL cache and fallback

Co-Authored-By: <YOUR AGENT IDENTITY>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 3 — Wire the `DATA_SOURCE` switch into the `dataStore` singleton

- [ ] Edit `src/server/data/store.ts`. Add the import immediately after the
  `import { TtlCache } from './cache';` line:

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
// The ESPN read-through store: today's default and the rollout fallback.
const espnStore: DataStore = createDataStore({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});

export type DataSource = 'espn' | 'api' | 'api-only';

export interface SelectDataStoreOptions {
  source?: string;
  makeApiStore?: () => DataStore;
  espn?: DataStore;
  base?: string;
}

// Pick the active store from the server-only DATA_SOURCE flag.
//
//   unset / anything else  → espnStore                      (today's behavior)
//   'api'                  → withFallback(apiStore, espn)   (ROLLOUT ONLY)
//   'api-only'             → apiStore, no fallback          (terminal state)
//
// 'api' is temporary. See docs/superpowers/plans/2026-08-11-frontend-cutover.md
// ("mixed-id-space hazard"): a per-call fallback between two stores is only
// sound while both serve the same id space, which stops being true once
// canonical team slugs / UUIDv7 match ids ship.
//
// NOTE: DATA_SOURCE / SCOREARC_API_BASE are server-only env vars — never prefix
// with NEXT_PUBLIC_, never send to the client. Parameters are injected for
// tests; production calls this with no args.
export function selectDataStore(options: SelectDataStoreOptions = {}): DataStore {
  const source = options.source ?? process.env.DATA_SOURCE;
  const makeApiStore = options.makeApiStore ?? (() => createApiStore());
  const espn = options.espn ?? espnStore;
  const base = 'base' in options ? options.base : process.env.SCOREARC_API_BASE;

  if (source !== 'api' && source !== 'api-only') {
    return espn;
  }
  // Fail fast at boot rather than throwing on every call. Without this, a
  // missing base URL would make every reader call throw, every call would fall
  // back to ESPN, and the site would look perfect while the cutover silently
  // never happened.
  if (!base) {
    throw new Error(`SCOREARC_API_BASE is required when DATA_SOURCE=${source}`);
  }
  console.info(`[data] source=${source} base=${base}`);
  const api = makeApiStore();
  return source === 'api-only' ? api : withFallback(api, espn);
}

export const dataStore: DataStore = selectDataStore();
```

- [ ] Typecheck and run the full suite. The new `apiStore.test.ts` must now pass, and the
  existing `store.test.ts` / `routes.test.ts` must stay green (`createDataStore` and
  `parseShootout` are untouched).

```bash
npx tsc --noEmit && npm test
```

expect: `npx tsc --noEmit` prints nothing (exit 0); `npm test` ends with a passing
summary, e.g. `Test Files  N passed (N)` / `Tests  M passed (M)`, exit code 0.

- [ ] Commit.

```bash
git add src/server/data/store.ts
git commit -m "feat(data): select reader vs ESPN store via DATA_SOURCE flag

Co-Authored-By: <YOUR AGENT IDENTITY>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 4 — Guard: the flag and base URL must never reach the browser

- [ ] Confirm no client component imports the data layer, and no `NEXT_PUBLIC_` variant
  of either variable exists.

```bash
grep -rln "use client" src/components src/app | xargs grep -ln "server/data/store\|server/data/apiStore"
```

expect: (no output; exit code 1) — no `'use client'` file imports the store.

```bash
grep -rn "NEXT_PUBLIC_DATA_SOURCE\|NEXT_PUBLIC_SCOREARC_API_BASE" . \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.json" \
  --exclude-dir=node_modules --exclude-dir=.next
```

expect: (no output; exit code 1)

- [ ] Confirm no `any` was introduced.

```bash
grep -n ": any\|<any>\|as any" src/server/data/apiStore.ts src/server/data/apiStore.test.ts
```

expect: (no output; exit code 1)

- [ ] Confirm the new code treats ids as opaque (no parsing, no literals).

```bash
grep -nE "parseInt|Number\(|\.slice\(|startsWith" src/server/data/apiStore.ts
```

expect: (no output; exit code 1)

- [ ] Production build still succeeds with the flag unset.

```bash
npm run build
```

expect: build completes, exit 0. (`src/server/data/store.ts` now runs `selectDataStore()`
at module load — this proves the default path does not throw.)

- [ ] No commit for this task if nothing changed; if a guard failed, fix and amend the
  relevant task's commit.

---

### Task 5 — Document the env vars, the rollout, and the exit criteria

- [ ] Append the following section to `AGENTS.md` at the end of the `## Architecture`
  section (do not reformat the rest of the file).

````markdown
### Data source flag (frontend ⇄ reader)

The website reads data through the `dataStore` singleton (`src/server/data/store.ts`),
selected at server start by **server-only** env vars:

- `DATA_SOURCE` — `espn` (default; unset ⇒ espn), `api`, or `api-only`.
  - `api` routes all data calls to our Reader API **with a per-call ESPN fallback**.
    This is a rollout aid with an expiry, not the destination.
  - `api-only` routes to the Reader API with **no fallback** — errors surface. This is
    the terminal state and the only safe mode once canonical ids (curated team slugs,
    UUIDv7 match ids) ship, because a per-call fallback would otherwise mix two id
    spaces inside a single render.
- `SCOREARC_API_BASE` — the reader origin (no trailing slash), e.g.
  `https://scorearc-reader.fly.dev`. Required for `api` and `api-only`; the app
  **fails to boot** without it in those modes, by design.

**These are server-only. Never prefix with `NEXT_PUBLIC_`, never pass them (or any
secret) to a client component.** In Vercel, add them as plain (non-`NEXT_PUBLIC_`)
Environment Variables for the target environment. Locally, put them in `.env.local`.

Cut over locally against a running reader:

```bash
# terminal 1: run the reader (see backend/reader/README.md)
# terminal 2:
DATA_SOURCE=api SCOREARC_API_BASE=http://localhost:8080 npm run dev
```

**Observability.** Every fallback logs one line:
`[data] source=espn-fallback method=<m> reason=<msg>`. If that line appears in
production, the reader is failing and we are silently on ESPN — the cutover is not
real. Startup logs `[data] source=<mode> base=<url>`.

**Removing the fallback** (required before `feat/canonical-identity-impl` merges):
7 days on `api` with zero `espn-fallback` lines → flip to `api-only` → 7 more days →
delete `withFallback` and the `api` value.

**Known gap:** `/v1/competitions/{comp}/news` is a live ESPN proxy inside the reader
(`backend/reader/news.go`), so news is not data we own yet even under `api-only`.
````

- [ ] Verify the doc carries the server-only warning (AGENTS.md contained no
  `NEXT_PUBLIC_` mention before this task).

```bash
grep -n "Never prefix with .NEXT_PUBLIC_" AGENTS.md
```

expect: exactly one line, the warning added above (exit 0).

- [ ] Commit.

```bash
git add AGENTS.md
git commit -m "docs: document DATA_SOURCE / SCOREARC_API_BASE and the fallback exit criteria

Co-Authored-By: <YOUR AGENT IDENTITY>"
```

expect: `1 file changed, ` (…) in the commit summary.

---

### Task 6 — Parity gate (manual, required before any environment is flipped)

Automated tests cannot catch hazard (G): the reader returning `200 []` for a season the
ingester has not populated. That is not an error, so nothing falls back and the site
just goes blank. **This gate is the only thing standing between an unpopulated database
and a blank production site.** It is a checklist item for whoever flips the flag, not a
code change.

- [ ] With the reader running and pointed at the real database, compare counts against
  ESPN for every competition × season the site can route to (they are enumerated in
  `src/server/data/competitions.ts`; the reader's copy is `backend/config/competitions.json`).

```bash
for comp in world-cup leagues-cup premier-league laliga serie-a bundesliga ligue-1 mls liga-mx; do
  for path in matches standings bracket top-scorers; do
    season=$(python3 -c "import json,sys;d=json.load(open('backend/config/competitions.json'));print([c for c in (d if isinstance(d,list) else d['competitions']) if c['id']=='$comp'][0]['currentSeasonId'])")
    n=$(curl -s "$SCOREARC_API_BASE/v1/competitions/$comp/$season/$path" | python3 -c "import json,sys;b=json.load(sys.stdin);print(len(b) if isinstance(b,list) else 'obj')")
    echo "$comp/$season/$path -> $n"
  done
done
```

expect: a non-zero count for every competition/season/endpoint the site actually renders
(a genuinely empty `bracket` before a knockout stage begins, or empty `top-scorers`
pre-season, is legitimate — everything else being `0` is not).

- [ ] Explicitly check the **historic** World Cup editions the season switcher exposes
  (`1998, 2002, 2006, 2010, 2014, 2018, 2022`). If the ingester does not backfill them,
  `DATA_SOURCE=api-only` will render those pages blank. Record the decision: backfill
  first, or accept the regression, or keep those routes on ESPN.

expect: a written answer in the PR description. Do not flip production without one.

- [ ] Confirm the reader's per-IP rate limit tolerates Vercel. The reader allows
  10 rps / burst 30 per client IP (`backend/reader/main.go:56`), and all Vercel SSR
  traffic egresses from a small shared IP pool. The hub page alone renders 9
  competitions × up to 2 calls per request. If this is not raised or allow-listed for
  our origin, production will 429 and — under `DATA_SOURCE=api` — silently serve ESPN
  for everything.

expect: a note confirming the limit was raised/allow-listed. **This is a backend change
and is out of scope for this plan; it is a precondition, not a task.**

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

expect: dev server boots; the site loads exactly as before (still direct-ESPN); no
`[data] source=` line in the server log; nothing hits `SCOREARC_API_BASE`.

- [ ] Misconfiguration fails loudly, not silently:

```bash
DATA_SOURCE=api npm run dev
```

expect: the server **fails to start** with
`SCOREARC_API_BASE is required when DATA_SOURCE=api`. (It must not boot and quietly
serve ESPN forever.)

- [ ] Manual reader cutover (requires a locally-running reader on `:8080` against a
  populated database):

```bash
DATA_SOURCE=api SCOREARC_API_BASE=http://localhost:8080 npm run dev
```

expect: server log shows `[data] source=api base=http://localhost:8080`. Then, in the
browser, check each of these — they are the consumers the semantic differences touch:
  - **Hub (`/`)** — each tile's "{n} matches" count is a *this week* number, comparable
    to what `DATA_SOURCE` unset shows. Not a whole-season number.
  - **A tournament page (`/c/world-cup/2026`)** — bracket renders, "Upcoming This Week"
    shows the same fixtures as the ESPN mode.
  - **A league page (`/c/premier-league/2026-27`)** — section order (table vs live)
    matches the ESPN mode; the group/table heading text matches (see difference (C)).
  - **A match popup** — goals and cards appear (this is the `teamId === team.id` join;
    if it silently shows none, you have an id-space mismatch).
  - **Standings + top scorers + news** pages render.

- [ ] Fallback path works and is visible:

```bash
# with the app running in DATA_SOURCE=api mode, stop the reader, then reload a page
```

expect: pages still render, and the server log shows
`[data] source=espn-fallback method=<m> reason=<...>` for each failed method.

- [ ] Strict mode surfaces errors instead of hiding them:

```bash
DATA_SOURCE=api-only SCOREARC_API_BASE=http://localhost:8080 npm run dev
# then stop the reader and reload
```

expect: pages degrade visibly (the existing `try/catch` blocks in
`src/app/c/[comp]/[season]/page.tsx:39,53,54,79` render the empty states) and **no**
`espn-fallback` line appears — no silent ESPN traffic.

- [ ] Do **not** merge or push to `main`. Leave the branch for the user to review/merge.

---

## Self-review checklist

- **Each method → correct endpoint + type** (verified against `openapi.yaml` + `types.ts`):
  - `getMatches` → `/v1/competitions/{comp}/{season}/matches` → `Match[]`, **narrowed to
    the current Mon→Sun week** ✓
  - `getStandings` → `/…/standings` → `Group[]` ✓
  - `getBracket` → `/…/bracket` → `BracketRound[]` ✓
  - `getTopScorers` → `/…/top-scorers` → `TopScorer[]` ✓
  - `getNews` → `/v1/competitions/{comp}/news` (season ignored) → `NewsArticle[]` ✓
  - `getMatchSummary` → `/v1/matches/{eventId}` (home/away ids ignored) →
    `MatchSummaryData` ✓
- **Validation, not blind casting.** Required fields are checked for *presence* (`in`),
  so `0` / `''` / `false` / `null` survive; unknown extra fields are allowed so the
  reader can ship our own computed stats ahead of the UI. ✓
- **Caching preserved.** Same TTLs as the ESPN store; failures are never cached. ✓
- **Timeout.** 6s `AbortSignal.timeout` per reader call, under the reader's own 10s. ✓
- **Fallback**: per call, on any throw, with a stable greppable log line and a counter.
  Tested for throw→fallback, success→no-fallback, and per-method independence. ✓
- **Switch**: `espn` (default / unrecognised), `api` (fallback), `api-only` (strict);
  **fails fast** when an api mode has no base URL. ✓
- **Exit criteria for the fallback are written down** and tied to the canonical-identity
  branch. ✓
- **Ids stay opaque**: never parsed, sliced, numbered, or compared to literals. ✓
- **No `NEXT_PUBLIC_` leak**: env vars read only in server-executed code; a grep guard
  asserts the prefixed names appear nowhere; no `'use client'` file imports the store. ✓
- **No `any`**: `getJson` returns `unknown`; validators narrow with one assertion each;
  test stubs are typed. ✓
- **No new fetch call sites in components**; all data still flows through the single
  `dataStore` seam. Zero call-site edits. ✓
- **No backend changes**: `git diff --stat origin/main` touches only
  `src/server/data/apiStore.ts`, `src/server/data/apiStore.test.ts`,
  `src/server/data/store.ts`, `AGENTS.md`, and this plan. ✓

## Risks and open decisions (for the user, not the executing agent)

1. **Rate limiting.** 10 rps / burst 30 per IP vs Vercel's shared egress. Must be raised
   or allow-listed before production is flipped, or `api` mode will 429 into a permanent
   invisible ESPN fallback. Backend change — out of scope here.
2. **Historic seasons.** The season switcher exposes World Cup 1998–2022. If the
   ingester does not backfill them, `api-only` renders those pages blank. Decide:
   backfill, accept, or keep them on ESPN.
3. **News is not ours.** `api`/`api-only` still depend on ESPN for news, just one hop
   further away, and gain a 502 mode.
4. **Bracket round allowlist.** The reader drops any round slug outside its hardcoded
   six; the ESPN mapper normalizes aliases for old editions. Latent divergence.
5. **Group heading text** for single-table leagues may differ (difference C).
6. **Shared bracket links** already encode raw team ids; the canonical-identity branch
   will invalidate every link in the wild. Out of scope for this plan, but it should be
   fixed (version the `?b=` payload, or key picks by `abbr`) in the same release train.
