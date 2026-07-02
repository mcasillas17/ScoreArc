# Unified Data Layer — Design Spec

**Project:** ScoreArc multi-competition platform
**Sub-project:** #1 of the launch (Leagues Cup + World Cup 2026 by ~Aug 4, 2026)
**Branch/worktree:** `feat/multi-competition`
**Date:** 2026-07-01

---

## Broader context (why this sub-project exists)

ScoreArc is being redesigned from a World-Cup-2026-only tracker into a **multi-competition platform** (memory: "intended to extend to many leagues and tournaments"). The launch turns on two competitions that reuse every existing view: **Leagues Cup** (club crests) and **World Cup 2026** (flags) — both groups/phase + radial bracket, so **no new view types**.

The full launch decomposes into sequential sub-projects, each its own spec → plan → implementation:

1. **Unified data layer** ← *this spec* — the foundation.
2. Multi-competition shell — Hub landing, `/c/[slug]` routing, sidebar competition switcher, crest-vs-flag badges.
3. Generic bracket — derive rings/leaf-order from data, per-competition override.
4. Leagues Cup wiring + polish.
5. *(later)* Storage & processing (shared KV cache + results ledger; ingestion → Postgres for data ownership/history) behind the seam this sub-project introduces. Accounts remain **out of scope / undecided**.

Everything the app consumes flows through the seam defined here, so later swapping the backing implementation (ESPN read-through today → owned pipeline later) requires **no changes to consumers**.

---

## Goal

Replace the hardcoded-`fifa.world` data layer with a **competition-parameterized, unified data-access layer** driven by a **competition registry** and exposed through a single **`DataStore` interface**. After this sub-project, any registered competition's data (starting with WC2026 + Leagues Cup) is fetchable through one consistent seam, cached independently, with **no UI regression** and **zero new infrastructure or dependencies**.

## Non-goals (explicitly deferred to later sub-projects)

