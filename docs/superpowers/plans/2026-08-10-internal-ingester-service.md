# Internal Ingester Service — Implementation Plan (tasks 6–9)

> **Executing without Superpowers:** this is a plain TDD checklist for an autonomous
> coding agent (Codex/Copilot). Work tasks top-to-bottom, run each step's command,
> confirm its `expect:`, commit per task. No other context is assumed — every file
> path, every line of Go, every SQL statement, and every command is spelled out here.

**Goal:** Build the ScoreArc **internal data-ingestion service** — the always-on Go
worker that pulls football data from external sources (ESPN today, others later) and
fills our Neon Postgres. It polls on a cadence (fast while any match is live), maps
every ESPN shape to our schema, and upserts matches, match detail, standings, top
scorers and brackets — **freezing finished matches** — plus mirrors team crests to
Cloudflare R2. This is the process that starts backing up ESPN data into our own DB.

**Architecture:** The ESPN client + mappers already exist under `backend/shared/espn/`
(tasks 1–5, DONE — see *Current state*). This plan adds four layers on top:

1. **Source seam** (`backend/shared/source/`) — a `Source` interface the ingester
   consumes, so ESPN is the *first* implementation and a second source can be dropped
   in later without touching the loop. Only the ESPN adapter is built now (it wraps the
   existing `shared/espn` mappers). No hypothetical sources.
2. **Store** (`backend/shared/store/`) — a `pgxpool`-backed repo over `POOLED_DSN` with
   idempotent, parameterized upserts and freeze-on-finish.
3. **Assets** (`backend/shared/assets/`) — an `aws-sdk-go-v2` S3 client pointed at R2
   that mirrors a crest once (HEAD-then-PUT) and is non-blocking on failure.
4. **Ingester** (`backend/ingester/`) — `main.go` + the poll loop applying all the
   write-once / skip rules, `emitSnapshots()` no-op stub, `ingest_run` logging,
   structured logs, graceful shutdown.

**Tech Stack:** Go 1.26, `github.com/jackc/pgx/v5` (+ `pgxpool`, `pgtype`) for Postgres,
`github.com/aws/aws-sdk-go-v2` (`aws`, `credentials`, `service/s3`) for the R2 mirror,
standard `net/http` + `log/slog`. Tests: Go `testing` — repo tests run against the live
`DIRECT_DSN` (skipped when unset), cadence/predicate tests are pure unit tests.

**Current state (this branch, `feat/backend-handoff`):**
- Tasks 1–5 of `docs/superpowers/plans/2026-08-09-backend-1b-ingester.md` are **DONE &
  committed**: `backend/shared/espn/` holds the client (`client.go`), domain types
  (`types.go`), and five fixture-tested mappers — `MapScoreboard`, `MapSummary`,
  `MapStandings`, `MapTopScorers`, `MapBracket`. Do **not** re-port them.
- The schema is live: `backend/migrations/0001_init.up.sql` (Tier-1 + roles) and
  `0002_snapshots.up.sql` (Tier-3 + `ingest_run`). Applied to Neon per SETUP §5.
- Config is loadable: `backend/config` (`config.Load() → *Registry`) reads the embedded
  `competitions.json` (comps → `ESPNSlug`, `CurrentSeasonId`, `Seasons`).
- **This plan is tasks 6–9** (store, assets, source seam, loop). The original plan's
  "Task 8 — poll loop" is split here: **Task 8** introduces the Source seam the loop
  consumes; **Task 9** is the loop + `main.go` + local run.

---

## Write-once / skip rules (don't back up immutable data every cycle)

The ingester must NOT re-fetch or re-write data that can't change. This keeps the DB
churn-free and kills the N+1 cost of fetching a summary per match per tick.

| Data | Rule |
|---|---|
| **Finished match row** | Frozen: once `state=finished`, write finals + set `finalized_at`, then **never re-upsert** it (the `UpsertMatch` SQL guards the UPDATE with `WHERE match.finalized_at IS NULL`). |
| **Match detail (summary)** | Fetch the summary only when it can change: **live** matches every fast tick; **scheduled** matches once when first seen, then refresh only on the slow tick; **finished-not-yet-finalized** once (the final summary) then never again. **Never** fetch a summary for a `finalized_at`-set match. This is `needsSummary()`. |
| **Logos (R2)** | Mirror once — HEAD the object; if present, skip the download. Skip entirely if `team.crest_url` already points at our CDN base. |
| **Dormant comp/season** | A comp/season with **no scheduled or live matches remaining** (e.g. a finished tournament) is skipped in the fast loop and only re-checked on the slow (5-minute) tick, in case new fixtures appear. Tracked per comp/season in `ingester.active`. |
| **Standings + top scorers** | Only re-fetch when a match **finished since the last cycle** (results actually changed) or on the slow tick — not every fast tick. |
| **Team metadata** | Upsert is cheap (keep); `crest_url` is preserved once set (`COALESCE(team.crest_url, EXCLUDED.crest_url)`) so the mirrored CDN URL is never clobbered by a raw ESPN URL. The crest **download** is once (above). |

Net effect: a fast tick usually fetches one scoreboard per active comp + summaries for
only the handful of live matches — not a summary for every fixture.

---

## Global Constraints

- Module `github.com/mcasillas17/scorearc-backend` (go.mod at `backend/go.mod`, so import
  paths are `github.com/mcasillas17/scorearc-backend/config`,
  `.../shared/espn`, `.../shared/store`, etc.). Ingester binary under
  `backend/ingester/` (package `main`); shared libraries under `backend/shared/`.
- **Idempotent upserts keyed by ESPN id.** Freeze on `state → finished` (set
  `finalized_at`, stop re-upserting).
- **All SQL parameterized** — no string building.
- Secrets come from `backend/.env` (gitignored): `DIRECT_DSN`, `POOLED_DSN`, and
  `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET`/
  `R2_PUBLIC_BASE_URL` (this plan adds the last one — Task 7). Never commit them.
- The poll list (comps/seasons + bracket date ranges) comes from `backend/config`.
- Services connect on the **pooled** DSN (`POOLED_DSN`); migrations/ops use `DIRECT_DSN`.
- Commit trailer: `Co-Authored-By: Codex <noreply@openai.com>` (the executing agent's
  own identity).
- `[no-DB]` tasks build/test with zero cloud. `[needs-DB]` require `backend/.env`
  pointing at Neon; those tests **skip** cleanly when the DSN env var is unset.

---

## File Structure (added by this plan)

```
backend/shared/store/
  store.go        pgxpool + upsert/freeze/replace methods + LogIngestRun
  store_test.go   repo tests against DIRECT_DSN (skip if unset)
backend/shared/assets/
  r2.go           aws-sdk-go-v2 S3 client at the R2 endpoint; Mirror()
backend/shared/source/
  source.go       the Source interface (the seam)
  espn.go         the ESPN adapter wrapping shared/espn mappers
backend/ingester/
  main.go         wiring + per-comp/season pipeline + graceful shutdown + emitSnapshots
  loop.go         nextInterval() cadence + needsSummary() predicate
  loop_test.go    unit tests for both (no DB)
```

