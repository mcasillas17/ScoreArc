# Reader evaluation (T16.4)

This is explicit evaluation tooling. The website still returns its existing ESPN
result. Nothing imports the evaluator into a page, route, scheduler or source
selector. No production traffic, configuration, deployment or migration is enabled.
T16.3 (#239, `52572d6`) is the adapter baseline; migration 0028 must not be repeated.
The branch was reconciled with latest main `a6a1db8` (undici lockfile update);
there were no overlapping adapter/index changes.
News remains an ESPN delegate and is **excluded**, never an independent success;
T16.6 remains unresolved. T16.5 soak/cutover approval is separate.

## Run offline

```sh
# No arguments: disabled JSON report, zero requests, no fixture server or health probe.
npx tsx scripts/reader-evaluate.ts

# Isolated recorded/synthetic exercise. These flags affect this child process only.
env -u SCOREARC_DATA_SOURCE -u SCOREARC_READER_ORIGIN \
  npx tsx scripts/reader-evaluate.ts --offline > /tmp/reader-evaluation.json

npx vitest run src/server/data/evaluation scripts/reader-evaluate.test.ts src/server/data/readerTransport.test.ts
```

The runner constructs **direct `createReaderDataStore`** and **explicit
`createDataStore`** instances, never `dataStore`, `configuredDataStore` or
`createSelectedDataStore`. The regression test makes the reader return 500 while
ESPN succeeds: the result is an error, not an ESPN-vs-ESPN match. Every transport
failure is recorded, including failures ESPN's optional summary/profile blocks
catch. There is no fallback, retry, shared primary cache, notification or DB access.
Existing default-source and navigation tests remain in the full suite.

Both factories receive the evaluation clock. ESPN implicit windows use the paired
sample's clock; reader policy uses response-time freshness. If an implicit reader
window crosses a date boundary, it becomes unavailable instead of comparing
non-equivalent ranges. No default website clock behavior changes.

A user-reported local smoke-test bug is repaired in the shared match popup: all
callers pass their existing competition `teamStyle`, club popups use supplied
crests, and a missing club crest falls back to its abbreviation rather than a
country with the same abbreviation. National-team flag rendering is preserved.

## Comparison matrix and per-method acceptance

Every row below additionally requires the exact sampled competition, season,
query and entity; usable complete/empty resource evidence; no dependency failure,
unknown scope, unresolved live race, truncation or broken link; and equality of
**all** compared fields after the named rules below. There is zero tolerance for
wrong entity, side, score, winner or match-link attribution. A missing match is
coverage disagreement, never an ignored row. No universal percentage is defined.

| Method | Explicit selection / semantic acceptance |
|---|---|
| `getMatches` | Required range, at most 14 days; complete event set, kickoff/state/status, side IDs, regulation/shootout/winner, scorers/cards/stats and retained summary fields |
| `getFixtures` | Required range, at most 92 days; complete event set and all core match fields, same scoped window; no summary enrichment |
| `getLiveWindow` | Same effective current window; all core match fields. Live observations remain inconclusive until their timing can be accepted; identical live values alone are insufficient |
| `getUpcoming` | Same effective forward window and limit (default 12, max 100); exact scheduled event selection and chronological order, sides and nullable scores |
| `getStandings` | Every table/membership, team, rank, played/W/D/L, goals, points and advancement; MLS overall and all Leagues Cup phase/membership inputs retained separately |
| `getBracket` | Round slugs and order, event membership, placeholders, sides, kickoff/state/scores/shootout/winner; only round display name excluded |
| `getMatchSummary` | Same addressed event and supplied home/away; every scorer/card identity and side, own-goal/penalty flags, stats, lineups, nullable starter, retained media/form/H2H/participation fields |
| `getLeaders` | Both goals and assists, each rank/order, athlete/team references, values and appearance counts; no legacy top-scorers substitute |
| `getTeam` | Requested entity, record/rank, squad, complete scoped schedule and availability, all nonexcluded profile fields; schedule rows remain compared |
| `getSquad` | Complete roster membership, provider roster order, athlete identity, nullable statistics, jersey, position and held profile fields |
| `getPlayer` | Requested identity, held totals, career order, exact log membership/chronology, per-match team/opponent/sides and score/result. The ESPN overview's mixed scope is unverified, never intersected with the reader's five held rows |

Current-only ESPN tables, statistics, rosters and profiles cannot establish
historical parity. Unsupported editions remain attempted/unavailable without
fetching. A current edition is necessary but insufficient: the runner also
checks available provider season/league/header evidence, including undated
bracket scoreboards. Missing evidence is
`scope_unverified`; contradictions are `scope_mismatch`. Summary header identity
and actual adapter side arguments are checked, including private bulk enrichment.
The isolated ESPN store exposes an optional observation callback for those
arguments; production supplies no callback. Missing/malformed provider event,
roster or statistics collections cannot count as explicit empty answers. The
bracket reuses the existing scoreboard envelope, pagination and event validators.
Roster mapping must preserve the supplied membership count; caught parsing
failures cannot become an empty roster. Missing leaderboard
categories retain partial evidence. ESPN request timestamps are **not**
source-observation timestamps. Its upstream observation remains null.

## Joined paths

The manifest selects the same explicit target on each side; missing targets never
cause either side to choose a different row. All work is awaited:

- `listPopup`: scoped list → declared event → summary using that row's sides.
- `playerPopup`: declared profile → declared held log row → existing
  `gameLogDetailInput` → summary; the actual slug index must resolve back to the
  same provider athlete. Reader unknown result/live context stays unlinked.
- `teamSchedule`: declared team → scoped schedule target → summary, including
  canonical public team-link validation.
- `leaderLinks`: both boards → existing `competitionPlayerIndex` → forward and
  reverse slug checks. An addressed index permits at most 64 distinct teams;
  it reads squads, never one profile per player.
- `formPopup`: existing T7.3 `loadStandingsForm` → declared team's badge → match
  from the returned set → summary. Missing badges, wrong sides and partial form
  remain visible. Separate MLS and Leagues Cup `getStandings` samples exercise
  the existing derived-table implementation and its resource inputs.

Optional enrichment helpers can swallow failures or race an 800 ms timer; the
runner uses the strict awaited index instead. No private selected-store marker
or fallback registration is necessary.

## Named normalization policy: `reader-evaluation-v1`

| Rule | Exact boundary |
|---|---|
| T16.3 adapter crosswalk | Existing persisted identity translation only; no evaluator name/score/time inference. Provider IDs at the seam remain compared |
| `instant-v1` | Match kickoff, player-log date and H2H date represent the same exact instant; timezone/text precision may differ. Fractional instants are not rounded |
| `match-set-order-v1` | Unordered match sets sorted by ID. Upcoming order, roster order, leader order, standings row rank/order, career and log chronology stay significant |
| `group-set-order-v1` | Table collection order only; keeps distinct tables, all membership rows and their rank/order |
| `nationality-empty-null-v1` | Only squad/player nationality empty string → null, matching the documented writer projection |
| `resource-evidence-v1` | `readerResources` and group `readerDerivation` are evaluated as evidence, not equal to an absent ESPN envelope |
| `qualified-canonical-player-ref-v1` | Only leader/lineup `playerId` is a reader-qualified canonical reference; provider athlete ID and public `playerSlug` still compare |
| `bracket-round-display-v1` | Reader-only round display name; slug/order/event membership still compare |

Each sample lists rules applied and excluded schema paths. There is no recursive
null coalescing, numeric coercion, case folding, tolerance for scores, row
intersection or dropping unknown fields. Absent/undefined/null/empty/zero/false
stay distinct except the one named nationality rule. Paths use a fixed schema
vocabulary; dynamic keys/IDs and raw values are not dumped.

Documented held-player projections (five scoped logs, fifty held career stints,
fifteen stored totals, null flags/headshots and stored display labels) do not
establish full provider parity. This version conservatively retains those
payload differences and their partial/scope evidence rather than discarding
scores or silently intersecting rows. Likewise team sponsor/competition wording
can remain a `value` difference. A future accepted field projection needs a new
named rule, regression and policy version; it cannot waive entity/side/score/link
criteria. No held-subset result is declared full profile parity.

## Evidence, counts and safety caps

All manifest samples are in `attempted`, even after cancellation or budget/time
exhaustion. `comparable = matched + mismatched`; the mutually exclusive four
outcomes sum to attempted. Counts are also grouped by method/scenario in `byKind`.
Unavailable/error cases never become matches. Semantic difference categories
remain attached even when scope, freshness or dependencies make a comparison
inconclusive. Any attribution or broken-link category blocks acceptance,
including on an unavailable sample.

- `entity`, `side`, `score`, `coverage`, `link`, `value`: bounded schema-path
  differences; inspect the named contract/adapter and reproduce the same scope.
- `stale`, `partial`, `unavailable`, `observation_unknown`: inspect resource
  status, availability, observation/finalization and derived-input envelopes.
  Dormant is usable only with complete/empty evidence and an observation; it
  never masks incomplete data.
- `lifecycle_unknown`: an addressed summary lacks a trustworthy lifecycle header;
  the summary DTO itself does not contain match state. This remains unavailable.
- `live_race`, `timing_skew`: retained live score differences and observation age
  relative to the paired request. This is possible race evidence, not an excuse
  or a proven cause. Stable finished-score disagreements remain disagreements.
- `unsupported_scope`, `scope_unverified`, `scope_mismatch`: no equivalent
  comparison established. Do not interpret partial-body differences as parity.
- `http`, `network`, `metadata`, `body`, `dependency`, `budget`, `timeout`,
  `cancelled`: sanitized failure codes; no upstream error text or SQL.

ESPN summary request evidence retains lifecycle state, using the existing final
header predicate. Live summaries remain inconclusive even when mapped details
agree; missing state cannot become a match.

Each side reports start/end/duration, actual HTTP calls/body bytes, bounded
request timing, route and scope/query evidence, and reader resource metadata.
Optional resource expiry is evaluated through the existing `readerPolicy` even
when an array DTO does not carry an evidence envelope. Reader timestamps are
retained separately for every resource/request; no global
snapshot time is fabricated. Fresh caches are private to one side of one sample;
no cross-sample cache reuse, and the run-wide budgets survive new caches.

| Bound | Limit |
|---|---:|
| Manifest / samples / distinct requested scopes | 32 KiB / 32 / 4 |
| Calls / consumed body byte threshold per source per run | 128 / 32 MiB |
| Response body threshold | 4 MiB |
| Concurrent HTTP reads | 4 per source, 8 combined |
| Paired samples / retries | 1 at a time / 0 |
| Sample-side / entire-run deadline | 10 seconds / 120 seconds |
| JSON report / differences per sample | 1 MiB / 64 |
| Comparator traversal | 100,000 nodes, depth 32 |

Streaming rejection includes the chunk crossing a byte threshold; already-active
reads may receive a final chunk. Actual consumed bytes include those chunks.
Queued and later requests stop after the run's byte threshold is exhausted.
Headers/body wait and queue time count toward deadlines. Report truncation is
explicit; omitted evidence counts stay visible and a truncated report cannot
establish acceptance. No request-path sampling or unmanaged background work.
These safety caps are not soak targets or SLO acceptance values.

## Offline sample and limits

[`reader-evaluation-sample.json`](reader-evaluation-sample.json) is a bounded
recorded/synthetic run, not a production snapshot. It samples all eleven methods,
five joins and both MLS/Leagues Cup tables in three requested scopes. The World
Cup index is deliberately only Argentina/France; Ali Avila membership and some
log references are synthetic. Provider/player scope and held-detail gaps are
intentionally exposed. Other competitions, entities, real live races, sustained
freshness, production latency and broad coverage were not sampled.

The checked-in run attempted 17 samples: 5 comparable (4 matched, 1 mismatched),
12 unavailable, 0 errors. It consumed 54 reader calls / 315,922 body bytes and
44 ESPN calls / 6,263,908 body bytes. The report records per-request latencies;
timing varies per machine and fixture bytes include local transformations.
Reproduce with the offline command, not by sending these synthetic IDs upstream.

## Separately authorized live procedure — not executed or enabled

1. Obtain owner authorization for the reader origin, explicit real scopes/entities,
   total sample volume and time. Resolve data-rights/coverage questions separately.
   Migration 0028 and T16.3 are already deployed per owner; do not migrate again.
2. On a local operator machine, prepare a version-1 manifest within the caps. For
   example, one settled window (choose the real scope/date with the owner):

   ```json
   {"version":1,"samples":[{"competition":"world-cup","season":"2026","kind":"getFixtures","range":"20260629-20260630"}]}
   ```

3. Only after that separate authorization, run once with a public HTTPS origin
   (no credentials, path prefix, query, fragment, redirects or production config):

   ```sh
   env -u SCOREARC_DATA_SOURCE -u SCOREARC_READER_ORIGIN \
     npx tsx scripts/reader-evaluate.ts --live \
       --manifest=/absolute/path/approved-reader-sample.json \
       --reader-origin="$APPROVED_READER_ORIGIN" > /tmp/reader-live-evaluation.json
   ```

4. Inspect every unavailable/error denominator and critical difference, then
   repeat only within the approved scope/budget. Stop with Ctrl-C if needed.
   No cron, traffic tap, production schedule or notification is installed.
5. Owner decisions still required: minimum samples per method/scope/state,
   soak duration, acceptable observation skew, freshness/latency/cost SLOs,
   coverage gaps and any additional held-field projections. This tool does not
   decide a universal match rate or authorize T16.5 cutover.
