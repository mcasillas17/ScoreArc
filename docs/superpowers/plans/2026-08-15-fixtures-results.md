# Fixtures & Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone reach last Saturday's results and next month's fixtures on any of the nine competitions — something ScoreArc cannot do at all today, because `getMatches` is hardcoded to the current Monday–Sunday week.

**Architecture:** A pure `monthRange` helper produces ESPN `dates` strings and a `parseRange` validator guards the API boundary. `getMatches` gains an optional range and keeps its summary enrichment for the live matchday; a new un-enriched `getFixtures` serves the calendar, because one summary request per match does not survive contact with a forty-fixture month. The cache key carries the range so two months cannot collide.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-fixtures-results-design.md`
**Epic:** E3 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `feat/fixtures-results` off latest `origin/main`

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

- TypeScript strict; no `any` in new code.
- Reuse existing CSS tokens and the `MatchDetailPopup`. If E2 has landed, reuse `LiveMatchCard` for the rows rather than writing a second card.
- **One upstream scoreboard request per month navigation.** Not one per match.
- Pure date helpers get Vitest tests with a **fixed `now`** — never `new Date()` in a test.
- `npx tsc --noEmit` clean and `npm test` green before a PR.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run build` while `npm run dev` is running.

---

## File Structure

- `src/server/data/dateRange.ts` — `monthRange`, `parseRange`, `shiftMonth`. Pure.
- `src/server/data/dateRange.test.ts` — their tests.
- `src/server/data/store.ts` — `getMatches(rc, range?)`, new `getFixtures(rc, range)`.
- `src/app/api/[comp]/[season]/fixtures/route.ts` — validated `?range=`.
- `src/components/MatchCalendar.tsx` — month nav + day-grouped list.
- `src/app/c/[comp]/[season]/fixtures/page.tsx` — the route.
- `src/components/Sidebar.tsx` — nav item.
- `src/app/globals.css` — `mc-*` classes (append).

---

### Task 1: Pure date-range helpers

**Files:**
- Create: `src/server/data/dateRange.ts`
- Test: `src/server/data/dateRange.test.ts`

**Interfaces:**
- `monthRange(d: Date): string` — the ESPN `dates` string `YYYYMMDD-YYYYMMDD`
  covering the whole calendar month containing `d`, in local time.
- `shiftMonth(d: Date, delta: number): Date` — first of the month `delta` months
  away. Clamps to the 1st so a 31st never overflows into the next month.
- `parseRange(raw: string | null, maxDays?: number): string | null` — returns the
  range if it is well-formed, ordered and within `maxDays` (default 92);
  otherwise `null`.

- [ ] **Step 1: Write the failing test**

Create `src/server/data/dateRange.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { monthRange, shiftMonth, parseRange } from './dateRange';

describe('monthRange', () => {
  it('covers the whole calendar month', () => {
    expect(monthRange(new Date(2026, 7, 15))).toBe('20260801-20260831');
  });

  it('handles a 30-day month', () => {
    expect(monthRange(new Date(2026, 8, 1))).toBe('20260901-20260930');
  });

  it('handles February in a leap year', () => {
    expect(monthRange(new Date(2028, 1, 10))).toBe('20280201-20280229');
  });

  it('handles February in a non-leap year', () => {
    expect(monthRange(new Date(2026, 1, 10))).toBe('20260201-20260228');
  });
});

describe('shiftMonth', () => {
  it('steps forward across a year boundary', () => {
    const d = shiftMonth(new Date(2026, 11, 15), 1);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
  });

  it('steps backward across a year boundary', () => {
    const d = shiftMonth(new Date(2026, 0, 15), -1);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(11);
  });

  // Naive setMonth on the 31st rolls into the following month: Jan 31 + 1
  // month becomes March 3. Clamping to the 1st is what prevents February
  // being unreachable from January.
  it('does not skip a month when the source day does not exist in the target', () => {
    const d = shiftMonth(new Date(2026, 0, 31), 1);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(1);
  });
});

describe('parseRange', () => {
  it('accepts a well-formed range', () => {
    expect(parseRange('20260801-20260831')).toBe('20260801-20260831');
  });

  it('rejects null and empty', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('')).toBeNull();
  });

  it('rejects a malformed shape', () => {
    expect(parseRange('2026-08-01')).toBeNull();
    expect(parseRange('20260801')).toBeNull();
    expect(parseRange('20260801-')).toBeNull();
    expect(parseRange('abcdefgh-20260831')).toBeNull();
  });

  // This value reaches a URL we build against a third-party API.
  it('rejects an injection attempt that happens to contain digits', () => {
    expect(parseRange('20260801-20260831&limit=999')).toBeNull();
    expect(parseRange('20260801-20260831/../../secret')).toBeNull();
  });

  it('rejects an impossible date', () => {
    expect(parseRange('20260231-20260301')).toBeNull();
    expect(parseRange('20261301-20261331')).toBeNull();
  });

  it('rejects a reversed range', () => {
    expect(parseRange('20260831-20260801')).toBeNull();
  });

  it('accepts a single-day range', () => {
    expect(parseRange('20260801-20260801')).toBe('20260801-20260801');
  });

  // An unbounded span is a cheap way to make ScoreArc fetch something enormous.
  it('rejects a span beyond the cap', () => {
    expect(parseRange('20260101-20261231')).toBeNull();
    expect(parseRange('19000101-20991231')).toBeNull();
  });

  it('honours a custom cap', () => {
    expect(parseRange('20260801-20260810', 5)).toBeNull();
    expect(parseRange('20260801-20260803', 5)).toBe('20260801-20260803');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/dateRange.test.ts`
