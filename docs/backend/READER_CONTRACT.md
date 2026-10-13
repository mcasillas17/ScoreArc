# Reader contract harness (T16.1)

October 3, 2026. The executable contract between the frontend `DataStore`
(`src/server/data/store.ts`), the Go reader (`backend/reader`) and
`backend/reader/openapi.yaml`. **This is not reader parity, an `apiStore`, or
permission to cut over.** ESPN remains the production source, and no application,
reader, OpenAPI, SQL or migration behavior changed with the harness.

**T16.2 (October 4)** changed behavior on both sides to resolve 13 of the 14 gaps
the harness assigned it, plus its three unregistered items; see
[T16.2 identity and DTO contract](#t162-identity-and-dto-contract). Its last gap,
`standings-dedup`, closed on October 5 with the owner's decision to keep every
table membership ([below](#owner-decision-standings-dedup)). Every E10/E17 gap
below remains: this is still not parity or cutover readiness.

The harness separates three things:

- **implemented reader behavior**: what the Go mappers, handlers and SQL return
  today;
- **the intended frontend contract**: what the TypeScript types and real store
  produce;
- **named incompatibilities**: each one is a gap with a roadmap task.

The gaps are characterized, not normalized away.

## Files

| File | Role |
|---|---|
| [`src/server/data/contracts/reader-contract.json`](../../src/server/data/contracts/reader-contract.json) | Shared vectors and the single source of truth: method inventory, gap registry, recorded-payload expectations, labeled synthetic cases |
| `src/server/data/contracts/reader-contract.test.ts` | Runs the real `createDataStore`, the ESPN mappers, the matches route and `parseMatchFreshness`. Pins full independent type shapes with `expectTypeOf`, checked by `tsc` |
| `backend/reader/reader_contract_test.go` | Runs the Go mappers on the same bytes, the reader DTO wire JSON, OpenAPI schema validation, and the real router and handlers over fake storage |
| `backend/reader/reader_contract_integration_test.go` | Testcontainers Postgres: ingester writer (`shared/store`), then reader SQL as the least-privilege `scorearc_reader_test` login, then HTTP |

Run them with `npx vitest run src/server/data/contracts`, `npx tsc --noEmit` and
`cd backend && go test ./reader -run '^TestReaderContract'`. Vitest does not
typecheck: `tsc` is what enforces the `expectTypeOf` shape pins and the
inventory. The Go command needs Docker; on Colima, set the environment described
in AGENTS.md first. All three run in CI (`npm test`, `tsc`, `go test ./...`).

## Methods

| Method | Reader route | Coverage |
|---|---|---|
| `getMatches` | `/v1/competitions/{comp}/{season}/matches` | Window months, ids, ordering, summary enrichment fan-out; the recorded scoreboard core fields and penalty aggregates; shared shootout-precedence vectors |
| `getFixtures` | same | Explicit and default ranges, date boundaries, clamping to split and historical seasons without a provider call |
| `getLiveWindow` | same | Live window selection; live minute with and without ESPN's display clock |
| `getUpcoming` | same | Scheduled-only rows, limit |
| `getStandings` | `…/standings` | Recorded groups and table rows (rank, stats, team identity), unnamed tables, MLS derived tables, synthetic duplicate-rank, missing-stat and empty tables; a team in two tables (stored, snapshotted and served in both); conflicting tables rejected |
| `getBracket` | `…/bracket` | Recorded rounds and every match (id, round, state, sides, scores, winner), placeholders, clockless live match |
| `getMatchSummary` | `/v1/matches/{id}` | Recorded scorers, cards, stats, lineups, win probability, info, form, head-to-head, videos and commentary; synthetic shootout detail, head-to-head, red card and unattributable scorer/card; own goal; canonical scorer/card sides on new and sealed legacy rows; route-layer player slugs; match-id translation; top-level key set |
| `getLeaders` | `…/top-scorers` | Recorded scorer and assist boards (values, ties, identity) |
| `getNews` | `/v1/competitions/{comp}/news` | Recorded articles, identical through the real reader proxy |
| `getTeam` | `…/teams/{teamId}` | Identity, location, record, colors, standing summary, squad, schedule ids, order and scope, partial-failure behavior, cache header |
| `getSquad` | same, embedded squad | Recorded roster order, ids, jersey, position, nationality, stats, age and headshots |
| `getPlayer` | none | Recorded identity, game log and career, with missing-context degradation |

Adding or removing a `DataStore` method fails `tsc`: two-way
`Exclude<keyof DataStore, …>` checks against the inventory, plus a runtime key
check on the store object. The Go suite requires the inventory routes plus
`/healthz` to equal the OpenAPI paths and the chi router's routes. The
TypeScript suite and `TestReaderContract` each end by requiring that they
exercised all 12 methods. Every suite (`ts`, `go` and `go-db`) ends by requiring
that the gaps it characterized equal the gaps the JSON assigns to it. A deleted
or skipped characterization therefore fails, in any skip form; the TypeScript
ledger never skips itself, and the file also rejects declared `.skip`, `.todo`,
`.only`, `.skipIf`, `.runIf` and `{ skip: true }`-style options. A Vitest `-t`
filter that selects the ledger together with only some tests fails it; a Go
`-run` filter that selects subtests skips the Go ledger checks by design.

The suites also cover, across methods:

- **Query and error behavior:** the matches route's query-to-method dispatch and
  its 400s, season mismatch, cancellation, provider failures that reject rather
  than return empty, and sanitized reader 500/502 bodies.
- **Freshness:** headers for eight frozen-clock snapshots through the real route
  (fresh, empty, dormant, stale, unavailable; ok, partial, failed and unknown
  polls), parsed by `parseMatchFreshness`. Rejection of invalid metadata stays
  owned by `src/lib/matchFreshness.test.ts` and `backend/reader/freshness_test.go`.
- **Transport:** frontend and reader error envelopes are pinned separately and
  never treated as interchangeable. Cache headers are checked against their
  OpenAPI descriptions.

## Evidence and normalizers

Expectations come from three kinds of evidence:

- **Recorded:** unmodified ESPN payloads in `src/server/data/__fixtures__`. Both
  languages read the same bytes.
- **Synthetic:** labeled in `evidence.synthetic`. These are the query window
  and live-minute events, freshness snapshots, transport paths, the summary
  overlay (including a goal and a card credited to neither side, and its
  header-identity and level-header cases), the scoreboard shootout precedence
  cases, the clockless and live-shootout bracket events, the unnamed and
  tie/dedup/malformed standings tables, the player missing-context overview,
  test match and bracket UUIDs, the integration suite's standings tie rows,
  provisional team, stored clockless live row, sealed legacy detail rows with
  their aligned match events, resolver-minted match, finalization winner rows,
  and the Leagues Cup competition, teams and match row under the recorded own
  goal, and the seeded Liga MX standing behind the reader team record and
  standing summary. None is a production crosswalk.
- **Crosswalk:** provider-to-canonical team ids come from the production seed
  (`backend/config/teams.seed.json`) and are verified in both languages; the
  go-db suite stores them as `team_external_ref` rows, and proves match ids
  through `match_external_ref` with the real resolver.

Expected values were checked against the raw payloads, not only against mapper
output. Each language checks them with its own independent implementation.

The only normalizers are named:

- the production team crosswalk, and the nested team-id translation it
  implies (below);
- kickoff instant comparison (ESPN minute precision vs reader RFC3339 seconds);
- the writer's `''` → `NULL` nationality;
- the `value` → `goals` leader projection;
- test UUIDs for provider event ids.

Nothing incompatible is stripped to force equality. Missing, `null`, empty,
zero and `false` are compared exactly.

## T16.2 identity and DTO contract

### Identity translations

These differences are intentional: each store serves its own identity space,
and the harness proves a translation instead of an equality. They are not gaps.

| Identity | Frontend (ESPN-backed) | Reader | Proven translation |
|---|---|---|---|
| Match | ESPN event id; list rows and its own summary fetch use it | UUIDv7; `/v1/matches/{id}` accepts nothing else (a provider id is 404) | `match_external_ref (source, source_id) → match.id` through the real resolver: the recorded event adopts the served match on its natural key, and a new event mints a stable UUIDv7 that the list route serves and the summary route addresses |
| Team | ESPN team id | canonical slug (`nat-civ`) | the curated seed, identical in both languages (`teamCrosswalk.json` equals the seed's ESPN map); `canonicalTeamId` accepts either space, so links and follows built from reader ids match |
| Scorer/card `teamId` | the provider id ESPN credits, normally a match side (kept as sent even when it names neither) | the canonical id of that side, or `null` | stored `match_detail` keeps the provider id; the reader translates at read time through each side's `team_external_ref` ids for the match's source (one statement, no per-event queries). A reference naming neither side, or both, is `null` — never a default side |
| Player | `athleteId` = provider athlete id; `playerSlug` filled by the match route | the same provider `athleteId`; no `playerSlug` | `withSummaryPlayerSlugs` resolves the same slugs from either store's scorers; a `null` id gets no link. Public player identity is T10.3/T10.4 (`squad-fields`, `player`) |

Match ids are store-scoped, so for T16.3 every method that produces or consumes
them (the four window methods, `getBracket`, `getTeam`'s schedule, `getPlayer`'s
game-log `eventId`, `getMatchSummary` and the match route's `home`/`away` side
ids) must read from the same source and fall back together.

### Resolved gaps

| Gap | Contract | Proof |
|---|---|---|
| `match-id`, `team-id` | the translations above | TS round-trip and helper tests; Go seed equality; go-db resolver |
| `nested-team-id` | reader serves canonical sides or `null`; `Scorer.teamId`/`Card.teamId` are `string \| null` in both contracts | TS translation of real store output equals the reader vectors; Go and OpenAPI over the seed; go-db over `team_external_ref`, including an unattributable pair |
| `scorer-identity` | `ownGoal` (`boolean \| null`) and `athleteId` (`string \| null`) in both; an own goal credits the side that benefits | recorded own goal in every suite, in go-db through the ingester's writer and the reader's summary and list routes; route-layer slug parity; sealed legacy rows recover both from aligned match events, and serve `null` (not `false`) without them (below) |
| `standings-rank` | each table ordered by ESPN's `rank` stat when it is a complete `1..n` permutation, else provider order | recorded World Cup groups arrive out of order; both languages |
| `standings-malformed` | the ingester's rule: a table with no teams, or a row with no or an empty team id or a missing required stat, rejects the payload, and so does an envelope with no `children` array; `children: []` is a legitimate empty table set. In the frontend, a payload whose only defect is a stat still yields its team identities to the team and player indexes (`StandingsStatsError.teams`, read by `standingTeams`), so slug links survive it; the standings page itself rejects it. A rejected payload is cached for the same 60 s as an accepted one, so the page and both indexes cost one upstream fetch, not one per read | shared malformed and envelope vectors: TS throws where the Go mapper rejects; the ingester's existing replacement guards keep stored standings when a payload is rejected |
| `group-label` | an unnamed table is labeled with the competition short name | both languages |
| `placeholder-crest` | an empty provider logo is no crest (`null`), on the bracket and on the match-list, team-schedule and leader mappers that shared the defect | both languages, on the recorded placeholder through the bracket and match-list mappers; TS mapper tests for the team schedule and leaders |
| `round-slug-type` | OpenAPI `KnockoutRound` enum on `BracketRound.slug` and `BracketMatch.round`, equal to the Go round order and the TS slug union | Go and `tsc` |
| `bracket-round-name` | contract decision: `name` is an additive English label for API consumers; the frontend localizes from `slug` | each reader name equals the frontend's English catalog label |
| `shootout-source` | summary header → scoreboard structured `shootoutScore` → anchored note → `null`. A scoreboard total is a non-negative integer or a string of digits (`''` and `null` read as 0), and the two are not both zero; anything else rejects the scoreboard. The summary header keeps its existing wider numeric rule. A header supplies totals only for its own match: its id and its single competition's id equal the event, and its two competitors are the event's sides, else it is ignored. A finished match is won by the side its served aggregate names when decisive, overriding the scoreboard's winner flags, and otherwise by ESPN's own flag: a level summary header that supersedes a decisive scoreboard aggregate falls back to the flag, never to the superseded aggregate's winner; a live, partial shootout names no winner, on the match list, the bracket (so no side advances early) and the ingester's summary recovery path alike; the ingester finalizes with the summary's winner and stores it as resolved, so a level final aggregate with no flag clears a superseded stored winner even on a match the bracket never confirmed (a finalization without final shootout evidence keeps the sparse rule); a match rebuilt from the finalization backlog keeps no flag: an observation of the same match this cycle, under any of its provider ids, outranks that stored row in the candidate merge, so its team ids, flag and structured totals are the ones finalized, and a stored row nothing observed takes ESPN's flag from the final summary header instead, and the final detail write stores that same evidence for both shootout fields (aggregate and kicks), or none, never a live poll's partial. The reader serves a finished match's stored winner, without re-deriving it from the stored aggregate (below), and no winner for a match that is not finished, so a provisional winner the bracket mapper stored mid-shootout before T16.2 is not served; the mappers keep ESPN's winner flags for such a match, and no recorded live payload sets one. The team schedule takes the scoreboard tiers and winner rule on its own competitor shape; as a lightweight per-team feed it ignores a malformed structured total instead of rejecting the feed. Both bracket mappers take the same tiers and winner rule (structured totals, else the anchored note, then the flags), and each rejects a malformed structured total by the scoreboard's rule, so a season whose bracket the frontend reads from one undated scoreboard rather than the dated window (Leagues Cup 2026) fails closed too. A match the ingester knows only from the bracket carries the bracket's aggregate (structured totals, else its note; off the served bracket) into the summary precedence, so a summary without header totals cannot let a conflicting note decide it. The frontend caches a summary per event and sides, because its totals are mapped for those sides, and a finished match takes that summary's header only once the header is final too by Go's `requireFinal` predicate (`observedMatchState`): a `STATUS_` name with a boolean completion, where a known in-play, scheduled, suspended or postponed name is never final, a terminal one (canceled, abandoned, forfeit) is final on state `post`, and any other is final on `post` with completion, and both sides carry a final score (`scoreOf`), so a summary held from a mid-shootout read keeps the scoreboard's evidence. Regulation scores are untouched; lightweight feeds never fetch summaries | shared precedence vectors (totals and winner) through both mappers; a live and a finished bracket shootout through both bracket mappers; header identity vectors, including a summary first read with other sides; level-header vectors over a decisive scoreboard aggregate with opposing or absent flags (TS store, Go mappers and `ResolveWinner`, ingester finalization); an ingester finalization test; a backlog-only finalization test (header flag, no flag, decisive aggregate, and an observed candidate keeping its own flag), a duplicate-provider-id finalization test (the observation survives with its own team alias, flag and structured totals), the backlog read marking its rows as from storage (go-db) and a source test of the final header's flag; unfinished-header identity vectors in both languages (in play, post without completion, completion missing, completion while in play, an unknown status name, known non-final names contradicted by post and completion, a terminal name final on post but not in play or without completion, and a final header missing a score or carrying one that is not a count) and a TS test of each held from an earlier read; a summary-recovery unit test; go-db through the ingester's writer: a live partial with a stored provisional winner; finalization with no final shootout evidence, after a terminal status, with a final aggregate, and with a level final aggregate over a stored winner, unconfirmed; and a row sealed before T16.2 whose aggregate names the other side, on the match, team-schedule and bracket projections; the Go bracket mapper's carried aggregate and an ingester test of a bracket-only match; the shared precedence vectors through the team schedule and both bracket mappers (TS store winner over the dated window and an undated scoreboard; Go `MapBracket` winner, aggregate and rejection), including a note over an opposing or absent flag, and an ingester test finalizing a real `MapBracket` note-only shootout over an opposing flag |
| `live-minute`, `bracket-live-minute` | a live match without a display clock is `minute: null`; the reader also serves a stored `''` as `null` | both mappers; go-db on match, bracket and team-schedule projections |

The three T16.2 items that were never registered gaps:

- **Leader crest keys:** the ingester mirrors a leader's crest under its team's
  canonical id (`teams/<id>`), the key team crests use, resolving the provider
  team id through the same crosswalk as standings rows (curated or
  provisional). A leader without a provider team id, or whose team cannot be
  resolved, keeps its upstream URL.
- **CDN allowlist:** `safeCrest` accepts exactly `cdn.scorearc.futbol`, and every
  allowed host now requires HTTPS on the default port; lookalikes, subdomains,
  the parent domain and other hosts are dropped. `OG_VERSION` is unchanged: the
  site has never generated a share URL with a CDN crest.
- **Team helper:** `canonicalTeamId` accepts canonical ids as well as provider
  ids (above).

### Historical data and rollout

No migration and no stored row is rewritten. The reader translates every stored
scorer and card reference when it reads, so rows written before T16.2 —
including finalized rows, which stay sealed — are served with canonical sides.

Their `match_detail` scorers never stored `ownGoal` or `athleteId`, but the
ingester's participation capture wrote the same summary key events to
`match_event`, in the same order, with the canonical side, the goal or own-goal
type, and the player. For a stored row whose scorers lack `ownGoal`, the reader
selects that match's goal and own-goal events in the same statement and fills
both fields only when every scorer pairs with the event at its ordinal on
canonical side, minute, penalty and shootout. `athleteId` is the player's one id
on the match's source in `player_external_ref`; a player with none, or with two,
is `null`. Any disagreement — participation never captured or partly skipped, a
side the reader cannot attribute, events from another poll whose goals differ
from the summary's in count, side, minute, penalty or shootout — leaves every
scorer in that match `null`. Nothing is matched by name, so one residual is not
detected: participation capture does not block finalization, and if ESPN
re-credited a goal to another player, or reclassified it as an own goal,
between the last captured poll and the final summary without changing those
fields, the recovered `athleteId`/`ownGoal` is the earlier poll's. That residual
is part of the legacy-row acceptance gap below. The cost
is bounded: current rows pay one jsonpath test; a legacy row adds one
primary-key range scan of `match_event` and one indexed `player_external_ref`
lookup per goal. A go-db test plans the match, team-schedule and summary queries
with sequential scans disabled and requires every correlated lookup — each
side's crosswalk ids, the goal events and their player ids, and the summary's
`match_detail` row — to use its expected index, `match_event` through its
`(match_id, seq)` primary key rather than its type index. The bracket projection
reads only `match` and `team` and adds no correlated lookup.

Shootout winners and aggregates of rows finalized before T16.2 are served as
stored, and neither is provably final. Their winner was resolved from the
observation that finished them (scoreboard flags, bracket totals or a recovered
summary header), independently of the stored aggregate; that aggregate went
through a detail write that kept a live poll's value when the final summary had
none, and a terminal status finalized with no detail at all. A sealed row whose aggregate names the other side than its winner
therefore cannot be resolved from stored data: either may be wrong. The reader
serves the stored winner and aggregate unchanged, and serves no winner for a row
that is not finished. Finding and correcting such rows needs a separately
approved operator procedure; how many exist in production is unmeasured. Rows
finalized from now on store one final evidence for both.

Legacy rows without aligned events stay `null`; nothing else in the database
holds their own-goal flag or athlete id. A recovered row can carry an earlier
poll's player or own-goal flag for a goal re-credited or reclassified before the
final summary (above). The production share of each case is unmeasured:
measuring it is part of production acceptance, and correcting the rest would
need a separately approved operator procedure.

The participation mapper classifies an event as an own goal when ESPN's type
contains `own`; the scorer mapper requires exactly `own-goal`, the only value
recorded. If ESPN ever sent another such type, a recovered legacy row would
call it an own goal where a new row would not.

The reader and ingester can deploy in either order: an old reader ignores the
new JSON keys, and a new reader translates old and new rows alike. Leader crests
move to their team-keyed URLs on the next leader refresh; objects already
mirrored under `teams/scorer-<hash>` stay in R2, unreferenced. Production
acceptance of these changes is a separate step.

### Owner decision: `standings-dedup`

**Decision (owner, October 5, 2026): A — keep every valid table membership, on
both sides.** The alternative was a first-table-only rule on both sides. It
needed no migration, but it would have dropped valid standings for good. Until
this change the frontend kept a team listed in two provider tables in both
tables, while the reader kept only the first. That was because `standing` held
one row per team per season, and `standing_snapshot` one per team per day.

The contract now:

- **Table identity** is the provider's own table id, ESPN's `children[].id`. It
  is stored as `table_key`. It is never the translated display name, and never
  the table's position alone.
  - A lone table may omit the id; it is stored with an empty key.
  - Several tables need distinct ids.
- **Rejected as conflicts, in both mappers:** a team listed twice in one table,
  two tables sharing an id, or a table without an id among several. The writer
  also refuses two provider ids that resolve to one canonical club in the same
  table. Rejection leaves the stored standings untouched; arrival order never
  picks a row.
- **Storage** — migration `0024_standing_table_membership`:
  - `standing` is keyed `(competition_id, season_id, table_key, team_id)`.
  - The `standing_snapshot` day key adds `table_key`.
  - A refresh or a same-day snapshot rerun is idempotent per membership.
  - The partial-replacement guard counts teams, as it did when a team had one
    row. A refresh that drops a whole table but keeps every team is the
    provider's current table set. A refresh that loses a team is still refused.
- **Reading:**
  - The reader returns one `Group` per stored table, ordered by name, then
    table key, then rank and team. Each row keeps its true rank, so zone cuts
    never shift.
  - Two tables that share a display name stay two groups.
  - The team profile's record and position come from the team's first table in
    that same order.
  - The wire shape is unchanged.

**Historical limits.**

- Rows stored before 0024 never recorded a table. They are kept unchanged with
  an empty `table_key`, meaning "not recorded"; no membership is invented. The
  next standings refresh replaces `standing` wholesale with keyed rows.
- Snapshot days before the migration keep the empty key. A series that crosses
  the migration therefore changes key.
- On the migration day, a pre-0024 row can sit beside the keyed rows for the
  same team. Prefer the keyed rows for that day. `standing_snapshot` is
  append-only for the ingester, so nothing removes the earlier row.
- The MLS overall table (T10.10, frontend-only) is unchanged. It merges the
  conference tables and already counts a club once, even if a provider repeated
  it across tables (`computeOverallTable`).
- No configured competition published overlapping tables on October 4, 2026,
  so the multi-table path is proven with labeled synthetic vectors, not
  production data.

Release order and rollback are in
[RELEASES.md](RELEASES.md#migration-0024-standing-table-membership).

## Remaining gaps

The full mismatch text for each gap is in `reader-contract.json` under `gaps`.
The gaps stay open until their tasks land.

| Task | Gaps |
|---|---|
| **T10.1** match queries | `match-query`: the reader ignores range, state, detail and limit, even when malformed |
| **T10.2** summary and leaders | `team-stats`, `lineups` (starters only), `leaders` (goals only, no assists route), `leaders-depth` (frontend shows 10 rows; the reader serves the whole stored board) |
| **T10.3** team and squad | `team`, `team-location`, `team-record`, `standing-summary`, `squad`, `squad-fields`, `partial-failure`, `team-cache-doc` (OpenAPI documents 60s; the route serves 120s) |
| **T10.4** player | `player`: no route or DTO |
| **T10.10** derived standings | `derived-standings` (MLS overall, Leagues Cup phases) |
| **T16.6** news | `news`: a live ESPN proxy, not owned data |
| **T17.3** provenance and freshness | `freshness-coverage`: no freshness headers on standings, top-scorers or news |
| **T21.4** observability | `dependency-error-logging`: six handlers log raw dependency text. `handleTeam`'s sanitized logging is the asserted reference |

Every check fails when its gap closes. To close one:

1. Fix the behavior under its task.
2. Update the vector.
3. Remove the gap id from `gaps` and from each method's `gaps` list, and replace
   its characterization in every suite with positive assertions of the chosen
   contract.

## Drift evidence

Temporary mutations, each restored byte-identically, made the intended suite
fail for the intended reason. They included:

- vector edits;
- TypeScript mapper and route changes;
- Go mapper, DTO and handler changes;
- OpenAPI schema and header changes;
- reader SQL ordering;
- a new `DataStore` method.

Mutations that would close a gap failed with `gap changed: … update
reader-contract.json`. The logs are kept outside the repository.
`go test -race` runs in CI. It could not run on the authoring host, where cgo
was blocked by an unaccepted Xcode license.

For `standings-dedup` (October 5), each of these mutations failed the intended
suite:

- the writer storing every row with an empty table key: the database contract
  suite failed with a primary-key violation;
- the reader grouping without the table key:
  `TestStandingsServeEveryTableMembership` failed;
- the TS mapper accepting a table without an id among several: the TS
  conflicts vector failed.

For T16.2, restoring each old behavior failed the intended positive assertion:
the team helper rejecting canonical ids; an empty live minute in the TS bracket,
the Go mapper and the reader SQL; ESPN's empty placeholder logo; the round-slug
enum removed; provider standings order; a zero-filled missing stat; scoreboard
shootout totals or the summary header ignored; the own-goal flag dropped; an
unknown scorer side defaulted to home, or the read-time translation removed (the
recorded own goal through Postgres catches both its flag and its side); a
URL-derived leader crest key; the CDN host or the port check removed; and a
provider-derived match UUID. The review repairs were checked the same way: the
scoreboard winner flags beating a decisive aggregate (both mappers and the
ingester), a live partial shootout naming a winner (match list, both bracket
mappers and the summary recovery path), a summary cached without its sides, the
level header keeping the superseded aggregate's winner (TS store and ingester),
the finalization writer ignoring a resolved null winner or treating every null
as resolved, the ingester not marking the resolution, a backlog finalization
ignoring the summary header's flag (or an observed one taking it, or keeping it
in provider space), the source dropping that flag, a merge keeping a stored row over
an observation, the backlog row left unmarked, the TS store taking an unfinished
header (or recording every header as final), the TS final-header predicate
ignoring completion, state, the status prefix, the known non-final names, the
terminal rule or the final scores, the Go final summary accepting
an unfinished header,
the reader naming a winner for a live row, either bracket mapper ignoring the
anchored note (its winner, or the Go aggregate) or accepting a malformed total
(the undated TS path, Go `MapBracket`), the note outranking level structured
totals, a final detail write keeping a poll's
shootout aggregate or kicks, the team schedule skipping the shootout tiers, a
correlated lookup without an index path, the bracket aggregate
dropped by the mapper, the ingester's candidate or its merge, a rejected
standings payload refetched on every read, a summary header for another event or with reversed sides, a padded
or fractional scoreboard total, a missing `children` array or an empty team id
accepted, a stat failure hiding team identities, and legacy recovery ignoring
the minute, the source or a second player id, or recovering a partial list.

### T7.21 participation persistence boundary

[Durable participation recovery](PARTICIPATION_RECOVERY.md) enrolls only future
ordinary finalization transitions under migration 0025. Scores/detail remain
sealed while a bounded sweep validates and atomically completes participation.
The retry ledger is private; reader queries/DTOs/freshness are unchanged.
Already-finalized legacy rows are not enrolled or repaired. The attribution
limitations above remain an open owner decision, not implicitly accepted loss.
