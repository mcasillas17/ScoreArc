# Match Upsert No-Op Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `UpsertMatch` from rewriting a `match` row that has not changed. Measured
in production: **82 `match` updates per slow tick against a 2,578-row table — 23,616
tuple writes a day** — because `matchUpsertSQL` compares nothing; its `WHERE` clause
enforces the finalization and state-regression invariants and then always writes,
setting `updated_at = now()` unconditionally. Of the 2,578 matches, 2,210 are
scheduled and sit outside the live window: their kickoff, score, minute and status do
not move from tick to tick, so these updates are almost entirely no-ops that still
produce a full tuple version each. This is C2 in the classification (`match` is
live-volatile while a match plays, immutable once it is `finalized_at`) and its stated
guard is: **write only when the content differs from what is stored.**

**Architecture:** `store.MatchRow` — the comparison snapshot `ExistingMatches` already
loads once per competition per cycle — currently carries only part of what
`matchUpsertSQL` writes. It has `State`, `Round`, `BracketRequired`, `WinnerID`,
`Note`, `Home`/`Away` (for their ids), and the two placeholder flags, but not
`Kickoff`, `HomeScore`, `AwayScore`, `Minute`, `StatusDetail` or `StatusName`. Without
those six the runner cannot tell a genuine change from a redundant write. This plan
widens `MatchRow` and `ExistingMatches`' query with exactly those six columns, adds a
pure comparison function in the ingester that mirrors `matchUpsertSQL` column for
column — using `IS DISTINCT FROM` semantics, not `=`, and reproducing the SQL's own
`COALESCE`/`CASE` logic for the four columns that are not simple overwrites — and
skips the `UpsertMatch` call when nothing would change. **No SQL predicate, no
migration.** The comparison happens in Go, after `processMatches`' existing
preservation rules (round/bracket/winner/team carry-forward) have already produced
the final intended values — comparing before them would make a preserved round or
winner look like a change and silently drop a real one, which the design spec calls
out by name as the failure mode this guard must not have.

The new guard **composes with, and runs strictly after, the two guards that already
exist**: `skipMatchUpsert` (a state-regression guard — e.g. a live match cannot
regress to scheduled except a genuine postponement) and the finalized-match `continue`
a few lines above it. Neither is touched. The finalization transition is untouched
for a second, independent reason: it always changes `state` to `'finished'` from
something else, so it can never satisfy "nothing differs," and `FinalizeMatch` is a
separate, unconditional write in `shared/store/matches.go` that does not depend on
whether `UpsertMatch` ran on a given tick at all.

**`updated_at` does not move on a genuine no-op**, because the whole `UPDATE`
statement is skipped — there is no write for `now()` to land in. This is intentional,
not a side effect to patch around: `docs/superpowers/plans/2026-08-18-api-health-and-provenance.md`
(T10.10, a sibling slice) builds ingest freshness monitoring entirely from
`ingest_run`, never from `match.updated_at` — confirmed by reading that plan and by
`grep -rn "updated_at" backend/reader` returning nothing that touches `match`. The
`"matches"` `ingest_run` kind is already logged once per competition per cycle at
`ingester/runner.go:365` (`r.recordRun(ctx, comp.ID, "matches", matchStart,
processErr)`), independent of how many individual `UpsertMatch` calls happened to run
inside that cycle — so freshness reporting is unaffected whether this guard skips
zero or all 82 of a tick's candidate writes.

**Tech Stack:** Go 1.26, pgx v5.10.0, Postgres 17 (Neon production) / Postgres 16 (CI
service container + testcontainers), golang-migrate.

**Spec:** `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
— §2 (the C1–C5 classification; `match` is C2, "live-volatile"), §3.3 (this exact
finding, measured), §4.2 (**"Extend `MatchRow` and skip the no-op `UpsertMatch`"** —
the design this plan implements verbatim).
**Epic:** E7 · History & trends / ingester write path
(`docs/PRODUCT_ROADMAP.md`). This plan implements §4.2 only, one slice of the write-
classification cleanup; five sibling plans divide the rest of §4 (leader/standings
double-write memo, the competition-level content memo, scheduled-match detail TTL,
commentary tail writes, C1 schema invariants) and are out of scope here. No new
roadmap task number is allocated by this plan — §4.2 is a sub-item of the design
spec's existing task list, not a new epic-level deliverable.
**Branch:** `tweak/match-upsert-noop-guard` off latest `origin/main`

---

## Implementation record (2026-08-18)

- Implemented on the harness-managed branch
  `mcasillas17-fix-match-upsert-noop-guard`, based on `origin/main` at
  `3625016c4eb62b36f3f3a1f718bcd330853cb200`.
- **Plan correction:** Task 1's quoted acceptance test initialized
  `MatchRow.Kickoff`, `StatusDetail`, and `StatusName` before Task 2 added those
  fields, so the stated runtime RED could not compile. The test was first
  committed with only the fields available on the pre-Task-2 `MatchRow`, where
  it failed for the intended duplicate second write. After Task 2 widened the
  snapshot, the realistic kickoff/status setup was restored before the guard
  was wired, and the restored test was reconfirmed RED against pre-wiring code.
- Testcontainers initially failed with `rootless Docker not found` because the
  active Colima profile did not expose `/var/run/docker.sock` on the host.
  Running with that profile's `DOCKER_HOST` and
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` exercised the
  real Postgres 16 tests.
- Round 1 independent reviews used Claude Opus 5 and GPT-5.6 Terra. Both ran
  the full frontend/backend gate and reported **NO BLOCKING FINDINGS**.
