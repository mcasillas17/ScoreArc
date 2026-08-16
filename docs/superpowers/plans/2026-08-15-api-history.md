# Reader API — History & Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the things ESPN structurally cannot — a table's trajectory over a season, a club's form and streaks, which seasons we actually hold data for, and where a player sits inside a population. ESPN publishes the current table, not yesterday's. Everything in this plan is a read over a series only we have, which is the entire justification for owning the data.

**Architecture:** Eight read models over rows the ingester already writes or is about to. The snapshot tables' daily grain is owned by the ingester write-path plans and **asserted, not created, here**. Form and streaks are computed from finished `match` rows — **they need no snapshots at all** and therefore ship before T7.1 has accumulated anything. Percentiles are a `percent_rank()` window over `player_season_stat`, with the metric passed as a bind parameter rather than interpolated into the statement. Line movement gets the same snapshot shape as win probability, because `open`/`current`/`close` are three readings of one moving quantity. The two heaviest endpoints charge more than one token against the per-IP bucket.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-15-history-and-trends-design.md`
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` — the read half of **T7.1**, **T7.3**, **T7.4** and **T7.5**, and the fact-finding half of E8's **T8.2**
**New roadmap task:** **T10.5** (Epic **E10 · Public API read surface**)
**Branch:** `feat/api-history` off latest `origin/main`
**Prerequisites:** the `api-match-reads` plan (it creates `backend/reader/params.go`). The percentile endpoint additionally needs the `api-players` plan's `player_season_stat` and `player` tables; that endpoint is deliberately the last task so the rest of this plan lands without it.

## Global Constraints

- Extend the existing layering. Routes register in `App.router()`; handlers in `handlers_history.go`; SQL in `store_history.go`; the `readerStore` interface in `server.go` grows and `fakeReaderStore` in `server_test.go` follows it.
- **No string-built SQL, and no exception for the percentile metric.** The metric name is a jsonb key and is passed as a bind parameter (`stats -> $3`), not concatenated. A whitelist plus interpolation would also be safe; a bind parameter is safe without needing the whitelist to be perfect, and the whitelist stays anyway because an unknown metric should 400 rather than return an empty population.
- **Reject, never silently fall back.** An unknown `interval`, an out-of-range `window`, a malformed `range` are all 400s.
- 400 messages are built only from constants in our own code — never `err.Error()` on a dependency error.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go` enforces: every object schema's `required` list equals its complete property list, `additionalProperties: false` everywhere, 200/405/500 (+429) on every GET, and a `Cache-Control` header on **every** documented response. Because `required` must list every property, **no response struct may use `omitempty`**.
- Rate limiting: `a.rateLimit` is router-level and every new route inherits the 10 rps / burst 30 per-IP bucket. Task 7 adds a second, explicit charge on the two endpoints whose response size is a function of season length rather than of a fixed page — see "What is capped, and to what".
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`, `go test -race ./...`. **Docker must be running.**
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Ingester prerequisites

Nothing in this plan invents data. Each read model names exactly what must be written for it to return anything, and every one of them returns an honest empty rather than a fabricated value until it is:

| Endpoint | Needs | Written by |
|---|---|---|
| `/standings/history`, `/standings/movers` | one `standing_snapshot` row per (comp, season, team, **day**), idempotent on re-run | **T7.1** — the task the E7 spec says cannot wait |
| `/form`, `/streaks` | nothing new. Finished `match` rows with non-null scores | already ingested |
| `/seasons` | nothing new. `match`, `standing`, `standing_snapshot` counts | already ingested |
| `/leaders/percentiles` | `player` and `player_season_stat` | the `api-players` plan's ingester prerequisites |
| `/matches/{id}/win-probability` | `win_prob_snapshot` rows during live matches | **T7.6** — `2026-08-15-ingester-win-probability-snapshots.md` |
| `/matches/{id}/odds` | `match_odds` + `odds_snapshot` rows polled while a line is open | **`2026-08-15-ingester-officials-and-odds.md`** (`0009_odds_snapshot`) |

> **Coordination point, stated loudly.** `standing_snapshot` and `win_prob_snapshot` exist in migration `0002_snapshots.up.sql` and **nothing writes to either of them today**. A sibling agent is writing the ingester write-path plans concurrently and **its published ledger owns migrations `0003`–`0010`**, including the daily uniqueness key at `0004_standing_snapshot_idempotency` and the probability key at `0005_win_prob_snapshot_idempotency`. This plan therefore **creates neither** — see Task 1's STOP note. What it does instead is assert the key in its own integration test, because a missing key does not make `/standings/history` fail: it makes it serve two points for one day, and every trend built on it is then quietly wrong. Reconcile the `comp_id` / `competition_id` column naming before either merges.

## What is capped, and to what

| Endpoint | Bound | Worst case |
|---|---|---|
| `/standings/history` | `?range=` capped at 92 days by `parseDateRange`; absent means the last 92 days, never the whole season. Teams bounded by the competition | ~30 teams × 93 days = 2,790 points |
| `/standings/history?interval=week` | downsampled to the last point of each ISO week | ~30 × 14 = 420 points |
| `/standings/movers` | `?window=` 1–92 days, `?limit=` 1–50 (default 10) | 50 rows |
| `/form` | `?window=` 1–20 matches (default 5); teams bounded by the competition | ~30 × 20 = 600 rows |
| `/streaks` | one row per team, streaks of length ≥ 2 only | ~30 × 7 kinds |
| `/seasons` | the competition's registry seasons | a handful |
| `/leaders/percentiles` | `?limit=` 1–200 (default 50), `?minAppearances=` 0–100 (default 3) | 200 rows |
| `/matches/{id}/win-probability` | `?limit=` 1–1000 (default 1000) | 1,000 points |
| `/matches/{id}/odds` | `?limit=` 1–1000 (default 1000), `?provider=`, `?phase=` | 1,000 points |
| rate limit | all `/v1` routes share one 10 rps / burst 30 per-IP bucket; `/standings/history` and `/leaders/percentiles` charge **3 tokens** | 10 history reads before throttling |

---

## File Structure

- **No migrations at all.** `0004_standing_snapshot_idempotency`, `0005_win_prob_snapshot_idempotency` and `0009_odds_snapshot` all belong to the ingester write-path plans. This plan reads them and asserts the invariants its reads depend on (Tasks 1 and 7).
- `backend/reader/store_history.go` — `StandingHistory`, `StandingMovers`, `Form`, `Streaks`, `SeasonCoverage`, `WinProbabilitySeries`, `MatchOdds`.
- `backend/reader/store_percentiles.go` — `LeaderPercentiles`.
- `backend/reader/handlers_history.go` — six handlers.
- `backend/reader/types.go` — the response models (append).
- `backend/reader/params.go` — `parseWindowDays`, `parseWindowMatches`, `parseInterval`, `parsePercentileMetric`, `parseMinAppearances` (append).
- `backend/reader/ratelimit.go` — `AllowCost`.
- `backend/reader/server.go` — interface + seven routes.
- `backend/reader/server_test.go`, `store_integration_test.go`, `migrations_integration_test.go`, `openapi_test.go`, `openapi.yaml`, `README.md`.

---

### Task 1: Verify the snapshot schema this plan reads — do not create it

**Files:**
- Modify: `backend/reader/store_integration_test.go` (seed only)

> ## STOP — schema ownership, read before writing any SQL
>
> An earlier draft of this plan created its own `0008_history_reads` migration
> adding `captured_on` to `standing_snapshot`. **That was wrong on two counts and
> has been replaced by this task.**
>
> **1. The write side owns the schema.** The sibling ingester write-path plans
> publish a migration ledger in
> `docs/superpowers/plans/2026-08-15-ingester-standings-snapshots.md` reserving
> `0003`–`0010`:
>
> | Migration | Owner plan | Task |
> |---|---|---|
> | `0003_player_capture` | `feat/player-identity` branch (unmerged) | — |
> | `0004_standing_snapshot_idempotency` | `2026-08-15-ingester-standings-snapshots.md` | T7.1 |
> | `0005_win_prob_snapshot_idempotency` | `2026-08-15-ingester-win-probability-snapshots.md` | T7.6 |
> | `0006_appearance_box_score` | `2026-08-15-ingester-box-score.md` | T7.7 |
> | `0007_leader_category` | `2026-08-15-ingester-season-leaders.md` | T7.8 |
> | `0008_squad_and_season_stats`, `0009_player_bio` | `2026-08-15-ingester-squad-and-athletes.md` | T7.9, T7.10 |
> | `0010_match_commentary` | `2026-08-15-ingester-commentary.md` | T7.11 |
>
> `0004_standing_snapshot_idempotency` adds **exactly the daily key this plan
> needs**, and `0005_win_prob_snapshot_idempotency` does the same for the
> probability series. A second migration doing the same thing under a different
> number is not a merge conflict — it is two `CREATE UNIQUE INDEX` statements on
> one table, the second of which fails on a live database.
>
> **2. The earlier draft's stated reason was factually wrong.** It claimed a
> generated column was impossible because `captured_at AT TIME ZONE 'UTC'` is
> `STABLE`. It is not: `timezone(text, timestamptz)` is **IMMUTABLE** — it is the
> *implicit* `timestamptz::date` cast, which resolves through the session time
> zone, that is `STABLE`. The ingester plan's `GENERATED ALWAYS AS
> ((captured_at AT TIME ZONE 'UTC')::date) STORED` is both legal and better than
> a writer-supplied column, because a value the writer fills in can disagree with
> the value it was derived from and a generated one cannot.
>
> **So: this plan creates no migration for snapshots.** It verifies the ingester's
> and reads it. If `/standings/history` is wanted before T7.1 lands, land T7.1 —
> that is the correct order anyway, since there is nothing to read until the
> writer runs.
>
> **One open question the executor must resolve, not guess at.** The ingester
> ledger's SQL names the column `competition_id`, because the unmerged
> `feat/canonical-identity-impl` branch renames it. Every SQL constant in
> `backend/reader/store.go` on `origin/main` today uses **`comp_id`**. The SQL in
> this plan is written against `comp_id`, matching what is actually on `main`.
> **Before running Task 2, check which name the applied migrations use and make
> the whole file consistent.** A rename that lands between these two plans is a
> compile error at worst and a silently empty result at best.

- [ ] **Step 1: Confirm the schema you are reading against**

```bash
ls backend/migrations
cd backend && grep -rn "captured_on" migrations/ | head
```

Expected: a `0004_standing_snapshot_idempotency.up.sql` containing
`captured_on` and a unique index over `(…, season_id, team_id, captured_on)`.
**If that file does not exist, T7.1 has not landed — stop and land it first.**
Note whether the index columns say `comp_id` or `competition_id` and use that
name throughout Tasks 2 and 4.

```bash
cd backend && grep -n "0004_standing_snapshot_idempotency\|0005_win_prob_snapshot_idempotency" reader/migrations_integration_test.go reader/store_integration_test.go
```

Expected: both files already listed in both hardcoded migration lists — the
ingester plans add them. **If they are missing, add them there**; this plan's
integration tests cannot run against a schema the test harness never applies.

- [ ] **Step 2: Seed a real series**

Add to `seedIntegrationData` in `backend/reader/store_integration_test.go` — three consecutive days for two teams, with Argentina climbing and France falling, so every later task has something with a direction in it. Note that `captured_on` is generated, so it is **not** in the column list: writing to a generated column is an error, and letting the seed supply it would hide exactly the mismatch the generated column exists to prevent.

```go
		`INSERT INTO standing_snapshot
			(comp_id, season_id, team_id, captured_at, rank, points, goal_difference, played)
		 VALUES
			('world-cup', '2026', 'arg', '2026-07-13T00:00:00Z', 3, 3, 1, 1),
			('world-cup', '2026', 'fra', '2026-07-13T00:00:00Z', 1, 3, 3, 1),
			('world-cup', '2026', 'arg', '2026-07-14T00:00:00Z', 2, 6, 4, 2),
			('world-cup', '2026', 'fra', '2026-07-14T00:00:00Z', 2, 3, 2, 2),
			('world-cup', '2026', 'arg', '2026-07-15T00:00:00Z', 1, 9, 6, 3),
			('world-cup', '2026', 'fra', '2026-07-15T00:00:00Z', 4, 3, 0, 3)`,
		`INSERT INTO win_prob_snapshot (match_id, captured_at, home, draw, away) VALUES
			('match-final', '2026-07-19T19:05:00Z', 40.00, 30.00, 30.00),
			('match-final', '2026-07-19T19:50:00Z', 62.50, 22.50, 15.00)`,
