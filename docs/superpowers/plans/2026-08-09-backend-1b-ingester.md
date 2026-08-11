# Backend Slice 1b — Ingester — Implementation Plan

> **Executing without Superpowers:** this is a plain TDD checklist — work tasks
> top-to-bottom, run each step's command, confirm its `expect:`, commit per task.
> Ignore the "sub-skill" convention; any agent can follow it.

**Goal:** A Go worker that polls ESPN, maps every shape to our schema, and upserts
into Neon Postgres — matches, match detail, standings, top scorers, brackets — plus
mirrors team/flag/emblem logos to Cloudflare R2. Finished matches are frozen. This
is the process that starts backing up ESPN data into our own DB.

**Architecture:** Port the existing TS ESPN mappers (`src/server/data/providers/espn-*.ts`)
to Go, fixture-tested against `src/server/data/__fixtures__/` for parity. A pgx repo
layer upserts into the Tier-1 tables and freezes finished matches. A poll loop drives
it on a cadence (fast while any match is live). `emitSnapshots()` is a no-op stub.

**Tech Stack:** Go 1.26, `jackc/pgx/v5` (Postgres), `aws-sdk-go-v2` S3 client (R2),
standard `net/http`. Tests: Go `testing` + fixtures; repo tests via testcontainers
(Docker) OR the live Neon `backend/.env` DSN.

## Write-once / skip rules (don't back up immutable data every cycle)

The ingester must NOT re-fetch or re-write data that can't change. This both keeps
the DB churn-free and kills the N+1 cost of fetching a summary per match per tick.

| Data | Rule |
|---|---|
| **Finished match row** | Frozen: once `state=finished`, write finals + set `finalized_at`, then **never re-upsert** it (skip in the scoreboard write). |
| **Match detail (summary)** | Fetch the summary only when it can change: **live** matches every fast tick; **scheduled** matches once when first seen, then refresh only occasionally (hourly); **finished-not-yet-finalized** once (the final summary) then never again. **Never** fetch a summary for a `finalized_at`-set match. |
| **Logos (R2)** | Mirror once — HEAD the object / check `crest_url` already points at our CDN, then skip. |
| **Dormant comp/season** | A comp/season with **no scheduled or live matches remaining** (e.g. a finished tournament like World Cup 2026) is skipped in the fast loop and only re-checked on a slow cadence (hourly), in case new fixtures appear. |
| **Standings + top scorers** | Only re-fetch when a match **finished since the last cycle** (results actually changed) or on a slow cadence — not every fast tick. |
| **Team metadata** | Upsert is cheap (keep), but the crest **download** is once (above). |

Net effect: a fast tick usually fetches one scoreboard per active comp + summaries
for only the handful of live matches — not a summary for every fixture.

## Global Constraints

- Module `github.com/mcasillas17/scorearc-backend`; ingester under `backend/ingester/`, shared code under `backend/shared/`.
- **Parity is the bar:** Go mapper output must match the TS mappers on the same fixture. When porting, read the TS source AND its `*.test.ts` to copy the exact field logic (winner resolution, shootout parsing, state derivation, etc.).
- Idempotent upserts keyed by ESPN id. Freeze on `state → finished` (set `finalized_at`, stop re-upserting).
- Secrets come from `backend/.env` (gitignored): `DIRECT_DSN`, `POOLED_DSN`, and (for assets) `R2_*`. Never commit them.
- The poll list (comps/seasons + bracket date ranges) comes from `backend/config` (the `Registry` from slice 1a).
- Commit trailer: your own agent identity (see `AGENTS.md`).
- `[no-DB]` tasks are buildable/testable with zero cloud. `[needs-DB]` require `backend/.env` pointing at Neon (or a testcontainers Postgres).

---

## File Structure

```
backend/shared/espn/          Go port of the ESPN client + mappers
  client.go                   HTTP client + endpoint builders (port of endpoints.ts)
  types.go                    domain structs (port of the subset of types.ts we persist)
  matches.go / matches_test.go        port of espn-matches.ts
  summary.go / summary_test.go        port of espn-summary.ts (detail jsonb payloads)
  standings.go / standings_test.go    port of espn-standings.ts
  stats.go / stats_test.go            port of espn-stats.ts (top scorers)
  bracket.go / bracket_test.go        port of espn-bracket.ts
  testdata/                   copies of the relevant src/server/data/__fixtures__/*.json
backend/shared/store/         DB layer
  store.go                    pgx pool + upsert/freeze methods
  store_test.go               repo tests (testcontainers or live DSN)
backend/shared/assets/        R2 logo mirror
  r2.go
backend/ingester/
  main.go                     wiring + the poll loop + cadence + emitSnapshots stub
  loop.go / loop_test.go      cadence logic (fast when any match live)
```

