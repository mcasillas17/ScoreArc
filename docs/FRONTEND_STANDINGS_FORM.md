# Standings form (T7.3)

Up to five recent results beside each team in the standings, each opening its
existing match popup. It reads ESPN through existing `DataStore` methods
(`getStandings`, `getFixtures`). It adds no `DataStore` method, reader-contract
entry, Go code or migration. When a reader-backed store serves those two methods,
this route needs no change beyond their parity.

- Server: `src/server/data/standingsForm.ts`, served at
  `GET /api/{comp}/{season}/standings/form` through the shared `seasonRoute` envelope.
- Client: `useStandingsForm` (no timer of its own) and `FormBadges`, used by
  `GroupTable`, `ThirdPlaceTable`, `LeagueLadder` and `LeagueZoneTable`, all mounted
  by `StandingsLive`. `ZoneRing`, `LeagueDial` and `PhaseQualifiers` show no rows
  of results and carry no form.

The Leagues Cup landing page now passes `playerBase` so the popup's scorers can link.
That also links its leaderboard names, as `/standings` already does.

## Result definition

`eligibleTeamMatches` in `teamPerformance.ts` is the one W/D/L definition, shared
with the team page: explicit played statuses only, valid scores and identity, goals
including extra time, a level score on penalties stays a draw, conflicting duplicates
excluded. Order is newest first with match id as the tie-break, matching the team
page. Fewer than five shows the actual sample.

## Table scope

`Match` has no phase, and adding one would create a parity gap, so scope comes from
what is held:

| Season shape | Scope | How |
| --- | --- | --- |
| No later phase on the slug | whole season | Newest five in contiguous windows back from today |
| `qualification`, or a `playoff`, `wildcard` or `relegation-playoff` zone (Liga MX, MLS, Greece, others) | regular season | Whole season read. Any matches beyond the table's `played` count are the newest, so they are dropped |
| Several group tables plus bracket (World Cup) | group stage | Same-group opponents, through the first knockout date (UTC) |
| `computedTables` (Leagues Cup) | phase one | Exactly the configured phase range the tables are computed from |
| No `standings` section (past World Cups) | none | No form. ESPN's standings endpoint has no season selector |
| Any edition that is not current, or a league season that has ended | none | No form, for the same reason: the table may already be the next edition's |

