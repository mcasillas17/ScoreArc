# Assists & per-match box score — design

**Status:** Design approved · 2026-08-15
**Epic:** E1 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.

## Goal

Surface player data we already fetch and currently discard. **Zero new network
requests, zero new endpoints, zero new providers.** Every byte this epic renders
is already arriving in responses ScoreArc makes today and dropping on the floor.

## What we are throwing away

### 1. Half of the statistics payload

**Verified live, 2026-08-15**, `GET /apis/site/v2/sports/soccer/mex.1/statistics`:

```
- goalsLeaders   | leaders: 50
- assistsLeaders | leaders: 50
```

Two categories, fifty players each, one response — the response we already fetch
on every standings render for the Golden Boot. `mapTopScorers` does:

```ts
const goals = stats.find((s: any) => s?.name === 'goalsLeaders');
```

…and the other fifty rows are garbage-collected. The top of the Liga MX assist
chart, which ScoreArc has held in memory this whole time:

```
Robert Morales  UNAM  Matches: 3, Assists: 3
Joaquim         UANL  Matches: 3, Assists: 2
Jhojan Julio    ATL   Matches: 3, Assists: 2
Juan Brunetta   UANL  Matches: 3, Assists: 2
```

`displayValue` follows the same `"Matches: N, <Metric>: N"` grammar as goals, so
the existing `parseMatches` regex works unchanged.

### 2. Every per-player match statistic

**Verified live, 2026-08-15**, Leagues Cup event `401863609`. Each entry in
`rosters[].roster[]` carries a `stats[]` array:

```
Jefferson Díaz (CD): appearances, foulsCommitted, foulsSuffered, ownGoals,
  redCards, subIns, yellowCards, goalsConceded, shotsFaced, goalAssists,
  offsides, shotsOnTarget, totalGoals, totalShots
```

`mapSummaryLineups` reads that exact array and keeps name, number and position.

**The stat set is not fixed.** Goalkeepers carry `saves` and omit `offsides`;
outfielders carry `offsides` and omit `saves`. The mapper must therefore look up
**by `name`**, never by array index, and every field must be nullable — a missing
stat means "not applicable to this position", not zero.

## Design decisions

### Generalise the leaders type rather than duplicating it

`TopScorer` is a leaderboard row that happens to call its metric `goals`. Assists
need the identical shape. `AGENTS.md` is explicit — *"never duplicate markup; when
something renders in two places, factor it into one component"* — so:

- `TopScorer` becomes `StatLeader`, with `goals: number` becoming `value: number`.
- `TopScorersTable` becomes `LeaderTable`, taking `metric: { abbr, title }`.
- `mapTopScorers` becomes `mapLeaders(raw, category, limit)`.

This touches eight files. It is a rename, not a rewrite, and it is cheaper now
than after a second leaderboard has been copy-pasted. When E7 adds shots, cards
and clean-sheet boards, they cost one config line each.

### One fetch serves both boards

`getTopScorers` already fetches `/statistics` and caches it for 60s under
`${comp}:${season}:top-scorers`. Assists must **not** trigger a second fetch of
the same URL. The store gains `getLeaders(rc)` which fetches once, maps both
categories, and caches the pair under one key.

The API surface follows: `/top-scorers` keeps working and returns goals (nothing
that consumes it needs to change), and a sibling `/top-assists` reads the same
cached payload.

### The box score is nullable per stat, per player

`LineupPlayer` gains a `stats: PlayerMatchStats | null` field. `PlayerMatchStats`
has every field as `number | null`. A goalkeeper's `offsides` is `null`, not `0`,
because ESPN did not send it and inventing a zero is the same class of defect as
E0's alphabetical champion.

### Derived percentages get recomputed

`shotAccuracy` arrives pre-rounded — `30` where the raw counts are 3-of-11
(27.3%). We hold numerator and denominator, so we compute the percentage
ourselves and display the fraction beside it. Echoing a provider's rounding when
you have the raw numbers is a choice to be less accurate than your own data.

## Out of scope

- Season-long player pages (E5) and player game logs (E7).
- Assist *networks* — who assists whom. That needs the commentary parse (E6).
- Any new leaderboard beyond assists. `mapLeaders` makes them trivial; adding
  them before anyone asks is YAGNI.

## Verification

- `npm test` green, `npx tsc --noEmit` clean.
- Liga MX standings shows an Assists board with Robert Morales top on 3.
- Network tab shows **one** request to `/statistics` per standings render, not two.
- The Minnesota–Atlante match popup lists per-player shots, fouls and cards, with
  goalkeeper rows showing saves and blank (not zero) offsides.
- A match with 3-of-11 shooting displays `27.3%` and `3/11`, not `30%`.