- Review follow-ups are carried in the implementation PR:
  backlog ordering by `match.updated_at` has a theoretical fairness edge above
  500 unfinalized rows; a future differential SQL-vs-Go guard test and a
  changed-score runner acceptance case would harden drift detection; the
  scheduled-detail-TTL slice will require a manual merge of its additional
  `MatchRow`/`ExistingMatches` columns; the SQL comment quote typo found in
  review was fixed here. The harness-managed branch name and required Copilot
  App trailer supersede the plan's illustrative branch/trailer text.
- No package-local ingester README exists. This internal write-path behavior is
  documented here and in the separate shared architecture-docs PR
  [#68](https://github.com/mcasillas17/ScoreArc/pull/68); no public API or
  OpenAPI contract changed.

---

## Global Constraints

- **No migration.** Every column this plan reads already exists on `match`
  (`migrations/0001_init.up.sql`). `MatchRow` is a Go struct and `ExistingMatches` is
  a `SELECT`; nothing here needs `ALTER TABLE`.
- Backend gate, from `backend/`: `go build ./... && go vet ./... && go test -race ./...`
  — the store-level test in Task 2 uses testcontainers, so **Docker must be running**.
- Frontend gate unchanged and still required before a PR by `AGENTS.md`: `npm test`,
  `npx tsc --noEmit`, `npm run lint`, `npm run build`. Nothing in `src/` changes, so
  this is a fast confirmation, not a design constraint — run it anyway.
- **The comparison must run on `match` in its FINAL form** — after
  `processMatches`' existing preservation block — never on the raw provider payload.
- **Never weaken the existing guards.** `skipMatchUpsert` (state regression) and the
  `current.FinalizedAt.Valid` early-continue are untouched; the new guard only adds a
  third, independent reason to skip the one `UpsertMatch` call, gated behind both of
  the existing ones already having decided not to skip.
- **When a column's SQL-side value cannot be reproduced by simple equality — because
  `matchUpsertSQL` computes it with a `CASE` or a `COALESCE` that can reference the
  stored row — the comparison must reproduce that computation, not approximate it.**
  A false "unchanged" silently drops a real write; a false "changed" costs one
  redundant tuple, which is exactly the cost this plan exists to remove but is never
  a correctness bug. When in doubt, the guard must resolve to "changed."
- Conventional commit prefixes, ending with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Substitute
  your own agent identity if you are not Claude.
- **Never push to `main`.** Feature branch, PR, and the merge is the user's call.

---

## File Structure

**Modified:**
- `backend/shared/store/matches.go` — `MatchRow` gains `Kickoff`, `HomeScore`,
  `AwayScore`, `Minute`, `StatusDetail`, `StatusName`; `ExistingMatches`' `SELECT`
  and `Scan` gain the matching six columns.
- `backend/shared/store/store_test.go` — a new integration test proving the six
  columns round-trip through `ExistingMatches`.
- `backend/ingester/schedule.go` — new pure functions `matchRowUnchanged`,
  `finalRound`, `finalPlaceholder`, `coalesceIntUnchanged`, `strPtrEqual`,
  `boolPtrEqual`, alongside the existing `needsSummary`/`nextInterval`.
- `backend/ingester/schedule_test.go` — table-driven unit tests for
  `matchRowUnchanged`, covering the `COALESCE`/`CASE` edge cases by name.
- `backend/ingester/matches.go` — `processMatches` computes `noopUpsert` after its
  existing preservation block and adds it to the `UpsertMatch` gate.
- `backend/ingester/runner_test.go` — the acceptance test,
  `TestUnchangedScheduledMatchWritesOnce`, plus a fixture helper.

**Deliberately NOT modified** — checked, no call site depends on it:
- No migration file. `docs/backend/ARCHITECTURE.md` is updated in the required
  separate shared-docs PR because skipped writes change ingester behavior and
  `match.updated_at` semantics; it remains outside this implementation branch.
- `backend/reader/**` — does not read `MatchRow` or `ExistingMatches`; confirmed via
  `grep -rn "MatchRow\|ExistingMatches" backend/reader` returning nothing.
- `shared/store/matches.go`'s `matchUpsertSQL`, `UpsertMatch`, `FinalizeMatch` and
  `UnfinalizedMatches` — untouched. The guard decides whether to *call* `UpsertMatch`;
  it does not change what that call does.

---

### Task 1: Write the failing acceptance test

**Files:**
- Modify: `backend/ingester/runner_test.go`

Before touching any production code, prove the bug the way the design spec measured
it: run the exact same unchanged scoreboard candidate through two ticks and show that
today's code writes it twice.

- [x] **Step 1: Add a scheduled-match fixture and the acceptance test**

In `backend/ingester/runner_test.go`, add near `finishedMatch()` (around line 962):

```go
// scheduledNoOpMatch is a fixture with realistic non-empty status text, unlike
// finishedMatch(), specifically so TestUnchangedScheduledMatchWritesOnce proves
// the guard on a payload that isn't just all-zero-values matching all-zero-values
// by coincidence.
func scheduledNoOpMatch() model.Match {
	return model.Match{
		ID: "m1", Kickoff: "2026-06-11T18:00:00Z",
		State:        model.MatchStateScheduled,
		StatusDetail: "Scheduled",
		StatusName:   "STATUS_SCHEDULED",
		Home:         model.Team{ID: "home", Name: "Home", Abbr: "HOM"},
		Away:         model.Team{ID: "away", Name: "Away", Abbr: "AWY"},
	}
}

// TestUnchangedScheduledMatchWritesOnce is the regression test for the C2 guard
// (design doc §4.2, §3.3). Before the guard, matchUpsertSQL was a blind UPDATE:
// 82 updates per slow tick against a 2,578-row match table, ~23,616/day, almost
// all rewriting a scheduled fixture whose kickoff, score and status had not
// moved since the previous tick. Two ticks over the exact same provider payload
// must produce exactly one write, not two.
func TestUnchangedScheduledMatchWritesOnce(t *testing.T) {
	match := scheduledNoOpMatch()
	src := &fakeSource{matches: []model.Match{match}}
	repo := &fakeRepository{existing: map[string]store.MatchRow{}}
	comp := config.Competition{
		ID: "test", CurrentSeasonId: "2026",
		Seasons: map[string]config.Season{"2026": {ID: "2026"}},
	}
	runner := testRunner(src, repo, comp)

	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	if err != nil {
		t.Fatal(err)
	}

	// Tick 1: nothing stored yet, so this is a genuine write.
	runner.runCycle(context.Background(), false)
	if repo.matchCalls != 1 {
		t.Fatalf("first tick upsert calls=%d, want 1", repo.matchCalls)
	}

	// The fake's `existing` fixture does not mutate itself after UpsertMatch --
	// unlike Postgres, it has no memory of what was just written. This block
	// plays that role: it is what tick 1 actually persisted, in MatchRow shape.
	repo.mu.Lock()
	repo.existing["m1"] = store.MatchRow{
		State: match.State, Kickoff: kickoff,
		StatusDetail: match.StatusDetail, StatusName: match.StatusName,
		Home: model.Team{ID: fakeTeamID("home")},
		Away: model.Team{ID: fakeTeamID("away")},
	}
	repo.mu.Unlock()

	// Tick 2: the exact same provider payload. Nothing changed.
	runner.runCycle(context.Background(), false)
	if repo.matchCalls != 1 {
		t.Fatalf(
			"second tick upsert calls=%d, want still 1 -- an unchanged match must not write twice",
			repo.matchCalls,
		)
	}
}
```

- [x] **Step 2: Run it and confirm it fails against today's code**

```bash
cd backend && go test ./ingester/... -run TestUnchangedScheduledMatchWritesOnce -v
```

Expected: **FAIL**.

```
--- FAIL: TestUnchangedScheduledMatchWritesOnce (0.00s)
    runner_test.go:...: second tick upsert calls=2, want still 1 -- an unchanged match must not write twice
FAIL
```

This is the reproduction: `matchUpsertSQL` has no content comparison today, so
`processMatches` calls `UpsertMatch` on tick 2 even though nothing in the stored row
would change.

- [x] **Step 3: Branch and commit the failing test**

```bash
git fetch origin && git checkout -b tweak/match-upsert-noop-guard origin/main
git add backend/ingester/runner_test.go
git commit -m "test: reproduce the match upsert no-op — two identical ticks write twice

matchUpsertSQL compares nothing; its WHERE clause only enforces the
finalization and state-regression guards. Two ticks over the same
scheduled-match payload should produce one write, and today produce two.
This is the acceptance test for the C2 guard in
docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
§4.2.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Widen `MatchRow` and `ExistingMatches` with the comparison columns

**Files:**
- Modify: `backend/shared/store/matches.go`
- Modify: `backend/shared/store/store_test.go`

**Interfaces:**
- `MatchRow` gains `Kickoff time.Time`, `HomeScore *int`, `AwayScore *int`,
  `Minute *string`, `StatusDetail string`, `StatusName string`.
- `ExistingMatches`' `SELECT` and `Scan` gain `m.kickoff, m.home_score, m.away_score,
  m.minute, m.status_detail, m.status_name`, in that order.

These are exactly the six columns `matchUpsertSQL` writes that `MatchRow` does not
already carry. Everything else it writes is already on `MatchRow`: `round` →
`Round`, `state` → `State`, `home_team_id`/`away_team_id` → `Home.ID`/`Away.ID`,
`winner_id` → `WinnerID`, `note` → `Note`, `home_placeholder`/`away_placeholder`,
`bracket_required` → `BracketRequired`. `source` is deliberately **not** added: every
`UpsertMatch` call in this process writes the same `sourceESPN` constant
(`ingester/matches.go:23`), so comparing it could never produce a false "unchanged" —
widening `MatchRow` for a value that never varies would be scope creep past what §4.2
specifies.

- [x] **Step 1: Write the failing test**

In `backend/shared/store/store_test.go`, add after `TestFinalizedMatchAndDetailAreFrozen`:

```go
// TestExistingMatchesReturnsTheNoOpGuardColumns is the store-side half of the
// C2 guard (design doc §4.2): the ingester cannot tell a genuine change from a
// redundant write without kickoff, score, minute and status on MatchRow.
func TestExistingMatchesReturnsTheNoOpGuardColumns(t *testing.T) {
	store, _ := newSeededStore(t)
	ctx := context.Background()
	kickoff := time.Date(2026, 8, 25, 15, 0, 0, 0, time.UTC)
	identity := resolveFixture(t, store, "compare-1", kickoff)
	homeScore, awayScore := 2, 1
	minute := "67"
	match := fixtureMatch(identity, "compare-1", kickoff)
	match.State = model.MatchStateLive
	match.HomeScore, match.AwayScore = &homeScore, &awayScore
	match.Minute = &minute
	match.StatusDetail, match.StatusName = "Second Half", "STATUS_IN_PROGRESS"
	if err := store.UpsertMatch(ctx, identity, match); err != nil {
		t.Fatal(err)
	}

	rows, err := store.ExistingMatches(ctx, testCompetition, testSeason, []uuid.UUID{identity.MatchID})
	if err != nil {
		t.Fatal(err)
	}
	row, ok := rows[identity.MatchID]
	if !ok {
		t.Fatal("match missing from ExistingMatches")
	}
	if !row.Kickoff.Equal(kickoff) {
		t.Fatalf("kickoff = %v, want %v", row.Kickoff, kickoff)
	}
	if row.HomeScore == nil || *row.HomeScore != 2 || row.AwayScore == nil || *row.AwayScore != 1 {
		t.Fatalf("score = %v-%v, want 2-1", row.HomeScore, row.AwayScore)
	}
	if row.Minute == nil || *row.Minute != "67" {
		t.Fatalf("minute = %v, want 67", row.Minute)
	}
	if row.StatusDetail != "Second Half" || row.StatusName != "STATUS_IN_PROGRESS" {
		t.Fatalf("status = %q/%q, want %q/%q", row.StatusDetail, row.StatusName,
			"Second Half", "STATUS_IN_PROGRESS")
	}
}
```

- [x] **Step 2: Run it to verify it fails to compile**

```bash
cd backend && go test ./shared/store/ -run TestExistingMatchesReturnsTheNoOpGuardColumns
```

Expected: a **compile error**, because `MatchRow` has no `Kickoff` field yet:

```
./store_test.go:...: row.Kickoff undefined (type MatchRow has no field or method Kickoff)
```

If instead you see `dial tcp ... connection refused`, **Docker is not running** —
`newSeededStore` uses testcontainers. Start Docker and re-run; the compile error must
appear before the container ever matters.

- [x] **Step 3: Widen `MatchRow`**

In `backend/shared/store/matches.go`, replace the `MatchRow` struct:

```go
// MatchRow is the stored state of a match, in canonical space: every id on it
// is a ScoreArc id, never a provider one.
type MatchRow struct {
	State           model.MatchState
	FinalizedAt     pgtype.Timestamptz
	HasDetail       bool
	Round           string
	BracketRequired *bool
	WinnerID        *string
	Note            *string
	Home            model.Team
	Away            model.Team
	HomePlaceholder bool
	AwayPlaceholder bool
}
```

with:

```go
// MatchRow is the stored state of a match, in canonical space: every id on it
// is a ScoreArc id, never a provider one.
type MatchRow struct {
	State           model.MatchState
	FinalizedAt     pgtype.Timestamptz
	HasDetail       bool
	Round           string
	BracketRequired *bool
	WinnerID        *string
	Note            *string
	Home            model.Team
	Away            model.Team
	HomePlaceholder bool
	AwayPlaceholder bool
	// The remaining six are the columns matchUpsertSQL writes that were not
	// already above -- added so the ingester's no-op guard (design doc §4.2)
	// can tell a genuine change from a redundant write. source is deliberately
	// absent: every write in this process carries the same sourceESPN
	// constant, so comparing it could never produce a false "unchanged".
	Kickoff      time.Time
	HomeScore    *int
	AwayScore    *int
	Minute       *string
	StatusDetail string
	StatusName   string
}
```

- [x] **Step 4: Widen `ExistingMatches`**

In the same file, replace the `ExistingMatches` query and scan:

```go
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.state, m.finalized_at, d.match_id IS NOT NULL,
	COALESCE(m.round, ''), m.bracket_required, m.winner_id, m.note,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url,
	m.home_placeholder, m.away_placeholder
FROM match m
LEFT JOIN match_detail d ON d.match_id=m.id
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.competition_id=$1 AND m.season_id=$2 AND m.id=ANY($3)`,
		competitionID, seasonID, ids)
```

with:

```go
	rows, err := s.pool.Query(ctx, `
SELECT m.id, m.state, m.finalized_at, d.match_id IS NOT NULL,
	COALESCE(m.round, ''), m.bracket_required, m.winner_id, m.note,
	home.id, home.name, home.abbr, home.crest_url,
	away.id, away.name, away.abbr, away.crest_url,
	m.home_placeholder, m.away_placeholder,
	m.kickoff, m.home_score, m.away_score, m.minute, m.status_detail, m.status_name
FROM match m
LEFT JOIN match_detail d ON d.match_id=m.id
JOIN team home ON home.id=m.home_team_id
JOIN team away ON away.id=m.away_team_id
WHERE m.competition_id=$1 AND m.season_id=$2 AND m.id=ANY($3)`,
		competitionID, seasonID, ids)
```

and the `Scan` call:

```go
		if err := rows.Scan(
			&id, &row.State, &row.FinalizedAt, &row.HasDetail,
			&row.Round, &row.BracketRequired, &row.WinnerID, &row.Note,
			&row.Home.ID, &row.Home.Name, &row.Home.Abbr, &row.Home.CrestURL,
			&row.Away.ID, &row.Away.Name, &row.Away.Abbr, &row.Away.CrestURL,
			&row.HomePlaceholder, &row.AwayPlaceholder,
		); err != nil {
```

with:

```go
		if err := rows.Scan(
			&id, &row.State, &row.FinalizedAt, &row.HasDetail,
			&row.Round, &row.BracketRequired, &row.WinnerID, &row.Note,
			&row.Home.ID, &row.Home.Name, &row.Home.Abbr, &row.Home.CrestURL,
			&row.Away.ID, &row.Away.Name, &row.Away.Abbr, &row.Away.CrestURL,
			&row.HomePlaceholder, &row.AwayPlaceholder,
			&row.Kickoff, &row.HomeScore, &row.AwayScore,
			&row.Minute, &row.StatusDetail, &row.StatusName,
		); err != nil {
```

`kickoff` is `NOT NULL` on `match` (`migrations/0001_init.up.sql`), so `time.Time`
scans directly with no pointer needed. `home_score`/`away_score`/`minute` are
nullable; `status_detail`/`status_name` are `NOT NULL DEFAULT ''`.

- [x] **Step 5: Run the test again**

```bash
cd backend && go test ./shared/store/ -run TestExistingMatchesReturnsTheNoOpGuardColumns -v
```

Expected: `PASS`.

- [x] **Step 6: Run the whole store package to confirm nothing else broke**

```bash
cd backend && go test ./shared/store/... -race
```

Expected: `ok`, all packages. (Testcontainers spins up Postgres 16 for the
integration tests in this package — this can take 10–20s the first time an image
pulls.)

- [x] **Step 7: Commit**

```bash
git add backend/shared/store/matches.go backend/shared/store/store_test.go
git commit -m "feat(store): widen MatchRow with the columns UpsertMatch writes

Kickoff, HomeScore, AwayScore, Minute, StatusDetail and StatusName join
the fields ExistingMatches already returned, so the ingester's no-op
guard (design doc §4.2) has everything it needs to tell a genuine
change from a redundant write. source is deliberately not added: it
never varies within a process.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add the comparison function and its `CASE`/`COALESCE` mirrors

**Files:**
- Modify: `backend/ingester/schedule.go`
- Modify: `backend/ingester/schedule_test.go`

**Interfaces:**
- `matchRowUnchanged(identity store.MatchIdentity, match model.Match, current
  store.MatchRow) bool` — the guard itself.
- `finalRound(match model.Match, current store.MatchRow) string`,
  `finalPlaceholder(bracketConfirmed bool, incomingTeamID, storedTeamID string,
  storedPlaceholder, incomingPlaceholder bool) bool`,
  `coalesceIntUnchanged(incoming, stored *int) bool`, `strPtrEqual(a, b *string)
  bool`, `boolPtrEqual(a, b *bool) bool` — private helpers, each mirroring one
  non-trivial column of `matchUpsertSQL`.

Four of `matchUpsertSQL`'s columns are not simple overwrites, and a plain equality
check on them would silently mask a real write in specific, real scenarios:

1. **`home_score`/`away_score`** — `COALESCE($n, match.col)`. A `nil` incoming score
   never changes what is stored, no matter what is stored. `coalesceIntUnchanged`
   returns `true` whenever the incoming value is `nil`, regardless of the stored one.
2. **`round`** — `CASE WHEN BracketConfirmed AND BracketRequired IS FALSE THEN NULL
   ELSE COALESCE(NULLIF(round,''), match.round) END`. `processMatches`' existing
   preservation block only fires when `!match.BracketConfirmed`, so a confirmed
   bracket match's round-clearing rule is untouched by it. `finalRound` reproduces
   the whole `CASE` so a confirmed bye clearing a stored round is detected as a real
   change.
3. **`winner_id`** — `CASE WHEN BracketConfirmed THEN $winner ELSE COALESCE($winner,
   match.winner_id) END`. Unlike round, this one *is* fully covered already: every
   preservation branch in `processMatches` that can leave `match.WinnerID` untouched
   only does so when `!match.BracketConfirmed`, which is exactly when SQL's
   `COALESCE` fallback applies. So by the time `matchRowUnchanged` runs,
   `identity.WinnerTeamID` already equals what SQL would compute in every case, and
   plain nil-safe equality (`strPtrEqual`) is correct — no `finalWinner` helper is
   needed, and adding one would be redundant, not just harmless.
4. **`home_placeholder`/`away_placeholder`** — `CASE WHEN NOT BracketConfirmed AND
   match.home_team_id = $team AND match.home_placeholder THEN true ELSE $incoming
   END`. Nothing in `processMatches` reconciles the incoming placeholder flag
   against the *stored* one (the merge in `runner.go`'s `mergeCandidate` only
   reconciles two candidates within the same tick, not against the database).
   `finalPlaceholder` reproduces the "true is sticky while unconfirmed" rule.

Every other compared column — `kickoff`, `state`, `home_team_id`/`away_team_id`
(via `identity.HomeTeamID`/`AwayTeamID` against `current.Home.ID`/`Away.ID`),
`minute`, `status_detail`, `status_name`, `note` (already resolved by
`processMatches`' existing `if match.Note == nil { match.Note = current.Note }`),
and `bracket_required` (already fully resolved by the existing preservation block —
traced in the design note below) — is a column `matchUpsertSQL` writes
unconditionally or one Go has already fully resolved, so direct comparison is
correct.

- [x] **Step 1: Write the failing test**

Create the table test in `backend/ingester/schedule_test.go`, appended after
`TestNeedsSummary`:

```go
func TestMatchRowUnchanged(t *testing.T) {
	kickoff := time.Date(2026, 6, 11, 18, 0, 0, 0, time.UTC)
	baseMatch := func() model.Match {
		return model.Match{
			ID: "m1", Kickoff: kickoff.Format(time.RFC3339),
			State: model.MatchStateScheduled,
			StatusDetail: "Scheduled", StatusName: "STATUS_SCHEDULED",
		}
	}
	baseCurrent := func() store.MatchRow {
		return store.MatchRow{
			State: model.MatchStateScheduled, Kickoff: kickoff,
			StatusDetail: "Scheduled", StatusName: "STATUS_SCHEDULED",
			Home: model.Team{ID: "home"}, Away: model.Team{ID: "away"},
		}
	}
	baseIdentity := store.MatchIdentity{HomeTeamID: "home", AwayTeamID: "away"}

	tests := []struct {
		name    string
		match   func() model.Match
		current func() store.MatchRow
		want    bool
	}{
		{"identical rows", baseMatch, baseCurrent, true},
		{"minute changed", func() model.Match {
			m := baseMatch()
			minute := "12"
			m.Minute = &minute
			return m
		}, baseCurrent, false},
		{"nil incoming score never overwrites a stored one", baseMatch,
			func() store.MatchRow {
				c := baseCurrent()
				home := 2
				c.HomeScore = &home
				return c
			}, true},
		{"a real incoming score that disagrees with storage is a change",
			func() model.Match {
				m := baseMatch()
				home := 3
				m.HomeScore = &home
				return m
			},
			func() store.MatchRow {
				c := baseCurrent()
				home := 2
				c.HomeScore = &home
				return c
			}, false},
		{"a confirmed bracket match clearing a stored round is a change",
			func() model.Match {
				m := baseMatch()
				required := false
				m.BracketConfirmed = true
				m.BracketRequired = &required
				return m
			},
			func() store.MatchRow {
				c := baseCurrent()
				c.Round = "quarterfinal"
				return c
			}, false},
		{"an unconfirmed sticky placeholder is not a change", baseMatch,
			func() store.MatchRow {
				c := baseCurrent()
				c.HomePlaceholder = true
				return c
			}, true},
		{"a confirmed bracket match clearing a stored winner is a change",
			func() model.Match {
				m := baseMatch()
				m.BracketConfirmed = true
				return m
			},
			func() store.MatchRow {
				c := baseCurrent()
				winner := "home"
				c.WinnerID = &winner
				return c
			}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			match := tt.match()
			current := tt.current()
			identity := baseIdentity
			identity.WinnerTeamID = match.WinnerID
			if got := matchRowUnchanged(identity, match, current); got != tt.want {
				t.Fatalf("matchRowUnchanged = %v, want %v", got, tt.want)
			}
		})
	}
}
```

- [x] **Step 2: Run it to verify it fails to compile**

```bash
cd backend && go test ./ingester/... -run TestMatchRowUnchanged
```

Expected: `undefined: matchRowUnchanged`.

- [x] **Step 3: Implement the guard and its helpers**

In `backend/ingester/schedule.go`, append after `needsSummary`:

```go
// matchRowUnchanged reports whether UpsertMatch would write anything different
// from what is already stored, so the caller can skip the statement -- the C2
// guard from
// docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
// §4.2. It MUST be called with `match` in its FINAL form: after processMatches'
// own preservation rules (round/bracket/winner/team carry-forward) have already
// run, because those rules are what decide the value a preserved round or
// winner actually carries.
//
// Every comparison mirrors matchUpsertSQL column for column, using
// IS DISTINCT FROM semantics -- nil==nil is unchanged, nil vs a value is a
// real difference -- EXCEPT the columns matchUpsertSQL itself writes with a
// COALESCE or a CASE that can reference the stored row (home_score, away_score,
// round, the two placeholders). Those get their own helper below so a nil
// incoming value SQL would coalesce away is never treated as a difference, and
// so a value SQL would compute differently from the raw payload (a cleared
// round, a cleared winner, an un-stuck placeholder) still counts as a real one.
// `source` is deliberately not compared: every write in this process carries
// the same sourceESPN constant, so it can never produce a false "unchanged".
func matchRowUnchanged(identity store.MatchIdentity, match model.Match, current store.MatchRow) bool {
	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	if err != nil {
		// resolveMatch already rejects an unparseable kickoff before this
		// point on every real call path. If one ever reaches here anyway,
		// treat it as a change rather than silently skip a write this
		// function cannot reason about.
		return false
	}
	return kickoff.Equal(current.Kickoff) &&
		match.State == current.State &&
		identity.HomeTeamID == current.Home.ID &&
		identity.AwayTeamID == current.Away.ID &&
		coalesceIntUnchanged(match.HomeScore, current.HomeScore) &&
		coalesceIntUnchanged(match.AwayScore, current.AwayScore) &&
		strPtrEqual(match.Minute, current.Minute) &&
		match.StatusDetail == current.StatusDetail &&
		match.StatusName == current.StatusName &&
		strPtrEqual(identity.WinnerTeamID, current.WinnerID) &&
		strPtrEqual(match.Note, current.Note) &&
		finalRound(match, current) == current.Round &&
		boolPtrEqual(match.BracketRequired, current.BracketRequired) &&
		finalPlaceholder(match.BracketConfirmed, identity.HomeTeamID, current.Home.ID,
			current.HomePlaceholder, match.HomePlaceholder) == current.HomePlaceholder &&
		finalPlaceholder(match.BracketConfirmed, identity.AwayTeamID, current.Away.ID,
			current.AwayPlaceholder, match.AwayPlaceholder) == current.AwayPlaceholder
}

