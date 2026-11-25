# Reader DataStore adapter (T16.3)

T16.3 implements the connection for local/test evaluation. It does not authorize
production activation, shadow traffic, deployment, monitoring, or a data-rights
decision. Existing production configuration continues to use ESPN. News remains
an explicit ESPN delegate; T16.6 is unresolved and the reader news route is itself
an ESPN proxy.

## Configuration and rollback

The source settings are server-only. Do not use `NEXT_PUBLIC` variants.

| Setting | Behavior |
|---|---|
| `SCOREARC_DATA_SOURCE` absent, empty, or `espn` | Returns the existing ESPN store directly; constructs no reader client and sends zero reader requests, including health/shadow requests |
| `SCOREARC_DATA_SOURCE=reader` | Selects the joined group of all eleven non-news methods; an eligible failure retries the whole logical operation once on ESPN |
| `SCOREARC_DATA_SOURCE=compare` | Samples joined operations for comparison. The default sample is 10%. |
| `SCOREARC_READER_ORIGIN` | Required when reader or compare mode makes reader calls; origin only, no credentials, path prefix, query, or fragment; HTTPS required in production |

The opt-in sampled mode is described below. Unknown source values fail configuration. HTTP is allowed only for loopback
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

## Sampled reader trial

Set server-only `SCOREARC_DATA_SOURCE=compare` and `SCOREARC_READER_ORIGIN` to opt in. `SCOREARC_READER_COMPARE_PERCENT` accepts an integer from 0 through 100 and defaults to 10. At zero the frontend returns its ordinary ESPN store. With comparison disabled, no comparison logs or reader calls are generated.

The sampling unit is a logical operation, including its joined reads. With the default, about 90% use ESPN only. Each sampled read starts both sources in parallel using independent request budgets. The reader gets up to five seconds and the sampled operation up to 25 seconds total. The same method-specific semantic comparator used by the offline evaluator checks IDs, scores, cards, coverage and other fields. Unproven equality selects ESPN. Differences can reflect feed timing, a crest URL or more complete reader data. The mismatch rate measures disagreement with ESPN. It does not establish which source is factually wrong.

One disagreement or reader error returns the full logical operation from ESPN. Reassembly reuses the original ESPN promises for the same method, arguments and scope. An ESPN error makes the comparison inconclusive and preserves the ESPN error path. A sampled operation with an observed dependency failure cannot promote the reader. News remains ESPN-only.

### Health telemetry and dashboard data

Set the server-only `SCOREARC_HTTP_TELEMETRY=1` on the frontend to monitor handlers and upstream fetches independently of the experiment. With the default ESPN source, `espn`, or a zero comparison percentage, the frontend uses its ordinary ESPN store and emits only HTTP health events. A server-rendered page or API request records ESPN fetches when it needs the network. Cache hits add zero outbound events. Remove the flag and redeploy to turn off standalone monitoring.

Frontend compare mode automatically emits two JSON log families. `scorearc_reader_comparison` describes logical calls, agreements, differences, inconclusive results and which source served the operation. `scorearc_http` describes individual handler executions and outgoing requests. A single match popup may need several logical reads, and a cached read can make zero HTTP calls. Use the denominator for the question being asked.

| Measurement | Coverage and denominator |
|---|---|
| Website API health | Every implemented Next.js API handler, including news, match detail, standings form and the Edge share-card route. Handler events include successful responses, validation failures and exceptions. The share card observes the streamed PNG to completion and records its explicit asset probes. |
| Reader and ESPN dependency health | Frontend outbound attempts from sampled, ESPN-only control and news reads. Both successful and failed calls count, including optional dependencies whose callers recover. Use the source, endpoint, status, outcome and latency to distinguish an HTTP 429 from a malformed HTTP 200 response or a timeout without a response. |
| Go reader and ingester | On each participating Go process, `SCOREARC_HTTP_TELEMETRY=1` enables the HTTP event schema. The reader records incoming API requests and health probes. The ingester and reader record their ESPN dependencies, with a separate record per retry or redirect hop. The operator CLI service labels separate manual activity from the regular ingester. |
| Edge and CDN traffic | Optional Vercel proxy-log input counts unique observed API requests, including cache hits, framework method responses and unmatched API paths. Use the separate `platformApi` section for this boundary. Application handlers cannot measure browser-direct asset hits, requests answered upstream of them, or Satori’s internal image fetches. |

