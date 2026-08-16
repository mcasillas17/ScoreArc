# Reader API — Stat Leaders and Per-Match Box Scores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the two datasets E1 proved we already fetch and then discard — the second half of ESPN's `/statistics` payload (fifty assist leaders sitting beside the fifty goal leaders we keep) and the per-player, per-match `stats[]` arrays inside `rosters[].roster[]`. Today the reader can answer "who has the most goals" and nothing else about a player. After this slice it answers "who has the most assists" through the same generalised leaderboard, and "what did each of these twenty-two players actually do in this match" through a new box score.

**Architecture:** `top_scorer` is a leaderboard row that happens to call its metric `goals`. It becomes `stat_leader` — same rows, same grants, a `metric` discriminator in the primary key — via `ALTER TABLE ... RENAME`, so no data moves and the rollback is exact. `Store.TopScorers` is replaced by `Store.Leaders(comp, season, metric, limit)`; the frozen `/top-scorers` path becomes a thin handler-level projection of `metric=goals` back onto the existing `TopScorer` shape. A new `match_player_stat` table holds one row per player per match with a `jsonb` stat bag, because the stat set genuinely varies by position and a fixed column list would have to invent a zero for every stat a position does not produce.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-15-assists-and-box-score-design.md`
**Epic:** E1 in `docs/PRODUCT_ROADMAP.md` — this is the backend half of **T1.1**, **T1.2** and **T1.3**
**New roadmap task:** **T9.2** (Epic **E9 · Public API read surface**)
**Branch:** `feat/api-leaders-and-box-scores` off latest `origin/main`

## Global Constraints

- **Task 1 has a blocking coordination note. Read it before starting anything.**
  The concurrent `2026-08-15-ingester-*.md` plans reserve migrations that model
  these same two datasets under a different schema, and which shape survives is
  the user's call, not this plan's.
- **`docs/superpowers/plans/2026-08-15-api-match-reads.md` (T9.1) must land first.** This plan appends to the `backend/reader/params.go` that T9.1 creates and calls its `parseLimit` and `parseEntityID`. Do not start until `params.go` exists on `origin/main`.
- Extend the existing layering. Routes register in `App.router()`; handlers live in `handlers.go` or a sibling `handlers_*.go`; SQL lives in `store.go` or a sibling `store_*.go`; the `readerStore` interface in `server.go` is the seam and `fakeReaderStore` in `server_test.go` implements it. **Adding or changing a store method means editing all three.**
- **No string-built SQL.** Every value is a pgx placeholder, including `metric` and `LIMIT`.
- **Reject, never silently fall back.** `?metric=shots` is a 400, not a quiet substitution of goals.
- **400 messages are built only from string constants in our own code.** Never `err.Error()` on a dependency error — `TestDependencyErrorsAreSanitized` exists because that leak class is real. Errors returned from `params.go` are constants declared there and are safe to echo.
- **A dash is not a zero.** Every per-player stat field is `*float64`. A goalkeeper who has no `offsides` entry gets `null`, never `0`. Inventing a zero here is the same defect class as E0's alphabetical champion: a confident answer to a question the provider did not answer.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go` enforces: every object schema's `required` list equals its full property list, every object schema sets `additionalProperties: false`, every `GET` documents 200/405/500 (+429 off `/healthz`), and every response — 200 and error alike — declares a `Cache-Control` header. Because `required` must list every property, **no response struct may use `omitempty`**.
- Rate limiting is unchanged: `a.rateLimit` is router-level middleware and both new routes inherit the 10 rps / burst 30 per-IP token bucket automatically. Only `/healthz` is exempt. **One request costs one token regardless of how much it returns**, which is exactly why the leader cap below is enforced server-side and not left to the caller — a caller who wants a thousand rows pays the same one token as a caller who wants ten.
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`, `go test -race ./...`. **Docker must be running** — the reader's store and migration tests use testcontainers.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Ingester prerequisites

This plan builds the read path only. Every endpoint here returns an empty board
or a `404` until the ingester writes the rows. The write-path plans are being
authored separately; these are the contracts they must satisfy.

1. **`stat_leader` rows for `metric='assists'` as well as `metric='goals'`, from
   one `/statistics` fetch.** ESPN returns `goalsLeaders` and `assistsLeaders` as
   two entries of the *same* `stats[]` array in the *same* response — verified
   live 2026-08-15 against `soccer/mex.1/statistics`, 50 leaders each. The spec is
   emphatic that assists must not become a second upstream request. One fetch,
   two categories, two sets of rows keyed by `metric`. Ranks restart at 1 per
   metric, which is why `metric` sits inside the primary key.
2. **One `match_player_stat` row per player per match**, sourced from
   `rosters[].roster[].stats`. The stat set **varies by position**: goalkeepers
   carry `saves`, `shotsFaced` and `goalsConceded` and omit `offsides`;
   outfielders carry `offsides` and omit `saves`. The mapper must therefore look
   each stat up **by its `name`**, never by array index, and must omit a key
   entirely rather than writing `0` when ESPN did not send it. `player_id` is
   ESPN's athlete id and is the only stable join key we get; `player` is the
   display name and is not unique.
3. **Do not persist `shotAccuracy`.** ESPN sends it pre-rounded (`30` where the
   raw counts are 3-of-11). The reader recomputes it from the raw numerator and
   denominator on every read. If the ingester writes it anyway the reader
   overwrites it, which is deliberate belt-and-braces — see Task 3.

## What is capped, and to what

| Input | Rule | Failure |
|---|---|---|
| `?metric=` | `goals` \| `assists`; absent means `goals` | 400 |
| `?limit=` on `/leaders` | integer `1..100`; absent means **50** | 400 |
| `{id}` on `/box-score` | `^[A-Za-z0-9._-]{1,64}$` (`parseEntityID`) | 400 |
| `/top-scorers` | no parameters; always `metric=goals`, 50 rows | — |
| `/box-score` row count | a match has at most ~40 players across both squads — **data, not user input** | — |

The leader default is 50 because that is exactly what ESPN publishes per
category; asking for more cannot return more, so a larger default would only
inflate the response for nothing. The cap of 100 leaves room for a provider that
publishes a longer board later without letting a caller ask for the table.

---

## File Structure

- `backend/migrations/0005_stat_leaders_and_box_scores.up.sql` — **new.**
- `backend/migrations/0005_stat_leaders_and_box_scores.down.sql` — **new.**
- `backend/migrations/migrations_test.go` — one assertion that 0005 renames rather than recreates.
- `backend/reader/migrations_integration_test.go` — 0005 appended to both halves of the round-trip list.
- `backend/reader/params.go` — `parseMetric`, `maxLeaderLimit`, `defaultLeaderLimit`.
- `backend/reader/params_test.go` — table cases for `parseMetric`.
- `backend/reader/types.go` — `StatLeader`, `PlayerMatchStats`, `PlayerBoxScore`, `TeamBoxScore`, `BoxScore`, `derivePlayerStats`.
- `backend/reader/types_test.go` — **new.** `derivePlayerStats` unit tests, no Docker.
- `backend/reader/store.go` — `Leaders` replaces `TopScorers`.
- `backend/reader/store_boxscore.go` — **new.** `BoxScore`, `ErrBoxScoreUnavailable`.
- `backend/reader/handlers.go` — `handleTopScorers` reprojected onto `Leaders`.
- `backend/reader/handlers_leaders.go` — **new.** `handleLeaders`.
- `backend/reader/handlers_boxscore.go` — **new.** `handleBoxScore`.
- `backend/reader/server.go` — interface change, two new routes.
- `backend/reader/server_test.go` — fake follows the interface; handler coverage.
- `backend/reader/store_integration_test.go` — seed moves to `stat_leader`, gains `match_player_stat`.
- `backend/reader/openapi.yaml` — two parameters, two paths, five schemas.
- `backend/reader/openapi_test.go` — two rows in the route table.
- `backend/reader/README.md` — the parameter table gains `metric`.

---

### Task 1: Migration 0005 — rename the leaderboard, add the box score table

> **STOP. Read this before writing a single file.**
>
> **Migration numbers are first-come, and `0005` is already claimed on paper.** A
> sibling agent authored the `2026-08-15-ingester-*.md` plans concurrently with
> this one, and `2026-08-15-ingester-standings-snapshots.md` publishes a ledger
> reserving `0004`–`0010`. **Run `ls backend/migrations` first**, take the next
> genuinely free integer, keep the `_stat_leaders_and_box_scores` suffix, and use
> that number consistently in every file list below.
>
> **The overlap is worse than the numbering, and it needs a human decision.**
> Those plans reserve two migrations that model the same two datasets this one
> does, under a different schema:
>
> | Their migration | Their shape | This plan's shape |
> |---|---|---|
> | `0006_appearance_box_score` | thirteen nullable `int` columns on an `appearance` table from `0003_player_capture` | `match_player_stat` with a `jsonb` stat bag |
> | `0007_leader_category` | a category discriminator on the leaders table | `stat_leader.metric` |
>
> They also assume an unmerged branch that **renumbers `0003` and `0004`**,
> replacing `0003_ingester_delete_grant` and `0004_ingester_hardening` with
> `0003_player_capture`. That branch is not on `origin/main` as of writing, and
> Task 1 below is written against the schema that *is* on `origin/main`.
>
> **Do not resolve this by guessing.** Exactly one of the two shapes should
> survive, and the choice is the user's:
>
> - If the ingester plans land first, **drop Task 1's `match_player_stat` and the
>   `metric` column entirely** and rewrite Tasks 4 and 6 to read `appearance` and
>   the leader category instead. The endpoints, the handlers, `params.go`, the
>   response types and every test in Tasks 2, 3, 5 and 7 are unaffected — only
>   the two SQL constants and the seed change.
> - If this plan lands first, the ingester plans' `0006` and `0007` become
>   redundant and should be cut from their ledger.
>
> Either way, **ask before writing Task 1.** Two tables holding the same per-player
> match statistics is the one outcome that must not happen: it guarantees two
> quietly different answers to the same question.

**Files:**
- Create: `backend/migrations/0005_stat_leaders_and_box_scores.up.sql`
- Create: `backend/migrations/0005_stat_leaders_and_box_scores.down.sql`
- Test: `backend/migrations/migrations_test.go`, `backend/reader/migrations_integration_test.go`

**Why rename instead of drop-and-recreate.** `top_scorer` holds live rows and
carries a grant that migration 0003 issued (`GRANT DELETE ON standing, top_scorer
TO scorearc_ingester`). Postgres grants attach to the table's OID, not its name,
so `ALTER TABLE ... RENAME` preserves both the rows and the grant, and the down
migration is a mechanical reversal instead of a re-derivation. It also matters
for the round-trip test's ordering: `0003_ingester_delete_grant.down.sql` runs
*after* our down migration and says `REVOKE DELETE ON standing, top_scorer` — so
the table must be called `top_scorer` again by the time it runs. A
drop-and-recreate would have to reissue that grant and would still leave 0003's
down migration revoking a privilege on a table it no longer recognises.

- [ ] **Step 1: Write the failing test**

Append to `backend/migrations/migrations_test.go`:

```go
func TestStatLeaderMigrationRenamesRatherThanRecreates(t *testing.T) {
	up, err := os.ReadFile("0005_stat_leaders_and_box_scores.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	// A DROP + CREATE would discard live rows and silently drop the DELETE
	// grant migration 0003 issued on this table.
	if strings.Contains(string(up), "DROP TABLE top_scorer") {
		t.Fatal("migration drops top_scorer instead of renaming it")
	}
	for _, required := range []string{
		"ALTER TABLE top_scorer RENAME TO stat_leader",
		"RENAME COLUMN goals TO value",
		"ADD PRIMARY KEY (comp_id, season_id, metric, rank)",
		"CREATE TABLE match_player_stat",
		"GRANT DELETE ON match_player_stat TO scorearc_ingester",
	} {
		if !strings.Contains(string(up), required) {
			t.Fatalf("up migration missing %q", required)
		}
	}

	down, err := os.ReadFile("0005_stat_leaders_and_box_scores.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	// 0003's own down migration revokes DELETE on "top_scorer" after ours runs,
	// so the table has to answer to that name again by then.
	for _, required := range []string{
		"DROP TABLE IF EXISTS match_player_stat",
		"ALTER TABLE stat_leader RENAME TO top_scorer",
		"PRIMARY KEY (comp_id, season_id, rank)",
	} {
		if !strings.Contains(string(down), required) {
			t.Fatalf("down migration missing %q", required)
		}
	}
}
```

In `backend/reader/migrations_integration_test.go`, extend the `files` slice —
the up file goes after `0004...up.sql`, the down file **before**
`0004...down.sql`, because rollback runs in reverse:

```go
	files := []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0005_stat_leaders_and_box_scores.up.sql",
		"../migrations/0005_stat_leaders_and_box_scores.down.sql",
		"../migrations/0004_ingester_hardening.down.sql",
		"../migrations/0003_ingester_delete_grant.down.sql",
		"../migrations/0002_snapshots.down.sql",
		"../migrations/0001_init.down.sql",
	}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./migrations
```

Expected: FAIL — `open 0005_stat_leaders_and_box_scores.up.sql: no such file or directory`.

- [ ] **Step 3: Implement**

Create `backend/migrations/0005_stat_leaders_and_box_scores.up.sql`:

```sql
-- top_scorer is a leaderboard row that happens to call its metric "goals".
-- Renaming keeps every existing row and every existing grant (grants attach to
-- the table OID, not its name), which is why this is a rename and not a
-- drop-and-recreate. Migration 0003's DELETE grant survives untouched.
ALTER TABLE top_scorer RENAME TO stat_leader;
ALTER TABLE stat_leader RENAME COLUMN goals TO value;

-- Existing rows are all goals, so the default backfills them in place. The
-- default is dropped afterwards: a row with no stated metric is a bug, not a
-- goals row, and the ingester must always say which board it is writing.
ALTER TABLE stat_leader ADD COLUMN metric text NOT NULL DEFAULT 'goals';
-- ESPN's athlete id. Nullable because the leaders payload does not always carry
-- one, and a synthesised id would be worse than an absent one.
ALTER TABLE stat_leader ADD COLUMN player_id text;
ALTER TABLE stat_leader ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Ranks restart at 1 for every metric, so metric belongs inside the key. The
-- constraint is still named top_scorer_pkey: RENAME TABLE does not rename the
-- constraints the table owns.
ALTER TABLE stat_leader DROP CONSTRAINT top_scorer_pkey;
ALTER TABLE stat_leader ADD PRIMARY KEY (comp_id, season_id, metric, rank);
ALTER TABLE stat_leader ALTER COLUMN metric DROP DEFAULT;

-- One row per player per match. stats is jsonb rather than a fixed column list
-- because the stat set genuinely varies by position: goalkeepers carry saves,
-- shotsFaced and goalsConceded and no offsides; outfielders the reverse. Fixed
-- columns would force a NULL-or-zero decision per position at write time, and
-- the reader would have no way to tell "not applicable" from "zero".
CREATE TABLE match_player_stat (
  match_id   text NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  team_id    text NOT NULL REFERENCES team(id),
  player_id  text NOT NULL,
  player     text NOT NULL,
  position   text NOT NULL DEFAULT '',
  jersey     text,
  starter    bool NOT NULL DEFAULT false,
  stats      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, player_id)
);
-- E5's player pages read every match one player appeared in; without this the
-- primary key only helps the other direction.
CREATE INDEX match_player_stat_player_idx ON match_player_stat (player_id);