Reference (already present, do not modify): `backend/shared/espn/{client,types,matches,
summary,standings,stats,bracket}.go`, `backend/config/config.go`,
`backend/migrations/0001_init.up.sql`, `0002_snapshots.up.sql`.

### Real signatures this plan wires (verified against the committed code)

```go
// backend/shared/espn/client.go
func New() *espn.Client
func (c *espn.Client) GetJSON(ctx context.Context, url string, out any) error
func espn.ScoreboardURL(slug, datesRange string) string
func espn.StandingsURL(slug string) string
func espn.SummaryURL(slug, event string) string
func espn.BracketURL(slug, datesRange string) string
func espn.StatisticsURL(slug string) string

// backend/shared/espn/{matches,summary,standings,stats,bracket}.go
func espn.MapScoreboard(raw []byte) ([]espn.Match, error)
func espn.MapSummary(raw []byte) (espn.MatchDetail, error)
func espn.MapStandings(raw []byte) ([]espn.Standing, error)
func espn.MapTopScorers(raw []byte, limit int) ([]espn.TopScorer, error)  // note: limit param
func espn.MapBracket(raw []byte) ([]espn.BracketMatch, error)
```

Domain types (`espn.Match`, `espn.Team`, `espn.Standing`, `espn.TopScorer`,
`espn.MatchDetail`, `espn.BracketMatch`, `espn.BracketTeam`) and the `espn.MatchState`
constants (`MatchStateScheduled`/`MatchStateLive`/`MatchStateFinished`) live in
`backend/shared/espn/types.go` — read it; the store and loop persist those exact shapes.

**Top-scorer team is denormalized.** `espn.TopScorer` carries `TeamAbbr`/`TeamName`/
`TeamCrestURL` (no team id), so the `top_scorer` table stores those columns directly
(`team_abbr`/`team_name`/`team_crest_url`) — matching the ESPN data and the frontend
`TopScorer` type. `ReplaceTopScorers` inserts them; there is no `team_id` FK to resolve.

---

### Task 6 [needs-DB]: store layer — upsert + freeze

**Files:** `backend/shared/store/store.go`, `backend/shared/store/store_test.go`.
Requires `backend/.env` (Neon). The test **skips** when `DIRECT_DSN` is unset.

- [ ] **Step 1:** Add pgx.

```bash
cd backend && go get github.com/jackc/pgx/v5@latest
# expect: go: added github.com/jackc/pgx/v5 vX.Y.Z  (+ its deps)
```

- [ ] **Step 2:** Write `backend/shared/store/store.go` — **complete**:

```go
// Package store is the ingester's Postgres repo layer: a pgxpool over the
// pooled Neon DSN with idempotent, parameterized upserts for the Tier-1
// tables plus freeze-on-finish. All SQL is parameterized — no string building.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// Store wraps a pgxpool.Pool. Construct with New; call Close when done.
type Store struct{ pool *pgxpool.Pool }

// New opens a pool on dsn (the pooled DSN) and verifies connectivity.
func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// MatchRow is the freeze/change-detection view of a persisted match: its
// current state and whether it has been finalized. Used by the loop's
// needsSummary predicate and its "finished since last cycle" detection.
type MatchRow struct {
	State       string
	FinalizedAt pgtype.Timestamptz
}

// teamUpsertSQL preserves an already-stored crest_url (once the R2/CDN URL is
// written by SetTeamCrest, a later raw ESPN URL must not clobber it) — hence
// COALESCE(team.crest_url, EXCLUDED.crest_url): keep existing, fill only if null.
const teamUpsertSQL = `
INSERT INTO team (id, name, abbr, crest_url, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (id) DO UPDATE SET
	name       = EXCLUDED.name,
	abbr       = EXCLUDED.abbr,
	crest_url  = COALESCE(team.crest_url, EXCLUDED.crest_url),
	updated_at = now()`

// UpsertTeams upserts a batch of teams. Safe to call with duplicate ids.
func (s *Store) UpsertTeams(ctx context.Context, teams []espn.Team) error {
	if len(teams) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	for _, t := range teams {
		b.Queue(teamUpsertSQL, t.ID, t.Name, t.Abbr, t.CrestURL)
	}
	return s.pool.SendBatch(ctx, b).Close()
}

// SetTeamCrest force-sets a team's crest_url to our CDN URL after a successful
// R2 mirror. This is the one path allowed to overwrite crest_url.
func (s *Store) SetTeamCrest(ctx context.Context, id, cdnURL string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE team SET crest_url = $2, updated_at = now() WHERE id = $1`,
		id, cdnURL)
	return err
}

// matchUpsertSQL is idempotent by ESPN id and enforces the freeze:
//   - finalized_at is set the moment state first becomes 'finished';
//   - the DO UPDATE is guarded by WHERE match.finalized_at IS NULL, so a
//     finalized row is never modified again (immutable history);
//   - round is preserved when the incoming value is empty (COALESCE +
//     NULLIF), so a bracket-assigned round slug is not wiped by a later
//     scoreboard upsert that carries an empty round.
// kickoff is passed as the raw ESPN ISO string and cast in-DB to timestamptz.
const matchUpsertSQL = `
INSERT INTO match (
	id, comp_id, season_id, round, kickoff, state,
	home_team_id, away_team_id, home_score, away_score,
	minute, status_detail, status_name, winner_id, note,
	finalized_at, updated_at)
VALUES (
	$1, $2, $3, $4, $5::timestamptz, $6,
	$7, $8, $9, $10,
	$11, $12, $13, $14, $15,
	CASE WHEN $6 = 'finished' THEN now() ELSE NULL END, now())
ON CONFLICT (id) DO UPDATE SET
	comp_id       = EXCLUDED.comp_id,
	season_id     = EXCLUDED.season_id,
	round         = COALESCE(NULLIF(EXCLUDED.round, ''), match.round),
	kickoff       = EXCLUDED.kickoff,
	state         = EXCLUDED.state,
	home_team_id  = EXCLUDED.home_team_id,
	away_team_id  = EXCLUDED.away_team_id,
	home_score    = EXCLUDED.home_score,
	away_score    = EXCLUDED.away_score,
	minute        = EXCLUDED.minute,
	status_detail = EXCLUDED.status_detail,
	status_name   = EXCLUDED.status_name,
	winner_id     = EXCLUDED.winner_id,
	note          = EXCLUDED.note,
	finalized_at  = CASE
		WHEN match.finalized_at IS NOT NULL THEN match.finalized_at
		WHEN EXCLUDED.state = 'finished'    THEN now()
		ELSE NULL END,
	updated_at    = now()
WHERE match.finalized_at IS NULL`

// UpsertMatch upserts one match under (comp, season). Callers must have
// upserted m.Home and m.Away first (FK) — the loop does via UpsertTeams.
// A finalized row is left untouched (see matchUpsertSQL).
func (s *Store) UpsertMatch(ctx context.Context, comp, season string, m espn.Match) error {
	var round any
	if m.Round != "" {
		round = m.Round
	}
	_, err := s.pool.Exec(ctx, matchUpsertSQL,
		m.ID, comp, season, round, m.Kickoff, string(m.State),
		m.Home.ID, m.Away.ID, m.HomeScore, m.AwayScore,
		m.Minute, m.StatusDetail, m.StatusName, m.WinnerID, m.Note)
	return err
}

