# T16.3 Reader DataStore Implementation Plan

> Execute with the installed Knights workflow, TDD and independent full-panel review. Task scope explicitly authorizes implementation and active PR delivery.

**Goal:** Implement all twelve methods with controlled reader selection and unchanged ESPN default.
**Architecture:** Typed reader adapter, bounded source-bound operations, stable provider references at frontend seam, minimal read-only persisted identity resolver.
Task commits are held until the installed Knights final publication gate; the delivered commit contains the validated tasks together.

**Tech Stack:** Next.js/TypeScript, Vitest, Go/pgx, existing Postgres testcontainers.
**Spec:** `docs/superpowers/specs/2026-11-01-t16-3-reader-datastore-design.md`

## Global constraints

No production actions, migrations, shadow reads or dependency changes. Missing flag means ESPN and zero reader calls. Retain URL/envelope/cache contracts. Validate nulls and metadata; never synthesize identity. One complete fallback per operation, 25s/32MiB/128 calls/four concurrent.

## Review focus

- Cross-request rollback, cold instances and side/scope contradictions: adapter identity/navigation tests.
- Partial parallel reader reads leaking into ESPN collections: composition and form/index tests.
- Cached evidence aging and dormant incomplete collections: clock-driven resource tests.
- Body streaming stalls, cancellation and byte floods: transport tests.
- Legacy nullable identity/detail/participation: decoder/UI and shared-vector tests.

### Task 1: Read-only identity contract

**Files:** backend/reader identity handler/store/tests, server route, OpenAPI, shared reader-contract inventory.
**Interface:** scoped GET identities with kind/from/ids; ordered rows `{id,status,canonicalId,providerId,competitionId,seasonId,homeId,awayId}` as spec.
- [x] Add failing router and real-Postgres tests for recorded team refs and resolver-created player/match refs, reverse ambiguity, wrong scope and limits. Run `go test ./reader -run Identity` (expect missing endpoint assertion failure).
- [x] Implement bounded parameterized read-only endpoint, metadata and inventory extension. No migration.
- [x] Run identity tests and reader contract tests (expect PASS). Included in the final gated task commit.

### Task 2: Runtime DTO and evidence validation

**Files:** src/server/data/readerDecode.ts and tests, types.ts, narrow nullable UI/type pins.
**Interface:** decodeReaderMatches/Bracket/Standings/Summary/Leaders/Team/Squad/Player(raw: unknown) typed results retaining reader fields and nulls.
- [x] Add shared-vector positive and malformed nested field tests (expect missing decoder failures).
- [x] Implement strict validators, preserve fields, widen nullable starter/career id and render unknown unlinked. Do not rewrite vectors.
- [x] Run decoder + contract tests and typecheck (expect PASS). Included in the final gated task commit.

### Task 3: Bounded transport, reader methods and selection

**Files:** readerTransport.ts, apiStore.ts, sourceSelection.ts, store.ts, telemetry and corresponding tests.
**Interface:** createReaderDataStore(dependencies): DataStore; runDataOperation(store, callback, signal?): Promise<T>; createDataStore stays ESPN callable.
- [x] Add failures for zero-traffic default, every mapped method, resource policy, cross-request identity, budgets, empty/failure separation and source cache isolation.
- [x] Implement fixed-origin bounded transport, typed adapter, explicit identity normalization and per-method evidence policy, derived tables and one whole-operation fallback.
- [x] Verify targeted Vitest tests (expect PASS), record cold/warm/derived/fallback call counts. Included in the final gated task commit.

### Task 4: Joined consumers and local integration

**Files:** playerIndex, standingsForm, banner loader, player/summary/leader routes and SSR loaders; integration tests and local preview harness.
- [x] Add failures for source-bound parallel index, badge-to-popup, player-log popup, source rollback and existing route envelopes.
- [x] Wrap logical joins and scope form sharing by store; preserve ESPN default path and best-effort enrichment.
- [x] Run targeted tests, npm test, tsc, lint, build, backend build/race/vet (expect PASS). Inspect default and fixture-reader EN/ES browser pages and injected failure; record exact preview paths.

### Task 5: Knights review and PR

- [x] Snapshot and implementation review by all configured models; fix findings and rerun full panels until clean. Round 4 converged with Astra, Sol and Luna each reporting no actionable findings.
- [x] Update affected documentation and measured evidence. Latest main remains `588c1ba`; no concurrent T12.4 change requires reconciliation.

Publication gates are recorded in the PR and external review records, so marking
them does not change the bytes approved by the final panel:

1. Fresh final panel and required checks; evaluator `publicationReady: true`.
2. Commit task-owned changes, push normally, create active PR with matrix/identity/cost/config/rollback/limitations. Leave preview running; no merge or rollout.
