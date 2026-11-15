# Reader DataStore adapter (T16.3)

T16.3 implements the connection for local/test evaluation. It does not authorize
production activation, shadow traffic, deployment, monitoring, or a data-rights
decision. Existing production configuration continues to use ESPN. News remains
an explicit ESPN delegate; T16.6 is unresolved and the reader news route is itself
an ESPN proxy.

## Configuration and rollback

Both settings are server-only. Do not use `NEXT_PUBLIC` variants.

| Setting | Behavior |
|---|---|
| `SCOREARC_DATA_SOURCE` absent, empty, or `espn` | Returns the existing ESPN store directly; constructs no reader client and sends zero reader requests, including health/shadow requests |
| `SCOREARC_DATA_SOURCE=reader` | Selects the joined group of all eleven non-news methods; an eligible failure retries the whole logical operation once on ESPN |
| `SCOREARC_READER_ORIGIN` | Required only in reader mode; origin only, no credentials, path prefix, query, or fragment; HTTPS required in production |

Unknown source values fail configuration. HTTP is allowed only for loopback
origins outside production; production also rejects HTTPS loopback origins. Redirects are rejected. Request callers supply
identities and typed queries, never an upstream URL. Rollback is to unset the
source setting or set it to `espn`, then restart/release the frontend through the
normal authorized process. Previously returned match and side references remain
valid under ESPN. No mapping cache, health switch, or database change is needed.

Before any enabled-mode evaluation against a deployed reader, that reader must
include this PR's additive `/identities` route. It uses existing tables, indexes,
and SELECT grants, with no migration. The owner confirms migration 0028 and
T17.3 were deployed October 31; this task did not independently inspect or change
production. Do not repeat those migrations.

## Identity and source operations

Reader UUIDs do not replace existing frontend route and lookup addresses. The adapter validates
persisted crosswalks and normalizes match IDs, team IDs, and player profile IDs
to the provider references already used at the frontend `DataStore` seam.
Public team URLs still use `canonicalTeamId`/`providerTeamId`; player links use
the existing `buildSlugMap` collision algorithm. No identity is inferred from
names, scores, or kickoff times. The reader’s nullable canonical `playerId` fields on leaders and lineup players are retained as qualified data fields; they are not provider IDs, public link slugs or popup addresses. Links still use `playerSlug`.

`GET /v1/competitions/{comp}/{season}/identities` accepts exactly `kind`
(`match|player|team`), `from` (`canonical|espn`), and comma-separated `ids` (1–100
unique IDs). Each ordered row has `id`, `status`, `canonicalId`, `providerId`,
`competitionId`, `seasonId`, `homeId`, and `awayId`. Missing/ambiguous mappings
have explicit null fields. Match resolution verifies scope and canonical sides;
team/player identity is global. Multiple ESPN aliases are ambiguous rather than
arbitrarily chosen. The endpoint is read-only, `no-store`, and carries identity
metadata with an intentionally unknown observation clock.

This solves both the slug → provider athlete → reader UUID path and the reverse
match/game-log → frontend popup path across independent requests, cold instances,
reader failure, and rollback. Unresolved addressed identity is an unavailable
operation, not proof of entity absence. An established profile 404 remains null;
a known match with no retained summary may fall back. Null references remain
null and unknown career clubs remain unlinked, including missing or ambiguous optional career crosswalks. Player identity and match-log side mappings remain required. The backward-compatible player `liveMatch` extension carries held live score/status/minute into the popup using the existing bounded query. Reader rows without result or live context stay unlinked; default ESPN interpretation is unchanged.

`runDataOperation` binds joined reads to one attempt: form tables and windows,
standings and squad indexes, slug resolution and profile, summary and slug
enrichment, both leader boards and slugs, banner reads, homepage sports collections, merged team directories, and each standings/cup page’s required data group. Failure discards the
reader attempt and reruns the callback on ESPN. There is no partial collection
merge. Reader summary slug enrichment stays inside the shared reader deadline;
expiry aborts that attempt and retries the entire operation. The ESPN path
retains its existing 800 ms best-effort enrichment deadline.

## Resource policy and ownership