// UpsertMatchDetail writes the jsonb detail for a match. Array columns default
// to '[]' (never SQL NULL); the optional object columns are SQL NULL when the
// corresponding pointer is nil. jsonb params are passed as strings so pgx
// sends them as text for Postgres to parse into jsonb.
func (s *Store) UpsertMatchDetail(ctx context.Context, matchID string, d espn.MatchDetail) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO match_detail (
	match_id, scorers, cards, stats, win_probability,
	shootout, shootout_detail, lineups, videos, info,
	form, h2h, commentary, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
ON CONFLICT (match_id) DO UPDATE SET
	scorers         = EXCLUDED.scorers,
	cards           = EXCLUDED.cards,
	stats           = EXCLUDED.stats,
	win_probability = EXCLUDED.win_probability,
	shootout        = EXCLUDED.shootout,
	shootout_detail = EXCLUDED.shootout_detail,
	lineups         = EXCLUDED.lineups,
	videos          = EXCLUDED.videos,
	info            = EXCLUDED.info,
	form            = EXCLUDED.form,
	h2h             = EXCLUDED.h2h,
	commentary      = EXCLUDED.commentary,
	updated_at      = now()`,
		matchID,
		jsonArr(d.Scorers), jsonArr(d.Cards),
		jsonPtr(d.Stats), jsonPtr(d.WinProbability),
		jsonPtr(d.Shootout), jsonPtr(d.ShootoutDetail),
		jsonPtr(d.Lineups), jsonArr(d.Videos),
		jsonPtr(d.Info), jsonPtr(d.Form),
		jsonArr(d.H2H), jsonArr(d.Commentary))
	return err
}

// ReplaceStandings replaces the full standings table for (comp, season) in one
// transaction: ensure the teams exist, delete the old rows, insert the new set
// (incl. group_id/group_name). "Replace" (not upsert) so a demoted/removed team
// disappears cleanly.
func (s *Store) ReplaceStandings(ctx context.Context, comp, season string, rows []espn.Standing) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, st := range rows {
		if _, err := tx.Exec(ctx, teamUpsertSQL,
			st.Team.ID, st.Team.Name, st.Team.Abbr, st.Team.CrestURL); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM standing WHERE comp_id = $1 AND season_id = $2`, comp, season); err != nil {
		return err
	}
	for _, st := range rows {
		if _, err := tx.Exec(ctx, `
INSERT INTO standing (
	comp_id, season_id, team_id, group_id, group_name, rank,
	played, wins, draws, losses, goals_for, goals_against,
	goal_difference, points, advanced, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
			comp, season, st.Team.ID, st.GroupID, st.GroupName, st.Rank,
			st.Played, st.Wins, st.Draws, st.Losses, st.GoalsFor, st.GoalsAgainst,
			st.GoalDifference, st.Points, st.Advanced); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ReplaceTopScorers replaces the top_scorer rows for (comp, season). The team is
// stored denormalized (abbr/name/crest) — espn.TopScorer carries no team id.
func (s *Store) ReplaceTopScorers(ctx context.Context, comp, season string, rows []espn.TopScorer) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM top_scorer WHERE comp_id = $1 AND season_id = $2`, comp, season); err != nil {
		return err
	}
	for _, ts := range rows {
		if _, err := tx.Exec(ctx, `
INSERT INTO top_scorer (comp_id, season_id, rank, player, team_abbr, team_name, team_crest_url, goals, matches)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			comp, season, ts.Rank, ts.Player, ts.TeamAbbr, ts.TeamName, ts.TeamCrestURL, ts.Goals, ts.Matches); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UpsertBracketMatches upserts knockout matches into the same `match` table as
// scoreboard fixtures, tagged with their round slug. Each bracket leg's team
// (real or placeholder — the mapper always sets a non-empty ESPN team id) is
// upserted first to satisfy the FK, then the match via the shared UpsertMatch
// (so freeze + round-preservation apply identically).
func (s *Store) UpsertBracketMatches(ctx context.Context, comp, season string, bms []espn.BracketMatch) error {
	for _, bm := range bms {
		home := espn.Team{ID: bm.Home.ID, Name: bm.Home.Name, Abbr: bm.Home.Abbr, CrestURL: bm.Home.CrestURL}
		away := espn.Team{ID: bm.Away.ID, Name: bm.Away.Name, Abbr: bm.Away.Abbr, CrestURL: bm.Away.CrestURL}
		if err := s.UpsertTeams(ctx, []espn.Team{home, away}); err != nil {
			return err
		}
		m := espn.Match{
			ID:           bm.ID,
			Kickoff:      bm.Kickoff,
			State:        bm.State,
			Round:        bm.Round,
			Minute:       bm.Minute,
			StatusDetail: bm.StatusDetail,
			StatusName:   bm.StatusName,
			Home:         home,
			Away:         away,
			HomeScore:    bm.HomeScore,
			AwayScore:    bm.AwayScore,
			WinnerID:     bm.WinnerID,
			Note:         bm.Note,
		}
		if err := s.UpsertMatch(ctx, comp, season, m); err != nil {
			return err
		}
	}
	return nil
}

// ExistingMatches returns the persisted state+finalized_at for every match under
// (comp, season), keyed by match id. Feeds the loop's needsSummary predicate and
// its "finished since last cycle" change detection.
func (s *Store) ExistingMatches(ctx context.Context, comp, season string) (map[string]MatchRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, state, finalized_at FROM match WHERE comp_id = $1 AND season_id = $2`,
		comp, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]MatchRow)
	for rows.Next() {
		var id string
		var r MatchRow
		if err := rows.Scan(&id, &r.State, &r.FinalizedAt); err != nil {
			return nil, err
		}
		out[id] = r
	}
	return out, rows.Err()
}