---

### Task 1 [no-DB]: ESPN client + endpoints + domain types

**Files:** `backend/shared/espn/client.go`, `backend/shared/espn/types.go`, copy fixtures into `backend/shared/espn/testdata/`.

- [ ] **Step 1:** Read `src/server/data/endpoints.ts` and `src/server/data/types.ts`. Port the endpoint builders to Go in `client.go`:

```go
package espn

import ("context"; "encoding/json"; "fmt"; "io"; "net/http"; "time")

const site = "https://site.api.espn.com/apis/site/v2/sports/soccer"

func ScoreboardURL(slug, datesRange string) string {
	if datesRange != "" { return fmt.Sprintf("%s/%s/scoreboard?dates=%s", site, slug, datesRange) }
	return fmt.Sprintf("%s/%s/scoreboard", site, slug)
}
func StandingsURL(slug string) string { return fmt.Sprintf("https://site.api.espn.com/apis/v2/sports/soccer/%s/standings", slug) }
func SummaryURL(slug, event string) string { return fmt.Sprintf("%s/%s/summary?event=%s", site, slug, event) }
func BracketURL(slug, datesRange string) string { return ScoreboardURL(slug, datesRange) }
func StatisticsURL(slug string) string { return fmt.Sprintf("%s/%s/statistics", site, slug) }

type Client struct{ HTTP *http.Client }
func New() *Client { return &Client{HTTP: &http.Client{Timeout: 15 * time.Second}} }

func (c *Client) GetJSON(ctx context.Context, url string, out any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "scorearc-ingester")
	res, err := c.HTTP.Do(req)
	if err != nil { return err }
	defer res.Body.Close()
	if res.StatusCode != 200 { b, _ := io.ReadAll(res.Body); return fmt.Errorf("espn %s: %d %s", url, res.StatusCode, string(b[:min(200,len(b))])) }
	return json.NewDecoder(res.Body).Decode(out)
}
```

- [ ] **Step 2:** In `types.go`, define the domain structs we persist (mirror `types.ts` field names/JSON tags for `Match`, `Team`, `Standing`, `TopScorer`, and a `MatchDetail` whose sub-fields are stored as jsonb). Copy the fixtures the mappers will test against from `src/server/data/__fixtures__/` into `testdata/`.
- [ ] **Step 3:** `cd backend && go build ./...` → expect clean. Commit.

---

### Task 2 [no-DB]: matches mapper (parity-tested)

**Files:** `backend/shared/espn/matches.go`, `matches_test.go`.

- [ ] **Step 1 (test-first):** Read `providers/espn-matches.ts` + `espn-matches.test.ts`. Write `matches_test.go` that loads the scoreboard fixture and asserts the mapped `[]Match` matches the TS test's expectations (ids, teams, scores, `state`, `kickoff`, `winner`, `note`). Run → FAIL.
- [ ] **Step 2:** Implement `MapScoreboard(raw json.RawMessage) ([]Match, error)` porting the TS logic exactly (state derivation, winner, note). Run → PASS. Commit.

---

### Task 3 [no-DB]: summary/detail mapper

**Files:** `backend/shared/espn/summary.go`, `summary_test.go`.

- [ ] Port `providers/espn-summary.ts` (scorers, cards, stats, winProbability, shootout, lineups, videos, info, form, h2h, commentary) into a `MapSummary(raw) (MatchDetail, error)` where each sub-shape marshals to the `match_detail` jsonb columns. Test-first against the summary fixture; assert scorers + winProbability + shootout parity with the TS test. PASS → commit.

---

### Task 4 [no-DB]: standings + top-scorers mappers

**Files:** `backend/shared/espn/standings.go` + `_test.go`, `stats.go` + `_test.go`.

- [ ] Port `providers/espn-standings.ts` → `MapStandings(raw) ([]Standing, error)` (rank/played/w/d/l/gf/ga/gd/points/advanced) and `providers/espn-stats.ts` → `MapTopScorers(raw) ([]TopScorer, error)`. Test-first against fixtures; PASS → commit.

---

### Task 5 [no-DB]: bracket mapper

**Files:** `backend/shared/espn/bracket.go`, `bracket_test.go`.

- [ ] Port `providers/espn-bracket.ts` → `MapBracket(raw) ([]BracketMatch, error)` — knockout matches tagged with `round` slugs (the `knockoutRounds` vocabulary) + winner + shootout. Test-first against `espn-bracket*.json` fixtures, asserting round slugs + winner + shootout parity. PASS → commit. (These rows are upserted into `match` in Task 6; the reader reconstructs `BracketRound[]` in slice 1c.)

