# Match recovery implementation plan

> Use the installed executing-plans skill. The Knights panel and separate final
> review own publication; do not commit intermediate, unreviewed work.

**Goal:** Recover overdue matches from validated provider observations and expose
staleness independently of worker liveness.

**Architecture:** Existing source and singleton runner, durable PostgreSQL
bookkeeping, additive reader headers and an external bounded watchdog.

**Stack:** Go/pgx/PostgreSQL, Vitest/TypeScript, Node.js/GitHub Actions.

## 1. Reproduce and repair provider path

Files: `backend/shared/source/{source,espn,espn_test}.go`,
`backend/shared/espn/{client,matches,summary}.go`, new targeted-observation tests.

- [ ] First assert that range HTTP 400 with a valid single-date response retains
  an error while returning only validated fallback events.
- [ ] Assert a live input and final summary produce a final match with new
  scores, and reject mismatched event/team/league/season and contradictory status.
- [ ] Run `cd backend && go test ./shared/source ./shared/espn`; observe the
  intended failures, implement typed partial coverage and verified lookup, rerun.
- [ ] Cover timeout/HTTP/malformed/missing scores, rescheduling, suspension,
  cancellation and penalties without elapsed-time finalization.

The source interface adds:

```go
RecoverMatch(context.Context, config.Competition, config.Season, model.Match) (model.Match, SummaryResult, error)
```

## 2. Durable bookkeeping and recovery

Files: migration 0023, `backend/shared/store/match_sync.go` and integration test,
`backend/ingester/{contracts,runner,matches}.go`, new `recovery.go` and tests.

- [ ] Reproduce a stored live row omitted by scoreboard never reaching final.
- [ ] Add tables `match_sync_status` and `match_poll_status`; test apply/rollback,
  least-privilege writes/reads and finalized facts remaining sealed.
- [ ] Add canonical due selection, pre-fetch retry claim, accepted observation
  recording, and poll result recording. Exercise fair bounded selection and
  restart persistence with real PostgreSQL.
- [ ] Run the recovery pass on slow ticks even when scoreboard fails. Feed
  verified matches through normal identity/preservation/finalization safeguards,
  reusing the recovered summary rather than making another request.
- [ ] Record observations for accepted unchanged source matches separately from
  fact writes; never for stored-only backlog candidates or rejected regressions.
- [ ] Run `go test ./shared/store ./ingester` using the isolated Docker socket.

## 3. Reader freshness and independent check

Files: `backend/reader` store/handlers/contracts/OpenAPI/tests,
`src/lib/matchFreshness.ts` and test, `scripts/match-freshness-watchdog.mjs`
and test, manual `.github/workflows/match-freshness.yml`.

- [ ] Add boundary tests for exact threshold equality, stopped ingestion,
  successful unchanged observations, explicit empty, dormant seasons, missing
  bookkeeping and partial polling.
- [ ] Compute freshness with reader time from durable observations. Attach the
  five documented headers to list, bracket, summary and team-match routes
  without changing bodies or existing match states.
- [ ] Validate headers in Go/OpenAPI and parse them strictly in TypeScript.
- [ ] Add watchdog tests for stale detection, deadline/HTTP/contract failures,
  first incident, duplicate suppression, resolution and recurrence.
- [ ] Keep workflow manual-only; document notification/schedule approval.

## 4. Full validation and review

- [ ] Run affected tests first, then `go build ./...`, `go test -race ./...`,
  `go vet ./...`, `npm test`, and `npx tsc --noEmit`.
- [ ] Capture Knights snapshot and complete all four configured reviewers;
  triage every finding, repair and repeat full panels until convergence.
- [ ] Update affected runbooks, CURRENT_STATE and roadmap with dated evidence;
  distinguish code delivery from unapproved production recovery and T21.2.
- [ ] Rerun affected checks and perform a separate fresh final full panel.
- [ ] Re-evaluate `publicationReady`, stage only owned files, commit with Copilot
  trailers, push without force, open a ready-for-review PR and verify its remote
  SHA/diff. Do not merge or activate production.
