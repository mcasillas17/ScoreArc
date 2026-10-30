# T21.4 dependency-error logging slice

**Goal:** Close only `T21.4-dependency-error-logging`; retain a useful diagnostic
for each of the six failing reader operations without retaining dependency text.

**Design:** Follow `logTeamError`'s safe metadata pattern in a small shared
`logDependencyError(request, operation, err, scope...)` helper. Keep the existing
event names and validated scope, add the server-generated request id and
operation, report the Go error type and extract PostgreSQL SQLSTATE with
`errors.As`. Do not format error values. Team/squad logging and fail-closed flags
remain as they are.

**Spec:** The approved task in this chat and
[reader contract](../../backend/READER_CONTRACT.md). Go, slog, pgx, Vitest.

## Constraints and review focus

- Only the six raw dependency log calls in `backend/reader/handlers.go` change.
- Preserve status/body/cache, access logs, validation, SQL, fetches, timeouts,
  fallback and freshness semantics. No migration or production action.
- Cover generic and wrapped errors, PostgreSQL Message/Detail, synthetic DSNs,
  upstream bodies, hostile newlines, cancellation and deadlines through handlers.
- Assert one error event and one correlated access event per failure; retain
  appropriate competition/season or canonical match-id scope.
- Remove only this gap and its method references; keep T16.6 and T17.3 intact.

## Task 1: Implement and deliver the logging contract

- [x] Add `backend/reader/dependency_logging_test.go`, using existing fake stores
  and JSON log capture. Exercise all six handlers for each error case; assert
  exact error responses/cache, absence of sensitive text, safe metadata and
  preserved access logging. `TestDependencyErrorLogging` must fail against the
  old raw log calls.
- [x] Run `cd backend && go test ./reader -run '^TestDependencyErrorLogging$'
  -count=1`. Expect failure for raw dependency text or missing safe metadata.
- [x] Add the helper and replace only the six raw logging calls. Keep existing
  messages (`matches`, `standings`, `bracket`, `top scorers`, `news`,
  `match summary`) as operation labels too.
- [x] Replace the old logging characterization in `reader_contract_test.go`
  with positive assertions; remove its registry entry and method references from
  `reader-contract.json`. Keep existing safe-reference checks.
- [x] Run targeted regression/contract/observability and TypeScript contract
  tests. Expect all pass. Use the running Colima profile's socket for Postgres.
- [ ] Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, then
  `cd backend && go build ./... && go test -race ./... && go vet ./...`.
  Expect all pass. Start the local app and smoke-check it in the browser.
- [x] Complete the configured Knights implementation review (Astra, Sol, Luna).
- [ ] Update only related contract/status/roadmap documentation to describe this
  logging slice, with the remainder of T21.4 still open; obtain a fresh final
  Knights review. Keep review records outside the repository.
- [ ] Commit the reviewed task-owned changes with a conventional message and
  Codex trailer, push normally, open an active non-draft PR. Do not merge.

Execution follows the installed Knights review/publication gates; its full-panel
loop and final documented-state review govern delivery. The user has already
authorized implementation and PR delivery.