---

### Task 6 [needs-DB]: store layer — upsert + freeze

**Files:** `backend/shared/store/store.go`, `store_test.go`. Requires `backend/.env` (Neon) or a testcontainers Postgres.

- [ ] **Step 1:** Add `jackc/pgx/v5` (`go get`). Implement a `Store` over a `pgxpool.Pool` with methods: `UpsertTeams`, `UpsertMatch` (+ `finalized_at` freeze: skip UPDATE when the existing row has `finalized_at` set), `UpsertMatchDetail`, `ReplaceStandings(comp,season,[]Standing)`, `ReplaceTopScorers(comp,season,[]TopScorer)`, `LogIngestRun`, and — so the loop can apply the write-once rules — `ExistingMatches(comp,season) (map[string]MatchRow, error)` where `MatchRow` carries `State` and `FinalizedAt sql.Null[time.Time]`. All parameterized SQL — no string building.
- [ ] **Step 2 (test):** `store_test.go` (testcontainers Postgres, or the live `DIRECT_DSN`): apply the migrations, upsert a match twice → one row; set it finished → `finalized_at` set; upsert again → finals unchanged. Run → PASS. Commit.

---

### Task 7 [needs-DB + R2]: asset mirror to R2

**Files:** `backend/shared/assets/r2.go`. Requires the `R2_*` vars in `backend/.env`.

- [ ] Implement `Mirror(ctx, kind, id, srcURL) (cdnURL string, err error)` using the aws-sdk-go-v2 S3 client pointed at the R2 endpoint: HEAD `kind/{id}.png`; if absent, GET `srcURL` and PUT it; return `https://<assets_domain>/kind/{id}.png`. The ingester calls this on first sight of each team/flag/emblem and stores the returned URL in `team.crest_url`. Guard so a mirror failure never blocks the data upsert (log + keep the source URL). Commit.

---

### Task 8 [needs-DB]: poll loop + wiring + local run

**Files:** `backend/ingester/main.go`, `backend/ingester/loop.go`, `loop_test.go`.

- [ ] **Step 1 (test the cadence):** `loop_test.go` — `nextInterval(anyLive bool)` returns the fast interval (~20s) when a match is live, slow (~5m) otherwise. PASS.
- [ ] **Step 2:** `main.go` wires config and applies the **write-once / skip rules** (table above). For each comp/season:
  - **Skip dormant** comps in the fast loop (no scheduled/live match remaining); re-check them only on the slow (hourly) cadence.
  - Fetch scoreboard (current-week range) → map → `UpsertTeams` + `UpsertMatch` (the store skips finalized rows).
  - **Summaries selectively**, not for every match. A helper decides per match:
    ```go
    // needsSummary reports whether to (re)fetch this match's summary this tick.
    func needsSummary(m Match, existing *MatchRow, now time.Time, slowTick bool) bool {
        if existing != nil && existing.FinalizedAt.Valid { return false }   // frozen: never
        switch m.State {
        case "live":      return true                                       // changing
        case "finished":  return existing == nil || !existing.FinalizedAt.Valid // once, at finish
        case "scheduled": return existing == nil || slowTick                 // once, then hourly
        }
        return false
    }
    ```
    For matches where it returns true: fetch summary → `UpsertMatchDetail`; mirror the two teams' logos (once).
  - **Standings + top scorers**: fetch only if a match finished since last cycle (compare states) OR on the slow tick.
  - Fetch bracket (if `hasBracket` and the tournament isn't fully finalized) → upsert knockout matches.
  - Call `emitSnapshots()` (no-op stub). Write an `ingest_run` row. Then `nextInterval(anyLive)` sleep + loop; every Nth tick is a "slow tick" that re-checks dormant comps / refreshes scheduled summaries + standings.
- [ ] **Step 3 (local run):** with `backend/.env` loaded, `cd backend && set -a && . ./.env && set +a && go run ./ingester` for one cycle → verify rows land:
  `psql "$DIRECT_DSN" -c "select comp_id,count(*) from match group by 1;"` (or a Go count) → expect rows for the active competitions. Commit.

---

## Self-Review

- Covers all six shapes (matches, detail, standings, top-scorers, bracket; news is NOT ingested — reader proxies it) + logos. ✓
- Parity enforced via fixture tests against the TS mappers (Tasks 2–5). ✓
- Freeze-on-finish (Task 6), asset idempotency + non-blocking (Task 7), cadence (Task 8). ✓
- `emitSnapshots()` stub only (Phase 2 fills it). ✓
- Tasks 1–5 need no cloud (buildable now); 6–8 need `backend/.env`. ✓
- No placeholders: each task names files, the TS source to port, the test, and the DB check.
