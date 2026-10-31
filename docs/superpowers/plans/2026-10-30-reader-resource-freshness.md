# T17.3 implementation plan

Spec: `docs/superpowers/specs/2026-10-30-reader-resource-freshness-design.md`.
Base: latest `origin/main`, initially dffd25a. Branch: feat/t17-3-reader-freshness.

Global constraints: no production operations, source switch, JSON shape changes,
football fact correction, cache-policy change, match-threshold change, watchdog
edits, raw dependency logs or schema-gate weakening. User authorized active PR
delivery, not merge. Final task-owned commit follows current Knights final review.

## Task 1: durable scoped collection evidence

- [x] Add failing Postgres tests for resource/season/category isolation, empty
  evidence, failed/partial preservation, atomic rollback, memo renewal and grants.
- [x] Add the next additive migration, resource observation writer/helper and
  participation completion-time view. Wire collection writers atomically.
- [x] Run `cd backend && go test ./shared/store ./migrations` with Colima env.
  Expect new regressions red before implementation, then all pass.

Interfaces: `resource_observation(competition_id,season_id,source,resource,
subject,observed_at,row_count)`; `RecordResourceObservation(ctx,comp,season,
source,resource,subject string,rowCount int) error` renews an accepted unchanged
or validated-empty collection only after checking stored scope count. Changed
standings/leaders/squads stamp within their writer transaction.

## Task 2: source validation and ingester renewals

- [x] Write failing source/runner tests for explicit-empty versus absent category,
  malformed tail/truncation, memo-hit renewal, partial category and season scope.
- [x] Validate source collection completeness; renew accepted memo observations
  through the repository interface and observe validated empty scopes safely.
- [x] Run `cd backend && go test ./shared/espn ./shared/source ./ingester`.
  Expect input failures never advance evidence or erase retained data.

## Task 3: reader resource metadata and coherent snapshots

- [x] Write failing boundary, route coverage, composite, cache-hit, metadata-error,
  cancellation and snapshot-release tests.
- [x] Implement versioned fixed-size resource metadata, scoped SQL evidence,
  resource thresholds, CORS exposure and every route's resource map.
- [x] Move remaining database reads into existing snapshots/savepoints. Preserve
  bodies, validators and cache policies. Preserve news singleflight/cloning.
- [x] Extend real Postgres snapshot interleaving, SQL grants and query-bound tests.
- [x] Run `cd backend && go test ./reader`.
  Expect old match vectors unchanged; every successful data route has scoped
  resource metadata; missing evidence is explicit, read failure is 500/no-store.

## Task 4: cross-language contract and delivery

- [x] Add strict TS metadata parser and shared vectors; positive TS/Go/OpenAPI/DB
  assertions replace T17.3-freshness-coverage only. Preserve T16.6 and T21.4 scope.
- [x] Update directly affected reader/runbook/roadmap docs, costs and rollout
  prerequisites, distinguishing local implementation from production acceptance.
- [x] Fetch/reconcile latest main after logging T21.4 merges. Confirm migration
  number remains next. Rerun affected checks after reconciliation.
- [x] Run npm test, npx tsc --noEmit, npm run lint, npm run build; then backend
  go build ./..., go test -race ./..., go vet ./.... Expect all exit zero.
- [x] Run npm run dev and browser smoke the unchanged ESPN-backed website.
- [ ] Capture snapshot; full configured Knights implementation review; repair
  every actionable finding and repeat. Then fresh final full-panel review of
  documented state. Expect evaluator publicationReady=true.
- [ ] Stage only task-owned files, conventional commit with Codex trailer,
  normal push, non-draft PR with migration warning, coverage/cost/limits.
  Verify PR is OPEN and non-draft; never merge or deploy.

Evidence: failing-first logs and validation are retained outside the worktree in
`/tmp/scorearc-t17-3-knights/`. Reconciled with merged T21.4 commit
`56aef1593b1bdc44c7e7b1ff40f9cc29c1910c60`. Reader suite passed after rebase
(50.176s); all TypeScript tests, typecheck, lint and build passed. Lint retains
five pre-existing warnings. Browser smoke at `http://localhost:3317/en` rendered
the unchanged ESPN-backed home page. Final full Go gates and Knights review
records are included in the PR validation when complete.

Knights round 1 identified incomplete news-envelope validation and structurally
unvalidated nested roster statistics, plus an obsolete HTTP freshness helper.
Failing-first regressions reproduced both data-validation defects; the repairs
passed the affected race suites and the unused helpers were removed. The next
complete panel reassesses these repairs. The reported news cache-value type issue was rejected:
`cached` already returns `newsCacheEntry`; its reviewer confirmed the retraction.

Round 2 identified the same validation weakness in career history. The accepted
bio envelope now preserves the existing athlete-not-found policy while rejecting
malformed/incomplete histories; failing-first tests prove retained facts and clocks.
Because prior mappers could already have renewed malformed statistics/career clocks, added nullable
`player_season_stat.observed_at` and `player.bio_observed_at` in 0028 without
backfill; readers use only those validated-write clocks. Existing eligibility
timestamps and fetch cadence stay unchanged. Regressions prove legacy rows
remain unavailable until a newly accepted write.

Audited new observation-write errors: existing ingester audit/log code renders
errors directly, so new dependency failures now have safe loggable text with
wrapped causes retained. PostgreSQL metadata-trigger and deferred-commit failures
prove injected credential-like text stays out of loggable errors and writes roll back.