```

- [ ] **Step 3: Prove the daily key is actually enforced**

The ingester plan owns the migration, but this plan owns a read that is wrong if
the key is missing, so assert it here rather than trusting a sibling plan's test.
Append to `backend/reader/store_integration_test.go`:

```go
func TestSnapshotDailyKeyIsEnforced(t *testing.T) {
	_, pool := newIntegrationStore(t)
	ctx := context.Background()
	// The same team, the same season, the same UTC day, a different instant.
	// If this is accepted, /standings/history serves two points for one day and
	// every trend built on it double-counts a re-run.
	if _, err := pool.Exec(ctx, `
		INSERT INTO standing_snapshot
			(comp_id, season_id, team_id, captured_at, rank, points, goal_difference, played)
		VALUES ('world-cup', '2026', 'arg', '2026-07-15T23:59:00Z', 1, 9, 6, 3)`,
	); err == nil {
		t.Fatal("a second snapshot for the same UTC day was accepted")
	}
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestStoreIntegration|TestSnapshotDailyKeyIsEnforced"
```

Expected: `ok`. If `TestSnapshotDailyKeyIsEnforced` fails with "a second snapshot
for the same UTC day was accepted", the applied `0004_standing_snapshot_idempotency`
does not carry the unique index — stop and fix it in the ingester plan, not here.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_integration_test.go
git commit -m "test(reader): pin the snapshot daily key the history reads depend on

The migration belongs to the ingester write-path plan; the read model
breaks silently without it, so the read side asserts it too.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Standings history and movers

**Files:**
- Create: `backend/reader/store_history.go`, `backend/reader/handlers_history.go`
- Modify: `backend/reader/types.go`, `backend/reader/params.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/params_test.go`

**Interfaces:**
- `Store.StandingHistory(ctx, comp, season string, filter HistoryFilter) ([]StandingSeries, error)`
- `Store.StandingMovers(ctx, comp, season string, since time.Time, limit int) ([]Mover, error)`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParseIntervalAndWindows(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]string{"": "day", "day": "day", "week": "week"} {
		got, err := parseInterval(raw)
		if err != nil || got != want {
			t.Fatalf("interval %q = %q, err %v", raw, got, err)
		}
	}
	for _, raw := range []string{"month", "DAY", "daily", "1"} {
		if _, err := parseInterval(raw); err == nil {
			t.Fatalf("interval %q was accepted", raw)
		}
	}

	if days, err := parseWindowDays(""); err != nil || days != 7 {
		t.Fatalf("default window = %d, err %v", days, err)
	}
	if days, err := parseWindowDays("30"); err != nil || days != 30 {
		t.Fatalf("window = %d, err %v", days, err)
	}
	for _, raw := range []string{"0", "-7", "93", "abc", "7.5"} {
		if _, err := parseWindowDays(raw); err == nil {
			t.Fatalf("window %q was accepted", raw)
		}
	}

	if window, err := parseWindowMatches(""); err != nil || window != 5 {
		t.Fatalf("default form window = %d, err %v", window, err)
	}
	for _, raw := range []string{"0", "21", "abc"} {
		if _, err := parseWindowMatches(raw); err == nil {
			t.Fatalf("form window %q was accepted", raw)
		}
	}
}
```

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreStandingHistory(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("one series per team, points in day order", func(t *testing.T) {
		series, err := store.StandingHistory(ctx, "world-cup", "2026", HistoryFilter{Interval: "day"})
		if err != nil {
			t.Fatal(err)
		}
		if len(series) != 2 {
			t.Fatalf("series = %+v", series)
		}
		byTeam := map[string][]StandingPoint{}
		for _, entry := range series {
			byTeam[entry.Team.ID] = entry.Points
		}
		argentina := byTeam["arg"]
		if len(argentina) != 3 || argentina[0].Date != "2026-07-13" || argentina[2].Date != "2026-07-15" {
			t.Fatalf("argentina = %+v", argentina)
		}
		if argentina[0].Rank != 3 || argentina[2].Rank != 1 || argentina[2].Points != 9 {
			t.Fatalf("argentina trajectory = %+v", argentina)
		}
	})

	t.Run("a team filter narrows to one series", func(t *testing.T) {
		series, err := store.StandingHistory(ctx, "world-cup", "2026", HistoryFilter{TeamID: "fra", Interval: "day"})
		if err != nil || len(series) != 1 || series[0].Team.ID != "fra" {
			t.Fatalf("series = %+v, err %v", series, err)
		}
	})

	t.Run("a window narrows the points, not the teams", func(t *testing.T) {
		from := time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)
		to := time.Date(2026, 7, 16, 0, 0, 0, 0, time.UTC)
		series, err := store.StandingHistory(ctx, "world-cup", "2026", HistoryFilter{From: &from, To: &to, Interval: "day"})
		if err != nil || len(series) != 2 || len(series[0].Points) != 1 {
			t.Fatalf("windowed series = %+v, err %v", series, err)
		}
	})

	t.Run("weekly interval keeps the last point of each ISO week", func(t *testing.T) {
		series, err := store.StandingHistory(ctx, "world-cup", "2026", HistoryFilter{TeamID: "arg", Interval: "week"})
		if err != nil {
			t.Fatal(err)
		}
		// 13, 14 and 15 July 2026 are Monday, Tuesday and Wednesday of one ISO
		// week, so a weekly view is that week's last reading.
		if len(series[0].Points) != 1 || series[0].Points[0].Date != "2026-07-15" {
			t.Fatalf("weekly points = %+v", series[0].Points)
		}
	})

	t.Run("a season with no snapshots is empty, not an error", func(t *testing.T) {
		series, err := store.StandingHistory(ctx, "world-cup", "1998", HistoryFilter{Interval: "day"})
		if err != nil || series == nil || len(series) != 0 {
			t.Fatalf("series = %#v, err %v", series, err)
		}
	})
}

