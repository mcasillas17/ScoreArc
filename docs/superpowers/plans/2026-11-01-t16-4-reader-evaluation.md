# T16.4 Reader Evaluation Implementation Plan

> Execute with installed Knights, test-driven implementation and its full panel.

**Goal:** Bounded trustworthy direct-reader vs explicit-ESPN evaluation.
**Architecture:** Opt-in CLI, isolated budgets/caches, named semantic comparison,
explicit joined samples, recorded/synthetic offline transport and bounded report.
**Tech stack:** Existing TypeScript, Vitest, tsx and Node; no new dependencies.
**Spec:** `docs/superpowers/specs/2026-11-01-t16-4-reader-evaluation-design.md`

## Global constraints

Keep website defaults and response path unchanged. No backend/production work,
migration, schedule, notification, watchdog edits or player-directory UI edits.
News never counts as parity. Commits are held until Knights publication gate.

## Review focus

- Swallowed ESPN dependencies and accidental selected-store fallback: task 2.
- Value distinctions and misleading held-data projections: task 1.
- Entity links, player discovery changes and scope equivalence: tasks 2–3.
- Streaming/cancellation, request admission and report bounds: task 2.
- Synthetic coverage mistaken for live/global parity: tasks 3–4.

### Task 1: Semantic comparison

Files: `src/server/data/evaluation/normalize.ts` and `normalize.test.ts`.
Interface: `compareSemantic(kind, reader, espn)` returns bounded differences with
schema path/category, named normalizations and truncation; no raw values.
- [x] Write assertions proving score/entity/coverage and null/zero/false/empty survive;
  approved timestamp/order/evidence/held projections alone normalize.
- [x] Run focused tests (expect missing module failure), then implement.
- [x] Run focused tests (expect PASS). Commit with final reviewed task.

### Task 2: Runner, scope and transport accounting

Files: `src/server/data/evaluation/{evaluate,scenarios}.ts` and tests.
Interface: `evaluate({enabled,manifest,readerOrigin,fetch,now,signal})` returns a
bounded report. Direct factories only; fresh caches per side/sample; no selection.
- [x] Write disabled zero-request, reader-failure false-match, metadata/timing,
  partial dependency, cancellation, manifest/runtime/call/byte/report-cap tests.
- [x] Run focused tests (expect missing implementation failures), then implement
  strict manifest parsing, two bounded sources and finite scenario dispatch.
- [x] Run focused tests (expect PASS), inspect all adapter/index callers before
  changing shared files; prefer evaluation-only changes.

### Task 3: Offline and joined evidence

Files: `scripts/reader-evaluate.ts`, evaluation fixture transport and tests;
reuse recorded contract payloads and local preview where applicable.
- [x] Add all eleven methods and explicitly addressed navigation scenarios,
  including both derived standings and T7.3. Run tests first (expect failure).
- [x] Add disabled/offline/live CLI modes; live requires explicit origin and
  bounded manifest, documented separately authorized procedure only.
- [x] Run offline command (expect JSON with counts/costs/limitations, no network),
  save sample report. Run npm test, tsc, lint, build (expect PASS).

### User followup: popup crests

- [x] Add failing club/national/missing-crest and form-popup propagation regressions.
- [x] Pass existing competition style through all popup callers; use held club
  crests with contain fit and abbreviation fallback, preserving national flags.
- [x] Verify local popup at low/middle/high mobile widths and desktop, then
  include this user-authorized fix in the full Knights panel (320/390/460/1280 px).

### Task 4: Review and delivery

- [x] Update `docs/backend/READER_EVALUATION.md`, roadmap and adapter cross-reference
  with matrix, normalizers, per-method criteria, costs and owner decisions.
- [x] Fetch latest main and reconcile shared adapter/index changes. Run default
  local browser smoke; no production fault injection or reader activation.
- [x] Snapshot and full Knights implementation panel; repair all actionable
  feedback until convergence (round 4: all three configured reviewers clean).
- [ ] Fresh final documented-state panel after latest-main reconciliation, same counter.
- [ ] Re-evaluate publicationReady, commit task-owned files, normal push and
  active non-draft PR. Do not merge or deploy.
