# T11.1 — Shared Priority Rule, Cheap Data Path & `/api/live` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the invisible foundation for E11 — one shared priority rule, an unenriched read for "now" surfaces, and a single cross-competition `/api/live` endpoint — and take the home page from 95 upstream ESPN requests to 18 with no visual change.

**Architecture:** `matchPriority` is a pure, timezone-agnostic function bucketing `Match[]` into `{ live, upcoming, recent }`. `getLiveWindow` reads the same unenriched scoreboard as `getFixtures` but on its own cache key and a 15s TTL. `/api/live` merges all nine competitions server-side and returns a flat, kickoff-sorted `{ competition, match }[]`, so one client poll replaces nine.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-dynamic-home-and-matches-design.md`
**Epic:** E11 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `feat/live-feed-foundation` off latest `origin/main`

---

## Global Constraints

- TypeScript strict. `any` only inside ESPN mappers on raw payloads, per existing convention. Nothing in this task touches a mapper.
- **No UI change.** If anything looks different in the browser after this task, something is wrong.
- **`npx tsc --noEmit` clean and `npm test` green before a PR.**
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run build` while `npm run dev` is running. Kill the dev server and `rm -rf .next` first.
- Work in a separate git worktree, branched off latest `origin/main`.

## Why this task exists (do not skip — it changes what "done" means)

Measured 2026-08-18 by instrumenting `defaultFetchJson` and issuing one request to `/`:

| | count |
|---|---|
| total upstream ESPN requests for one home render | **95** |
| of which per-match `/summary` | **77** |
| scoreboard | 11 |
| standings | 7 |

The 77 summary fetches come from `dataStore.getMatches`, which enriches every
match with its scorers and cards. The home page reads only `state` and a score,
both of which the scoreboard already carries. Task 5 is where those 77 go away.

---

## File Structure

- `src/server/data/matchPriority.ts` — **create.** Pure bucketing rule. No I/O, no `Date.now()` — `now` is a parameter.
- `src/server/data/matchPriority.test.ts` — **create.**
- `src/server/data/dateRange.ts` — **modify.** Add `nowWindowRange`.
- `src/server/data/dateRange.test.ts` — **modify** (or create if absent).
- `src/server/data/store.ts` — **modify.** Extract a shared window loader; add `getLiveWindow`.
- `src/server/data/store.test.ts` — **modify.**
- `src/app/api/live/route.ts` — **create.** The cross-competition merge.
- `src/app/api/live/route.test.ts` — **create.**
- `src/lib/telemetry/server.ts` — **modify.** Add `'live'` to `APIEndpoint`.
- `src/app/page.tsx` — **modify.** Swap the enriching read for the unenriched one.
- `src/app/page.test.tsx` — **create.** The request-cost regression guard.

---

### Task 1: `matchPriority` — the shared rule

**Files:**
- Create: `src/server/data/matchPriority.ts`
- Test: `src/server/data/matchPriority.test.ts`

**Interfaces:**
- `PrioritisedMatches` — `{ live: Match[]; upcoming: Match[]; recent: Match[] }`
- `matchPriority(matches: Match[], now: Date, opts?): PrioritisedMatches`

**Design notes you need before writing it:**

- **Timezone-agnostic on purpose.** This function has no concept of "today". It
  compares instants only. The local-date split ("Later today" vs "This week")
  belongs to the rendering component in T11.3, which does it after mount so a
  UTC server and a UTC−6 reader agree. Putting a "today" bucket here would push
  that bug into every caller.
- **A scheduled match whose kickoff has passed is not automatically upcoming.**
  It is either seconds from kicking off or it was postponed. Within a 3-hour
  grace it stays in `upcoming`; past that it is stale and belongs in neither
  bucket, because "Next up: a match from Tuesday" is worse than showing nothing.
- **An unparseable kickoff is excluded, not defaulted.** `new Date('nonsense')`
  yields `NaN`, and every comparison against `NaN` is `false`, which would
  silently place the match in whichever bucket the code happened to fall
  through to.

- [ ] **Step 1: Write the failing test**

