# Reader contract harness (T16.1)

October 3, 2026. The executable contract between the frontend `DataStore`
(`src/server/data/store.ts`), the Go reader (`backend/reader`) and
`backend/reader/openapi.yaml`. **This is not reader parity, an `apiStore`, or
permission to cut over.** ESPN remains the production source, and no application,
reader, OpenAPI, SQL or migration behavior changed with the harness.

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
| `getMatches` | `/v1/competitions/{comp}/{season}/matches` | Window months, ids, ordering, summary enrichment fan-out; the recorded scoreboard core fields and penalty aggregates |
| `getFixtures` | same | Explicit and default ranges, date boundaries, clamping to split and historical seasons without a provider call |
| `getLiveWindow` | same | Live window selection; live minute with and without ESPN's display clock |
| `getUpcoming` | same | Scheduled-only rows, limit |
| `getStandings` | `…/standings` | Recorded groups and table rows (rank, stats, team identity), unnamed tables, MLS derived tables, synthetic duplicate-rank, shared-team, missing-stat and empty tables |
| `getBracket` | `…/bracket` | Recorded rounds and every match (id, round, state, sides, scores, winner), placeholders, clockless live match |
| `getMatchSummary` | `/v1/matches/{id}` | Recorded scorers, cards, stats, lineups, win probability, info, form, head-to-head, videos and commentary; synthetic shootout detail, head-to-head and red card; own goal; top-level key set |
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
  overlay, the unnamed and tie/dedup/malformed standings tables, the player
  missing-context overview, test match and bracket UUIDs, the integration
  suite's standings tie rows and provisional team, and the seeded Liga MX
  standing behind the reader team record and standing summary. None is a
  production crosswalk.
- **Crosswalk:** provider-to-canonical team ids come from the production seed
  (`backend/config/teams.seed.json`) and are verified in both languages.

Expected values were checked against the raw payloads, not only against mapper
output. Each language checks them with its own independent implementation.

The only normalizers are named:

- the production team crosswalk;
- kickoff instant comparison (ESPN minute precision vs reader RFC3339 seconds);
- the writer's `''` → `NULL` nationality;
- the `value` → `goals` leader projection;
- test UUIDs for provider event ids.

Nothing incompatible is stripped to force equality. Missing, `null`, empty,
zero and `false` are compared exactly.

## Remaining gaps

The full mismatch text for each gap is in `reader-contract.json` under `gaps`.
The gaps stay open until their tasks land; T16.1 does not close any of them.

| Task | Gaps |
|---|---|
| **T16.2** identity and DTO parity | `match-id`, `team-id`, `nested-team-id`, `scorer-identity` (own goal, athlete id), `standings-rank`, `standings-dedup`, `standings-malformed`, `group-label`, `placeholder-crest`, `bracket-round-name`, `round-slug-type`, `shootout-source`, `live-minute`, `bracket-live-minute` |
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
3. Remove the gap id from `gaps`, from each method's `gaps` list and from the
   characterization.

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
