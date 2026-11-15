# Player directory (T12.4)

`/[locale]/c/[comp]/[season]/players` searches the currently available rosters of
teams listed in that competition/season. Players is available in the competition
sidebar, phone drawer and bottom navigation; singular player profiles also
highlight that section. There is no site-wide roster fan-out.

## Coverage and identity

Only the competition's configured current season offers search. Older season
routes explain that historical roster discovery is unsupported and link to the
current directory; their metadata carries the same limitation. Even for a
concluded competition's configured current season, these are current rosters,
not a historical record of every player who participated.

The directory reports teams with a nonempty roster out of distinct listed teams.
That count does not certify completeness. No listed teams, no roster data,
partial roster coverage, no search matches and failed directory loads are distinct
states. Default ESPN's existing roster method returns an empty array for both an
empty roster and an unavailable roster; the UI does not claim it can distinguish
those. Required reader/fallback errors propagate and produce an explicit
unavailable state, never an apparently successful empty list.

`competitionPlayerIndex` still owns the identity join. Its added `directory`
projection is created alongside `bySlug` and `byProvider` inside the same
`runDataOperation` callback, from the same roster rows. Fallback discards and
rebuilds the entire result, including display names, team context and links.
Source-selection code, transport bounds and reader activation are unchanged.

`buildSlugMap` and public URLs are unchanged. Existing limits remain: a player on
multiple rosters keeps the first listed roster; partial membership can change
collision suffixes; indistinguishable same-name/same-team entries without distinct
jerseys can overwrite an entry in the existing slug map. The directory retains an
unresolved player as plain text rather than guessing a slug. Resolving those public
identity limitations belongs to a separate contract change.

Search is local, accent-folded through existing player-name normalization, and
matches player names, roster team names and abbreviations. The page sends only
name, slug and team labels to the search component, without profile/stat/headshot
payloads. Directory `PlayerName` links use `prefetch={false}`: profiles are loaded
when selected, not for every result or hover. Other PlayerName consumers keep
existing prefetch behavior.

## Verification and measurements

Verified November 2, 2026 on an isolated local checkout, default ESPN and explicit
local reader mode. The reader fixture is **synthetic**, including Ali Avila's
Argentina membership; it is not a live parity or historical-coverage dataset.
No production configuration, monitoring, backend migration or deployment changed.

Isolated directory-operation measurements (decoded upstream response body bytes;
cold cache followed immediately by warm cache, excluding shared page chrome):

| Source and scope | Players / roster teams | Cold requests / bytes | Warm requests / bytes | Serialized directory |
| --- | --- | --- | --- | --- |
| Live ESPN, Liga MX 2026-apertura | 584 / 18 of 18 | 19 / 2,094,004 | 0 / 0 | 53,661 bytes |
| Synthetic reader, World Cup 2026 | 1 / 1 of 48 | 49 / 12,864 | 0 / 0 | 129 bytes |

ESPN's existing parallel roster path peaked at 18 calls, taking 1,135 ms cold and
2 ms warm. The reader peaked at four under the unchanged shared budget, taking
45 ms cold and 1 ms warm. These are individual local observations, not comparative
provider benchmarks. Other competitions, unknown team crosswalks and cache expiry
can require different counts; warm reader operations are not generally zero-call.
Neither measured index read requested player profiles.

Production-build browser loads (cold/warm server data cache, existing browser asset
cache) for the live Liga MX directory returned HTTP 200
and 201,510 decoded HTML bytes (28,143 transfer bytes) for both cold and warm loads.
Observed document response-end time was 3,091 ms cold and 38 ms warm. Browser
resource counts were 27/27, with 13,361/13,364 reported transfer bytes respectively;
these include shared page assets, and cross-origin timing restrictions can omit
asset sizes. The HTML already includes server-rendered rows and hydration data.
Production typing and link hover produced zero data or profile-prefetch requests.

Behavior checks:

- EN/ES accent/name/team search, empty search result and keyboard Tab/Enter to
  `/player/ali-avila`; visible focus outline. Historical 2018 page loads no index.
- Widths 320/440/560 (stacked rows), 600/680/760 (phone navigation),
  800/830/860 (desktop rail with compact page padding), and 1280. No horizontal
  overflow; smallest visible phone target 50.8 × 55 px. Bottom navigation remains
  at the viewport edge after scrolling. Measurements wait for the existing
  200 ms sidebar transition; hidden desktop bottom tabs are intentionally zero-size.
- Synthetic reader EN/ES directory → profile; partial coverage of 1/48 teams.
  Injected squad 500 rebuilds the complete 584-player Liga MX list through ESPN.
- Default ESPN Liga MX standings: 90 form badges and a populated match popup.
  Synthetic Leagues Cup: 114 badges and match popup, including fallback when its
  roster join fails. Existing player-page and standings-form tests remain green.
- Default source mode leaves every synthetic reader counter at zero.
- `npm test`: 117 files, 2,006 tests. Typecheck, lint and production build exit 0.
  Lint retains five baseline warnings. Local production analytics script 404s and
  Next middleware/Edge deprecation warnings predate this feature.

## Reproduce

```sh
npm test
npx tsc --noEmit
npm run lint
npm run build
npm run dev -- --hostname 127.0.0.1 --port 3474
```

Browse `/en/c/liga-mx/2026-apertura/players`, its `/es/` counterpart, and
`/es/c/world-cup/2018/players`. Search `america`, `queretaro` or `ali avila`, then
Tab to the result and press Enter. Players is also in each competition's navigation.

For reader mode, start `npx tsx scripts/reader-preview.ts --port=4398`, stop the
frontend and restart it explicitly with:

```sh
SCOREARC_DATA_SOURCE=reader SCOREARC_READER_ORIGIN=http://127.0.0.1:4398 \
  npm run dev -- --hostname 127.0.0.1 --port 3474
```

Browse `/en/c/world-cup/2026/players`, `/es/c/world-cup/2026/players` and
`/es/c/leagues-cup/2026/standings`. Local fixture fault controls and counter reset
are described in [READER_DATASTORE.md](backend/READER_DATASTORE.md).
`src/server/data/playerDirectory.test.ts` exercises the actual synthetic transport,
coverage, warm cache, byte/call/concurrency bounds and absence of profile fan-out;
`playerIndex.test.ts` pins grouped fallback, exhaustion and cancellation.

Unset both source settings and restart to return this local preview to ESPN.
Production remains on its existing source settings. T16.4 evaluation and T17.4
monitoring are separate work; this task does not alter either.