Create `src/server/data/matchPriority.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchPriority } from './matchPriority';
import type { Match, MatchState } from './types';

const NOW = new Date('2026-08-18T18:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

function match(id: string, state: MatchState, kickoff: string): Match {
  return {
    id,
    kickoff,
    state,
    minute: null,
    statusDetail: '',
    statusName: '',
    home: { id: `${id}h`, name: 'Home', abbr: 'HOM', crestUrl: null },
    away: { id: `${id}a`, name: 'Away', abbr: 'AWY', crestUrl: null },
    homeScore: null,
    awayScore: null,
    winnerId: null,
    note: null,
    scorers: [],
    cards: [],
    shootout: null,
    shootoutDetail: null,
    stats: null,
    winProbability: null,
  } as Match;
}

describe('matchPriority', () => {
  it('buckets by state', () => {
    const { live, upcoming, recent } = matchPriority(
      [
        match('l', 'live', hours(-1)),
        match('u', 'scheduled', hours(3)),
        match('r', 'finished', hours(-5)),
      ],
      NOW,
    );
    expect(live.map((m) => m.id)).toEqual(['l']);
    expect(upcoming.map((m) => m.id)).toEqual(['u']);
    expect(recent.map((m) => m.id)).toEqual(['r']);
  });

  it('sorts upcoming soonest-first and recent most-recent-first', () => {
    const { upcoming, recent } = matchPriority(
      [
        match('later', 'scheduled', hours(8)),
        match('sooner', 'scheduled', hours(2)),
        match('older', 'finished', hours(-20)),
        match('newer', 'finished', hours(-2)),
      ],
      NOW,
    );
    expect(upcoming.map((m) => m.id)).toEqual(['sooner', 'later']);
    expect(recent.map((m) => m.id)).toEqual(['newer', 'older']);
  });

  // "Just finished" stops being interesting well before the next matchday.
  it('drops a result older than the recent window', () => {
    const { recent } = matchPriority([match('stale', 'finished', hours(-72))], NOW);
    expect(recent).toEqual([]);
  });

  // A scheduled match whose kickoff just passed is about to go live; one that
  // passed days ago was postponed, and "Next up" must not advertise it.
  it('keeps a just-past kickoff as upcoming but drops a long-past one', () => {
    const { upcoming } = matchPriority(
      [
        match('imminent', 'scheduled', hours(-1)),
        match('postponed', 'scheduled', hours(-30)),
      ],
      NOW,
    );
    expect(upcoming.map((m) => m.id)).toEqual(['imminent']);
  });

  // NaN comparisons are all false, so an unparseable date would otherwise fall
  // through into whichever bucket the code reached last.
  it('excludes a match with an unparseable kickoff', () => {
    const { live, upcoming, recent } = matchPriority(
      [match('bad', 'scheduled', 'not-a-date'), match('bad2', 'finished', 'not-a-date')],
      NOW,
    );
    expect([...live, ...upcoming, ...recent]).toEqual([]);
  });

  // A live match always belongs in `live`, whatever its clock says.
  it('keeps a live match live even with a stale kickoff', () => {
    const { live } = matchPriority([match('l', 'live', hours(-40))], NOW);
    expect(live.map((m) => m.id)).toEqual(['l']);
  });

  it('returns three empty arrays for no input', () => {
    expect(matchPriority([], NOW)).toEqual({ live: [], upcoming: [], recent: [] });
  });

  it('honours caller-supplied windows', () => {
    const { recent } = matchPriority([match('r', 'finished', hours(-5))], NOW, {
      recentWindowMs: 3_600_000,
    });
    expect(recent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/matchPriority.test.ts`
Expected: FAIL — `Failed to resolve import "./matchPriority"`.

- [ ] **Step 3: Implement**

Create `src/server/data/matchPriority.ts`:

