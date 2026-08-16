# Player pages — design

**Status:** Design approved · 2026-08-15
**Epic:** E5 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.

## Goal

Give ScoreArc people. Today a player's name appears in the Golden Boot table, in
a lineup and in a scorer line, and none of them lead anywhere. A fútbol platform
where you cannot click a player's name is a results service.

**This ships without a database and without a new provider.**

## What the provider gives us — verified live, 2026-08-15

All keyless, all on `site.web.api.espn.com`, probed against Liga MX athlete
`297287` (Ali Avila, Querétaro).

| Endpoint | Status | Carries |
|---|---|---|
| `/athletes/{id}` | **200** | identity + season totals |
| `/athletes/{id}/overview` | **200** | **game log**, next game, news, season stats |
| `/athletes/{id}/bio` | **200** | career club history |
| `/athletes/{id}/gamelog` | 500 | — |
| `/athletes/{id}/splits` | 404 | — |
| `/athletes/{id}/stats` | 404 | — |

### `/athletes/{id}`

```
Ali Avila · 22 · Forward · Querétaro · Mexico
statsSummary "2026-27 Liga MX Stats":
  starts-subIns  3 (0)
  totalGoals     3
  goalAssists    0
  totalShots     9
```

Server-aggregated season totals, **including Liga MX** — which is what makes this
viable, since our North American core is exactly where most free providers stop.

### `/athletes/{id}/overview` — the one that changes the design

Carries a populated `gameLog`:

```
"Last 5 Matches"
  labels: APP, G, A, SHOT, SOG, FC, FA, OF, YC, RC
  events:
    401863615  Started, 1, 0, 1, 1, 4, 1, 2, 0, 0
    401863600  Sub,     0, 0, 0, 0, 1, 0, 0, 0, 0
    401863562  Started, 0, 0, 7, ...
```

Plus `nextGame`, 16 news articles, and a fuller `statistics` block.

**This narrows the stated ceiling.** The roadmap said player pages would ship with
"no game log". That was wrong — a **last-five-matches** log is available today,
keyed by `eventId` so each row links to the match we already render. What remains
genuinely unavailable is a *full-season* log, cross-season history and
per-position percentiles.

### `/athletes/{id}/bio`

`teamHistory[]` — clubs with `seasons` spans (`"2025-CURRENT"`). Career path with
no database.

### Two gaps to design around

- **`headshot` is `null` for this player.** Headshots are not guaranteed. The
  page must be laid out for their absence, not have a hole punched in it — use
  the shirt-number/initials fallback pattern rather than a broken image or a grey
  box.
- **`/gamelog`, `/splits` and `/stats` are dead.** Do not retry them, do not build
  a fallback chain around them. `/overview` is the source.

## Design

### Route

`/c/[comp]/[season]/player/[athleteId]`, competition-scoped for the same reason
team pages are: a player's season stats belong to a competition, and the
`statsSummary` label ESPN returns literally says `"2026-27 Liga MX Stats"`.

### Page structure

1. **Header** — name, age, position, nationality flag, current club crest
   (links to the team page from E4), shirt number. Headshot if present.
2. **Season totals** — `statsSummary`, rendered as stat tiles.
3. **Last five matches** — the `gameLog`, one row per match, each linking to that
   match via `eventId`.
4. **Career** — `teamHistory` from `/bio`, as a compact club timeline.
5. **News** — the athlete's articles, reusing `NewsList`.

### State the ceiling on the page

Under the game log, say plainly that it covers the last five matches and that
full-season and multi-season history arrive with E7. A stats platform that
silently shows five matches where a user assumes a season is misleading them by
omission — the same class of defect as E0's alphabetical champion, just quieter.

### Reuse

- `TeamBadge` for the club crest, linking to E4's team page if it has landed.
- `NewsList` for the articles block — it already exists and already handles the
  empty case.
- `MatchDetailPopup` for game-log row clicks.
- E1's nullable-stat convention: a dash is not a zero.

## Out of scope

- Full-season and multi-season game logs, form curves, per-position percentiles,
  and any "compare two players" view. All gated on **E7**, and the page says so.
- Player pages for competitions where ESPN publishes no athlete data. Detect and
  degrade — do not render an empty skeleton.
- Transfer history, contracts, market value — no source.

## Verification

- `/c/liga-mx/2026-27/player/297287` shows Ali Avila, 22, Forward, Querétaro,
  Mexico, with 3 goals from 9 shots in 3 starts.
- The last-five table shows five rows, `Started` / `Sub` distinguished, and each
  row opens the right match.
- The page renders correctly for a player with **no** headshot — no broken image,
  no empty frame.
- Player names in the Golden Boot, the assists board and match lineups all
  navigate here.
- The ceiling note is visible under the game log.
- One upstream request per block — two for the whole page, not one per match.
