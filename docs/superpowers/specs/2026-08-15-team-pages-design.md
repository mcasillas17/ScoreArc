# Team pages — design

**Status:** Design approved · 2026-08-15
**Epic:** E4 (`docs/PRODUCT_ROADMAP.md`)
**Scope:** One implementation plan.

## Goal

Make every crest on ScoreArc lead somewhere. Right now a club badge appears in the
standings, the ticker, the bracket, the scorer table and the match popup, and not
one of them is clickable. A user who wonders "who are América, actually?" has
nowhere to go.

## What the provider gives us — verified live, 2026-08-15

Three keyless endpoints, all HTTP 200, checked against `mex.1/teams/227` (América):

**`/teams/{id}`** — identity and season summary:
`displayName`, `abbreviation`, `location`, `logos`, `color` / `alternateColor`,
`standingSummary`, `nextEvent`, and `record.items[]` carrying
`gamesPlayed`, `points`, `pointDifferential`, `pointsAgainst` with a
`summary` string (`"2-1-0"`).

**`/teams/{id}/schedule`** — the club's fixture list. Returned 3 events for
América three matchdays into the season, each with `date`, `name`, `shortName`
and a full `competitions[]` block.

**`/teams/{id}/roster`** — the headline find. **35 athletes, and every one of
them carries their full season statistics inline**:

```
Cristian Borja (D)
  general      foulsCommitted 3, foulsSuffered 6, redCards 0, yellowCards 0,
               ownGoals 0, appearances 3, subIns 0
  offensive    goalAssists 0, offsides 1, shotsOnTarget 1, totalShots 2, totalGoals 1
  goalKeeping  saves 0, shotsFaced 0, goalsConceded 1
```

So a **complete squad statistics table costs one request**. This is materially
better than the design assumed — the original plan was a squad list of names and
numbers, and what is actually available is a sortable season stat table for all 35
players.

**Also present, and deliberately unused:** each athlete carries an `injuries`
array. It is **empty for all 35 players**. The field exists; the data does not.
Do not build an injuries feature on it, and do not render an empty "no injuries"
panel, which would imply we checked and there are none.

## Design

### Page structure

`/c/[comp]/[season]/team/[teamId]`, competition-scoped. A club's league position
and season record only mean something inside a competition, and the same club
appears in several — América are in Liga MX and the Leagues Cup at once, with
different records in each.

Four blocks, in order:

1. **Header** — crest, name, location, season record, current standing summary.
   Tint the header with the club's own `color` / `alternateColor` rather than the
   competition accent, so a team page feels like *that* club's page. Reuse the
   accent-injection pattern already used per competition on `.app-shell`.
2. **Form and next fixture** — last five results as W/D/L chips, then the next
   fixture from `nextEvent`.
3. **Squad statistics** — the whole roster, one row per player, sortable by
   appearances, goals, assists, shots, cards. Goalkeeper rows show saves and
   goals conceded; outfield rows show offsides. Same nullability rule as E1: a
   stat the provider did not send renders as a dash, never as a zero.
4. **Fixtures & results** — the club's schedule, past and future.

### Reuse

- `TeamBadge` for the crest.
- E2's `LiveMatchCard` for fixture rows, if it has landed.
- `MatchDetailPopup` for click-through. Do not build a second detail view.
- E1's `PlayerMatchStats` nullability convention for the squad table. The stat
  names are identical (`totalGoals`, `goalAssists`, `totalShots`, `saves`,
  `foulsCommitted`, …), so the same "look up by name, default to null" helper
  applies — but note the shape differs: the roster nests stats under
  `statistics.splits.categories[].stats[]`, where the match summary puts them in
  a flat `stats[]`. Write the lookup to walk both, or give each its own
  extractor; do not assume one shape works for the other.

### Linking

`TeamBadge` becomes the single place a crest becomes a link. Check first whether
every call site threads enough context (competition, season, team id) — if it
does, this is one change rather than six. If it does not, add the link at the call
sites that have the context and leave the rest as plain badges rather than
inventing a link that 404s.

The bracket is the case to check carefully: it renders placeholder teams with no
real id, and those must not become links.

## Out of scope

- Cross-competition team pages ("América everywhere"). Needs identity resolution
  across competitions, which is backend Phase 1 work.
- Historical squads and past seasons — E7.
- Transfers, contracts, market values — no source.
- Injuries — the field is empty, as above.

## Verification

- Every crest in the standings, the scorer table and the match popup navigates to
  a team page.
- `/c/liga-mx/2026-27/team/227` shows América with a 35-player squad table,
  correct season record, and their own club colours in the header.
- A goalkeeper row shows saves; an outfield row shows a dash there, not a zero.
- Bracket placeholder slots are not links.
- One upstream request per data block — three for the whole page, not one per
  player.