-- SELECT for scorearc_reader and SELECT/INSERT/UPDATE for scorearc_ingester
-- arrive automatically from 0001's ALTER DEFAULT PRIVILEGES. DELETE does not,
-- and the ingester needs it to replace a squad list when a lineup changes.
GRANT DELETE ON match_player_stat TO scorearc_ingester;
```

Create `backend/migrations/0005_stat_leaders_and_box_scores.down.sql`:

```sql
-- Dropping the table takes match_player_stat_player_idx and the DELETE grant
-- with it.
DROP TABLE IF EXISTS match_player_stat;

-- Rolling back to a single-metric table means the assist rows have nowhere to
-- live. Deleting them is the honest reversal: a (comp_id, season_id, rank)
-- primary key cannot hold two boards, and keeping them would make the restored
-- key fail on duplicate ranks. Re-running the up migration plus one ingest run
-- rebuilds them from ESPN.
DELETE FROM stat_leader WHERE metric <> 'goals';

ALTER TABLE stat_leader DROP CONSTRAINT stat_leader_pkey;
ALTER TABLE stat_leader DROP COLUMN IF EXISTS updated_at;
ALTER TABLE stat_leader DROP COLUMN IF EXISTS player_id;
ALTER TABLE stat_leader DROP COLUMN IF EXISTS metric;
ALTER TABLE stat_leader RENAME COLUMN value TO goals;
ALTER TABLE stat_leader RENAME TO top_scorer;
-- Restore 0001's constraint under its original name so
-- 0003_ingester_delete_grant.down.sql, which runs next, still finds the table
-- and the privilege it means to revoke.
ALTER TABLE top_scorer ADD CONSTRAINT top_scorer_pkey PRIMARY KEY (comp_id, season_id, rank);
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./migrations && go test ./reader -run TestMigrationsRoundTrip
```

Expected: both `ok`. The round trip still ends with `tables=0 roles=0` — if it
reports a leftover table, the down migration dropped something in the wrong
order. (Docker must be running for the second command.)

```bash
cd backend && go test ./reader
```

Expected: `ok` — `store_integration_test.go` still applies only 0001–0004, so
`top_scorer` still exists for the existing store tests. Task 4 moves it.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0005_stat_leaders_and_box_scores.up.sql backend/migrations/0005_stat_leaders_and_box_scores.down.sql backend/migrations/migrations_test.go backend/reader/migrations_integration_test.go
git commit -m "feat(db): generalise top_scorer to stat_leader and add match_player_stat

The leaderboard is renamed rather than recreated so the live rows and
migration 0003's DELETE grant survive, and so the rollback is a
mechanical reversal that leaves the table answering to top_scorer again
before 0003's own down migration revokes on it.

match_player_stat stores its stat bag as jsonb because the stat set
varies by position: fixed columns would force a zero where ESPN sent
nothing at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `parseMetric` and the leader caps

**Files:**
- Modify: `backend/reader/params.go`
- Test: `backend/reader/params_test.go`

**Interfaces:**
- `parseMetric(raw string) (string, error)` — `""` or `"goals"` → `"goals"`; `"assists"` → `"assists"`; anything else is an error.
- `maxLeaderLimit = 100`, `defaultLeaderLimit = 50`, `metricGoals = "goals"`, `metricAssists = "assists"`.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParseMetric(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]string{
		"":        metricGoals,
		"goals":   metricGoals,
		"assists": metricAssists,
	} {
		got, err := parseMetric(raw)
		if err != nil || got != want {
			t.Fatalf("metric %q = %q, err %v", raw, got, err)
		}
	}
	// This value reaches SQL as a bound parameter, so it is not injection that
	// is at stake - it is that an unknown metric must be a 400 rather than a
	// silent goals board wearing an assists label.
	for _, raw := range []string{"Goals", "ASSISTS", "shots", "goals ", "goals;--", "clean_sheets"} {
		if _, err := parseMetric(raw); err == nil {
			t.Fatalf("metric %q was accepted", raw)
		}
	}
	if _, err := parseMetric("nope"); err == nil || err.Error() != "metric must be goals or assists" {
		t.Fatalf("metric message = %v", err)
	}
}

func TestLeaderLimitIsCappedBelowTheMatchLimit(t *testing.T) {
	t.Parallel()
	// ESPN publishes 50 leaders per category, so 50 is the default and 100 is
	// generous headroom. 500 rows of leaderboard is not a thing that exists.
	if defaultLeaderLimit != 50 || maxLeaderLimit != 100 {
		t.Fatalf("leader limits = %d/%d", defaultLeaderLimit, maxLeaderLimit)
	}
	if maxLeaderLimit >= maxMatchLimit {
		t.Fatalf("leader cap %d is not below the match cap %d", maxLeaderLimit, maxMatchLimit)
	}
	value, err := parseLimit("100", maxLeaderLimit)
	if err != nil || value == nil || *value != 100 {
		t.Fatalf("limit = %v, err %v", value, err)
	}
	for _, raw := range []string{"101", "500", "0", "-1", "abc"} {
		if _, err := parseLimit(raw, maxLeaderLimit); err == nil {
			t.Fatalf("leader limit %q was accepted", raw)
		}
	}
	if _, err := parseLimit("101", maxLeaderLimit); err.Error() != "limit must be an integer between 1 and 100" {
		t.Fatalf("cap message does not name the leader cap")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestParseMetric|TestLeaderLimit"
```