// LogIngestRun records one ingest operation for observability. compID is
// optional (nil for a whole-cycle marker); errMsg "" is stored as SQL NULL.
func (s *Store) LogIngestRun(ctx context.Context, compID *string, kind string, startedAt, finishedAt time.Time, ok bool, errMsg string) error {
	var e any
	if errMsg != "" {
		e = errMsg
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO ingest_run (comp_id, kind, started_at, finished_at, ok, error)
VALUES ($1, $2, $3, $4, $5, $6)`,
		compID, kind, startedAt, finishedAt, ok, e)
	return err
}

// jsonArr marshals a slice for a NOT NULL jsonb column; nil/"null" becomes "[]".
func jsonArr(v any) string {
	b, err := json.Marshal(v)
	if err != nil || string(b) == "null" {
		return "[]"
	}
	return string(b)
}

// jsonPtr marshals a pointer for a nullable jsonb column; a nil pointer becomes
// SQL NULL (returned as a nil interface).
func jsonPtr(v any) any {
	rv := reflect.ValueOf(v)
	if !rv.IsValid() || (rv.Kind() == reflect.Ptr && rv.IsNil()) {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return string(b)
}
```

- [ ] **Step 3:** `cd backend && go build ./...`

```bash
cd backend && go build ./...
# expect: (clean — no output, exit 0)
```

- [ ] **Step 4 (test — freeze + idempotency):** Write `backend/shared/store/store_test.go`.
  It runs in package `store` (so it can reach `s.pool` for cleanup), uses synthetic
  `test-*` ids it deletes before and after, and **skips** when `DIRECT_DSN` is unset. It
  assumes the schema is already migrated (SETUP §5).

```go
package store

import (
	"context"
	"os"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func intp(n int) *int { return &n }

func TestUpsertMatchIdempotencyAndFreeze(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set — skipping DB repo test")
	}
	ctx := context.Background()
	st, err := New(ctx, dsn)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	const comp, season, matchID = "test-comp", "test-season", "test-m1"
	teamIDs := []string{"test-home", "test-away"}

	clean := func() {
		st.pool.Exec(ctx, `DELETE FROM match_detail WHERE match_id = $1`, matchID)
		st.pool.Exec(ctx, `DELETE FROM match WHERE id = $1`, matchID)
		st.pool.Exec(ctx, `DELETE FROM standing WHERE comp_id = $1`, comp)
		st.pool.Exec(ctx, `DELETE FROM top_scorer WHERE comp_id = $1`, comp)
		st.pool.Exec(ctx, `DELETE FROM team WHERE id = ANY($1)`, teamIDs)
	}
	clean()
	t.Cleanup(clean)

	home := espn.Team{ID: "test-home", Name: "Home FC", Abbr: "HOM"}
	away := espn.Team{ID: "test-away", Name: "Away FC", Abbr: "AWY"}
	if err := st.UpsertTeams(ctx, []espn.Team{home, away}); err != nil {
		t.Fatalf("UpsertTeams: %v", err)
	}

	scheduled := espn.Match{
		ID: matchID, Kickoff: "2026-06-11T18:00Z", State: espn.MatchStateScheduled,
		Home: home, Away: away,
	}
	if err := st.UpsertMatch(ctx, comp, season, scheduled); err != nil {
		t.Fatalf("UpsertMatch scheduled: %v", err)
	}
	// Idempotent: a second identical upsert must not create a second row.
	if err := st.UpsertMatch(ctx, comp, season, scheduled); err != nil {
		t.Fatalf("UpsertMatch scheduled #2: %v", err)
	}
	var count int
	if err := st.pool.QueryRow(ctx, `SELECT count(*) FROM match WHERE id = $1`, matchID).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("want 1 match row, got %d", count)
	}

	rows, err := st.ExistingMatches(ctx, comp, season)
	if err != nil {
		t.Fatalf("ExistingMatches: %v", err)
	}
	if r := rows[matchID]; r.State != "scheduled" || r.FinalizedAt.Valid {
		t.Fatalf("pre-finish: got state=%q finalized=%v", r.State, r.FinalizedAt.Valid)
	}

	// Transition to finished with finals → finalized_at set.
	finished := scheduled
	finished.State = espn.MatchStateFinished
	finished.HomeScore = intp(2)
	finished.AwayScore = intp(1)
	if err := st.UpsertMatch(ctx, comp, season, finished); err != nil {
		t.Fatalf("UpsertMatch finished: %v", err)
	}
	rows, _ = st.ExistingMatches(ctx, comp, season)
	if r := rows[matchID]; r.State != "finished" || !r.FinalizedAt.Valid {
		t.Fatalf("post-finish: got state=%q finalized=%v", r.State, r.FinalizedAt.Valid)
	}

	// Freeze: a later upsert with DIFFERENT scores must NOT change the finals.
	tampered := finished
	tampered.HomeScore = intp(9)
	tampered.AwayScore = intp(9)
	if err := st.UpsertMatch(ctx, comp, season, tampered); err != nil {
		t.Fatalf("UpsertMatch tampered: %v", err)
	}
	var hs, as int
	if err := st.pool.QueryRow(ctx,
		`SELECT home_score, away_score FROM match WHERE id = $1`, matchID).Scan(&hs, &as); err != nil {
		t.Fatalf("scores: %v", err)
	}
	if hs != 2 || as != 1 {
		t.Fatalf("freeze broken: want 2-1, got %d-%d", hs, as)
	}
}

func TestUpsertMatchDetailRoundTrip(t *testing.T) {
	dsn := os.Getenv("DIRECT_DSN")
	if dsn == "" {
		t.Skip("DIRECT_DSN not set — skipping DB repo test")
	}
	ctx := context.Background()
	st, err := New(ctx, dsn)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	const comp, season, matchID = "test-comp", "test-season", "test-m1"
	teamIDs := []string{"test-home", "test-away"}
	clean := func() {
		st.pool.Exec(ctx, `DELETE FROM match_detail WHERE match_id = $1`, matchID)
		st.pool.Exec(ctx, `DELETE FROM match WHERE id = $1`, matchID)
		st.pool.Exec(ctx, `DELETE FROM team WHERE id = ANY($1)`, teamIDs)
	}
	clean()
	t.Cleanup(clean)

	home := espn.Team{ID: "test-home", Name: "Home FC", Abbr: "HOM"}
	away := espn.Team{ID: "test-away", Name: "Away FC", Abbr: "AWY"}
	if err := st.UpsertTeams(ctx, []espn.Team{home, away}); err != nil {
		t.Fatalf("UpsertTeams: %v", err)
	}
	if err := st.UpsertMatch(ctx, comp, season, espn.Match{
		ID: matchID, Kickoff: "2026-06-11T18:00Z", State: espn.MatchStateFinished,
		Home: home, Away: away,
	}); err != nil {
		t.Fatalf("UpsertMatch: %v", err)
	}

	detail := espn.MatchDetail{
		Scorers:        []espn.Scorer{{TeamID: "test-home", Player: "A. Striker", Minute: "23'"}},
		WinProbability: &espn.WinProbability{Home: 55.5, Draw: 22.0, Away: 22.5},
	}
	if err := st.UpsertMatchDetail(ctx, matchID, detail); err != nil {
		t.Fatalf("UpsertMatchDetail: %v", err)
	}
	// Upsert again (idempotent, single row keyed by match_id).
	if err := st.UpsertMatchDetail(ctx, matchID, detail); err != nil {
		t.Fatalf("UpsertMatchDetail #2: %v", err)
	}
	var scorers, winProb string
	if err := st.pool.QueryRow(ctx,
		`SELECT scorers::text, win_probability::text FROM match_detail WHERE match_id = $1`,
		matchID).Scan(&scorers, &winProb); err != nil {
		t.Fatalf("select detail: %v", err)
	}
	if scorers == "[]" || winProb == "" {
		t.Fatalf("detail not stored: scorers=%q winProb=%q", scorers, winProb)
	}
}
```

- [ ] **Step 5:** Run the repo tests with the env loaded.

```bash
cd backend && set -a && . ./.env && set +a && go test ./shared/store/...
# expect (with DIRECT_DSN set): ok  github.com/mcasillas17/scorearc-backend/shared/store
# expect (DIRECT_DSN unset):     ok ... (tests SKIP, still exit 0)
```

- [ ] **Step 6:** Commit.

```bash
cd backend && go mod tidy && git add -A && git commit -m "feat(backend): store layer — pgx upserts + freeze-on-finish" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 7 [needs-DB + R2]: asset mirror to R2

**Files:** `backend/shared/assets/r2.go`, and add `R2_PUBLIC_BASE_URL` to
`backend/.env.example`. Requires the `R2_*` vars in `backend/.env`.

- [ ] **Step 1:** Add the AWS SDK v2 modules.

```bash
cd backend && go get \
  github.com/aws/aws-sdk-go-v2/aws@latest \
  github.com/aws/aws-sdk-go-v2/credentials@latest \
  github.com/aws/aws-sdk-go-v2/service/s3@latest
# expect: go: added github.com/aws/aws-sdk-go-v2/... (+ deps)
```

- [ ] **Step 2:** Add the public base URL to the env template. Edit
  `backend/.env.example`, appending under the R2 block:

```bash
# Public CDN base for mirrored assets, e.g. https://assets.scorearc.futbol
# (the R2 bucket's custom domain / r2.dev URL). Used to build team.crest_url.
R2_PUBLIC_BASE_URL='https://assets.scorearc.futbol'
```

Add the same key with the real value to your `backend/.env` (gitignored).

- [ ] **Step 3:** Write `backend/shared/assets/r2.go` — **complete**:

```go
// Package assets mirrors external images (team crests / flags) into our
// Cloudflare R2 bucket via the aws-sdk-go-v2 S3 client, so we serve them from
// our own CDN instead of hot-linking ESPN. A mirror is write-once (HEAD then
// PUT) and non-blocking: on any failure the caller keeps the source URL.
package assets

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// maxAsset caps how many bytes we download from a source image (8 MiB).
const maxAsset = 8 << 20

// Config holds the R2 connection + public-base settings.
type Config struct {
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	PublicBaseURL   string
}

// Mirror is a configured R2 asset mirror.
type Mirror struct {
	client  *s3.Client
	bucket  string
	baseURL string
	http    *http.Client
}

// FromEnv builds a Mirror from the R2_* environment variables. Returns
// (nil, false) when any required var is missing, so the caller can run with
// mirroring disabled rather than fail.
func FromEnv() (*Mirror, bool) {
	c := Config{
		AccountID:       os.Getenv("R2_ACCOUNT_ID"),
		AccessKeyID:     os.Getenv("R2_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
		Bucket:          os.Getenv("R2_BUCKET"),
		PublicBaseURL:   os.Getenv("R2_PUBLIC_BASE_URL"),
	}
	if c.AccountID == "" || c.AccessKeyID == "" || c.SecretAccessKey == "" ||
		c.Bucket == "" || c.PublicBaseURL == "" {
		return nil, false
	}
	return New(c), true
}

// New builds a Mirror from an explicit Config. The S3 client targets R2's
// S3-compatible endpoint with path-style addressing and static credentials.
func New(c Config) *Mirror {
	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", c.AccountID)
	client := s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider(
			c.AccessKeyID, c.SecretAccessKey, ""),
		UsePathStyle: true,
	})
	return &Mirror{
		client:  client,
		bucket:  c.Bucket,
		baseURL: strings.TrimRight(c.PublicBaseURL, "/"),
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

// BaseURL is the public CDN base (no trailing slash). The loop uses it to skip
// crests already pointing at our CDN.
func (m *Mirror) BaseURL() string { return m.baseURL }

// Mirror ensures kind/{id}.png exists in R2 (downloading srcURL once if absent)
// and returns its public CDN URL. HEAD-gated: if the object already exists, it
// returns the URL without re-downloading.
func (m *Mirror) Mirror(ctx context.Context, kind, id, srcURL string) (string, error) {
	key := fmt.Sprintf("%s/%s.png", kind, id)
	cdnURL := fmt.Sprintf("%s/%s", m.baseURL, key)

	if _, err := m.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(m.bucket),
		Key:    aws.String(key),
	}); err == nil {
		return cdnURL, nil // already mirrored — skip the download
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srcURL, nil)
	if err != nil {
		return "", err
	}
	res, err := m.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: status %d", srcURL, res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxAsset))
	if err != nil {
		return "", err
	}
	contentType := res.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/png"
	}
	if _, err := m.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(m.bucket),
		Key:          aws.String(key),
		Body:         bytes.NewReader(body),
		ContentType:  aws.String(contentType),
		CacheControl: aws.String("public, max-age=31536000, immutable"),
	}); err != nil {
		return "", err
	}
	return cdnURL, nil
}
```

- [ ] **Step 4:** `cd backend && go build ./...`

```bash
cd backend && go build ./...
# expect: (clean — no output, exit 0)
```

- [ ] **Step 5:** Commit.

```bash
cd backend && go mod tidy && git add -A && git commit -m "feat(backend): R2 asset mirror (aws-sdk-go-v2, HEAD-then-PUT, non-blocking)" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 8 [no-DB]: Source seam + ESPN adapter

