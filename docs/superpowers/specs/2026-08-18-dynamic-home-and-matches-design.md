# Dynamic Home Page & Now-First Matches View — Design

**Status:** shipped 2026-08-19 (T11.1 in #89; T11.2/T11.3 in the follow-up PR)
**Epic:** E11 in `docs/PRODUCT_ROADMAP.md`
**Surfaces:** `/` (all competitions) and `/c/{comp}/{season}/matches`
**Gate:** none — no backend, no new provider, no new upstream endpoint

## Problem

Both of ScoreArc's entry points are static in the literal sense: neither updates
itself, and both look the same on a matchday as on a quiet Tuesday.

**The home page** renders nine competition tiles whose sub-line is a count —
"0 matches", "10 matches" — or a season label. It carries no football. It fetches
every competition's full match list to decide whether a tile reads "In progress"
or "Soon", then discards the matches.

**The matches view** is a month browser. `MatchCalendar` fetches when you change
month and **never again** — no polling at all. A match that kicks off while the
page is open stays frozen at its scheduled time until reload.

### Measured, not assumed

| Measurement | Result | How |
|---|---|---|
| Upstream ESPN requests for one `/` render | **95** | instrumented `defaultFetchJson`, single request to `/` |
| — of which per-match `/summary` | **77** | `getMatches` enriches every match with scorers and cards |
| — scoreboard | 11 | one per competition, plus forward-feed fallbacks |
| — standings | 7 | one per league, for the "has it started" test |
| Matchday/jornada number in the payload | **absent** | queried `mex.1`, `eng.1`, `usa.1` live: no `week`, no round, empty `calendar` |
| Scroll-to-today on the matches page | **already works** | `MatchCalendar.tsx:229-240` |

The 77 summary fetches buy nothing on the home page: it reads only `state` and a
score, and the scoreboard already carries both.

## The rule

Both surfaces answer one question in one order:

```
live  →  starting soon / later today  →  just finished
```

`src/server/data/matchPriority.ts` — a pure function over `Match[]` returning
`{ live, upcoming, recent }`, cutoffs as parameters. Both surfaces render from
it. Liga MX's eight simultaneous kickoffs and the World Cup's one knockout tie a
day are the same input.

## Data path

The band and the Now view use the **unenriched** read (`getFixtures`, i.e.
`/api/{comp}/{season}/matches?range=` without `detail=summary`). The home page
drops from **95 upstream requests to 18** — the 11 scoreboard reads and the 7
standings reads, both of which it genuinely needs.

**The band shows score and minute, not scorers.** `AME 1–0 CAZ · 67'` is free;
`⚽ Ocampos 34'` costs the 77 requests. Scorers remain on the match popup, which
already fetches one summary on demand. This is a deliberate trade, agreed at
design time.

**`/api/live`** (new) merges the nine competitions server-side behind the
existing TTL cache, so the client polls **one** endpoint every 30s rather than
nine.

## Every competition, deliberately

The rule is competition-agnostic; three states need handling and all three exist
in production today.

| State | Example today | Band | Matches page opens on |
|---|---|---|---|
| Finished edition | World Cup 2026 | contributes nothing; tile keeps its champion badge | **Calendar** — Now would be empty |
| Pre-season | Premier League, Serie A, Ligue 1 | upcoming only | **Now** — "first match is Friday" is what a visitor wants |
| Mid-season, quiet midweek | Liga MX (last played the 17th, next the 21st) | recent + upcoming | **Now** |
| Nothing published yet | Leagues Cup ("0 matches") | contributes nothing | **Calendar** |

The default-mode rule is one line: **open on Now if it has any content,
otherwise the calendar.** No competition needs a special case, and one that
gains or loses fixtures moves between the modes on its own.

Pre-season must not invent state — no results, no standings-derived claims
before a ball is kicked. This is the E0 regression, and it is why the tile
sub-line for an `upcoming` competition is the first fixture's date and nothing
else.

## Components

### Home

- **`src/app/page.tsx`** — same per-competition fetch, on the cheap path. Still
  reads standings (leagues) or bracket (cups) for the "has it started" test;
  that logic is correct and unchanged.
- **`LiveBand.tsx`** (new, client) — server-rendered props for instant first
  paint, then polls `/api/live` every 30s. Renders exactly one mode:

  | Condition | Mode |
  |---|---|
  | any match live | **Live** — score, minute, competition |
  | else | **Just finished** + **Next up**, side by side |
  | neither has content | nothing — the band unmounts |

  Each row links to that match's popup, so the band is a shortcut, not a dead end.
- **`HubTiles.tsx`** — keeps its four status groups; gains a real sub-line:
  - `live` → `2 live · AME 1–0 CAZ`
  - `ongoing` → next kickoff, falling back to the table leader when no fixture is
    in range (leader costs nothing: league standings are already fetched here)
  - `upcoming` → the first fixture's date, never an invented standing
  - `finished` → champion, as today

  The **"Live now" tile group stays.** The band shows *matches*; the group shows
  *which competitions* to click into. Removing it would make a live competition
  harder to navigate to, not easier.

### Matches

- **Mode in the URL** as `?view=calendar`, so links are shareable and the back
  button behaves.
- **`MatchesNow.tsx`** (new, client) — sections in priority order: **Live**,
  **Later today**, **This week**, **Latest results**. Renders `MatchRow`, the
  component the calendar already uses, so a match looks identical in both modes
  and there is one place to change a row. One unenriched `matches?range=` fetch
  spanning ~today−7 → today+14 feeds every section; polls on the same 30s cadence.
- **`MatchCalendar.tsx`** — otherwise untouched. E3's month browser, its
  scroll-to-today, its month bounds and its error copy all survive. Its one
  change: **poll while the visible month contains today.** Older months are
  settled history.

## Error handling

A competition that fails contributes nothing and never blocks the other eight.

- `/api/live` merges with `Promise.allSettled` and returns what succeeded. One
  dead feed means one competition missing from the band, not a 502. It 502s only
  when **all nine** fail.
- The client keeps last-good data on a failed poll, firing `trackFeedFailure`
  once and `trackFeedRecovery` on recovery — the pattern already in
  `StandingsLive`.
- Empty is a first-class state, not an error: the band unmounts, the matches page
  opens on the calendar. Nothing renders a heading over zero rows.

## Testing

The rules live in pure functions, so most of the tests do too.

- **`matchPriority`** — bucketing, cutoffs, ties, empty input, and the
  competition archetypes above.
- **Default-mode decision** — one test per archetype: finished edition →
  calendar, pre-season → Now, mid-season → Now.
- **`/api/live`** — one competition throws → 200 with the other eight; all throw
  → 502.
- **`LiveBand`** — `renderToStaticMarkup` over the three modes plus the empty
  case. Presentational components are normally verified by running the app here,
  but *which mode renders* is the kind of invisible rule E0's five-round review
  showed needs pinning.
- **Request-cost regression** — assert the home page render never calls the
  enriching `getMatches`. This is what stops the 77 summary fetches creeping
  back, in the spirit of the "one `/statistics` fetch" test guarding E1.

## Out of scope

| Not building | Why |
|---|---|
| Jornada / matchday grouping | ESPN sends no `week`, no round, empty `calendar` for `mex.1`, `eng.1` and `usa.1`. Deriving rounds by date-clustering breaks on midweek fixtures and postponements. |
| Team filter / search on the matches view | Useful, but belongs with E4's team pages. |
| Continuous season scroll (no month paging) | Deferred, not rejected. Scroll-anchored incremental loading is a lot of machinery for a page that does not yet refresh itself. |
| Favourites / personalisation | There are no accounts. |
| Dial-and-ladder clipping below ~1000px | Pre-existing (identical `scrollWidth` on production); its own change. |

## What implementation changed about this design

Recorded because the spec was wrong in two places, and both only surfaced in
review.

**Client-side bucketing was not enough — formatting is the real hazard.** The
spec said to bucket by local date on the client. It did not say that
*formatting* a kickoff is equally timezone-bound, so the first implementation
deferred the bucketing and then formatted times on the server anyway. Vercel
runs UTC: a 19:00 Mexico City kickoff rendered as "Thursday 1:00 AM", wrong day
and wrong hour, permanently, for every reader outside UTC. Unlike a bucketing
decision, a string baked into server HTML is never corrected on hydration.

Every kickoff now renders through `LocalTime`, which shows a placeholder until
mount and then the reader's clock. It exports `useLocalNow` and `localTimeText`
too, because an `aria-label` is a string attribute and cannot contain a
component — a row that shows its day on screen while its label omits it has
fixed the ambiguity only for people who can see it.

**The cheap upstream read moved the cost to the client.** The spec counted
upstream requests (95 → 18) and never counted the payload. `/api/live` merged
nine competitions across a three-week window — roughly 200 entries, over 100KB
— embedded it in the home page *and* re-sent it every 30 seconds, to fill a
six-row band. `prioritiseEntries` now caps upcoming and recent at twelve each:
15 entries, 10KB. **Live entries are deliberately not capped**, because the
band renders a count from what it receives and a capped list makes that count
wrong.

**Two rules the spec did not anticipate:**

- `matchPriority`'s recent bucket needs a *lower* bound. ESPN reports every
  `post` state as finished, abandoned ties included, so a future-dated finished
  fixture had a negative age, satisfied the window, and sorted to the top of
  "just finished".
- The mode tabs must name their view. Linking "Now" to the bare path made it a
  no-op for exactly the states it exists to reach: when Now is empty the bare
  path resolves to the calendar.

## Delivery

Three slices, one PR each. The first is invisible and the other two depend on it.

1. **`matchPriority` + the cheap data path + `/api/live`** — no UI change; the
   95 → 18 drop lands here.
2. **Home band + richer tiles.**
3. **Matches Now mode + calendar polling** — **absorbs E2.** `LiveScores.tsx`
   (378 finished lines, imported nowhere) becomes the Live section's renderer
   instead of a standalone `/live` route, which would have rendered the same
   matches on a second URL. Closes T0.3's dead nav link.