The [twelve-method matrix](../superpowers/specs/2026-11-01-t16-3-reader-datastore-design.md#method-and-resource-policy-matrix)
specifies endpoint/query, required and optional resources, identity translation,
and caching for each method. `readerDecode.ts` validates complete DTOs from
unknown values; `readerPolicy.ts` applies method policy after the unchanged
`parseReaderResources` parser. Schema-valid scope/side contradictions fail.

Required collections need complete/empty availability independently of
fresh/empty/dormant status. A valid empty never causes fallback merely because it
is empty. Identity and retained detail can have useful validated data with
unknown freshness; optional player career, statistics, game log and participation
do not invent completeness. Team child blocks can degrade while preserving core
identity and availability evidence. Malformed optional data still fails decoding.

MLS and Leagues Cup use `deriveReaderStandings`; every configured input is
validated. Partial groups retain derivation issues. Unavailable derivations and
partial results with no group to carry their evidence fail as unavailable, never
as unexplained successful empty arrays. Input reads are separate snapshots. `readerDerivation.inputs` retains each input’s competition, season and resource envelope separately; it does not collapse their observation times into a global snapshot.

`sourceSelection.ts` owns the deadline and fallback, `readerTransport.ts` owns
fixed-route transport and bounds, and `apiStore.ts` owns per-method semantics and
reader cache admission. Network/429/5xx/internal timeout, malformed data/evidence,
or required stale/unavailable data may fall back once. Caller cancellation,
adapter 400s, semantic scope/side mismatches and unresolved addressed identity do
not start a blind fallback. Both-source failure propagates the normal unavailable
path. Required reader-mode page/banner/directory failures propagate to the existing unavailable/error boundary after fallback is exhausted, instead of becoming empty collections. ESPN-only best-effort degradation and optional ESPN link enrichment keep their existing behavior. Fallback telemetry uses bounded reason codes, without IDs, URLs, bodies,
SQL, or raw dependency errors. Frontend route envelopes/cache policies stay owned
by their existing route code.

## Budgets and cache evidence

The joined non-news operation allows 25 seconds total, including one reader
attempt of at most 5 seconds and fallback in the remaining time. It shares a
128-call, four-concurrent-request, 4 MiB-per-response, 32 MiB-total budget. Queue
wait and response streaming count. There are no retries, probes, poll loops, or
new schedulers. News keeps the existing ESPN path and its cache policy.

Reader cache keys include origin, route/scope/query and normalization policy.
Only validated reader results enter that cache; ESPN fallback stays in the ESPN
cache. Match windows, brackets, summaries, and team profiles revalidate every
operation. Standings, leaders, squads, and player bodies have a 15-second TTL,
with observation ages checked again on reuse. Identity mappings are revalidated
per operation. A warm reader read is not necessarily zero upstream calls.

The isolated fixture self-check measured 33 reader calls and 307,060 response
bytes while exercising the adapter methods, derivations and navigation. Leagues
Cup tables cost 4 cold calls (three input reads plus match crosswalk), 2 warm
calls (phase matches plus crosswalk). The navigation regression measures 6 cold
calls for Leagues Cup form and 2 for its separate popup. No per-player profile
fan-out constructs the index, and enriched windows do not fan out to summaries.
A failed summary costs 3 calls cold (identity, reader failure, ESPN summary) and
2 warm (identity and reader failure; the ESPN cache supplies detail). That test
asserts shared call/byte accounting, one ESPN fetch, and no fallback value in the
reader cache. Fallback reruns one complete operation under the same total budget;
tests assert one fallback attempt and no mixed reader/ESPN result. Current-scope synthetic transport tests measure homepage sports reads at 36 cold / 18 warm calls and merged team directories at 13 cold / 2 warm; each stays below 1 MiB and peaks at four in flight under the same deadlines and limits.

## Reproduce locally

Run the self-check, then keep the fixture service running in its own terminal:

```sh
npx tsx scripts/reader-preview.ts --self-test
npx tsx scripts/reader-preview.ts --port=4399
```

The service binds to `127.0.0.1` and uses explicitly synthetic/recorded fixtures,
including synthetic player membership/game-log references. It is not a live
parity dataset. Start the reader-mode frontend in another terminal:

```sh
SCOREARC_DATA_SOURCE=reader SCOREARC_READER_ORIGIN=http://127.0.0.1:4399 npm run dev -- --port 3431
```

Inspect `/en/c/leagues-cup/2026/standings` and its `/es/` counterpart: phase
tables, W/D/L badges, canonical team links and badge popups. Inspect
`/en/c/world-cup/2026/player/ali-avila` and the Spanish counterpart for nullable
statistics, an unlinked unknown career club and game-log popups; inspect
`/en/c/world-cup/2026/team/nat-arg` for schedule/squad links and canonical follows.

For an injected local summary failure, POST
`http://127.0.0.1:4399/__test/fault?route=summary`, then open a Leagues Cup badge.
The popup should keep its numeric reference and use ESPN fallback. POST
`/__test/reset` on that same loopback service to clear faults/counters.
GET `/__test/state` reports counters. These controls exist only in the local
fixture script. Fallback and news may make ordinary read-only ESPN requests.

For unchanged-default proof, restart the frontend with both source variables
absent, reset local fixture counters, and browse EN/ES pages/popups. All reader
counters must stay zero. Browser verification covered this default mode and
explicit reader mode, including a summary 500 followed by a successful ESPN
popup. Shared contract vectors, fake transport/clock tests and least-privilege
Postgres tests cover the other failure/identity cases. Run the frontend and
backend gates from AGENTS.md before delivery; use bounded Vitest workers if
concurrent local builds cause subprocess-test timeouts.

T16.4 adds a disabled-by-default [explicit evaluation runner](READER_EVALUATION.md);
its offline evidence does not enable production traffic. T16.5 owner-approved
soak/cutover, T16.6 news ownership,
sustained coverage, notification activation and rights gates remain separate.
