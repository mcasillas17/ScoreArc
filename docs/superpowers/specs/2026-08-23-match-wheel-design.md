# Match wheel — the fixture band becomes a drum list

**Date:** 2026-08-23 · **Status:** Approved by user (chat, from a working
prototype) · **Branch:** `feat/fixture-wheel`

## What and why

The horizontal fixture band (`UpcomingTicker`) clips cards at the viewport
edge and hides everything past the first swipe. It is replaced everywhere it
appears (season root + standings, via `UpcomingBanner`) with the **match
wheel**: a fixed-height vertical list that scrolls like a phone time picker —
rows snap to a highlighted center slot and curl away above and below (tilt +
fade + scale). The drum's curvature IS the brand's arc; no decorative arc is
drawn on the list itself. Prototyped with live data and approved.

## The row (quiet, from concept D)

Grid `1fr auto 1fr auto`: [full club name (≥900px) + abbr + crest] ·
[score or "vs"] · [crest + abbr + name] · [meta]. Meta: live minute chip
(red), "Final", or day + local kickoff time. **The arc is scarce:** a small
green arc crowns the score ONLY on live rows — the signal for "alive now",
never decoration. Clicking a row opens the shared `MatchDetailPopup` exactly
as the ticker did (same fetch, same telemetry surface renamed
`match-wheel`).

## The drum

- Fixed height ≈ 330px desktop / ≈ 300px phone: ~5 rows visible; edge
  gradients fade rows out; a soft green-tinted center slot marks the snap
  target.
- CSS `scroll-snap-type: y mandatory`, rows `scroll-snap-align: center`;
  `overscroll-behavior: contain` so the drum never traps the page scroll;
  scrollbar hidden.
- A rAF scroll handler transforms each row by its distance from center:
  `rotateX(-38deg·d)`, `scale(1-0.14|d|)`, `opacity 1-0.65|d|` (the prototype's
  tuning; refine in browser).
- Initial position: centered on the live match, else the next upcoming, else
  the last finished (season-gap honesty: show the most recent real thing).
- Order: all matches chronological (finished → live → upcoming), no day
  headers inside the drum; day lives in each row's meta.

## Animation

- **Live pulse:** the green arc + live dot breathe (CSS keyframes, ~2.4s).
- **Goal flash:** when polling changes a row's score, that row's score pops
  (scale) and flashes green for ~1.2s. Detected by diffing the previous
  matches state against the freshly polled one.
- **Entrance:** rows cascade-settle on first mount (short, ≤400ms total).
- **Reduced motion:** `prefers-reduced-motion` disables tilt/scale transforms,
  pulse, flash, and entrance — the drum degrades to a flat snap-scrolling
  list (still fixed-height, still scrollable).

## Data & machinery (reused from the ticker, not rebuilt)

Same 15s poll of `${apiBase}/matches` (weekOnly `detail=summary`, else
`state=scheduled&limit=12`), same `trackFeedFailure/Recovery('upcoming')`
telemetry, same mount-gating so time-derived rendering runs on the client
clock (SSR TZ mismatch), same popup fetch. `UpcomingBanner`'s API is
unchanged — callers don't move.

## Pure logic (unit-tested)

`src/components/matchWheelModel.ts`:
- `wheelOrder(matches)` — chronological sort.
- `initialIndex(matches)` — live → next upcoming → last finished → 0.
- `scoreChanges(prev, next)` — match ids whose home/away score changed
  (goal-flash input); ignores matches entering/leaving the feed.

## Cleanup

- `UpcomingTicker.tsx` is deleted with its marquee CSS (`tick-*` classes,
  used nowhere else); `MatchDetailPopup` stays (shared).
- The throwaway prototype `public/fixture-concepts.html` is deleted.
- The Partidos page's full list is untouched — the wheel is the *banner*, a
  week at a glance, not the fixture archive.

## Also in this change: the home digest stops promoting finished competitions

The home page still shows World Cup 2026 scorers (and would show its news and
matches) though the final was played in July. Rule: **a competition whose
current season has concluded contributes nothing to the home digest** — no
match cards, no scorer board, no stories. Its own pages stay fully browsable;
this is about the digest not presenting a finished tournament as current.

- Config: `Season.concluded?: boolean` (explicit, like every other identity
  fact in `competitions.ts` — inferring "over" from data would cost a bracket
  read per competition per home render). Set for `world-cup/2026`. Leagues
  Cup 2026 stays until its final is actually played, then gets the same flag.
- `listCompetitions()` keeps returning everything (nav, teams browse, share
  cards must not change); the home page filters:
  `listCompetitions().filter((c) => !c.seasons[c.currentSeasonId].concluded)`
  — via a small `ongoingCompetitions()` helper next to `listCompetitions`,
  unit-tested.
- `npm run export:competitions` must run (config file changes; the exporter
  decides whether the flag crosses into the backend JSON).

## Out of scope

- Auto-rotation/idle drift (annoying), horizontal anything.
- Wheel on the home page (its "What's On" grid already works; revisit
  separately if wanted).
