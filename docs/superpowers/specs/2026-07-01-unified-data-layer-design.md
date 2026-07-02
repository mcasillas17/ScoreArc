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

### 1. Competition + Season registry — `src/server/data/competitions.ts`

A **durable Competition** (one ESPN league) owns one or more **Seasons** (editions). This split is required because recurring competitions run many editions — and some, like **Liga MX (Torneo Apertura / Clausura)**, run **two per calendar year** — so a single flat id can't identify an edition. ESPN confirms this: its feed reports `season.year` + `season.type.name` (literally `"Torneo Apertura"` for Liga MX).

```ts
export type CompetitionKind = 'national' | 'club';
export type TeamStyle = 'flag' | 'crest';
export type Section = 'bracket' | 'standings' | 'scores' | 'news';

// A specific edition. The season `id` is the URL slug within its competition:
//   '2026' (one-off editions) · '2025-26' (cross-year leagues) ·
//   '2026-apertura' / '2026-clausura' (split leagues like Liga MX).
export interface Season {
  id: string;
  label: string;
  sections: Section[];
  format: { hasBracket: boolean; hasGroups: boolean; hasThirdPlaceRace: boolean };
  bracketDatesRange?: string;         // date-range scoreboard bracket fetch (e.g. '20260628-20260719')
  bracketOrder?: [string, string][];  // identity-based leaf-order override (WC); omitted = derive (sub-project #3)
}

// A durable competition = one ESPN league, across seasons.
export interface Competition {
  id: string;              // 'world-cup', 'leagues-cup', 'liga-mx'  (durable slug)
  name: string;
  shortName: string;
  espnSlug: string;        // ESPN league slug — durable ('fifa.world', 'mex.1')
  kind: CompetitionKind;
  teamStyle: TeamStyle;    // flags for national, crests for club
  emblem: string;          // hub tile glyph
  currentSeasonId: string; // season a hub tile / bare URL resolves to
  seasons: Record<string, Season>;
}

// A resolved (competition, season) pair — what the data store consumes.
export interface CompetitionSeason { competition: Competition; season: Season; }

export const COMPETITIONS: Record<string, Competition> = { /* world-cup, leagues-cup */ };
export function getCompetition(id: string): Competition | undefined;
export function listCompetitions(): Competition[];
// Resolves a (competition, season) pair; seasonId defaults to the current season.
export function resolveSeason(compId: string, seasonId?: string): CompetitionSeason | undefined;
```

- `world-cup` → season `2026`: `espnSlug: 'fifa.world'`, `national`, `teamStyle: 'flag'`, `hasThirdPlaceRace: true`, `bracketDatesRange: '20260628-20260719'`, `bracketOrder: OFFICIAL_R32_ORDER`.
- `leagues-cup` → season `2026`: `espnSlug: 'concacaf.leagues.cup'`, `club`, `teamStyle: 'crest'`, `hasThirdPlaceRace: false`, no `bracketOrder` (derive later).
- **Launch wires *current* seasons only.** ESPN serves the current season by default; historical/other seasons (`?season=`/date-range params) are a later capability.
- **`OFFICIAL_R32_ORDER` moves here** from `RadialBracket.tsx` (data, not UI); the season carries it. `RadialBracket` imports it from the registry.

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

The one interface the rest of the app consumes. Consumers pass a resolved `CompetitionSeason`; they never see ESPN slugs, URLs, or caches.

```ts
export interface DataStore {
  getMatches(rc: CompetitionSeason): Promise<Match[]>;
  getStandings(rc: CompetitionSeason): Promise<Group[]>;
  getBracket(rc: CompetitionSeason): Promise<BracketRound[]>;
  getMatchSummary(rc: CompetitionSeason, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getTopScorers(rc: CompetitionSeason): Promise<TopScorer[]>;
  getNews(rc: CompetitionSeason): Promise<NewsArticle[]>;
}
```

**Launch implementation — `EspnReadThroughStore`:** the current `service.ts` logic, generalized:
- Every fetch uses `rc.competition.espnSlug` via the URL builders; bracket uses `rc.season.bracketDatesRange`.
- Cache keys are **competition + season scoped**: `${comp.id}:${season.id}:matches`, `…:bracket`, `…:summary:${eventId}`, etc. — so editions cache independently in the existing in-memory `TtlCache` (TTLs unchanged). `cache: 'no-store'` ESPN fetch retained.
- Match enrichment (summary → scorers/cards/stats/winProb/shootout) carries over verbatim, now `rc`-scoped. `parseShootout` is exported and directly tested; `emptySummary()` returns a fresh object per call.

`export const dataStore: DataStore = createDataStore({ fetchJson, cache: new TtlCache() });`

### 4. API routes — competition/season-scoped, back-compat kept

- Scoped routes: **`/api/[comp]/[season]/{matches,bracket,standings,top-scorers,news}`** and `/api/[comp]/[season]/match/[id]`. Each resolves `resolveSeason(params.comp, params.season)` (**404** on unknown competition *or* season) and calls the store. `dynamic='force-dynamic'` + `Cache-Control: no-store` retained.
- **Keep the existing routes** (`/api/matches`, …) working by delegating to the store with `resolveSeason('world-cup')` (current WC season), so the current UI keeps functioning on the branch until sub-project #2 rewires callers. (Old routes get removed in #2.)
- The public UI URL scheme (sub-project #2) mirrors this: **`/c/<competition>/<season>`**, with `/c/<competition>` resolving to the current season.

### 5. Consumers this sub-project touches

- Server components (`app/page.tsx`, `app/standings/page.tsx`, `app/news/page.tsx`) call `dataStore.<method>(resolveSeason('world-cup')!)` instead of `dataService.<method>()`. No visual change.
- Client pollers keep hitting the existing (WC-defaulted) routes for now.

---

## Data flow

`page/route → resolveSeason(comp, season) → dataStore.getX(rc) → EspnReadThroughStore → (comp+season-scoped TtlCache | ESPN via slug URL) → mapper → typed domain object`.

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