```ts
import type { Match } from './types';

export interface PrioritisedMatches {
  live: Match[];
  upcoming: Match[];
  recent: Match[];
}

export interface PriorityWindows {
  /** How far back a finished match still counts as "just finished". */
  recentWindowMs?: number;
  /** How long past kickoff a still-scheduled match counts as imminent. */
  kickoffGraceMs?: number;
}

export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const KICKOFF_GRACE_MS = 3 * 60 * 60 * 1000;

/**
 * The one rule both entry points answer: live, then what is next, then what
 * just happened.
 *
 * Deliberately timezone-agnostic — it compares instants and has no concept of
 * "today". The local-date split ("Later today" vs "This week") happens in the
 * rendering component after mount, because the server runs UTC and a reader in
 * UTC-6 disagrees with it about which day an 8pm kickoff falls on. A "today"
 * bucket here would push that hydration mismatch into every caller.
 */
export function matchPriority(
  matches: Match[],
  now: Date,
  { recentWindowMs = RECENT_WINDOW_MS, kickoffGraceMs = KICKOFF_GRACE_MS }: PriorityWindows = {},
): PrioritisedMatches {
  const t = now.getTime();
  const live: Match[] = [];
  const upcoming: Match[] = [];
  const recent: Match[] = [];

  for (const m of matches) {
    const kickoff = new Date(m.kickoff).getTime();

    // A live match is live regardless of what its kickoff says.
    if (m.state === 'live') {
      live.push(m);
      continue;
    }

    // Every comparison against NaN is false, so an unparseable kickoff would
    // fall through into whichever bucket came last rather than being skipped.
    if (Number.isNaN(kickoff)) continue;

    if (m.state === 'scheduled') {
      // Past kickoff but still scheduled means either "about to start" or
      // "postponed". The grace tells them apart: advertising a fixture from
      // last Tuesday under "Next up" is worse than showing nothing.
      if (kickoff >= t - kickoffGraceMs) upcoming.push(m);
      continue;
    }

    if (t - kickoff <= recentWindowMs) recent.push(m);
  }

  const asc = (a: Match, b: Match) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
  live.sort(asc);
  upcoming.sort(asc);
  recent.sort((a, b) => -asc(a, b));

  return { live, upcoming, recent };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/data/matchPriority.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/matchPriority.ts src/server/data/matchPriority.test.ts
git commit -m "feat: add the shared match priority rule

Live, then what is next, then what just happened -- the one ordering
both the home page and the matches view will render from.

Timezone-agnostic on purpose: it compares instants and has no concept
of today. The local-date split belongs to the component, after mount,
because the server runs UTC and a reader in UTC-6 disagrees with it
about which day an 8pm kickoff falls on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `nowWindowRange` — the window the "now" surfaces read

**Files:**
- Modify: `src/server/data/dateRange.ts`
- Test: `src/server/data/dateRange.test.ts`

**Interface:** `nowWindowRange(now: Date, backDays?: number, forwardDays?: number): string` — an ESPN `dates` range, `YYYYMMDD-YYYYMMDD`.

Defaults are 7 back and 14 forward: 22 days, comfortably inside `parseRange`'s
92-day cap, wide enough that a competition on an international break still has
a next fixture to show.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/dateRange.test.ts`. If that file does not exist,
create it with the two imports at the top:

```ts
import { describe, it, expect } from 'vitest';
import { nowWindowRange } from './dateRange';

describe('nowWindowRange', () => {
  it('spans the default 7 days back and 14 forward', () => {
    expect(nowWindowRange(new Date(2026, 7, 18))).toBe('20260811-20260901');
  });

  it('honours custom spans', () => {
    expect(nowWindowRange(new Date(2026, 7, 18), 1, 1)).toBe('20260817-20260819');
  });

  // Month and year rollover is exactly what a hand-rolled string would get
  // wrong, and the value is interpolated straight into an upstream URL.
  it('rolls across a month boundary', () => {
    expect(nowWindowRange(new Date(2026, 8, 2), 7, 0)).toBe('20260826-20260902');
  });

  it('rolls across a year boundary', () => {
    expect(nowWindowRange(new Date(2027, 0, 3), 7, 0)).toBe('20261227-20270103');
  });

  it('produces a range parseRange accepts', async () => {
    const { parseRange } = await import('./dateRange');
    const range = nowWindowRange(new Date(2026, 7, 18));
    expect(parseRange(range)).toBe(range);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/dateRange.test.ts -t "nowWindowRange"`
Expected: FAIL — `nowWindowRange is not a function`.

- [ ] **Step 3: Implement**

In `src/server/data/dateRange.ts`, add below `monthRange` (it reuses the
module-private `fmt` already defined at the top of that file):

