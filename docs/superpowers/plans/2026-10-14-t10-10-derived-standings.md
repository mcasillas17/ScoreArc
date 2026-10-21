# T10.10 Derived Standings Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reader-backed data reproduces the MLS Supporters' Shield table and the Leagues Cup phase tables the site already derives.

**Architecture:** Roadmap option B. The football rules stay in TypeScript (`mlsTables.ts`, `leaguesCupTables.ts`), shared by the ESPN store and a new pure reader adapter, `deriveReaderStandings` (`src/server/data/derivedStandings.ts`). The reader serves only the inputs, through existing routes: `/standings` for provider tables and membership, `/matches?range=<phase window>` for phase results. A go-db test stores the recorded ESPN payloads with the Go mapper and writer, reads them back as the least-privilege login through the HTTP routes, and pins the decoded response bodies in `src/server/data/contracts/derived-standings.json`. The TS suite feeds those bodies to the adapter and compares the result with today's store over the same recorded payloads.

**Tech Stack:** TypeScript/Vitest, Go/testcontainers Postgres.

**Spec:** `docs/PRODUCT_ROADMAP.md` T10.10; `docs/backend/READER_CONTRACT.md`.

## Global Constraints

- No reader SQL, DTO, route or migration change; no ESPN fetch from the reader.
- No apiStore, no source flag, no change to the ESPN-backed site's output.
- Membership comes from configured (competition, season) standings scopes, never country, name or "not Liga MX means MLS".
- The missing-shootout rule (one point each) is preserved and reported, not changed.
- Only named normalizer: the production team crosswalk (ESPN id → canonical id).

## Review Focus

- A finished level match without a decisive shootout: one point each, status `partial`.
- A phase club in neither membership table, or in both: kept out of both tables, status `partial`.
- A membership scope with no stored table: status `unavailable`, no empty tables.
- Input that already contains the Supporters' Shield table: never merged again.
- Kickoffs on the UTC edges of the phase window: the reader range, not the adapter, decides.

---

### Task 1: Adapter and shared rules

**Files:** create `src/server/data/derivedStandings.ts` + test; modify `leaguesCupTables.ts`, `store.ts`, `competitions.ts` (`computedTables.membership`).

- [x] Failing tests: MLS conferences + overall, ties to the name fallback, identical and conflicting repeats, pre-derived overall input ignored, ranks not mutated, empty input; Leagues Cup regulation/shootout/missing shootout/incomplete score/nonfinished, unclassified and doubly classified clubs, missing membership, qualification cuts.
- [x] Implement `deriveReaderStandings(rc, inputs): { status, groups, issues }`; `computePhaseTables` gains an optional primary membership set; the store and adapter share `configuredPhaseTables`.
- [x] `npx vitest run src/server/data` passes.

### Task 2: Real-SQL inputs and parity

**Files:** create `backend/reader/derived_standings_integration_test.go`, `src/server/data/contracts/derived-standings.json`; modify both contract suites, `reader-contract.json`.

- [x] go-db: seed the recorded MLS standings, synthetic Liga MX Apertura membership and the recorded 54-match phase (plus window-edge, knockout-date and other-competition rows); assert the wire equals the vector; count statements.
- [x] TS: the vector through the adapter equals today's store over the recorded payloads, after the crosswalk.
- [x] Remove `T10.10-derived-standings` from the gap registry and replace both characterizations with positive assertions.

### Task 3: Docs

- [x] READER_CONTRACT T10.10 section, roadmap and CURRENT_STATE status lines, OpenAPI standings description.