// finalRound mirrors matchUpsertSQL's round CASE. Once a bracket match is
// confirmed with BracketRequired explicitly false, round is cleared to NULL
// regardless of what the payload carries -- a bye or a dead rubber leaving the
// bracket. Otherwise an empty incoming round falls back to whatever is already
// stored, exactly like SQL's COALESCE(NULLIF($2,''), match.round).
func finalRound(match model.Match, current store.MatchRow) string {
	if match.BracketConfirmed && match.BracketRequired != nil && !*match.BracketRequired {
		return ""
	}
	if match.Round == "" {
		return current.Round
	}
	return match.Round
}

// finalPlaceholder mirrors matchUpsertSQL's placeholder CASE. While a bracket
// match's confirmation is still pending, a placeholder flag that is already
// true and still points at the same team is sticky: the scoreboard has no way
// to prove an unresolved leg has resolved, so its silence is not evidence.
// Once the match is bracket-confirmed, the incoming flag is authoritative.
func finalPlaceholder(bracketConfirmed bool, incomingTeamID, storedTeamID string,
	storedPlaceholder, incomingPlaceholder bool) bool {
	if !bracketConfirmed && incomingTeamID == storedTeamID && storedPlaceholder {
		return true
	}
	return incomingPlaceholder
}

// coalesceIntUnchanged mirrors `COALESCE($n, match.col)`: a nil incoming score
// can never change the stored one, so it is never a difference for this guard
// even when the stored value is non-nil.
func coalesceIntUnchanged(incoming, stored *int) bool {
	return incoming == nil || (stored != nil && *incoming == *stored)
}

func strPtrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func boolPtrEqual(a, b *bool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
```

No new imports: `time`, `model` and `store` are already imported by `schedule.go`.

- [x] **Step 4: Run the table test**

```bash
cd backend && go test ./ingester/... -run TestMatchRowUnchanged -v
```

Expected: `PASS`, all seven subtests.

- [x] **Step 5: Commit**

```bash
git add backend/ingester/schedule.go backend/ingester/schedule_test.go
git commit -m "feat(ingester): add matchRowUnchanged, the C2 no-op comparison

Mirrors matchUpsertSQL column for column. Four columns aren't simple
overwrites -- home_score/away_score (COALESCE), round and the two
placeholders (CASE referencing the stored row) -- and get their own
helper so a nil incoming value SQL would coalesce away is never a
false 'changed', and a value SQL would compute differently from the
raw payload (a cleared round, an un-stuck placeholder) is never a
false 'unchanged'. winner_id needs no helper: processMatches' existing
preservation already resolves it to SQL's final value in every branch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the guard into `processMatches`

**Files:**
- Modify: `backend/ingester/matches.go`

- [x] **Step 1: Add the guard between the preservation block and the upsert**

In `backend/ingester/matches.go`, find this block (currently around lines 171–189):

```go
		// The preservation rules above can hand the match back its STORED teams
		// and winner, which are canonical too. What gets written follows the
		// match, not the provider payload that started the loop.
		identity.HomeTeamID = match.Home.ID
		identity.AwayTeamID = match.Away.ID
		identity.WinnerTeamID = match.WinnerID

		matchActive := false
		switch match.State {
		case model.MatchStateLive:
			result.live = true
			matchActive = true
		case model.MatchStateScheduled:
			matchActive = candidateIsActive(match, backfill, time.Now())
		case model.MatchStateFinished:
			matchActive = currentPtr == nil || !currentPtr.FinalizedAt.Valid
		}

		if !skipMatchUpsert {
			if err := r.repo.UpsertMatch(ctx, identity, match); err != nil {
```

Replace it with:

```go
		// The preservation rules above can hand the match back its STORED teams
		// and winner, which are canonical too. What gets written follows the
		// match, not the provider payload that started the loop.
		identity.HomeTeamID = match.Home.ID
		identity.AwayTeamID = match.Away.ID
		identity.WinnerTeamID = match.WinnerID

		// C2 guard (design doc §4.2): matchUpsertSQL is a blind UPDATE with no
		// content comparison -- 82 updates/slow-tick against a 2,578-row table,
		// ~23,616/day, almost all rewriting a scheduled fixture whose kickoff,
		// score and status had not moved. matchRowUnchanged runs on `match` in
		// its FINAL form, after every preservation rule above has already run,
		// so a preserved round or winner is compared against what it actually
		// is, not against the raw provider payload. It composes with
		// skipMatchUpsert rather than replacing it: that guard already means
		// "do not write" for a state regression, and this one only evaluates
		// once it did not fire. A match transitioning to 'finished' can never
		// satisfy this guard -- state itself is one of the compared columns --
		// so the finalization transition is never suppressed by it, and
		// FinalizeMatch's own write is unconditional regardless either way.
		noopUpsert := found && !skipMatchUpsert &&
			matchRowUnchanged(identity, match, current)

		matchActive := false
		switch match.State {
		case model.MatchStateLive:
			result.live = true
			matchActive = true
		case model.MatchStateScheduled:
			matchActive = candidateIsActive(match, backfill, time.Now())
		case model.MatchStateFinished:
			matchActive = currentPtr == nil || !currentPtr.FinalizedAt.Valid
		}

		if !skipMatchUpsert && !noopUpsert {
			if err := r.repo.UpsertMatch(ctx, identity, match); err != nil {
```

The rest of the function — the `if skipMatchUpsert { ... }` block, the finalize
checks, `needsSummary`, the crest mirroring — is unchanged. `noopUpsert` only ever
suppresses the single `r.repo.UpsertMatch` call; nothing downstream reads it.

- [x] **Step 2: Run the acceptance test from Task 1**

```bash
cd backend && go test ./ingester/... -run TestUnchangedScheduledMatchWritesOnce -v
```

Expected: `PASS`.

```
--- PASS: TestUnchangedScheduledMatchWritesOnce (0.00s)
PASS
```

- [x] **Step 3: Run the full ingester package to confirm no regression**

The existing guards (`skipMatchUpsert` for state regression, the finalized-match
`continue`, postponement/suspension transitions, the finalize-always-writes tests
around `TestFinishedMatchRetriesSummaryBeforeFinalizing`) must all still pass
unmodified — this guard must not weaken any of them.

```bash
cd backend && go test ./ingester/... -race -v 2>&1 | tail -60
```

Expected: `ok      github.com/mcasillas17/scorearc-backend/ingester`, every test
`PASS`, including `TestLiveMatchCanTransitionToPostponed`,
`TestLiveMatchCanTransitionToSuspended`, `TestFinishedMatchRetriesSummaryBeforeFinalizing`
and `TestBracketFailureKeepsBackfillRetryable`.

If any of those regress, the most likely cause is `noopUpsert` firing when it
shouldn't — re-check that it is gated on `found` (a brand-new match, `found ==
false`, must always write) and that `finalRound`/`finalPlaceholder` are being passed
`current`, not a zero-value `store.MatchRow{}`.

- [x] **Step 4: Commit**

```bash
git add backend/ingester/matches.go
git commit -m "fix(ingester): skip UpsertMatch when nothing would change

Wires matchRowUnchanged into processMatches, gated behind the existing
skipMatchUpsert state-regression guard so the two compose rather than
duplicate. Closes the reproduction in TestUnchangedScheduledMatchWritesOnce:
82 match updates/slow tick, ~23,616/day against a 2,578-row table,
almost all rewriting fixtures whose kickoff, score and status hadn't
moved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full gate and PR

**Files:** none — verification only.

- [x] **Step 1: Backend gate**

```bash
cd backend && go build ./... && go vet ./... && go test -race ./...
```

Expected: clean build, clean vet, `ok` for every package (Docker running, for the
`shared/store` testcontainers tests).

- [x] **Step 2: Frontend gate**

Nothing in `src/` changed, so this should be a fast, unsurprising pass — run it
anyway, per `AGENTS.md`'s "test locally before opening a PR" rule.

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all four green.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin tweak/match-upsert-noop-guard
gh pr create --title "fix(ingester): skip the no-op match UPDATE" --body "$(cat <<'EOF'
## Summary

`matchUpsertSQL` was a blind UPDATE: its WHERE clause enforced the finalization
and state-regression guards and then always wrote, setting `updated_at = now()`
unconditionally. Measured in production: 82 `match` updates per slow tick
against a 2,578-row table -- ~23,616 tuple writes a day, almost all rewriting a
scheduled fixture whose kickoff, score and status had not moved.

Implements §4.2 of `docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md`
(one slice of a five-way write-classification cleanup; the other four are
separate PRs):

- `MatchRow` and `ExistingMatches` gain the six columns `matchUpsertSQL` writes
  that weren't already there: kickoff, home/away score, minute, status detail,
  status name.
- `matchRowUnchanged` (ingester/schedule.go) mirrors `matchUpsertSQL` column for
  column, including its `COALESCE`/`CASE` logic for the four columns that
  aren't simple overwrites -- a plain equality check on those would have
  silently masked real writes (a confirmed bracket match clearing a round or a
  winner, an un-stuck placeholder).
- `processMatches` skips `UpsertMatch` when the guard says nothing would
  change, composed behind the existing `skipMatchUpsert` state-regression
  guard rather than replacing it.

## Why `updated_at` does not move on a skipped write

The whole statement is skipped, so there's nothing for `now()` to land in. This
is safe: `docs/superpowers/plans/2026-08-18-api-health-and-provenance.md`
(T10.10, ingest freshness) reads `ingest_run`, never `match.updated_at`, and the
`"matches"` `ingest_run` kind is already logged once per competition per cycle
regardless of how many individual matches inside that cycle actually wrote.

## Test plan

- [x] `TestUnchangedScheduledMatchWritesOnce` reproduces the bug (fails on
      `main`, passes on this branch) and is the acceptance test.
- [x] `TestMatchRowUnchanged` table-tests the guard, including the four
      COALESCE/CASE edge cases by name.
- [x] `TestExistingMatchesReturnsTheNoOpGuardColumns` proves the six new
      columns round-trip through Postgres.
- [x] Full ingester suite green, including every existing state-regression,
      postponement and finalization test -- none of them changed behavior.
- [x] `go build ./... && go vet ./... && go test -race ./...` clean.
- [x] Frontend gate green (no `src/` changes).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Stop**

Do **not** merge. Merging is the user's decision — see `AGENTS.md`.

---

## Testing

- `TestUnchangedScheduledMatchWritesOnce` (`ingester/runner_test.go`) — the
  acceptance test: two identical ticks over the same scheduled-match payload write
  once, not twice. Fails on `main` (`matchCalls == 2`), passes after Task 4.
- `TestMatchRowUnchanged` (`ingester/schedule_test.go`) — table test, no Docker,
  covering the identical-rows case and the four `COALESCE`/`CASE` edge cases:
  a nil incoming score never overwriting a stored one, a real disagreeing score
  being a change, a confirmed bracket match clearing a stored round, an unconfirmed
  sticky placeholder not being a change, and a confirmed bracket match clearing a
  stored winner.
- `TestExistingMatchesReturnsTheNoOpGuardColumns` (`shared/store/store_test.go`,
  testcontainers) — the six new `MatchRow` columns round-trip through Postgres.
- Full `go test -race ./...` from `backend/` — every existing guard test
  (state regression, postponement, suspension, finalize-retry, finalize-always-writes)
  stays green, proving the new guard composes with them instead of replacing or
  weakening any of them.

---

## Self-review notes

- **The comparison is complete against the actual `match` schema**, not just the
  design doc's list. Every column `matchUpsertSQL` writes is accounted for: eleven
  were already on `MatchRow` (`round`, `state`, both team ids via `Home.ID`/`Away.ID`,
  `winner_id`, `note`, both placeholders, `bracket_required`), six are added by this
  plan (`kickoff`, both scores, `minute`, `status_detail`, `status_name`), and one
  (`source`) is deliberately excluded with a stated reason (it never varies within a
  process, so it can never cause a false "unchanged").
- **`IS DISTINCT FROM`, not `=`, is explicit throughout.** Every pointer field is
  compared with a nil-safe helper (`strPtrEqual`, `boolPtrEqual`,
  `coalesceIntUnchanged`) rather than Go's `==` on dereferenced values, which would
  panic on `nil`.
- **The four non-trivial columns got individual analysis, not a blanket
  "reproduce the SQL" instruction.** `round` and the placeholders needed new helper
  functions because `processMatches`' existing preservation only fires when
  `!BracketConfirmed`. `winner_id` did **not** need one — traced through every
  preservation branch to show `identity.WinnerTeamID` already equals SQL's final
  value in all cases — and the plan says so explicitly, rather than adding a
  redundant `finalWinner` helper "to be safe."
- **The finalization-always-writes requirement is structural, not a runtime check.**
  `state` is one of the compared columns and a finalizing match's state always
  differs from its stored value, so `matchRowUnchanged` can never return `true` on
  that transition — and `FinalizeMatch` is a separate, unconditional statement that
  does not consult this guard at all.
- **`updated_at` semantics are decided, not left implicit**, and checked against the
  one thing that could depend on it: grepped `backend/reader` for any read of
  `match.updated_at` (none), and read the sibling ingest-freshness plan to confirm
  T10.10 is built entirely on `ingest_run`.
- **The acceptance test is a real reproduction, not a description of one.** It was
  run against pre-Task-4 code specifically to confirm the `FAIL` (matchCalls == 2)
  before any production code changed, per TDD.