```ts
/**
 * The scoreboard window the "now" surfaces read: recent results behind, the
 * next fortnight ahead.
 *
 * Wider than the current week on purpose. `currentWeekRange` is right on a
 * matchday and empty the rest of the time — five of nine competitions were in
 * exactly that state on 2026-08-15, between them holding 132 scheduled
 * fixtures and displaying none.
 */
export function nowWindowRange(now: Date, backDays = 7, forwardDays = 14): string {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backDays);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + forwardDays);
  return `${fmt(from)}-${fmt(to)}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/data/dateRange.test.ts`
Expected: PASS, including the pre-existing cases in that file.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/dateRange.ts src/server/data/dateRange.test.ts
git commit -m "feat: add nowWindowRange for the live surfaces

Seven days back and fourteen forward, so a competition between
matchdays still has a next fixture to show. currentWeekRange is right
on a matchday and empty the rest of the time.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `getLiveWindow` — the cheap read, on its own TTL

**Files:**
- Modify: `src/server/data/store.ts`
- Test: `src/server/data/store.test.ts`

**Interface:** `getLiveWindow(rc: CompetitionSeason): Promise<Match[]>`

**Why a separate method rather than calling `getFixtures`:** `getFixtures`
caches for 120 seconds, which is right for a calendar month and wrong for a
score the band polls every 30 seconds — the band would render "67'" beside a
two-minute-old scoreline. Lowering `getFixtures`' TTL instead would triple
upstream load on the calendar for no benefit. Separate cache key, separate TTL,
same unenriched fetch.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/store.test.ts`:

```ts
describe('getLiveWindow', () => {
  // The whole point of this method: the band must not pay for 77 summary
  // fetches to read a scoreline the scoreboard already carries.
  it('fetches the scoreboard once and never a summary', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return SCOREBOARD_TWO_EVENTS;
      },
    });

    const matches = await store.getLiveWindow(wc);

    expect(matches.length).toBe(2);
    expect(urls.filter((u) => u.includes('/summary'))).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('serves a repeat call from cache', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new TtlCache<unknown>(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return { events: [] };
      },
    });
    await store.getLiveWindow(wc);
    await store.getLiveWindow(wc);
    expect(urls).toHaveLength(1);
  });

  // Sharing getFixtures' cache entry would give the calendar's 120s TTL to a
  // live scoreline, or the live 15s TTL to the calendar. Distinct keys.
  it('does not share a cache entry with getFixtures', async () => {
    const cache = new TtlCache<unknown>();
    const urls: string[] = [];
    const store = createDataStore({
      cache,
      fetchJson: async (url: string) => {
        urls.push(url);
        return { events: [] };
      },
    });
    await store.getLiveWindow(wc);
    const liveCalls = urls.length;
    await store.getFixtures(wc, '20260801-20260831');
    expect(urls.length).toBe(liveCalls + 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/store.test.ts -t "getLiveWindow"`
Expected: FAIL — `store.getLiveWindow is not a function`.

- [ ] **Step 3: Extract the shared loader**

`getFixtures` and `getLiveWindow` differ only in cache key and TTL, so the
fetch-map-sort body becomes one local function. In `src/server/data/store.ts`,
add this beside the other local helpers inside `createDataStore` (above
`async function computeTables(`):

```ts
  // One unenriched scoreboard read. Shared by getFixtures and getLiveWindow,
  // which differ only in cache key and TTL — a calendar month is settled for
  // two minutes, a live scoreline is not.
  async function loadWindow(
    rc: CompetitionSeason,
    range: string,
    cacheKey: string,
    ttlMs: number,
  ): Promise<Match[]> {
    const k = key(rc, cacheKey);
    const cached = deps.cache.get(k) as Match[] | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(scoreboardUrl(slug(rc), range));
    const matches = mapScoreboard(raw)
      .map((m) => ({ ...m, shootout: parseShootout(m.note, m.home.name, m.away.name) }))
      .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
    deps.cache.set(k, matches, ttlMs);
    return matches;
  }
```

- [ ] **Step 4: Rewrite `getFixtures` to use it, and add `getLiveWindow`**

**Open the file and diff before replacing.** As of 2026-08-19 `getFixtures`
reads exactly:

