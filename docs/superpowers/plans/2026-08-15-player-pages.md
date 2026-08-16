# Player Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ScoreArc player pages — identity, season totals, a last-five-matches game log, career club history and news — with no database and no new provider, using three keyless ESPN endpoints verified live on 2026-08-15.

**Architecture:** A new `espn-athlete.ts` provider maps `/athletes/{id}`, `/athletes/{id}/overview` and `/athletes/{id}/bio` behind the `DataStore` seam. The game log arrives keyed by `eventId`, so each row links straight into the match detail we already render. Three sibling endpoints (`/gamelog`, `/splits`, `/stats`) are dead — 500, 404, 404 — and are deliberately never called.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-player-pages-design.md`
**Epic:** E5 in `docs/PRODUCT_ROADMAP.md`
**Branch:** `feat/player-pages` off latest `origin/main`

## Global Constraints

- TypeScript strict; `any` only inside mappers on raw payloads.
- All fetches go through the `DataStore` seam — no fetch call sites in components.
- Stats are `number | null`; a dash is not a zero.
- **Do not call `/gamelog`, `/splits` or `/stats`.** Verified dead 2026-08-15 (500, 404, 404). No fallback chain, no retry.
- `npx tsc --noEmit` clean and `npm test` green before a PR.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run build` while `npm run dev` is running.

## Note on a corrected assumption

An earlier draft of the roadmap said player pages would ship with "no game log".
That was wrong. `/overview` returns a populated `gameLog` — "Last 5 Matches", ten
stat columns, keyed by `eventId`. What is genuinely missing is a **full-season**
log, cross-season history and per-position percentiles, all of which need E7. The
page states that limit explicitly rather than letting five matches read as a
season.

---

## File Structure

- `src/server/data/endpoints.ts` — three athlete URL builders (append).
- `src/server/data/providers/espn-athlete.ts` — `mapAthleteProfile`, `mapAthleteOverview`, `mapAthleteBio`.
- `src/server/data/providers/espn-athlete.test.ts`
- `src/server/data/__fixtures__/espn-athlete.json`, `espn-athlete-overview.json`, `espn-athlete-bio.json`
- `src/server/data/types.ts` — `PlayerProfile`, `PlayerSeasonTotal`, `GameLogRow`, `CareerStint`.
- `src/server/data/store.ts` — `getPlayer(rc, athleteId)`.
- `src/app/api/[comp]/[season]/player/[athleteId]/route.ts`
- `src/components/PlayerHeader.tsx`, `src/components/PlayerGameLog.tsx`
- `src/app/c/[comp]/[season]/player/[athleteId]/page.tsx`
- `src/app/globals.css` — `pl-*` classes (append).

---

### Task 1: Record the three fixtures

- [ ] **Step 1: Record**

```bash
BASE="https://site.web.api.espn.com/apis/common/v3/sports/soccer/mex.1/athletes/297287"
curl -s "$BASE"          -o src/server/data/__fixtures__/espn-athlete.json
curl -s "$BASE/overview" -o src/server/data/__fixtures__/espn-athlete-overview.json
curl -s "$BASE/bio"      -o src/server/data/__fixtures__/espn-athlete-bio.json
```

- [ ] **Step 2: Verify what they carry**

```bash
node -e "
const a = require('./src/server/data/__fixtures__/espn-athlete.json').athlete;
console.log('athlete:', a.displayName, a.age, a.position.displayName, '| team', a.team.displayName);
console.log('headshot:', a.headshot ? a.headshot.href : 'NONE');
console.log('summary:', a.statsSummary.displayName);
for (const s of a.statsSummary.statistics) console.log('   ', s.name, '=', s.displayValue);
const o = require('./src/server/data/__fixtures__/espn-athlete-overview.json');
console.log('gameLog:', o.gameLog.displayName, '| events', o.gameLog.statistics[0].events.length);
console.log('  labels:', o.gameLog.statistics[0].names.join(','));
const b = require('./src/server/data/__fixtures__/espn-athlete-bio.json');
console.log('teamHistory:', b.teamHistory.map(t => t.displayName + ' ' + t.seasons).join(' | '));
"
```