**Files:** `backend/shared/source/source.go`, `backend/shared/source/espn.go`.

The seam future-proofs "different sources": the loop depends only on the `Source`
interface, so a second provider can be added later as another implementation. **Only the
ESPN adapter is built now** — it wraps the existing `shared/espn` mappers. No hypothetical
sources.

- [ ] **Step 1:** Write `backend/shared/source/source.go` — the interface:

```go
// Package source defines the data-source seam the ingester consumes: a single
// Source interface producing our persisted domain types (defined in
// shared/espn). ESPN is the first implementation (espn.go); additional
// providers can be added later without touching the ingester loop.
package source

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// Source is an external football-data provider. Every method takes the config
// Competition/Season (the poll list) and returns the domain types the store
// persists. Implementations are responsible for their own URL construction and
// raw→domain mapping.
type Source interface {
	// Name identifies the provider (for logs / ingest_run).
	Name() string
	// Scoreboard returns the current fixtures for a comp/season.
	Scoreboard(ctx context.Context, comp config.Competition, season config.Season) ([]espn.Match, error)
	// Summary returns the per-match detail (jsonb payload) for one match id.
	Summary(ctx context.Context, comp config.Competition, matchID string) (espn.MatchDetail, error)
	// Standings returns the league/group table for a comp/season.
	Standings(ctx context.Context, comp config.Competition, season config.Season) ([]espn.Standing, error)
	// TopScorers returns the ranked goal leaders, capped at limit.
	TopScorers(ctx context.Context, comp config.Competition, season config.Season, limit int) ([]espn.TopScorer, error)
	// Bracket returns the knockout matches (tagged with round slugs).
	Bracket(ctx context.Context, comp config.Competition, season config.Season) ([]espn.BracketMatch, error)
}
```

- [ ] **Step 2:** Write `backend/shared/source/espn.go` — the ESPN implementation
  wrapping the committed client + mappers:

