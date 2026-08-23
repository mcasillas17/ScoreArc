# Liga MX Liguilla projection bracket — design

**Date:** 2026-08-22 · **Status:** Approved by user (chat) · **Branch:** `feat/liguilla-bracket`

## What and why

Bring the signature arc-bracket to the Liga MX UX now, months before the
Apertura 2026 Liguilla is drawn. The bracket renders as a **projection from the
live standings** — "if the Liguilla started today" — and updates every
matchday. When the real Liguilla fixtures are published (late November), they
take over the same surface and the projection becomes the fallback.

**Format, verified 2026-08-22:** the Play-In was suspended for Clausura 2026
(World Cup calendar) and then **permanently eliminated by the owners' assembly
starting Apertura 2026**. The top 8 of the general table go straight to
quarterfinals: 1v8, 2v7, 3v6, 4v5, reseeded nowhere in our scope. The existing
standings `qualification: { cut: 8 }` is therefore already correct — no
standings change ships with this feature. (Sources: TUDN, Olympics.com, TV
Azteca, 2026-08.)

## Placement

- `/c/liga-mx/2026-apertura` (the season root) currently redirects to
  `/standings` because a league season "has nothing of its own to show". It
  now does: the root renders the projected bracket, exactly parallel to the
  World Cup's root-is-bracket structure. The redirect stays for league seasons
  **without** a projection config.
- Liga MX's season `sections` gains `'bracket'`, so the section nav shows the
  Bracket tab. Standings, scores, news are untouched.
- The page header labels the projection honestly: an eyebrow with the
  competition/season and a title + note keyed off new i18n entries
  ("Liguilla hoy" / "Si la Liguilla empezara hoy…"). It must never read as a
  real draw.

## Data

New pure module `src/server/data/liguillaProjection.ts`:

```
projectLiguilla(groups: Group[]): BracketRound[] | null
```

- Input: the standings the page already fetches (`dataStore.getStandings`).
  Liga MX publishes one 18-team general table; use the first group with ≥ 8
  standings, ordered by `rank`.
- Output: synthetic rounds `quarterfinals / semifinals / final` shaped exactly
  like a real `BracketRound[]`:
  - Quarters: real `BracketTeam`s paired 1v8, 2v7, 3v6, 4v5. Synthetic ids
    (`proj-qf-1` … `proj-qf-4`), `state: 'pre'`, `kickoff: ''`, null scores,
    `winnerId: null`.
  - Semis and final: all-placeholder teams (`placeholder: true`), ids
    `proj-sf-*`, `proj-f-1` — `RadialBracket` already renders placeholder
    discs (the World Cup pre-draw state uses them).
- Returns `null` when the table cannot seat 8 (missing group, short table,
  duplicate ranks) — the caller shows the existing `bracket.unavailable`
  empty state, never a fabricated bracket.
- Pure and provider-free: no fetching, no ESPN ids in any URL (they stay
  inside `BracketTeam.id` exactly as the real bracket does today).

## Config

`Season` gains an optional flag consumed only by the season root:

```
projection?: 'liguilla'
```

set on Liga MX's `2026-apertura` season via `leagueCompetition(...)`. The
knockout shape for the projection is the existing 3-ring geometry
(`['quarterfinals','semifinals','final']` — the Leagues Cup radii). Because
`competitions.ts` changes, `npm run export:competitions` must run and the
regenerated JSON committed.

## Rendering

- The season root branches: real bracket ready (existing `knockoutIsReady`
  path, unchanged) → `BracketInteractive` as today; else if
  `season.projection === 'liguilla'` → the projection; else → the existing
  redirect for plain leagues.
- The projection renders through `RadialBracket` directly (server page,
  static rounds) — **no** `BracketInteractive`: no polling (nothing live to
  poll), no predictions in v1 (quarters are real but semis/final placeholders
  make picks meaningless mid-season). Crest discs link nowhere new; the
  existing disc → team behavior comes free from `RadialBracket`.
- November switch-over: adding `bracketDatesRange` (+ `hasBracket: true`,
  `knockoutRounds`) to the Liga MX season config makes the real-fixtures
  branch win. One config PR, no code.

## i18n

New keys in `en.ts`/`es.ts` (audited by `uiCopyAudit`):
`bracket.projectionTitle`, `bracket.projectionNote`, and whatever the header
eyebrow needs that `bracket.knockout` does not already cover. Spanish is the
primary voice ("Liguilla hoy"); English mirrors it ("Liguilla today").

## Testing

- `liguillaProjection.test.ts`: correct pairings from an 18-team fixture,
  placeholder semis/final, `null` on short/missing/duplicate-rank tables,
  round slugs match the 3-ring shape.
- Season-root page test: Liga MX renders the projection section; a plain
  league (no `projection`) still redirects; the World Cup path is untouched.
- Visual verification in the browser at three widths inside each media query
  (AGENTS.md rule), on `/es` and `/en`.

## Out of scope (deliberate)

- Predictions/shareable picks on the projection (revisit when the real
  Liguilla starts and all eight teams are fixed).
- Any Play-In modeling — the format no longer has one.
- Home-page teaser of the projection; the Liga MX tile already links to the
  competition.
