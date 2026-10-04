# Durable Match Monitor Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; Knights full-panel convergence and separate final review govern publication.

**Goal:** Durable opt-in match monitoring and retryable transition delivery, disabled on delivery.
**Architecture:** Reuse checkScope; one bounded v2 outbox plus GitHub artifact selection and two checkpoint workflow.
**Tech Stack:** Node 26 stdlib, existing Vitest/js-yaml, pinned GitHub Actions.
**Spec:** ../specs/2026-10-04-durable-match-monitor-design.md

## Global constraints

No production checks, dispatch, secrets, notifications, migrations or reader changes.
No new dependencies. Preserve v1 local checker. Commit reviewed task-owned work
only after Knights publication gate (overrides intermediate commit steps).

## Review focus

- Newer run missing a checkpoint must prevent rollback (Task 2).
- Accepted send plus lost acknowledgment can duplicate but never silently lose an event (Task 1/3).
- Disabled flags precede every side effect (Task 3).
- Scope/DTO changes cannot erase incidents or validate malformed fields (Task 1).
- Queue exhaustion must remain explicit and permit drainage (Task 1).

### Task 1: Bounded incidents, outbox and webhook

Files: scripts/match-freshness-watchdog.mjs and tests; new
scripts/match-freshness-monitor.mjs and scripts/match-freshness-monitor.test.ts.
Interfaces: prepareMonitor(options), deliverMonitor(options), validateState(state, config).
Reuse checkScope. Inject clock, checker, checkpoint callback for deterministic tests.

- [x] Add failing tests: current/additive scorer shapes; missing required fields rejected;
  healthy→OPEN→continued→RESOLVED→recurrence; pending OPEN survives recovery; queue caps;
  timeout/429/ambiguous acknowledgment retains event; upload failure sends zero messages.
- [x] Run `npx vitest run scripts/match-freshness-monitor.test.ts scripts/match-freshness-watchdog.test.ts`.
  Expect new assertions FAIL before implementation.
- [x] Implement strict state validation, atomic local lock/write and stable event IDs;
  prepared checkpoint reserves retries before send; FIFO acknowledgments retain bounded receipts.
- [x] Repeat focused command; expect PASS.

### Task 2: Trusted newest-state selection

Files: scripts/match-freshness-state.mjs and scripts/match-freshness-state.test.ts.
Interface: selectState({ github, run, initialize, now }) returns artifact/run provenance or explicit initialization.

- [x] Add mocked API tests for failed state-bearing runs; wrong repository/ref/workflow;
  newer missing/expired checkpoints; unavailable/corrupt state; bounded pages; first init;
  reruns/concurrent/newer runs and monotonic run numbers. Expect FAIL before implementation.
- [x] Implement fixed-origin bounded GitHub API reads and strict metadata selection.
- [x] Run `npx vitest run scripts/match-freshness-state.test.ts`; expect PASS.

### Task 3: Opt-in workflow and runbook

Files: .github/workflows/match-freshness.yml, monitoring tests,
docs/backend/MATCH_FRESHNESS.md, backend/reader/README.md.

- [x] Replace old workflow tests with failing executable phase/gate tests: disabled zero
  network; pending upload failure prohibits send; ack upload failure restores pending;
  serial concurrency; correct artifact IDs and immutable action pins.
- [x] Wire select→download→prepare→upload pending→deliver→upload final→classify result.
  Keep cron commented and exact enablement gates before side effects.
- [x] Document provenance, finite durability, failure behavior, cost budgets, activation,
  notification acknowledgment/dedup contract and unresolved recipient/T16.2 decisions.
- [x] Run focused tests, `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.
  Expect all gates pass; summarize existing warnings separately.
- [ ] Full Knights implementation reviews until clean; separate final fresh full panel;
  evaluate publicationReady immediately before staging; commit with Codex trailer.
- [ ] Push normally, create new active PR; observe automatic checks at exact final SHA.

## Execution evidence

Task 1: new outbox behavior failed first (13 tests), then passed. The additive
scorer regression failed against the old exact-key validator and then passed.
Task 2: mocked selector tests failed first, then passed; first full review added
nine failing cases for deleted-final/ambiguous-job history before repairing them.
Task 3: enabled phase harness failed first, then passed. It runs actual CLI phase
functions against loopback HTTP and mocked GitHub/artifact actions using parsed
workflow conditions. It covers both upload boundaries and same-ID replay.

Knights round 1 accepted all four findings: deleted-final rollback, restored-event
contradictions, enabled workflow integration coverage and generated next-env residue.
Repairs preserve the original scope; channel/recipient and T16.2 owner confirmation
remain explicit activation decisions. Shared roadmap/status paragraphs are untouched.

Local validation after round-1 repairs: 159 focused tests; full suite 1,395 tests
in 92 files; TypeScript and build exit 0; ESLint 0 errors / 5 unchanged UI warnings.

Implementation round 2 converged. Fresh final round 3 identified missing pending
sequence continuity; three failing multi-scope corruption tests preceded the fix.
The checkpoint now requires a contiguous pending suffix and retained FIFO receipt
prefix, preventing lost pending events from being suppressed by active incidents.