func TestStoreStandingMovers(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	movers, err := store.StandingMovers(ctx, "world-cup", "2026", time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(movers) != 2 {
		t.Fatalf("movers = %+v", movers)
	}
	// Argentina went 3rd -> 1st, so a delta of +2 and the biggest climb.
	if movers[0].Team.ID != "arg" || movers[0].RankDelta != 2 || movers[0].PointsGained != 6 {
		t.Fatalf("top mover = %+v", movers[0])
	}
	// France went 1st -> 4th. A faller is a negative delta, never an absolute
	// value: "moved three places" without a direction is not a fact.
	if movers[1].Team.ID != "fra" || movers[1].RankDelta != -3 {
		t.Fatalf("faller = %+v", movers[1])
	}
	if movers[0].FromDate != "2026-07-13" || movers[0].ToDate != "2026-07-15" {
		t.Fatalf("mover window = %+v", movers[0])
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestParseIntervalAndWindows|TestStoreStanding"
```

Expected: FAIL — `undefined: parseInterval`, `undefined: HistoryFilter`, `store.StandingHistory undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/params.go`:

```go
const (
	// maxMoverWindowDays matches the range cap: a "biggest climber this
	// quarter" is the longest window any ScoreArc surface asks for.
	maxMoverWindowDays     = 92
	defaultMoverWindowDays = 7
	// maxFormWindow is twenty matches. Beyond that it stops being form and
	// starts being the season, which the table already tells you.
	maxFormWindow     = 20
	defaultFormWindow = 5
	maxMoverLimit     = 50
	defaultMoverLimit = 10
)

var (
	errInterval    = errors.New("interval must be day or week")
	errWindowDays  = errors.New("window must be an integer between 1 and 92 days")
	errFormWindow  = errors.New("window must be an integer between 1 and 20 matches")
)

// parseInterval validates the standings-history downsampling. "week" keeps the
// last reading of each ISO week, which is what makes a season-long chart
// legible without the server inventing interpolated points.
func parseInterval(raw string) (string, error) {
	switch raw {
	case "", "day":
		return "day", nil
	case "week":
		return "week", nil
	default:
		return "", errInterval
	}
}

func parseWindowDays(raw string) (int, error) {
	if raw == "" {
		return defaultMoverWindowDays, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxMoverWindowDays {
		return 0, errWindowDays
	}
	return value, nil
}

func parseWindowMatches(raw string) (int, error) {
	if raw == "" {
		return defaultFormWindow, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxFormWindow {
		return 0, errFormWindow
	}
	return value, nil
}
```

Append to `backend/reader/types.go`:

```go
// StandingPoint is one team's table position on one day. The date is the
// snapshot's day, not the moment it was taken: a series is a daily grain and
// saying so in the field name stops a consumer reading millisecond precision
// into it.
type StandingPoint struct {
	Date           string `json:"date"` // YYYY-MM-DD, UTC
	Rank           int    `json:"rank"`
	Points         int    `json:"points"`
	GoalDifference int    `json:"goalDifference"`
	Played         int    `json:"played"`
}

type StandingSeries struct {
	Team   espn.Team       `json:"team"`
	Points []StandingPoint `json:"points"`
}

// Mover is a team's movement between the first and last snapshot inside a
// window. RankDelta is signed and positive means climbed; an unsigned "moved
// three places" is not a fact.
type Mover struct {
	Team         espn.Team `json:"team"`
	FromDate     string    `json:"fromDate"`
	ToDate       string    `json:"toDate"`
	FromRank     int       `json:"fromRank"`
	ToRank       int       `json:"toRank"`
	RankDelta    int       `json:"rankDelta"`
	PointsGained int       `json:"pointsGained"`
}
```

Create `backend/reader/store_history.go`:

```go
package main

import (
	"context"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// HistoryFilter is the validated shape of the /standings/history query string.
type HistoryFilter struct {
	From     *time.Time // inclusive day
	To       *time.Time // exclusive day
	TeamID   string     // "" means every team in the season
	Interval string     // "day" or "week"
}

// Bounds are compared as dates, and the parameters are bound as text and cast
// with ::date rather than passed as timestamps. A timestamptz cast to date
// resolves through the session time zone; a text-to-date cast does not, so the
// window means the same thing whatever the connection is set to.
const standingHistorySQL = `
SELECT s.team_id, t.name, t.abbr, t.crest_url,
       s.captured_on, s.rank, s.points, s.goal_difference, s.played
FROM standing_snapshot s
JOIN team t ON t.id = s.team_id
WHERE s.comp_id = $1 AND s.season_id = $2
  AND ($3::text IS NULL OR s.captured_on >= $3::date)
  AND ($4::text IS NULL OR s.captured_on <  $4::date)
  AND ($5::text IS NULL OR s.team_id = $5)
ORDER BY t.name, t.id, s.captured_on`

func dayParam(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.DateOnly)
}

func (s *Store) StandingHistory(ctx context.Context, competition, season string, filter HistoryFilter) ([]StandingSeries, error) {
	var team any
	if filter.TeamID != "" {
		team = filter.TeamID
	}
	rows, err := s.db.Query(ctx, standingHistorySQL,
		competition, season, dayParam(filter.From), dayParam(filter.To), team)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	series := make([]StandingSeries, 0)
	index := make(map[string]int)
	for rows.Next() {
		var teamRow espn.Team
		var point StandingPoint
		var day time.Time
		if err := rows.Scan(
			&teamRow.ID, &teamRow.Name, &teamRow.Abbr, &teamRow.CrestURL,
			&day, &point.Rank, &point.Points, &point.GoalDifference, &point.Played,
		); err != nil {
			return nil, err
		}
		point.Date = day.Format(time.DateOnly)
		position, exists := index[teamRow.ID]
		if !exists {
			series = append(series, StandingSeries{Team: teamRow, Points: []StandingPoint{}})
			position = len(series) - 1
			index[teamRow.ID] = position
		}
		series[position].Points = append(series[position].Points, point)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if filter.Interval == "week" {
		for i := range series {
			series[i].Points = weeklyPoints(series[i].Points)
		}
	}
	return series, nil
}

// weeklyPoints keeps the last reading of each ISO week. Downsampling is a
// selection, never an average: a mean rank across a week is a number no table
// ever showed, and a chart of it would be a chart of nothing.
func weeklyPoints(points []StandingPoint) []StandingPoint {
	weekly := make([]StandingPoint, 0, len(points))
	previousKey := ""
	for _, point := range points {
		day, err := time.Parse(time.DateOnly, point.Date)
		if err != nil {
			continue
		}
		year, week := day.ISOWeek()
		key := time.Date(year, 1, week, 0, 0, 0, 0, time.UTC).Format("2006-002")
		if key == previousKey && len(weekly) > 0 {
			weekly[len(weekly)-1] = point
			continue
		}
		weekly = append(weekly, point)
		previousKey = key
	}
	return weekly
}

// The first and last snapshot inside the window, per team, joined back to the
// rows they came from. min/max over an indexed column beats fetching the whole
// series and folding it in Go for the only thing a digest actually asks: who
// moved.
const standingMoversSQL = `
WITH bounds AS (
  SELECT team_id, min(captured_on) AS from_day, max(captured_on) AS to_day
  FROM standing_snapshot
  WHERE comp_id = $1 AND season_id = $2 AND captured_on >= $3::date
  GROUP BY team_id
)
SELECT b.team_id, t.name, t.abbr, t.crest_url,
       b.from_day, b.to_day,
       first.rank, last.rank, first.points, last.points
FROM bounds b
JOIN team t ON t.id = b.team_id
JOIN standing_snapshot first
  ON first.comp_id = $1 AND first.season_id = $2
 AND first.team_id = b.team_id AND first.captured_on = b.from_day
JOIN standing_snapshot last
  ON last.comp_id = $1 AND last.season_id = $2
 AND last.team_id = b.team_id AND last.captured_on = b.to_day
ORDER BY (first.rank - last.rank) DESC, t.name, t.id
LIMIT $4`

func (s *Store) StandingMovers(ctx context.Context, competition, season string, since time.Time, limit int) ([]Mover, error) {
	rows, err := s.db.Query(ctx, standingMoversSQL,
		competition, season, since.UTC().Format(time.DateOnly), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	movers := make([]Mover, 0)
	for rows.Next() {
		var mover Mover
		var fromDay, toDay time.Time
		var fromPoints, toPoints int
		if err := rows.Scan(
			&mover.Team.ID, &mover.Team.Name, &mover.Team.Abbr, &mover.Team.CrestURL,
			&fromDay, &toDay, &mover.FromRank, &mover.ToRank, &fromPoints, &toPoints,
		); err != nil {
			return nil, err
		}
		mover.FromDate = fromDay.Format(time.DateOnly)
		mover.ToDate = toDay.Format(time.DateOnly)
		// Rank 1 is the top, so a climb is a decrease. The sign is flipped here
		// once so no consumer has to remember which way the table counts.
		mover.RankDelta = mover.FromRank - mover.ToRank
		mover.PointsGained = toPoints - fromPoints
		movers = append(movers, mover)
	}
	return movers, rows.Err()
}
```

Create `backend/reader/handlers_history.go`:

```go
package main

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// historySeriesCost is charged against the per-IP bucket on top of the one
// token the router-level limiter already took. These two endpoints are the only
// ones whose response size scales with the length of a season rather than with
// a fixed page, so they cost more than a scoreboard read. Burst is 30, so a
// client still gets ten of them back to back.
const historySeriesCost = 2

func (a *App) handleStandingHistory(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	query := request.URL.Query()
	filter := HistoryFilter{}

	if raw := query.Get("range"); raw != "" {
		from, to, err := parseDateRange(raw)
		if err != nil {
			writeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		filter.From, filter.To = &from, &to
	} else {
		// No range means the last 92 days, not the whole season. An unbounded
		// default would make the cheapest possible request the most expensive
		// one we serve.
		to := time.Now().UTC().AddDate(0, 0, 1)
		from := to.AddDate(0, 0, -maxRangeDays-1)
		filter.From, filter.To = &from, &to
	}
	if raw := query.Get("team"); raw != "" {
		teamID, err := parseEntityID(raw)
		if err != nil {
			writeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		filter.TeamID = teamID
	}
	interval, err := parseInterval(query.Get("interval"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	filter.Interval = interval

	if !a.limiter.AllowCost(clientIP(request), historySeriesCost) {
		writer.Header().Set("Retry-After", "1")
		writeError(writer, http.StatusTooManyRequests, "rate limit exceeded")
		return
	}

	series, err := a.store.StandingHistory(request.Context(), competition, season, filter)
	if err != nil {
		a.logger.Error("standing history", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if series == nil {
		series = []StandingSeries{}
	}
	// A finished day never changes, so this caches far longer than a live read.
	cacheFor(writer, 300)
	writeJSON(writer, http.StatusOK, series)
}

func (a *App) handleStandingMovers(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	window, err := parseWindowDays(request.URL.Query().Get("window"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := parseLimit(request.URL.Query().Get("limit"), maxMoverLimit)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	rows := defaultMoverLimit
	if limit != nil {
		rows = *limit
	}
	since := time.Now().UTC().AddDate(0, 0, -window)

	movers, err := a.store.StandingMovers(request.Context(), competition, season, since, rows)
	if err != nil {
		a.logger.Error("standing movers", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if movers == nil {
		movers = []Mover{}
	}
	cacheFor(writer, 300)
	writeJSON(writer, http.StatusOK, movers)
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	StandingHistory(context.Context, string, string, HistoryFilter) ([]StandingSeries, error)
	StandingMovers(context.Context, string, string, time.Time, int) ([]Mover, error)
```

(add `"time"` to that file's imports) and register:

```go
			router.Get("/competitions/{comp}/{season}/standings/history", a.handleStandingHistory)
			router.Get("/competitions/{comp}/{season}/standings/movers", a.handleStandingMovers)
```

> chi matches the static segments `history` and `movers` before any wildcard, and `/standings` itself is a separate exact route, so these three coexist without ordering tricks.

In `backend/reader/server_test.go`, add the fields and methods to `fakeReaderStore`:

```go
	history    []StandingSeries
	historyErr error
	movers     []Mover
	moversErr  error
```

```go
func (f *fakeReaderStore) StandingHistory(context.Context, string, string, HistoryFilter) ([]StandingSeries, error) {
	f.calls++
	return f.history, f.historyErr
}

func (f *fakeReaderStore) StandingMovers(context.Context, string, string, time.Time, int) ([]Mover, error) {
	f.calls++
	return f.movers, f.moversErr
}
```

In `backend/reader/openapi.yaml`, add a `HistoricalCacheControl` header, four parameters and two paths. Header, under `components.headers`:

```yaml
    HistoricalCacheControl:
      description: public, max-age=300. A finished day does not change.
      schema: { type: string, example: "public, max-age=300" }
```

Parameters, under `components.parameters`:

```yaml
    TeamFilter:
      name: team
      in: query
      required: false
      description: Restrict to one team id. Absent means every team in the season.
      schema: { type: string, minLength: 1, maxLength: 64 }
    Interval:
      name: interval
      in: query
      required: false
      description: >-
        Series granularity. "week" keeps the last reading of each ISO week; it
        selects points, it never averages them.
      schema: { type: string, enum: [day, week], default: day }
    WindowDays:
      name: window
      in: query
      required: false
      description: Trailing window in days, 1-92.
      schema: { type: integer, minimum: 1, maximum: 92, default: 7 }
    WindowMatches:
      name: window
      in: query
      required: false
      description: Trailing window in matches, 1-20.
      schema: { type: integer, minimum: 1, maximum: 20, default: 5 }
```

Paths:

```yaml
  /v1/competitions/{comp}/{season}/standings/history:
    get:
      operationId: getStandingHistory
      summary: Get each team's table position over time
      description: >-
        One series per team from the daily standings snapshot. Absent range
        means the trailing 92 days, never the whole season. An empty array
        means no snapshots are held yet, which is a real state before the
        snapshot writer has run - it is not a flat line.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/Range" }
        - { $ref: "#/components/parameters/TeamFilter" }
        - { $ref: "#/components/parameters/Interval" }
      responses:
        "200":
          description: One series per team, points in day order
          headers:
            Cache-Control: { $ref: "#/components/headers/HistoricalCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/StandingSeries" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
  /v1/competitions/{comp}/{season}/standings/movers:
    get:
      operationId: getStandingMovers
      summary: Rank and points movement over a trailing window
      description: >-
        Ordered by rank movement, biggest climb first. rankDelta is signed and
        positive means climbed.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/WindowDays" }
        - { $ref: "#/components/parameters/Limit" }
      responses:
        "200":
          description: Movers ordered by rank delta
          headers:
            Cache-Control: { $ref: "#/components/headers/HistoricalCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/Mover" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

Schemas:

```yaml
    StandingPoint:
      type: object
      additionalProperties: false
      required: [date, rank, points, goalDifference, played]
      properties:
        date: { type: string, format: date }
        rank: { type: integer }
        points: { type: integer }
        goalDifference: { type: integer }
        played: { type: integer }
    StandingSeries:
      type: object
      additionalProperties: false
      required: [team, points]
      properties:
        team: { $ref: "#/components/schemas/Team" }
        points: { type: array, items: { $ref: "#/components/schemas/StandingPoint" } }
    Mover:
      type: object
      additionalProperties: false
      required: [team, fromDate, toDate, fromRank, toRank, rankDelta, pointsGained]
      properties:
        team: { $ref: "#/components/schemas/Team" }
        fromDate: { type: string, format: date }
        toDate: { type: string, format: date }
        fromRank: { type: integer }
        toRank: { type: integer }
        rankDelta: { type: integer, description: "Signed; positive means the team climbed." }
        pointsGained: { type: integer }
```

Extend the `openapi_test.go` route table and seed the fake:

```go
		{target: "/v1/competitions/world-cup/2026/standings/history", template: "/v1/competitions/{comp}/{season}/standings/history"},
		{target: "/v1/competitions/world-cup/2026/standings/movers", template: "/v1/competitions/{comp}/{season}/standings/movers"},
```

```go
		history: []StandingSeries{{Team: espn.Team{ID: "arg", Name: "Argentina", Abbr: "ARG"}, Points: []StandingPoint{{Date: "2026-07-15", Rank: 1, Points: 9, GoalDifference: 6, Played: 3}}}},
		movers:  []Mover{{Team: espn.Team{ID: "arg", Name: "Argentina", Abbr: "ARG"}, FromDate: "2026-07-13", ToDate: "2026-07-15", FromRank: 3, ToRank: 1, RankDelta: 2, PointsGained: 6}},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`. `AllowCost` does not exist yet — for now, replace the `a.limiter.AllowCost(...)` call in `handleStandingHistory` with `a.limiter.Allow(clientIP(request))` and restore it in Task 8, or land Task 8 first. Pick one and be consistent; the plan assumes Task 8 lands last and this call is temporarily `Allow`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_history.go backend/reader/handlers_history.go backend/reader/types.go backend/reader/params.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go backend/reader/params_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): serve standings history and movers

The table's trajectory over a season is the first thing ESPN cannot
serve: it publishes the current table, not yesterday's. Weekly
downsampling selects the last reading of each ISO week rather than
averaging, because a mean rank is a number no table ever showed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Form and streaks — computed from results, not snapshots

**Files:**
- Modify: `backend/reader/store_history.go`, `backend/reader/handlers_history.go`, `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`

**Why this task does not depend on Task 1.** The E7 spec lists form under "genuinely gated" on Phase 1, and that is true of the *frontend*, which has no store. The reader already holds every finished match. Last-five is a fold over results, not over snapshots — so `/form` and `/streaks` return real answers the day this ships, with no waiting for a series to accumulate. Say so on the PR; it is the one place this plan beats the roadmap's own sequencing.

- [ ] **Step 1: Write the failing test**

The existing seed has only two world-cup matches, neither finished. Extend `seedIntegrationData` with a finished mini-season so form and streaks have something to fold — three finished matches giving Argentina W, W and a clean sheet run:

```go
		`INSERT INTO match
			(id, comp_id, season_id, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, status_detail, status_name, finalized_at)
		 VALUES
			('form-1', 'world-cup', '2026', '2026-07-01T18:00:00Z', 'finished', 'arg', 'fra', 2, 0, 'FT', 'STATUS_FULL_TIME', now()),
			('form-2', 'world-cup', '2026', '2026-07-05T18:00:00Z', 'finished', 'fra', 'arg', 0, 1, 'FT', 'STATUS_FULL_TIME', now()),
			('form-3', 'world-cup', '2026', '2026-07-09T18:00:00Z', 'finished', 'arg', 'crestless', 3, 3, 'FT', 'STATUS_FULL_TIME', now())`,
```

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreFormAndStreaks(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("form is most recent first and respects the window", func(t *testing.T) {
		forms, err := store.Form(ctx, "world-cup", "2026", 5)
		if err != nil {
			t.Fatal(err)
		}
		byTeam := map[string]TeamForm{}
		for _, entry := range forms {
			byTeam[entry.Team.ID] = entry
		}
		argentina := byTeam["arg"]
		if len(argentina.Form) != 3 {
			t.Fatalf("argentina form = %+v", argentina.Form)
		}
		if argentina.Form[0].MatchID != "form-3" || argentina.Form[0].Result != "D" {
			t.Fatalf("most recent first violated: %+v", argentina.Form[0])
		}
		if argentina.Form[1].Result != "W" || argentina.Form[1].Home {
			t.Fatalf("away win misread: %+v", argentina.Form[1])
		}
		if argentina.Wins != 2 || argentina.Draws != 1 || argentina.Losses != 0 || argentina.Points != 7 {
			t.Fatalf("argentina totals = %+v", argentina)
		}

		narrow, err := store.Form(ctx, "world-cup", "2026", 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range narrow {
			if len(entry.Form) > 1 {
				t.Fatalf("window ignored: %+v", entry)
			}
		}
	})

	t.Run("an unfinished or unscored match never enters form", func(t *testing.T) {
		forms, err := store.Form(ctx, "world-cup", "2026", 20)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range forms {
			for _, played := range entry.Form {
				// match-final is live and match-semi is scheduled; a finished
				// match with null scores would produce a fabricated result.
				if played.MatchID == "match-final" || played.MatchID == "match-semi" {
					t.Fatalf("non-final match in form: %+v", played)
				}
			}
		}
	})

	t.Run("streaks are signed, named and at least two long", func(t *testing.T) {
		streaks, err := store.Streaks(ctx, "world-cup", "2026")
		if err != nil {
			t.Fatal(err)
		}
		byTeam := map[string][]Streak{}
		for _, entry := range streaks {
			byTeam[entry.Team.ID] = entry.Streaks
		}
		kinds := map[string]int{}
		for _, streak := range byTeam["arg"] {
			kinds[streak.Kind] = streak.Length
			if streak.Length < 2 {
				t.Fatalf("a one-match streak is noise: %+v", streak)
			}
		}
		// Unbeaten across all three; the win run stopped at the draw, so it is
		// not reported at all rather than reported as zero.
		if kinds["unbeaten"] != 3 {
			t.Fatalf("unbeaten streak = %d (%+v)", kinds["unbeaten"], byTeam["arg"])
		}
		if _, reported := kinds["win"]; reported {
			t.Fatalf("a broken streak was still reported: %+v", byTeam["arg"])
		}
		if kinds["scoring"] != 3 {
			t.Fatalf("scoring streak = %d", kinds["scoring"])
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreFormAndStreaks
```

Expected: FAIL — `store.Form undefined`, `store.Streaks undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
type FormMatch struct {
	MatchID  string    `json:"matchId"`
	Kickoff  string    `json:"kickoff"`
	Result   string    `json:"result"` // "W" | "D" | "L"
	Opponent espn.Team `json:"opponent"`
	Home     bool      `json:"home"`
	Score    string    `json:"score"` // from this team's perspective, e.g. "2-0"
}

type TeamForm struct {
	Team   espn.Team   `json:"team"`
	Form   []FormMatch `json:"form"` // most recent first
	Wins   int         `json:"wins"`
	Draws  int         `json:"draws"`
	Losses int         `json:"losses"`
	Points int         `json:"points"`
}

// Streak is a run of at least two matches. A run of one is the last result,
// which the form list already carries; reporting it as a "streak" inflates
// noise into a headline.
type Streak struct {
	Kind   string `json:"kind"` // win | unbeaten | loss | winless | clean-sheet | scoring | scoreless
	Length int    `json:"length"`
	Since  string `json:"since"` // ISO kickoff of the run's first match
}

type TeamStreaks struct {
	Team    espn.Team `json:"team"`
	Streaks []Streak  `json:"streaks"`
}
```

Append to `backend/reader/store_history.go`:

```go
// Only finished matches with both scores present. A finished row with a null
// score would otherwise produce a result out of nothing, which is the same
// defect class as ranking a table nobody has played in.
const finishedMatchesSQL = `
SELECT m.id, m.kickoff, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
       ht.name, ht.abbr, ht.crest_url,
       at.name, at.abbr, at.crest_url
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
WHERE m.comp_id = $1 AND m.season_id = $2
  AND m.state = 'finished'
  AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
ORDER BY m.kickoff DESC, m.id DESC`

// playedMatch is the per-team view of one finished result, produced once and
// reused by both Form and Streaks so the two can never disagree about what a
// result was.
type playedMatch struct {
	matchID  string
	kickoff  time.Time
	opponent espn.Team
	home     bool
	scored   int
	conceded int
}

func (p playedMatch) result() string {
	switch {
	case p.scored > p.conceded:
		return "W"
	case p.scored < p.conceded:
		return "L"
	default:
		return "D"
	}
}

// finishedByTeam returns each team's finished matches, most recent first, and
// the teams in a stable order so two calls produce identical output.
func (s *Store) finishedByTeam(ctx context.Context, competition, season string) ([]espn.Team, map[string][]playedMatch, error) {
	rows, err := s.db.Query(ctx, finishedMatchesSQL, competition, season)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	order := make([]espn.Team, 0)
	seen := make(map[string]bool)
	byTeam := make(map[string][]playedMatch)
	for rows.Next() {
		var matchID string
		var kickoff time.Time
		var homeID, awayID string
		var homeScore, awayScore int
		var home, away espn.Team
		if err := rows.Scan(
			&matchID, &kickoff, &homeID, &awayID, &homeScore, &awayScore,
			&home.Name, &home.Abbr, &home.CrestURL,
			&away.Name, &away.Abbr, &away.CrestURL,
		); err != nil {
			return nil, nil, err
		}
		home.ID, away.ID = homeID, awayID
		for _, side := range []struct {
			team     espn.Team
			opponent espn.Team
			atHome   bool
			scored   int
			conceded int
		}{
			{home, away, true, homeScore, awayScore},
			{away, home, false, awayScore, homeScore},
		} {
			if !seen[side.team.ID] {
				seen[side.team.ID] = true
				order = append(order, side.team)
			}
			byTeam[side.team.ID] = append(byTeam[side.team.ID], playedMatch{
				matchID: matchID, kickoff: kickoff, opponent: side.opponent,
				home: side.atHome, scored: side.scored, conceded: side.conceded,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	sort.Slice(order, func(i, j int) bool { return order[i].ID < order[j].ID })
	return order, byTeam, nil
}

func (s *Store) Form(ctx context.Context, competition, season string, window int) ([]TeamForm, error) {
	order, byTeam, err := s.finishedByTeam(ctx, competition, season)
	if err != nil {
		return nil, err
	}
	forms := make([]TeamForm, 0, len(order))
	for _, team := range order {
		played := byTeam[team.ID]
		if len(played) > window {
			played = played[:window]
		}
		entry := TeamForm{Team: team, Form: make([]FormMatch, 0, len(played))}
		for _, match := range played {
			result := match.result()
			entry.Form = append(entry.Form, FormMatch{
				MatchID:  match.matchID,
				Kickoff:  isoTime(match.kickoff),
				Result:   result,
				Opponent: match.opponent,
				Home:     match.home,
				Score:    fmt.Sprintf("%d-%d", match.scored, match.conceded),
			})
			switch result {
			case "W":
				entry.Wins++
				entry.Points += 3
			case "D":
				entry.Draws++
				entry.Points++
			default:
				entry.Losses++
			}
		}
		forms = append(forms, entry)
	}
	return forms, nil
}

// streakRules maps a streak name to the predicate that continues it. Keeping
// the rules in one table means adding "scored in every half" later is a line,
// not a new fold.
var streakRules = []struct {
	kind      string
	continues func(playedMatch) bool
}{
	{"win", func(m playedMatch) bool { return m.scored > m.conceded }},
	{"unbeaten", func(m playedMatch) bool { return m.scored >= m.conceded }},
	{"loss", func(m playedMatch) bool { return m.scored < m.conceded }},
	{"winless", func(m playedMatch) bool { return m.scored <= m.conceded }},
	{"clean-sheet", func(m playedMatch) bool { return m.conceded == 0 }},
	{"scoring", func(m playedMatch) bool { return m.scored > 0 }},
	{"scoreless", func(m playedMatch) bool { return m.scored == 0 }},
}

// minStreak is two. A one-match "streak" is the last result wearing a headline.
const minStreak = 2

func (s *Store) Streaks(ctx context.Context, competition, season string) ([]TeamStreaks, error) {
	order, byTeam, err := s.finishedByTeam(ctx, competition, season)
	if err != nil {
		return nil, err
	}
	all := make([]TeamStreaks, 0, len(order))
	for _, team := range order {
		played := byTeam[team.ID] // already most recent first
		entry := TeamStreaks{Team: team, Streaks: []Streak{}}
		for _, rule := range streakRules {
			length := 0
			for _, match := range played {
				if !rule.continues(match) {
					break
				}
				length++
			}
			if length < minStreak {
				// A broken run is absent, not reported as zero. "Winning
				// streak: 0" is a sentence about nothing.
				continue
			}
			entry.Streaks = append(entry.Streaks, Streak{
				Kind:   rule.kind,
				Length: length,
				Since:  isoTime(played[length-1].kickoff),
			})
		}
		all = append(all, entry)
	}
	return all, nil
}
```

Add `"fmt"` and `"sort"` to `store_history.go`'s imports.

Append the two handlers to `backend/reader/handlers_history.go`, following `handleStandingMovers`'s shape exactly: resolve the competition, parse `window` with `parseWindowMatches` (form only), call the store, normalise nil to an empty slice, `cacheFor(writer, 60)` — form changes the moment a match finishes, so it does not get the historical TTL — and `writeJSON`.

Register both routes in `server.go`, add both to `readerStore`, add `form`/`formErr`/`streaks`/`streaksErr` to `fakeReaderStore` with matching methods, and add both paths, both schemas (`FormMatch`, `TeamForm`, `Streak`, `TeamStreaks`) and both entries in the `openapi_test.go` route table, mirroring Task 2 exactly.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_history.go backend/reader/handlers_history.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): serve form and streaks from finished results

Neither needs a snapshot series: the reader already holds every finished
match, so last-five and current runs are a fold over results and return
real answers the day this ships. A finished match with a null score is
excluded rather than resolved into a fabricated result, and a broken run
is absent rather than reported as zero.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `/seasons` — what we actually hold

**Files:**
- Modify: `backend/reader/store_history.go`, `backend/reader/handlers_history.go`, `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`

**Why.** `SeasonSwitcher.tsx` exists and has nothing to switch to (T7.5). A switcher that offers a season we hold no rows for is worse than one with a single entry, because it produces an empty page that looks broken. This endpoint answers "what can I switch to, and what will I get" in one request: the registry supplies the seasons, the database supplies the coverage, and a season with zero coverage is returned with zeros rather than hidden — hiding it would make a data gap look like a product decision.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreSeasonCoverage(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	coverage, err := store.SeasonCoverage(ctx, "world-cup")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]SeasonCoverage{}
	for _, entry := range coverage {
		byID[entry.SeasonID] = entry
	}
	current, held := byID["2026"]
	if !held {
		t.Fatalf("coverage = %+v", coverage)
	}
	if current.Matches != 5 || current.FinishedMatches != 3 {
		t.Fatalf("2026 counts = %+v", current)
	}
	if current.StandingRows != 2 || current.SnapshotDays != 3 {
		t.Fatalf("2026 coverage = %+v", current)
	}
	if current.FirstKickoff == nil || *current.FirstKickoff != "2026-07-01T18:00:00Z" {
		t.Fatalf("first kickoff = %v", current.FirstKickoff)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreSeasonCoverage
```

Expected: FAIL — `store.SeasonCoverage undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// SeasonCoverage answers "what will I get if I switch to this season". Zeros
// are returned rather than the season being omitted: an absent season looks
// like a product decision, while a season showing zero matches is visibly a
// data gap.
type SeasonCoverage struct {
	SeasonID        string  `json:"seasonId"`
	Label           string  `json:"label"`
	Current         bool    `json:"current"`
	Matches         int     `json:"matches"`
	FinishedMatches int     `json:"finishedMatches"`
	FirstKickoff    *string `json:"firstKickoff"`
	LastKickoff     *string `json:"lastKickoff"`
	StandingRows    int     `json:"standingRows"`
	SnapshotDays    int     `json:"snapshotDays"`
}
```

Append to `backend/reader/store_history.go`:

```go
// Three small aggregates rather than one join: the three tables have no shared
// grain (matches are per fixture, standings per team, snapshots per team-day)
// and joining them would multiply the counts.
const seasonMatchCoverageSQL = `
SELECT season_id, count(*)::int,
       count(*) FILTER (WHERE state = 'finished')::int,
       min(kickoff), max(kickoff)
FROM match WHERE comp_id = $1 GROUP BY season_id`

const seasonStandingCoverageSQL = `
SELECT season_id, count(*)::int FROM standing WHERE comp_id = $1 GROUP BY season_id`

const seasonSnapshotCoverageSQL = `
SELECT season_id, count(DISTINCT captured_on)::int
FROM standing_snapshot WHERE comp_id = $1 GROUP BY season_id`

// SeasonCoverage returns database coverage keyed by season id. The handler
// merges it with the competition registry, which is the source of truth for
// which seasons exist and what they are called.
func (s *Store) SeasonCoverage(ctx context.Context, competition string) (map[string]SeasonCoverage, error) {
	coverage := make(map[string]SeasonCoverage)

	rows, err := s.db.Query(ctx, seasonMatchCoverageSQL, competition)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var entry SeasonCoverage
		var first, last *time.Time
		if err := rows.Scan(&entry.SeasonID, &entry.Matches, &entry.FinishedMatches, &first, &last); err != nil {
			rows.Close()
			return nil, err
		}
		if first != nil {
			opening := isoTime(*first)
			entry.FirstKickoff = &opening
		}
		if last != nil {
			closing := isoTime(*last)
			entry.LastKickoff = &closing
		}
		coverage[entry.SeasonID] = entry
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, query := range []struct {
		sql    string
		assign func(*SeasonCoverage, int)
	}{
		{seasonStandingCoverageSQL, func(entry *SeasonCoverage, count int) { entry.StandingRows = count }},
		{seasonSnapshotCoverageSQL, func(entry *SeasonCoverage, count int) { entry.SnapshotDays = count }},
	} {
		countRows, err := s.db.Query(ctx, query.sql, competition)
		if err != nil {
			return nil, err
		}
		for countRows.Next() {
			var seasonID string
			var count int
			if err := countRows.Scan(&seasonID, &count); err != nil {
				countRows.Close()
				return nil, err
			}
			entry := coverage[seasonID]
			entry.SeasonID = seasonID
			query.assign(&entry, count)
			coverage[seasonID] = entry
		}
		countRows.Close()
		if err := countRows.Err(); err != nil {
			return nil, err
		}
	}
	return coverage, nil
}
```

Add the handler to `handlers_history.go`:

```go
func (a *App) handleSeasons(writer http.ResponseWriter, request *http.Request) {
	competitionID := chi.URLParam(request, "comp")
	competition, known := a.registry.Get(competitionID)
	if !known {
		writeError(writer, http.StatusBadRequest, "unknown competition")
		return
	}
	coverage, err := a.store.SeasonCoverage(request.Context(), competitionID)
	if err != nil {
		a.logger.Error("season coverage", "competition", competitionID, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}

	// The registry decides which seasons exist and what they are called; the
	// database only says how much of each we hold. A season the registry does
	// not list is not offered even if rows exist for it, because a switcher
	// that offers an unconfigured season leads to a page that cannot render.
	seasons := make([]SeasonCoverage, 0, len(competition.Seasons))
	for id, season := range competition.Seasons {
		entry := coverage[id]
		entry.SeasonID = id
		entry.Label = season.Label
		entry.Current = id == competition.CurrentSeasonId
		seasons = append(seasons, entry)
	}
	sort.Slice(seasons, func(i, j int) bool { return seasons[i].SeasonID > seasons[j].SeasonID })
	cacheFor(writer, 300)
	writeJSON(writer, http.StatusOK, seasons)
}
```

Add `"sort"` to that file's imports. Register `router.Get("/competitions/{comp}/seasons", a.handleSeasons)`, add `SeasonCoverage(context.Context, string) (map[string]SeasonCoverage, error)` to `readerStore` and to `fakeReaderStore`, and add the path, the `SeasonCoverage` schema and the `openapi_test.go` table entry (`{target: "/v1/competitions/world-cup/seasons", template: "/v1/competitions/{comp}/seasons"}`).

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): report per-season data coverage

SeasonSwitcher has nothing to switch to, and a switcher that offers a
season we hold no rows for produces an empty page that looks broken. The
registry supplies the seasons, the database supplies the coverage, and a
season with zero coverage is returned with zeros rather than hidden.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The win-probability series

**Files:**
- Modify: `backend/reader/store_history.go`, `backend/reader/handlers_history.go`, `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestStoreWinProbabilitySeries(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	series, err := store.WinProbabilitySeries(ctx, "match-final", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(series) != 2 {
		t.Fatalf("series = %+v", series)
	}
	if series[0].CapturedAt != "2026-07-19T19:05:00Z" || series[0].Home != 40 {
		t.Fatalf("first point = %+v", series[0])
	}
	if series[1].Home != 62.5 || series[1].Away != 15 {
		t.Fatalf("second point = %+v", series[1])
	}

	// A match we captured no samples for is an empty series, not an error and
	// not a 404: "we hold no probability samples" is exactly what an empty
	// time series says, and it is true.
	empty, err := store.WinProbabilitySeries(ctx, "match-semi", 1000)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty series = %#v, err %v", empty, err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreWinProbabilitySeries
```

Expected: FAIL — `store.WinProbabilitySeries undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// WinProbPoint is one market-implied probability reading during a match. The
// values are percentages that sum to about 100, the same convention as the
// WinProbability object served on a match.
type WinProbPoint struct {
	CapturedAt string  `json:"capturedAt"`
	Home       float64 `json:"home"`
	Draw       float64 `json:"draw"`
	Away       float64 `json:"away"`
}
```

Append to `backend/reader/store_history.go`:

```go
// A live match polled every twenty seconds for two hours yields about 360
// points, so the 1000 cap is a guard rather than paging.
const winProbSeriesSQL = `
SELECT captured_at, home::float8, draw::float8, away::float8
FROM win_prob_snapshot
WHERE match_id = $1
ORDER BY captured_at
LIMIT $2`

func (s *Store) WinProbabilitySeries(ctx context.Context, matchID string, limit int) ([]WinProbPoint, error) {
	rows, err := s.db.Query(ctx, winProbSeriesSQL, matchID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	points := make([]WinProbPoint, 0)
	for rows.Next() {
		var point WinProbPoint
		var capturedAt time.Time
		if err := rows.Scan(&capturedAt, &point.Home, &point.Draw, &point.Away); err != nil {
			return nil, err
		}
		point.CapturedAt = isoTime(capturedAt)
		points = append(points, point)
	}
	return points, rows.Err()
}
```

> The `::float8` casts are deliberate: the columns are `numeric(5,2)`, and casting in SQL keeps the Go scan a plain `float64` rather than a `pgtype.Numeric` that every caller would have to unwrap.

Add the handler, validating the id with `parseEntityID` and the limit with `parseLimit(raw, maxWinProbPoints)` where `maxWinProbPoints = 1000` is appended to `params.go`; default to 1000 when absent. Cache with `cacheFor(writer, 60)` — the series grows while a match is live. Register `router.Get("/matches/{id}/win-probability", a.handleWinProbability)`, extend `readerStore` and `fakeReaderStore`, and add the path, the `WinProbPoint` schema and the `openapi_test.go` table entry.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve the in-match win-probability series

win_prob_snapshot has existed since migration 0002 with nothing reading
it and nothing writing it. This is the read half; the write half is the
ingester's emitSnapshots hook.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Per-position percentiles

**Files:**
- Create: `backend/reader/store_percentiles.go`
- Modify: `backend/reader/handlers_history.go`, `backend/reader/types.go`, `backend/reader/params.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/params_test.go`

**Prerequisite:** the `api-players` plan, which creates `player` and `player_season_stat`. This task is last so the rest of the plan ships without it.

> **A correction to the spec, stated rather than papered over.** The E7 spec
> illustrates percentiles with *"top 3% of forwards for shots per 90"*. **Minutes
> played is not in any ESPN payload we have verified** — the athlete and roster
> stat sets carry `appearances`, `subIns` and `starts`, and no minutes. A per-90
> figure therefore cannot be computed, and inventing one from appearances × 90
> would be a fabricated denominator presented as a measurement. This endpoint
> serves a **per-appearance** rate instead and names it `perAppearance`. If a
> minutes source is ever found, `per90` is an additive change.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParsePercentileParameters(t *testing.T) {
	t.Parallel()
	if metric, err := parsePercentileMetric(""); err != nil || metric != "totalGoals" {
		t.Fatalf("default metric = %q, err %v", metric, err)
	}
	for _, metric := range []string{"totalGoals", "goalAssists", "totalShots", "shotsOnTarget", "saves", "foulsCommitted"} {
		if got, err := parsePercentileMetric(metric); err != nil || got != metric {
			t.Fatalf("metric %q = %q, err %v", metric, got, err)
		}
	}
	// The metric is bound as a jsonb key, so an unknown one would quietly
	// return an all-zero population rather than erroring. It must 400.
	for _, metric := range []string{"xG", "minutes", "stats", "totalGoals'", "'; DROP TABLE player"} {
		if _, err := parsePercentileMetric(metric); err == nil {
			t.Fatalf("metric %q was accepted", metric)
		}
	}

	if value, err := parseMinAppearances(""); err != nil || value != 3 {
		t.Fatalf("default minAppearances = %d, err %v", value, err)
	}
	for _, raw := range []string{"-1", "101", "abc"} {
		if _, err := parseMinAppearances(raw); err == nil {
			t.Fatalf("minAppearances %q was accepted", raw)
		}
	}
}
```

Append to `backend/reader/store_integration_test.go` a test that seeds four forwards and two defenders with different goal counts and asserts: the population is partitioned by position (a defender never appears in a forward's population count), `percentile` is 0–100 with the top scorer at 100, `rank` is 1 for the top scorer, `perAppearance` is `value/appearances` and is `null` when appearances is zero, and a player below `minAppearances` is excluded entirely.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestParsePercentileParameters|TestStoreLeaderPercentiles"
```

Expected: FAIL — `undefined: parsePercentileMetric`, `store.LeaderPercentiles undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/params.go`:

```go
// percentileMetrics is the whitelist of jsonb keys a percentile may be taken
// over. The key is bound as a parameter, not interpolated, so this list is not
// what stands between us and injection - it is what turns a typo into a 400
// instead of a population of zeros, which is a far likelier failure.
var percentileMetrics = map[string]bool{
	"totalGoals": true, "goalAssists": true, "totalShots": true,
	"shotsOnTarget": true, "saves": true, "foulsCommitted": true,
}

const defaultPercentileMetric = "totalGoals"

// maxWinProbPoints bounds the in-match probability series. A live match polled
// every twenty seconds for two hours produces about 360 points.
const maxWinProbPoints = 1000

const (
	maxPercentileLimit     = 200
	defaultPercentileLimit = 50
	defaultMinAppearances  = 3
	maxMinAppearances      = 100
)

var (
	errMetric         = errors.New("metric must be one of totalGoals, goalAssists, totalShots, shotsOnTarget, saves, foulsCommitted")
	errMinAppearances = errors.New("minAppearances must be an integer between 0 and 100")
)

func parsePercentileMetric(raw string) (string, error) {
	if raw == "" {
		return defaultPercentileMetric, nil
	}
	if !percentileMetrics[raw] {
		return "", errMetric
	}
	return raw, nil
}

func parseMinAppearances(raw string) (int, error) {
	if raw == "" {
		return defaultMinAppearances, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > maxMinAppearances {
		return 0, errMinAppearances
	}
	return value, nil
}
```

Append to `backend/reader/types.go`:

```go
// PercentileRow places one player inside their position's population for one
// metric. Percentile is 0-100 within Position, not within the competition:
// comparing a goalkeeper's goals against a striker's is not a comparison.
type PercentileRow struct {
	PlayerID      string   `json:"playerId"`
	Player        string   `json:"player"`
	TeamID        *string  `json:"teamId"`
	Position      string   `json:"position"`
	Metric        string   `json:"metric"`
	Value         float64  `json:"value"`
	Appearances   float64  `json:"appearances"`
	PerAppearance *float64 `json:"perAppearance"`
	Percentile    float64  `json:"percentile"`
	Rank          int      `json:"rank"`
	Population    int      `json:"population"`
}
```

Create `backend/reader/store_percentiles.go`:

```go
package main

import "context"

// The metric is a jsonb key bound as $3, never concatenated into the
// statement. jsonb_typeof guards the cast: a stat stored as a string or null
// would otherwise raise "invalid input syntax for type numeric" and turn one
// bad row into a 500 for the whole competition.
const leaderPercentilesSQL = `
WITH population AS (
  SELECT p.player_id,
         pl.name                                    AS player,
         p.team_id,
         COALESCE(pl.position, '')                  AS position,
         COALESCE(CASE WHEN jsonb_typeof(p.stats -> $3::text) = 'number'
                       THEN (p.stats ->> $3::text)::numeric END, 0)::float8 AS value,
         COALESCE(CASE WHEN jsonb_typeof(p.stats -> 'appearances') = 'number'
                       THEN (p.stats ->> 'appearances')::numeric END, 0)::float8 AS appearances
  FROM player_season_stat p
  JOIN player pl ON pl.id = p.player_id
  WHERE p.comp_id = $1 AND p.season_id = $2
)
SELECT player_id, player, team_id, position, value, appearances,
       (percent_rank() OVER (PARTITION BY position ORDER BY value))::float8 * 100 AS percentile,
       (rank()        OVER (PARTITION BY position ORDER BY value DESC))::int      AS position_rank,
       (count(*)      OVER (PARTITION BY position))::int                          AS population
FROM population
WHERE appearances >= $4
  AND ($5::text IS NULL OR position = $5)
ORDER BY value DESC, player, player_id
LIMIT $6`

func (s *Store) LeaderPercentiles(
	ctx context.Context, competition, season, metric string, minAppearances int, position string, limit int,
) ([]PercentileRow, error) {
	var positionFilter any
	if position != "" {
		positionFilter = position
	}
	rows, err := s.db.Query(ctx, leaderPercentilesSQL,
		competition, season, metric, minAppearances, positionFilter, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]PercentileRow, 0)
	for rows.Next() {
		row := PercentileRow{Metric: metric}
		if err := rows.Scan(
			&row.PlayerID, &row.Player, &row.TeamID, &row.Position,
			&row.Value, &row.Appearances, &row.Percentile, &row.Rank, &row.Population,
		); err != nil {
			return nil, err
		}
		// Per appearance, not per 90: minutes played is not in any verified
		// payload, and appearances x 90 would be a fabricated denominator.
		if row.Appearances > 0 {
			rate := row.Value / row.Appearances
			row.PerAppearance = &rate
		}
		results = append(results, row)
	}
	return results, rows.Err()
}
```

> **A note on the population filter.** `appearances >= $4` is applied *after*
> the window functions are computed, so the percentile is taken over every
> player at that position and the filter only decides who is listed. Filtering
> inside the CTE instead would shrink the population and inflate everyone's
> percentile — the same number meaning something different depending on a query
> parameter. Do not move it.

Add the handler to `handlers_history.go`, validating `metric`, `position` (with `parseEntityID`, since positions are provider text), `minAppearances` and `limit` (`maxPercentileLimit`, default `defaultPercentileLimit`), charging `historySeriesCost` against the limiter as `handleStandingHistory` does, and caching for 300 seconds. Register `router.Get("/competitions/{comp}/{season}/leaders/percentiles", a.handleLeaderPercentiles)`. Extend `readerStore`, `fakeReaderStore`, `openapi.yaml` (path, `PercentileRow` schema, a `Metric`, `Position` and `MinAppearances` parameter) and the `openapi_test.go` table.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve per-position percentiles

percent_rank partitioned by position, with the metric bound as a jsonb
key rather than interpolated and jsonb_typeof guarding the cast. Serves
perAppearance rather than per90: minutes played is not in any verified
payload, and appearances x 90 would be a fabricated denominator.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The odds series — line movement is time series, not a field

**Files:**
- **Creates no migration** — the ingester's `0009_odds_snapshot` owns the storage. See the STOP note below.
- Modify: `backend/reader/store_history.go`, `backend/reader/handlers_history.go`, `backend/reader/types.go`, `backend/reader/params.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`, `backend/reader/migrations_integration_test.go`, `backend/reader/store_integration_test.go`

**Verified live 2026-08-15.** ESPN's core host returns `/odds` for a match, carrying **DraftKings and Bet 365** with `open`, `close` and `current` blocks, plus `overUnder`, `spread` and `propBets`.

**Why this belongs in the history plan rather than on the match object.** Line movement is the interesting fact — "the total moved a goal in the hour before kickoff" — and a movement chart is time series, which is what this plan is for.

> ## Correction: `open`, `current` and `close` are not three readings of one series
>
> An earlier draft of this task asserted they were, and modelled them as one
> table with both a `phase` column and a `captured_at`. **That was wrong**, and
> the sibling ingester plan's reasoning is the one to follow:
>
> - `open` and `close` are **facts about the match** that ESPN computes. They do
>   not move. ESPN does not even say *when* the line opened or closed, which is
>   why their column is honestly named `observed_at` — our observation time, not
>   the market's.
> - `current` is **the only one that moves**, and a series exists only because
>   *we* sample it on a cadence.
>
> A single table keyed on `(match, provider, phase, captured_at)` is idempotent
> on neither: a re-poll appends a second "open" row that never changed, and the
> resulting "line movement" chart has three points on it. Their split is correct
> — `match_odds` (open/close, upserted on `(match_id, provider_id, phase)`) plus
> `odds_snapshot` (current, append-only, minute-truncated exactly as
> `win_prob_snapshot` is).
>
> **The wire shape changes with it.** A flat `OddsPoint[]` with a `phase` field
> conflates a fixed fact with a sampled series. Serve the distinction instead:
>
> ```json
> { "matchId": "401863609",
>   "providers": [ { "providerId": "40", "providerName": "DraftKings",
>                    "open": { … } , "close": null,
>                    "current": [ { "capturedAt": "…", … } ] } ] }
> ```
>
> `open` and `close` are nullable single objects; `current` is an array that may
> be empty. Rewrite `OddsPoint`, `matchOddsSQL` and the Step 1 tests below
> against that shape — the tests as written assert the flat one and will need
> reworking, not just renaming.
>
> **Two more things their DDL carries that this draft missed:** `provider_id`
> alongside `provider_name` (so `?provider=` filters on a stable id rather than
> on the display string `"Bet 365"` — the same mistake `typeKey`/`typeText`
> avoids elsewhere in this API), and `over_odds` / `under_odds` beside the
> total. Serve all four.
>
> **And one thing worth stating so nobody "deduplicates" it:** this is not a
> duplicate of `win_prob_snapshot`. That stores the normalised three-way
> probability with the bookmaker margin removed; this stores the raw moneylines
> that derivation is computed *from* — which is what you need to audit it, or to
> compute a closing-line value.

> ## STOP — the ingester owns this schema too
>
> `docs/superpowers/plans/2026-08-15-ingester-officials-and-odds.md` exists and
> **owns the odds schema at migration `0009_odds_snapshot`**, creating
> `match_odds` and `odds_snapshot`. **This task therefore creates no migration.**
> The `0011_match_odds` SQL in Step 3 below is retained only as a statement of
> what the read model needs; **do not run it.** Instead:
>
> 1. Open that plan, read its `0009_odds_snapshot.up.sql`, and rewrite `matchOddsSQL` and the `OddsPoint` scan against its real table and column names. Their split into `match_odds` (per match and provider) plus `odds_snapshot` (the readings) is a normalisation this draft flattened into one table; the **wire shape stays flat**, because a consumer charting a line does not care how we store it.
> 2. Verify with `ls backend/migrations` and `grep -rn "CREATE TABLE odds_snapshot" backend/migrations/`. If `0009_odds_snapshot.up.sql` is absent, that plan has not landed — stop; there is nothing to read.
> 3. Assert on the read side whatever their key is. A missing uniqueness constraint here does not make `/odds` fail, it makes it serve a line that appears to have moved when it was only re-polled — the same silent-doubling failure as the standings snapshots in Task 1.
> 4. Check `match.id`'s type before writing any foreign key: the ingester plans write `match_id uuid REFERENCES match(id)` while `0001_init.up.sql` on `main` declares `match.id text`. Raise the mismatch; do not work around it.
>
> Keep the Step 1 tests, the handler, the parameter validation, the OpenAPI additions and the wire shape exactly as written — only the storage layer is theirs.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreMatchOdds(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("readings come back in capture order across providers", func(t *testing.T) {
		points, err := store.MatchOdds(ctx, "match-final", OddsFilter{Limit: 1000})
		if err != nil {
			t.Fatal(err)
		}
		if len(points) != 3 {
			t.Fatalf("points = %+v", points)
		}
		if points[0].Phase != "open" || points[0].Provider != "DraftKings" {
			t.Fatalf("first reading = %+v", points[0])
		}
		if points[2].Phase != "current" || points[2].OverUnder == nil || *points[2].OverUnder != 3.5 {
			t.Fatalf("last reading = %+v", points[2])
		}
	})

	t.Run("a provider filter narrows without reordering", func(t *testing.T) {
		points, err := store.MatchOdds(ctx, "match-final", OddsFilter{Provider: "Bet 365", Limit: 1000})
		if err != nil || len(points) != 1 || points[0].Provider != "Bet 365" {
			t.Fatalf("filtered = %+v, err %v", points, err)
		}
	})

	t.Run("a missing moneyline is null, never zero", func(t *testing.T) {
		points, err := store.MatchOdds(ctx, "match-final", OddsFilter{Provider: "Bet 365", Limit: 1000})
		if err != nil {
			t.Fatal(err)
		}
		// A book that publishes no draw price has not priced the draw at
		// evens. Zero is a price; absent is not.
		if points[0].DrawMoneyline != nil {
			t.Fatalf("absent draw price materialised: %+v", points[0])
		}
	})

	t.Run("a match with no line is an empty series, not an error", func(t *testing.T) {
		points, err := store.MatchOdds(ctx, "match-semi", OddsFilter{Limit: 1000})
		if err != nil || points == nil || len(points) != 0 {
			t.Fatalf("points = %#v, err %v", points, err)
		}
	})
}
```

Add to `seedIntegrationData`:

```go
		`INSERT INTO match_odds_snapshot
			(match_id, provider, captured_at, phase, home_moneyline, draw_moneyline, away_moneyline, spread, over_under)
		 VALUES
			('match-final', 'DraftKings', '2026-07-18T12:00:00Z', 'open',    -110,  240,  280, -0.50, 2.50),
			('match-final', 'Bet 365',    '2026-07-19T10:00:00Z', 'open',    -120, NULL,  300, -0.50, 3.00),
			('match-final', 'DraftKings', '2026-07-19T18:00:00Z', 'current', -150,  260,  340, -1.00, 3.50)`,
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreMatchOdds
```

Expected: FAIL — `undefined: OddsFilter`, `store.MatchOdds undefined`, and the seed fails with `relation "match_odds_snapshot" does not exist`.

- [ ] **Step 3: Reconcile against the ingester's odds schema**

**Do not create this file.** The SQL below states what the read model needs; the ingester's `0009_odds_snapshot` is what actually exists. Use it as the checklist for reading theirs — every constraint and nullability rule commented here must hold in their version, and where it does not, raise it rather than compensating in Go.

Reference only — `backend/migrations/0011_match_odds.up.sql` as this draft would have written it:

```sql
-- Line movement is a time series, not three fields. ESPN's /odds returns
-- open/current/close per provider; modelled as columns, a consumer can see
-- that a line moved but never when or how fast, and the speed of the move
-- before kickoff is the interesting part.
--
-- Every price column is nullable and that is load-bearing: a book that does
-- not publish a draw price has not priced the draw at zero. The same rule as
-- the per-position box score, for the same reason.
CREATE TABLE match_odds_snapshot (
  match_id       text NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  captured_at    timestamptz NOT NULL,
  phase          text NOT NULL CHECK (phase IN ('open', 'current', 'close')),
  home_moneyline int,
  draw_moneyline int,
  away_moneyline int,
  spread         numeric(5,2),
  over_under     numeric(5,2),
  -- The idempotency key. A twenty-second poll that re-reads an unchanged line
  -- must not add a point to the curve.
  PRIMARY KEY (match_id, provider, phase, captured_at)
);

CREATE INDEX match_odds_snapshot_match_idx
  ON match_odds_snapshot (match_id, captured_at);

GRANT DELETE ON match_odds_snapshot TO scorearc_ingester;
```

Confirm the ingester's migration is in both hardcoded migration lists — `newIntegrationStore` in `store_integration_test.go` and the up/down `files` slice in `migrations_integration_test.go`. Their plan adds it; if it is missing, add it there, because this plan's integration tests cannot run against a schema the harness never applies.

> **Deliberately not stored: `propBets`.** It is an open-ended, provider-specific
> structure with no shape we can validate, and no ScoreArc surface asks for it.
> This is a decision to leave it out, not an oversight to revisit later: if a
> consumer ever needs prop markets, that is a new table with its own shape, not a
> jsonb column added now on the chance it becomes useful.

- [ ] **Step 4: Implement the read model**

Append to `backend/reader/params.go`:

```go
const maxOddsPoints = 1000

var errPhase = errors.New("phase must be open, current or close")

// parseOddsPhase validates ?phase=. Empty means every phase, which is the
// series a movement chart wants.
func parseOddsPhase(raw string) (string, error) {
	switch raw {
	case "", "open", "current", "close":
		return raw, nil
	default:
		return "", errPhase
	}
}
```

Append to `backend/reader/types.go`:

```go
// OddsPoint is one reading of one provider's line. Every price is nullable: a
// book that does not publish a market has not priced it at zero.
type OddsPoint struct {
	Provider       string   `json:"provider"`
	CapturedAt     string   `json:"capturedAt"`
	Phase          string   `json:"phase"` // open | current | close
	HomeMoneyline  *int     `json:"homeMoneyline"`
	DrawMoneyline  *int     `json:"drawMoneyline"`
	AwayMoneyline  *int     `json:"awayMoneyline"`
	Spread         *float64 `json:"spread"`
	OverUnder      *float64 `json:"overUnder"`
}
```

Append to `backend/reader/store_history.go`:

```go
// OddsFilter is the validated shape of the /odds query string.
type OddsFilter struct {
	Provider string
	Phase    string
	Limit    int
}

const matchOddsSQL = `
SELECT provider, captured_at, phase,
       home_moneyline, draw_moneyline, away_moneyline,
       spread::float8, over_under::float8
FROM match_odds_snapshot
WHERE match_id = $1
  AND ($2::text IS NULL OR provider = $2)
  AND ($3::text IS NULL OR phase = $3)
ORDER BY captured_at, provider
LIMIT $4`

func (s *Store) MatchOdds(ctx context.Context, matchID string, filter OddsFilter) ([]OddsPoint, error) {
	var provider, phase any
	if filter.Provider != "" {
		provider = filter.Provider
	}
	if filter.Phase != "" {
		phase = filter.Phase
	}
	rows, err := s.db.Query(ctx, matchOddsSQL, matchID, provider, phase, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	points := make([]OddsPoint, 0)
	for rows.Next() {
		var point OddsPoint
		var capturedAt time.Time
		if err := rows.Scan(
			&point.Provider, &capturedAt, &point.Phase,
			&point.HomeMoneyline, &point.DrawMoneyline, &point.AwayMoneyline,
			&point.Spread, &point.OverUnder,
		); err != nil {
			return nil, err
		}
		point.CapturedAt = isoTime(capturedAt)
		points = append(points, point)
	}
	return points, rows.Err()
}
```

> The `::float8` casts match the win-probability query's reasoning: the columns
> are `numeric(5,2)`, and casting in SQL keeps the Go scan a plain `*float64`
> rather than a `pgtype.Numeric` every caller would have to unwrap.

Add `handleMatchOdds` to `handlers_history.go`, validating the id with
`parseEntityID`, the provider with `parseEntityID` (provider names contain a
space — **use a dedicated check instead: reject anything longer than 32 characters
or containing a character outside letters, digits, space and hyphen**, and add
that as `parseProvider` in `params.go` rather than bending `parseEntityID`), the
phase with `parseOddsPhase` and the limit with `parseLimit(raw, maxOddsPoints)`
defaulting to `maxOddsPoints`. Cache with `cacheFor(writer, 60)` — a line moves
while it is open. Register `router.Get("/matches/{id}/odds", a.handleMatchOdds)`,
extend `readerStore` and `fakeReaderStore`, and add the path, the `OddsPoint`
schema, a `Provider` and `OddsPhase` parameter and the `openapi_test.go` table
entry, exactly as Task 5 did for the probability series.

- [ ] **Step 5: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve line movement as a time series

open/current/close are three readings of one moving quantity. As three
fields a consumer can see that a line moved but never when or how fast,
and the speed of the move before kickoff is the interesting part. Every
price is nullable: a book that does not publish a market has not priced
it at zero.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Weighted rate limiting, docs and the full gate

**Files:**
- Modify: `backend/reader/ratelimit.go`, `backend/reader/ratelimit_test.go`, `backend/reader/README.md`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/ratelimit_test.go`:

```go
func TestAllowCostChargesMultipleTokens(t *testing.T) {
	t.Parallel()
	limiter := newIPRateLimiter(0, 6) // no refill, burst of six
	if !limiter.AllowCost("192.0.2.9", 3) {
		t.Fatal("first weighted request refused")
	}
	if !limiter.AllowCost("192.0.2.9", 3) {
		t.Fatal("second weighted request refused")
	}
	if limiter.AllowCost("192.0.2.9", 1) {
		t.Fatal("bucket was not drained by the weighted requests")
	}
	// Allow stays exactly equivalent to a cost of one.
	if limiter.Allow("192.0.2.10") != true {
		t.Fatal("a fresh client was refused")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestAllowCost
```

Expected: FAIL — `limiter.AllowCost undefined`.

- [ ] **Step 3: Implement**

In `backend/reader/ratelimit.go`, replace `Allow` with a thin wrapper over a weighted form:

```go
// Allow charges one token, the cost of an ordinary read.
func (l *ipRateLimiter) Allow(ip string) bool { return l.AllowCost(ip, 1) }

// AllowCost charges cost tokens. Endpoints whose response size scales with the
// length of a season rather than with a fixed page charge more than one, so a
// client cannot buy an unbounded amount of work at the price of a scoreboard
// read. Cost must stay well under burst: a cost above burst can never succeed.
func (l *ipRateLimiter) AllowCost(ip string, cost int) bool {
	if cost < 1 {
		cost = 1
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	// ... the existing sweep, lookup, eviction and lastSeen body is unchanged ...
	return client.limiter.AllowN(now, cost)
}
```

Restore the `a.limiter.AllowCost(clientIP(request), historySeriesCost)` calls in `handleStandingHistory` and `handleLeaderPercentiles` if they were temporarily `Allow`.

- [ ] **Step 4: Document**

Append to `backend/reader/README.md`:

```markdown
## History endpoints

| Endpoint | Serves | Source |
|---|---|---|
| `/v1/competitions/{comp}/{season}/standings/history` | table trajectory | `standing_snapshot` |
| `/v1/competitions/{comp}/{season}/standings/movers` | biggest climbs and falls over a window | `standing_snapshot` |
| `/v1/competitions/{comp}/{season}/form` | last-N W/D/L per team | finished `match` rows |
| `/v1/competitions/{comp}/{season}/streaks` | current runs of two or more | finished `match` rows |
| `/v1/competitions/{comp}/seasons` | per-season data coverage | registry + counts |
| `/v1/competitions/{comp}/{season}/leaders/percentiles` | per-position percentiles | `player_season_stat` |
| `/v1/matches/{id}/win-probability` | in-match probability series | `win_prob_snapshot` |
| `/v1/matches/{id}/odds` | line movement across providers | `match_odds_snapshot` |

`/form` and `/streaks` need no snapshot series — they are folds over finished
results, so they return real answers immediately. Everything reading
`standing_snapshot` returns an empty series until the daily snapshot writer has
run; an empty series means "no history held", not a flat line, and a consumer
must render it as the former.

`/standings/history` and `/leaders/percentiles` charge **3 tokens** against the
per-IP bucket instead of 1, because their response size is a function of season
length rather than of a fixed page. With a burst of 30 a client still gets ten
back to back.
```

- [ ] **Step 5: Full gate and hand verification**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. Docker must be running.

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/standings/history?interval=month"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/standings/movers?window=400"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/leaders/percentiles?metric=xG"
curl -si "http://localhost:8080/v1/competitions/premier-league/2026-27/form?window=5" | head -n 8
curl -s  "http://localhost:8080/v1/competitions/premier-league/seasons"
```

Expected: `400`, `400`, `400`, then a `200` with `Cache-Control: public, max-age=60` and a form array, then a seasons array with one entry per configured season — including any with zero coverage.

- [ ] **Step 6: Open the PR**

```bash
git add backend/reader/ratelimit.go backend/reader/ratelimit_test.go backend/reader/README.md backend/reader/handlers_history.go
git commit -m "feat(reader): charge the two season-scale reads more than one token

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-history
gh pr create --title "feat(reader): history and trends — the reads ESPN cannot serve" --body "$(cat <<'EOF'
## What

Eight endpoints over data that only exists because we keep it: table
trajectory, movers, form, streaks, per-season coverage, per-position
percentiles, the in-match win-probability series and line movement.

`standing_snapshot` and `win_prob_snapshot` have existed since migration 0002
with nothing writing to them and nothing reading them. This is the read half.

## Approach

**This plan creates no snapshot migration, deliberately.** The write side owns
the schema: `0004_standing_snapshot_idempotency` and
`0005_win_prob_snapshot_idempotency` belong to the ingester write-path plans,
and a second migration adding the same unique index under a different number is
not a merge conflict but a statement that fails on a live database. The read
side asserts the key it depends on in its own integration test instead, because
a missing key does not break this read — it silently doubles it.

> **Coordination:** the ingester's snapshot writer must key on
> `(competition, season, team, captured_on)` with `captured_on` derived from
> `captured_at AT TIME ZONE 'UTC'`. `/standings/history` serves duplicate points
> per day if it does not. Note that the ingester ledger's SQL says
> `competition_id` while `main` says `comp_id`; whichever lands second must make
> the reader's SQL consistent.

**Line movement is a series; `open` and `close` are not part of it.** ESPN
returns all three per provider, but only `current` moves — `open` and `close`
are fixed facts it computes, and ESPN never says when either happened. The
response therefore serves `open` and `close` as nullable single readings and
`current` as a sampled array, rather than flattening all three into one list
with a phase label. An earlier draft of this task got that wrong; the correction
is recorded in the plan rather than quietly applied. `propBets` is deliberately
not stored.

**Form and streaks need no snapshots.** The roadmap lists form under E7's gate,
which is true of the frontend but not of the reader: we already hold every
finished match, so last-five and current runs are a fold over results and return
real answers the day this ships.

**Honesty rules that shaped the shapes.** A broken streak is absent rather than
reported as zero. A faller's `rankDelta` is negative rather than an absolute
value, because "moved three places" without a direction is not a fact. Weekly
downsampling selects the last reading of each ISO week rather than averaging —
a mean rank is a number no table ever showed. A season with no data appears in
`/seasons` with zeros rather than being hidden, because an absent season looks
like a product decision and a zeroed one visibly does not. A finished match with
null scores is excluded from form rather than resolved into a result.

**A correction to the spec, stated rather than worked around.** The E7 spec
illustrates percentiles with "shots per 90". **Minutes played is not in any
verified ESPN payload** — the athlete and roster stat sets carry `appearances`,
`subIns` and `starts`, and no minutes. This serves `perAppearance` and says so.
`per90` is an additive change if a minutes source is ever found.

**Injection surface.** The percentile metric is a jsonb key bound as `$3`, never
concatenated, with `jsonb_typeof` guarding the numeric cast so one badly typed
stat cannot 500 a whole competition. The whitelist stays anyway, so a typo is a
400 rather than a silent population of zeros.

**Rate limiting.** `/standings/history` and `/leaders/percentiles` charge 3
tokens instead of 1: their response size is a function of season length rather
than of a fixed page.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` clean.
- A read-side integration test proves the ingester's daily unique key rejects a
  same-day re-run, because a missing key does not break this read — it silently
  doubles it.
- The odds read is asserted against the ingester's `0009_odds_snapshot`; this
  plan adds no migration of its own.
- Testcontainers coverage for series ordering, team filtering, windowing, weekly
  downsampling, signed mover deltas, form windows, the exclusion of unfinished
  and unscored matches, streak minimum length, per-season coverage counts, the
  empty probability series and percentile partitioning.
- OpenAPI contract tests validate all seven new paths and every new schema.

Plan: `docs/superpowers/plans/2026-08-15-api-history.md`
EOF
)"
```

- [ ] **Step 7: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** T7.1's read side → Tasks 1 and 2. T7.6's read side → Task 5.
  Odds → Task 7, from a live capability probe rather than a spec. T7.3 form → Task 3.
  T7.4 game logs are the `api-players` plan's; T7.4 percentiles → Task 6.
  T7.5 previous seasons → Task 4. E8's T8.2 "SQL finds the fact" → `/movers` and
  `/streaks`, which are precisely the fact-finding queries the digest generator
  reads. E7's "published Brier score" ambition → `/matches/{id}/win-probability`
  is the series a reliability curve would be scored against; the scoring itself
  is not in this plan and is not implied by it.
- **Deliberately not built.** No simulation endpoint. The E7 spec gates that on a
  published Brier score and reliability curve, and neither can be computed until
  a probability series exists — which Task 5 makes readable and the ingester has
  yet to write. No xG-shaped anything. No per-90 (see Task 6).
- **Type consistency.** `HistoryFilter`, `StandingSeries`, `StandingPoint`,
  `Mover`, `TeamForm`, `FormMatch`, `Streak`, `TeamStreaks`, `SeasonCoverage`,
  `WinProbPoint` and `PercentileRow` are each declared once in Tasks 2–6 and
  referenced under those names in the handlers, the fake store and openapi.yaml.
  `parseInterval`, `parseWindowDays`, `parseWindowMatches`,
  `parsePercentileMetric`, `parseMinAppearances`, `maxWinProbPoints`,
  `maxPercentileLimit` and `maxMoverLimit` are added to the `params.go` created
  by the `api-match-reads` plan and are consumed only by handlers in this one.
- **Interface churn.** `readerStore` gains seven methods across this plan, and
  the sibling `api-*` plans add more to the same file. Land them one at a time.
- **The one thing that cannot wait.** Every endpoint here reads correctly the day
  it ships, and three of them return an empty series until the snapshot writer
  runs. That asymmetry is the whole argument of the E7 spec: the reads can be
  built any time, and the writes cannot be backfilled.
