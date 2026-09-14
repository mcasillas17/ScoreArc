# Team insights execution plan

Spec: [team insights design](../specs/2026-09-13-team-insights-design.md).
Baseline: latest origin/main `fea71f9`; branch `feat/team-insights-local-follows`.
Inspect current implementations before each edit. Preserve telemetry and default
home/team behavior. No production source, infrastructure, or release changes.

## 1. Contract foundation (independent backend/test ownership)

- [ ] Inventory 14 methods in `docs/backend/TEAM_INSIGHTS_CONTRACT.md` against
  current `backend/reader/{handlers,store,types}.go` and `openapi.yaml`.
- [ ] Add shared JSON vectors and TypeScript contract tests under
  `src/server/data/contracts/`, plus Go reader contract tests consuming the same
  files. Include recorded identity/schedule input, exact field/nullability checks,
  explicit ID translation, query/error vectors and known-gap assertions.
- [ ] Run `npx vitest run src/server/data/contracts` and targeted Go reader tests.
  Expect: failures for intentionally mutated supported fields; actual contracts
  pass; unsupported semantics remain named gaps (no skipped tests).
- [ ] Commit: `test: establish team insights reader contract slice`.

## 2. Scoped performance data and derivation

- [ ] Add failing tests for scoped schedule requests/results, nullable/invalid
  scores, unavailable payloads and unchanged cache/failure behavior.
- [ ] Extend `types.ts`, `endpoints.ts`, `providers/espn-team.ts`, `store.ts`
  through the existing seam, adding explicit scope and schedule availability.
- [ ] Add pure `teamPerformance.ts` with tests for home/away, ties, shootouts,
  exceptional states, duplicates/conflicts/order, wrong team/scope and windows.
- [ ] Run targeted mapper/store/performance tests; expect exact window membership,
  denominators and deltas, with no comparison under ten. Commit data slice.

## 3. Local follows (independent client ownership)

- [ ] Add storage/hydration tests first. Implement a bounded validated versioned
  store plus hook using browser lifecycle and canonical identity helpers.
- [ ] Add `FollowTeamButton` and `YourTeams` using existing localization. Parent
  integrates them into header/home and owns shared CSS and dictionary edits.
- [ ] Verify persist/unfollow, corrupt/versioned data, future schema, unavailable
  and quota storage, cross-tab events, locale/season independence and hydration.
  Expect: no initialization write; failures retain in-memory usability. Commit.

## 4. Team and home integration

- [ ] Replace inline form derivation with the shared performance section. Reuse
  `MatchDetailPopup` and the existing summary API/telemetry; refactor shared detail
  opening logic if useful, without copying a second detail presentation.
- [ ] Preserve next match, squad and schedule; make evidence match rows accessible.
  Add follow near the header and lightweight shortcuts to the existing digest.
- [ ] Add English/Spanish copy, local loading/unavailable/insufficient states and
  CSS using existing tokens after inspecting matching rules. Run page/navigation/
  detail/telemetry tests and targeted lint. Commit UI slice.

## 5. Validation and independent review

- [ ] Run `npm test`, `npx tsc --noEmit`, lint, and `npm run build`; never run build
  alongside dev on this `.next`. Go build, `go test -race -count=1 ./...`, vet;
  use a running verified Docker profile, never prune shared data.
- [ ] Start dev and inspect real data: América, Arsenal and a ten-match team;
  both locales, phone 320/390/560 and desktop, keyboard, disabled storage,
  hydration/console, home navigation and supporting match detail. Save screenshots.
- [ ] Run configured independent Sol/Terra whole-panel review, fix concrete issues,
  rerun affected checks and repeat until clean. Update roadmap/current state with
  exact partial completion and scheduling exception; add validation handoff.
- [ ] Run fresh final full-panel review of documented state. Commit with Codex
  trailer, push all intended commits; verify remote head and full PR file set.
- [ ] Open ACTIVE ready-for-review PR; no draft, auto-merge, merge or deployment.
  Leave dev running and hand over URLs with what to inspect.