Expected: Ali Avila, 22, Forward, Querétaro; **`headshot: NONE`**; a
`"2026-27 Liga MX Stats"` summary with `totalGoals = 3` and `totalShots = 9`;
a `"Last 5 Matches"` game log; a Querétaro `2025-CURRENT` stint.

The `headshot: NONE` line is why Task 4 lays the header out for a missing
headshot rather than treating it as an edge case.

- [ ] **Step 3: Commit**

```bash
git add src/server/data/__fixtures__/espn-athlete*.json
git commit -m "test: record athlete profile, overview and bio fixtures

Liga MX Ali Avila (297287). /overview carries a populated last-five game
log keyed by eventId; this player has no headshot, which the layout has
to survive.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Endpoints and types

**Interfaces:**
- `athleteUrl(slug, id)`, `athleteOverviewUrl(slug, id)`, `athleteBioUrl(slug, id)`
- `PlayerSeasonTotal` — `{ name: string; label: string; display: string; value: number | null }`
- `GameLogRow` — `{ eventId: string; appearance: string; stats: Record<string, number | null> }`
- `CareerStint` — `{ teamId: string; teamName: string; crestUrl: string | null; seasons: string }`
- `PlayerProfile` — `{ id, name, age, position, jersey, nationality, flagUrl, headshotUrl, team, seasonLabel, totals, gameLog, gameLogLabel, career }`

- [ ] **Step 1: Write the failing endpoint test**

Append to `src/server/data/endpoints.test.ts`:

```ts
describe('athlete endpoints', () => {
  it('builds athlete urls on the web api host', () => {
    expect(athleteUrl('mex.1', '297287')).toBe(
      'https://site.web.api.espn.com/apis/common/v3/sports/soccer/mex.1/athletes/297287');
    expect(athleteOverviewUrl('mex.1', '297287')).toBe(
      'https://site.web.api.espn.com/apis/common/v3/sports/soccer/mex.1/athletes/297287/overview');
    expect(athleteBioUrl('mex.1', '297287')).toBe(
      'https://site.web.api.espn.com/apis/common/v3/sports/soccer/mex.1/athletes/297287/bio');
  });

  it('encodes the athlete id', () => {
    expect(athleteUrl('mex.1', '../x')).not.toContain('../');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/data/endpoints.test.ts` — expected FAIL, builders
not exported.

- [ ] **Step 3: Add the builders**

Append to `src/server/data/endpoints.ts`:

```ts
// Athletes live on a DIFFERENT host and a different API version from everything
// else in this file -- site.web.api / common/v3, not site.api / site/v2. Verified
// keyless and HTTP 200 on 2026-08-15 for mex.1/athletes/297287.
//
// Three sibling paths are dead and must not be called: /gamelog returns 500,
// /splits and /stats return 404. The game log comes from /overview.
const webCommon = (slug: string) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/soccer/${slug}`;

export const athleteUrl = (slug: string, athleteId: string) =>
  `${webCommon(slug)}/athletes/${encodeURIComponent(athleteId)}`;

export const athleteOverviewUrl = (slug: string, athleteId: string) =>
  `${webCommon(slug)}/athletes/${encodeURIComponent(athleteId)}/overview`;

export const athleteBioUrl = (slug: string, athleteId: string) =>
  `${webCommon(slug)}/athletes/${encodeURIComponent(athleteId)}/bio`;
```

- [ ] **Step 4: Add the types to `src/server/data/types.ts`**

```ts
// One headline season figure as ESPN pre-aggregates it. `display` is kept
// alongside `value` because some are not plain numbers -- starts-subIns comes
// through as "3 (0)" and rendering it as 3 loses the substitute appearances.
export interface PlayerSeasonTotal {
  name: string;
  label: string;
  display: string;
  value: number | null;
}

// One row of the last-five game log. Keyed by eventId, which is the same id the
// match popup takes -- so a row is a link into detail we already render.
export interface GameLogRow {
  eventId: string;
  appearance: string; // "Started" | "Sub"
  stats: Record<string, number | null>;
}

export interface CareerStint {
  teamId: string;
  teamName: string;
  crestUrl: string | null;
  seasons: string; // e.g. "2025-CURRENT"
}

export interface PlayerProfile {
  id: string;
  name: string;
  age: number | null;
  position: string;
  jersey: string | null;
  nationality: string | null;
  flagUrl: string | null;
  headshotUrl: string | null; // frequently null -- lay out for its absence
  team: Team | null;
  seasonLabel: string; // e.g. "2026-27 Liga MX Stats"
  totals: PlayerSeasonTotal[];
  gameLogLabel: string; // e.g. "Last 5 Matches"
  gameLog: GameLogRow[];
  career: CareerStint[];
}
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run src/server/data/endpoints.test.ts` — PASS.
Run: `npx tsc --noEmit` — clean.

```bash
git add src/server/data/endpoints.ts src/server/data/endpoints.test.ts src/server/data/types.ts
git commit -m "feat: add athlete endpoint builders and player profile types

Athletes live on site.web.api / common/v3, a different host and API
version from every other endpoint in this file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The athlete mappers

**Files:**
- Create: `src/server/data/providers/espn-athlete.ts`
- Test: `src/server/data/providers/espn-athlete.test.ts`

**Shape note.** The game log is column-oriented, not row-oriented:
`gameLog.statistics[0]` holds a `names[]` array of column keys and an `events[]`
array whose `stats[]` are **positional strings** aligned to those names. The first
column is the appearance string (`"Started"` / `"Sub"`), not a number. Zip
`names` against `stats` by index — and read `names` from the payload rather than
hardcoding the column order, because the order is the provider's to change.

- [ ] **Step 1: Write the failing test**

Create `src/server/data/providers/espn-athlete.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapAthleteProfile, mapAthleteOverview, mapAthleteBio } from './espn-athlete';
import athleteRaw from '../__fixtures__/espn-athlete.json';
import overviewRaw from '../__fixtures__/espn-athlete-overview.json';
import bioRaw from '../__fixtures__/espn-athlete-bio.json';

describe('mapAthleteProfile', () => {
  const p = mapAthleteProfile(athleteRaw)!;

  it('maps identity', () => {
    expect(p.name).toBe('Ali Avila');
    expect(p.age).toBe(22);
    expect(p.position).toBe('Forward');
    expect(p.nationality).toBe('Mexico');
    expect(p.team!.name).toBe('Querétaro');
  });

  // Headshots are frequently absent. Null is the correct mapping, and the
  // layout has to survive it -- not a placeholder URL that 404s.
  it('maps a missing headshot to null', () => {
    expect(p.headshotUrl).toBeNull();
  });

  it('maps the season totals with their labels', () => {
    expect(p.seasonLabel).toBe('2026-27 Liga MX Stats');
    const goals = p.totals.find((t) => t.name === 'totalGoals')!;
    expect(goals.value).toBe(3);
    const shots = p.totals.find((t) => t.name === 'totalShots')!;
    expect(shots.value).toBe(9);
  });

  // "3 (0)" is starts and substitute appearances. Coercing it to 3 silently
  // discards the second number.
  it('keeps the display string for a compound stat', () => {
    const starts = p.totals.find((t) => t.name === 'starts-subIns')!;
    expect(starts.display).toBe('3 (0)');
  });

  it('returns null for a malformed payload', () => {
    expect(mapAthleteProfile({})).toBeNull();
    expect(mapAthleteProfile(null)).toBeNull();
  });
});

describe('mapAthleteOverview', () => {
  const o = mapAthleteOverview(overviewRaw);

  it('maps the game log label and rows', () => {
    expect(o.label).toBe('Last 5 Matches');
    expect(o.rows.length).toBeGreaterThan(0);
  });

  // The stats array is positional against a names array. Zipping by index is
  // the whole mapping; getting it wrong silently shifts every column.
  it('zips positional stats against their column names', () => {
    const row = o.rows.find((r) => r.eventId === '401863615')!;
    expect(row.appearance).toBe('Started');
    expect(row.stats.totalGoals).toBe(1);
    expect(row.stats.totalShots).toBe(1);
    expect(row.stats.foulsCommitted).toBe(4);
    expect(row.stats.offsides).toBe(2);
  });

  it('distinguishes a substitute appearance', () => {
    const row = o.rows.find((r) => r.eventId === '401863600')!;
    expect(row.appearance).toBe('Sub');
  });

  it('returns an empty log for a malformed payload', () => {
    expect(mapAthleteOverview({}).rows).toEqual([]);
    expect(mapAthleteOverview(null).rows).toEqual([]);
  });
});

describe('mapAthleteBio', () => {
  it('maps the career club history', () => {
    const career = mapAthleteBio(bioRaw);
    expect(career.length).toBeGreaterThan(0);
    expect(career[0].teamName).toBe('Querétaro');
    expect(career[0].seasons).toBe('2025-CURRENT');
  });

  it('returns [] for a malformed payload', () => {
    expect(mapAthleteBio({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/data/providers/espn-athlete.test.ts`
Expected: FAIL — cannot resolve `./espn-athlete`.

- [ ] **Step 3: Implement**

Create `src/server/data/providers/espn-athlete.ts`. The game-log zip is the part
worth writing carefully:

```ts
/**
 * The game log is column-oriented: `names` holds the column keys and each
 * event's `stats` holds positional strings aligned to them. The first column is
 * the appearance ("Started" / "Sub"), which is a word, not a number.
 *
 * Column order is the provider's to change, so the names array is read from the
 * payload rather than hardcoded -- a hardcoded order would keep parsing
 * successfully while shifting every value one column to the left.
 */
export function mapAthleteOverview(raw: unknown): { label: string; rows: GameLogRow[] } {
  try {
    const log: any = (raw as any)?.gameLog ?? {};
    const block: any = log.statistics?.[0] ?? {};
    const names: string[] = block.names ?? [];
    const rows: GameLogRow[] = (block.events ?? []).map((e: any): GameLogRow => {
      const values: string[] = e?.stats ?? [];
      const stats: Record<string, number | null> = {};
      // Skip index 0: it is the appearance word, not a stat.
      for (let i = 1; i < names.length; i++) {
        const n = Number(values[i]);
        stats[names[i]] = Number.isFinite(n) ? n : null;
      }
      return {
        eventId: String(e?.eventId ?? ''),
        appearance: values[0] ?? '',
        stats,
      };
    });
    return { label: log.displayName ?? '', rows };
  } catch {
    return { label: '', rows: [] };
  }
}
```

Check the fixture before trusting the "skip index 0" assumption: confirm
`names[0]` is `appearances` and `stats[0]` is the word `"Started"`. If the
provider aligns them differently, follow the fixture, not this comment.

Write `mapAthleteProfile` and `mapAthleteBio` in the same defensive style,
returning `null` / `[]` on malformed input.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/data/providers/espn-athlete.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/data/providers/espn-athlete.ts src/server/data/providers/espn-athlete.test.ts
git commit -m "feat: map athlete profile, game log and career history

The game log is column-oriented -- positional stat strings zipped against
a names array read from the payload, since a hardcoded column order would
keep parsing while shifting every value.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Store, route and page

**Interfaces:**
- `getPlayer(rc, athleteId, ttlMs?): Promise<PlayerProfile | null>` — profile,
  overview and bio in parallel; `null` if the profile fails; overview and bio
  degrade to empty blocks.

- [ ] **Step 1: Write the failing store test**

Append to `src/server/data/store.test.ts`:

```ts
describe('getPlayer', () => {
  it('fetches profile, overview and bio in parallel and caches', async () => {
    const urls: string[] = [];
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => {
        urls.push(url);
        if (url.endsWith('/overview')) return overviewRaw;
        if (url.endsWith('/bio')) return bioRaw;
        return athleteRaw;
      },
    });
    const p = await store.getPlayer(RC, '297287');
    expect(p!.name).toBe('Ali Avila');
    expect(p!.gameLog.length).toBeGreaterThan(0);
    expect(urls).toHaveLength(3);
    await store.getPlayer(RC, '297287');
    expect(urls).toHaveLength(3);
  });

  // A dead sibling endpoint must not take the page down with it.
  it('still returns a profile when overview and bio fail', async () => {
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async (url: string) => {
        if (url.endsWith('/overview') || url.endsWith('/bio')) throw new Error('500');
        return athleteRaw;
      },
    });
    const p = await store.getPlayer(RC, '297287');
    expect(p!.name).toBe('Ali Avila');
    expect(p!.gameLog).toEqual([]);
    expect(p!.career).toEqual([]);
  });

  it('returns null when the profile fetch fails', async () => {
    const store = createDataStore({
      cache: new MemoryCache(),
      fetchJson: async () => { throw new Error('502'); },
    });
    expect(await store.getPlayer(RC, '297287')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/data/store.test.ts -t "getPlayer"`
Expected: FAIL — `store.getPlayer is not a function`.

- [ ] **Step 3: Implement `getPlayer`**

Follow the shape of `getTeam` (E4) if it has landed, or the same pattern if not:
`Promise.all` with `.catch(() => null)` on the two optional payloads, a single
cache entry keyed `player:${athleteId}`, `null` when the profile itself fails.

- [ ] **Step 4: Add the API route**

Create `src/app/api/[comp]/[season]/player/[athleteId]/route.ts`, modelled on the
existing routes: 404 for unknown competition or unknown player, 502 on provider
failure.

- [ ] **Step 5: Build the page**

Create `src/app/c/[comp]/[season]/player/[athleteId]/page.tsx` plus
`PlayerHeader` and `PlayerGameLog`. Five blocks, per the spec: header, season
totals, last five, career, news.

**Header must survive a null headshot.** Ali Avila has none, and he is the
fixture. Use the shirt-number/initials fallback — never a broken `<img>` and never
an empty grey frame.

**Totals** render `display`, not `value`. `starts-subIns` is `"3 (0)"`; showing
`3` discards the substitute appearances.

**Game log** rows link to their match by `eventId`, opening `MatchDetailPopup`.

**State the ceiling** directly under the log:

```tsx
<p className="pl-ceiling">
  Showing the last five matches — the deepest history this data source
  publishes. Full-season and multi-season history are coming.
</p>
```

**Career** uses `TeamBadge` linking to E4's team page if it has landed, plain
otherwise.

**News** reuses `NewsList`.

- [ ] **Step 6: Verify in the browser**

```bash
npm run dev
```

`http://localhost:3000/c/liga-mx/2026-27/player/297287`:

- Ali Avila, 22, Forward, Querétaro, Mexico flag.
- Season totals show 3 goals, 9 shots, and starts as **`3 (0)`** — not `3`.
- **No headshot, and the header still looks deliberate** — this is the case the
  layout exists to handle.
- Five game-log rows, `Started` / `Sub` distinguished, each opening the right
  match.
- The ceiling note is visible under the log.
- Career shows Querétaro, 2025–current.

Now try a player from a different competition — e.g. a Premier League scorer via
`/c/premier-league/2026-27/player/<id>` — to confirm the endpoint is not
Liga-MX-only in practice.

- [ ] **Step 7: Commit**

```bash
git add src/server/data/store.ts src/server/data/store.test.ts "src/app/api/[comp]/[season]/player/[athleteId]/route.ts" "src/app/c/[comp]/[season]/player/[athleteId]/page.tsx" src/components/PlayerHeader.tsx src/components/PlayerGameLog.tsx src/app/globals.css
git commit -m "feat: add player pages with season totals and a last-five game log

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Link players from everywhere they appear

**Files:**
- Modify: `src/components/LeaderTable.tsx` (E1) or `TopScorersTable.tsx` (if E1 has not landed)
- Modify: `src/components/MatchExtras.tsx`, `src/components/MatchStats.tsx`

**A blocker to resolve first, before writing any code.** The leaderboard mapper
does **not** currently carry an athlete id — `StatLeader` has `player` (a display
name) and no id. A name is not a key, and linking by name would break on
accents, initials and namesakes.

- [ ] **Step 1: Check whether the id is in the payload**

```bash
node -e "
const d = require('./src/server/data/__fixtures__/espn-statistics.json');
const l = d.stats.find(s => s.name === 'goalsLeaders').leaders[0];
console.log('athlete id:', l.athlete.id, '| name:', l.athlete.displayName);
"
```

If an id is present, add `athleteId: string | null` to `StatLeader` and map it —
that is a three-line change in `mapLeaders` plus its test.

If it is **not** present, stop and do not link from the leaderboards. Link only
from lineups and scorer lines, where `participants[0].athlete.id` is available,
and record the leaderboard gap in the roadmap as a follow-up. Do not fall back to
name matching.

- [ ] **Step 2: Add the ids and the links**

Thread `athleteId` through, and render player names as links wherever a real id
exists. Where it does not, render plain text — the same rule as E4's bracket
placeholders.

- [ ] **Step 3: Verify**

Run: `npm test` and `npx tsc --noEmit` — expected green and clean.

```bash
npm run dev
```

Golden Boot, assists board, match lineups and scorer lines all navigate to the
right player. A player with no id is plain text, not a dead link.

- [ ] **Step 4: Commit**

```bash
git add src/components src/server/data
git commit -m "feat: link player names to player pages

Links only where a real athlete id exists -- names are not keys, and a
name match would break on accents and namesakes.

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

- [ ] **Step 2: Check the request count**

DevTools → Network on a player page.
Expected: **three** upstream requests — profile, overview, bio. Not one per match
in the log.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/player-pages
gh pr create --title "feat: player pages" --body "$(cat <<'EOF'
## What

ScoreArc had no people in it — a player's name in the Golden Boot, a lineup or a
scorer line led nowhere. This adds
`/c/[comp]/[season]/player/[athleteId]`: identity, season totals, a last-five
game log, career club history and news.

**No database and no new provider.** Three keyless ESPN endpoints, verified live
2026-08-15 against Liga MX athlete 297287 (Ali Avila) — which matters because
Liga MX and MLS are exactly where most free providers stop.

## A corrected assumption

The roadmap said player pages would ship with "no game log". That was wrong:
`/overview` carries a populated `gameLog` — "Last 5 Matches", ten stat columns,
keyed by `eventId`, so every row links into match detail we already render.

What is genuinely missing is a **full-season** log, cross-season history and
per-position percentiles, all gated on E7. The page says so directly under the
log rather than letting five matches read as a season.

## Notes

- `/gamelog` (500), `/splits` (404) and `/stats` (404) are dead. Never called, no
  fallback chain.
- The game log is column-oriented — positional stat strings zipped against a
  `names` array read from the payload. Hardcoding the column order would keep
  parsing successfully while shifting every value one column left.
- `headshot` is null for the fixture player. The header is laid out for its
  absence rather than treating it as an edge case.
- `starts-subIns` renders as its display string `"3 (0)"`; coercing to `3` would
  silently discard substitute appearances.
- Player names link **only** where a real athlete id exists. Names are not keys.

## Testing

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- Mapper tests cover the positional zip, `Started` vs `Sub`, the null headshot and
  the compound display string.
- Store tests cover parallel fetch, caching, and degrading to empty blocks when
  `/overview` and `/bio` fail without taking the page down.

Plan: `docs/superpowers/plans/2026-08-15-player-pages.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** Route → Task 4. Page structure blocks 1–5 → Task 4 Step 5.
  Ceiling statement → Task 4 Step 5. Reuse → Tasks 4 and 5. All six spec
  verification bullets appear in Task 4 Step 6 and Task 6 Step 2.
- **Type consistency.** `PlayerSeasonTotal`, `GameLogRow`, `CareerStint` and
  `PlayerProfile` are defined in Task 2 Step 4 and consumed under those names in
  Tasks 3 and 4. `mapAthleteOverview` returns `{ label, rows }` in Task 3 and is
  destructured under those names in Task 4.
- **Genuine unknown, surfaced rather than assumed.** Task 5 Step 1 checks whether
  the leaderboard payload carries an athlete id before any linking code is
  written, and states what to do in both outcomes.
- **Cross-epic dependencies.** Task 5 targets E1's `LeaderTable` or the current
  `TopScorersTable`; Task 4 links career clubs to E4's team page only if it exists.
