# T10.2 reader contracts implementation plan

**Goal:** close team-statistics, lineup, leaders and board-depth contract gaps without frontend cutover.
**Spec:** the approved T10.2 task, `docs/backend/READER_CONTRACT.md`, and the intent of the August 15 leaders/box-score plan, reconciled against main `6664aea`.
**Architecture:** reuse category-aware top_scorer, nullable appearance columns, and sealed match_detail. Extend future leader identity capture and expose only participation enrollment/completion through an owner-backed view; no retry-ledger grants. No standings calculation changes.

## Constraints and decisions

- `/leaders`: goals default, assists supported, default 10/max 30, strict single-value query validation; rank order is authoritative, rank is unique per board. Legacy `/top-scorers` retains its exact goals shape and full stored depth (bounded 30).
- Leader athleteId is ESPN-qualified provider identity, playerId is nullable canonical UUID, teamId is canonical via crosswalk, playerSlug remains null. Missing old identity stays null.
- Summary keeps its existing route; full rosters and box-score fields come from appearance when available. No name/URL joins. Old sealed lineup JSON can retain unknown identity. New captures retain explicit athlete identity and full roster.
- `/matches/{id}/box-score` uses canonical UUIDs. Availability: complete only with completion evidence; pending for enrolled incomplete; partial for held rows without completion; unavailable with no rows/evidence. Appearance membership alone never proves minutes played. Starter/sub-on evidence supports appearances; an unused bench zero is derived only with complete event evidence.
- Team percentages: 0–100, one decimal, valid operands preferred, provider fallback only for genuinely missing operands; zero/invalid denominators never invent ratios. Inspection showed historical Go values already use 0–100; preserve that scale and recompute only from held counts, with no finalized-fact rewrites.
- One additive migration 0026 (number rechecked against current main) holds nullable leader source identity and reader-safe participation projection. Exact schema startup advances automatically through embedded migration head; no production SQL or claim 25/26 deployed.

## Tasks (each failing-first)

- [x] Leaders: failing query/DTO/writer-read tests; implement shared bounded SQL, future identity persistence/fingerprint, compatibility handler and independent OpenAPI. `go test ./reader ./shared/espn ./shared/store ./ingester` expects pass after implementation.
- [x] Team stats: shared recorded and synthetic operand cases fail before mapper/read normalization; implement nullable numerators and scale normalization; independent TS/Go/OpenAPI assertions become positive. `go test ./shared/espn ./reader` and contract Vitest expect pass.
- [x] Participation: failing least-privilege writer/read tests for complete/pending/partial/legacy/unused bench; implement projection, full roster mapping, bounded SQL and summary reuse, canonical box-score route. Preserve writer completion/retry rules. Same focused Go tests expect pass.
- [x] Harness/docs: replace exactly four gap characterizations with positive assertions; preserve other tasks and merged T10.10; update inventory, suite ledgers, contract/OpenAPI/rollout docs.
- [x] Full validation: isolated Postgres, go build ./..., go test -race -count=1 ./..., go vet ./..., npm test, tsc, lint and applicable build checks. No UI behavior changes intended.
- [ ] Knights: full Astra/Sol/Terra implementation convergence, then separate final documented-state panel, no cap. Only afterward stage, commit with Codex trailer, normal push/new active PR, retain ownership through CI. No merge/deploy/source switch.

## Review focus

Historical nullable identity; pending capture versus all-zero stats; private ledger isolation; row bounds before joins; competition/season scope and canonical address rejection. All are covered by persisted writer-to-reader tests, not DTO-only fixtures.