```go
package source

import (
	"context"
	"encoding/json"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// ESPN is the Source backed by ESPN's keyless public API. It builds URLs and
// maps raw JSON with the shared/espn package.
type ESPN struct{ client *espn.Client }

// NewESPN returns an ESPN Source with a default HTTP client.
func NewESPN() *ESPN { return &ESPN{client: espn.New()} }

// Name implements Source.
func (e *ESPN) Name() string { return "espn" }

// get fetches url and returns the raw JSON bytes for a mapper.
func (e *ESPN) get(ctx context.Context, url string) ([]byte, error) {
	var raw json.RawMessage
	if err := e.client.GetJSON(ctx, url, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// Scoreboard fetches the current scoreboard (no dates range = ESPN's current
// window) and maps it.
func (e *ESPN) Scoreboard(ctx context.Context, comp config.Competition, season config.Season) ([]espn.Match, error) {
	raw, err := e.get(ctx, espn.ScoreboardURL(comp.ESPNSlug, ""))
	if err != nil {
		return nil, err
	}
	return espn.MapScoreboard(raw)
}

// Summary fetches and maps one match's detail payload.
func (e *ESPN) Summary(ctx context.Context, comp config.Competition, matchID string) (espn.MatchDetail, error) {
	raw, err := e.get(ctx, espn.SummaryURL(comp.ESPNSlug, matchID))
	if err != nil {
		return espn.MatchDetail{}, err
	}
	return espn.MapSummary(raw)
}

// Standings fetches and maps the standings table.
func (e *ESPN) Standings(ctx context.Context, comp config.Competition, season config.Season) ([]espn.Standing, error) {
	raw, err := e.get(ctx, espn.StandingsURL(comp.ESPNSlug))
	if err != nil {
		return nil, err
	}
	return espn.MapStandings(raw)
}

// TopScorers fetches the statistics endpoint and maps the goal leaders.
func (e *ESPN) TopScorers(ctx context.Context, comp config.Competition, season config.Season, limit int) ([]espn.TopScorer, error) {
	raw, err := e.get(ctx, espn.StatisticsURL(comp.ESPNSlug))
	if err != nil {
		return nil, err
	}
	return espn.MapTopScorers(raw, limit)
}

// Bracket fetches the knockout scoreboard (season.BracketDatesRange window) and
// maps it. A nil range falls back to the current window.
func (e *ESPN) Bracket(ctx context.Context, comp config.Competition, season config.Season) ([]espn.BracketMatch, error) {
	var datesRange string
	if season.BracketDatesRange != nil {
		datesRange = *season.BracketDatesRange
	}
	raw, err := e.get(ctx, espn.BracketURL(comp.ESPNSlug, datesRange))
	if err != nil {
		return nil, err
	}
	return espn.MapBracket(raw)
}

// Compile-time assertion that ESPN satisfies Source.
var _ Source = (*ESPN)(nil)
```

- [ ] **Step 3:** `cd backend && go build ./...`

```bash
cd backend && go build ./...
# expect: (clean — no output, exit 0)
```

- [ ] **Step 4:** Commit.

```bash
cd backend && git add -A && git commit -m "feat(backend): Source seam + ESPN adapter over shared/espn mappers" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 9 [needs-DB]: poll loop + wiring + local run

**Files:** `backend/ingester/loop.go`, `backend/ingester/loop_test.go`,
`backend/ingester/main.go`. Requires `backend/.env` (Neon; R2 optional).

- [ ] **Step 1 (test-first — cadence + predicate):** Write `backend/ingester/loop.go`:

```go
package main

import (
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	// fastInterval drives the loop while any polled match is live.
	fastInterval = 20 * time.Second
	// slowInterval is the idle cadence; it also defines a "slow tick" — the
	// period on which dormant comps, scheduled-match summaries, standings and
	// top scorers are re-checked.
	slowInterval = 5 * time.Minute
	// topScorerLimit caps the goal-leaders list persisted per comp/season.
	topScorerLimit = 30
)

// nextInterval returns the sleep before the next cycle: fast when any match is
// live, slow otherwise.
func nextInterval(anyLive bool) time.Duration {
	if anyLive {
		return fastInterval
	}
	return slowInterval
}

// needsSummary reports whether to (re)fetch this match's summary this tick,
// applying the write-once / skip rules:
//   - finalized (frozen) match: never;
//   - live: every tick (it's changing);
//   - finished-but-not-yet-finalized: once (the final summary);
//   - scheduled: once when first seen, then only on the slow tick.
func needsSummary(m espn.Match, existing *store.MatchRow, slowTick bool) bool {
	if existing != nil && existing.FinalizedAt.Valid {
		return false
	}
	switch m.State {
	case espn.MatchStateLive:
		return true
	case espn.MatchStateFinished:
		return existing == nil || !existing.FinalizedAt.Valid
	case espn.MatchStateScheduled:
		return existing == nil || slowTick
	}
	return false
}
```

- [ ] **Step 2:** Write `backend/ingester/loop_test.go`:

```go
package main

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func TestNextInterval(t *testing.T) {
	if got := nextInterval(true); got != fastInterval {
		t.Errorf("live: want %v, got %v", fastInterval, got)
	}
	if got := nextInterval(false); got != slowInterval {
		t.Errorf("idle: want %v, got %v", slowInterval, got)
	}
}

func finalized() *store.MatchRow {
	return &store.MatchRow{State: "finished", FinalizedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}}
}

func TestNeedsSummary(t *testing.T) {
	live := espn.Match{State: espn.MatchStateLive}
	fin := espn.Match{State: espn.MatchStateFinished}
	sched := espn.Match{State: espn.MatchStateScheduled}

	cases := []struct {
		name     string
		m        espn.Match
		existing *store.MatchRow
		slowTick bool
		want     bool
	}{
		{"frozen never", fin, finalized(), true, false},
		{"live always", live, nil, false, true},
		{"live even if existing not finalized", live, &store.MatchRow{State: "live"}, false, true},
		{"finished not yet finalized -> once", fin, &store.MatchRow{State: "live"}, false, true},
		{"finished new -> once", fin, nil, false, true},
		{"scheduled new -> once", sched, nil, false, true},
		{"scheduled seen, fast tick -> skip", sched, &store.MatchRow{State: "scheduled"}, false, false},
		{"scheduled seen, slow tick -> refresh", sched, &store.MatchRow{State: "scheduled"}, true, true},
	}
	for _, c := range cases {
		if got := needsSummary(c.m, c.existing, c.slowTick); got != c.want {
			t.Errorf("%s: want %v, got %v", c.name, c.want, got)
		}
	}
}
```

```bash
cd backend && go test ./ingester/...
# expect: ok  github.com/mcasillas17/scorearc-backend/ingester
```

- [ ] **Step 3:** Write `backend/ingester/main.go` — wiring + the full per-comp/season
  pipeline applying every write-once / skip rule, `emitSnapshots()` no-op stub,
  `ingest_run` logging, structured logs, graceful shutdown, and a `-once` flag for the
  local run:

```go
// Command ingester is the ScoreArc internal data-ingestion worker: an
// always-on Go process that polls a Source (ESPN today) on a cadence, maps
// every shape to our schema, upserts into Neon Postgres (freezing finished
// matches), and mirrors team crests to R2. No public HTTP.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

