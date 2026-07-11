# World Cup Past Editions (read-only) — Design

**Date:** 2026-07-11
**Branch:** `feat/wc-past-editions`
**Status:** Approved (design)

## Problem

ScoreArc only shows **World Cup 2026**. Users can't browse previous editions (2022, 2018, …).
ESPN's keyless API (`fifa.world` league) actually serves every modern edition's results by date
range — verified live back to 1998 (e.g. `dates=20221214-20221218` → the 2022 semis + final;
`dates=20140708-20140714` → BRA 1–7 GER). What's missing is (a) season configs for past editions,
and (b) a bracket that can render a shape other than 2026's.

The blocker is format: **2026 is a 48-team tournament whose knockout starts at the Round of 32
(5 rings, 16 leaf pairings). Every edition 1998–2022 is a 32-team tournament whose knockout starts
at the Round of 16 (4 rings, 8 leaf pairings).** `RadialBracket` hardcodes the 2026 shape via a
module-level `RINGS` array and `OFFICIAL_R32_ORDER`.

## Goal

Let users switch to and browse **past World Cup editions (1998–2022)** — the knockout bracket and
scores — served live from ESPN, with the existing bracket animation replaying each finished
tournament forward to its champion. No new storage; read-only.

This is the first of three linked sub-projects (past-editions → persistence foundation → stats
features). Persistence and stats are **out of scope here** and get their own specs.

## Scope

**In scope**
- Season configs for **1998, 2002, 2006, 2010, 2014, 2018, 2022** under the `world-cup` competition.
- A generalized `RadialBracket` that renders an N-round bracket (4-ring R16 or 5-ring R32) from the
  season config.
- A **season switcher** on the competition page.
- Past editions show **bracket + scores** only.
- The bracket animation **replays** a finished edition R16 → Final → champion (existing timeline,
  no change needed).

**Out of scope (explicit non-goals)**
- Persistence / storing data on our side (separate spec).
- Stats features / cross-edition comparisons (separate spec).
- Historical **group standings** and **news** for past editions (ESPN's standings endpoint is
  current-season-only; no reliable keyless historical group tables).
- Pre-1998 / 24-team (or smaller) formats.
- Past seasons of non-World-Cup competitions (Leagues Cup, leagues) — the generalization should not
  preclude them, but they are not built here.
- Predict mode ("Build your bracket") for past editions — past editions are view-only.

## Architecture

### Chosen approach: config-driven bracket shape

The season config becomes the single source of truth for a bracket's shape. `RadialBracket` derives
its ring geometry and leaf order from the season instead of module constants. One render path handles
4-ring and 5-ring brackets (and any future shape). Rejected alternatives: two hardcoded presets
(duplicative, only two shapes) and padding past editions into a 5-ring layout (visually wrong).

### 1. Season config (`src/server/data/competitions.ts`)

Extend the `Season` interface with an explicit, ordered knockout description:

- `knockoutRounds: string[]` — round slugs outer→inner, e.g.
  `['round-of-16','quarterfinals','semifinals','final']` (past) or
  `['round-of-32','round-of-16','quarterfinals','semifinals','final']` (2026).
- `bracketOrder: [string,string][]` — the leaf-round seed pairings by team abbr, in bracket
  (angular) order. 2026 = the existing 16-pair `OFFICIAL_R32_ORDER`; past editions = 8 R16 pairs,
  hardcoded per edition from the known bracket.
- `bracketDatesRange` — the edition's knockout window (already exists on the interface).
- `sections` — past editions use `['bracket','scores']`.

