# Champion means clinched — the last false claim in the standings

**Date:** 2026-08-24 · **Status:** Approved by user (chat: "why does it say
champion?" → structure agreed) · **Branch:** `fix/table-outcomes`

## The problem

Zones are *stakes* — "finishing here earns the Champions League" is true all
season. One zone kind breaks that model: `champion` asserts a *result*. After
two matchdays the Premier League table crowns Arsenal CHAMPION; every zoned
league (PL, LaLiga, Serie A, Bundesliga, Ligue 1) plus MLS's Supporters'
Shield makes the same overclaim from the first round to the last.

The zero-played case was already fixed centrally (`toBands` and `splitByCut`
suppress all bands at P0). This closes the remaining gap with the same
pattern: one rule, in the one place both renderers already consume.

## The rule

A `champion`-kind zone renders **only when mathematically clinched**:

```
leader.points > max over every other team of (points + 3 × max(0, rounds − played))
```

Every chaser, not just rank 2 — the provider ranks by points, so a team on
fewer points with games in hand sits below second and its ceiling can be the
highest. Remaining games clamp at zero. When every team has played all its
rounds the table is final and rank 1 keeps the band regardless of the strict
inequality: the provider's ranking already applied the tiebreakers, and a
title won on goal difference must not lose its crown.

Until then, rank 1 is absorbed into the band directly below it (PL: the
Champions League band becomes 1–4 — which is also true), or into mid-table
when no band abuts it. When it IS clinched, the champion band appears exactly
as today. No new UI; the claim just waits for the math.

## What carries `rounds`

`Season.rounds?: number` in config — the length of the league season, an
identity fact like every other: PL/LaLiga/Serie A 38, Bundesliga/Ligue 1 34,
Super League Greece 26 (regular phase), MLS overall 34. Liga MX needs none
(no champion zone — the Liguilla decides). **No `rounds` → never clinched**:
the conservative direction, a missing config value must not mint a champion.

MLS note: the Shield goes to the overall table's rank 1, so `rounds` rides
the season and the overall-table zones get the same treatment.

## Where the rule lives

`toBands(standings, zones, opts?: { rounds?: number })` — the single
derivation both `LeagueZoneTable` and `ZoneRing` already consume, exactly
where the P0 rule lives and for the same reason (fixing one renderer is how
the last bug shipped). `splitByCut` consumers (dial, ladder) never paint
champion; untouched. Callers (StandingsLive → pages) thread
`rc.season.rounds` through the existing zones prop path.

## Tests

- Clinched: leader 10 points clear, second has 3 games left → champion band.
- Not clinched: same gap, 4 games left → no champion band, next band absorbs
  rank 1 (from = 1).
- Boundary: gap exactly 3×remaining (catchable on goal difference) → NOT
  clinched (points parity is not a title).
- No rounds provided → never clinched.
- Champion zone with no adjacent band below → rank 1 falls to mid.
- MLS shape: champion zone inside `overallTable.zones` honors season rounds.
- Existing P0 suppression unaffected.

## Out of scope

- Clinched-relegation marking (the relegation *zone* label is already honest
  — a zone is a place, not a verdict). Revisit if wanted.
- Simulation-grade "magic number" displays (E13 territory).
