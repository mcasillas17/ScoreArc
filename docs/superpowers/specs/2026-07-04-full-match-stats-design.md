# Full Match Stats — Design

**Date:** 2026-07-04
**Branch:** `feat/full-match-stats`

## Problem

ESPN's match `summary` response returns **28 team statistics** per side, but ScoreArc
maps and displays only **6** of them (possession, shots, on-target, passes, corners,
fouls) in `MatchStatsBlock`. We already fetch the full payload — the other 22 stats
are free, we just discard them. The current presentation is also a bare number table
(winner bolded), which doesn't visualize the comparison.

## Goal

Surface the high-value subset of the remaining stats and present every stat as a
**diverging comparison bar** (home fills from the left, away from the right,
proportional to each side's share of the combined value), grouped under category
headers. No new data source, no new API call — all additive to the existing mapper,
type, and component.

## Non-Goals

- No positional / heat-map / xG data.

  > **Correction, 2026-08-15.** This bullet originally read "ESPN's free API has no x,y
  > coordinates — verified". That was **wrong**, and the "verified" made it more
  > damaging: it was verified of `site.api.espn.com`, which is the host this spec's
  > feature uses, and is false of `sports.core.api.espn.com`, whose play stream carries
  > pitch coordinates on ~97% of events.
  >
  > The non-goal itself **still stands for this feature** — team-level match stats have
  > no business rendering a heat map — but the *reason* is scope, not absence.
  > Coordinates are persisted by T7.12; the shot map is E6 and xG is E9. Do not cite
  > this line as evidence that coordinates are unavailable.
- No new endpoints or providers.
- No changes to the LiveScores inline stat rendering beyond what the shared component gives.
- Penalty-kick count stats (`penaltyKickGoals/Shots`) are excluded — already covered by
  the scorers/shootout sections.

## Stats & Grouping

All source names are exact ESPN `boxscore.teams[].statistics[].name` keys (verified
against a live World Cup match). Percentage stats keep ESPN's own computed value.

**Possession** — stays as the top full-width bar (unchanged behavior), from `possessionPct`.

| Group | Label | ESPN stat name | Type |
|-------|-------|----------------|------|
| Attacking | Shots | `totalShots` | count |
| Attacking | On Target | `shotsOnTarget` | count |
| Attacking | Shot Accuracy | `shotPct` | percent |
| Attacking | Corners | `wonCorners` | count |
| Attacking | Offsides | `offsides` | count |
| Passing | Passes | `totalPasses` | count |
| Passing | Pass Accuracy | `passPct` | percent |
| Passing | Crosses | `totalCrosses` | count |
| Passing | Cross Accuracy | `crossPct` | percent |
| Passing | Long Balls | `totalLongBalls` | count |
| Defending | Tackles | `totalTackles` | count |
| Defending | Tackle % | `tacklePct` | percent |
| Defending | Interceptions | `interceptions` | count |
| Defending | Clearances | `totalClearance` | count |
| Defending | Blocked Shots | `blockedShots` | count |
| Defending | Saves | `saves` | count |
| Discipline | Fouls | `foulsCommitted` | count |
| Discipline | Yellow Cards | `yellowCards` | count |
| Discipline | Red Cards | `redCards` | count |

That's 19 grouped stats + possession = the full high-value set. `shotPct`, `passPct`,
etc. are already computed by ESPN so we don't derive them.

## Data Layer

`TeamStats` (in `src/server/data/types.ts`) grows from 6 fields to hold all of the
above. Every field stays `number | null`. `buildTeamStats` in
`src/server/data/providers/espn-summary.ts` adds one `parseStat(statistics, '<name>')`
line per new field — `parseStat` already handles missing/NaN by returning `null`.

No change to `mapSummaryStats`, the `/api/match` route, `service.ts`, or the store —
they pass `MatchStats` through opaquely.

## Presentation

**Progressive disclosure** — the block must not become a wall of 23 rows. It renders in
two tiers:

1. **Possession bar** at top (as today).
2. **Headline stats (always visible):** a curated short set — `Shots` (`totalShots`),
   `On Target` (`shotsOnTarget`), `Pass Accuracy` (`passPct`), `Fouls` (`foulsCommitted`).
   These are the marquee stats people scan for. Rendered as diverging-bar rows.
3. **Full match stats (collapsed):** a `<details>` expander labeled "Full match stats"
   (same pattern as `CommentaryFeed`), closed by default. Inside are the four **category
   sections** (`Attacking · Passing · Defending · Discipline`), each a header + its stat
   rows — the complete grouped set from the table above. The headline stats appear again
   in their natural categories inside the expander (canonical full view); the top tier is
   a curated preview, so light duplication is intentional and acceptable.

The expander only renders if it would contain ≥1 visible row beyond the headline set —
so a preseason match with only a few stats shows just the headline tier, no empty toggle.

A stat row is `[home value]  [diverging bar]  [away value]`, stat label beside/above the bar.

**Bar semantics (consistent for all rows):** each side's fill width = its share of the
two teams' combined value, i.e. `homeWidth = home / (home + away)`. This is the standard
"who dominated this stat" view (FotMob/ESPN style). Percentage stats use the same share
model so the rendering rule is uniform.

**Rendering rules:**
- A row renders only if at least one side has a non-null value. If both are null → skip.
- If `home + away === 0` (both zero, e.g. no cards) → render a neutral 50/50 bar and
  show `0 / 0`. Guard against divide-by-zero.
- The higher side's value keeps the existing `ls-stat-higher` emphasis.
- A category section renders only if it has ≥1 visible row (so preseason/limited-data
  matches don't show empty "Defending" headers).
- The "Full match stats" `<details>` renders only if at least one category section is
  visible; otherwise only the headline tier shows.
- Percent-type values display with a `%` suffix.

**Styling:** new CSS in `globals.css` under the existing `ls-stat-*` namespace —
`ls-stat-group` (header), `ls-stat-row`, `ls-stat-bar` (track), `ls-stat-bar-home` /
`ls-stat-bar-away` (fills, reusing the possession bar's home/away colors), and a
`ls-stat-more` style for the `<details>` expander summary (matching the `cm-summary`
Commentary toggle). Reuses the existing color tokens; mobile-safe (bars are `%`-width,
values fixed-width columns).

## Testing

- **`espn-summary.test.ts`**: extend the existing `buildTeamStats`/`mapSummaryStats`
  assertions to cover several new fields (e.g. `passPct`, `offsides`, `saves`,
  `totalTackles`) from the fixture. Add a case asserting a stat absent from the fixture
  maps to `null`. May need to enrich `__fixtures__/espn-summary.json` if it lacks the
  new stat names.
- **Component**: `MatchStatsBlock` is presentational; verify manually in the running app
  (a finished World Cup match in the popup) that groups render, bars are proportional,
  empty groups are hidden, and mobile layout holds.

## Files Touched

- `src/server/data/types.ts` — expand `TeamStats`.
- `src/server/data/providers/espn-summary.ts` — expand `buildTeamStats`.
- `src/server/data/providers/espn-summary.test.ts` — extend assertions.
- `src/server/data/__fixtures__/espn-summary.json` — enrich stats if needed.
- `src/components/MatchStats.tsx` — rewrite `MatchStatsBlock`.
- `src/app/globals.css` — grouped diverging-bar styles.
