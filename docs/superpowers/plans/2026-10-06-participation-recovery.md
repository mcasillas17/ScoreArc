# T7.21 Implementation Plan

**Goal:** Recover eligible failed participation after finalization and restart.
**Architecture:** Private atomic enrollment, validated atomic completion, bounded sweep.
**Tech Stack:** Existing Go, pgx, PostgreSQL/testcontainers and ESPN source.
**Spec:** ../specs/2026-10-06-participation-recovery-design.md

## Constraints

No production operations, reader/API redesign, dependencies or historical scans.
Keep existing score/detail finality, lease, cancellation and other captures.
Apply Knights whole-panel implementation and separate final review before commit.

## Review focus

Enrollment failure rolls finalization back; completion failure rolls facts back.
Provider correction cannot overwrite completed or legacy facts.
Missing and partial coverage never prunes existing participation.
Poison entries and season rollover cannot hide other enrolled work.
Least-privilege triggers reject spoofed enrollment and reopening completion.

## Task 1 — persistence boundary

Files: new migration 0025 up/down; shared/store participation and recovery files/tests.

- [x] Add real-Postgres regressions for atomic enrollment, legacy seal, pending
  completion, completion rollback and completed immutability; run to observe red.
- [x] Implement private enrollment and seal, deterministic pending selection,
  persistent begin-attempt backoff, atomic participation completion.
- [x] Reuse participation convergence SQL and identity resolution, preserving
  failed/partial payloads instead of replacement. No transaction during network.
- [x] Test upgrade, grants, unrelated guards, rollback and canonical scope.
  Run `go test ./shared/store -run 'Participation|Final' -count=1`; expect PASS.

## Task 2 — evidence and runner

Files: shared/model/participation.go, shared/espn/participation.go and tests;
ingester/participation_recovery.go, contracts.go, matches.go, runner.go and tests.

- [x] Add failing tests for missing/null events, partial/foreign rosters,
  missing/duplicate IDs, legitimate zero events and recorded complete coverage.
- [x] Preserve coverage evidence in internal model; validate before completion.
- [x] Add restart/failure recovery integration test and scheduler budget tests;
  confirm red before implementing the sweep.
- [x] Reuse RecoverMatch with strict ordinary-final/identity/score checks;
  claim backoff before lookup; only eligible pending rows can complete.
- [x] Bound sweep to 10 attempts, 2 per competition, 30 seconds, 6 seconds/call;
  deterministic ordering, fake clock and cancellation checks; cover old seasons.
- [x] Run `go test ./ingester ./shared/espn ./shared/source -count=1`; expect PASS.

## Task 3 — validation, documentation and delivery

- [x] Run Go build, full race suite with count=1, vet; frontend tests/typecheck
  and required contract checks using active Colima socket. Expect all passing.
- [x] Full configured Knights implementation review, repair and repeat to clean.
- [x] Narrowly update contract, architecture, runbook, task/current-state status
  with migration window and outstanding owner decision; no production claims.
- [ ] Separate full Knights final review; revalidate any changes.
- [ ] Focused conventional commit with Codex attribution, normal push, NEW
  non-draft PR. Follow automatic CI, repair/review failures, verify remote SHA.

Final review and publication evidence belong in the PR handoff; this plan does
not claim production rollout or close the legacy owner decision.