Expected: FAIL — cannot resolve `./dateRange`.

- [ ] **Step 3: Implement**

Create `src/server/data/dateRange.ts`:

```ts
// ESPN scoreboard `dates` strings are YYYYMMDD-YYYYMMDD in local time. These
// helpers sit beside currentWeekRange and forwardRange in store.ts, which use
// the same format for the live week and the fixture banner respectively.

function fmt(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** The whole calendar month containing `d`. */
export function monthRange(d: Date): string {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  // Day 0 of the next month is the last day of this one, which is how this
  // gets February and the 30-day months right without a lookup table.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${fmt(first)}-${fmt(last)}`;
}

/**
 * The first of the month `delta` months from `d`.
 *
 * Clamped to the 1st deliberately: `new Date(2026, 0, 31)` stepped forward with
 * setMonth lands on March 3, so navigating forward from a 31st would skip
 * February entirely.
 */
export function shiftMonth(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

const RANGE_RE = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/;

/**
 * Validate a client-supplied `dates` range before it is interpolated into a
 * third-party URL.
 *
 * Anchored regex first, then real-date parsing (so 20260231 is rejected rather
 * than silently rolling to March 3), then ordering, then a span cap. The cap
 * exists because an unbounded range is a cheap way to make ScoreArc fetch
 * something enormous on someone else's behalf.
 */
export function parseRange(raw: string | null, maxDays = 92): string | null {
  if (!raw) return null;
  const m = RANGE_RE.exec(raw);
  if (!m) return null;

  const toDate = (y: string, mo: string, d: string): Date | null => {
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const date = new Date(year, month - 1, day);
    // Round-trip check: JS rolls invalid dates over silently, so 2026-02-31
    // becomes March 3 and would otherwise pass.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  };

  const start = toDate(m[1], m[2], m[3]);
  const end = toDate(m[4], m[5], m[6]);
  if (!start || !end) return null;
  if (end.getTime() < start.getTime()) return null;

  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (spanDays > maxDays) return null;

  return raw;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/data/dateRange.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/dateRange.ts src/server/data/dateRange.test.ts
git commit -m "feat: add month-range and range-validation date helpers

parseRange guards a value that reaches a third-party URL: anchored
regex, real-date round-trip (so 20260231 is rejected rather than rolling
to March 3), ordering, and a 92-day span cap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Range-aware store reads

**Files:**
- Modify: `src/server/data/store.ts`
- Test: `src/server/data/store.test.ts`

**Interfaces:**
- `getMatches(rc, range?: string, ttlMs?: number): Promise<Match[]>` — the range
  defaults to `currentWeekRange(new Date())`. Summary enrichment is unchanged.
- `getFixtures(rc, range: string, ttlMs?: number): Promise<Match[]>` — **no**
  enrichment. One upstream request for the whole range.

**Why two functions.** `getMatches` fetches one summary per match. That is right
for a live matchday of ten and ruinous for a calendar month of forty — the exact
trap `getUpcoming`'s comment already documents: *"pulling a summary per match
would turn one request into thirty."* The calendar does not need scorers on every
row; the popup fetches a summary when a match is actually clicked.

- [ ] **Step 1: Write the failing test**

Append to `src/server/data/store.test.ts`:

```ts
describe('range-aware match reads', () => {
  // Adding a range parameter without adding it to the cache key means the
  // first range fetched is served for every later one -- August's results
  // returned for a September request. That reads as a provider bug for a week.
  it('does not serve one range from another range cache entry', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => {
        urls.push(url);
        return { events: [] };
      },
    });

    await store.getFixtures(RC, '20260801-20260831');
    await store.getFixtures(RC, '20260901-20260930');

    expect(urls.filter((u) => u.includes('20260801-20260831'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('20260901-20260930'))).toHaveLength(1);
  });

  it('serves a repeated range from cache', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => { urls.push(url); return { events: [] }; },
    });
    await store.getFixtures(RC, '20260801-20260831');
    await store.getFixtures(RC, '20260801-20260831');
    expect(urls).toHaveLength(1);
  });

  // The calendar must cost one request per month, not one per match.
  it('fetches no per-match summaries for a fixtures range', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => {
        urls.push(url);
        // Two events, so a summary-enriching implementation would betray
        // itself with two extra /summary calls.
        return SCOREBOARD_TWO_EVENTS;
      },
    });
    await store.getFixtures(RC, '20260801-20260831');
    expect(urls.filter((u) => u.includes('/summary'))).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('defaults getMatches to the current week when no range is given', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => { urls.push(url); return { events: [] }; },
    });
    await store.getMatches(RC);
    expect(urls[0]).toMatch(/dates=\d{8}-\d{8}/);
  });
});
```

Reuse whatever `RC` and `MemoryCache` doubles the existing tests in this file use,
and define `SCOREBOARD_TWO_EVENTS` from the existing
`__fixtures__/espn-scoreboard.json` (or a two-event slice of it) rather than
hand-writing a payload — the point is that `mapScoreboard` really produces two
matches.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/data/store.test.ts -t "range-aware"`
Expected: FAIL — `store.getFixtures is not a function`.

- [ ] **Step 3: Implement**

In `src/server/data/store.ts`, add the import:

```ts
import { monthRange, parseRange } from './dateRange';
```

(only `monthRange` if `parseRange` is not used here — the route does the
validating; do not import what you do not use, `npm run lint` will flag it.)

Add both signatures to the `DataStore` interface:

```ts
  getMatches(rc: CompetitionSeason, range?: string): Promise<Match[]>;
  getFixtures(rc: CompetitionSeason, range: string): Promise<Match[]>;
```

Change the `getMatches` implementation's signature and its first three lines:

```ts
    async getMatches(rc, range?: string, ttlMs = 10_000): Promise<Match[]> {
      const window = range ?? currentWeekRange(new Date());
      // The range is part of the identity of this result. Without it in the
      // key, the first window fetched is served for every later one.
      const k = key(rc, `matches:${window}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(scoreboardUrl(slug(rc), window));
```

Leave the rest of `getMatches` exactly as it is — the enrichment loop is correct
for its callers.

Add `getFixtures` beside `getUpcoming`:

```ts
    // A calendar month of results, with NO summary enrichment.
    //
    // getMatches fetches one summary per match, which is right for a live
    // matchday of ten fixtures and ruinous for a month of forty -- the same
    // trap getUpcoming avoids. A calendar row needs kickoff, teams, state and
    // score; the match popup fetches the summary when a match is actually
    // clicked.
    //
    // Longer TTL than getMatches for the same reason: a finished month does
    // not change.
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

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. Existing `getMatches` callers pass no range and are unaffected.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/store.ts src/server/data/store.test.ts
git commit -m "feat: range-aware match reads with the range in the cache key

getMatches gains an optional range (default: the current week, so every
existing caller is unchanged). getFixtures is new and does no summary
enrichment -- one request per month rather than one per match.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The fixtures API route

**Files:**
- Create: `src/app/api/[comp]/[season]/fixtures/route.ts`
- Test: `src/app/api/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/routes.test.ts`, matching the shape the existing route
tests in that file use to build a `Request` and call the handler:

```ts
describe('GET /api/[comp]/[season]/fixtures', () => {
  it('400s on a malformed range without calling the provider', async () => {
    const res = await GET(new Request('http://x/?range=2026-08-01'), { params: { comp: 'liga-mx', season: '2026-27' } });
    expect(res.status).toBe(400);
  });

  it('400s on a reversed range', async () => {
    const res = await GET(new Request('http://x/?range=20260831-20260801'), { params: { comp: 'liga-mx', season: '2026-27' } });
    expect(res.status).toBe(400);
  });

  it('400s on a range beyond the span cap', async () => {
    const res = await GET(new Request('http://x/?range=20260101-20261231'), { params: { comp: 'liga-mx', season: '2026-27' } });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown competition', async () => {
    const res = await GET(new Request('http://x/?range=20260801-20260831'), { params: { comp: 'nope', season: '2026-27' } });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/routes.test.ts -t "fixtures"`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Implement**

Create `src/app/api/[comp]/[season]/fixtures/route.ts`:

```ts
import { dataStore } from '@/server/data/store';
import { resolveSeason } from '@/server/data/competitions';
import { monthRange, parseRange } from '@/server/data/dateRange';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) return Response.json({ error: 'unknown competition or season' }, { status: 404 });

  // `range` is interpolated into a URL we call against a third-party API, so it
  // is validated here rather than trusted. An absent range is fine and means
  // "this month"; a present-but-invalid one is a client error, not a silent
  // fallback -- falling back would hide a broken caller.
  const raw = new URL(req.url).searchParams.get('range');
  const range = raw === null ? monthRange(new Date()) : parseRange(raw);
  if (!range) {
    return Response.json({ error: 'range must be YYYYMMDD-YYYYMMDD, ordered, and at most 92 days' }, { status: 400 });
  }

  try {
    const matches = await dataStore.getFixtures(rc, range);
    return Response.json(matches, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
```

- [ ] **Step 4: Run and verify by hand**

Run: `npx vitest run src/app/api/routes.test.ts`
Expected: PASS.

```bash
npm run dev
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/premier-league/2026-27/fixtures?range=2026-08-01"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/premier-league/2026-27/fixtures?range=20260101-20261231"
curl -s "http://localhost:3000/api/premier-league/2026-27/fixtures?range=20260801-20260831" | head -c 200
```

Expected: `400`, `400`, then a JSON array of August fixtures.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/[comp]/[season]/fixtures/route.ts" src/app/api/routes.test.ts
git commit -m "feat: add the fixtures API route with server-side range validation

An invalid range is a 400, not a silent fallback -- falling back would
hide a broken caller and still fetch something.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `MatchCalendar` — month navigation and day grouping

**Files:**
- Create: `src/components/MatchCalendar.tsx`
- Modify: `src/app/globals.css` (append)

Presentational — verified by running the app.

- [ ] **Step 1: Build the component**

Create `src/components/MatchCalendar.tsx`, a client component that:

1. holds `cursor: Date` (a month), seeded from the server-rendered month;
2. fetches `${apiBase}/fixtures?range=${monthRange(cursor)}` whenever `cursor`
   changes, showing the previous month's rows until the new ones arrive rather
   than blanking;
3. groups matches under day headings (weekday, date) in kickoff order;
4. renders each match with `LiveMatchCard` if E2 has landed, otherwise a local
   row component — **do not** write a second card if `LiveMatchCard` exists;
5. renders prev/next month buttons, disabled outside the season's bounds;
6. opens `MatchDetailPopup` on click, mirroring `UpcomingTicker`'s handling;
7. renders "No matches this month" when the month is empty — a real state for a
   winter break or an international window, not an error.

Scroll today's heading into view on first paint of the current month only.

Append to `src/app/globals.css`:

```css
/* ---- Match calendar ---- */
.mc-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 12px; }
.mc-month { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.mc-nav button { background: var(--surface-2); border: 1px solid var(--hairline); color: var(--text); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.mc-nav button:hover:not(:disabled) { border-color: var(--gold); }
.mc-nav button:disabled { opacity: 0.35; cursor: default; }
.mc-day { margin: 18px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.mc-day--today { color: var(--gold); }
/* Keep the outgoing month visible while the next one loads. Blanking the list
   on every navigation makes a fast fetch feel like a broken one. */
.mc-list--loading { opacity: 0.5; transition: opacity 120ms ease; }
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MatchCalendar.tsx src/app/globals.css
git commit -m "feat: add the match calendar with month navigation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The page and the nav

**Files:**
- Create: `src/app/c/[comp]/[season]/fixtures/page.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Add the page**

Create `src/app/c/[comp]/[season]/fixtures/page.tsx`, mirroring
`standings/page.tsx` for the `resolveSeason` guard, `notFound()`, metadata and
shell markup. Server-render the current month with
`dataStore.getFixtures(rc, monthRange(new Date()))` so first paint is populated,
then hand off to `MatchCalendar`.

- [ ] **Step 2: Add the sidebar item**

Add a "Fixtures & Results" item to both nav arrays in `src/components/Sidebar.tsx`,
matching the `href` / `label` / `match` / `icon` shape the existing items use:

```tsx
  const fixturesItem = {
    href: `${base}/fixtures`,
    label: 'Fixtures & Results',
    match: (path: string) => path.endsWith('/fixtures'),
    icon: fixturesIcon,
  };
```

Add a matching `fixturesIcon` beside the existing icon declarations, in the same
inline-SVG style (a calendar glyph on the shared `ICON` props object).

- [ ] **Step 3: Verify in the browser, on more than one competition**

```bash
npm run dev
```

`http://localhost:3000/c/premier-league/2026-27/fixtures`:

- Opens on the current month, today's heading highlighted and scrolled into view.
- **Back** reaches last month with results — scores present, not kickoff times.
- **Forward** reaches next month with fixtures — kickoff times, no scores.
- Clicking any match opens `MatchDetailPopup`.
- Prev/next are disabled outside the season bounds.

DevTools → Network, filter `scoreboard`, then navigate three months.

Expected: **three** upstream scoreboard requests, one per month. If you see one
per match, `MatchCalendar` is calling `/matches` instead of `/fixtures`.

Repeat on `/c/liga-mx/2026-27/fixtures` and `/c/leagues-cup/2026/fixtures` — the
Leagues Cup is the awkward one, with phase matches and a bracket in the same
month.

- [ ] **Step 4: Commit**

```bash
git add "src/app/c/[comp]/[season]/fixtures/page.tsx" src/components/Sidebar.tsx
git commit -m "feat: add the fixtures and results page

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full gate and PR

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

- [ ] **Step 2: Sweep all nine competitions**

Open `/fixtures` on every competition in `src/server/data/competitions.ts`.
Expected: each renders a month, navigates in both directions, and shows the empty
state rather than an error where a month has no fixtures.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/fixtures-results
gh pr create --title "feat: fixtures and results, any month" --body "$(cat <<'EOF'
## What

ScoreArc could not show last Saturday's results or next month's fixtures on any
competition. `getMatches` took no date argument — its only window was the
Monday–Sunday week containing today, and every match surface in the app was fed
from it.

Adds a Fixtures & Results page with month navigation.

## Approach

Two fetch paths, deliberately:

- `getMatches(rc, range?)` keeps its per-match summary enrichment and gains an
  optional range. The default is unchanged, so every existing caller is untouched.
- `getFixtures(rc, range)` is new and does **no** enrichment — one upstream
  request for a whole month instead of one per match. This is the trap
  `getUpcoming` already documents: *"pulling a summary per match would turn one
  request into thirty."* The popup fetches a summary when a match is clicked.

The range is part of the cache key. Without that, the first month fetched would be
served for every later one — a defect that reads as a provider bug for a week — so
a store test asserts two ranges do not collide.

`?range=` is validated server-side before it reaches a third-party URL: anchored
regex, real-date round-trip (so `20260231` is rejected rather than rolling to
March 3), ordering, and a 92-day span cap. Invalid is a 400, not a silent fallback.

## Testing

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- 20 unit cases on the date helpers, including leap years, month-end overflow on
  `shiftMonth`, and injection attempts that contain digits.
- Store tests assert range cache isolation and zero `/summary` calls for a
  fixtures range.
- Verified in the browser across all nine competitions; three months of
  navigation cost three upstream scoreboard requests.

Plan: `docs/superpowers/plans/2026-08-15-fixtures-results.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** Two fetch paths → Task 2. Range validation → Tasks 1 and 3.
  Cache key → Task 2 Step 1/3. Navigation model → Task 4. Reuse → Task 4 Step 1
  item 4. All eight spec verification bullets appear in Task 5 Step 3 and Task 6
  Step 2.
- **Type consistency.** `monthRange`, `shiftMonth` and `parseRange` are defined in
  Task 1 Step 3 and imported under those names in Tasks 3, 4 and 5. `getFixtures`
  is declared in Task 2 and called in Tasks 3 and 5.
- **Cross-epic dependency.** Task 4 reuses E2's `LiveMatchCard` if present and
  falls back to a local row if not, so E3 does not block on E2.
