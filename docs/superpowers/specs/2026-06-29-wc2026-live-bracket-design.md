# WC2026 Live Bracket & Standings — Design Spec

**Date:** 2026-06-29
**Status:** Approved design, pending implementation plan
**Context:** The 2026 FIFA World Cup is live right now — group play has ended and the Round of 32 is the current stage. This is v1 of a broader interactive futbol site; the World Cup tracker is the first surface.

## Goal

An interactive World Cup 2026 site whose hero is a **radial ("circle draw") knockout bracket** — each team shown with both its **flag and federation crest** — backed by **real, live data**. Default view is the real tournament truth; making predictions is an optional what-if layer.

Inspiration: EmilioSansolini's circular bracket graphic (the pasted reference image); reference sites `worldcup.lucena023.com` (IA: Standings · Live Info · Make your bracket · Prediction board) and `fwc2026-knockout.vercel.app` ("FWC26 Circle Draw").

## Core decisions (locked in brainstorming)

| Decision | Choice |
| --- | --- |
| Core mode | **Live-first.** Real results are the default truth; predictions are an opt-in what-if overlay that never overwrites real data. |
| v1 scope | **Group standings + radial knockout bracket.** |
| Stack | **Next.js + React**, SVG for the radial bracket, deploy to Vercel (free). |
| Data sources | **ESPN unofficial scoreboard (`fifa.world`) as live primary** (includes team logos); **football-data.org `WC` as cross-check/fallback.** Both free. |
| Data delivery | Next.js API routes serving a normalized schema, **plus an SSE endpoint** for live score push (no client polling). |
| Node visual | **B — flag disc + crest badge:** one flag-filled disc with the federation crest as a small badge clipped to the corner. |
| Desktop bracket | Radial layout matching the reference: near-black background, warm radial glow at center, trophy core, gold/colored winner-path connectors. |
| Mobile bracket | **Keep the radial,** shrunk to fit, with pinch-zoom + drag-to-pan and generous touch targets. |
| Crests | **Curated 48-team crest + flag asset set built upfront** for consistency (flags also available via flagcdn by ISO code as a baseline/fallback). |
| Navigation (IA) | `Standings · Live Info · Bracket` (adopted from lucena023; **Prediction board deferred to v2**). |

## Architecture

```
ESPN (live primary) ─┐
                     ├─► Data Layer ─► normalize → our schema → cache ─┬─► Next.js API routes ─► React UI
football-data (xref)─┘                                                 └─► SSE endpoint ──────► live push to browser
```

Single Next.js app on Vercel. The **data layer is the central asset** ("the nice API"): it owns all contact with external feeds, normalizes them into our own provider-agnostic schema, caches, and is structured so it can later graduate into a standalone service without UI changes.

### Components (each independently understandable/testable)

1. **Providers** — thin adapters, one per feed (`espn`, `footballData`). Each fetches raw data and maps it to our schema. The UI never sees a provider's native shape. Adding/removing a provider touches only this layer.
2. **Aggregator** — merges providers per the policy: ESPN primary for live matches/scores; football-data as fallback when ESPN is stale/unavailable and as a cross-check for standings. Owns freshness/staleness logic.
3. **Cache** — short TTL for live matches (~15–30s), long TTL for static structure (teams, groups, fixtures). Revalidate-on-demand.
4. **API routes** (`/api/...`) — serve normalized `Group[]`, `Standing[]`, `Match[]`, `BracketNode[]` to the client. Read-only.
5. **SSE endpoint** (`/api/live`) — pushes match-score updates to subscribed clients; server holds the freshest aggregated state and emits diffs.
6. **UI surfaces** — Standings view, Live Info strip, Radial Bracket view, optional Predict layer.

### Our schema (provider-agnostic)

- `Team` — id, name, ISO code, crest asset ref, flag asset ref, group.
- `Group` — id (A–L), teams, ordered standings.
- `Standing` — team, P/W/D/L/GF/GA/GD/Pts, rank, qualification status.
- `Match` — id, round, home/away team, score, status (scheduled/live/finished), minute, kickoff time.
- `BracketNode` — position in the 32-team knockout tree, the match (if known), feeder nodes, winner.

## Surfaces

### Group standings (`Standings`)
12 live group tables (Groups A–L), each row = node style B (flag + crest badge) + team name + P/W/D/L/GD/Pts. Live-updating via SSE. Visually marks who advances (top 2 + best-thirds logic).

### Radial knockout bracket (`Bracket`) — the hero
- SVG, 32 teams arranged on the outer ring, rounds spiraling inward to a central trophy with a warm glow.
- Computed polar coordinates per node; connector spokes between rounds; **winner paths highlighted** in gold/color (as in the reference).
- Each node = style B disc; **live scores render on active matches** with a live-minute indicator.
- Desktop: full circle. Mobile: same circle, pinch-zoom + drag-to-pan.

### Live Info (`Live Info`)
A strip/section of today's and in-progress matches with live scores — the "what's happening right now" glance. Feeds from the same SSE stream.

### Predict layer (opt-in)
A toggle. Off by default (pure live truth). On: user picks winners for **unplayed** matches to project a path through the bracket; this is local/visual only and never mutates real results. Persisted in local state / URL (no accounts in v1).

## Data feasibility

ESPN/CBS/FOX/Yahoo all publish live WC2026 brackets today, and ESPN's `fifa.world` scoreboard demonstrably carries the tournament — so the primary feed is sound. **First implementation task is a short spike** to confirm the exact ESPN + football-data endpoints and payload shapes for WC2026 *right now*, and to record fixtures from them.

## Testing

- **TDD on the data layer**: provider mapping, aggregator fallback/freshness policy, cache behavior — all against **recorded real-feed fixtures** so tests are deterministic and make no live calls.
- UI: component tests for node rendering, standings ordering, and bracket node placement.

## Responsive

Radial on both desktop and mobile (mobile adds pinch-zoom/pan). Group tables stack vertically on narrow screens. Touch targets sized for finger taps.

## Out of scope for v1 (clean v2+ adds)

- User accounts and server-saved predictions (v1 keeps predictions in local/URL state).
- **Prediction board** / sharing / leaderboards.
- Lineups, odds, player stats, match commentary.
- Multiple tournaments / a generalized "futbol platform" shell.
- Graduating the data layer into a standalone deployed service (it's designed to allow this later, but v1 runs it in-process).

## Open implementation risks

- ESPN is unofficial and can change shape without notice → mitigated by the provider abstraction + football-data fallback + recorded fixtures.
- Curating 48 consistent crests is real manual asset work → budget for it explicitly as its own task.
- SSE on Vercel serverless has connection-duration limits → confirm during the data spike; fall back to short-interval polling behind the same client interface if needed.
