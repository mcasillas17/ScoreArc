# Ingester — Season Leaderboards Beyond Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop throwing away the assists leaderboard that arrives in the same response as
the Golden Boot, and make the table able to hold a third category without another
migration.

**Architecture:** `MapTopScorers` does `if block.Name == "goalsLeaders"` and discards the
rest of the `stats` array. Verified in the repo's own recorded fixture,
`backend/shared/espn/testdata/espn-statistics.json`: that array contains
`goalsLeaders` **and** `assistsLeaders`, **50 rows each**. This generalises the mapper to
`MapLeaders(raw, category, limit)`, adds a `category` column to `top_scorer`, and writes
both boards from the one fetch already being made. **No new endpoint, no new request.**

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-assists-and-box-score-design.md` (E1 — the
TypeScript half of the identical change)
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Task: T7.8** (new — add under E7)
**Branch:** `feat/ingester-season-leaders`

---

## Parity with E1, which is the whole reason this is worth care

E1's T1.1 makes exactly this change on the frontend: `TopScorer` becomes `StatLeader` with
`goals` generalised to `value`, and `mapTopScorers` becomes
`mapLeaders(raw, category, limit)`. This plan is the Go half.

The two must agree on the category vocabulary — `goalsLeaders`, `assistsLeaders` — for the
same reason the own-goal rule must: once `DATA_SOURCE=api` flips in slice 1d, the same
competition would otherwise report a different assists board depending on which path served
it. **If E1 has already landed, read `src/server/data/providers/espn-stats.ts` first and
match its category strings exactly.**

---

## ⚠️ Merge order and migration numbering

Adds migration **`0010_leader_category`**. Prerequisites, in order:
`feat/canonical-identity-impl` → `feat/player-identity` → T7.1 (`0004`) → T7.6 (`0005`)
→ T7.7 (`0006`) → T7.12 (`0007`) → T7.14/T7.15 (`0008`, `0009`).

```bash
ls backend/migrations/
```

Expected: `0001` … `0009_odds_snapshot.*`. If any are missing, take the next free number
and adjust every filename and test reference in this plan consistently.

**This plan changes a table the reader already serves.** `top_scorer` is read by
`reader/store.go` and returned as `TopScorer[]`. Task 3 updates that query. Do not skip it:
without the `WHERE category = 'goals'` filter the Golden Boot page silently gains fifty
assists rows interleaved by rank.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, confirmed failing for the stated reason.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN`, `INGESTER_LEASE_DSN`. Secrets via `fly secrets`.
- `top_scorer` already has a `DELETE` grant (0001), which the wholesale replacement needs.
  **Do not add another**, and do not widen it.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/migrations/0010_leader_category.{up,down}.sql`
- `backend/migrations/migrations_test.go`
- `backend/shared/model/types.go` — `StatLeader`.
- `backend/shared/espn/stats.go` — `MapLeaders` replaces `MapTopScorers`.
- `backend/shared/espn/stats_test.go`
- `backend/shared/espn/types.go` — the alias.
- `backend/shared/source/{source,espn}.go` — `Leaders(ctx, comp, season, category, limit)`.
- `backend/shared/store/competitions.go` — `ReplaceLeaders` replaces `ReplaceTopScorers`.
- `backend/shared/store/store_test.go`, `*_integration_test.go`
- `backend/ingester/{contracts,runner,runner_test}.go`
- `backend/reader/store.go` — the `WHERE category = 'goals'` filter.
- `docs/backend/ARCHITECTURE.md`

---

### Task 1: A `category` column, not a second table

**Files:**
- Create: `backend/migrations/0010_leader_category.{up,down}.sql`
- Test: `backend/migrations/migrations_test.go`

**Why a column and not a `top_assist` table.** A sibling table duplicates seven columns,
two indexes, one grant and one replacement transaction to express "the same thing, counted
differently" — and it forces a third table the day ESPN's `cleanSheetsLeaders` becomes
interesting. One `category` column in the primary key costs one migration and no new code
path.

- [ ] **Step 1: Write the failing migration test**

Append to `backend/migrations/migrations_test.go`:

```go
// assistsLeaders arrives in the SAME /statistics response as goalsLeaders --
// 50 rows each in the repo's own recorded fixture -- and MapTopScorers threw it
// away. A category column costs one migration; a sibling top_assist table costs
// seven duplicated columns and a third table the day cleanSheetsLeaders matters.
func TestLeaderCategoryIsPartOfTheKey(t *testing.T) {
	sql := readMigration(t, "0010_leader_category.up.sql")
	for _, required := range []string{
		"ALTER TABLE top_scorer",
		"ADD COLUMN category text NOT NULL DEFAULT 'goals'",
		"DROP CONSTRAINT top_scorer_pkey",
		"PRIMARY KEY (competition_id, season_id, category, rank)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0010_leader_category.up.sql missing %q", required)
		}
	}
}

