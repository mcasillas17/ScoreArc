# Team insights: bounded contract foundation

September 13, 2026. This is a test/documentation slice of T16.1, **not full
DataStore parity, an apiStore implementation, or permission to cut over**. ESPN
remains the production source. No reader routes, DTOs, SQL, migrations,
infrastructure or deployment configuration change in this slice.

Sources inspected: `src/server/data/{store,types,teamIdentity}.ts`,
`providers/espn-team.ts`, `backend/reader/{server,handlers,store,types}.go`,
`backend/reader/openapi.yaml`, and `docs/CURRENT_STATE.md` §5. (The Go DTO
comments that once claimed an exact frontend mirror now point at the gap
registry instead.)

## Method inventory (now executable)

Inventory reconciled October 2, 2026 against `store.ts`: September's slice had
14 methods. PR #191 removed the redundant `getTopScorers`/`getTopAssists`
wrappers; public scorer/assist capabilities still use `getLeaders`. This reduces
the method count, not the reader's leader/assists or other parity gaps.

The per-method table that lived here is superseded by
[`reader-contract.json`](../../src/server/data/contracts/reader-contract.json):
every method's reader route (or none), its named gaps and each gap's roadmap
task. Two-way `Exclude<keyof DataStore, …>` checks in `reader-contract.test.ts`
make adding or removing a method a compile-time inventory update, and the Go
suite compares its routes with OpenAPI and the router. See
[READER_CONTRACT](READER_CONTRACT.md) for the full harness. The team-specific
contract below remains this slice's responsibility.

## Shared vectors and exact boundaries

`src/server/data/contracts/team-insights.json` contains a reduced recorded
América event (401877014), a synthetic scheduled match with unknown scores,
explicit reader UUID test identities, expected complete wire objects, scope,
canonical/provider identity and public error vectors.
The first event's retained fields are unchanged from the existing recorded
schedule. The TS test also runs the full recorded input to prevent the reduction
from inventing a supported shape. UUIDs are test identities, not a production
match crosswalk. Timestamp lexical forms are preserved: ESPN minute precision
and reader RFC3339 seconds are compared as instants, explicitly.

The TypeScript checks exercise the actual profile/schedule mappers and curated
team crosswalk, exact match fields/arrays/nulls, chronological ordering, record
and structured standing, and unsupported reader fields. Independent expected
TypeScript shapes here pin team identity strings and nullable crest, and profile
metadata, nullable record/standing and optional availability; the profile's key
set is exhaustive. The Match field shape (including the schedule element) is
pinned exhaustively in `reader-contract.test.ts`.
`tsc --noEmit` evaluates these `expectTypeOf` assertions; ordinary Vitest
execution only exercises runtime behavior. Extra fields outside this bounded
shape are not a claim of coverage, and no return-annotation-only check establishes
field compatibility. The
legacy raw mapper treats malformed input as `[]`; that ambiguity is asserted,
not relabeled as availability. A recorded scoped-mapper assertion also checks the selected season, attached
scope, empty-success versus unavailable, and rejection of the other Liga MX
split. Broader performance eligibility tests live separately.

Go consumes the same JSON. Exact DTO serialization detects dropped/changed
fields, then the committed OpenAPI schemas validate the serialized objects.
Negative schema checks reject a missing required nullable score and a string
score. Explicit gap assertions pin absent per-match `scope` in both reader
objects and OpenAPI; absent `standing` and `scheduleAvailability` are pinned by
the reader contract harness (gap T10.3-team in `reader_contract_test.go`).
These assertions fail when the gaps are implemented so the documented contract
must be updated.

`TestTeamContractHTTPQueriesAndErrors` uses actual routing and handlers with a
fake storage dependency. (Route inventory and match-query parity (T10.1) are owned by
`reader_contract_test.go`, `match_query_integration_test.go` and `reader-contract.json`.)
It checks 400 unknown scope,
404 unknown team, canonical rather than provider route addressing, 500 dependency
failure, safe error body and `no-store`, and no database call for invalid scope.
It does not claim fake data proves SQL behavior.

`TestTeamContractStoreIntegration` uses real Testcontainers Postgres and the
SELECT-only reader. It inserts the shared match vectors, exercises `Store.Team`,
checks exact wire fields and nullable scores, and asserts a complete ordered ID
list. Existing seed rows supply a different competition, different season and
unrelated teams; all must be excluded. A same-kickoff pair inserted in reverse
order verifies the SQL ID tie-breaker. The recorded América crest differs from
the seed's null crest; this single known metadata difference is explicit in the
assertion, not a general normalization pass.

## Running and extending the slice

```sh
npx vitest run src/server/data/contracts
npx tsc --noEmit
cd backend
go test ./reader -run 'TestTeamContract(Serialization|HTTPQueriesAndErrors)$' -count=1
# Docker + the active Colima socket environment from AGENTS.md are required:
go test ./reader -run '^TestTeamContractStoreIntegration$' -count=1
```

A deliberate expected home-score mutation from 3 to 99 was detected by both the
exact mapper assertion and the cross-language comparison; it was restored before
final checks. Type-level drift (for example an added `TeamProfile` field or a
retyped `Match` field) now fails `tsc` through the exhaustive pins in this test
and `reader-contract.test.ts`. Tests alone do not establish ingestion coverage
or availability.
The team vectors cover only the fields used by this milestone. Scorer, lineup,
stats, leader, bracket and news contracts are characterized (not made equal) by
the reader contract harness; neither establishes production event/player
crosswalks, asset allowlisting, historical completeness or reader parity. Those gaps and the data-rights gate remain open in
`CURRENT_STATE.md` and the product roadmap.