A team in several tables (MLS conference and Supporters' Shield) has one form while
those tables agree on its played count. If they disagree, it shows as unavailable.

## Coverage

A team with no entry has played nothing and shows no badges, and a table where
nobody has played costs no scoreboard read. A blank provider table is a failed read,
not an empty season, unless it is computed from results and none has finished. A team shows a visible "Form unavailable"
label, never a short sample, when:

- its table count exceeds what a complete read can explain;
- it has played but holds no eligible match;
- an awarded, abandoned or unknown final makes the later-phase boundary ambiguous;
- one of its held matches was a conflicting duplicate.

Cancelled events and the store's `UNFINISHED_STATUSES` (postponed, suspended and others) are never treated as counted by a table: ESPN
reported AEK Athens at Atromitos (October 17, 2026) as a postponed `post` event,
and it must not blur the boundary.

Any failed window fails the whole response, so a partial read cannot become a
"last five". The standings stay on screen and a notice says form is unavailable.

## Budgets

Each `getFixtures` window spans at most 92 days and reads provider months with its
existing bounds: 15 seconds, 4 MiB per response, 16 MiB per window. Windows run
sequentially, four at most for a year-long season, under a 25-second read deadline.

| Season (worst date) | Cold scoreboard calls (tested cap) |
| --- | --- |
| MLS 2026, December 31 | 19 |
| LaLiga-shaped season with no later phase, June 30, all windows needed | 17 |
| Liga MX Apertura, December 31 | 10 |
| World Cup 2026 | 8 |
| Leagues Cup 2026 | 2, plus one teams read |

A season with no later phase normally stops after one window, at most 5 calls. The
measured LaLiga and Premier League reads on October 30, 2026 took 0.4–0.6 seconds.

Add one standings read when that 60-second cache is cold. Leagues Cup computes its
tables from a scoreboard and a teams read instead, so a cold read reads its one phase
month twice: `computeTables` bypasses the window cache, and changing the core store
was out of scope. Its table re-reads that month every 60 seconds while viewed, as it
did before this feature. A warm read makes no upstream
call: results stay in the existing 120-second `getFixtures` cache, keyed by UTC-date
range. No summary is requested until a badge is clicked. Concurrent readers of one
competition season share one read per server instance. Its scoreboard windows are
cancelled when the last reader leaves. The standings read is not, because `getStandings`
takes no signal: the form stops waiting for it, and the request itself runs to the
platform's fetch timeout. So one instance runs at most one set of cold calls at a time per
competition season, and a new set only once a window has expired, failed or been
cancelled. Failed windows are not cached; a client backs its retries off (below).

Steady state while a competition is being viewed: a client's five-minute refresh
outlives the 120-second window cache, so one instance repeats at most one full set per
120 seconds. That is about 2.5 calls a minute for a league with no later phase, and
about 10 a minute for MLS at year end, its worst case. No derived form is cached,
because it would hold back the read that follows a table change.

Measured response bodies on October 30, 2026, uncompressed: Liga MX 31 KB, LaLiga
35 KB, Leagues Cup 38 KB, World Cup 49 KB, MLS 52 KB.

## Refresh

`StandingsLive`'s existing 30-second poll calls `tick`. Form refetches only when:

1. the first answer has been held for 150 seconds: once, without a notice, because it
   may predate the server-rendered table;
2. the table's counts change: at once, and again 150 seconds later, once the
   server's scoreboard cache must have moved past that change;
3. five minutes have passed;
4. the last load failed: after 60 seconds, 120, 240, then every five minutes.

These times are earliest due times: the read runs on the first poll after, so up to 30
seconds later, because the page keeps one timer. One request runs at a time, with a
30-second client deadline, and unmount aborts it.
A page with no table requests nothing until a table arrives. No notice appears before
kick-off or on an edition that offers no form.
From a table change until the 150-second read, a visible "catching up" notice says
the badges may be behind the table. If a refresh fails, the last good badges stay
under a visible "may be out of date" notice until a load succeeds, and telemetry
records one failure and one recovery (`standings-form`).

## Known limits

- A regular-season match rescheduled into the playoff weeks is ordered by kickoff,
  so the played-count boundary can misplace it.
- A read cancelled by its last reader caches only the windows it finished, so repeated
  connect-and-abort requests can restart scoreboard reads. The public `/matches` route
  forwards cancellation the same way.
- Whether Greece's split playoffs count in ESPN's `gre.1` table is unverified until spring
  2027. Past the configured 26 rounds a team shows as unavailable, not as regular-season
  form. Re-check against a recorded post-season payload then.
- An early-stopping read does not check the table count, so in a league with no later
  phase a newest match missing from the provider's scoreboard goes unnoticed: the next
  five visible results show. Detecting it would need the season read early stop avoids.
- A match missing from the provider's scoreboard while the team also has a later-phase
  match leaves the count balanced, so that playoff match can pass as regular season.
- The phase slug ESPN sends is not on `Match`, and carrying it would be a contract
  change, so the regular-season note says the count is what leaves playoffs out.
- For up to 150 seconds after a page opens, a result already in the server-rendered
  table can be missing from the badges without a notice, in an early-stopping league.
- Up to 150 seconds after a result, a team can show an "unavailable" gap while the two
  caches disagree. If the table lags the scoreboard, a later-phase league drops the
  newest match, which keeps the form consistent with the table on screen until the
  table moves and the "catching up" refresh runs.
- A one-off tie-break on a league with no later-phase zone (Serie A's title or
  relegation spareggio) is not separable, so it would count as season form. An
  early-stopping read cannot see that surplus.
