# Live scores grid — design

**Status:** Design approved · 2026-08-15
**Epic:** E2 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.

## Goal

Give ScoreArc a live-matchday page. A component that does most of this already
exists, finished, and has never been rendered.

## The situation

`src/components/LiveScores.tsx` is 378 lines of working code that is **imported
nowhere**. Verified: the only occurrences of `LiveScores` anywhere in `src/` are
its own `interface LiveScoresProps` declaration and its own `export default`.
The sidebar has carried a "Live Scores" nav item pointing at a `#live` fragment
no page renders, with `match: () => false` so it could never highlight.

It was replaced on the competition page by `UpcomingTicker`, which was the right
call for that slot — a fixture banner is not a live scoreboard — and the component
was left behind rather than deleted.

## What to keep and what to throw away

**Keep** — this is the part that works and would be tedious to rewrite:

- The 15s poll of `${apiBase}/matches`, with the `connOk` flag that survives a
  failed tick and retries rather than blanking the view.
- `sortMatches` — live, then finished, then scheduled.
- `FullFlag` and the crest/flag fallback that respects `teamStyle`.
- Everything imported from `MatchStats`: `ScorersRow`, `CardsRow`, `WinProbBar`,
  `PenaltyShootout`, `liveStatus`, `isBeforeKickoff`.

**Throw away** — the carousel:

- `dragX` / `slideTo` / `animating` / `startX` / `startY` / `axis` / `dragRef`
- `firstLiveIndex`, `index`, `interacted`, and the 30s `ROTATE_MS` auto-advance
- The three-card prev/current/next track

### Why the carousel has to go

A carousel shows one match at a time and rotates every 30 seconds. Liga MX
regularly kicks off **seven matches simultaneously**; a Premier League Saturday
3pm is ten. The one interaction every live-football viewer performs — glance
across every score at once — is the one interaction a carousel prohibits. On a
Saturday it would take three and a half minutes of watching an auto-rotating
panel to see ten scores that fit on one screen.

The swipe mechanics are also the most fragile code in the file (touch axis
detection, drag refs mirroring state, guards against fighting an in-progress
slide) and none of it is needed by a grid.

## Design

A responsive grid of match cards, `auto-fill` with a ~320px minimum, so the
column count follows the viewport rather than a breakpoint list.

**Ordering.** Live first, then finished, then scheduled — `sortMatches` unchanged.
Within live, order by ascending minute so the match closest to full time leads.

**Card contents by state.** A live card and a scheduled card should not look
alike:

| State | Shows |
|---|---|
| `live` | minute, score, scorers, cards, a live pulse |
| `finished` | final score, scorers, cards, shootout if any |
| `scheduled` | kickoff time, win probability |

**Empty state.** The existing copy — "No matches in the live window right now" —
is honest and stays. A competition with no fixtures today is a real state, and
E3's fixtures page is where that user should be pointed; the empty state links
there once E3 lands.

**Click-through.** Each card opens the existing `MatchDetailPopup`, exactly as
`UpcomingTicker` does. Do not build a second detail view.

**Reduced motion.** The live pulse respects `prefers-reduced-motion: reduce`.

## The route

`/c/[comp]/[season]/live`, server-rendered with `dataStore.getMatches(rc)` for
first paint, then polled client-side. Reuses the existing `/matches` API route
untouched.

The sidebar item is reinstated here with a real `href` and a real `match`
predicate. E0 removes the dead link; this epic replaces it. **If E2 lands before
E0, skip E0 Task 6** — it exists only to stop shipping a dead link in the interim.

## Out of scope

- Cross-competition live scores ("everything live right now, everywhere"). It
  needs a fan-out across nine competitions with its own cache strategy. Worth
  doing; not this epic.
- Push updates / WebSockets. 15s polling is adequate and is what the store's
  10s match cache is already tuned for.
- Deleting `UpcomingTicker`. The fixture banner stays where it is.

## Verification

- `/c/liga-mx/2026-27/live` renders every match of the current week as a grid,
  all visible without interaction.
- Live matches sort above finished, finished above scheduled.
- A card click opens the same `MatchDetailPopup` used elsewhere.
- Killing the network for one poll tick does not blank the grid; it recovers on
  the next tick.
- The sidebar "Live Scores" link navigates and highlights when active.
