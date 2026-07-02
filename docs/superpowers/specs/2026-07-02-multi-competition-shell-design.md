# Multi-Competition Shell (UX Redesign) — Design Spec

**Project:** ScoreArc multi-competition platform
**Sub-project:** #2 of the launch (Leagues Cup + World Cup 2026)
**Branch/worktree:** `feat/multi-competition` (continues on the same branch as sub-project #1)
**Date:** 2026-07-02

---

## Context

Sub-project #1 built the unified, competition+season-parameterized data layer behind a `DataStore` seam, with `/api/<competition>/<season>/*` routes. The app UI is still World-Cup-only. This sub-project is the **UX redesign** that turns ScoreArc into a real multi-competition app, using the design the user approved in the visual companion:

- **Competition Hub** landing (grid of competition tiles, grouped by status).
- **Sidebar competition switcher** once inside a competition (hop without returning to the Hub).
- **Competition workspace** at `/c/<competition>/<season>` — the current bracket + live-scores + standings + news, scoped to the competition and rendered with its team style (flags for national, **crests for clubs**).

## Goal

Ship a browsable multi-competition experience: a Hub at `/`, competition workspaces at `/c/<competition>/<season>`, a sidebar that switches competitions, and team badges + bracket that adapt to national (flag) vs club (crest) competitions — with **World Cup 2026 and Leagues Cup both fully usable**. The whole app reads through the season-scoped API; legacy WC routes/pages are removed.

## Non-goals (deferred)

- Storage/processing pipeline (KV/Postgres) — behind the existing `DataStore` seam, later.
- Generic bracket derivation for arbitrary formats — WC keeps its `bracketOrder`; Leagues Cup's bracket is validated against real data as it fills in (sub-project #3). Single-table league views (no bracket) are phase 2.
- Historical/multi-season selection UI (registry supports it; UI wires current season only).
- Accounts.

---

## Architecture

### 1. Routing & pages

| Route | Purpose |
|---|---|
| `/` | **Hub** — competition tiles (replaces the old WC home) |
| `/c/[comp]/[season]` | Workspace main — bracket + live scores |
| `/c/[comp]/[season]/standings` | Standings (groups + top scorers + third-place if `format.hasThirdPlaceRace`) |
| `/c/[comp]/[season]/news` | News |
| `/c/[comp]` | Redirect → `/c/[comp]/<currentSeasonId>` |

- Every `/c/[comp]/[season]` page resolves `resolveSeason(params.comp, params.season)`; unknown → `notFound()` (404).
- The old top-level pages (`/standings`, `/news`) are **removed**; their content moves under the workspace.
- "Live Scores" stays part of the workspace main page (a strip under the bracket), matching today.

### 2. Competition-aware layout + Sidebar — `src/app/c/[comp]/[season]/layout.tsx`

- The **root layout** (`app/layout.tsx`) drops the global `<Sidebar />`; it keeps only `<html><body>` + fonts + default metadata. The Hub renders full-bleed with no sidebar.
- The **workspace layout** renders the app-shell + a competition-aware `<Sidebar comp={rc} />` + `{children}`.
- **`Sidebar` becomes competition-aware** (`src/components/Sidebar.tsx`):
  - A **competition switcher** block near the top: shows the current competition's emblem + name + season label; expands to a dropdown listing `listCompetitions()` (each linking to `/c/<id>/<currentSeasonId>`).
  - Section links scoped to the current competition/season: Bracket → `/c/[comp]/[season]`, Standings → `/c/[comp]/[season]/standings`, Live Scores → `/c/[comp]/[season]#live`, News → `/c/[comp]/[season]/news`. Active state from `usePathname`.
  - "⌂ All competitions" → `/`. Keeps the collapse toggle + "Built by elOpenMike" credit.

### 3. Hub page — `src/app/page.tsx`

- Server component. For each `listCompetitions()`, resolve the current season and derive a light **status** from `dataStore.getMatches(rc)` (2 competitions at launch — cheap, cached): `live` if any match is live, else `upcoming` if all scheduled, else `ongoing`.
- Render tiles grouped **Live now / Starting soon / Ongoing**, each tile = emblem + name + status badge + a sub-line (e.g. "Round of 32 · 4 live" or "kicks off Aug 4"), linking to `/c/[comp]/[season]`. A `hubStatus(matches)` pure helper (unit-tested) computes the label.

### 4. Team style — flag vs crest

The registry's `teamStyle` drives badge rendering; it threads to the components that draw teams.

- **`TeamBadge`** (`src/components/TeamBadge.tsx`): gains a `style: TeamStyle` prop. `flag` → flagcdn (current behavior); `crest` → the team's `crestUrl` (ESPN club logo) directly, no flag lookup.
- **`RadialBracket`**: outer teams currently render **twin discs (federation crest + country flag)** — that is national-only. For `teamStyle: 'crest'` (clubs), outer teams render a **single crest disc** (no flag), and inner/advancing discs render the club crest. A `teamStyle` prop selects twin (flag competitions) vs single-crest (club competitions). Winner-path colors, greyscale-on-elimination, ping cues, popups all unchanged.
- **`LiveScores` `FullFlag`, `GroupTable`/standings badges, `TopScorersTable`, `MatchDetailPopup` flags**: take/get `teamStyle` and render crest vs flag accordingly. (Most already fall back to `crestUrl` when `flagUrl` returns null, but the explicit style avoids a club abbr colliding with a country code.)

### 5. Client components read the season-scoped API

Each polling client takes the competition/season so it hits the scoped routes:
- `BracketInteractive` → `/api/[comp]/[season]/bracket`
- `LiveScores` → `/api/[comp]/[season]/matches`
- `StandingsLive` → `/api/[comp]/[season]/standings` + `/top-scorers`
- `NewsLive` → `/api/[comp]/[season]/news`
- Match popup (`RadialBracket` `handleView`) → `/api/[comp]/[season]/match/[id]`

Threaded via a single `apiBase: /api/${comp}/${season}` prop (or the `{comp, season}` ids) from the server pages. Once every caller is on the scoped routes, the **legacy `/api/matches|bracket|groups|top-scorers|news|match/[id]` routes are removed**.

### 6. Predictions, share & OG — per competition

- Build-your-bracket, the champion celebration, and Reset stay as-is but live inside the workspace. The share URL becomes `${origin}/c/<comp>/<season>?b=<picks>&c=<champ>&name=<name>`; `?b=` hydration reads from the workspace page.
- `generateMetadata` for `/c/[comp]/[season]` produces the competition-aware title + OG (champion card when `?c=` present).

---

## Data flow

`/c/[comp]/[season] page → resolveSeason → dataStore.getX(rc) (SSR) + passes {comp,season} to client → client polls /api/[comp]/[season]/* → store → mapper`. Team style flows from `rc.competition.teamStyle` into the badge/bracket components.

## Decomposition (for the plan)

1. **Routing + Hub + workspace shell + competition Sidebar** — WC works at `/c/world-cup/2026`; Hub lists competitions; client components accept an `apiBase` and use the scoped routes; legacy top-level pages removed.
2. **Team style (crest/flag)** — `teamStyle` through `TeamBadge` + `RadialBracket` (single-crest club variant) + live scores / standings badges.
3. **Remove legacy API routes; predictions/share/OG per competition; polish** — Leagues Cup end-to-end (crests, bracket, scores, standings, news).

## Testing

- `hubStatus(matches)` pure helper: live/upcoming/ongoing classification.
- `resolveSeason` already covered (sub-project #1).
- Route/redirect: `/c/[comp]` redirects to current season; unknown comp/season 404s.
- `TeamBadge` renders flag for `flag`, crest for `crest`.
- Existing component/data tests stay green; the WC experience is visually unchanged at its new URL.
- Manual: Hub → World Cup workspace (flags, unchanged) and Leagues Cup workspace (crests) both render bracket + live scores + standings + news; switcher hops between them.

## Success criteria

1. `/` is a Hub listing World Cup 2026 + Leagues Cup with status.
2. `/c/world-cup/2026` reproduces today's WC app exactly (flags), and `/c/leagues-cup/2026` shows the Leagues Cup with **club crests**.
3. The sidebar switcher moves between competitions; sections are competition-scoped.
4. All data flows through `/api/<comp>/<season>/*`; legacy routes/pages gone.
5. Predictions + share + OG work per competition.

## Open decision for review

- **Club bracket rendering:** for club competitions the outer teams show a **single crest disc** (no twin flag), since clubs have no country flag. Confirm this is the desired look (vs. e.g. crest + a small league/city marker).
