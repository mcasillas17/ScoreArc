# Live-scores rework → "Upcoming This Week" ticker

**Status:** Design approved (brainstorming) · 2026-07-20
**Scope:** One implementation plan.

## Goal

Replace the current live-scores carousel (a big swipeable card showing one match
in full detail) with a **horizontally scrolling ticker band** of this week's
**upcoming fixtures**. The band moves continuously right-to-left; hovering (or
tapping on mobile) pauses it and opens a compact pre-match hover-card, with a
tap-through to the existing full match-detail popup.

Visual reference: approved mockup — ScoreArc dark ground, gold accent, chips with
day tag + crests + kickoff time, a pre-match popover with the win-probability
bar. (Mockup used colored discs as placeholders; the real component renders real
club crests via each team's `crestUrl`.)

## Deliberate product decision

This strip becomes **upcoming-only**: it shows only `scheduled` matches within
the current week. Live and finished matches no longer appear here — a match drops
off the ticker once it kicks off. The rich live/finished data still lives in the
bracket and the match-detail popup. The section relabels from "Live Scores" to
**"Upcoming This Week"**.

## Behavior

**The band (CSS marquee):**
- The chip list is rendered **twice back-to-back** inside a track; the track
  animates `transform: translateX(0 → -50%)` on an infinite linear loop, so when
  the first copy scrolls off the second is exactly in place (seamless).
- Hover over the band sets `animation-play-state: paused` (pure CSS).
- The band container uses `overflow-x: clip; overflow-y: visible` so the
  hover-card can rise **above** the band while chips still clip sideways.
  (`overflow: hidden` would clip the card — confirmed in the mockup.)
- Soft fade masks on the left/right edges so chips ease in/out.
- `prefers-reduced-motion: reduce` → no auto-scroll; the band becomes a manually
  horizontally-scrollable strip (`overflow-x: auto`). Hover-card still works.

**Each chip** (one upcoming match):
- Day tag (e.g. `FRI` / `SAT` / `SUN`, from the kickoff date, local time).
- Home crest + abbr · `vs` · away crest + abbr.
- Kickoff time (local, e.g. `9:05 PM`).
- Chips are ordered by kickoff ascending.

**Hover-card** (opens on hover/tap, anchored above the chip):
- Teams line + kickoff (weekday + time).
- **Win-probability bar** (home / draw / away) reusing the existing
  `WinProbability` data (`{ home, draw, away }`). If a match has no
  `winProbability` (null), omit the bar and show just the kickoff.
- **"Full details ›"** → opens the existing `MatchDetailPopup` for that match
  (see Full-details path).
- On mobile: tap a chip to open+pin its card (and pause the band); tap elsewhere
  (or the card's close affordance) to dismiss and resume.

## Data

No new fetch call sites. The page already loads `Match[]` via
`dataStore.getMatches(rc)` and `LiveScores` polls `${apiBase}/matches` every 15s.
The ticker keeps that poll and applies a **filter**:

- Keep only `m.state === 'scheduled'`.
- Keep only matches whose `kickoff` falls within the **current week window**:
  from now through the end of the upcoming Sunday, local time (the remainder of
  the current Mon–Sun week). This is a single documented helper
  (`isThisWeek(kickoff, now)`) so the window is trivially tunable.
- Sort by `kickoff` ascending.

`winProbability` is already present on scheduled matches when ESPN provides
pre-match odds; it is nullable and handled as above.

## Full-details path

`MatchDetailPopup` takes a `BracketMatch`; the ticker has `Match`. `BracketMatch`
is structurally `Match` plus `round` and `placeholder` teams, so adapt with a
small pure helper `matchToBracketMatch(m: Match): BracketMatch` (round: '',
teams get `placeholder: false`). The popup fetches its summary from the existing
`${apiBase}/match/${id}?home=${homeId}&away=${awayId}` route (works for any
comp/season), mirroring `RadialBracket.handleView`. The ticker owns
`detail: Match | null` + `summary` state and renders `MatchDetailPopup` when a
card's "Full details" is activated. `MatchDetailPopup` already portals to
`document.body`, so it escapes the ticker's clip context cleanly.

## Components & files

- **`UpcomingTicker.tsx`** (new, client) — replaces `LiveScores` in the page's
  live section. Owns the poll, the week filter, the marquee, chip rendering, the
  hover-card, and (via the adapter) the full-details popup. Presentational parts
  are plain markup; interaction is local state.
- **`upcomingWindow.ts`** (new) — pure helpers: `isThisWeek(kickoffIso, now):
  boolean` and `matchToBracketMatch(m): BracketMatch`. Unit-tested.
- **`MatchDetailPopup.tsx`** — reused unchanged.
- The hover-card's win-probability bar is a **compact inline bar** built in the
  card (three flex segments home/draw/away from `WinProbability`), not the large
  `WinProbBar` from `MatchStats.tsx` (which is styled for the full card). Same
  data, sized for the popover.
- **`page.tsx`** — the live section is defined once as `liveSection` (a single
  `<LiveScores .../>` rendered in three conditional slots). Swap that one usage
  for `<UpcomingTicker .../>` and relabel the section heading from "Live Scores"
  to "Upcoming This Week". `LiveScores.tsx` is left in the codebase (no longer
  imported) — deleting it is out of scope for this change.
- **`globals.css`** — new namespaced block (`tick-*`) for the band, chips,
  fade edges, hover-card. Reuse existing tokens.

## Styling

Namespaced `tick-*` classes appended to `globals.css`, reusing tokens (`--gold`,
`--gold-bright`, `--surface-1`, `--surface-2`, `--hairline`, `--text`,
`--text-muted`, and `--live` if defined; otherwise a literal is fine for the
scheduled-only band, which has no live state). Dark-only. Numbers use
`tabular-nums`. The marquee duration is a constant tuned for a calm pace
(~44s/loop for a full week; scales fine with chip count since the loop is
`-50%`).

## Edge cases

- **No upcoming matches this week** → quiet empty state: "No matches scheduled
  this week." (No empty band.)
- **Few matches** (track narrower than the viewport) → repeat the chip list
  enough times that the doubled track still exceeds the viewport width, so the
  `-50%` loop stays seamless and the band always appears full. (Compute the
  repeat count from match count; minimum enough to fill.)
- **Missing crest** → abbreviation fallback disc (as `TeamBadge` does).
- **Missing win-probability** → card shows kickoff only, no bar.
- **Off-season / empty `Match[]`** → empty state as above.

## Testing

- **Unit (Vitest):** `upcomingWindow.test.ts` covers `isThisWeek` (a match today
  = in; end-of-Sunday boundary = in; next Monday = out; a past kickoff = out) and
  `matchToBracketMatch` (round '' + `placeholder: false` teams, fields carried
  through). Pass a fixed `now` — no reliance on the real clock.
- **Presentational:** verified by running the app + screenshots (desktop +
  mobile), per repo convention. Confirm: band scrolls and loops; hover pauses +
  opens the card with the win-prob bar; "Full details" opens the popup; empty
  state; reduced-motion falls back to a scrollable strip.
- `npx tsc --noEmit` clean; `npm test` green; `npm run build` (touches the page +
  a client component).

## Out of scope (YAGNI)

- Deleting `LiveScores.tsx` (leave it; just stop importing it).
- Showing live/finished matches in the ticker (explicitly excluded).
- Movement/animation of chips on data update (they just re-render).
- Applying the ticker to non-league contexts beyond where the live section
  already renders.