Read-only is **derived**, not a new field: a season is view-only when
`season.id !== competition.currentSeasonId` (past editions are anything that isn't the current one).

Add the seven past seasons to `COMPETITIONS['world-cup'].seasons`. `OFFICIAL_R32_ORDER` moves into
2026's `bracketOrder`; past editions each get a `BRACKET_ORDER_<year>` constant (8 pairs).

**Sourcing note:** each edition's `bracketOrder` + `bracketDatesRange` is verified data entry from
the known bracket during implementation, not derived at runtime.

### 2. Bracket-shape helper (new, pure)

`bracketShapeFor(season) → { ringGeometry, knockoutRounds, bracketOrder }` where `ringGeometry` is
the tuned per-ring `{ slug, rx, ry, discR }` array. Ring geometry is a **tuned preset keyed by ring
count** (a `RING_GEOMETRY_BY_COUNT` map with entries for 4 and 5 rings) — computed spacing reads
worse than hand-tuned radii, and only two counts occur in practice. The helper is pure and
unit-testable in isolation from React.

### 3. `buildRings` generalization (`RadialBracket.tsx` / `radialBracketModel.ts`)

Currently `buildRings` hardcodes the `round-of-32` leaf and `RINGS`. Generalize it to take the
season's `ringGeometry`, `knockoutRounds`, and `bracketOrder`:
- Seed the leaf ring (`knockoutRounds[0]`) using `bracketOrder` (via a generalized `officialLeafOrder`
  that works for 8 or 16 pairs).
- Iterate inward over the remaining `knockoutRounds`, same winner-propagation logic as today.
- Index ring geometry by depth `0..N-1`.

`teamJourney`, the connector rendering, `InnerHop`, the `simRound` timeline, greyscale — all already
iterate over `rings`/`RINGS` generically and need **no shape-specific change**; they inherit N rings.

### 4. `RadialBracket` wiring

`RadialBracket` receives the bracket shape as a **`shape` prop**, computed by the caller
(`page.tsx`/`BracketInteractive`) via `bracketShapeFor(season)` — `RadialBracket` itself does no
config lookup. Replace reads of module-level `RINGS` / `OFFICIAL_R32_ORDER` with `shape`. `CREST_SCALE`, disc rendering, connectors, and the animation
are unchanged.

Data flow: `page.tsx` resolves the season → passes the season (or its shape) down through
`BracketInteractive` → `RadialBracket` → `buildRings`.

### 5. Season switcher (UI)

A small control on the competition page (`src/app/c/[comp]/[season]/page.tsx`) listing the
competition's seasons newest-first, each linking to `/c/<comp>/<seasonId>` (routing already
supports arbitrary season ids). The current edition is highlighted. Rendered only when a
competition has more than one season.

### 6. Read-only past editions

`BracketInteractive` hides the "Build your bracket" (predict) tab and skips the 15s live-refresh
poll when the season is read-only (finished edition). The bracket animation still plays: for a
finished edition `maxDepth` is the final, so the existing timeline replays to the champion.

### 7. Data layer

No new fetch call sites. `dataStore.getBracket(rc)` already fetches the scoreboard for
`season.bracketDatesRange` and maps to `BracketRound[]`; for a past edition it returns
`[round-of-16, quarterfinals, semifinals, final]`. Confirm the ESPN bracket mapper buckets those
rounds correctly (it maps whatever rounds ESPN returns; verify with a 2022 fixture). Scores reuse
the existing matches path over the edition's date range.

## Data flow

```
/c/world-cup/2022  ->  resolveSeason() -> CompetitionSeason (season '2022')
                        |
   page.tsx: season.sections -> render <BracketInteractive> (bracket) + scores
                        |
   dataStore.getBracket(rc)  -> ESPN scoreboard(bracketDatesRange) -> BracketRound[]
                        |
   bracketShapeFor(season) -> { ringGeometry(4), knockoutRounds(4), bracketOrder(8) }
                        |
   RadialBracket(rounds, shape) -> buildRings(...) -> 4-ring rings[][]
                        |
   simRound timeline replays R16 -> Final -> champion
```

## Error handling

- A past edition with missing/incomplete ESPN data for its window: the bracket renders whatever
  rounds resolve (placeholders for undecided), same as today's live behavior — it never throws.
- A `bracketOrder` whose pairings don't match the fetched teams: `officialLeafOrder` already falls
  back to plain event order (existing behavior) — degraded but non-fatal; flagged in tests.
- Unknown season id in the URL: existing `resolveSeason` handling (redirect/404) is unchanged.

## Testing

- **Unit:** `bracketShapeFor` returns the 4-ring geometry + 8-pair order for a past season and the
  5-ring geometry + 16-pair order for 2026; the generalized `officialLeafOrder` maps 8 and 16 pairs
  correctly (and falls back on mismatch); `teamJourney` unchanged (existing tests still green).
- **Fixture:** record a real 2022 knockout scoreboard into `__fixtures__/`; test the ESPN bracket
  mapper + `buildRings` produce a correct 4-round tree (R16 → champion), including the winner
  propagation and greyscale/elimination depths.
- **Visual (in-app):** open 2022 and 2014 — the 4-ring bracket renders correctly, teams sit on the
  right rings, the replay plays R16 → Final and crowns the champion; the season switcher navigates
  between editions; 2026 still renders its 5-ring bracket unchanged.

## Rollout / risk

- Low risk: additive config + a contained generalization of an already depth-agnostic component.
- 2026 must be byte-for-byte visually unchanged (regression guard: 2026 uses the same code path with
  its 5-ring geometry + 16-pair order).
- Each past edition's `bracketOrder`/date range is verified during implementation against the known
  bracket before it ships.
