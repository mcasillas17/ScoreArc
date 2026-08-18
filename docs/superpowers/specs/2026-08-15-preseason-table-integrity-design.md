# Pre-season table integrity — design

**Status:** Design approved · 2026-08-15
**Epic:** E0 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.
**Priority:** Ship first. Two of the three defects are live on production now.

## Goal

Stop ScoreArc from publishing statements that are false. Three defects, all
verified against live data on 2026-08-15, all cheap, all corrosive to the one
thing a stats platform sells: being right.

---

## Defect 1 — pre-season tables declare champions and relegations

**Verified live, 2026-08-15**, `GET /apis/v2/sports/soccer/eng.1/standings`:

```
TABLE: 2026-27 English Premier League
   1 AFC Bournemouth   P 0  Pts 0
   2 Arsenal           P 0  Pts 0
   3 Aston Villa       P 0  Pts 0
   ...
  19 Sunderland        P 0
  20 Tottenham Hotspur P 0
```

ESPN ranks a table that has not started **alphabetically**, and still emits
`rank` 1–20. Our zone config (`src/server/data/competitions.ts`) paints rank 1 as
`champion` and 18–20 as `relegation`, so the site currently states that
**Bournemouth are champions of England and Tottenham are relegated**.

Serie A, Bundesliga and Ligue 1 are affected identically — every competition with
a `zones` config and a season that has not kicked off.

Introduced by PR #26.

**What already exists, and why it is not enough.** `LeagueZoneTable.tsx` already
computes `played` and renders:

```
Season not started — no matches played yet.
```

The note shipped; the fix did not. The coloured bands, the `◆ Champion` /
`◆ Relegation` band labels and the alphabetical rank column all still render
beside that note. A caption saying "this hasn't started" under a graphic saying
"Bournemouth are top" reads as a rendering glitch, not as honesty.

### Decision

When **every** row in a table has `played === 0`:

- Render **no bands** — one flat, unmarked list.
- Render **no rank numbers**. The order ESPN supplies is alphabetical and carries
  no meaning; numbering it makes it look like a standing.
- Render **no legend**, since there are no bands to key.
- Keep the existing "Season not started" note, promoted to sit above the list.
- `ZoneRing` renders its neutral ring with no zone arcs.

The rule is *all* rows at zero, not *any*. A league one matchday in, where two
clubs have played and eighteen have not, is a real if lopsided table — bands stay.

The rule is deliberately placed in `toBands`, not in the components. Two views
(`LeagueZoneTable` and `ZoneRing`) consume bands, and a fix in only one of them
is how this defect shipped in the first place.

---

## Defect 2 — own goals are credited to the wrong player

**Verified live, 2026-08-15**, Leagues Cup event `401863609`,
Minnesota United (17362) v Atlante (226):

```
team 226   | type {"id":"97","text":"Own Goal","type":"own-goal"} | player Devin Padelford | 32'
team 17362 | type {"id":"70","text":"Goal","type":"goal"}         | player Mauricio Gonzalez | 59'
```

ESPN's convention: an own goal is credited to the **team that benefits**, and the
player named is the **opposition player who scored it**. Devin Padelford plays for
Minnesota. ESPN credits the goal to Atlante and names Padelford.

`mapSummaryScorers` (`src/server/data/providers/espn-summary.ts`) reads
`scoringPlay`, `team.id` and `participants[0]`, and **never looks at `e.type`**.
So ScoreArc lists Devin Padelford as an Atlante goalscorer.

Note there is **no `ownGoal` boolean** on the event — the only signal is
`type.type === 'own-goal'`. Do not guess at a field that is not there.

### Decision

Add `ownGoal: boolean` to `Scorer`, set from `e.type?.type === 'own-goal'`, and
render an `(OG)` suffix. The team attribution stays exactly as ESPN sends it —
crediting the beneficiary is correct and is what every scoreboard in the world
does. What is wrong today is silently presenting the scorer as one of their
players.

The Go ingester on `feat/player-identity` already carries this logic; this is the
TypeScript half of the same fix, and the two must agree.

---

## Defect 3 — the "Live Scores" nav link goes nowhere

`src/components/Sidebar.tsx:23`:

```tsx
const liveItem = { href: `${base}#live`, label: 'Live Scores', match: () => false, icon: liveIcon };
```

An anchor to a `#live` fragment, with `match: () => false` so it can never show as
active. The `LiveScores` component it was named for is imported nowhere.

### Decision

E0 removes the item. **E2 reinstates it** pointing at the real
`/c/[comp]/[season]/live` route, with a real `match` predicate.

Removing beats leaving it: a nav item that does nothing teaches people the nav is
unreliable, and E2 is one branch away. If E0 and E2 land in the same week, E2 may
simply supersede this task — the plan says so explicitly.

## Out of scope

- Changing the zone configs themselves. The configs are right; applying them to an
  empty table is what is wrong.
- Pre-season predicted tables, "last season's finish" fallbacks, or any other
  substitute content. Showing the squad list honestly is the fix; inventing a
  table to fill the space is the same defect wearing a hat.

## Defect 1b — the same false statement in a second code path

Found during review of the fix. `GroupTable.rowClass` marks rank 1–2 as
`row-qualify` and rank 3 as `row-playoff` with **no `played` guard**, so a group
table rendered before kick-off says the two clubs whose names sort first are
through.

This is not theoretical: `/c/[comp]/[season]/standings` never passes `zones` to
`StandingsLive`, so it always renders `GroupTable` — and that route is what the
sidebar's **Standings** link points at for every bracket competition. It is not
live-broken today only because neither the World Cup nor the Leagues Cup is
currently pre-season.

### Decision

Same rule, same predicate. `rowClass` becomes an exported
`groupRowClass(s, started)` returning `''` for everything when the group has not
started, with the rank cell blanked to match. Exporting it makes the rule
unit-testable rather than browser-only.

## Verification

- `npm test` green, `npx tsc --noEmit` clean.
- In a browser: `/c/premier-league/2026-27` — the **base** page — shows a flat
  unranked list with no colour bands and no champion or relegation labels.
- In a browser: `/c/mls/2026` (mid-season, real `played` values, and zone-configured)
  is **unchanged** — bands, ranks and legend all still render.

> ⚠️ **Route trap.** `/standings` never passes `zones`, so it renders the legacy
> `GroupTable` and never exercises `toBands`. And Liga MX renders through
> `LeagueLadder`, not `LeagueZoneTable`. Verifying against either would prove
> nothing about this fix — MLS is the correct mid-season regression check.
- In a browser: the Leagues Cup Minnesota–Atlante match popup shows Padelford's
  32' goal marked `(OG)` under Atlante.