// Snapshot is the per-tick marker handed to emitSnapshots (Phase 2 fills it).
type Snapshot struct{ At time.Time }

// ingester holds the wired dependencies and the cross-cycle state used for
// dormant-comp detection and slow-tick scheduling.
type ingester struct {
	cfg    *config.Registry
	src    source.Source
	st     *store.Store
	mirror *assets.Mirror // nil when R2_* env is not set
	log    *slog.Logger

	// active[comp/season] is whether that comp/season had a scheduled or live
	// match last cycle. Dormant (false) comps are skipped on fast ticks.
	active   map[string]bool
	lastSlow time.Time
}

func main() {
	once := flag.Bool("once", false, "run a single ingest cycle and exit")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dsn := os.Getenv("POOLED_DSN")
	if dsn == "" {
		log.Error("POOLED_DSN not set")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		os.Exit(1)
	}

	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Error("connect store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	var mirror *assets.Mirror
	if m, ok := assets.FromEnv(); ok {
		mirror = m
		log.Info("asset mirror enabled")
	} else {
		log.Warn("asset mirror disabled (R2_* env not fully set) — crests keep source URLs")
	}

	ing := &ingester{
		cfg:    cfg,
		src:    source.NewESPN(),
		st:     st,
		mirror: mirror,
		log:    log,
		active: map[string]bool{},
	}

	if *once {
		anyLive := ing.runCycle(ctx, true) // treat as slow tick to exercise every path
		log.Info("single cycle complete", "anyLive", anyLive)
		return
	}

	for {
		slowTick := time.Since(ing.lastSlow) >= slowInterval
		if slowTick {
			ing.lastSlow = time.Now()
		}
		anyLive := ing.runCycle(ctx, slowTick)
		d := nextInterval(anyLive)
		log.Info("cycle done", "anyLive", anyLive, "slowTick", slowTick, "sleep", d.String())
		select {
		case <-ctx.Done():
			log.Info("shutdown signal — exiting")
			return
		case <-time.After(d):
		}
	}
}

// runCycle polls every comp on its current season, applying the dormant-skip
// rule, then calls emitSnapshots. Returns whether any match was live.
func (i *ingester) runCycle(ctx context.Context, slowTick bool) (anyLive bool) {
	for _, comp := range i.cfg.List() {
		season, ok := comp.Seasons[comp.CurrentSeasonId]
		if !ok {
			continue
		}
		key := comp.ID + "/" + season.ID
		if !slowTick && !i.active[key] {
			continue // dormant: only re-checked on the slow tick
		}
		if i.ingestCompSeason(ctx, comp, season, slowTick) {
			anyLive = true
		}
	}
	if err := i.emitSnapshots(ctx, Snapshot{At: time.Now()}); err != nil {
		i.log.Error("emitSnapshots", "err", err)
	}
	return anyLive
}

// ingestCompSeason runs the full pipeline for one comp/season and returns
// whether any of its matches were live. It also updates i.active[key].
func (i *ingester) ingestCompSeason(ctx context.Context, comp config.Competition, season config.Season, slowTick bool) (anyLive bool) {
	start := time.Now()
	compID := comp.ID
	key := comp.ID + "/" + season.ID
	l := i.log.With("comp", comp.ID, "season", season.ID)

	existing, err := i.st.ExistingMatches(ctx, comp.ID, season.ID)
	if err != nil {
		l.Error("existing matches", "err", err)
		i.logRun(ctx, &compID, "scoreboard", start, false, err.Error())
		return false
	}

	matches, err := i.src.Scoreboard(ctx, comp, season)
	if err != nil {
		l.Error("scoreboard", "err", err)
		i.logRun(ctx, &compID, "scoreboard", start, false, err.Error())
		return false
	}

	// Upsert every team once, then the matches (FK: teams first).
	teams := make([]espn.Team, 0, len(matches)*2)
	for _, m := range matches {
		teams = append(teams, m.Home, m.Away)
	}
	if err := i.st.UpsertTeams(ctx, teams); err != nil {
		l.Error("upsert teams", "err", err)
	}

	finishedSinceLast := false
	activeRemaining := false
	for _, m := range matches {
		prev, had := existing[m.ID]
		var prevPtr *store.MatchRow
		if had {
			prevPtr = &prev
		}

		// UpsertMatch is a no-op UPDATE for already-finalized rows (freeze in SQL).
		if err := i.st.UpsertMatch(ctx, comp.ID, season.ID, m); err != nil {
			l.Error("upsert match", "match", m.ID, "err", err)
			continue
		}

		switch m.State {
		case espn.MatchStateLive:
			anyLive = true
			activeRemaining = true
		case espn.MatchStateScheduled:
			activeRemaining = true
		case espn.MatchStateFinished:
			if !had || prev.State != string(espn.MatchStateFinished) {
				finishedSinceLast = true
			}
		}

		if needsSummary(m, prevPtr, slowTick) {
			detail, err := i.src.Summary(ctx, comp, m.ID)
			if err != nil {
				l.Warn("summary", "match", m.ID, "err", err)
			} else if err := i.st.UpsertMatchDetail(ctx, m.ID, detail); err != nil {
				l.Error("upsert detail", "match", m.ID, "err", err)
			}
			i.mirrorCrest(ctx, m.Home)
			i.mirrorCrest(ctx, m.Away)
		}
	}
	i.logRun(ctx, &compID, "scoreboard", start, true, "")

	// Standings + top scorers: only when results changed or on the slow tick.
	if finishedSinceLast || slowTick {
		i.ingestStandings(ctx, comp, season)
		i.ingestTopScorers(ctx, comp, season)
	}

	// Bracket: only for configured knockout comps, and skip a fully finished
	// tournament except on the slow tick (in case a fixture reopens).
	if season.HasBracket && (activeRemaining || slowTick) {
		i.ingestBracket(ctx, comp, season)
	}

	i.active[key] = activeRemaining
	return anyLive
}

// mirrorCrest mirrors a team's crest to R2 once (best-effort). A failure never
// blocks the data upsert — we log and keep the source URL. Skips when mirroring
// is disabled, the crest is empty, or it already points at our CDN.
func (i *ingester) mirrorCrest(ctx context.Context, t espn.Team) {
	if i.mirror == nil || t.CrestURL == nil || *t.CrestURL == "" {
		return
	}
	if strings.HasPrefix(*t.CrestURL, i.mirror.BaseURL()) {
		return
	}
	cdn, err := i.mirror.Mirror(ctx, "teams", t.ID, *t.CrestURL)
	if err != nil {
		i.log.Warn("mirror crest", "team", t.ID, "err", err)
		return
	}
	if err := i.st.SetTeamCrest(ctx, t.ID, cdn); err != nil {
		i.log.Warn("set crest", "team", t.ID, "err", err)
	}
}

func (i *ingester) ingestStandings(ctx context.Context, comp config.Competition, season config.Season) {
	start := time.Now()
	compID := comp.ID
	rows, err := i.src.Standings(ctx, comp, season)
	if err != nil {
		i.log.Warn("standings", "comp", comp.ID, "err", err)
		i.logRun(ctx, &compID, "standings", start, false, err.Error())
		return
	}
	if err := i.st.ReplaceStandings(ctx, comp.ID, season.ID, rows); err != nil {
		i.log.Error("replace standings", "comp", comp.ID, "err", err)
		i.logRun(ctx, &compID, "standings", start, false, err.Error())
		return
	}
	i.logRun(ctx, &compID, "standings", start, true, "")
}

func (i *ingester) ingestTopScorers(ctx context.Context, comp config.Competition, season config.Season) {
	start := time.Now()
	compID := comp.ID
	rows, err := i.src.TopScorers(ctx, comp, season, topScorerLimit)
	if err != nil {
		i.log.Warn("top scorers", "comp", comp.ID, "err", err)
		i.logRun(ctx, &compID, "top_scorers", start, false, err.Error())
		return
	}
	if err := i.st.ReplaceTopScorers(ctx, comp.ID, season.ID, rows); err != nil {
		i.log.Error("replace top scorers", "comp", comp.ID, "err", err)
		i.logRun(ctx, &compID, "top_scorers", start, false, err.Error())
		return
	}
	i.logRun(ctx, &compID, "top_scorers", start, true, "")
}

func (i *ingester) ingestBracket(ctx context.Context, comp config.Competition, season config.Season) {
	start := time.Now()
	compID := comp.ID
	bms, err := i.src.Bracket(ctx, comp, season)
	if err != nil {
		i.log.Warn("bracket", "comp", comp.ID, "err", err)
		i.logRun(ctx, &compID, "bracket", start, false, err.Error())
		return
	}
	if err := i.st.UpsertBracketMatches(ctx, comp.ID, season.ID, bms); err != nil {
		i.log.Error("upsert bracket", "comp", comp.ID, "err", err)
		i.logRun(ctx, &compID, "bracket", start, false, err.Error())
		return
	}
	i.logRun(ctx, &compID, "bracket", start, true, "")
}

// logRun writes an ingest_run row and logs a warning if that write itself fails.
func (i *ingester) logRun(ctx context.Context, compID *string, kind string, start time.Time, ok bool, errMsg string) {
	if err := i.st.LogIngestRun(ctx, compID, kind, start, time.Now(), ok, errMsg); err != nil {
		i.log.Warn("log ingest_run", "kind", kind, "err", err)
	}
}

// emitSnapshots is the per-tick Tier-3 hook. No-op in Phase 1; Phase 2 writes
// standing_snapshot / win_prob_snapshot here.
func (i *ingester) emitSnapshots(ctx context.Context, tick Snapshot) error { return nil }
```

- [ ] **Step 4:** Build + run the unit tests.

```bash
cd backend && go build ./... && go test ./ingester/...
# expect: ok  github.com/mcasillas17/scorearc-backend/ingester
```

- [ ] **Step 5 (local run — one cycle against Neon):** Load `backend/.env` and run one
  cycle with `-once`, then verify rows landed.

```bash
cd backend && set -a && . ./.env && set +a && go run ./ingester -once
# expect: JSON logs to stdout, ending with a line like:
#   {"level":"INFO","msg":"single cycle complete","anyLive":false}
# (comp/season INFO lines and any per-comp WARN for out-of-window feeds are normal)
```

```bash
psql "$DIRECT_DSN" -c "SELECT comp_id, count(*) FROM match GROUP BY comp_id ORDER BY comp_id;"
# expect: one row per competition that had fixtures in ESPN's current window
#         (e.g. premier-league, laliga, mls, liga-mx, ... with non-zero counts)

psql "$DIRECT_DSN" -c "SELECT kind, ok, count(*) FROM ingest_run GROUP BY kind, ok ORDER BY kind;"
# expect: at least a 'scoreboard | t | N' row (plus standings/top_scorers/bracket rows)
```

- [ ] **Step 6:** Commit.

```bash
cd backend && go mod tidy && git add -A && git commit -m "feat(backend): ingester poll loop + wiring (cadence, write-once rules, ingest_run)" \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

## Self-Review

- **Spec coverage.** (1) Source seam: `source.Source` interface + only-ESPN adapter
  wrapping the committed mappers ✓. (2) Store: `UpsertTeams`, `UpsertMatch` (freeze via
  `WHERE match.finalized_at IS NULL` + `finalized_at` set on transition to finished),
  `UpsertMatchDetail` (jsonb), `ReplaceStandings` (incl. `group_id`/`group_name`),
  `ReplaceTopScorers`, `UpsertBracketMatches`, `ExistingMatches → map[string]MatchRow{State,
  FinalizedAt}`, `LogIngestRun`; repo test asserts upsert-idempotency + freeze against the
  live `DIRECT_DSN` ✓. (3) R2 mirror: `Mirror(ctx, kind, id, srcURL) (cdnURL, error)`,
  HEAD-then-PUT once, non-blocking on failure ✓. (4) Loop + `main.go`:
  `nextInterval(anyLive)`, per-comp/season pipeline applying every write-once/skip rule
  (dormant skip, `needsSummary`, standings/scorers on change or slow tick, bracket gating,
  freeze), `emitSnapshots()` no-op stub with the contract signature, `ingest_run` logging,
  structured `slog` logs, graceful shutdown via `signal.NotifyContext`, `-once` local run ✓.
- **No placeholders.** Every method, SQL statement, test, and command is complete — no
  "TBD"/"add error handling"/"similar to above".
- **Column/type names match the real schema** (`0001_init.up.sql` / `0002_snapshots.up.sql`):
  `match(finalized_at, status_detail, status_name, winner_id, note, round, minute, …)`,
  `match_detail` jsonb columns (`scorers, cards, stats, win_probability, shootout,
  shootout_detail, lineups, videos, info, form, h2h, commentary`), `standing(group_id,
  group_name, goals_for, goals_against, goal_difference, …)`, `top_scorer(rank, player,
  team_abbr, team_name, team_crest_url, goals, matches)`, `ingest_run(comp_id, kind, started_at, finished_at, ok,
  error)`.
- **Mapper signatures match the committed code** (`MapScoreboard`/`MapSummary`/
  `MapStandings`/`MapTopScorers(raw, limit)`/`MapBracket`) and domain types
  (`espn.Match/Team/Standing/TopScorer/MatchDetail/BracketMatch/BracketTeam`,
  `MatchState*` constants) from `shared/espn/types.go`.
- **Top-scorer team denormalized:** `top_scorer` stores `team_abbr`/`team_name`/
  `team_crest_url` (ESPN stats give no team id), matching the `TopScorer` type — no
  NULL FK, no unresolved team.
- **Idempotency guarantees:** teams (`ON CONFLICT (id)`, crest preserved), matches
  (`ON CONFLICT (id)`, freeze), match_detail (`ON CONFLICT (match_id)`), standings/top
  scorers (delete-then-insert in a transaction), brackets (reuse `UpsertMatch`).
- **Tasks 1–5 untouched** (already committed); this plan adds only tasks 6–9.
</content>
