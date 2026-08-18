# Fix Leader Double-Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `refreshLeaders` from replacing `top_scorer` twice on every slow tick,
forever, and close the correctness window where the table briefly serves ESPN
hotlinks instead of our CDN.

**Architecture:** `refreshLeaders` (`backend/ingester/runner.go`) writes the freshly-mapped
ESPN board, mirrors its crests to R2, then rewrites the whole board again if
`leaderCrestsChanged(board, mirrored)`. `board` is mapped fresh from ESPN on every
call and therefore always carries `a.espncdn.com` URLs; `mirrored` always carries
`cdn.scorearc.futbol` ones. The comparison is unconditionally true, so the second
`ReplaceLeaders` call — a full delete-and-reinsert of up to 30 rows — runs every
time, for every category, for every competition. Measured against production:
`top_scorer` absorbs +600/−600 tuple writes per slow tick for a 300-row table
(~345,600 writes/day), and all 300 stored rows already carry the CDN host, which is
only reachable through that redundant second write.

The fix is to reorder, not to add a second comparison. `mirrorLeaders` /
`mirrorLeader` (`backend/ingester/runner.go:692-762`, `mirrorAsset`
`backend/ingester/matches.go:405-449`) resolve each leader's crest purely from the
in-memory `[]model.StatLeader` slice already held after mapping ESPN's payload: they
hash the *source* URL to build a cache key, upload to the mirror/R2 if not already
cached, and rewrite `TeamCrestURL` in place. Nothing in that path reads
`top_scorer`, queries the store, or otherwise depends on the board having been
persisted first. So there is no ordering hazard — mirroring can safely happen
**before** the one and only `ReplaceLeaders` call, exactly as the design doc names
as the eventual state (`docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
§3.1: "mirror first and write once"). `leaderCrestsChanged` and its `stringValue`
helper become dead code once the second call is gone and are deleted with it — they
existed only to gate that second write.

This plan does **not** implement §4.1's broader content-memo (hash-and-skip)
guard — that is a separate, larger slice covering `standing` too. This is only the
leader-boards double-write.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), the existing `fakeRepository` /
`fakeSource` / `fakeMirror` test doubles in `backend/ingester/runner_test.go`.

**Spec:** `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md` §3.1
**Branch:** `fix/leader-double-write` off latest `origin/main`

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, confirmed failing for the stated reason, before touching
  `runner.go`.
- Backend gate: `cd backend && go build ./... && go vet ./... && go test -race ./...`
  — Docker must be running (some packages use testcontainers; this package's tests
  do not, but run the full gate anyway).
- Frontend gate per `.github/workflows/ci.yml`: `npm test`, `npx tsc --noEmit`,
  `npm run lint`, `npm run build` — none of this plan's files are TypeScript, but the
  gate still runs in CI on the PR, so confirm it stays green.
- **No migration.** This is a code-only fix; `top_scorer`'s schema and grants are
  untouched.
- Touch only `backend/ingester/runner.go` and `backend/ingester/runner_test.go`. Do
  not touch `standing`, `match_detail`, commentary, or any schema/migration file —
  those are other agents' concurrent slices on this same design doc.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
  Substitute your own agent identity if you are not Claude.

---

## File Structure

- `backend/ingester/runner.go` — `refreshLeaders` (mirror-then-write, single call),
  delete `leaderCrestsChanged` and `stringValue`.
- `backend/ingester/runner_test.go` — new regression test asserting exactly one
  `ReplaceLeaders` call per category when a crest needs mirroring.

---

### Task 1: Regression test, then the fix

**Files:**
- Modify: `backend/ingester/runner_test.go`
- Modify: `backend/ingester/runner.go:640-731` (`refreshLeaders`,
  `leaderCrestsChanged`, `stringValue`)

**Interfaces:** No signature changes. `refreshLeaders(ctx, comp, season) error` keeps
its shape; `leaderCrestsChanged` and `stringValue` are deleted, not renamed —
nothing outside this fix calls them (verified:
`grep -rn "stringValue(\|leaderCrestsChanged(" backend/ingester/*.go` returns only
the two call/definition sites inside `runner.go` itself).

- [x] **Step 1: Write the failing test**

The existing crest-mirroring tests (`TestLeaderCrestMirrorsOnceAcrossRefreshes`,
`TestLeaderCrestOutageUsesSharedCircuit`) only assert on `mirror.calls`, never on
how many times `ReplaceLeaders` ran — which is exactly why this bug shipped
unnoticed. Add a test that asserts on the write count.

Append to `backend/ingester/runner_test.go`, immediately after
`TestLeaderCrestMirrorsOnceAcrossRefreshes` (after its closing `}` around line 1852):

```go
// The bug: refreshLeaders wrote the ESPN board, mirrored its crests to R2, then
// rewrote the WHOLE board again if leaderCrestsChanged(board, mirrored) reported
// a difference. board is mapped fresh from ESPN every call and therefore always
// carries a.espncdn.com URLs, while mirrored always carries the mirror's host --
// so that comparison was unconditionally true and ReplaceLeaders ran twice per
// category, every tick, forever. Verified against production: all 300 stored
// top_scorer rows already carry the CDN host, reachable only via the second
// write. This test fails today because "goals" appears twice in
// repo.leaderCategories.
func TestRefreshLeadersWritesEachCategoryExactlyOnce(t *testing.T) {
	crest := "https://a.espncdn.com/i/teamlogos/soccer/500/win.png"
	src := &fakeSource{statistics: statisticsPayload(
		t,
		[]model.StatLeader{{
			Rank: 1, Player: "Winner", TeamAbbr: "WIN",
			TeamCrestURL: &crest, Value: 1,
		}},
		[]model.StatLeader{{Rank: 1, Player: "Helper", Value: 1}},
	)}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)
	runner.mirror = &fakeMirror{}

	result := runner.runCycle(context.Background(), true)
	if result.failures != 0 {
		t.Fatalf("result=%+v", result)
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	writes := map[string]int{}
	for _, category := range repo.leaderCategories {
		writes[category]++
	}
	if writes["goals"] != 1 || writes["assists"] != 1 {
		t.Fatalf("ReplaceLeaders calls per category = %v, want exactly {goals:1, assists:1}",
			writes)
	}
}
```

- [x] **Step 2: Run it to verify it fails, and for the stated reason**

Run: `cd backend && go test ./ingester/ -run TestRefreshLeadersWritesEachCategoryExactlyOnce -v`

Expected: FAIL —
```
leader_test.go:...: ReplaceLeaders calls per category = map[assists:1 goals:2], want exactly {goals:1, assists:1}
```
`goals` is the category carrying the crest, so it is the one that gets rewritten a
second time; `assists` (no crest in this fixture) is unaffected and stays at 1. If
the failure message instead complains about `result.failures` or a different
category, stop and re-read `refreshLeaders` before proceeding — the fix below
assumes this exact failure shape.

- [x] **Step 3: Reorder — mirror before the write, write once**

In `backend/ingester/runner.go`, replace this block inside `refreshLeaders`
(currently lines 663-686):

```go
		writeErr := r.repo.ReplaceLeaders(
			ctx, comp.ID, season.ID, sourceESPN, category, board,
		)
		if errors.Is(writeErr, store.ErrEmptyReplacement) {
			// Normal. Not every competition publishes every board, and an
			// absent assists table must not take the Golden Boot down with it.
			r.log.Info("leader board unavailable; preserving existing rows",
				"comp", comp.ID, "category", category)
			r.recordRun(ctx, comp.ID, "leaders_preserved", start, nil)
			continue
		}
		if writeErr != nil {
			errs = append(errs, fmt.Errorf("%s: %w", category, writeErr))
			continue
		}
		mirrored := r.mirrorLeaders(ctx, board)
		if leaderCrestsChanged(board, mirrored) {
			if err := r.repo.ReplaceLeaders(
				ctx, comp.ID, season.ID, sourceESPN, category, mirrored,
			); err != nil {
				errs = append(errs, fmt.Errorf("%s crests: %w", category, err))
			}
		}
	}
```

with:

```go
		// Mirror crests before the write, not after. mirrorLeaders only touches
		// the in-memory board -- it hashes each source URL, uploads to R2 once
		// per unique crest, and caches by that hash -- so it has no dependency
		// on rows already being stored, and mirroring first lets this write
		// once instead of twice. The old code wrote the ESPN board, mirrored
		// it, then rewrote the whole board again because the freshly-mapped
		// board always carried a.espncdn.com URLs and mirrored always carried
		// our CDN's, so that comparison was unconditionally true. Also closes
		// the window where the table served ESPN hotlinks between the two
		// writes.
		mirrored := r.mirrorLeaders(ctx, board)
		writeErr := r.repo.ReplaceLeaders(
			ctx, comp.ID, season.ID, sourceESPN, category, mirrored,
		)
		if errors.Is(writeErr, store.ErrEmptyReplacement) {
			// Normal. Not every competition publishes every board, and an
			// absent assists table must not take the Golden Boot down with it.
			r.log.Info("leader board unavailable; preserving existing rows",
				"comp", comp.ID, "category", category)
			r.recordRun(ctx, comp.ID, "leaders_preserved", start, nil)
			continue
		}
		if writeErr != nil {
			errs = append(errs, fmt.Errorf("%s: %w", category, writeErr))
			continue
		}
	}
```

- [x] **Step 4: Delete the now-dead comparison helpers**

Still in `backend/ingester/runner.go`, delete these two functions in their entirety
(currently lines 716-731, immediately after `mirrorLeaders`):

```go
func leaderCrestsChanged(before, after []model.StatLeader) bool {
	for index := range before {
		if index >= len(after) || stringValue(before[index].TeamCrestURL) !=
			stringValue(after[index].TeamCrestURL) {
			return true
		}
	}
	return len(before) != len(after)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
```

Leave `mirrorLeaders`, `mirrorLeader`, `mirrorAsset` and everything else in the file
untouched.

- [x] **Step 5: Run the regression test again**

Run: `cd backend && go test ./ingester/ -run TestRefreshLeadersWritesEachCategoryExactlyOnce -v`

Expected: PASS.

- [x] **Step 6: Run the full existing leader-board suite**

Run: `cd backend && go test ./ingester/ -run 'Leader' -v`

Expected: PASS — `TestLeaderCrestMirrorsOnceAcrossRefreshes`,
`TestLeaderCrestOutageUsesSharedCircuit`, `TestRefreshLeadersFetchesOnceAndWritesBoth`,
`TestEmptyLeaderBoardsPreserveRowsAndRemainRetryable`,
`TestEmptyAssistsBoardDoesNotFailTheCycle`, and the new
`TestRefreshLeadersWritesEachCategoryExactlyOnce`, all green. Pay particular
attention to `TestEmptyLeaderBoardsPreserveRowsAndRemainRetryable`: it proves the
`ErrEmptyReplacement` → "preserve existing rows" path still fires correctly now
that it guards the *only* write instead of the first of two.

- [x] **Step 7: Full backend gate**

Run: `cd backend && go build ./... && go vet ./... && go test -race ./...`

Expected: all three commands exit 0. `go vet` in particular confirms
`leaderCrestsChanged` and `stringValue` left no dangling references.

- [x] **Step 8: Commit**

```bash
git add backend/ingester/runner.go backend/ingester/runner_test.go
git commit -m "$(cat <<'EOF'
fix: mirror leader crests before writing, not after

refreshLeaders wrote the ESPN board, mirrored its crests to R2, then
rewrote the whole board again if leaderCrestsChanged(board, mirrored)
reported a difference. board is mapped fresh from ESPN every call and
always carries a.espncdn.com URLs; mirrored always carries our CDN's --
so the comparison was unconditionally true and ReplaceLeaders ran twice
per category, every tick, forever. Measured against production:
top_scorer absorbed +600/-600 tuple writes per slow tick for a 300-row
table (~345,600 writes/day), entirely from the redundant second pass.

mirrorLeaders has no dependency on persisted rows -- it hashes each
leader's source crest URL, uploads to R2 once per unique hash, and
rewrites the in-memory slice -- so mirroring can run before the write
instead of after it. That makes one write correct instead of two, and
closes the window where the table served ESPN hotlinks between the old
two writes. leaderCrestsChanged and stringValue existed only to gate
that second write and are deleted with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Full gate and PR

- [x] **Step 1: Backend gate, one more time, from a clean tree**

```bash
cd backend && go build ./... && go vet ./... && go test -race ./...
```

Expected: all green.

- [x] **Step 2: Frontend gate**

This change touches no TypeScript, but `.github/workflows/ci.yml` runs the frontend
gate on every PR regardless — confirm it stays clean rather than assuming.

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: suite green, typecheck silent, lint clean, build succeeds.

- [x] **Step 3: Open the PR**

```bash
git push -u origin fix/leader-double-write
gh pr create --title "fix: stop double-writing top_scorer on every slow tick" --body "$(cat <<'EOF'
## What

`refreshLeaders` replaced the whole `top_scorer` board twice per category on
every slow tick, forever — verified against production, where all 300 stored
rows already carry the mirrored CDN host, reachable only through the second,
redundant write. Measured cost: ~345,600 tuple writes/day for a 300-row table.

The guard that was supposed to make the second write conditional,
`leaderCrestsChanged(board, mirrored)`, compared the freshly-ESPN-mapped board
(always `a.espncdn.com`) against the mirrored one (always
`cdn.scorearc.futbol`), so it was unconditionally true. There was also a
correctness gap: between the two writes the table briefly served ESPN
hotlinks instead of our CDN.

## Approach

Mirror crests before the write instead of after, and write once.
`mirrorLeaders` only touches the in-memory board — it hashes each crest's
source URL, uploads to R2 once per unique hash, and rewrites the slice — so it
has no dependency on the board having been persisted first. Reordering makes
one write correct; `leaderCrestsChanged` and its `stringValue` helper existed
only to gate the now-removed second write and are deleted with it.

Scope: only the leader-board double-write, per
`docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
§3.1. The broader content-memo guard that §4.1 proposes (and that would also
cover `standing`) is a separate, larger slice and is not part of this PR.

## Testing

- New regression test, `TestRefreshLeadersWritesEachCategoryExactlyOnce`,
  fails against the old code (`goals` written twice) and passes against the
  fix.
- Full existing leader-board test suite (`-run 'Leader'`) green, including the
  `ErrEmptyReplacement` "preserve existing rows" path, now guarding the only
  write instead of the first of two.
- `cd backend && go build ./... && go vet ./... && go test -race ./...` clean.
- Frontend gate (`npm test`, `npx tsc --noEmit`, `npm run lint`,
  `npm run build`) clean, though this PR touches no TypeScript.

Plan: `docs/superpowers/plans/2026-08-18-fix-leader-double-write.md`
EOF
)"
```

- [x] **Step 4: Stop**

Do **not** merge. Merging is the user's decision — see `AGENTS.md`.

---

## Execution notes (2026-08-18)

- The RED test failed for the intended reason:
  `leader writes=map[assists:1 goals:2], want map[assists:1 goals:1]`.
  After the reorder, the targeted regression and existing leader tests passed.
- The Step 6 selector is incomplete: `-run 'Leader'` does not match
  `TestEmptyAssistsBoardDoesNotFailTheCycle`. The named test was run separately
  and passed, so the empty-assists preservation path is covered despite the plan
  command omitting it.
- The first full race-gate attempt found the documented Colima socket variables
  unset. After applying them, the default Colima VM proved full
  (`initdb: ... pg_wal: No space left on device`). The same gate passed against
  the existing healthy `scorearc-pr64-audit` Colima profile; no code change was
  needed for either environment failure.
- The exact CI gate passed: 25 frontend files / 210 tests, silent TypeScript
  typecheck, lint and build exit 0 with six pre-existing frontend warnings, and
  all backend packages pass under `go test -race ./...`.
- Independent Claude Opus 5 and GPT-5.6 Terra reviews both reported no BLOCKING
  findings and independently reran the full gate. Their NON-BLOCKING follow-ups
  are to strengthen the regression with cycle-success and persisted-CDN
  assertions, add direct coverage for the sole-write error branch, and correct
  the Step 6 selector before reusing this plan.
- No package-local ingester README exists. The shared write invariant is
  documented separately in `docs/backend/ARCHITECTURE.md`; no new package README
  was created for this two-file orchestration fix.

---

## Self-review notes

- **Ordering-dependency question, answered from the code.** `mirrorLeader`
  (`runner.go:733-762`) and `mirrorAsset` (`matches.go:405-449`) read only the
  `model.StatLeader` slice already in memory and `r.mirrored`/`r.rejectedAssets`
  in-process caches; neither calls into `r.repo`. `ReplaceLeaders`
  (`shared/store/competitions.go:78-115`) takes a plain `[]model.StatLeader` and
  does not resolve team IDs against anything already stored (unlike
  `ReplaceStandings`, which does resolve against `teamIDs`). So mirror-then-write
  has no ordering hazard, which is why this plan picks it over "compare against
  what was actually stored" — the latter would need a read-back that the former
  makes unnecessary.
- **Regression test targets the actual defect.** The two existing crest tests
  (`TestLeaderCrestMirrorsOnceAcrossRefreshes`, `TestLeaderCrestOutageUsesSharedCircuit`)
  assert on `mirror.calls`, never on `ReplaceLeaders` call count, which is exactly
  why the double-write shipped unnoticed. The new test asserts on
  `repo.leaderCategories`, which `fakeRepository.ReplaceLeaders` appends to on every
  non-empty call — the one existing hook precise enough to catch this.
- **`ErrEmptyReplacement` still behaves.** Moving the mirror call earlier does not
  change when the board is empty: `mirrorLeaders` on a zero-length slice is a no-op
  (the `for index := range mirrored` loop runs zero times), so `ReplaceLeaders`
  still receives a zero-length slice and still returns `ErrEmptyReplacement`,
  still logged as `leaders_preserved`. Step 6 runs
  `TestEmptyLeaderBoardsPreserveRowsAndRemainRetryable` explicitly to confirm this.
- **No scope creep.** Only `backend/ingester/runner.go` and
  `backend/ingester/runner_test.go` change. No migration, no schema, no touch to
  `standing`, `match_detail`, commentary, or `ReplaceStandings` — those are other
  agents' concurrent slices on the same design doc.