- UI: Hub, `/c/[slug]` routing, sidebar switcher, bracket generalization, crest rendering. (This sub-project keeps the current UI working unchanged.)
- External storage (KV/Redis, Postgres), ingestion/cron pipeline, data ownership/history.
- Generic bracket derivation (WC keeps `OFFICIAL_R32_ORDER` via the registry; Leagues Cup bracket handled in sub-project #3).
- Accounts / user data.

---

## Architecture

### 1. Competition registry — `src/server/data/competitions.ts`

The single source of truth describing each competition; drives the data layer now and the UI later.

```ts
export type CompetitionKind = 'national' | 'club';
export type TeamStyle = 'flag' | 'crest';
export type Section = 'bracket' | 'standings' | 'scores' | 'news';

export interface Competition {
  id: string;              // 'world-cup-2026'  (our slug, used in URLs + cache keys)
  name: string;            // 'World Cup 2026'
  shortName: string;       // 'World Cup'
  espnSlug: string;        // 'fifa.world'  (ESPN's league slug)
  kind: CompetitionKind;
  teamStyle: TeamStyle;    // flags for national, crests for club
  emblem: string;          // hub tile glyph (emoji for now)
  sections: Section[];     // which workspace sections apply
  format: {
    hasBracket: boolean;
    hasGroups: boolean;
    hasThirdPlaceRace: boolean; // WC true (8 best 3rd-placed advance); Leagues Cup false
  };
  bracketDatesRange?: string;     // for the date-range scoreboard bracket fetch (e.g. WC '20260628-20260719')
  bracketOrder?: [string, string][]; // identity-based leaf order override (WC); omitted = derive (sub-project #3)
}

export const COMPETITIONS: Record<string, Competition> = { /* world-cup-2026, leagues-cup */ };
export function getCompetition(id: string): Competition | undefined;
export function listCompetitions(): Competition[];
```

- `world-cup-2026`: `espnSlug: 'fifa.world'`, `national`, `teamStyle: 'flag'`, `hasThirdPlaceRace: true`, `bracketDatesRange: '20260628-20260719'`, `bracketOrder: OFFICIAL_R32_ORDER`.
- `leagues-cup`: `espnSlug: 'concacaf.leagues.cup'`, `club`, `teamStyle: 'crest'`, `hasThirdPlaceRace: false`, no `bracketOrder` (derive later).
- **`OFFICIAL_R32_ORDER` moves here** from `RadialBracket.tsx` (it is data, not UI). The bracket component will receive the order via props/config in later sub-projects; for now it can import from the registry.

### 2. Parameterized ESPN endpoints + providers

Replace the module-level constant URLs with slug-taking builders:

```ts
const base = (slug: string) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}`;
export const scoreboardUrl  = (slug: string) => `${base(slug)}/scoreboard`;
export const standingsUrl   = (slug: string) => `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
export const summaryUrl     = (slug: string, event: string) => `${base(slug)}/summary?event=${event}`;
export const bracketUrl      = (slug: string, range?: string) => `${base(slug)}/scoreboard${range ? `?dates=${range}` : ''}`;
export const statisticsUrl  = (slug: string) => `${base(slug)}/statistics`;
export const newsUrl        = (slug: string) => `${base(slug)}/news`;
```

The **mappers are unchanged in logic** (`espn-matches`, `-standings`, `-bracket`, `-summary`, `-stats`, `-news`) — ESPN's JSON shape is the same across competitions; they already take `(raw, ids…)`.

### 3. The `DataStore` seam — `src/server/data/store.ts`

The one interface the rest of the app consumes. Consumers pass a `Competition`; they never see ESPN slugs, URLs, or caches.

```ts
export interface DataStore {
  getMatches(comp: Competition): Promise<Match[]>;
  getStandings(comp: Competition): Promise<Group[]>;
  getBracket(comp: Competition): Promise<BracketRound[]>;
  getMatchSummary(comp: Competition, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getTopScorers(comp: Competition): Promise<TopScorer[]>;
  getNews(comp: Competition): Promise<NewsArticle[]>;
}
```

**Launch implementation — `EspnReadThroughStore`:** the current `service.ts` logic, generalized:
- Every fetch uses `comp.espnSlug` via the URL builders; bracket uses `comp.bracketDatesRange`.
- Cache keys are **competition-scoped**: `${comp.id}:matches`, `${comp.id}:bracket`, `${comp.id}:summary:${eventId}`, etc. — so competitions cache independently in the existing in-memory `TtlCache` (TTLs unchanged). `cache: 'no-store'` ESPN fetch retained.
- Match enrichment (summary → scorers/cards/stats/winProb/shootout) and the `matches`/`bracket`/`groups`/`topscorers`/`news` methods carry over verbatim, now `comp`-scoped.

`export const dataStore: DataStore = new EspnReadThroughStore(new TtlCache());`

### 4. API routes — competition-scoped, back-compat kept

- Add competition-scoped routes: `/api/[comp]/matches`, `/api/[comp]/bracket`, `/api/[comp]/standings`, `/api/[comp]/top-scorers`, `/api/[comp]/news`, `/api/[comp]/match/[id]`. Each resolves `getCompetition(params.comp)` (404 on unknown) and calls the store. `dynamic='force-dynamic'` + `Cache-Control: no-store` retained.
- **Keep the existing routes** (`/api/matches`, …) working by delegating to the store with the `world-cup-2026` competition, so the current UI keeps functioning on the branch until sub-project #2 rewires callers to the scoped routes. (Old routes get removed in #2.)

### 5. Consumers this sub-project touches

- Server components (`app/page.tsx`, `app/standings/page.tsx`, `app/news/page.tsx`) call `dataStore.<method>(worldCup)` instead of `dataService.<method>()`. No visual change.
- Client pollers keep hitting the existing (WC-defaulted) routes for now.

---

## Data flow

`page/route → dataStore.getX(competition) → EspnReadThroughStore → (comp-scoped TtlCache | ESPN via slug URL) → mapper → typed domain object`.

Later (sub-project #5): swap `EspnReadThroughStore` for a KV/ingestion-backed store implementing the same `DataStore` — consumers unchanged.

## Error handling

Unchanged from today: fetch failures throw; server components catch and render empty states; routes return 502. Unknown competition id → 404 from scoped routes / `undefined` from `getCompetition`.

## Testing

- **Registry:** every competition has required fields; ids unique; `world-cup-2026` + `leagues-cup` present with correct `espnSlug`/`teamStyle`.
- **Providers:** existing mapper tests keep passing against WC fixtures. Add a recorded **Leagues Cup fixture** (`__fixtures__/espn-leagues-cup-scoreboard.json`) and assert the store maps its matches (club teams, crests present).
- **Store:** `getMatches`/`getBracket`/etc. plumb `comp.espnSlug`; cache keys are competition-scoped (WC and Leagues Cup cached independently — a fake `fetchJson`/cache verifies no cross-contamination).
- **Back-compat:** all **108 existing tests pass**; legacy routes still return WC data.

## Success criteria

1. `dataStore.getMatches(leaguesCup)` and `dataStore.getMatches(worldCup)` both return correctly-mapped data from their respective ESPN feeds, cached independently, through one interface.
2. No UI regression; the app looks and behaves exactly as today.
3. Zero new dependencies; $0 infrastructure.
4. The seam is the only thing later storage/processing work needs to replace.