Expected: FAIL — `undefined: parseMetric`, `undefined: metricGoals`, `undefined: maxLeaderLimit`.

- [ ] **Step 3: Implement**

Append to `backend/reader/params.go`'s existing `const` block:

```go
	// metricGoals and metricAssists are the two leaderboards ESPN publishes in
	// a single /statistics response (goalsLeaders and assistsLeaders, 50 rows
	// each, verified live 2026-08-15). They are also the values persisted in
	// stat_leader.metric, so the enum and the column agree by construction.
	metricGoals   = "goals"
	metricAssists = "assists"
	// defaultLeaderLimit matches what the provider actually publishes per
	// category. Asking for more cannot return more.
	defaultLeaderLimit = 50
	// maxLeaderLimit leaves headroom for a longer upstream board without
	// letting a caller ask for the whole table on one token.
	maxLeaderLimit = 100
```

and, beside the other error constants:

```go
	errMetric = errors.New("metric must be goals or assists")
```

then the function:

```go
// parseMetric validates ?metric= against the leaderboards we persist. An empty
// value means goals, which keeps /leaders a superset of the frozen
// /top-scorers path rather than a different endpoint that happens to overlap.
func parseMetric(raw string) (string, error) {
	switch raw {
	case "", metricGoals:
		return metricGoals, nil
	case metricAssists:
		return metricAssists, nil
	default:
		return "", errMetric
	}
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestParse|TestLeaderLimit" && go vet ./reader
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/reader`, and `go vet` silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/params.go backend/reader/params_test.go
git commit -m "feat(reader): validate the leaderboard metric and its row cap

metric is an enum of the two boards ESPN publishes in one response, and
an unknown value is a 400 rather than a goals board wearing an assists
label. The leader cap is 100 against a default of 50 because the
provider publishes 50 - a larger response would be padding.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The response types and the recomputed percentage

**Files:**
- Modify: `backend/reader/types.go`
- Create: `backend/reader/types_test.go`

**Interfaces:**
- `StatLeader`, `PlayerMatchStats`, `PlayerBoxScore`, `TeamBoxScore`, `BoxScore`.
- `derivePlayerStats(stats *PlayerMatchStats)` — recomputes `shotAccuracy`, in place.

- [ ] **Step 1: Write the failing test**

Create `backend/reader/types_test.go`:

```go
package main

import (
	"encoding/json"
	"testing"
)

func number(value float64) *float64 { return &value }

func TestDerivePlayerStatsRecomputesShotAccuracy(t *testing.T) {
	t.Parallel()
	// ESPN sends shotAccuracy pre-rounded: 30 where the raw counts are 3 of 11
	// (27.27%). We hold the numerator and the denominator, so echoing the
	// provider's rounding is a choice to be less accurate than our own data.
	stats := PlayerMatchStats{
		TotalShots:    number(11),
		ShotsOnTarget: number(3),
		ShotAccuracy:  number(30),
	}
	derivePlayerStats(&stats)
	if stats.ShotAccuracy == nil || *stats.ShotAccuracy != 27.3 {
		t.Fatalf("shotAccuracy = %v, want 27.3", stats.ShotAccuracy)
	}
}

func TestDerivePlayerStatsNeverInventsAPercentage(t *testing.T) {
	t.Parallel()
	// A substitute who never took a shot has no shooting accuracy. Zero would
	// claim he shot and missed; null says he did not shoot.
	for name, stats := range map[string]PlayerMatchStats{
		"no shots taken":      {TotalShots: number(0), ShotsOnTarget: number(0)},
		"denominator absent":  {ShotsOnTarget: number(3)},
		"numerator absent":    {TotalShots: number(11)},
		"neither reported":    {},
		"provider value only": {ShotAccuracy: number(30)},
	} {
		t.Run(name, func(t *testing.T) {
			derivePlayerStats(&stats)
			if stats.ShotAccuracy != nil {
				t.Fatalf("shotAccuracy = %v, want null", *stats.ShotAccuracy)
			}
		})
	}
}

func TestPlayerMatchStatsKeepsAbsenceAbsent(t *testing.T) {
	t.Parallel()
	// A goalkeeper's payload carries saves and no offsides; an outfielder's
	// carries offsides and no saves. Neither absence may decode as zero.
	var keeper PlayerMatchStats
	if err := json.Unmarshal([]byte(`{"saves":4,"shotsFaced":6,"goalsConceded":2,"appearances":1}`), &keeper); err != nil {
		t.Fatal(err)
	}
	if keeper.Saves == nil || *keeper.Saves != 4 || keeper.Offsides != nil || keeper.TotalShots != nil {
		t.Fatalf("keeper = %+v", keeper)
	}

	var outfielder PlayerMatchStats
	if err := json.Unmarshal([]byte(`{"offsides":2,"totalShots":11,"shotsOnTarget":3}`), &outfielder); err != nil {
		t.Fatal(err)
	}
	if outfielder.Offsides == nil || *outfielder.Offsides != 2 || outfielder.Saves != nil || outfielder.GoalsConceded != nil {
		t.Fatalf("outfielder = %+v", outfielder)
	}
}

func TestPlayerMatchStatsSerializesEveryFieldAsNull(t *testing.T) {
	t.Parallel()
	// openapi_test.go requires every property in a schema's required list, so
	// no field here may carry omitempty. This is the guard against someone
	// adding one and quietly breaking the contract test three files away.
	data, err := json.Marshal(PlayerMatchStats{})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 17 {
		t.Fatalf("PlayerMatchStats encoded %d fields, want 17: %s", len(decoded), data)
	}
	for name, value := range decoded {
		if value != nil {
			t.Fatalf("field %s = %v, want null on the zero value", name, value)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestDerivePlayerStats|TestPlayerMatchStats"
```

Expected: FAIL — `undefined: PlayerMatchStats`, `undefined: derivePlayerStats`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go` (and add `"math"` to its imports — the file
currently imports only the `espn` package, so this becomes a grouped block):

```go
// StatLeader is one row of any leaderboard. It replaces the goals-only
// TopScorer shape at the store layer; the frozen /top-scorers path projects
// Value back onto TopScorer.Goals in its handler.
type StatLeader struct {
	Rank         int     `json:"rank"`
	PlayerID     *string `json:"playerId"`
	Player       string  `json:"player"`
	TeamAbbr     string  `json:"teamAbbr"`
	TeamName     string  `json:"teamName"`
	TeamCrestURL *string `json:"teamCrestUrl"`
	Value        int     `json:"value"`
	Matches      *int    `json:"matches"`
}

// PlayerMatchStats is one player's line in one match. Every field is a pointer
// because ESPN's stat set varies by position: a goalkeeper's payload has saves
// and no offsides, an outfielder's has offsides and no saves. A missing stat
// means "not applicable to this position", and encoding that as 0 would claim
// a goalkeeper was caught offside nought times when nobody counted.
//
// Field names are ESPN's own stat names so a mapper can look each one up by
// name rather than by array index, which is the only lookup that survives the
// per-position reordering.
type PlayerMatchStats struct {
	Appearances    *float64 `json:"appearances"`
	SubIns         *float64 `json:"subIns"`
	Starts         *float64 `json:"starts"`
	TotalGoals     *float64 `json:"totalGoals"`
	GoalAssists    *float64 `json:"goalAssists"`
	TotalShots     *float64 `json:"totalShots"`
	ShotsOnTarget  *float64 `json:"shotsOnTarget"`
	Offsides       *float64 `json:"offsides"`
	FoulsCommitted *float64 `json:"foulsCommitted"`
	FoulsSuffered  *float64 `json:"foulsSuffered"`
	YellowCards    *float64 `json:"yellowCards"`
	RedCards       *float64 `json:"redCards"`
	OwnGoals       *float64 `json:"ownGoals"`
	Saves          *float64 `json:"saves"`
	ShotsFaced     *float64 `json:"shotsFaced"`
	GoalsConceded  *float64 `json:"goalsConceded"`
	// ShotAccuracy is computed by derivePlayerStats, never echoed. See there.
	ShotAccuracy *float64 `json:"shotAccuracy"`
}

// PlayerBoxScore is one player's row. PlayerID is ESPN's athlete id and is the
// only stable join key; Player is a display name and is not unique.
type PlayerBoxScore struct {
	PlayerID string           `json:"playerId"`
	Player   string           `json:"player"`
	Position string           `json:"position"`
	Jersey   *string          `json:"jersey"`
	Starter  bool             `json:"starter"`
	Stats    PlayerMatchStats `json:"stats"`
}

