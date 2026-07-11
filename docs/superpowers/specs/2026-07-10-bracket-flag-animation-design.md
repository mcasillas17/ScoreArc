# Bracket Flag Animation — Design

**Date:** 2026-07-10
**Branch:** `feat/bracket-flag-animation`
**Component:** `src/components/RadialBracket.tsx`

## Problem

The radial bracket renders each team's flag **once per ring it reaches**: an
`OuterTeam` at the outer ring plus a fresh `InnerFlag` for **every decided inner
slot** (`RadialBracket.tsx` ~lines 660–700). A finalist is therefore 5 separate
flag elements, each independently playing its own `bracket-advance` travel
animation at mount — so the whole bracket shows dozens of flags gliding between
levels at once. The intended effect is a single flag per team that walks the
tournament inward.

## Goal

Render **one traveling flag per team** that starts at the outer ring, **glides
inward one round at a time as the team wins**, and **greys out where it loses** —
a timed simulation of the tournament that plays once on load and then updates
incrementally. Keep the existing bracket structure, connectors, popup, zoom, and
predict-mode picking intact.

## Model

### Representation
- **Outer ring (R32) = the team's stationary "home."** Keep the existing
  `OuterTeam` twin badge (federation crest + flag roundel for national style;
  single crest for club style). It never moves. It greys (`.bracket-disc--eliminated`)
  only if the team was eliminated in its R32 match.
- **One traveling flag per team.** For every team that advances past R32, a
  single flag circle emerges from its home badge and travels inward, coming to
  rest at the deepest ring it reached. This is the only *moving* element per team.
  There are **no persistent flags at intermediate rings** — the connectors show
  the path; the flag rests at the frontier.

### `teamJourney` — a pure helper
A new pure function derives the animation data from the existing `rings` structure
(the depth-0..4 arrays of `RingNode`s already computed in the component):

```
teamJourney(rings): Map<teamId, {
  homeIndex: number;              // slot index on the outer ring
  positions: {depth,x,y}[];       // ring positions from R32 inward, in order,
                                  //   as far as the team advanced (index 0 = R32 home)
  eliminatedAtDepth: number|null; // ring depth where it lost; null if still alive / champion
}>
```

- A team occupies ring `d` iff it is the effective winner of every match up to
  ring `d` — already encoded by the existing `isWinner` flags per node. `positions`
  is the list of that team's node coordinates from depth 0 up to its deepest ring.
- `eliminatedAtDepth` = the depth at which the team lost (it appears at that ring
  but is not `isWinner` there); `null` if it is the champion or has not yet lost
  (still alive in an in-progress tournament).

### `simRound` — a shared timeline
A single state variable drives every traveling flag:
- A traveling flag for a team with journey depth `d` renders at
  `positions[min(simRound, d)]`. Its home (depth 0) is R32; at `simRound ≥ 1` it
  has moved to at least R16.
- Only teams with `positions.length > 1` (advanced past R32) get a traveling flag.
- Greyscale: the traveling flag greys once `simRound ≥ eliminatedAtDepth`.
- A CSS transition on the flag's `x`/`y` (transform) makes each step a smooth
  glide; the round stepper advancing `simRound` produces the round-by-round walk.

## Behavior

### On load
`simRound` steps `0 → maxDepth` on a timer: **~650 ms per round**, each flag
gliding **~500 ms ease-out** per step; losers grey with the existing `filter`
transition (~0.3 s). A full World Cup (5 rounds) plays in ~3.3 s.

### On live refresh (15 s poll) and predict mode
`simRound` stays pinned at `maxDepth`, so nothing replays. When new data deepens
a team's journey (a fresh win), its flag glides one ring further via the same
`positions[min(simRound, d)]` rule (d increased). A fresh loss greys the resting
flag. Predict-mode picks animate identically (incremental), since a pick extends
the journey the same way a real result does.

### Reduced motion
Under `prefers-reduced-motion`, skip the timeline: initialize `simRound` at
`maxDepth` immediately and disable the glide transition, so flags appear at final
positions with greyscale applied at once. No movement.

## Interaction preserved
- Home badges (R32) and traveling flags remain clickable exactly as today: view
  mode opens the relevant match detail (the match the flag most recently played /
  won to reach its ring); predict mode picks at the live frontier.
- Connectors, junction dots, the center trophy image, `BracketZoom`, and
  `MatchDetailPopup` are unchanged.
- Champion still rests at the center.

## Scope & files
- **`src/components/RadialBracket.tsx`**: keep `OuterTeam`; **remove the per-slot
  `InnerFlag` mapping loop** (lines ~660–700) and replace it with a per-team
  traveling-flag render driven by `simRound`. Add the `teamJourney` helper and a
  `useEffect` timeline that advances `simRound` on mount (respecting
  `prefers-reduced-motion`). The traveling-flag disc reuses the existing
  `ImageDisc`/`FallbackDisc` and `.bracket-disc--eliminated` styling.
- **`src/app/globals.css`**: the `.bracket-advance` per-slot keyframe travel is no
  longer used and is removed; add a simple transition on the traveling flag's
  transform. `.bracket-disc--eliminated` stays.
- **Test:** `teamJourney` is pure → unit-test it against a small fixture bracket
  (a team that wins to the final; a team out in R32; a team out in R16; an
  in-progress team with no elimination). The animation itself is visually verified
  in the running app.

## Non-goals
- No change to how bracket/standings data is fetched or shaped.
- No change to the match popup, standings, or non-bracket competitions.
- No new dependency (pure React state + CSS transitions; no animation library).