Standalone monitoring keeps native fetch redirect behavior for ordinary ESPN reads and share-card probes and records one event with the terminal outcome of each fetch. Intermediate redirects are not visible in this mode.

The sampled reader and reference transports reject redirects. In compare mode, measured ESPN control reads can follow redirects on their origin and the configured ESPN API hosts. Share-card CDN probes follow redirects to recognized asset hosts. Each followed or refused hop contributes an HTTP event.

The frontend emits timestamp, environment and revision when available. Request, operation, sampled-read and reader-generated request identifiers correlate individual events during diagnosis. The report groups by bounded route names and dimensions, never by those identifiers. Applications omit raw request paths, query parameters, client addresses, participant IDs, response bodies, and dependency error text from health events. Vercel proxy input can contain sensitive fields; the report retains only bounded route, method, response, cache and time dimensions.

**Run the report** on a bounded window of newline-delimited JSON. Combine the app’s Vercel logs, Go JSON logs from Fly and optionally Vercel proxy records for the same period. Raw JSON events and envelopes whose `message` is a JSON event are supported.

```sh
npx tsx scripts/reader-comparison-report.ts /path/to/window.jsonl > health-report.json
```

The output includes:

- `operationIntervals` for five-minute cohort, decision and source-served counts.
- `reads`, `endpoints` and `comparisonIntervals` for semantic results. Disagreement divides mismatches by matched plus mismatched reads. Inconclusive and reader-failure rates use all sampled reads. Only a completed ESPN comparison can establish disagreement. News is ESPN-only and contributes no parity samples.
- `http.byEndpoint` and `http.intervals` for HTTP health, with five-minute UTC buckets, HTTP status counts, failure outcomes, application codes, measured bytes, total latency and mergeable latency histograms. Dashboard failure rate divides failures by successes plus failures. Cancellations are counted separately. A rejected redirect is a failure; an accepted redirect hop retains its 3xx status. The p95 estimate is an inclusive bucket upper bound; a null estimate in a populated row means the percentile exceeds 60 seconds. Bytes coverage counts only requests with measured bytes.
- `platformApi` for Vercel proxy records with a terminal status and a request identifier. Duplicate observations count once within the input window. Conflicting records and records without a usable ID are counted separately. This requires provider-side collection with the needed sources and sampling enabled; a cache-only hit usually produces no application event. See the [Vercel log-drain schema](https://vercel.com/docs/drains/reference/logs).
- `malformedComparisonEvents` and `http.rejectedEvents` for recognized events that fail validation. Zero denominators yield `null`. Use a complete export for traffic rates, and keep origins, retries and frontend handler counts separate.

**Storage today.** In Neon, `ingest_run` records job kind, competition, start and finish times, success and error. `match_poll_status` records the latest poll result and event count per competition and season. `match_sync_status` records match observation time, attempts, retry time and the last recovery error. This PR writes new HTTP and comparison telemetry to process logs, collected by Vercel and Fly on deployments with the instrumentation enabled. The report writes the aggregates to the chosen local file. There is no application write to Neon for each API hit.

**Proposed admin-portal storage.** A collector should read the two providers’ log streams, deduplicate deliveries using provider log IDs, checkpoint only after committing, and upsert complete five-minute buckets into a private Neon operations schema. Keys should include time bucket, environment, release, source, route, cohort and comparison policy where applicable. Keep the originating deployment environment and revision when collecting logs. Store counts, byte sums and latency histograms so longer-window rates and percentiles can be recomputed. The authenticated portal server would query aggregates with a read-only role and use ingestion audit/freshness tables for poll history. Collector identity, retention, migrations, drains and portal access are a separate implementation and production decision. No new database, drain or portal is provisioned by this PR.

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

The standalone preview includes dated synthetic roster totals for Ali Avila.
On `/en/c/world-cup/2026/team/nat-arg` and
`/es/c/world-cup/2026/player/ali-avila`, his three goals carry the original
June 29, 2026 verification time. Use local reader mode to see both routes.
Production comparison retains its configured sampling rate and compares current
observations under the [evaluation policy](READER_EVALUATION.md).

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