type TeamBoxScore struct {
	TeamID  string           `json:"teamId"`
	Players []PlayerBoxScore `json:"players"`
}

// BoxScore is both squads' player lines for one match. Home and Away are
// assigned from match.home_team_id and match.away_team_id, never from the order
// rows come back in.
type BoxScore struct {
	MatchID string       `json:"matchId"`
	Home    TeamBoxScore `json:"home"`
	Away    TeamBoxScore `json:"away"`
}

// derivePlayerStats recomputes the fields we own rather than echo.
//
// ESPN publishes shotAccuracy pre-rounded - 30 where the raw counts are 3 of 11
// (27.27%). We hold both the numerator and the denominator, so echoing the
// provider's rounding would be choosing to be less accurate than our own data.
// The provider value is discarded first, unconditionally, so a stat bag that
// was persisted with one cannot leak through the branch that declines to
// compute a replacement.
func derivePlayerStats(stats *PlayerMatchStats) {
	stats.ShotAccuracy = nil
	if stats.TotalShots == nil || stats.ShotsOnTarget == nil || *stats.TotalShots == 0 {
		// No shots is not zero accuracy - zero would claim he shot and missed.
		return
	}
	accuracy := math.Round(*stats.ShotsOnTarget / *stats.TotalShots * 1000) / 10
	stats.ShotAccuracy = &accuracy
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestDerivePlayerStats|TestPlayerMatchStats" && go vet ./reader
```

Expected: `ok`, vet silent. If `TestPlayerMatchStatsSerializesEveryFieldAsNull`
reports fewer than 17 fields, a field picked up an `omitempty` — remove it
rather than lowering the count.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/types.go backend/reader/types_test.go
git commit -m "feat(reader): add the leader and box-score response shapes

Every per-player stat is a pointer because ESPN's stat set varies by
position - a goalkeeper has saves and no offsides. Zero would claim he
was caught offside nought times when nobody counted.

shotAccuracy is recomputed from the raw numerator and denominator and
the provider's pre-rounded value is discarded first, so a persisted 30
cannot leak through the branch that declines to compute 27.3.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `Store.Leaders` replaces `Store.TopScorers`

**Files:**
- Modify: `backend/reader/store.go`, `backend/reader/server.go`, `backend/reader/handlers.go`, `backend/reader/server_test.go`
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `Store.Leaders(ctx context.Context, competition, season, metric string, limit *int) ([]StatLeader, error)`
- `Store.TopScorers` is **removed**. `/v1/competitions/{comp}/{season}/top-scorers` keeps its path and its exact JSON shape; `handleTopScorers` projects `StatLeader.Value` onto `TopScorer.Goals`.

**Why the path is frozen.** `/top-scorers` has consumers. E1's rename of
`TopScorer` to `StatLeader` is a *frontend* refactor — it changes TypeScript
interfaces and component props, not the wire format the reader already publishes.
Renaming the field here as well would break every existing consumer to save one
projection loop, so `/top-scorers` stays exactly as it is and becomes the v1
alias of `?metric=goals`. `/leaders` is the endpoint new consumers use.

- [ ] **Step 1: Write the failing test**

In `backend/reader/store_integration_test.go`, add 0005 to the migration list in
`newIntegrationStore`:

```go
	for _, migration := range []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0005_stat_leaders_and_box_scores.up.sql",
	} {
```

and in `seedIntegrationData`, replace the `top_scorer` statement with:

```go
		`INSERT INTO stat_leader
			(comp_id, season_id, metric, rank, player_id, player, team_abbr, team_name, team_crest_url, value, matches)
		 VALUES
			('world-cup', '2026', 'goals',   1, '1001', 'Lionel Messi',   'ARG', 'Argentina', 'https://cdn.scorearc.futbol/arg.png', 7, 6),
			('world-cup', '2026', 'goals',   2, NULL,   'Mystery Player', NULL,  NULL,        NULL, 5, NULL),
			('world-cup', '2026', 'assists', 1, '1002', 'Robert Morales', 'FRA', 'France',    'https://cdn.scorearc.futbol/fra.png', 3, 3),
			('world-cup', '2026', 'assists', 2, '1001', 'Lionel Messi',   'ARG', 'Argentina', 'https://cdn.scorearc.futbol/arg.png', 2, 6)`,
```

Replace the existing `"top scorers normalize nullable team text"` subtest inside
`TestStoreIntegration` with:

```go
	t.Run("leaders are per-metric and normalize nullable team text", func(t *testing.T) {
		goals, err := store.Leaders(ctx, "world-cup", "2026", metricGoals, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(goals) != 2 || goals[0].Player != "Lionel Messi" || goals[0].Value != 7 {
			t.Fatalf("goals = %+v", goals)
		}
		// A leader with no team text must read as empty strings, not "<nil>".
		if goals[1].TeamAbbr != "" || goals[1].TeamName != "" || goals[1].Matches != nil || goals[1].PlayerID != nil {
			t.Fatalf("nullable leader = %+v", goals[1])
		}
		if goals[0].PlayerID == nil || *goals[0].PlayerID != "1001" {
			t.Fatalf("playerId = %v", goals[0].PlayerID)
		}

		// Ranks restart at 1 per metric, which is why metric is in the key.
		assists, err := store.Leaders(ctx, "world-cup", "2026", metricAssists, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(assists) != 2 || assists[0].Rank != 1 || assists[0].Player != "Robert Morales" || assists[0].Value != 3 {
			t.Fatalf("assists = %+v", assists)
		}

		one := 1
		capped, err := store.Leaders(ctx, "world-cup", "2026", metricGoals, &one)
		if err != nil || len(capped) != 1 || capped[0].Rank != 1 {
			t.Fatalf("capped = %+v, err %v", capped, err)
		}

		// A season we hold no board for is an empty list, not an error and not
		// nil - the UI renders "no leaders yet", which is a real state.
		empty, err := store.Leaders(ctx, "world-cup", "1998", metricGoals, nil)
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("empty leaders = %#v, err %v", empty, err)
		}
	})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreIntegration
```

Expected: FAIL — `store.Leaders undefined (type *Store has no field or method Leaders)`.

- [ ] **Step 3: Implement**

In `backend/reader/store.go`, replace `topScorersSQL` and `TopScorers` with:

```go
// One statement serves every board. metric is a bound parameter whose value
// came out of parseMetric, and LIMIT is a placeholder: Postgres reads
// LIMIT NULL as "no limit", so an uncapped store call needs no second query.
const leadersSQL = `
SELECT rank, player_id, player, value, matches, team_abbr, team_name, team_crest_url
FROM stat_leader
WHERE comp_id = $1 AND season_id = $2 AND metric = $3
ORDER BY rank
LIMIT $4`

func (s *Store) Leaders(ctx context.Context, competition, season, metric string, limit *int) ([]StatLeader, error) {
	rows, err := s.db.Query(ctx, leadersSQL, competition, season, metric, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	leaders := make([]StatLeader, 0)
	for rows.Next() {
		var leader StatLeader
		// ESPN's leaders payload gives the player's team as abbr/name/crest
		// with no team id, so the columns are denormalized and nullable. An
		// absent name is an empty string in the contract, not a null.
		var teamAbbr, teamName *string
		if err := rows.Scan(
			&leader.Rank, &leader.PlayerID, &leader.Player, &leader.Value, &leader.Matches,
			&teamAbbr, &teamName, &leader.TeamCrestURL,
		); err != nil {
			return nil, err
		}
		if teamAbbr != nil {
			leader.TeamAbbr = *teamAbbr
		}
		if teamName != nil {
			leader.TeamName = *teamName
		}
		leaders = append(leaders, leader)
	}
	return leaders, rows.Err()
}
```

In `backend/reader/server.go`, replace the `TopScorers` line in `readerStore`:

```go
	Leaders(context.Context, string, string, string, *int) ([]StatLeader, error)
```

In `backend/reader/handlers.go`, replace `handleTopScorers`:

```go
// handleTopScorers is the frozen v1 alias of /leaders?metric=goals. The path
// and the TopScorer field names are contract: consumers exist, and E1's rename
// of TopScorer to StatLeader is a frontend-side refactor of TypeScript
// interfaces, not a change to the wire format this service already publishes.
// The projection below is the whole cost of keeping that promise.
func (a *App) handleTopScorers(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	limit := defaultLeaderLimit
	leaders, err := a.store.Leaders(request.Context(), competition, season, metricGoals, &limit)
	if err != nil {
		a.logger.Error("top scorers", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	scorers := make([]espn.TopScorer, 0, len(leaders))
	for _, leader := range leaders {
		scorers = append(scorers, espn.TopScorer{
			Rank:         leader.Rank,
			Player:       leader.Player,
			TeamAbbr:     leader.TeamAbbr,
			TeamName:     leader.TeamName,
			TeamCrestURL: leader.TeamCrestURL,
			Goals:        leader.Value,
			Matches:      leader.Matches,
		})
	}
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, scorers)
}
```

In `backend/reader/server_test.go`, add to the `fakeReaderStore` struct (keep
`topScorers` and `topScorersErr` — the tests that seed them still describe
exactly this data):

```go
	leaders      []StatLeader
	leadersErr   error
	leaderMetric string
	leaderLimit  *int
```

and replace the `TopScorers` method with:

```go
func (f *fakeReaderStore) Leaders(_ context.Context, _, _, metric string, limit *int) ([]StatLeader, error) {
	f.calls++
	f.leaderMetric, f.leaderLimit = metric, limit
	if f.leaders != nil || f.leadersErr != nil {
		return f.leaders, f.leadersErr
	}
	// Tests written before /leaders existed seed topScorers and topScorersErr.
	// The goals board is that same leaderboard under its old name, so bridge
	// those fixtures here rather than rewriting assertions that are still
	// exactly right about the data they describe.
	bridged := make([]StatLeader, 0, len(f.topScorers))
	for _, scorer := range f.topScorers {
		bridged = append(bridged, StatLeader{
			Rank:         scorer.Rank,
			Player:       scorer.Player,
			TeamAbbr:     scorer.TeamAbbr,
			TeamName:     scorer.TeamName,
			TeamCrestURL: scorer.TeamCrestURL,
			Value:        scorer.Goals,
			Matches:      scorer.Matches,
		})
	}
	return bridged, f.topScorersErr
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: build clean, `ok`. `TestPublicRoutesAndCachePolicies`,
`TestNilListDependenciesStillEncodeArrays`, `TestDependencyErrorsAreSanitized`
and `TestOpenAPIValidatesActualRouteResponses` all still cover `/top-scorers`
unchanged — its status, `Cache-Control: public, max-age=60`, array body and
sanitized 500 are exactly what they were.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store.go backend/reader/server.go backend/reader/handlers.go backend/reader/server_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read leaderboards per metric behind the frozen path

Store.Leaders replaces Store.TopScorers with a metric-parameterized
read. /top-scorers keeps its path and its exact JSON: consumers exist,
and E1's TopScorer-to-StatLeader rename is a frontend refactor, not a
wire-format change. The handler projects Value back onto Goals, which is
the entire cost of keeping that promise.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `GET /leaders` — the generalised leaderboard

**Files:**
- Create: `backend/reader/handlers_leaders.go`
- Modify: `backend/reader/server.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/server_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestLeadersDefaultsToGoalsAndFifty(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{leaders: []StatLeader{}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/competitions/world-cup/2026/leaders")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if store.leaderMetric != "goals" {
		t.Fatalf("metric = %q, want goals", store.leaderMetric)
	}
	// ESPN publishes 50 per category, so an absent ?limit= must still be
	// bounded rather than unbounded - the store contract treats nil as "all".
	if store.leaderLimit == nil || *store.leaderLimit != 50 {
		t.Fatalf("limit = %v, want 50", store.leaderLimit)
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if body := strings.TrimSpace(response.Body.String()); body != "[]" {
		t.Fatalf("body = %q, want an empty array", body)
	}
}

func TestLeadersServesTheAssistsBoard(t *testing.T) {
	t.Parallel()
	playerID := "1002"
	store := &fakeReaderStore{leaders: []StatLeader{
		{Rank: 1, PlayerID: &playerID, Player: "Robert Morales", TeamAbbr: "UNAM", TeamName: "Pumas", Value: 3},
	}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet,
		"/v1/competitions/world-cup/2026/leaders?metric=assists&limit=10")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if store.leaderMetric != "assists" || store.leaderLimit == nil || *store.leaderLimit != 10 {
		t.Fatalf("metric=%q limit=%v", store.leaderMetric, store.leaderLimit)
	}
	var leaders []StatLeader
	if err := json.Unmarshal(response.Body.Bytes(), &leaders); err != nil {
		t.Fatal(err)
	}
	// The generalised board reports "value", not "goals" - the goals name is
	// frozen only on the /top-scorers alias.
	if len(leaders) != 1 || leaders[0].Value != 3 {
		t.Fatalf("leaders = %+v", leaders)
	}
	if !strings.Contains(response.Body.String(), `"value":3`) {
		t.Fatalf("body does not use the generalised field name: %s", response.Body.String())
	}
}

func TestInvalidLeaderParametersAre400AndNeverReachTheStore(t *testing.T) {
	t.Parallel()
	base := "/v1/competitions/world-cup/2026/leaders?"
	for _, query := range []string{
		"metric=shots",
		"metric=Goals",
		"metric=goals;--",
		"limit=0",
		"limit=101",
		"limit=abc",
	} {
		store := &fakeReaderStore{leaders: []StatLeader{}}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, base+query)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", query, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", query)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s Cache-Control = %q", query, response.Header().Get("Cache-Control"))
		}
	}
}

func TestTopScorersStillReportsGoals(t *testing.T) {
	t.Parallel()
	// The frozen alias. If this ever emits "value" instead of "goals", every
	// existing consumer breaks.
	store := &fakeReaderStore{leaders: []StatLeader{
		{Rank: 1, Player: "Lionel Messi", TeamAbbr: "ARG", TeamName: "Argentina", Value: 7},
	}}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet,
		"/v1/competitions/world-cup/2026/top-scorers")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if store.leaderMetric != "goals" {
		t.Fatalf("alias asked for metric %q", store.leaderMetric)
	}
	body := response.Body.String()
	if !strings.Contains(body, `"goals":7`) || strings.Contains(body, `"value"`) || strings.Contains(body, `"playerId"`) {
		t.Fatalf("top-scorers shape changed: %s", body)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestLeaders|TestInvalidLeader|TestTopScorersStill"
```

Expected: FAIL — `/leaders` returns 404 (`{"error":"not found"}`) because the
route does not exist, so every status assertion fails.

- [ ] **Step 3: Implement**

Create `backend/reader/handlers_leaders.go`:

```go
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// handleLeaders serves any persisted leaderboard. Both parameters are validated
// before the store is touched: an unknown metric must not cost a query, and it
// must not quietly return goals under an assists label.
func (a *App) handleLeaders(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	query := request.URL.Query()
	metric, err := parseMetric(query.Get("metric"))
	if err != nil {
		// Safe to echo: every error out of params.go is a constant declared
		// there, never a wrapped dependency error.
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := parseLimit(query.Get("limit"), maxLeaderLimit)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if limit == nil {
		// parseLimit's nil means "no limit", which is right for a match list
		// bounded by a fixture calendar and wrong for a board a caller asks
		// for by the row. Leaders always carry a bound.
		value := defaultLeaderLimit
		limit = &value
	}
	leaders, err := a.store.Leaders(request.Context(), competition, season, metric, limit)
	if err != nil {
		a.logger.Error("leaders", "competition", competition, "season", season, "metric", metric, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if leaders == nil {
		leaders = []StatLeader{}
	}
	// A leaderboard changes when a match ends, not while it runs, so this keeps
	// the standard sixty seconds rather than the live cadence.
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, leaders)
}
```

In `backend/reader/server.go`, register the route beside the others:

```go
		router.Get("/competitions/{comp}/{season}/leaders", a.handleLeaders)
```

In `backend/reader/openapi.yaml`, append to `components.parameters`:

```yaml
    Metric:
      name: metric
      in: query
      required: false
      description: >-
        Which leaderboard to return. Absent means goals, which makes this
        endpoint a superset of the frozen /top-scorers alias.
      schema: { type: string, enum: [goals, assists], default: goals }
    LeaderLimit:
      name: limit
      in: query
      required: false
      description: >-
        Maximum leaders to return, 1-100. Absent means 50, which is what the
        upstream provider publishes per category.
      schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
```

add the path after the `top-scorers` path:

```yaml
  /v1/competitions/{comp}/{season}/leaders:
    get:
      operationId: listLeaders
      summary: List a statistical leaderboard for a competition season
      description: >-
        The generalised leaderboard. metric selects the board and value carries
        its count, so a new board costs no new endpoint.
        /v1/competitions/{comp}/{season}/top-scorers is the frozen v1 alias of
        metric=goals and reports the same rows under the field name goals.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/Metric" }
        - { $ref: "#/components/parameters/LeaderLimit" }
      responses:
        "200":
          description: Leaders ordered by rank
          headers:
            Cache-Control: { $ref: "#/components/headers/StandardCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/StatLeader" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

and the schema under `components.schemas`, directly after `TopScorer`:

```yaml
    StatLeader:
      type: object
      additionalProperties: false
      required: [rank, playerId, player, teamAbbr, teamName, teamCrestUrl, value, matches]
      properties:
        rank: { type: integer, description: "Rank within this metric; ranks restart at 1 per board." }
        playerId: { type: [string, "null"], description: "Upstream athlete id; null when the provider omits it." }
        player: { type: string }
        teamAbbr: { type: string, description: "Empty when the provider gives no team; never null." }
        teamName: { type: string }
        teamCrestUrl: { type: [string, "null"] }
        value: { type: integer, description: "The metric's count - goals, assists." }
        matches: { type: [integer, "null"] }
```

In `backend/reader/openapi_test.go`, add a row to
`TestOpenAPIValidatesActualRouteResponses`'s table:

```go
		{target: "/v1/competitions/world-cup/2026/leaders", template: "/v1/competitions/{comp}/{season}/leaders"},
```

The fake's `topScorers` seed already bridges into a non-empty `StatLeader` list,
so no extra seeding is needed. Also add `/leaders` to
`TestNilListDependenciesStillEncodeArrays`'s path list, so the new list endpoint
is held to the same "`[]`, never `null`" rule as the others:

```go
		"/v1/competitions/world-cup/2026/leaders",
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`. If `TestOpenAPIObjectSchemasAreExact` fails on `StatLeader`, the
`required` list and the property list have diverged — they must match exactly,
sorted or not.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_leaders.go backend/reader/server.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/server_test.go
git commit -m "feat(reader): add the generalised /leaders endpoint

metric selects the board and value carries its count, so assists cost
one query parameter rather than a second endpoint - and the shots and
clean-sheet boards E7 wants will cost the same. An unknown metric is a
400 before the store is touched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `Store.BoxScore` — both squads, assigned by team id

**Files:**
- Create: `backend/reader/store_boxscore.go`
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `Store.BoxScore(ctx context.Context, matchID string) (*BoxScore, espn.MatchState, error)`
- `ErrBoxScoreUnavailable` — the match exists but we hold no player rows for it.

**Why two distinct 404s.** "This match id is not one of ours" and "this match is
ours but nobody has ingested its squad yet" are different facts, and a caller
that cannot tell them apart cannot decide whether to retry. **Why not an empty
array.** Returning `{"home":{"players":[]},"away":{"players":[]}}` would assert
that eleven players each took zero shots and committed zero fouls. That is the
same defect class as E0's alphabetical champion: a confident, wrong answer
dressed as data. Absence must be absence.

**Why the state is returned separately.** The cache lifetime is a property of
the match, not of the payload, and adding a `state` field to `BoxScore` would
change a shape the frontend already models against `MatchSummary`.

- [ ] **Step 1: Write the failing test**

In `backend/reader/store_integration_test.go`, append to `seedIntegrationData`'s
`statements` slice. Note the ordering: the **away** team's player is inserted
first and sorts first alphabetically, so a store that assigned sides by row
order would put France at home and this test would catch it.

```go
		`INSERT INTO match_player_stat
			(match_id, team_id, player_id, player, position, jersey, starter, stats)
		 VALUES
			('match-final', 'fra', '2001', 'Adrien Gardien', 'G', '1', true,
			 '{"appearances":1,"starts":1,"saves":4,"shotsFaced":6,"goalsConceded":2,"foulsCommitted":0,"yellowCards":0,"redCards":0}'),
			('match-final', 'arg', '1001', 'Lionel Messi', 'F', '10', true,
			 '{"appearances":1,"starts":1,"totalGoals":1,"goalAssists":2,"totalShots":11,"shotsOnTarget":3,"shotAccuracy":30,"offsides":2,"foulsCommitted":1,"foulsSuffered":4,"yellowCards":1,"redCards":0,"ownGoals":0}'),
			('match-final', 'arg', '1003', 'Unused Substitute', 'M', '23', false,
			 '{"appearances":0,"subIns":0,"totalShots":0,"shotsOnTarget":0}')`,
```

and append this subtest to `TestStoreIntegration`:

```go
	t.Run("box score assigns sides by team id and keeps absence absent", func(t *testing.T) {
		boxScore, state, err := store.BoxScore(ctx, "match-final")
		if err != nil {
			t.Fatal(err)
		}
		if state != espn.MatchStateLive {
			t.Fatalf("state = %q, want live", state)
		}
		// The France row is inserted first and sorts first. Sides come from
		// match.home_team_id / away_team_id, never from row order.
		if boxScore.Home.TeamID != "arg" || boxScore.Away.TeamID != "fra" {
			t.Fatalf("sides = %s/%s", boxScore.Home.TeamID, boxScore.Away.TeamID)
		}
		if len(boxScore.Home.Players) != 2 || len(boxScore.Away.Players) != 1 {
			t.Fatalf("squads = %d/%d", len(boxScore.Home.Players), len(boxScore.Away.Players))
		}

		keeper := boxScore.Away.Players[0]
		if keeper.PlayerID != "2001" || keeper.Position != "G" || keeper.Jersey == nil || *keeper.Jersey != "1" || !keeper.Starter {
			t.Fatalf("keeper = %+v", keeper)
		}
		// A goalkeeper has saves and no offsides. Zero offsides would claim
		// somebody counted, and nobody did.
		if keeper.Stats.Saves == nil || *keeper.Stats.Saves != 4 {
			t.Fatalf("keeper saves = %v", keeper.Stats.Saves)
		}
		if keeper.Stats.Offsides != nil || keeper.Stats.TotalShots != nil || keeper.Stats.ShotAccuracy != nil {
			t.Fatalf("keeper invented outfield stats: %+v", keeper.Stats)
		}

		outfielder := boxScore.Home.Players[0]
		if outfielder.PlayerID != "1001" || outfielder.Stats.Offsides == nil || *outfielder.Stats.Offsides != 2 {
			t.Fatalf("outfielder = %+v", outfielder)
		}
		if outfielder.Stats.Saves != nil || outfielder.Stats.GoalsConceded != nil {
			t.Fatalf("outfielder invented keeper stats: %+v", outfielder.Stats)
		}
		// The seed persists ESPN's pre-rounded 30. 3 of 11 is 27.3.
		if outfielder.Stats.ShotAccuracy == nil || *outfielder.Stats.ShotAccuracy != 27.3 {
			t.Fatalf("shotAccuracy = %v, want 27.3", outfielder.Stats.ShotAccuracy)
		}

		// Starters first, then by name - a stable order the UI can rely on.
		substitute := boxScore.Home.Players[1]
		if substitute.PlayerID != "1003" || substitute.Starter {
			t.Fatalf("substitute = %+v", substitute)
		}
		if substitute.Stats.ShotAccuracy != nil {
			t.Fatalf("zero shots produced an accuracy of %v", *substitute.Stats.ShotAccuracy)
		}
	})

	t.Run("box score distinguishes an unknown match from an uningested one", func(t *testing.T) {
		if _, _, err := store.BoxScore(ctx, "no-such-match"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown match error = %v, want ErrNotFound", err)
		}
		// match-semi is a real match with no player rows. An empty squad list
		// would assert that eleven players each took zero shots.
		if _, _, err := store.BoxScore(ctx, "match-semi"); !errors.Is(err, ErrBoxScoreUnavailable) {
			t.Fatalf("uningested match error = %v, want ErrBoxScoreUnavailable", err)
		}
	})
```

Add `"github.com/mcasillas17/scorearc-backend/shared/espn"` to that file's imports.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreIntegration
```

Expected: FAIL — `store.BoxScore undefined`, `undefined: ErrBoxScoreUnavailable`.

- [ ] **Step 3: Implement**

Create `backend/reader/store_boxscore.go`:

```go
package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// ErrBoxScoreUnavailable means the match is one of ours but we hold no player
// rows for it. It is deliberately distinct from ErrNotFound: "we do not know
// this match" and "nobody has ingested its squad yet" are different facts, and
// a caller that cannot tell them apart cannot decide whether to retry.
var ErrBoxScoreUnavailable = errors.New("box score unavailable")

// The sides come from the match row so they are never inferred from the order
// player rows happen to arrive in.
const boxScoreMatchSQL = `
SELECT home_team_id, away_team_id, state
FROM match
WHERE id = $1`

// Starters first, then alphabetically. Both keys are total over the result set,
// so the order is stable across reads - a UI that renumbers its rows between
// polls looks broken even when the data is right.
const boxScorePlayersSQL = `
SELECT team_id, player_id, player, position, jersey, starter, stats
FROM match_player_stat
WHERE match_id = $1
ORDER BY starter DESC, player, player_id`

func (s *Store) BoxScore(ctx context.Context, matchID string) (*BoxScore, espn.MatchState, error) {
	var homeTeamID, awayTeamID, state string
	if err := s.db.QueryRow(ctx, boxScoreMatchSQL, matchID).Scan(&homeTeamID, &awayTeamID, &state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}

	rows, err := s.db.Query(ctx, boxScorePlayersSQL, matchID)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	boxScore := &BoxScore{
		MatchID: matchID,
		Home:    TeamBoxScore{TeamID: homeTeamID, Players: []PlayerBoxScore{}},
		Away:    TeamBoxScore{TeamID: awayTeamID, Players: []PlayerBoxScore{}},
	}
	found := 0
	for rows.Next() {
		var player PlayerBoxScore
		var teamID string
		var stats []byte
		if err := rows.Scan(
			&teamID, &player.PlayerID, &player.Player, &player.Position,
			&player.Jersey, &player.Starter, &stats,
		); err != nil {
			return nil, "", err
		}
		if err := jsonInto(stats, &player.Stats); err != nil {
			return nil, "", err
		}
		// Recompute what we own. This also discards any pre-rounded
		// shotAccuracy the ingester may have persisted.
		derivePlayerStats(&player.Stats)
		found++
		switch teamID {
		case homeTeamID:
			boxScore.Home.Players = append(boxScore.Home.Players, player)
		case awayTeamID:
			boxScore.Away.Players = append(boxScore.Away.Players, player)
		default:
			// A player row for a third team is corrupt data, not a side we can
			// guess at. Dropping it silently would under-report a squad.
			return nil, "", errors.New("box score row references a team that did not play this match")
		}
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if found == 0 {
		// Not an empty box score - an absent one. Two empty player arrays would
		// claim eleven players each took zero shots.
		return nil, "", ErrBoxScoreUnavailable
	}
	return boxScore, espn.MatchState(state), nil
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStoreIntegration
```

Expected: `ok`. (Docker must be running.)

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_boxscore.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read per-match player lines from match_player_stat

Sides come from match.home_team_id and away_team_id, never from row
order. A match we hold with no player rows returns
ErrBoxScoreUnavailable rather than two empty squads, because two empty
squads would assert that eleven players each took zero shots.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `GET /matches/{id}/box-score`

**Files:**
- Create: `backend/reader/handlers_boxscore.go`
- Modify: `backend/reader/server.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/server_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func newTestBoxScore() *BoxScore {
	jersey := "10"
	return &BoxScore{
		MatchID: "1",
		Home: TeamBoxScore{TeamID: "arg", Players: []PlayerBoxScore{{
			PlayerID: "1001", Player: "Lionel Messi", Position: "F", Jersey: &jersey, Starter: true,
			Stats: PlayerMatchStats{TotalShots: number(11), ShotsOnTarget: number(3), ShotAccuracy: number(27.3)},
		}}},
		Away: TeamBoxScore{TeamID: "fra", Players: []PlayerBoxScore{}},
	}
}

func TestBoxScoreCacheTracksTheMatchState(t *testing.T) {
	t.Parallel()
	for state, want := range map[espn.MatchState]string{
		espn.MatchStateLive:      "public, max-age=10",
		espn.MatchStateFinished:  "public, max-age=60",
		espn.MatchStateScheduled: "public, max-age=60",
	} {
		store := &fakeReaderStore{boxScore: newTestBoxScore(), boxScoreState: state}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
			http.MethodGet, "/v1/matches/401863609/box-score")
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body %s", state, response.Code, response.Body.String())
		}
		if got := response.Header().Get("Cache-Control"); got != want {
			t.Fatalf("%s Cache-Control = %q, want %q", state, got, want)
		}
	}
}

func TestBoxScoreSeparatesAnUnknownMatchFromAnUningestedOne(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		err     error
		message string
	}{
		{name: "unknown match", err: ErrNotFound, message: "match not found"},
		{name: "no player rows", err: ErrBoxScoreUnavailable, message: "box score not available for this match"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeReaderStore{boxScoreErr: tt.err}
			response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
				http.MethodGet, "/v1/matches/401863609/box-score")
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			// The two facts must be distinguishable: one is worth retrying,
			// the other never will be.
			if body["error"] != tt.message {
				t.Fatalf("error = %q, want %q", body["error"], tt.message)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestBoxScoreValidatesItsID(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{boxScore: newTestBoxScore(), boxScoreState: espn.MatchStateFinished}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	if response := performRequest(router, http.MethodGet, "/v1/matches/401863609/box-score"); response.Code != http.StatusOK {
		t.Fatalf("valid id status = %d", response.Code)
	}
	before := store.calls
	for _, id := range []string{"not%20an%20id", "..%2F..%2Fetc", "a%27%20OR%20%271%27%3D%271"} {
		response := performRequest(router, http.MethodGet, "/v1/matches/"+id+"/box-score")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("id %s status = %d, body %s", id, response.Code, response.Body.String())
		}
	}
	if store.calls != before {
		t.Fatal("an invalid id reached the store")
	}
}

func TestBoxScoreDatabaseErrorsAreSanitized(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{boxScoreErr: errors.New("postgres password=must-not-leak")}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/matches/401863609/box-score")
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "password") {
		t.Fatalf("response = %d body %s", response.Code, response.Body.String())
	}
}
```

Add `number` is already declared in `types_test.go` in the same package, so it
is available here — do not redeclare it.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestBoxScore
```

Expected: FAIL — `store.boxScore undefined` and, once the fake compiles, every
request 404s because the route does not exist.

- [ ] **Step 3: Implement**

Create `backend/reader/handlers_boxscore.go`:

```go
package main

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func (a *App) handleBoxScore(writer http.ResponseWriter, request *http.Request) {
	id, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	boxScore, state, storeErr := a.store.BoxScore(request.Context(), id)
	switch {
	case errors.Is(storeErr, ErrNotFound):
		writeError(writer, http.StatusNotFound, "match not found")
		return
	case errors.Is(storeErr, ErrBoxScoreUnavailable):
		// Deliberately a different message from the one above. "We have this
		// match but not its squad" is worth retrying; "we do not have this
		// match" never will be, and one message for both would hide that.
		writeError(writer, http.StatusNotFound, "box score not available for this match")
		return
	case storeErr != nil:
		a.logger.Error("box score", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// Player lines move minute to minute while a match runs and never again
	// once it ends, so the lifetime follows the match rather than a constant.
	cacheFor(writer, liveMaxAge(state == espn.MatchStateLive))
	writeJSON(writer, http.StatusOK, boxScore)
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	BoxScore(context.Context, string) (*BoxScore, espn.MatchState, error)
```

and register the route beside `/matches/{id}`:

```go
		router.Get("/matches/{id}/box-score", a.handleBoxScore)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore`:

```go
	boxScore      *BoxScore
	boxScoreState espn.MatchState
	boxScoreErr   error
```

```go
func (f *fakeReaderStore) BoxScore(context.Context, string) (*BoxScore, espn.MatchState, error) {
	f.calls++
	return f.boxScore, f.boxScoreState, f.boxScoreErr
}
```

In `backend/reader/openapi.yaml`, add the path after `/v1/matches/{id}`:

```yaml
  /v1/matches/{id}/box-score:
    get:
      operationId: getMatchBoxScore
      summary: Get per-player statistics for one match
      description: >-
        One row per player per squad. Every statistic is nullable because the
        provider's stat set varies by position - a goalkeeper reports saves and
        no offsides, an outfielder the reverse - and a missing statistic means
        "not applicable", never zero. shotAccuracy is recomputed from
        shotsOnTarget and totalShots rather than echoed. Sides are assigned from
        the match's own home and away team ids. A match we hold no player rows
        for returns 404 rather than two empty squads.
      parameters:
        - $ref: "#/components/parameters/MatchID"
      responses:
        "200":
          description: Per-player statistics for both squads
          headers:
            Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/BoxScore" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

Widen the shared `NotFound` description, which now covers both facts:

```yaml
    NotFound:
      description: >-
        Match not found, or the match exists but no box score has been ingested
        for it. The two cases carry different error messages.
```

and add the four schemas under `components.schemas`:

```yaml
    PlayerMatchStats:
      type: object
      additionalProperties: false
      required: [appearances, subIns, starts, totalGoals, goalAssists, totalShots, shotsOnTarget, offsides, foulsCommitted, foulsSuffered, yellowCards, redCards, ownGoals, saves, shotsFaced, goalsConceded, shotAccuracy]
      description: >-
        Every field is nullable. null means the provider did not report the
        statistic for this player's position - it does not mean zero.
      properties:
        appearances: { type: [number, "null"] }
        subIns: { type: [number, "null"] }
        starts: { type: [number, "null"] }
        totalGoals: { type: [number, "null"] }
        goalAssists: { type: [number, "null"] }
        totalShots: { type: [number, "null"] }
        shotsOnTarget: { type: [number, "null"] }
        offsides: { type: [number, "null"], description: "Absent for goalkeepers." }
        foulsCommitted: { type: [number, "null"] }
        foulsSuffered: { type: [number, "null"] }
        yellowCards: { type: [number, "null"] }
        redCards: { type: [number, "null"] }
        ownGoals: { type: [number, "null"] }
        saves: { type: [number, "null"], description: "Goalkeepers only." }
        shotsFaced: { type: [number, "null"], description: "Goalkeepers only." }
        goalsConceded: { type: [number, "null"], description: "Goalkeepers only." }
        shotAccuracy:
          type: [number, "null"]
          description: >-
            Percent, one decimal, computed as shotsOnTarget / totalShots * 100.
            Recomputed here rather than echoed from the provider, which rounds
            to whole percent. null when either input is null or totalShots is 0.
    PlayerBoxScore:
      type: object
      additionalProperties: false
      required: [playerId, player, position, jersey, starter, stats]
      properties:
        playerId: { type: string, description: "Upstream athlete id; the only stable join key." }
        player: { type: string, description: "Display name; not unique." }
        position: { type: string }
        jersey: { type: [string, "null"] }
        starter: { type: boolean }
        stats: { $ref: "#/components/schemas/PlayerMatchStats" }
    TeamBoxScore:
      type: object
      additionalProperties: false
      required: [teamId, players]
      properties:
        teamId: { type: string }
        players:
          type: array
          description: Starters first, then by name.
          items: { $ref: "#/components/schemas/PlayerBoxScore" }
    BoxScore:
      type: object
      additionalProperties: false
      required: [matchId, home, away]
      properties:
        matchId: { type: string }
        home: { $ref: "#/components/schemas/TeamBoxScore" }
        away: { $ref: "#/components/schemas/TeamBoxScore" }
```

In `backend/reader/openapi_test.go`, seed the fake in
`TestOpenAPIValidatesActualRouteResponses` — add to the `fakeReaderStore`
literal:

```go
		boxScore: func() *BoxScore {
			jersey := "10"
			return &BoxScore{
				MatchID: "1",
				Home: TeamBoxScore{TeamID: "arg", Players: []PlayerBoxScore{{
					PlayerID: "1001", Player: "Lionel Messi", Position: "F", Jersey: &jersey, Starter: true,
					Stats: PlayerMatchStats{TotalShots: number(11), ShotsOnTarget: number(3), ShotAccuracy: number(27.3)},
				}}},
				Away: TeamBoxScore{TeamID: "fra", Players: []PlayerBoxScore{}},
			}
		}(),
		boxScoreState: espn.MatchStateFinished,
```

and add the route to that test's table:

```go
		{target: "/v1/matches/1/box-score", template: "/v1/matches/{id}/box-score"},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`. If `TestOpenAPIObjectSchemasAreExact` fails on
`PlayerMatchStats`, the `required` list is missing a property — it must name all
seventeen, `shotAccuracy` included.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_boxscore.go backend/reader/server.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/server_test.go
git commit -m "feat(reader): add the per-match box-score endpoint

Two distinct 404s: an unknown match and a match whose squad has not been
ingested are different facts, and a caller that cannot tell them apart
cannot decide whether to retry. The cache lifetime follows the match
state, so a live box score refreshes on the ten-second cadence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Document the surface, run the full gate, open the PR

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document the new parameters and the two 404s**

In `backend/reader/README.md`, extend the "Query parameters" table that T9.1
added with the two new rows, and append the paragraph below it:

```markdown
| `metric` | `/leaders` | `goals` (default) \| `assists` |
| `limit` | `/leaders` | integer `1..100`; absent means **50** |
```

```markdown
### Leaderboards

`/v1/competitions/{comp}/{season}/leaders` is the general endpoint: `metric`
picks the board and each row reports its count as `value`.
`/v1/competitions/{comp}/{season}/top-scorers` is a **frozen v1 alias** of
`?metric=goals` that reports the same rows with the field named `goals`. It has
consumers, so its path and its shape do not change; new consumers should use
`/leaders`.

The leader default of 50 is what the upstream provider publishes per category —
asking for more cannot return more. The cap of 100 exists because a request
costs one rate-limit token whatever it returns.

### Box scores

`/v1/matches/{id}/box-score` returns one row per player per squad. Every
statistic is nullable: the provider's stat set varies by position, so a
goalkeeper reports `saves` and no `offsides` and an outfielder the reverse, and
`null` means "not applicable to this position" rather than zero. `shotAccuracy`
is **recomputed** from `shotsOnTarget` and `totalShots` to one decimal rather
than echoed — the provider rounds it to whole percent, and we hold the raw
counts.

Two `404`s are distinguishable by message: `match not found` means the id is not
one of ours, and `box score not available for this match` means the match is
ours but no squad has been ingested for it yet. Only the second is worth
retrying. The endpoint never returns empty squads for a match it has no data
for, because two empty player arrays would assert that eleven players each took
zero shots.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. **Docker must be
running** for `reader`, `migrations` round-trip coverage and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/liga-mx/2026/leaders?metric=shots"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/liga-mx/2026/leaders?limit=101"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/not%20an%20id/box-score"
curl -si "http://localhost:8080/v1/competitions/liga-mx/2026/leaders?metric=assists" | head -n 8
curl -s "http://localhost:8080/v1/competitions/liga-mx/2026/top-scorers" | head -c 200
curl -s "http://localhost:8080/v1/matches/401863609/box-score" | head -c 400
curl -s "http://localhost:8080/v1/matches/000000000/box-score"
```

Expected, in order: `400`, `400`, `400`; then a `200` with
`Cache-Control: public, max-age=60` and a JSON array whose rows carry `value`
and `playerId`; then a `top-scorers` array whose rows carry `goals` and **no**
`value` or `playerId`; then a box-score object with `matchId`, `home.teamId`,
`away.teamId` and player rows where a goalkeeper shows `"saves":4` and
`"offsides":null`; then `{"error":"match not found"}`.

If `/leaders?metric=assists` returns `[]`, the ingester has not written assist
rows yet — that is the prerequisite in "Ingester prerequisites", not a bug in
this slice. Confirm with:

```bash
psql "$READER_DSN" -c "SELECT metric, count(*) FROM stat_leader GROUP BY metric"
psql "$READER_DSN" -c "SELECT count(*) FROM match_player_stat"
```

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document the leaderboard and box-score surface

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-leaders-and-box-scores
gh pr create --title "feat(reader): stat leaders by metric and per-match box scores" --body "$(cat <<'EOF'
## What

E1 established that ScoreArc already fetches two datasets and then throws them
away: ESPN returns `goalsLeaders` **and** `assistsLeaders` in the same
`/statistics` response, and every match summary carries a `stats[]` array for
every player in `rosters[].roster[]`. The reader could serve neither.

Adds `GET /v1/competitions/{comp}/{season}/leaders?metric=goals|assists&limit=`
and `GET /v1/matches/{id}/box-score`, plus the schema both need.
`GET /v1/competitions/{comp}/{season}/top-scorers` is unchanged in path and in
shape.

## Approach

`top_scorer` becomes `stat_leader` by **rename**, not by drop-and-recreate. The
rows survive, migration 0003's `DELETE` grant survives with them (grants attach
to the table OID, not its name), and the down migration is a mechanical
reversal that leaves the table answering to `top_scorer` again before 0003's own
down migration revokes on it. `metric` joins the primary key because ranks
restart at 1 per board.

`/top-scorers` is frozen. It has consumers, and E1's `TopScorer` → `StatLeader`
rename is a refactor of TypeScript interfaces, not of the wire format this
service already publishes. The handler projects `StatLeader.Value` back onto
`TopScorer.Goals`; that loop is the entire cost of not breaking anybody.

`match_player_stat` stores its stat bag as `jsonb` because the stat set genuinely
varies by position — goalkeepers carry `saves`, `shotsFaced` and `goalsConceded`
and no `offsides`; outfielders the reverse. Fixed columns would force a
null-or-zero decision at write time and the reader would lose the ability to
distinguish "not applicable" from "zero". Every field in `PlayerMatchStats` is a
pointer for the same reason.

Two deliberate refusals to invent data:

- `shotAccuracy` is **recomputed** from `shotsOnTarget / totalShots`, one
  decimal, and the provider's pre-rounded value is discarded first. ESPN sends
  `30` where the raw counts are 3-of-11 (27.3%). Echoing that would be choosing
  to be less accurate than our own data.
- A match with no player rows returns `404 box score not available for this
  match`, distinct from `404 match not found`. Returning two empty squads would
  assert that eleven players each took zero shots — the same defect class as
  E0's alphabetical champion.

Sides come from `match.home_team_id` / `away_team_id`, never from row order, and
there is an integration test that seeds the away squad first to prove it.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- Migration round trip still ends at zero tables and zero roles with 0005 in the
  chain, in both directions.
- Table tests on `parseMetric` including case variants and `goals;--`.
- Unit tests on `derivePlayerStats`: 3-of-11 becomes 27.3 over a persisted 30,
  and zero shots, an absent numerator, an absent denominator and a
  provider-value-only bag all produce `null` rather than `0`.
- A test that asserts `PlayerMatchStats` serializes all seventeen fields as
  `null` on its zero value, which is what keeps `omitempty` from silently
  breaking the OpenAPI contract test.
- Testcontainers integration coverage for per-metric leaders with restarting
  ranks, nullable team text, the limit, a goalkeeper row with `saves` and no
  `offsides`, an outfielder with `offsides` and no `saves`, and both 404 paths.
- Handler tests assert every invalid parameter returns 400 **and never reaches
  the store**, and that `/top-scorers` still emits `goals` and never `value`.
- OpenAPI contract tests validate both new paths and all five new schemas.

## Not in this PR

The ingester write path. `/leaders?metric=assists` returns `[]` and
`/box-score` returns 404 until it lands. The exact contracts it must satisfy are
listed under "Ingester prerequisites" in the plan.

Plan: `docs/superpowers/plans/2026-08-15-api-leaders-and-box-scores.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** E1's "one fetch serves both boards" → the `metric` column
  and the "Ingester prerequisites" section, which states the single-fetch rule as
  a contract rather than leaving it to be rediscovered. E1's "`TopScorer` becomes
  `StatLeader`, `goals` becomes `value`" → `StatLeader` at the store and
  `/leaders` on the wire, with `/top-scorers` frozen because that rename is a
  frontend concern and this service has consumers. E1's "the box score is
  nullable per stat, per player" → every `PlayerMatchStats` field is `*float64`,
  proven by a goalkeeper row and an outfielder row in the same seeded match.
  E1's "derived percentages get recomputed" → `derivePlayerStats`, with the
  provider value discarded unconditionally so it cannot leak through the branch
  that declines to compute a replacement.
- **Type consistency with the frontend.** `StatLeader` is a superset of
  `types.ts`'s `TopScorer`: same seven fields with `goals` renamed to `value`,
  plus `playerId`. The frontend's E1 rename lands on exactly this shape.
  `PlayerBoxScore` deliberately does **not** reuse `LineupPlayer` — that type
  carries `number: number | null` (a parsed shirt number) where this one carries
  the provider's `jersey` string and an athlete id, and collapsing them would
  force one of the two to lie about what it holds.
- **Two 404s, one response object.** `openapi.yaml` documents a single `NotFound`
  response whose description names both cases, because the schema is identical
  and only the `error` string differs. The distinction is asserted in
  `TestBoxScoreSeparatesAnUnknownMatchFromAnUningestedOne` rather than in the
  document, which is where a message string can actually be checked.
- **The fake's bridge.** `fakeReaderStore.Leaders` falls back to the
  `topScorers` / `topScorersErr` fixtures when no `leaders` fixture is seeded.
  That is not laziness about updating tests: those fixtures describe the goals
  board, the goals board is exactly what `metric=goals` returns, and rewriting
  four call sites to say the same thing in a new type would churn assertions
  that are still correct. If a future slice removes the `/top-scorers` alias,
  delete the bridge and the fixtures together.
- **`Store.BoxScore` returns three values.** The cache lifetime is a property of
  the match, not of the payload. Putting `state` inside `BoxScore` would have
  been tidier at the call site and would have changed a response shape for the
  benefit of a `Cache-Control` header, which is the wrong trade.
- **Interface churn.** `readerStore` loses `TopScorers` and gains `Leaders` and
  `BoxScore`. The sibling `api-*` plans each edit the same interface and the same
  fake, so they should land one at a time rather than in parallel.
- **The down migration deletes rows.** Rolling `stat_leader` back to a
  single-metric `top_scorer` cannot keep the assist rows: the restored
  `(comp_id, season_id, rank)` key has no room for two boards, and leaving them
  would make the key fail on duplicate ranks. `DELETE FROM stat_leader WHERE
  metric <> 'goals'` is stated in the migration with a comment saying so. One
  ingest run rebuilds them.
- **Unresolved: this plan's storage layer collides with the concurrent ingester
  plans.** `2026-08-15-ingester-box-score.md` models per-match player statistics
  as thirteen nullable `int` columns on an `appearance` table;
  `2026-08-15-ingester-season-leaders.md` reserves `0007_leader_category` for the
  same discriminator as `stat_leader.metric`. Both are defensible — fixed columns
  are queryable and typed, a `jsonb` bag survives a provider adding a stat — but
  only one may exist, and it is a user decision rather than a race between two
  agents. Task 1 states the fork and what each branch costs. **Nothing outside
  Task 1 depends on the answer:** every endpoint, handler, response type,
  parameter and test in Tasks 2, 3, 5 and 7 is storage-agnostic, and losing the
  fork costs two SQL constants and one seed block.
- **Deliberately not built.** (a) `?metric=` values beyond goals and assists —
  `parseMetric` and the `metric` column make shots, cards and clean sheets a
  one-line change each, but adding them before E7 asks is YAGNI and would ship
  endpoints that return `[]` forever. (b) A team-level aggregate over
  `match_player_stat` — `match_detail.stats` already holds ESPN's team totals,
  and summing player rows would produce a second, quietly different number for
  the same question. (c) Anything involving xG, shot coordinates or injuries:
  those were probed and are **not** in ESPN's payloads, so there is nothing to
  model. (d) Pagination on `/leaders` — the whole board is 50 rows.