```ts
    async getFixtures(rc, range: string, ttlMs = 120_000): Promise<Match[]> {
      const k = key(rc, `fixtures:${range}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(scoreboardUrl(slug(rc), range));
      const matches = mapScoreboard(raw)
        .map((m) => ({ ...m, shootout: parseShootout(m.note, m.home.name, m.away.name) }))
        .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
      deps.cache.set(k, matches, ttlMs);
      return matches;
    },
```

Replace it with:

```ts
    async getFixtures(rc, range: string, ttlMs = 120_000): Promise<Match[]> {
      return loadWindow(rc, range, `fixtures:${range}`, ttlMs);
    },

    // The window the live band and the "Now" view read. Same unenriched
    // scoreboard as getFixtures, on its own cache key and a far shorter TTL:
    // the band polls every 30s, and serving it a 120s-old entry would render
    // "67'" beside a two-minute-old scoreline.
    async getLiveWindow(rc, ttlMs = 15_000): Promise<Match[]> {
      const range = nowWindowRange(new Date());
      return loadWindow(rc, range, `live:${range}`, ttlMs);
    },
```

- [ ] **Step 5: Declare it on the interface and import the helper**

In the `DataStore` interface, add below `getFixtures`:

```ts
  getLiveWindow(rc: CompetitionSeason): Promise<Match[]>;
```

Add `nowWindowRange` to the existing `dateRange` import in `store.ts`. If
`store.ts` does not yet import from `./dateRange`, add:

```ts
import { nowWindowRange } from './dateRange';
```

- [ ] **Step 6: Run the store suite and typecheck**

Run: `npx vitest run src/server/data/store.test.ts`
Expected: PASS, including the three new cases and every pre-existing one — the
`getFixtures` refactor must not change its behaviour.

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/server/data/store.ts src/server/data/store.test.ts
git commit -m "feat: add getLiveWindow, the cheap read for the live surfaces

Same unenriched scoreboard as getFixtures, on its own cache key and a
15s TTL. Sharing getFixtures' 120s entry would let a band that polls
every 30s render a minute-old scoreline as live; lowering that TTL
instead would triple upstream load on the calendar for no benefit.

The fetch-map-sort body both methods share is now one local function.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `/api/live` — nine competitions, one poll

**Files:**
- Create: `src/app/api/live/route.ts`
- Modify: `src/lib/telemetry/server.ts`
- Test: `src/app/api/live/route.test.ts`

**Interface:**

```ts
interface LiveEntry {
  competition: { id: string; name: string; shortName: string; emblem: string };
  match: Match;
}
```

`GET /api/live` → `LiveEntry[]`, flat and kickoff-sorted.

**Two deliberate decisions:**

1. **The competition travels with each match.** `Match` carries no competition
   field, so a bare `Match[]` could not be labelled "Liga MX · 67'" without the
   client joining against a second list. Flat and pre-sorted means the client
   does no work.
2. **A failed competition is caught per-competition, not by `Promise.allSettled`
   over the whole set.** Same guarantee, but it lets each failure be attributed
   to the competition it belongs to in telemetry instead of counting anonymous
   rejections. Eight competitions must still render when the ninth is down.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/live/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataStore } from '@/server/data/store';
import { listCompetitions } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type { Match } from '@/server/data/types';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));

function match(id: string, kickoff: string): Match {
  return {
    id, kickoff, state: 'scheduled', minute: null, statusDetail: '', statusName: '',
    home: { id: 'h', name: 'Home', abbr: 'HOM', crestUrl: null },
    away: { id: 'a', name: 'Away', abbr: 'AWY', crestUrl: null },
    homeScore: null, awayScore: null, winnerId: null, note: null,
    scorers: [], cards: [], shootout: null, shootoutDetail: null,
    stats: null, winProbability: null,
  } as Match;
}

describe('GET /api/live', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('labels every match with its competition', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('m1', '2026-08-20T00:00:00Z')]);
    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(listCompetitions().length);
    expect(body[0].competition.id).toBeTruthy();
    expect(body[0].competition.emblem).toBeTruthy();
    expect(body[0].match.id).toBe('m1');
  });

  it('returns entries sorted by kickoff across competitions', async () => {
    let n = 0;
    vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(async () => {
      n += 1;
      // Later competitions return earlier kickoffs, so an unsorted merge
      // would come back in competition order rather than time order.
      return [match(`m${n}`, new Date(Date.UTC(2026, 7, 30 - n)).toISOString())];
    });
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    const times = body.map((e: { match: Match }) => new Date(e.match.kickoff).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  // One dead feed means one competition missing from the band, not a dead band.
  it('returns 200 with the surviving competitions when one feed fails', async () => {
    let first = true;
    vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(async () => {
      if (first) { first = false; throw new Error('upstream unavailable'); }
      return [match('ok', '2026-08-20T00:00:00Z')];
    });
    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(listCompetitions().length - 1);
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('live', 502, expect.any(String), expect.any(String));
  });

  it('502s only when every competition fails', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockRejectedValue(new Error('upstream unavailable'));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it('never fetches a match summary', async () => {
    const spy = vi.spyOn(dataStore, 'getMatchSummary');
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const { GET } = await import('./route');
    await GET();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/live/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Add `'live'` to the telemetry endpoint union**

In `src/lib/telemetry/server.ts`, the union currently reads:

```ts
type APIEndpoint =
  | 'bracket'
  | 'match-summary'
  | 'matches'
  | 'news'
  | 'standings'
  | 'top-assists'
  | 'top-scorers';