func TestLeaderCategoryRollbackRestoresTheOldKey(t *testing.T) {
	sql := readMigration(t, "0010_leader_category.down.sql")
	for _, required := range []string{
		"DELETE FROM top_scorer WHERE category <> 'goals'",
		"PRIMARY KEY (competition_id, season_id, rank)",
		"DROP COLUMN IF EXISTS category",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./migrations/ -run LeaderCategory
```

Expected: FAIL — `open 0010_leader_category.up.sql: no such file or directory`.

- [ ] **Step 3: Write the migrations**

Create `backend/migrations/0010_leader_category.up.sql`:

```sql
-- top_scorer becomes a leaderboard table rather than a goals table.
--
-- assistsLeaders ships in the SAME /statistics response the ingester already
-- fetches for the Golden Boot -- 50 rows each, verified in the repo's own
-- shared/espn/testdata/espn-statistics.json -- and MapTopScorers discarded it
-- with `if block.Name == "goalsLeaders"`.
--
-- The table keeps its name. Renaming it to `season_leader` would be tidier and
-- would also rewrite the reader's query, its OpenAPI schema and its integration
-- fixtures for zero behavioural gain. The column carries the meaning; the name
-- is just a name, and a rename is a separate, optional change.
--
-- DEFAULT 'goals' on the new column is what makes this migration safe against
-- existing rows: every row already in the table IS a goals row.
ALTER TABLE top_scorer
  ADD COLUMN category text NOT NULL DEFAULT 'goals';

-- The rank is only unique WITHIN a category: rank 1 for goals and rank 1 for
-- assists are different players. Without category in the key the second board
-- would silently overwrite the first, one row at a time, with no error.
ALTER TABLE top_scorer DROP CONSTRAINT top_scorer_pkey;
ALTER TABLE top_scorer
  ADD CONSTRAINT top_scorer_pkey
  PRIMARY KEY (competition_id, season_id, category, rank);
```

Create `backend/migrations/0010_leader_category.down.sql`:

```sql
-- Rolling back means the old primary key comes back, and it cannot hold two
-- boards. The non-goals rows are dropped FIRST and deliberately: leaving them
-- would make the ADD CONSTRAINT fail on a duplicate rank, and the failure would
-- arrive as an opaque 23505 in the middle of a rollback.
--
-- Nothing is lost that cannot be re-fetched: /statistics returns the current
-- season's boards on every request, unlike a standings snapshot.
DELETE FROM top_scorer WHERE category <> 'goals';
ALTER TABLE top_scorer DROP CONSTRAINT top_scorer_pkey;
ALTER TABLE top_scorer
  ADD CONSTRAINT top_scorer_pkey
  PRIMARY KEY (competition_id, season_id, rank);
ALTER TABLE top_scorer DROP COLUMN IF EXISTS category;
```

- [ ] **Step 4: Run and prove it applies**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0010_leader_category.*.sql backend/migrations/migrations_test.go
git commit -m "feat: make top_scorer hold any leader category

assistsLeaders ships in the same /statistics response as goalsLeaders --
50 rows each in our own recorded fixture -- and the mapper threw it away.

category joins the primary key because rank is only unique within a
board: without it the assists table would overwrite the goals table one
row at a time, with no error anywhere.

DEFAULT 'goals' makes the migration safe against existing rows, which are
all goals rows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `MapLeaders`

**Files:**
- Modify: `backend/shared/model/types.go`, `backend/shared/espn/types.go`,
  `backend/shared/espn/stats.go`
- Test: `backend/shared/espn/stats_test.go`

**Interfaces:**
- `model.StatLeader` — `{Rank int; Player, TeamAbbr, TeamName string; TeamCrestURL *string; Value int; Matches *int}`.
  Mirrors E1's TypeScript `StatLeader` field for field.
- `func MapLeaders(raw []byte, category string, limit int) ([]model.StatLeader, error)`
  — `category` is an ESPN `stats[].name`.

- [ ] **Step 1: Write the failing test**

Replace the body of the existing `MapTopScorers` tests in
`backend/shared/espn/stats_test.go` and append:

```go
// The point of the generalisation, against the fixture already in the repo.
func TestMapLeadersReadsBothBoardsFromOneResponse(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-statistics.json")
	if err != nil {
		t.Fatal(err)
	}
	goals, err := MapLeaders(raw, "goalsLeaders", 50)
	if err != nil {
		t.Fatal(err)
	}
	assists, err := MapLeaders(raw, "assistsLeaders", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(goals) != 50 {
		t.Fatalf("goals = %d, want 50", len(goals))
	}
	if len(assists) != 50 {
		t.Fatalf("assists = %d, want 50 -- this board was in the payload all along",
			len(assists))
	}
	// Ranks are per board. Both start at 1, and that is exactly why category
	// had to join the primary key.
	if goals[0].Rank != 1 || assists[0].Rank != 1 {
		t.Fatalf("ranks = %d/%d, want 1 and 1", goals[0].Rank, assists[0].Rank)
	}
}

// A category ESPN does not publish for this competition is an empty board, not
// an error. Coverage varies, and a hard failure here would take down the whole
// competition's ingest over a leaderboard nobody asked for.
func TestMapLeadersReturnsEmptyForAnAbsentCategory(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-statistics.json")
	if err != nil {
		t.Fatal(err)
	}
	board, err := MapLeaders(raw, "cleanSheetsLeaders", 20)
	if err != nil {
		t.Fatalf("an absent category must not be an error: %v", err)
	}
	if len(board) != 0 {
		t.Fatalf("board = %d, want 0", len(board))
	}
}

// The validation MapTopScorers already had must survive the generalisation: a
// leaderboard row with no player, or a fractional count, is a payload we do not
// understand and publishing it would put a wrong number on the front page.
func TestMapLeadersStillRejectsAnImpossibleRow(t *testing.T) {
	raw := []byte(`{"stats":[{"name":"goalsLeaders","leaders":[
	  {"value":1.5,"displayValue":"Matches: 3","athlete":{"displayName":"Striker","team":{}}}]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 20); err == nil {
		t.Fatal("want an error for a fractional goal count")
	}
	raw = []byte(`{"stats":[{"name":"goalsLeaders","leaders":[
	  {"value":3,"displayValue":"Matches: 3","athlete":{"team":{}}}]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 20); err == nil {
		t.Fatal("want an error for a row with no player identity")
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/espn/ -run MapLeaders
```

Expected: FAIL to compile — `undefined: MapLeaders`.

- [ ] **Step 3: Add `StatLeader` and rewrite the mapper**

In `backend/shared/model/types.go`, add beside `TopScorer`:

```go
// StatLeader is one row of any season leaderboard.
//
// It mirrors the TypeScript StatLeader that E1 introduces in
// src/server/data/types.ts, field for field. The metric-specific `Goals` on
// TopScorer becomes `Value`, because a field called Goals holding an assist
// count is a lie that every reader of this struct then has to remember.
//
// TopScorer stays for now: it is the shape the reader serializes today, and
// removing it belongs to slice 1d's cutover, not here.
type StatLeader struct {
	Rank         int     `json:"rank"`
	Player       string  `json:"player"`
	TeamAbbr     string  `json:"teamAbbr"`
	TeamName     string  `json:"teamName"`
	TeamCrestURL *string `json:"teamCrestUrl"`
	Value        int     `json:"value"`
	Matches      *int    `json:"matches"`
}
```

Add `type StatLeader = model.StatLeader` to `backend/shared/espn/types.go`.

In `backend/shared/espn/stats.go`, replace `MapTopScorers` with:

```go
// MapLeaders maps one board out of ESPN's /statistics response.
//
// category is an entry in stats[].name: "goalsLeaders", "assistsLeaders". The
// old MapTopScorers hardcoded the first of those and discarded the rest of the
// array -- including assistsLeaders, which arrives in the SAME response with
// the same 50 rows. Generalising costs one parameter.
//
// An absent category returns an empty board rather than an error. Coverage
// varies by competition, and failing here would take the whole competition's
// ingest down over a leaderboard nobody requested.
func MapLeaders(raw []byte, category string, limit int) ([]StatLeader, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	stats, exists := envelope["stats"]
	if !exists || string(stats) == "null" {
		return []StatLeader{}, nil
	}
	if err := validateArrayEnvelope(raw, "stats"); err != nil {
		return nil, err
	}
	var doc rawStatistics
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	var leaders []rawLeader
	for _, block := range doc.Stats {
		if block.Name == category {
			leaders = block.Leaders
			break
		}
	}
	if limit >= 0 && len(leaders) > limit {
		leaders = leaders[:limit]
	}

	board := make([]StatLeader, 0, len(leaders))
	for i, l := range leaders {
		team := l.Athlete.Team
		// The two validations MapTopScorers already had, kept verbatim: a
		// leaderboard is the most visible number on the site, and a row we do
		// not understand must not be published as if we did.
		if l.Athlete.DisplayName == "" {
			return nil, fmt.Errorf("%s row %d missing player identity", category, i)
		}
		if l.Value < 0 || math.Trunc(l.Value) != l.Value {
			return nil, fmt.Errorf("%s row %d has an invalid count", category, i)
		}

		var crest *string
		if team.Logo != nil && *team.Logo != "" {
			crest = team.Logo
		} else if len(team.Logos) > 0 && team.Logos[0].Href != "" {
			href := team.Logos[0].Href
			crest = &href
		}
		board = append(board, StatLeader{
			Rank:         i + 1,
			Player:       l.Athlete.DisplayName,
			TeamAbbr:     team.Abbreviation,
			TeamName:     team.DisplayName,
			TeamCrestURL: crest,
			Value:        int(l.Value),
			Matches:      parseMatches(l.DisplayValue),
		})
	}
	return board, nil
}
```

`parseMatches` is unchanged. Note it parses `Matches:` out of the `displayValue`, which is
`"Matches: 4, Goals: 6"` for goals and `"Matches: 4, Assists: 2"` for assists — the prefix
it keys on is the same in both, so no change is needed. **Confirm that against the recorded
fixture rather than trusting this sentence:**

```bash
cd backend && node -e "
const d = require('./shared/espn/testdata/espn-statistics.json');
for (const name of ['goalsLeaders','assistsLeaders']) {
  const b = d.stats.find(s => s.name === name);
  console.log(name, '->', JSON.stringify(b.leaders[0].displayValue));
}"
```

Expected: both print a string beginning `"Matches: `. If the assists board uses a different
prefix, `parseMatches` needs a second pattern and this plan understated the work — say so.

- [ ] **Step 4: Run**

```bash
cd backend && go test ./shared/espn/ -run "MapLeaders|MapTopScorers" -v
```

Expected: the three new cases pass. The old `MapTopScorers` cases will not compile until
they are renamed to call `MapLeaders(raw, "goalsLeaders", …)` and read `.Value` instead of
`.Goals` — do that rather than keeping a shim, since there is exactly one production caller.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/model/types.go backend/shared/espn/types.go \
        backend/shared/espn/stats.go backend/shared/espn/stats_test.go
git commit -m "feat: generalise the leaders mapper beyond goals

MapTopScorers hardcoded goalsLeaders and discarded the rest of the stats
array, including assistsLeaders -- same response, same 50 rows.

Value replaces Goals on the row type: a field called Goals holding an
assist count is a lie every later reader has to remember. Mirrors the
StatLeader shape E1 introduces on the TypeScript side, because once
DATA_SOURCE flips the two paths must agree.

An absent category is an empty board, not an error: coverage varies by
competition and failing would take a whole ingest down over a leaderboard
nobody asked for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Write both boards, and stop the reader serving them together

**Files:**
- Modify: `backend/shared/store/competitions.go`, `backend/shared/source/{source,espn}.go`,
  `backend/ingester/{contracts,runner,runner_test}.go`, `backend/reader/store.go`

**Interfaces:**
- `func (s *Store) ReplaceLeaders(ctx context.Context, competitionID, seasonID, source, category string, leaders []model.StatLeader) error`
  — replaces `ReplaceTopScorers`; the `DELETE` is now scoped by category.
- `Source.Leaders(ctx, comp, season, category string, limit int) ([]model.StatLeader, error)`
  — replaces `TopScorers`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/shared/store/store_test.go` (or the relevant integration file):

```go
// The failure this test exists to prevent: a category-blind DELETE that wipes
// the goals board every time the assists board is written, leaving whichever
// ran last.
func TestReplaceLeadersDoesNotWipeTheOtherBoard(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedSeason(t, pool)

	goals := []model.StatLeader{{Rank: 1, Player: "Striker", Value: 12}}
	assists := []model.StatLeader{{Rank: 1, Player: "Playmaker", Value: 9}}
	if err := store.ReplaceLeaders(ctx, "premier-league", "2026-27", "espn", "goals", goals); err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceLeaders(ctx, "premier-league", "2026-27", "espn", "assists", assists); err != nil {
		t.Fatal(err)
	}

	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM top_scorer`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("rows = %d after writing two boards, want 2 -- the DELETE is not scoped by category", rows)
	}
	var player string
	if err := pool.QueryRow(ctx,
		`SELECT player FROM top_scorer WHERE category='goals' AND rank=1`).Scan(&player); err != nil {
		t.Fatal(err)
	}
	if player != "Striker" {
		t.Fatalf("goals rank 1 = %q, want Striker", player)
	}
}

// The reader's contract does not change: /top-scorers is still goals.
func TestReaderTopScorersFiltersToGoals(t *testing.T) {
	// … arrange both boards, call the reader's top-scorers query, assert it
	// returns exactly the goals rows and none of the assists rows.
}
```

Append to `backend/ingester/runner_test.go`:

```go
// One fetch, two boards. Fetching /statistics twice would double the request
// count for a payload that already contains both.
func TestRefreshLeadersFetchesOnceAndWritesBoth(t *testing.T) {
	repo := &fakeRepository{}
	source := &fakeSource{}
	newTestRunnerWithSource(repo, source).runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if source.statisticsCalls != 1 {
		t.Fatalf("/statistics fetched %d times, want 1", source.statisticsCalls)
	}
	if len(repo.leaderCategories) != 2 {
		t.Fatalf("categories written = %v, want goals and assists", repo.leaderCategories)
	}
}

// An empty assists board must not take down the goals board. ErrEmptyReplacement
// is already the "preserve what we have" signal for top scorers; it stays that,
// per category.
func TestEmptyAssistsBoardDoesNotFailTheCycle(t *testing.T) {
	repo := &fakeRepository{}
	source := &fakeSource{emptyAssists: true}
	worker := newTestRunnerWithSource(repo, source)
	if result := worker.runCycle(context.Background(), true); result.failures != 0 {
		t.Fatalf("failures = %d, want 0 -- an absent assists board is normal", result.failures)
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/store/ ./ingester/ -run "Leaders"
```

Expected: FAIL to compile — `store.ReplaceLeaders undefined`.

- [ ] **Step 3: Implement**

In `backend/shared/store/competitions.go`, replace `ReplaceTopScorers` with
`ReplaceLeaders`. The only substantive changes are the extra `category` parameter, the
`category` column in the `INSERT`, and — the line the test above exists for — the `DELETE`:

```go
	if _, err := tx.Exec(ctx,
		// Scoped by category. A category-blind DELETE here would wipe the goals
		// board every time the assists board is written, leaving whichever ran
		// last, with no error and a silently half-empty page.
		`DELETE FROM top_scorer WHERE competition_id=$1 AND season_id=$2 AND category=$3`,
		competitionID, seasonID, category); err != nil {
		return err
	}
```

In `backend/shared/source/espn.go`, replace `TopScorers` with `Leaders`, passing `category`
through to `espn.MapLeaders`. The `/statistics` URL is unchanged, and `e.get` already
de-duplicates concurrent identical fetches through its `singleflight` group — so two
`Leaders` calls in the same cycle cost **one** HTTP request. Verify that rather than assume
it: the singleflight cache in `source/espn.go` currently keys only `/scoreboard` URLs, so
extend it to `/statistics` or fetch once and map twice in the runner. **Fetch once and map
twice is simpler and is what `TestRefreshLeadersFetchesOnceAndWritesBoth` asserts.**

In `backend/ingester/runner.go`, replace `refreshTopScorers` with:

```go
// leaderCategories are the boards written from each /statistics response.
//
// ESPN's names on the left, ours on the right. Ours are what goes in the
// database and what the reader's ?category= will eventually accept, so they are
// short and provider-neutral -- if a second source ever supplies leaderboards,
// only this map changes.
var leaderCategories = map[string]string{
	"goalsLeaders":   "goals",
	"assistsLeaders": "assists",
}

func (r *runner) refreshLeaders(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	start := time.Now()
	// Both boards come out of ONE response. Fetching per category would double
	// the request count for a payload that already contains both.
	raw, err := r.source.Statistics(ctx, comp, season)
	if err != nil {
		r.recordRun(ctx, comp.ID, "leaders_fetch", start, err)
		return err
	}
	var errs []error
	for espnName, category := range leaderCategories {
		board, mapErr := espn.MapLeaders(raw, espnName, topScorerLimit)
		if mapErr != nil {
			errs = append(errs, fmt.Errorf("%s: %w", category, mapErr))
			continue
		}
		writeErr := r.repo.ReplaceLeaders(ctx, comp.ID, season.ID, sourceESPN, category, board)
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
			if err := r.repo.ReplaceLeaders(ctx, comp.ID, season.ID, sourceESPN,
				category, mirrored); err != nil {
				errs = append(errs, fmt.Errorf("%s crests: %w", category, err))
			}
		}
	}
	joined := errors.Join(errs...)
	r.recordRun(ctx, comp.ID, "leaders", start, joined)
	return joined
}
```

`mirrorLeaders` and `leaderCrestsChanged` are `mirrorTopScorers` and
`topScorerCrestsChanged` retyped onto `StatLeader`; the mirroring logic is unchanged.
`Source.Statistics(ctx, comp, season) ([]byte, error)` is the raw fetch that replaces
`TopScorers` — it returns bytes precisely so one response can feed two mappers.

In `backend/reader/store.go`, add the filter to the top-scorers query:

```sql
WHERE competition_id = $1 AND season_id = $2 AND category = 'goals'
```

**This is not optional.** Without it, `/v1/competitions/{comp}/{season}/top-scorers`
returns 100 rows — both boards interleaved by rank — and the Golden Boot table shows
assists totals as goals.

- [ ] **Step 4: Run the whole suite**

```bash
cd backend && go test -race ./...
```

Expected: every package `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/store/competitions.go backend/shared/source/source.go \
        backend/shared/source/espn.go backend/ingester/contracts.go \
        backend/ingester/runner.go backend/ingester/runner_test.go \
        backend/reader/store.go backend/shared/store/store_test.go
git commit -m "feat: write the assists board alongside the Golden Boot

One /statistics fetch, two mappers, two categories. Fetching per category
would double the request count for a payload that already carries both.

The replacement DELETE is scoped by category -- without that, writing the
assists board wipes the goals board one row at a time with no error, and
the page silently shows whichever ran last.

The reader gains WHERE category = 'goals' so /top-scorers keeps its
existing contract instead of returning both boards interleaved by rank.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Doc, gate and PR

- [ ] **Step 1: Update the architecture doc**

In `docs/backend/ARCHITECTURE.md`, replace the `top_scorer` bullet:

```markdown
- **top_scorer**(PK (competition_id, season_id, **category**, rank), player, team_abbr, team_name, team_crest_url, goals, matches, source) — any season leaderboard, not only goals. `category` is `goals` | `assists`, both written from a **single** `/statistics` fetch (T7.8): `assistsLeaders` ships in the same response as `goalsLeaders`, 50 rows each, and was previously discarded. `category` is in the primary key because rank is only unique within a board. The reader's `/top-scorers` filters `category = 'goals'` to keep its existing contract. Team is denormalized (ESPN's stats give abbr/name/crest, no id). The table keeps its name deliberately — renaming it to `season_leader` would rewrite the reader's query, its OpenAPI schema and its fixtures for no behavioural gain.
```

- [ ] **Step 2: Full gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok`, vet silent.

- [ ] **Step 3: Prove it end to end**

```bash
cd backend
docker run -d --name scorearc-leaders -e POSTGRES_PASSWORD=postgres -p 55436:5432 postgres:16-alpine
sleep 5
for f in migrations/*.up.sql; do docker exec -i scorearc-leaders psql -U postgres -q < "$f"; done
docker exec -i scorearc-leaders psql -U postgres -q <<'SQL'
CREATE ROLE ingest_local LOGIN PASSWORD 'ingest_local';
GRANT ingest_local TO postgres;
GRANT scorearc_ingester TO ingest_local;
GRANT USAGE ON SCHEMA public TO ingest_local;
SQL
export POOLED_DSN='postgres://ingest_local:ingest_local@localhost:55436/postgres?sslmode=disable'
export INGESTER_LEASE_DSN="$POOLED_DSN"
go run ./ingester -once
go run ./ingester -once
docker exec -i scorearc-leaders psql -U postgres -q -c \
  "SELECT competition_id, category, count(*) FROM top_scorer GROUP BY 1,2 ORDER BY 1,2;"
docker rm -f scorearc-leaders
```

Expected: two rows per competition, `goals` and `assists`, each capped at
`topScorerLimit` (30). **Run twice on purpose** — if the second run leaves only one
category per competition, the `DELETE` is not scoped and Task 3's fix did not land.

- [ ] **Step 4: Open the PR**

```bash
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: top_scorer holds any leader category now

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/ingester-season-leaders
gh pr create --title "feat: persist the assists leaderboard that was already in the payload (T7.8)" --body "$(cat <<'EOF'
## What

`assistsLeaders` ships in the **same** `/statistics` response the ingester already fetches
for the Golden Boot — **50 rows each**, verified in the repo's own recorded fixture
`shared/espn/testdata/espn-statistics.json` — and `MapTopScorers` discarded it with
`if block.Name == "goalsLeaders"`.

No new endpoint. No new request. One fetch, two mappers.

## Design decisions

- **A `category` column, not a `top_assist` table.** A sibling table duplicates seven
  columns, two indexes, a grant and a replacement transaction to express "the same thing,
  counted differently", and forces a third table the day `cleanSheetsLeaders` matters.
- **`category` is in the primary key.** Rank is only unique within a board — goals rank 1
  and assists rank 1 are different players. Without it the second board overwrites the first
  one row at a time, with no error.
- **The replacement `DELETE` is scoped by category.** This is the failure mode the plan's
  first store test exists for, and the end-to-end check runs the ingester **twice** to catch
  it.
- **The table keeps its name.** `season_leader` would be tidier and would also rewrite the
  reader's query, its OpenAPI schema and its integration fixtures for zero behavioural gain.
- **`Value`, not `Goals`, on the row type.** A field called `Goals` holding an assist count
  is a lie every later reader has to remember.
- **The reader gains `WHERE category = 'goals'`** so `/top-scorers` keeps its existing
  contract instead of returning 100 rows interleaved by rank.

## Parity with E1

E1's T1.1 makes the identical change on the frontend (`TopScorer` → `StatLeader`,
`mapTopScorers` → `mapLeaders`). The category vocabulary must match, for the same reason the
own-goal rule must: once `DATA_SOURCE=api` flips in slice 1d, a mismatch means the same
competition reports a different assists board depending on which path served it.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Fixture-backed: both boards at 50 rows each, both ranked from 1; an absent category
  returning an empty board rather than an error; the existing row validations preserved.
- Real Postgres: writing the assists board does not wipe the goals board.
- `go run ./ingester -once` twice against a scratch Postgres as the least-privilege login:
  both categories survive the second run.

Plan: `docs/superpowers/plans/2026-08-15-ingester-season-leaders.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **The one bug this plan is really about.** A `DELETE` that forgets `category`. It is
  asserted in a store integration test (Task 3 Step 1), guarded by a comment at the SQL
  itself (Step 3), and caught by running the ingester twice in the end-to-end check
  (Task 4 Step 3). One of those would be a hope; three is a rule.
- **Naming consistency.** ESPN's `goalsLeaders`/`assistsLeaders` appear only in
  `leaderCategories` (Task 3 Step 3); everything downstream uses `goals`/`assists`. That
  boundary is the single place a second provider's vocabulary would be mapped.
- **Ordering hazard.** Task 2 removes `MapTopScorers`. Every existing test in
  `stats_test.go` calls it and reads `.Goals`; they must be migrated in the same commit, not
  shimmed. There is exactly one production caller, so a compatibility wrapper would only be
  there to avoid touching tests.
- **The unverified assumption, flagged.** `parseMatches` keys on a `Matches: ` prefix in
  `displayValue`. Task 2 Step 3 includes a command to confirm the assists board uses the same
  prefix. If it does not, this plan understated the work — report it rather than adding a
  regex nobody asked for.
</content>
