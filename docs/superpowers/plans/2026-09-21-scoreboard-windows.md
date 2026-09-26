# Scoreboard windows implementation plan

> **For agentic workers:** Use `executing-plans` for inline implementation.
> Knights owns the full independent panel and publication gates; no commits
> before the final reviewed state. The invocation already selects active PR
> delivery, not merge or production activation.

**Goal:** Replace rejected range queries with complete bounded month selectors.

**Architecture:** Keep `Source.Scoreboard` and `Source.Bracket` signatures.
Share window retrieval in `backend/shared/source/scoreboard_window.go`, using
existing endpoint builders/client, season bounds, mappers and partial error.
The runner/store/freshness contract remains unchanged unless a failing
end-to-end regression proves a tightly coupled defect.

**Tech stack:** Go 1.26, net/http, encoding/json, existing pgx/Testcontainers.

## Task 1: Adapter regression and repair

Files: `backend/shared/source/scoreboard_window_test.go`,
`scoreboard_window.go`, `espn.go`, and affected existing source tests.

- [x] Add a recorded-error transport: reject hyphenated selectors with the
  observed 400; return explicit league/events month envelopes. Assert the
  requested sequence at fixed September 21 UTC is August then September and
  that the September 15 previously unknown match is returned without partial
  error. Use the existing injectable source clock and response helpers.

  ```go
  src.now = func() time.Time {
      return time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
  }
  matches, err := src.Scoreboard(context.Background(),
      config.Competition{ESPNSlug: "esp.1"},
      config.Season{ID: "2026-27"}, false)
  if err != nil || len(matches) != 1 {
      t.Fatalf("incomplete discovery: matches=%v err=%v", matches, err)
  }
  ```

- [x] Run `cd backend && go test ./shared/source -run TestMonthlyScoreboard`.
  Expect behavioral failure against range-plus-today implementation.
- [x] Enumerate calendar months from UTC start minus one day through exclusive
  end; reject more than 14 before issuing requests. Fetch sequentially under
  a 45-second child context; stop on first error. Keep 1,000-event/16 MiB caps.
- [x] Validate league/envelope/count, map events, validate month envelope,
  filter exact UTC window, require in-window season year, merge identical
  duplicates, reject conflicts and sort IDs. Emit raw merged events for both
  existing scoreboard and bracket mappers, retaining bracket-only metadata.
- [x] Wire both adapter paths. Retain 400-only current-date partial fallback.
  Anchor all boundary-sensitive source tests to injected UTC clocks and model
  each successful test transport's month envelope explicitly.
- [x] Cover Jan/Feb provider-date spill, UTC rollover, apertura/clausura,
  calendar/split/tournament bounds, exact empty results, cap before filtering,
  duplicate conflicts, foreign league/season, out-of-month, malformed payload,
  400/429/5xx/cancellation, retry counts and request deadlines.
- [x] Run `cd backend && go test ./shared/source ./shared/espn`.
  Expect all passing, with no live network dependency.

## Task 2: Whole-path regression

File: `backend/ingester/scoreboard_window_integration_test.go`.
Reuse `newRecoveryPostgres`, `testRunner` and a source wrapper that overrides
scoreboard with the actual ESPN adapter while isolating ancillary endpoints.

- [x] With an empty seeded local DB, make the real adapter discover a new
  provider event from a month; run normal processing and query canonical
  `match`, `match_external_ref`, `match_sync_status`, `match_poll_status`.
- [x] Assert complete polls store `outcome='ok'`, accepted source time and
  event count. Repeat unchanged data with an advanced runner clock; compare
  `match.updated_at` equality and advancing `observed_at`/`succeeded_at`.
- [x] Reschedule a nonfinal event; assert canonical ID unchanged and kickoff
  updated. Finalize through validated summary using the normal pipeline;
  assert later source regression cannot mutate sealed facts.
- [x] Fail a month, return truncated/invalid data, and exercise current-date
  partial fallback; assert no complete success renewal and no known deletion.
  Existing targeted recovery must still finalize a known overdue match.
- [x] Run the focused integration test with explicit environment:
  `DOCKER_HOST=unix:///Users/elopenmike/.colima/scorearc-match-recovery/docker.sock`
  and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
  Expect pass against ephemeral Postgres 16 with all migrations.

## Task 3: Review, documentation and delivery

- [x] Run `cd backend && go build ./... && go test -race ./... && go vet ./...`
  with the same Docker environment; preserve result artifacts outside repo.
- [x] Snapshot the worktree, dispatch all four configured Knights reviewers,
  evaluate JSON, repair concrete findings and repeat to convergence.
- [x] Update `docs/backend/MATCH_FRESHNESS.md`,
  `docs/backend/ARCHITECTURE.md`, affected source/runbook examples and
  `docs/CURRENT_STATE.md`. Date completed recovery operations explicitly;
  distinguish new local repair from unperformed production acceptance.
- [x] Document per-cycle and sweep logical/physical request ceilings,
  unchanged write budgets, undocumented-provider limitations and acceptance.
- [ ] Rerun affected checks. Perform a separate fresh final full-panel review
  on the same monotonically increasing round counter. Require publicationReady.
- [ ] Stage only reviewed task-owned files, conventional commit with Copilot
  trailers, verify hooks did not change content, push without force and open
  active non-draft PR. Verify remote head SHA and changed file set, no auto-merge.

## CI follow-through: cancellation before every HTTP attempt

The first push run exposed a ready-timer/cancellation race in the shared client;
the simultaneous PR run passed. Keep ownership of the same PR, without duplicate
workflow dispatch or changed retry/time budgets.

- [x] Reproduce with pre-cancelled/expired contexts and cancellation concurrent
  with a nanosecond retry timer in `shared/espn/client_test.go`.
- [x] Check `ctx.Err()` before every `GetJSON` attempt; tighten the source
  deadline regression to at most one transport call.
- [ ] Run stress regressions, full backend build/race/vet, and fresh complete
  Knights implementation/final panels before the follow-up commit.
- [ ] Push normally to the same PR and observe its resulting CI outcomes.