```

Add `| 'live'` in alphabetical position (after `'bracket'`).

- [ ] **Step 4: Implement the route**

Create `src/app/api/live/route.ts`:

```ts
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type { Match } from '@/server/data/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface LiveEntry {
  competition: { id: string; name: string; shortName: string; emblem: string };
  match: Match;
}

/**
 * Every competition's current window, merged, so the client polls once rather
 * than nine times.
 *
 * The competition travels with each match because `Match` carries no
 * competition field, and a band row has to say "Liga MX · 67'" without the
 * client joining against a second list.
 *
 * A competition that fails contributes nothing and never blocks the other
 * eight — the failure is caught per competition rather than by settling the
 * whole set, so telemetry can name which feed died.
 */
export async function GET() {
  const competitions = listCompetitions();
  let failed = 0;

  const perCompetition = await Promise.all(
    competitions.map(async (comp): Promise<LiveEntry[]> => {
      const rc = resolveSeason(comp.id);
      if (!rc) return [];
      try {
        const matches = await dataStore.getLiveWindow(rc);
        return matches.map((match) => ({
          competition: {
            id: comp.id,
            name: comp.name,
            shortName: comp.shortName,
            emblem: comp.emblem,
          },
          match,
        }));
      } catch {
        failed += 1;
        await trackAPIRequestFailure('live', 502, comp.id, rc.season.id);
        return [];
      }
    }),
  );

  // Every feed down is an outage worth a 502; one feed down is a gap.
  if (failed === competitions.length) {
    return Response.json({ error: 'every competition feed failed' }, { status: 502 });
  }

  const entries = perCompetition
    .flat()
    .sort((a, b) => new Date(a.match.kickoff).getTime() - new Date(b.match.kickoff).getTime());

  return Response.json(entries, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run src/app/api/live/route.test.ts`
Expected: PASS, 5 tests.

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Verify against the running app**

```bash
npm run dev
```

```bash
curl -s "http://localhost:3000/api/live" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('entries:', len(d))
print('competitions:', sorted({e['competition']['id'] for e in d}))
print('sorted:', [e['match']['kickoff'] for e in d] == sorted(e['match']['kickoff'] for e in d))
"
```

Expected: a non-zero entry count, several distinct competition ids, and
`sorted: True`.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/live/route.ts" "src/app/api/live/route.test.ts" src/lib/telemetry/server.ts
git commit -m "feat: add /api/live, one poll for every competition

Merges all nine competitions' current windows server-side and returns a
flat, kickoff-sorted list, so the band polls once rather than nine
times. The competition travels with each match because Match carries no
competition field and a band row must name its league.

A competition that fails contributes nothing and never blocks the other
eight; only a total outage is a 502.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Take the home page off the enriching read

**Files:**
- Modify: `src/app/page.tsx`
- Test: `src/app/page.test.tsx` (create)

This is the 95 → 18 task. The home page reads only `state` (for `hubStatus`)
and `matches.length`, and the scoreboard carries both. `getMatches` was buying
scorers and cards it then discarded, at one upstream request per match.

**Keep the same window.** `getMatches` defaults to `currentWeekRange`; the
replacement passes that range explicitly, so tile counts and statuses are
byte-identical. Widening the window is T11.2's job, not this one.

- [ ] **Step 1: Write the failing test**

Create `src/app/page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { dataStore, currentWeekRange } from '@/server/data/store';
import Hub from './page';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

describe('Hub', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getBracket').mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  // One render used to cost 95 upstream ESPN requests, 77 of them per-match
  // /summary calls bought by getMatches and then discarded -- the home page
  // reads only `state` and a count, both of which the scoreboard carries.
  it('never uses the enriching match read', async () => {
    const enriching = vi.spyOn(dataStore, 'getMatches');
    const cheap = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);

    renderToStaticMarkup(await Hub());

    expect(enriching).not.toHaveBeenCalled();
    expect(cheap).toHaveBeenCalled();
  });

  it('reads the current week, so tiles are unchanged', async () => {
    const cheap = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    renderToStaticMarkup(await Hub());
    expect(cheap).toHaveBeenCalledWith(expect.anything(), currentWeekRange(new Date()));
  });

  it('still renders a tile per competition when the feed is empty', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('ScoreArc');
    expect(html).toContain('Liga MX');
  });

  // A dead feed for one competition must not take the page down.
  it('renders when a competition feed throws', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValue(new Error('upstream unavailable'));
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('Liga MX');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/page.test.tsx`
Expected: FAIL — `expected "getMatches" to not be called at all, but actually been called 9 times`.

- [ ] **Step 3: Swap the read**

In `src/app/page.tsx`, the import currently reads:

```ts
import { dataStore } from '@/server/data/store';
```

Change it to:

```ts
import { dataStore, currentWeekRange } from '@/server/data/store';
```

Then replace this block:

```ts
      let matches: Awaited<ReturnType<typeof dataStore.getMatches>> = [];
```

with:

```ts
      let matches: Awaited<ReturnType<typeof dataStore.getFixtures>> = [];
```

and replace:

```ts
      try {
        matches = await dataStore.getMatches(rc);
      } catch {
        // ESPN feed unavailable — show best-effort status
      }
```

with:

```ts
      try {
        // The unenriched read, deliberately. getMatches fetches one /summary
        // per match for scorers and cards this page never renders -- 77 of the
        // 95 upstream requests a single home render used to cost. The same
        // current-week window, so every tile is unchanged.
        matches = await dataStore.getFixtures(rc, currentWeekRange(new Date()));
      } catch {
        // ESPN feed unavailable — show best-effort status
      }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run src/app/page.test.tsx`
Expected: PASS, 4 tests.

Run: `npm test`
Expected: PASS, whole suite.

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Verify the drop against the running app**

Temporarily instrument the upstream fetch. In `src/server/data/store.ts`, find
`defaultFetchJson` and add a log line above its `fetch` call:

```ts
  console.log('UPSTREAM', url);
```

Then:

```bash
rm -rf .next
npm run dev > /tmp/scorearc-dev.log 2>&1 &
sleep 15
curl -s -o /dev/null http://localhost:3000/
sleep 8
grep -c UPSTREAM /tmp/scorearc-dev.log
grep UPSTREAM /tmp/scorearc-dev.log | sed 's/?.*//' | awk -F/ '{print $NF}' | sort | uniq -c
```

Expected: **18 total**, and **zero** `summary` lines. Before this task the same
measurement gave 95 with 77 summaries.

**Then remove the `console.log` line and confirm it is gone:**

```bash
grep -c UPSTREAM src/server/data/store.ts
```

Expected: `0`.

- [ ] **Step 6: Verify the page is visually unchanged**

Open `http://localhost:3000/`. Every tile, badge, group heading and sub-line
must be identical to `main`. This task is invisible by design; a visible
difference means the window or the status logic moved.

- [ ] **Step 7: Commit**

```bash
git add "src/app/page.tsx" "src/app/page.test.tsx"
git commit -m "perf: stop buying 77 match summaries the home page discards

One home render cost 95 upstream ESPN requests, 77 of them per-match
/summary calls fetched by getMatches for scorers and cards this page
never renders. It reads only state and a count, both of which the
scoreboard already carries.

Same current-week window, so every tile is byte-identical. 95 -> 18.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full gate and PR

- [ ] **Step 1: Confirm no instrumentation survived**

```bash
grep -rn "UPSTREAM" src/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 2: Gate**

Kill the dev server first — `next dev` and `next build` both write `.next/`.

```bash
rm -rf .next
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: green, silent, no new warnings (six pre-existing ones are expected),
build succeeds.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/live-feed-foundation
gh pr create --title "perf: cheap live data path, shared priority rule, and /api/live" --body "$(cat <<'EOF'
## What

The invisible foundation for E11. **No UI change** — the home page renders
byte-identically. What changes is what it costs and what is now available to
build on.

- **`matchPriority`** — the one rule both entry points will render from: live,
  then what is next, then what just happened. Pure and timezone-agnostic.
- **`nowWindowRange`** — seven days back, fourteen forward.
- **`getLiveWindow`** — the same unenriched scoreboard read as `getFixtures`,
  on its own cache key and a 15s TTL.
- **`/api/live`** — all nine competitions merged server-side, so a client polls
  once rather than nine times.
- **The home page moves off the enriching read.**

## The number

One home page render, measured by instrumenting `defaultFetchJson`:

| | before | after |
|---|---|---|
| upstream ESPN requests | **95** | **18** |
| of which per-match `/summary` | 77 | **0** |
| scoreboard | 11 | 11 |
| standings | 7 | 7 |

`getMatches` fetches one `/summary` per match for scorers and cards. The home
page reads `state` and a count, both of which the scoreboard already carries.

## Decisions worth reviewing

- **`matchPriority` has no concept of "today".** It compares instants only. The
  local-date split lands in T11.3's component, after mount — the server runs UTC
  and a reader in UTC−6 disagrees with it about which day an 8pm kickoff falls
  on, so bucketing by date on the server is a hydration mismatch on exactly the
  rows that matter most.
- **A scheduled match whose kickoff passed** stays "upcoming" for three hours,
  then drops out entirely. Past that it is a postponement, and "Next up: a
  fixture from Tuesday" is worse than showing nothing.
- **`getLiveWindow` is a separate method, not a TTL argument to `getFixtures`.**
  Sharing the 120s entry would render "67'" beside a two-minute-old scoreline;
  lowering that TTL globally would triple upstream load on the calendar.
- **`/api/live` catches per competition** rather than settling the whole set, so
  a failure is attributed to the feed that died. Eight competitions still render
  when the ninth is down; only a total outage is a 502.

## Testing

`npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` all clean.

Verified against the running app: `/api/live` returns kickoff-sorted entries
across several competitions, the instrumented home render logs 18 upstream
requests and zero summaries, and the page is visually identical to `main`.

Spec: `docs/superpowers/specs/2026-08-18-dynamic-home-and-matches-design.md`
Plan: `docs/superpowers/plans/2026-08-19-t11-1-live-feed-foundation.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** "One rule in one place" → Task 1. "Unenriched read /
  95→18" → Tasks 3 and 5. "`/api/live` merges nine server-side" → Task 4.
  "Partial failure tolerance" → Task 4 Steps 1 and 4. "Request-cost regression
  test" → Task 5 Step 1. The spec's slices 2 and 3 are deliberately not here.
- **Type consistency.** `PrioritisedMatches` is defined in Task 1 Step 3 and
  used nowhere else in this task — it is T11.2/T11.3's consumer, which is why
  Task 1 tests it directly rather than through a caller. `LiveEntry` is defined
  and consumed inside Task 4. `getLiveWindow`'s signature is declared on the
  interface in Task 3 Step 5 and called in Task 4 Step 4.
- **Known hazard.** Task 3 refactors `getFixtures` into `loadWindow`. Its
  existing tests must pass untouched; if any needs editing, the refactor changed
  behaviour and is wrong.
- **Deliberate deviation from the spec.** The spec says `/api/live` merges with
  `Promise.allSettled`. The implementation uses `Promise.all` over
  per-competition try/catch — identical guarantee, but each failure can be
  attributed to its competition in telemetry rather than counted anonymously.
