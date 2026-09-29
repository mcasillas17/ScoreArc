# Frontend scoreboard windows implementation plan

> Use Superpowers test-driven execution and the full Knights review pipeline.

**Goal:** Restore all shared scoreboard-window consumers.
**Architecture:** One bounded raw-event loader feeds existing store mappers/caches.
**Tech stack:** TypeScript, native fetch/AbortSignal, existing Vitest.
**Spec:** ../specs/2026-09-29-frontend-scoreboard-windows-design.md

The owner's implementation/delivery instruction authorizes execution. Knights' full
review loops and pre-publication commit gate supersede generic per-task commit and
single-review defaults. No task is committed before final documented-state review.

## Task 1 — Bounded retrieval
- [x] Record compact regression payloads from bounded Node fetch probes.
- [x] Add `scoreboardWindow.test.ts` cases for monthly/year/UTC boundaries, scope,
  historical/split editions, duplicates, truncation, failures, bytes and cancellation.
  Run `npx vitest run src/server/data/scoreboardWindow.test.ts`; expect RED.
- [x] Implement `fetchScoreboardWindow(rc, range, fetchJson, signal?)` in
  `src/server/data/scoreboardWindow.ts`, retaining raw event metadata. FetchJson
  accepts optional `{signal, maxBytes}`; native bounded transport reads the stream.
- [x] Run the targeted tests; expect all GREEN.

## Task 2 — Shared consumers and honest errors
- [x] Add failing store/API integration regressions for calendar/live/upcoming,
  enriched filtered scope, computed tables, historical brackets and cache failure.
- [x] Route every explicit scoreboard read through the loader in `store.ts`;
  preserve no-range bracket behavior and mapper/identifier contracts.
- [x] Adapt existing mocks to valid monthly provider envelopes without weakening
  behavioral assertions. Correct EN/ES unavailableNow copy and page assertions.
- [x] Run store, API/page and query tests; expect GREEN, including unchanged limits.

## Task 3 — Acceptance and delivery
- [x] Run npm test, npx tsc --noEmit, npm run lint, npm run build; expect success.
- [x] Start dev server after build; verify requested real-browser surfaces and
  controlled unavailable states on desktop/mobile; keep preview running.
- [x] Full configured Knights implementation review, fixes and fresh rounds until
  clean. Update directly affected docs with dated evidence/budgets/limitations.
- [ ] Separate final full-panel documented-state review, then re-evaluate current
  snapshot before focused commit with Codex trailer, normal push and active PR.
- [ ] Verify remote SHA/files and automatically triggered CI; repair related
  failures in the same PR with affected tests and required fresh reviews.

## Review focus
Provider year differs for Clausura; padded months cross season boundaries; historical
brackets need raw round fields; failed partitions must not renew TTL; summary calls
must include only the exact retained window. Task 1/2 tests pin each behavior.

Implementation and local acceptance are complete. Publication milestones above
are recorded in the PR after they happen; this source does not predeclare review,
commit, push or CI outcomes. Operational details: [frontend window contract](../../FRONTEND_SCOREBOARD_WINDOWS.md).
