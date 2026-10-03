# T16.1 reader contract harness — spec and plan

> Executed inline on `test/t16-1-reader-contract-harness` from `origin/main`
> 3373b0f. Test-only: no application, reader, OpenAPI, SQL or migration behavior
> change (three Go files receive comment-only corrections; see Files).
> The steps name the committed files instead of quoting their code; the files
> are the source of truth.

**Goal:** make the contract between the frontend `DataStore`, the Go reader and
`openapi.yaml` executable and drift-detecting across all 12 current methods,
with every known incompatibility characterized and assigned to a roadmap task.

**Not in scope:** T16.2 identity fixes, T10.1 query support, new endpoints,
`apiStore`, shadow traffic, cutover, UI. Harness completion is not reader parity.

## Spec

- **One shared vector file** — `src/server/data/contracts/reader-contract.json`,
  read by both languages: method inventory, gap registry (id, task, exact
  mismatch, suites that must characterize it), recorded-payload expectations,
  synthetic window/freshness/transport vectors.
- **Evidence.** Unmodified recorded ESPN payloads in `__fixtures__/` are read by
  both suites from the same path. Synthetic data is labeled (window events,
  freshness snapshots, test UUIDs, standings tie rows, one provisional team).
  Provider→canonical team ids come from the production seed and are verified in
  both languages. Expected values were taken from mapper output only after an
  independent check against the raw payloads (scorers, own goal, stat operands,
  rank stat, leader values, news ids), and each is then cross-checked by the
  other language's independent implementation.
- **Independence.** TypeScript pins full independent type shapes with
  `expectTypeOf` (checked by `tsc`, not Vitest). Go compares exact serialized
  JSON (`reflect.DeepEqual` over decoded wire values) and validates committed
  OpenAPI schemas.
- **Gaps are characterized, not normalized away.** Each gap check fails when
  the gap closes ("gap changed: … update reader-contract.json"). Each suite ends
  by requiring that the set of gaps it characterized equals the set the JSON
  assigns to it, so a deleted or skipped characterization fails too.
- **Named normalizers only:** production team crosswalk, kickoff instant
  comparison, writer `''→NULL` nationality, `value→goals` leader projection, test UUID for
  a provider event id. Nothing incompatible is stripped to force equality.

## Files

- Create `src/server/data/contracts/reader-contract.json` — shared vectors.
- Create `src/server/data/contracts/reader-contract.test.ts` — real
  `createDataStore`, mappers, matches route and `parseMatchFreshness`.
- Create `backend/reader/reader_contract_test.go` — Go mappers on the same
  bytes, reader DTO serialization, OpenAPI, real handlers with fake storage.
- Create `backend/reader/reader_contract_integration_test.go` — Testcontainers:
  ingester writer → least-privilege reader SQL → HTTP.
- Modify `src/server/data/contracts/team-insights.test.ts`, `team-insights.json`
  and `backend/reader/team_contract_test.go` — drop the string-only method map,
  the hard-coded route list and the duplicate ignored-query loop; the executable
  inventory and the T10.1 gap replace them.
- Comment-only (no behavior change): `backend/reader/types.go`,
  `backend/shared/model/types.go` and `backend/shared/espn/standings.go`, whose
  comments claimed a frontend parity the harness disproves; they now name the
  characterized gaps.
- Docs already in this slice: `docs/backend/TEAM_INSIGHTS_CONTRACT.md`
  (repointed to the executable inventory) and `docs/PRODUCT_ROADMAP.md` (T10.3,
  T16.2 and T21.4 rows widened to the gaps the harness assigns them).
- Docs (task 9): `docs/backend/READER_CONTRACT.md` (new), `docs/CURRENT_STATE.md`,
  the roadmap's E16/T16.1 status, `docs/backend/ARCHITECTURE.md` (§3, §5, §8 and §10:
  frontend shapes are the target; points at the gap registry), and links from
  `TEAM_INSIGHTS_CONTRACT.md`, `docs/TEAM_INSIGHTS_HANDOFF.md` and
  `backend/reader/README.md`.

## Tasks

- [x] **1. Inventory.** Compile-time two-way `Exclude<…>` against
  `keyof DataStore`, runtime key check against the store object, gap ids valid
  and task-prefixed; Go: inventory routes + `/healthz` equal OpenAPI paths, no
  player/squad/assist path.
  Run: `npx tsc --noEmit` → expect: clean.
- [x] **2. Recorded summary/own goal.** TS through `store.getMatchSummary`; Go
  through `espn.MapSummary` → `MatchSummary` → OpenAPI. Shared fields exact;
  scorer identity, nested team id, stat numerators/percentages, lineup bench
  gaps characterized.
- [x] **3. Standings, bracket, leaders, news, squad, player** through the real
  store (TS) and Go mappers/news proxy; standings rank-order, placeholder
  crest, derived MLS table, goals-only leaders and no player route
  characterized.
- [x] **4. Windows and queries.** Frozen clock (2026-07-01T12:00Z); each window
  method's months, ids, ordering, summary fan-out; split/historical season
  clamps without provider calls; season mismatch and cancellation reject; the
  matches route's query→method dispatch and 400s; Go characterizes that the
  reader ignores every one (T10.1).
- [x] **5. Freshness and transport.** Go emits headers for eight frozen-clock
  snapshots through the real route; TS parses the same headers (invalid or
  contradictory metadata rejection stays owned by `src/lib/matchFreshness.test.ts`
  and `backend/reader/freshness_test.go`); empty vs unavailable distinguished with identical bodies;
  dependency/cancellation errors 500 without freshness; non-match routes carry
  none (T17.3); frontend and reader error envelopes pinned separately.
- [x] **6. Real SQL.** Summary (recorded and synthetic shootout/H2H) via
  `UpsertMatchDetail`, standings via `ReplaceStandings` (plus a synthetic tie),
  leaders via `ReplaceLeaders`, bracket rows, and the recorded roster via
  `ReplaceSquad`; read back as `scorearc_reader_test`. Gaps only SQL can show
  (every gap whose `suites` include `go-db` in reader-contract.json) have their
  own ledger.
  Run: `cd backend && go test ./reader -run '^TestReaderContractStoreIntegration$' -count=1`
  → expect: `ok` (Docker + AGENTS.md Colima environment).
- [x] **7. Drift proof.** Temporary mutations across both languages fail for the
  intended reason and are restored (evidence kept outside the repository).
- [x] **8. Gates (local).** `npm test`, `npx tsc --noEmit`, `npm run lint`,
  `go build ./...`, `go vet ./...`, `go test -count=1 ./...` (Docker/Colima).
- [ ] **8b. `go test -race -count=1 ./...`** — CI only. It could not run on the
  authoring host: `-race` needs cgo, and cgo was blocked by an unaccepted Xcode
  license. Not a passing local gate.
- [x] **9. Documentation** (after implementation review converged):
  `docs/backend/READER_CONTRACT.md` lists all 12 methods, covered fields,
  normalizers, evidence and remaining gaps by task; T16.1 marked done in the
  roadmap and `CURRENT_STATE.md` §5, dependent tasks left open;
  `ARCHITECTURE.md` §3/§5/§8/§10 and `TEAM_INSIGHTS_HANDOFF.md` repointed at the harness.
