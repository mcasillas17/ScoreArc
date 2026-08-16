# Reader API — Players, Season Stats and the Full Game Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put people in the reader API. Three endpoints: a competition-agnostic player profile with career club history, a competition-scoped season stat line, and — the one that matters — **a game log covering every match we hold**, not the last five ESPN is willing to give away.

**Architecture:** A new migration adds `player`, `player_season_stat` and `player_career_stint`. A new `backend/reader/store_players.go` owns three reads; a new `backend/reader/handlers_players.go` owns three handlers. The game log is a join of `match_player_stat` (from the `api-leaders-and-box-scores` plan) onto `match`, with the opponent resolved from `match.home_team_id`/`away_team_id` and the result derived from the scores and the side the player's team was on. `?range=`, `?order=` and `?limit=` reuse `backend/reader/params.go` verbatim from the `api-match-reads` plan.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-15-player-pages-design.md` (E5). Context on what E7 gates: `docs/superpowers/specs/2026-08-15-history-and-trends-design.md`.
**Epic:** E5 in `docs/PRODUCT_ROADMAP.md` — this is the backend half of **T5.1** and **T5.2**, and it is what eventually lifts the ceiling E5's page declares (**T7.4**'s game-log half).
**New roadmap task:** **T9.4** (Epic **E9 · Public API read surface**)
**Branch:** `feat/api-players` off latest `origin/main`

## Why this endpoint set is the payoff, not a port

E5 ships the player page today against ESPN directly, and it works. Its `/overview`
game log carries **five matches** — verified live on 2026-08-15 against Liga MX
athlete `297287` — and the page has to say so out loud, because five matches
rendered where a reader assumes a season is misleading by omission.

This plan is the endpoint that removes that sentence from the page. ESPN serves
five rows because ESPN is not in the business of giving us a season. We are: the
ingester writes `match_player_stat` for **every** match it processes, so
`GET /v1/competitions/{comp}/{season}/players/{playerId}/game-log` returns every
appearance we hold, windowable by date, ordered either way. That difference — five
rows versus the season — is the concrete, demonstrable payoff of owning the data,
and it is worth stating in the PR in exactly those terms.

**Not in this plan:** per-position percentiles (E7 **T7.4**'s other half). A
percentile needs a population and a history — every forward's shots per 90 across
a season — not one player's row. That belongs to the `api-history` plan, which is
where the population lives. Do not add a `percentile` field here "while we're in
the file"; a percentile computed from one row is a number with no meaning.

## STOP — schema ownership. Read before Task 1.

**This plan must not create `player`, `player_season_stat` or `player_career_stint` if an ingester write-path plan already does.** Verified on disk 2026-08-15: the unmerged `feat/player-identity` branch adds **`0003_player_capture`** with `appearance` and `match_event`, and the ledger in `docs/superpowers/plans/2026-08-15-ingester-standings-snapshots.md` reserves **`0008_squad_and_season_stats`** and **`0009_player_bio`** — which between them almost certainly cover every table this plan's Task 1 creates. `2026-08-15-ingester-play-stream.md` also references `player(id)` as **`uuid`**, not `text`.

**The write side owns the schema.** Before executing Task 1:

1. `ls backend/migrations` and `grep -rn "CREATE TABLE player\b\|player_season_stat\|player_career_stint\|team_history" backend/migrations/`.
2. If an ingester migration already creates them, **delete this plan's Task 1 migration** and rewrite every SQL statement in the later tasks against the real column names. Record the mapping as a table in this plan so the executor applies it once rather than discovering it six times.
3. **Check `player.id`'s and `match.id`'s types before writing any foreign key.** The ingester plans use `uuid` for both; `0001_init.up.sql` on `main` declares `match.id text`. A foreign key whose type differs from its target's will not create, and Postgres reports the error against the wrong file. Raise the mismatch; do not work around it.
4. The game log reads `match_player_stat` from the `api-leaders-and-box-scores` plan — **which has its own unresolved fork**, since the ingester's `0006_appearance_box_score` models the same data as thirteen nullable columns on an `appearance` table rather than a jsonb bag. Whichever wins, this plan's `GameLogRow` shape is unchanged; only the SELECT list moves.

Everything else in this plan — the three endpoints, the wire shapes, the null-not-zero rules, the age-computed-not-stored rule, the caps — is storage-agnostic and stands whichever way this resolves.

---

## Global Constraints

- **Depends on two sibling plans.** `params.go` comes from `api-match-reads`
  (**T9.1**); the `match_player_stat` table comes from `api-leaders-and-box-scores`.
  Verify both before Task 1 — see *Prerequisites* below.
- Extend the existing layering. Routes register in `App.router()` under `/v1`;
  handlers live in `handlers_players.go`; SQL lives in `store_players.go`; the
  `readerStore` interface in `server.go` is the seam and `fakeReaderStore` in
  `server_test.go` implements it. Three files change together, always.
- **No string-built SQL.** Every value is a pgx placeholder. The one
  non-placeholder fragment (`ORDER BY`) is selected from a two-entry constant map
  keyed by the already-validated output of `parseOrder`.
- **Reject, never silently fall back.** A malformed `range` is a 400 with a
  specific message, not a quiet substitution of the whole season.
- **400 messages are built only from string constants in our own code.** Never
  `err.Error()` on a dependency error — errors returned by `params.go` are
  constants declared there and are safe to echo; nothing else is.
  `TestDependencyErrorsAreSanitized` exists because that leak class is real.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go`
  enforces: every object schema's `required` list equals its full property list,
  every object schema sets `additionalProperties: false`, every `GET` documents
  200/405/500 (+429 off `/healthz`), and **every** response — 200 and error alike —
  declares a `Cache-Control` header. Because `required` must list every property,
  **no response struct may use `omitempty`**.
- Rate limiting is unchanged: `a.rateLimit` is router-level middleware and all
  three new routes inherit the 10 rps / burst 30 per-IP token bucket
  automatically. Only `/healthz` is exempt. **One request costs one token
  regardless of how much it returns**, which is exactly why the caps below are
  enforced server-side rather than left to the caller — a caller who pays the same
  token for 5 rows and 500 has no incentive to ask for 5.
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`,
  `go test -race ./...`. **Docker must be running** — the reader's store and
  migration tests use testcontainers.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Prerequisites — verify these before Task 1

Run all four. Each has an exact expectation; if one fails, this plan is blocked on
the named sibling and you should stop rather than invent the missing piece.

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
grep -n "func parseDateRange\|func parseLimit\|func parseOrder\|func parseEntityID" backend/reader/params.go
grep -rn "type PlayerMatchStats" backend/reader/ backend/shared/espn/
grep -rn "match_player_stat" backend/migrations/
grep -n "PlayerMatchStats:" backend/reader/openapi.yaml
```

Expected:

1. Four function definitions in `params.go` (from `api-match-reads`, **T9.1**).
2. Exactly one `type PlayerMatchStats` declaration, in package `main` under
   `backend/reader/`. This plan's code refers to it **unqualified**. It is the
   sibling's type and this plan does not touch it.
3. `CREATE TABLE match_player_stat` in `backend/migrations/0005_stat_leaders_and_box_scores.up.sql`
   (or whatever number that plan finally took). Its columns are `match_id`,
   `team_id`, `player_id`, `player`, `position`, `jersey`, `starter`, `stats`,
   `updated_at`, keyed `(match_id, player_id)`. **The game log reads exactly five
   of them** — `match_id`, `player_id`, `team_id`, `starter`, `stats`. That plan
   also creates `match_player_stat_player_idx` on `player_id`, explicitly for this
   endpoint, which is why Task 1 below does **not** create an index.
4. A `PlayerMatchStats:` schema in `openapi.yaml`; `GameLogRow` `$ref`s it.

If any of the four is missing, the sibling has not landed. Stop and say so rather
than recreating its table under a second name — two tables holding one player's
match stats is worse than waiting.

## Ingester prerequisites

This plan is the read half. None of it returns anything until the ingester writes
these rows, and the write path belongs to the ingester plans. What it must persist:

- **`player`** — one row per athlete, from `GET /athletes/{id}` (**200**, verified
  2026-08-15). Identity only: name, short name, position, nationality, headshot,
  birth date, height, weight. `headshot` is **`null`** for athlete `297287` and is
  not guaranteed for anyone; persist `NULL`, never `''`. **Never persist a computed
  age** — an age is a fact about today, and a stored age is wrong the morning after
  it is written. The reader computes it from `birth_date` at request time.
- **`player_season_stat`** — one row per `(comp_id, season_id, player_id)`, from
  the same response's `statsSummary` block, written as a JSON object keyed by
  ESPN's own stat names (`totalGoals`, `goalAssists`, `subIns`, …). A stat ESPN
  omits must be **absent from the JSON**, not written as `0`. A goalkeeper has no
  `offsides` and a striker has no `saves`; a zero there is a claim about a
  measurement that was never taken.
- **`player_career_stint`** — ordered rows from `GET /athletes/{id}/bio`'s
  `teamHistory[]` (**200**, verified). `ordinal` is the array position, so the
  reader can return the career in the order the provider tells the story without
  parsing `"2025-CURRENT"` into dates. Persist the raw span in `seasons_label` and
  the parsed years in `start_year`/`end_year` when they parse, `NULL` when they do
  not.
- **`match_player_stat` for every match**, not the last five. This is the entire
  difference between our game log and ESPN's. The rows already have to be written
  for E1's box score; the game log is the same data read along the other axis
  (by player across matches, instead of by match across players). If the ingester
  ever narrows that write to recent matches, this endpoint quietly becomes ESPN's
  endpoint with extra steps.

**`GET /athletes/{id}/gamelog` returns 500. `/splits` returns 404. `/stats`
returns 404.** All three verified dead on 2026-08-15. Never call them, never build
a fallback chain around them, never retry them on a schedule. `/athletes/{id}`,
`/athletes/{id}/overview` and `/athletes/{id}/bio` are the whole athlete surface.

**Also verified unavailable anywhere in the athlete surface:** populated
injuries, transfers and market values. No column in this migration is reserved
for them.

> **Corrected 2026-08-15.** An earlier draft also listed *shot coordinates* as
> unavailable. They are not: the typed play stream carries `fieldPositionX/Y`,
> `fieldPosition2X/Y` and `goalPositionY/Z` on ~96% of plays, and they survive
> ESPN's pruning of the touch tier. They are simply not on the **athlete**
> surface — they are per-play, and a player's shots are served by the
> `api-commentary-and-shots` plan's
> `/v1/competitions/{comp}/{season}/players/{playerId}/shots`, not from here.
> Nothing in this plan should be read as saying a player shot map is impossible.
> xG remains absent because no model exists, not because the inputs do.

## What is capped, and to what

| Input | Rule | Failure |
|---|---|---|
| `{playerId}` (all three routes) | `parseEntityID` — `^[A-Za-z0-9._-]{1,64}$` | 400 |
| `?range=` (game log) | `YYYYMMDD-YYYYMMDD`, real dates, ordered, **≤ 92 days** | 400 |
| `?order=` (game log) | `asc` \| `desc`; absent means `asc` | 400 |
| `?limit=` (game log) | integer `1..500`; absent means **no limit** | 400 |
| game log with no `?range=` | every appearance of the season — a player cannot exceed roughly 60 in a season, so this is bounded by football, not by us | — |
| `career` | one row per stint we hold; a career is a few dozen rows at worst | — |
| `player_season_stat` | one row, by primary key | — |

The 500-row `limit` cap is inherited from `maxMatchLimit` and is a **guard, not a
paging mechanism**. Nobody plays 500 matches in a season; the cap exists so a
caller who discovers `?limit=` cannot use it to ask for something absurd, and so
the number in the OpenAPI document is a promise we actually enforce. If a season
ever legitimately exceeds it, that is a data bug worth seeing, not a pagination
requirement.

---

## File Structure

- `backend/migrations/0007_players.up.sql` — **new.** Three tables, one grant.
- `backend/migrations/0007_players.down.sql` — **new.** Exact inverse.
- `backend/migrations/migrations_test.go` — a text assertion on the new migration pair.
- `backend/reader/migrations_integration_test.go` — append to the round-trip file list.
- `backend/reader/store_integration_test.go` — append to the up-file list; seed players, stints, season stats and match stats; two new integration tests.
- `backend/reader/types.go` — `CareerStint`, `PlayerProfile`, `PlayerSeasonStats`, `PlayerSeason`, `GameLogRow`.
- `backend/reader/store_players.go` — **new.** `Player`, `PlayerSeason`, `PlayerGameLog`, `GameLogFilter`, `ErrNoSeasonRecord`, `ageOn`, `resultAndScore`.
- `backend/reader/store_players_test.go` — **new.** Pure unit tests for `ageOn` and `resultAndScore`. No Docker.
- `backend/reader/handlers_players.go` — **new.** Three handlers and `parseGameLogFilter`.
- `backend/reader/server.go` — `readerStore` gains three methods; three new routes.
- `backend/reader/server_test.go` — `fakeReaderStore` follows the interface; five new handler tests.
- `backend/reader/openapi.yaml` — one parameter, three paths, five schemas, one header, one widened response description.
- `backend/reader/openapi_test.go` — three rows in the route table, seeded fakes.
- `backend/reader/README.md` — the new routes and their caps.

---

### Task 1: Migration `0007_players` — the three tables

> **Migration numbers are first-come, and this one is contested on paper.** A
> sibling agent authored the `2026-08-15-ingester-*.md` plans concurrently;
> `2026-08-15-ingester-standings-snapshots.md` publishes a ledger **reserving
> `0004`–`0010`**, and `2026-08-15-api-leaders-and-box-scores.md` carries its own
> coordination note about the same collision. On top of that, `0005` is the
> `api-leaders-and-box-scores` plan's and `0006` is the `api-teams` plan's.
>
> **Run `ls backend/migrations` first.** Take the next free integer on disk — not
> the next one on paper — and keep the `_players` suffix (`0009_players.up.sql`,
> etc.). Use that number consistently in the two hardcoded file lists and in
> `migrations_test.go`, in the same commit. Do not resolve a collision by guessing
> which reserved plan will land; the number is cheap, the collision is not.

**Files:**
- Create: `backend/migrations/0007_players.up.sql`, `backend/migrations/0007_players.down.sql`
- Modify: `backend/migrations/migrations_test.go`, `backend/reader/migrations_integration_test.go`, `backend/reader/store_integration_test.go`

**Why a `player` table at all, when `top_scorer` already stores a name.**
`top_scorer.player` is a display string with no identity behind it — two players
called "Rodrigo" are the same row to it. Everything in this plan hangs off a
stable `player.id`, which is what makes a game log joinable and a career
attachable. The denormalised leaderboard stays as it is; it answers a different
question.

- [ ] **Step 1: Write the failing test**

Append to `backend/migrations/migrations_test.go` (package `migrations`, plain
text assertions, no Docker):

```go
func TestPlayersMigrationShapeAndGrants(t *testing.T) {
	up, err := os.ReadFile("0007_players.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"CREATE TABLE player",
		"CREATE TABLE player_season_stat",
		"CREATE TABLE player_career_stint",
		"REFERENCES player(id) ON DELETE CASCADE",
		// The ingester replaces a career wholesale rather than diffing it, so it
		// needs DELETE on exactly that table and nothing else. Every other write
		// in this migration is an upsert covered by the 0001 default grants.
		"GRANT DELETE ON player_career_stint TO scorearc_ingester",
	} {
		if !strings.Contains(string(up), required) {
			t.Fatalf("migration missing %q", required)
		}
	}

	down, err := os.ReadFile("0007_players.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	// Children before parents: player_season_stat and player_career_stint both
	// reference player, so a rollback that drops player first fails on a live
	// database and only fails at 3am.
	stints := strings.Index(string(down), "DROP TABLE IF EXISTS player_career_stint")
	seasons := strings.Index(string(down), "DROP TABLE IF EXISTS player_season_stat")
	parent := strings.Index(string(down), "DROP TABLE IF EXISTS player;")
	if stints < 0 || seasons < 0 || parent < 0 {
		t.Fatalf("rollback does not drop all three tables:\n%s", down)
	}
	if parent < stints || parent < seasons {
		t.Fatalf("rollback drops player before its children:\n%s", down)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./migrations
```

Expected: FAIL — `open 0007_players.up.sql: no such file or directory`.

- [ ] **Step 3: Implement**

Create `backend/migrations/0007_players.up.sql`:

```sql
-- A person, not a competition participant. Identity here is competition-agnostic
-- on purpose: a player who moves from Liga MX to MLS is the same person, and
-- only their season stats belong to a competition.
CREATE TABLE player (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  short_name   text,
  position     text,
  nationality  text,
  headshot_url text,          -- frequently NULL upstream; never store ''
  birth_date   date,          -- age is computed at read time, never stored
  height_cm    int,
  weight_kg    int,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per (competition, season, player). stats is a JSON object keyed by
-- ESPN's own statsSummary names. A stat the provider omits is absent from the
-- object rather than written as 0 - a zero is a claim that the measurement was
-- taken and came back empty.
CREATE TABLE player_season_stat (
  comp_id    text NOT NULL,
  season_id  text NOT NULL,
  player_id  text NOT NULL REFERENCES player(id),
  team_id    text REFERENCES team(id),
  stats      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comp_id, season_id, player_id)
);

-- Career club history from /athletes/{id}/bio. ordinal is the provider's own
-- array position, so the career reads back in the order the provider tells it
-- without us parsing "2025-CURRENT" into a sort key. team_id is nullable because
-- a former club may be one we hold no team row for.
CREATE TABLE player_career_stint (
  player_id      text NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  ordinal        int  NOT NULL,
  team_id        text,
  team_name      text NOT NULL,
  team_crest_url text,
  seasons_label  text NOT NULL,   -- e.g. "2025-CURRENT", verbatim
  start_year     int,
  end_year       int,
  PRIMARY KEY (player_id, ordinal)
);

-- The ingester rewrites a career as a whole (stints get corrected upstream and
-- an ordinal can disappear), so it needs DELETE here. Nowhere else.
GRANT DELETE ON player_career_stint TO scorearc_ingester;
```

**No index on `match_player_stat` here.** That table is keyed
`(match_id, player_id)`, which serves the box score reading by match, and the game
log reads by player across matches — but the `api-leaders-and-box-scores` plan
already creates `match_player_stat_player_idx` on `player_id` in `0005`,
explicitly for this endpoint. Verify it (`grep -n match_player_stat_player_idx
backend/migrations/*.up.sql`) rather than adding a second identical index.

Create `backend/migrations/0007_players.down.sql`:

```sql
REVOKE DELETE ON player_career_stint FROM scorearc_ingester;

DROP TABLE IF EXISTS player_career_stint;
DROP TABLE IF EXISTS player_season_stat;
DROP TABLE IF EXISTS player;
```

`REVOKE` before the `DROP TABLE` is redundant — dropping a table drops its grants
— but it keeps the file a literal inverse of the up file, which is how `0003` and
`0004` are written, and it means the rollback still reads correctly if a future
edit stops dropping the table.

Now the two hardcoded lists. In `backend/reader/migrations_integration_test.go`,
the `files` slice is applied strictly in order — every up file, then every down
file in reverse — so the new up entry goes **last among the ups** and the new down
entry **first among the downs**:

```go
	files := []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0007_players.up.sql",
		"../migrations/0007_players.down.sql",
		"../migrations/0004_ingester_hardening.down.sql",
		"../migrations/0003_ingester_delete_grant.down.sql",
		"../migrations/0002_snapshots.down.sql",
		"../migrations/0001_init.down.sql",
	}
```

(If `0005` and `0006` have landed, they are already in this list; put `0007` after
them on the way up and before them on the way down.)

In `backend/reader/store_integration_test.go`, `newIntegrationStore` applies its
own up-file list. Append there too:

```go
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0007_players.up.sql",
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./migrations
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/migrations`.

```bash
cd backend && go test ./reader -run TestMigrationsRoundTrip
```

Expected: `ok`. This is the assertion that matters: it applies every up file, then
every down file in reverse, and fails unless **zero tables and zero roles remain**.
A `0007` that leaks a table shows up here and nowhere else. (Docker required.)

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0007_players.up.sql backend/migrations/0007_players.down.sql backend/migrations/migrations_test.go backend/reader/migrations_integration_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): add player, season stat and career stint tables

A person is not scoped to a competition; their season stats are. player
holds identity, player_season_stat holds one row per (comp, season,
player), player_career_stint holds the provider's own ordered club
history. No age column - an age is a fact about today and a stored one is
wrong the next morning.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Response types, and the two derivations that must be pure

**Files:**
- Modify: `backend/reader/types.go`
- Create: `backend/reader/store_players.go` (helpers only in this task)
- Test: `backend/reader/store_players_test.go` (**new**, no Docker)

**Interfaces:**
- `ageOn(birth, on time.Time) int` — whole years elapsed.
- `resultAndScore(state espn.MatchState, playedHome bool, homeScore, awayScore *int) (*string, *string)`.

Both are pure functions with no database in them, tested without Docker, because
both encode a rule that is easy to get subtly wrong and expensive to notice: an
age that is a year out for two months, or a live match reported as a win.

- [ ] **Step 1: Write the failing test**

Create `backend/reader/store_players_test.go`:

```go
package main

import (
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestAgeOn(t *testing.T) {
	t.Parallel()
	birth := time.Date(2004, 1, 15, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		on   time.Time
		want int
	}{
		{time.Date(2026, 1, 14, 23, 59, 0, 0, time.UTC), 21}, // the day before
		{time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC), 22},   // the birthday
		{time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC), 22},
		{time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC), 21},  // December, not yet
	}
	for _, tt := range tests {
		if got := ageOn(birth, tt.on); got != tt.want {
			t.Fatalf("ageOn(%s) = %d, want %d", tt.on.Format(time.DateOnly), got, tt.want)
		}
	}
}

func TestAgeOnHandlesLeapDayBirthdays(t *testing.T) {
	t.Parallel()
	// Born 29 February. In a non-leap year the birthday lands on 1 March, which
	// is the convention every registry uses and the only one that never reports
	// someone a year older than they are.
	leap := time.Date(2000, 2, 29, 0, 0, 0, 0, time.UTC)
	if got := ageOn(leap, time.Date(2026, 2, 28, 0, 0, 0, 0, time.UTC)); got != 25 {
		t.Fatalf("28 Feb = %d, want 25", got)
	}
	if got := ageOn(leap, time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)); got != 26 {
		t.Fatalf("1 Mar = %d, want 26", got)
	}
}

func TestResultAndScore(t *testing.T) {
	t.Parallel()
	score := func(home, away int) (*int, *int) { return &home, &away }

	homeScore, awayScore := score(3, 1)
	result, display := resultAndScore(espn.MatchStateFinished, true, homeScore, awayScore)
	if result == nil || *result != "W" || display == nil || *display != "3-1" {
		t.Fatalf("home win = %v %v", result, display)
	}

	// The same match from the away side: the score is written from the player's
	// team's perspective, so it reads 1-3 and not 3-1.
	result, display = resultAndScore(espn.MatchStateFinished, false, homeScore, awayScore)
	if result == nil || *result != "L" || display == nil || *display != "1-3" {
		t.Fatalf("away loss = %v %v", result, display)
	}

	homeScore, awayScore = score(2, 2)
	result, display = resultAndScore(espn.MatchStateFinished, true, homeScore, awayScore)
	if result == nil || *result != "D" || display == nil || *display != "2-2" {
		t.Fatalf("draw = %v %v", result, display)
	}

	// Live: there is a score, but 1-0 at 20' is not a win. Result stays null
	// until the match is finished.
	homeScore, awayScore = score(1, 0)
	result, display = resultAndScore(espn.MatchStateLive, true, homeScore, awayScore)
	if result != nil || display == nil || *display != "1-0" {
		t.Fatalf("live = %v %v", result, display)
	}

	// Scheduled and unscored: both null. Not "0-0", which is a claim that a
	// goalless match was played.
	result, display = resultAndScore(espn.MatchStateScheduled, true, nil, nil)
	if result != nil || display != nil {
		t.Fatalf("unscored = %v %v", result, display)
	}

	// A half-populated pair is not a score either.
	only := 2
	if result, display = resultAndScore(espn.MatchStateFinished, true, &only, nil); result != nil || display != nil {
		t.Fatalf("half score = %v %v", result, display)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestAgeOn|TestResultAndScore"
```

Expected: FAIL — `undefined: ageOn`, `undefined: resultAndScore`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// CareerStint is one club spell from the provider's own team history. ordinal is
// the provider's array position, so a career reads back in the order it was told
// without us parsing a season label into a sort key.
type CareerStint struct {
	Ordinal      int     `json:"ordinal"`
	TeamID       *string `json:"teamId"`
	TeamName     string  `json:"teamName"`
	TeamCrestURL *string `json:"teamCrestUrl"`
	SeasonsLabel string  `json:"seasonsLabel"`
	StartYear    *int    `json:"startYear"`
	EndYear      *int    `json:"endYear"`
}

// PlayerProfile is competition-agnostic. A person is not scoped to a
// competition; their season stats are, which is why this type carries no stat.
//
// Age is computed from BirthDate at request time and is null when the birth date
// is unknown. HeadshotUrl is null far more often than not - it was null for the
// athlete this design was verified against - and is never the empty string.
type PlayerProfile struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	ShortName   *string       `json:"shortName"`
	Position    *string       `json:"position"`
	Nationality *string       `json:"nationality"`
	HeadshotURL *string       `json:"headshotUrl"`
	BirthDate   *string       `json:"birthDate"` // YYYY-MM-DD
	Age         *int          `json:"age"`
	HeightCm    *int          `json:"heightCm"`
	WeightKg    *int          `json:"weightKg"`
	Career      []CareerStint `json:"career"`
}

// PlayerSeasonStats carries ESPN's own statsSummary names rather than prettier
// ones. The ingester writes what the provider names, the reader returns it, and
// there is one vocabulary for a number instead of two. Every field is a pointer:
// a goalkeeper has no offsides and a striker has no saves, and null is the only
// honest way to say "not measured".
type PlayerSeasonStats struct {
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
}

// PlayerSeason is the competition-scoped view: who they are, who they played
// for, what they did. Team is null when we hold a stat line but no club for it.
type PlayerSeason struct {
	Player PlayerProfile     `json:"player"`
	Team   *espn.Team        `json:"team"`
	Stats  PlayerSeasonStats `json:"stats"`
}

// GameLogRow is one appearance. Opponent is resolved from the match's own team
// ids, never from row order. Result is null for anything not finished, and Score
// is written from the player's team's perspective.
type GameLogRow struct {
	MatchID  string           `json:"matchId"`
	Kickoff  string           `json:"kickoff"`
	Opponent espn.Team        `json:"opponent"`
	Home     bool             `json:"home"`
	Result   *string          `json:"result"` // "W" | "D" | "L" | null
	Score    *string          `json:"score"`  // "2-1" from this player's side
	Starter  bool             `json:"starter"`
	Stats    PlayerMatchStats `json:"stats"`
}
```

Create `backend/reader/store_players.go` with the two pure helpers (the reads
land in Tasks 3 and 4):

```go
package main

import (
	"fmt"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// ageOn returns whole years elapsed between birth and on.
//
// The comparison is month-then-day rather than day-of-year, because day-of-year
// is off by one across a leap boundary for everyone born after February. A 29
// February birthday therefore turns over on 1 March in a non-leap year, which is
// the convention that never reports someone older than they are.
func ageOn(birth, on time.Time) int {
	years := on.Year() - birth.Year()
	if on.Month() < birth.Month() ||
		(on.Month() == birth.Month() && on.Day() < birth.Day()) {
		years--
	}
	return years
}

// resultAndScore derives a game-log row's outcome from the match's scores and
// the side the player's team was on.
//
// Two rules, both deliberate:
//
//   - No score, no strings. A scheduled match returns (nil, nil) rather than
//     "0-0", which would be a claim that a goalless match was played.
//   - A live match has a score but no result. 1-0 at 20' is not a win, and a
//     game log that says otherwise will be screenshotted at 21'.
//
// A knockout tie level after 90 and decided on penalties reads "D" here, which
// is the correct match result; the shootout belongs to the match, not to a
// player's appearance row.
func resultAndScore(state espn.MatchState, playedHome bool, homeScore, awayScore *int) (*string, *string) {
	if homeScore == nil || awayScore == nil {
		return nil, nil
	}
	mine, theirs := *homeScore, *awayScore
	if !playedHome {
		mine, theirs = *awayScore, *homeScore
	}
	display := fmt.Sprintf("%d-%d", mine, theirs)
	if state != espn.MatchStateFinished {
		return nil, &display
	}
	outcome := "D"
	switch {
	case mine > theirs:
		outcome = "W"
	case mine < theirs:
		outcome = "L"
	}
	return &outcome, &display
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestAgeOn|TestResultAndScore" && go vet ./reader
```

Expected: build clean, `ok`, vet silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/types.go backend/reader/store_players.go backend/reader/store_players_test.go
git commit -m "feat(reader): add player response types and their two derivations

Age is computed from birth_date at request time, month-then-day so it is
never a year out across a leap boundary. A game-log row's result is null
until the match is finished - a live 1-0 is a score, not a win - and the
score is written from the player's team's perspective.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `Player` and `PlayerSeason` — the two profile reads

**Files:**
- Modify: `backend/reader/store_players.go`
- Test: `backend/reader/store_integration_test.go` (seed rows + a new test)

**Interfaces:**
- `Store.Player(ctx, id string) (*PlayerProfile, error)` — `ErrNotFound` when unknown.
- `Store.PlayerSeason(ctx, competition, season, id string) (*PlayerSeason, error)` — `ErrNotFound` when the player is unknown, `ErrNoSeasonRecord` when we know them but hold no row for this competition season.

**Two 404s, deliberately.** "We have never heard of this id" and "we know this
player but hold nothing for them in this competition season" are different facts
and the caller can act differently on each. What neither of them is: an empty
stat object full of zeros. A zero in `totalGoals` is a claim that the player
appeared and did not score. We do not hold that claim, so we do not make it.

**Contrast that with `career: []`,** which this task returns happily for a player
with no stints. The difference is between an **empty collection** and a
**fabricated measurement**: an empty array reads as "no career history recorded",
which is exactly true, while `{"totalGoals": 0}` reads as a measurement that was
taken. One is an absent list; the other is an invented number.

- [ ] **Step 1: Write the failing test**

First extend `seedIntegrationData` in `backend/reader/store_integration_test.go`.
Add these statements to the `statements` slice, after the existing leaderboard
insert (`top_scorer`, or `stat_leader` if the `api-leaders-and-box-scores` plan has
landed and renamed it). The two new `premier-league` matches are deliberately in a
competition whose match rows no other test asserts a count on — `world-cup` counts
are asserted by `TestStoreIntegration` and by the `api-match-reads` filter tests,
and adding a finished world-cup match would break both:

```go
		`INSERT INTO match
			(id, comp_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, minute, status_detail, status_name, winner_id, note,
			 home_placeholder, away_placeholder)
		 VALUES
			('pl-finished', 'premier-league', '2026-27', NULL, '2026-08-22T14:00:00Z', 'finished', 'arg', 'fra', 3, 1, NULL, 'FT', 'STATUS_FULL_TIME', 'arg', NULL, false, false),
			('pl-away-loss', 'premier-league', '2026-27', NULL, '2026-08-29T14:00:00Z', 'finished', 'crestless', 'arg', 2, 0, NULL, 'FT', 'STATUS_FULL_TIME', 'crestless', NULL, false, false)`,
		`INSERT INTO player
			(id, name, short_name, position, nationality, headshot_url, birth_date, height_cm, weight_kg)
		 VALUES
			('messi', 'Lionel Messi', 'Messi', 'Forward', 'Argentina', 'https://cdn.scorearc.futbol/messi.png', '1987-06-24', 170, 72),
			('297287', 'Ali Avila', NULL, 'Forward', 'Mexico', NULL, '2004-01-15', 175, 70),
			('ghost', 'Ghost Winger', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
		`INSERT INTO player_season_stat (comp_id, season_id, player_id, team_id, stats) VALUES
			('world-cup', '2026', 'messi', 'arg',
			 '{"appearances":6,"starts":6,"subIns":0,"totalGoals":7,"goalAssists":3,"totalShots":21,"shotsOnTarget":11,"offsides":2,"foulsCommitted":4,"foulsSuffered":9,"yellowCards":1,"redCards":0,"ownGoals":0}'),
			('premier-league', '2026-27', 'messi', 'arg', '{"appearances":2,"totalGoals":2,"goalAssists":1}'),
			('world-cup', '2026', '297287', NULL, '{"appearances":3,"totalGoals":3}')`,
		`INSERT INTO player_career_stint
			(player_id, ordinal, team_id, team_name, team_crest_url, seasons_label, start_year, end_year)
		 VALUES
			('messi', 1, 'arg', 'Argentina', 'https://cdn.scorearc.futbol/arg.png', '2005-CURRENT', 2005, NULL),
			('messi', 2, NULL, 'Newell''s Old Boys', NULL, '1995-2000', 1995, 2000)`,
		`INSERT INTO match_player_stat (match_id, team_id, player_id, player, position, starter, stats) VALUES
			('pl-finished', 'arg', 'messi', 'Lionel Messi', 'F', true,
			 '{"appearances":1,"totalGoals":2,"goalAssists":1,"totalShots":5,"shotsOnTarget":3}'),
			('pl-away-loss', 'arg', 'messi', 'Lionel Messi', 'F', false,
			 '{"appearances":1,"totalGoals":0,"totalShots":1,"shotsOnTarget":0}'),
			('match-final', 'arg', 'messi', 'Lionel Messi', 'F', true,
			 '{"appearances":1,"totalGoals":1,"totalShots":4,"shotsOnTarget":2}'),
			('other-comp', 'tbd', 'messi', 'Lionel Messi', 'F', true, '{"appearances":1}')`,
```

`match_player_stat.player` is `NOT NULL` and `team_id` comes before `player_id` in
that table — the column list above is written in the table's own order. **The
`api-leaders-and-box-scores` plan also seeds `match_player_stat` rows** for its box
score tests; the primary key is `(match_id, player_id)`, so if it already seeded a
row for `('match-final', 'messi')`, merge rather than duplicate — add your stats to
its row and drop the duplicate line here.

The last `match_player_stat` row is a fixture for a defect, not a happy path:
`other-comp` is `arg` vs `fra`, and this row claims `messi` played it for `tbd`.
A team that is on neither side of the fixture cannot have an opponent, and Task 4
excludes it rather than rendering a player as his own opponent.

Now append the test:

```go
func TestStorePlayerProfileAndSeason(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("profile carries identity, a computed age and an ordered career", func(t *testing.T) {
		profile, err := store.Player(ctx, "messi")
		if err != nil {
			t.Fatal(err)
		}
		if profile.Name != "Lionel Messi" || profile.BirthDate == nil || *profile.BirthDate != "1987-06-24" {
			t.Fatalf("profile = %+v", profile)
		}
		if profile.Age == nil || *profile.Age != ageOn(time.Date(1987, 6, 24, 0, 0, 0, 0, time.UTC), time.Now().UTC()) {
			t.Fatalf("age = %v", profile.Age)
		}
		if profile.HeadshotURL == nil || len(profile.Career) != 2 {
			t.Fatalf("headshot/career = %v %+v", profile.HeadshotURL, profile.Career)
		}
		if profile.Career[0].Ordinal != 1 || profile.Career[1].TeamID != nil || profile.Career[1].EndYear == nil {
			t.Fatalf("career = %+v", profile.Career)
		}
	})

	t.Run("an unknown birth date is a null age, never zero", func(t *testing.T) {
		profile, err := store.Player(ctx, "ghost")
		if err != nil {
			t.Fatal(err)
		}
		if profile.Age != nil || profile.BirthDate != nil || profile.HeadshotURL != nil {
			t.Fatalf("ghost = %+v", profile)
		}
		// No stints is an empty list, not nil: an empty career is a true
		// statement, unlike an invented stat line.
		if profile.Career == nil || len(profile.Career) != 0 {
			t.Fatalf("career = %#v", profile.Career)
		}
	})

	t.Run("an unknown player is ErrNotFound", func(t *testing.T) {
		if _, err := store.Player(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("season stats carry the club and leave absent stats null", func(t *testing.T) {
		season, err := store.PlayerSeason(ctx, "world-cup", "2026", "messi")
		if err != nil {
			t.Fatal(err)
		}
		if season.Team == nil || season.Team.ID != "arg" || season.Player.Name != "Lionel Messi" {
			t.Fatalf("season = %+v", season)
		}
		if season.Stats.TotalGoals == nil || *season.Stats.TotalGoals != 7 {
			t.Fatalf("totalGoals = %v", season.Stats.TotalGoals)
		}
		// A forward has no saves. The provider omitted the stat, so it stays
		// null rather than becoming a zero we invented.
		if season.Stats.Saves != nil || season.Stats.GoalsConceded != nil {
			t.Fatalf("keeper stats leaked onto a forward: %+v", season.Stats)
		}
	})

	t.Run("a stat line with no club still returns", func(t *testing.T) {
		season, err := store.PlayerSeason(ctx, "world-cup", "2026", "297287")
		if err != nil {
			t.Fatal(err)
		}
		if season.Team != nil || season.Stats.TotalGoals == nil || *season.Stats.TotalGoals != 3 {
			t.Fatalf("season = %+v", season)
		}
	})

	t.Run("known player, no row for this season, is a distinct error", func(t *testing.T) {
		_, err := store.PlayerSeason(ctx, "world-cup", "2026", "ghost")
		if !errors.Is(err, ErrNoSeasonRecord) {
			t.Fatalf("err = %v, want ErrNoSeasonRecord", err)
		}
		_, err = store.PlayerSeason(ctx, "world-cup", "2026", "nobody")
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStorePlayerProfileAndSeason
```

Expected: FAIL — `store.Player undefined`, `undefined: ErrNoSeasonRecord`.

- [ ] **Step 3: Implement**

Append to `backend/reader/store_players.go` (and extend its import block with
`context`, `errors`, `github.com/jackc/pgx/v5`):

```go
// ErrNoSeasonRecord separates "we do not know this player" from "we know them
// and hold no row for this competition season". Both are 404s to a client, but
// they are different facts and the messages differ. Neither is ever answered
// with a stat object of zeros.
var ErrNoSeasonRecord = errors.New("no season record")

const playerSQL = `
SELECT p.id, p.name, p.short_name, p.position, p.nationality, p.headshot_url,
       p.birth_date, p.height_cm, p.weight_kg
FROM player p
WHERE p.id = $1`

const playerCareerSQL = `
SELECT c.ordinal, c.team_id, c.team_name, c.team_crest_url,
       c.seasons_label, c.start_year, c.end_year
FROM player_career_stint c
WHERE c.player_id = $1
ORDER BY c.ordinal`

// Player returns identity plus career history. Deliberately two statements
// rather than one join: a join repeats the identity columns once per stint and
// forces a nil-row dance for a player with no career at all, in exchange for
// saving one primary-key lookup. Two indexed reads are cheaper to read and to
// reason about than that trade.
func (s *Store) Player(ctx context.Context, id string) (*PlayerProfile, error) {
	profile := &PlayerProfile{Career: []CareerStint{}}
	var birth *time.Time
	if err := s.db.QueryRow(ctx, playerSQL, id).Scan(
		&profile.ID, &profile.Name, &profile.ShortName, &profile.Position,
		&profile.Nationality, &profile.HeadshotURL, &birth,
		&profile.HeightCm, &profile.WeightKg,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if birth != nil {
		date := birth.UTC().Format(time.DateOnly)
		age := ageOn(*birth, time.Now().UTC())
		profile.BirthDate, profile.Age = &date, &age
	}

	rows, err := s.db.Query(ctx, playerCareerSQL, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var stint CareerStint
		if err := rows.Scan(
			&stint.Ordinal, &stint.TeamID, &stint.TeamName, &stint.TeamCrestURL,
			&stint.SeasonsLabel, &stint.StartYear, &stint.EndYear,
		); err != nil {
			return nil, err
		}
		profile.Career = append(profile.Career, stint)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return profile, nil
}

const playerSeasonSQL = `
SELECT s.stats, t.id, t.name, t.abbr, t.crest_url
FROM player_season_stat s
LEFT JOIN team t ON t.id = s.team_id
WHERE s.comp_id = $1 AND s.season_id = $2 AND s.player_id = $3`

// PlayerSeason reads the profile first so an unknown id costs one primary-key
// lookup and stops, rather than paying for a career read and a season read to
// discover the same thing.
func (s *Store) PlayerSeason(ctx context.Context, competition, season, id string) (*PlayerSeason, error) {
	profile, err := s.Player(ctx, id)
	if err != nil {
		return nil, err
	}

	var stats []byte
	var teamID, teamName, teamAbbr *string
	var crestURL *string
	if err := s.db.QueryRow(ctx, playerSeasonSQL, competition, season, id).Scan(
		&stats, &teamID, &teamName, &teamAbbr, &crestURL,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNoSeasonRecord
		}
		return nil, err
	}

	result := &PlayerSeason{Player: *profile}
	if err := jsonInto(stats, &result.Stats); err != nil {
		return nil, err
	}
	// team_id is nullable and the join is a LEFT JOIN, so a stat line we hold
	// without a club returns a null team rather than an empty one wearing no
	// name.
	if teamID != nil && teamName != nil && teamAbbr != nil {
		result.Team = &espn.Team{ID: *teamID, Name: *teamName, Abbr: *teamAbbr, CrestURL: crestURL}
	}
	return result, nil
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStorePlayerProfileAndSeason
```

Expected: `ok`. (Docker required.)

```bash
cd backend && go test -race ./reader
```

Expected: `ok` — the existing suite still passes with the widened seed data.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_players.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read player identity, career and season stats

Two distinct not-found signals: an unknown id, and a known player with no
row for this competition season. Neither is answered with a stat object
of zeros - a zero in totalGoals is a claim that the player appeared and
did not score, and we do not hold that claim.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `PlayerGameLog` — every match we hold

**Files:**
- Modify: `backend/reader/store_players.go`
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `type GameLogFilter struct { From, To *time.Time; Order string; Limit *int }`
- `Store.PlayerGameLog(ctx, competition, season, playerID string, filter GameLogFilter) ([]GameLogRow, error)`

**Why `GameLogFilter` and not `MatchFilter`.** `MatchFilter` carries a `State`
field, and this read has no use for one — filtering a game log by `state=live`
asks for the at most one row a player can currently be playing. A struct field the
read silently ignores is a promise the API does not keep, so the filter is its own
four-field type.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStorePlayerGameLog(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	day := func(year int, month time.Month, dayOfMonth int) *time.Time {
		value := time.Date(year, month, dayOfMonth, 0, 0, 0, 0, time.UTC)
		return &value
	}

	t.Run("every appearance of the season, in kickoff order", func(t *testing.T) {
		rows, err := store.PlayerGameLog(ctx, "premier-league", "2026-27", "messi", GameLogFilter{Order: "asc"})
		if err != nil {
			t.Fatal(err)
		}
		// Three match_player_stat rows exist for this player in this season's
		// competition; one of them names a team that is on neither side of its
		// fixture and must be excluded rather than rendered.
		if len(rows) != 2 {
			t.Fatalf("rows = %+v", rows)
		}
		if rows[0].MatchID != "pl-finished" || !rows[0].Home || rows[0].Opponent.ID != "fra" {
			t.Fatalf("home row = %+v", rows[0])
		}
		if rows[0].Result == nil || *rows[0].Result != "W" || rows[0].Score == nil || *rows[0].Score != "3-1" {
			t.Fatalf("home result = %v %v", rows[0].Result, rows[0].Score)
		}
		if !rows[0].Starter || rows[0].Stats.TotalGoals == nil || *rows[0].Stats.TotalGoals != 2 {
			t.Fatalf("home stats = %+v", rows[0])
		}
		// Away: the opponent is the home side, the score is written from this
		// player's perspective, and the crest is null and stays null.
		if rows[1].Home || rows[1].Opponent.ID != "crestless" || rows[1].Opponent.CrestURL != nil {
			t.Fatalf("away opponent = %+v", rows[1].Opponent)
		}
		if rows[1].Result == nil || *rows[1].Result != "L" || rows[1].Score == nil || *rows[1].Score != "0-2" {
			t.Fatalf("away result = %v %v", rows[1].Result, rows[1].Score)
		}
		if rows[1].Starter {
			t.Fatalf("substitute row reported as a starter: %+v", rows[1])
		}
	})

	t.Run("a live match has a score and no result", func(t *testing.T) {
		rows, err := store.PlayerGameLog(ctx, "world-cup", "2026", "messi", GameLogFilter{Order: "asc"})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0].MatchID != "match-final" {
			t.Fatalf("rows = %+v", rows)
		}
		if rows[0].Result != nil || rows[0].Score == nil || *rows[0].Score != "2-2" {
			t.Fatalf("live row = %v %v", rows[0].Result, rows[0].Score)
		}
		if rows[0].Kickoff != "2026-07-19T19:00:00Z" {
			t.Fatalf("kickoff = %q", rows[0].Kickoff)
		}
	})

	t.Run("desc plus limit is the most recent N", func(t *testing.T) {
		one := 1
		rows, err := store.PlayerGameLog(ctx, "premier-league", "2026-27", "messi",
			GameLogFilter{Order: "desc", Limit: &one})
		if err != nil || len(rows) != 1 || rows[0].MatchID != "pl-away-loss" {
			t.Fatalf("rows = %+v, err %v", rows, err)
		}
	})

	t.Run("the window is half-open and includes the last named day", func(t *testing.T) {
		rows, err := store.PlayerGameLog(ctx, "premier-league", "2026-27", "messi",
			GameLogFilter{From: day(2026, 8, 22), To: day(2026, 8, 23), Order: "asc"})
		if err != nil || len(rows) != 1 || rows[0].MatchID != "pl-finished" {
			t.Fatalf("windowed rows = %+v, err %v", rows, err)
		}
	})

	t.Run("no rows is an empty slice, not an error and not nil", func(t *testing.T) {
		rows, err := store.PlayerGameLog(ctx, "premier-league", "2026-27", "ghost", GameLogFilter{Order: "asc"})
		if err != nil || rows == nil || len(rows) != 0 {
			t.Fatalf("rows = %#v, err %v", rows, err)
		}
		unknown, err := store.PlayerGameLog(ctx, "premier-league", "2026-27", "nobody", GameLogFilter{Order: "asc"})
		if err != nil || unknown == nil || len(unknown) != 0 {
			t.Fatalf("unknown player rows = %#v, err %v", unknown, err)
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStorePlayerGameLog
```

Expected: FAIL — `store.PlayerGameLog undefined`, `undefined: GameLogFilter`.

- [ ] **Step 3: Implement**

Append to `backend/reader/store_players.go`:

```go
// GameLogFilter is the validated shape of the game log's query string. The zero
// value is "every appearance of the season in kickoff order".
//
// It is not MatchFilter: that type carries a State, and filtering a game log by
// state asks for the at most one match a player can currently be playing. A
// field the read ignores is a promise the API does not keep.
type GameLogFilter struct {
	From  *time.Time // inclusive
	To    *time.Time // exclusive
	Order string     // "asc" (default) or "desc"
	Limit *int       // nil means no limit
}

// The opponent is resolved from the match's own team ids, never from row order:
// a game log that decides who someone played by which column it read first is
// one schema change away from being wrong and looking right.
//
// The IN predicate is the guard for a row whose team is on neither side of its
// fixture. Without it the CASE falls through to the home side and a player is
// rendered as his own opponent. Excluding the row states nothing; rendering it
// states something false.
const playerGameLogSQL = `
SELECT m.id, m.kickoff, m.state, m.home_score, m.away_score,
       (m.home_team_id = ps.team_id) AS played_home,
       ps.starter, ps.stats,
       opponent.id, opponent.name, opponent.abbr, opponent.crest_url
FROM match_player_stat ps
JOIN match m ON m.id = ps.match_id
JOIN team opponent ON opponent.id = CASE
    WHEN m.home_team_id = ps.team_id THEN m.away_team_id
    ELSE m.home_team_id
  END
WHERE ps.player_id = $1
  AND m.comp_id = $2
  AND m.season_id = $3
  AND ps.team_id IN (m.home_team_id, m.away_team_id)
  AND ($4::timestamptz IS NULL OR m.kickoff >= $4)
  AND ($5::timestamptz IS NULL OR m.kickoff <  $5)
`

// The only fragment in this file concatenated rather than bound. Its key is the
// output of parseOrder, which returns one of exactly two constants, so no
// request text can reach the statement. LIMIT takes a placeholder because
// Postgres reads LIMIT NULL as "no limit", which is how an absent ?limit= is
// expressed without a second query.
var gameLogOrderSQL = map[string]string{
	"asc":  "ORDER BY m.kickoff, m.id LIMIT $6",
	"desc": "ORDER BY m.kickoff DESC, m.id DESC LIMIT $6",
}

// PlayerGameLog returns every appearance we hold for a player in one competition
// season. ESPN's /overview serves five matches; this serves the season, because
// the ingester writes match_player_stat for every match rather than the recent
// ones. That difference is the endpoint's entire reason to exist.
func (s *Store) PlayerGameLog(ctx context.Context, competition, season, playerID string, filter GameLogFilter) ([]GameLogRow, error) {
	order := filter.Order
	if order == "" {
		order = "asc"
	}
	clause, known := gameLogOrderSQL[order]
	if !known {
		// Unreachable through the router - parseOrder runs first - but a store
		// that trusts its caller here would be one refactor from a hole.
		return nil, fmt.Errorf("unknown game log order %q", order)
	}

	rows, err := s.db.Query(ctx, playerGameLogSQL+clause,
		playerID, competition, season, filter.From, filter.To, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	log := make([]GameLogRow, 0)
	for rows.Next() {
		var row GameLogRow
		var kickoff time.Time
		var state string
		var homeScore, awayScore *int
		var stats []byte
		if err := rows.Scan(
			&row.MatchID, &kickoff, &state, &homeScore, &awayScore,
			&row.Home, &row.Starter, &stats,
			&row.Opponent.ID, &row.Opponent.Name, &row.Opponent.Abbr, &row.Opponent.CrestURL,
		); err != nil {
			return nil, err
		}
		row.Kickoff = isoTime(kickoff)
		if err := jsonInto(stats, &row.Stats); err != nil {
			return nil, err
		}
		row.Result, row.Score = resultAndScore(espn.MatchState(state), row.Home, homeScore, awayScore)
		log = append(log, row)
	}
	return log, rows.Err()
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run TestStorePlayerGameLog
```

Expected: `ok`. (Docker required.)

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_players.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read a player's full-season game log

ESPN's /overview serves the last five matches. This serves every match we
hold, which is the concrete payoff of owning the data. The opponent is
resolved from the match's own team ids rather than row order, a row whose
team is on neither side is excluded, and the result is null until the
match is finished.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Three routes, end to end

**Files:**
- Create: `backend/reader/handlers_players.go`
- Modify: `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`

- [ ] **Step 1: Write the failing test**

First extend `fakeReaderStore` in `backend/reader/server_test.go` with the fields
the tests assert on:

```go
	player          *PlayerProfile
	playerErr       error
	playerSeason    *PlayerSeason
	playerSeasonErr error
	gameLog         []GameLogRow
	gameLogErr      error
	gameLogFilter   GameLogFilter
```

and the three methods:

```go
func (f *fakeReaderStore) Player(context.Context, string) (*PlayerProfile, error) {
	f.calls++
	return f.player, f.playerErr
}
func (f *fakeReaderStore) PlayerSeason(context.Context, string, string, string) (*PlayerSeason, error) {
	f.calls++
	return f.playerSeason, f.playerSeasonErr
}
func (f *fakeReaderStore) PlayerGameLog(_ context.Context, _ string, _ string, _ string, filter GameLogFilter) ([]GameLogRow, error) {
	f.calls++
	f.gameLogFilter = filter
	return f.gameLog, f.gameLogErr
}
```

Then append the tests:

```go
func TestPlayerRoutesAndCachePolicies(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{
		player:       &PlayerProfile{ID: "messi", Name: "Lionel Messi", Career: []CareerStint{}},
		playerSeason: &PlayerSeason{Player: PlayerProfile{ID: "messi", Name: "Lionel Messi", Career: []CareerStint{}}},
		gameLog:      []GameLogRow{},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	tests := []struct {
		path         string
		cacheControl string
		array        bool
	}{
		// A person's name, position and birth date do not move. Five minutes.
		{path: "/v1/players/messi", cacheControl: "public, max-age=300"},
		{path: "/v1/competitions/world-cup/2026/players/messi", cacheControl: "public, max-age=60"},
		{path: "/v1/competitions/world-cup/2026/players/messi/game-log", cacheControl: "public, max-age=60", array: true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			recorder := performRequest(router, http.MethodGet, tt.path)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Cache-Control"); got != tt.cacheControl {
				t.Fatalf("Cache-Control = %q, want %q", got, tt.cacheControl)
			}
			if tt.array && recorder.Body.String() != "[]\n" {
				t.Fatalf("empty game log = %q", recorder.Body.String())
			}
		})
	}
}

func TestPlayerNotFoundMessagesAreDistinct(t *testing.T) {
	t.Parallel()
	unknown := performRequest(
		newTestApp(t, &fakeReaderStore{playerErr: ErrNotFound}, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/players/nobody")
	if unknown.Code != http.StatusNotFound || !strings.Contains(unknown.Body.String(), "player not found") {
		t.Fatalf("unknown player = %d %s", unknown.Code, unknown.Body.String())
	}

	// A player we know with nothing in this competition season is a different
	// fact, and it is never answered with a stat object of zeros.
	noRecord := performRequest(
		newTestApp(t, &fakeReaderStore{playerSeasonErr: ErrNoSeasonRecord}, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/competitions/world-cup/2026/players/messi")
	if noRecord.Code != http.StatusNotFound ||
		!strings.Contains(noRecord.Body.String(), "player has no record in this competition season") {
		t.Fatalf("no season record = %d %s", noRecord.Code, noRecord.Body.String())
	}
	if strings.Contains(noRecord.Body.String(), "totalGoals") {
		t.Fatalf("a missing season record returned stats: %s", noRecord.Body.String())
	}
}

func TestPlayerIDsAndGameLogParametersAreValidatedBeforeTheStore(t *testing.T) {
	t.Parallel()
	paths := []string{
		"/v1/players/not%20an%20id",
		"/v1/competitions/world-cup/2026/players/not%20an%20id",
		"/v1/competitions/world-cup/2026/players/x'%20OR%20'1'='1/game-log",
		"/v1/competitions/world-cup/2026/players/messi/game-log?range=2026-08-01",
		"/v1/competitions/world-cup/2026/players/messi/game-log?range=20260101-20261231",
		"/v1/competitions/world-cup/2026/players/messi/game-log?order=DESC",
		"/v1/competitions/world-cup/2026/players/messi/game-log?limit=501",
		"/v1/competitions/world-cup/2026/players/messi/game-log?limit=abc",
	}
	for _, path := range paths {
		store := &fakeReaderStore{gameLog: []GameLogRow{}}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, path)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", path, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", path)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s Cache-Control = %q", path, response.Header().Get("Cache-Control"))
		}
	}
}

func TestGameLogFilterIsParsedAndDefaulted(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{gameLog: []GameLogRow{}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	if response := performRequest(router, http.MethodGet,
		"/v1/competitions/world-cup/2026/players/messi/game-log?range=20260801-20260831&order=desc&limit=25"); response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	filter := store.gameLogFilter
	if filter.From == nil || !filter.From.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("From = %v", filter.From)
	}
	if filter.To == nil || !filter.To.Equal(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("To = %v", filter.To)
	}
	if filter.Order != "desc" || filter.Limit == nil || *filter.Limit != 25 {
		t.Fatalf("filter = %+v", filter)
	}

	// The default is the whole season ascending with no limit. A season of
	// appearances cannot exceed roughly sixty rows, so no limit is the right
	// default and the 500 cap is a guard rather than a paging mechanism.
	store.gameLogFilter = GameLogFilter{}
	if response := performRequest(router, http.MethodGet,
		"/v1/competitions/world-cup/2026/players/messi/game-log"); response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if filter = store.gameLogFilter; filter.From != nil || filter.To != nil || filter.Order != "asc" || filter.Limit != nil {
		t.Fatalf("default filter = %+v", filter)
	}
}

func TestAbsentPlayerFieldsSerializeAsNull(t *testing.T) {
	t.Parallel()
	// A headshot we do not have is null, never "". An age we cannot compute is
	// null, never 0 - a zero would make every player without a birth date a
	// newborn. A player with no stints gets [], which is a true statement about
	// a collection rather than an invented measurement.
	store := &fakeReaderStore{player: &PlayerProfile{ID: "ghost", Name: "Ghost Winger"}}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, "/v1/players/ghost")
	body := response.Body.String()
	for _, want := range []string{`"headshotUrl":null`, `"age":null`, `"birthDate":null`, `"career":[]`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if strings.Contains(body, `"age":0`) || strings.Contains(body, `"headshotUrl":""`) {
		t.Fatalf("absent value rendered as a value: %s", body)
	}
}
```

Add these rows to the existing `TestDependencyErrorsAreSanitized` table so the new
routes are covered by the leak check too:

```go
		{name: "player database", path: "/v1/players/messi", store: &fakeReaderStore{playerErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "player season database", path: "/v1/competitions/world-cup/2026/players/messi", store: &fakeReaderStore{playerSeasonErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
		{name: "game log database", path: "/v1/competitions/world-cup/2026/players/messi/game-log", store: &fakeReaderStore{gameLogErr: secret}, news: &fakeNewsReader{}, status: http.StatusInternalServerError},
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestPlayer|TestGameLog|TestAbsentPlayer"
```

Expected: FAIL — the fake does not satisfy `readerStore` yet and all three paths
return 404 from the router's `NotFound` handler.

- [ ] **Step 3: Implement**

Create `backend/reader/handlers_players.go`:

```go
package main

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// parseGameLogFilter turns the query string into a validated GameLogFilter, or
// into the exact 400 message the caller gets. Every branch returns before any
// dependency is touched: an invalid parameter must not cost a query. There is no
// state parameter here - see GameLogFilter.
func parseGameLogFilter(request *http.Request) (GameLogFilter, error) {
	query := request.URL.Query()
	filter := GameLogFilter{}

	if raw := query.Get("range"); raw != "" {
		from, to, err := parseDateRange(raw)
		if err != nil {
			return GameLogFilter{}, err
		}
		filter.From, filter.To = &from, &to
	}
	order, err := parseOrder(query.Get("order"))
	if err != nil {
		return GameLogFilter{}, err
	}
	filter.Order = order

	// maxMatchLimit is a guard, not a page size. A season cannot hold 500
	// appearances; the cap exists so a caller who finds ?limit= cannot ask for
	// something absurd, and so the number in openapi.yaml is enforced.
	limit, err := parseLimit(query.Get("limit"), maxMatchLimit)
	if err != nil {
		return GameLogFilter{}, err
	}
	filter.Limit = limit
	return filter, nil
}

func (a *App) handlePlayer(writer http.ResponseWriter, request *http.Request) {
	id, err := parseEntityID(chi.URLParam(request, "playerId"))
	if err != nil {
		// Safe to echo: every error out of params.go is a constant declared
		// there, never a wrapped dependency error.
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	profile, storeErr := a.store.Player(request.Context(), id)
	if errors.Is(storeErr, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "player not found")
		return
	}
	if storeErr != nil {
		a.logger.Error("player", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if profile.Career == nil {
		profile.Career = []CareerStint{}
	}
	// Identity is near-static: a name, a position and a birth date do not move
	// during a match. The one derived field, age, changes once a year.
	cacheFor(writer, 300)
	writeJSON(writer, http.StatusOK, profile)
}

func (a *App) handlePlayerSeason(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	id, err := parseEntityID(chi.URLParam(request, "playerId"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	result, storeErr := a.store.PlayerSeason(request.Context(), competition, season, id)
	if errors.Is(storeErr, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "player not found")
		return
	}
	// A player we know with no row for this competition season is a different
	// answer from an unknown player, and both are different from a stat object
	// of zeros - which would claim they played and did nothing.
	if errors.Is(storeErr, ErrNoSeasonRecord) {
		writeError(writer, http.StatusNotFound, "player has no record in this competition season")
		return
	}
	if storeErr != nil {
		a.logger.Error("player season", "competition", competition, "season", season, "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if result.Player.Career == nil {
		result.Player.Career = []CareerStint{}
	}
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, result)
}

func (a *App) handlePlayerGameLog(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	id, err := parseEntityID(chi.URLParam(request, "playerId"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	filter, err := parseGameLogFilter(request)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// A player we do not know returns an empty log rather than a 404. The array
	// is the set of appearances we hold, and an empty set is an honest answer;
	// proving the id exists would cost a second query on every request to
	// distinguish a case the caller already learned from the profile endpoint.
	log, storeErr := a.store.PlayerGameLog(request.Context(), competition, season, id, filter)
	if storeErr != nil {
		a.logger.Error("player game log", "competition", competition, "season", season, "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if log == nil {
		log = []GameLogRow{}
	}
	// Sixty seconds, not the ten-second live cadence: nothing here is a running
	// clock. A live row's score can be up to a minute stale, which openapi.yaml
	// says out loud.
	cacheFor(writer, 60)
	writeJSON(writer, http.StatusOK, log)
}
```

In `backend/reader/server.go`, add three methods to `readerStore`:

```go
	Player(context.Context, string) (*PlayerProfile, error)
	PlayerSeason(context.Context, string, string, string) (*PlayerSeason, error)
	PlayerGameLog(context.Context, string, string, string, GameLogFilter) ([]GameLogRow, error)
```

and three routes inside the `/v1` subrouter:

```go
		router.Get("/competitions/{comp}/{season}/players/{playerId}", a.handlePlayerSeason)
		router.Get("/competitions/{comp}/{season}/players/{playerId}/game-log", a.handlePlayerGameLog)
		router.Get("/players/{playerId}", a.handlePlayer)
```

Now `backend/reader/openapi.yaml`. Add the parameter under `components.parameters`:

```yaml
    PlayerID:
      name: playerId
      in: path
      required: true
      description: Opaque upstream athlete identifier used only as a SQL parameter.
      schema: { type: string, pattern: "^[A-Za-z0-9._-]{1,64}$" }
```

Add the header under `components.headers`:

```yaml
    LongCacheControl:
      description: public, max-age=300. Player identity is near-static.
      schema: { type: string }
```

Widen the shared `NotFound` description, which now covers two entity kinds:

```yaml
    NotFound:
      description: Match not found, player not found, or the player has no record in this competition season
```

Add the three paths after `/v1/matches/{id}`:

```yaml
  /v1/players/{playerId}:
    get:
      operationId: getPlayer
      summary: Get a player's identity and career club history
      description: >-
        Competition-agnostic. A person is not scoped to a competition; their
        season stats are. age is computed from birthDate at request time and is
        null when the birth date is unknown. headshotUrl is null far more often
        than not and is never an empty string. career is the list of club stints
        we hold and is an empty array when we hold none.
      parameters:
        - { $ref: "#/components/parameters/PlayerID" }
      responses:
        "200":
          description: Player profile
          headers:
            Cache-Control: { $ref: "#/components/headers/LongCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PlayerProfile" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
  /v1/competitions/{comp}/{season}/players/{playerId}:
    get:
      operationId: getPlayerSeason
      summary: Get a player's season stat line in one competition
      description: >-
        Returns 404 when the player is unknown, and a different 404 when the
        player is known but we hold no row for this competition season. Neither
        case returns a stat object of zeros: a zero is a claim that the player
        appeared and did nothing. Individual stats are null when the provider did
        not measure them - a goalkeeper has no offsides, a striker has no saves.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/PlayerID" }
      responses:
        "200":
          description: Player season
          headers:
            Cache-Control: { $ref: "#/components/headers/StandardCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PlayerSeason" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
  /v1/competitions/{comp}/{season}/players/{playerId}/game-log:
    get:
      operationId: getPlayerGameLog
      summary: List every appearance a player made in a competition season
      description: >-
        Every match we hold, not a recent window. Absent limit means no limit; a
        season of appearances is bounded by the fixture list rather than by
        pagination. A row's result is null until the match is finished - a live
        1-0 is a score, not a win - and score is written from the player's team's
        perspective. A live row's score may be up to sixty seconds stale. A
        player we hold no rows for returns an empty array.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/PlayerID" }
        - { $ref: "#/components/parameters/Range" }
        - { $ref: "#/components/parameters/Order" }
        - { $ref: "#/components/parameters/Limit" }
      responses:
        "200":
          description: Appearances in kickoff order
          headers:
            Cache-Control: { $ref: "#/components/headers/StandardCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/GameLogRow" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

And the five schemas under `components.schemas`:

```yaml
    CareerStint:
      type: object
      additionalProperties: false
      required: [ordinal, teamId, teamName, teamCrestUrl, seasonsLabel, startYear, endYear]
      properties:
        ordinal: { type: integer, description: "Provider's own ordering of the career." }
        teamId: { type: [string, "null"], description: "Null for a club we hold no team row for." }
        teamName: { type: string }
        teamCrestUrl: { type: [string, "null"] }
        seasonsLabel: { type: string, description: "Verbatim provider span, e.g. 2025-CURRENT." }
        startYear: { type: [integer, "null"] }
        endYear: { type: [integer, "null"] }
    PlayerProfile:
      type: object
      additionalProperties: false
      required: [id, name, shortName, position, nationality, headshotUrl, birthDate, age, heightCm, weightKg, career]
      properties:
        id: { type: string }
        name: { type: string }
        shortName: { type: [string, "null"] }
        position: { type: [string, "null"] }
        nationality: { type: [string, "null"] }
        headshotUrl: { type: [string, "null"], description: "Null when absent; never an empty string." }
        birthDate: { type: [string, "null"], format: date }
        age: { type: [integer, "null"], description: "Computed at request time; null when birthDate is unknown." }
        heightCm: { type: [integer, "null"] }
        weightKg: { type: [integer, "null"] }
        career: { type: array, items: { $ref: "#/components/schemas/CareerStint" } }
    PlayerSeasonStats:
      type: object
      additionalProperties: false
      required: [appearances, subIns, starts, totalGoals, goalAssists, totalShots, shotsOnTarget, offsides, foulsCommitted, foulsSuffered, yellowCards, redCards, ownGoals, saves, shotsFaced, goalsConceded]
      properties:
        appearances: { type: [number, "null"] }
        subIns: { type: [number, "null"] }
        starts: { type: [number, "null"] }
        totalGoals: { type: [number, "null"] }
        goalAssists: { type: [number, "null"] }
        totalShots: { type: [number, "null"] }
        shotsOnTarget: { type: [number, "null"] }
        offsides: { type: [number, "null"] }
        foulsCommitted: { type: [number, "null"] }
        foulsSuffered: { type: [number, "null"] }
        yellowCards: { type: [number, "null"] }
        redCards: { type: [number, "null"] }
        ownGoals: { type: [number, "null"] }
        saves: { type: [number, "null"] }
        shotsFaced: { type: [number, "null"] }
        goalsConceded: { type: [number, "null"] }
    PlayerSeason:
      type: object
      additionalProperties: false
      required: [player, team, stats]
      properties:
        player: { $ref: "#/components/schemas/PlayerProfile" }
        team: { oneOf: [{ $ref: "#/components/schemas/Team" }, { type: "null" }] }
        stats: { $ref: "#/components/schemas/PlayerSeasonStats" }
    GameLogRow:
      type: object
      additionalProperties: false
      required: [matchId, kickoff, opponent, home, result, score, starter, stats]
      properties:
        matchId: { type: string, description: "The same id /v1/matches/{id} takes." }
        kickoff: { type: string, format: date-time }
        opponent: { $ref: "#/components/schemas/Team" }
        home: { type: boolean }
        result: { type: [string, "null"], enum: [W, D, L, null] }
        score: { type: [string, "null"], description: "From this player's team's perspective; null when unscored." }
        starter: { type: boolean }
        stats: { $ref: "#/components/schemas/PlayerMatchStats" }
```

Finally, `backend/reader/openapi_test.go`. Seed the fake in
`TestOpenAPIValidatesActualRouteResponses` so the responses are non-trivial:

```go
		player: &PlayerProfile{ID: "messi", Name: "Lionel Messi", Career: []CareerStint{
			{Ordinal: 1, TeamName: "Argentina", SeasonsLabel: "2005-CURRENT"},
		}},
		playerSeason: &PlayerSeason{
			Player: PlayerProfile{ID: "messi", Name: "Lionel Messi", Career: []CareerStint{}},
			Team:   &espn.Team{ID: "arg", Name: "Argentina", Abbr: "ARG"},
		},
		gameLog: []GameLogRow{{
			MatchID: "2", Kickoff: "2026-07-19T19:00:00Z",
			Opponent: espn.Team{ID: "fra", Name: "France", Abbr: "FRA"}, Home: true,
		}},
```

and add three rows to its table:

```go
		{target: "/v1/players/messi", template: "/v1/players/{playerId}"},
		{target: "/v1/competitions/world-cup/2026/players/messi", template: "/v1/competitions/{comp}/{season}/players/{playerId}"},
		{target: "/v1/competitions/world-cup/2026/players/messi/game-log", template: "/v1/competitions/{comp}/{season}/players/{playerId}/game-log"},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestPlayer|TestGameLog|TestAbsentPlayer|TestOpenAPI|TestDependencyErrors"
```

Expected: `ok`. If `TestOpenAPIObjectSchemasAreExact` fails, a schema's `required`
list does not name every property — that test exists because a response field
missing from `required` is a field a client is entitled to treat as optional.
If `TestOpenAPIDocumentsOperationalResponses` fails, a response you added is
missing its `Cache-Control` header entry.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_players.go backend/reader/server.go backend/reader/server_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): serve player profiles, season stats and game logs

Three routes. The profile is competition-agnostic and cached for five
minutes; the season stat line and the game log are competition-scoped and
cached for sixty seconds. Every player id is validated before any query,
and an absent value serializes as null - never \"\", never 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Document the surface, run the full gate, open the PR

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document the routes**

In `backend/reader/README.md`, under the "Query parameters" section the
`api-match-reads` plan added, append:

```markdown
## Players

| Route | Cache | Notes |
|---|---|---|
| `/v1/players/{playerId}` | `public, max-age=300` | Competition-agnostic identity and career club history |
| `/v1/competitions/{comp}/{season}/players/{playerId}` | `public, max-age=60` | Season stat line for one competition |
| `/v1/competitions/{comp}/{season}/players/{playerId}/game-log` | `public, max-age=60` | Every appearance; `range`, `order`, `limit` |

A person is not scoped to a competition; their season stats are. The profile
therefore carries no stat, and the season endpoint carries the club.

`age` is computed from `birth_date` at request time and is `null` when the birth
date is unknown — never `0`. `headshotUrl` is `null` when we hold no headshot —
never `""`. Both are common: the athlete this design was verified against has no
headshot at all.

Two distinct 404s on the season endpoint: **`player not found`** (we have never
heard of the id) and **`player has no record in this competition season`** (we
know them and hold nothing here). Neither returns a stat object of zeros — a zero
in `totalGoals` claims the player appeared and did not score, and we do not hold
that claim. An empty `career` array is different and is returned freely: an empty
collection says "no stints recorded", which is true, while a fabricated zero says
a measurement was taken.

The game log returns **every match we hold**, not a recent window. ESPN's
`/athletes/{id}/overview` serves five; ours serves the season, because the
ingester writes `match_player_stat` for every match. `?limit=` defaults to no
limit and caps at 500 — a guard against an absurd request, not a paging mechanism,
since a season cannot hold more than roughly sixty appearances.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. **Docker must be running**
for `reader`, `migrations`' round-trip coverage and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/players/not%20an%20id"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/players/definitely-not-a-player"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/liga-mx/2026-27/players/297287/game-log?range=20260101-20261231"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/liga-mx/2026-27/players/297287/game-log?order=DESC"
curl -si "http://localhost:8080/v1/players/297287" | head -n 8
curl -s  "http://localhost:8080/v1/players/297287" | python3 -m json.tool | head -n 20
curl -s  "http://localhost:8080/v1/competitions/liga-mx/2026-27/players/297287" | head -c 500
curl -s  "http://localhost:8080/v1/competitions/liga-mx/2026-27/players/297287/game-log?order=desc&limit=10" | python3 -m json.tool | head -n 30
```

Expected: `400`, `404`, `400` (a 364-day range), `400` (uppercase order), then a
`200` carrying `Cache-Control: public, max-age=300`, then a profile whose
`headshotUrl` is `null` and whose `age` is a number, then a season object with a
`team` and a `stats` block, then a game log array whose rows carry `matchId`,
`opponent`, `home`, `result` and `score`. **Count the rows** — if the log returns
exactly five, the ingester is writing `match_player_stat` only for recent matches
and the whole point of this endpoint has been lost upstream.

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document the player routes and their two 404s

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-players
gh pr create --title "feat(reader): player profiles, season stats and full-season game logs" --body "$(cat <<'EOF'
## What

Three reader endpoints for people:

- `GET /v1/players/{playerId}` — competition-agnostic identity plus career club history.
- `GET /v1/competitions/{comp}/{season}/players/{playerId}` — profile, club, season stat line.
- `GET /v1/competitions/{comp}/{season}/players/{playerId}/game-log?range=&order=&limit=` — **every appearance we hold**.

Plus migration `0007_players`: `player`, `player_season_stat`, `player_career_stint`.

## Why the game log is the point

E5's player page ships today against ESPN directly and carries a stated ceiling:
its game log is **five matches**, because `/athletes/{id}/overview` serves five
and the page refuses to let five rows read as a season. This endpoint is what
removes that sentence. The ingester writes `match_player_stat` for every match, so
we can serve the season, windowed by date and ordered either way. That difference
is the concrete payoff of owning the data rather than proxying it.

`/athletes/{id}/gamelog` (500), `/splits` (404) and `/stats` (404) are dead
upstream, verified 2026-08-15. Nothing here calls them and there is no fallback
chain.

## Approach

- **A person is not scoped to a competition; their season stats are.** Hence a
  competition-agnostic profile and a competition-scoped stat line, rather than one
  endpoint that pretends identity belongs to a league.
- **Age is computed, never stored.** A stored age is wrong the morning after it is
  written. It is derived from `birth_date` month-then-day so it is never a year
  out across a leap boundary, and it is `null` — not `0` — when the birth date is
  unknown.
- **Two distinct 404s, and no zero-filled stat object.** "Unknown player" and
  "known player, no row this competition season" are different facts. Neither is
  answered with `{"totalGoals": 0}`, which would claim the player appeared and did
  nothing. An empty `career` array *is* returned freely — the distinction is
  between an absent collection, which is honest, and a fabricated measurement,
  which is not.
- **The opponent comes from the match's own team ids**, never from row order, and
  a stat row whose team is on neither side of its fixture is excluded rather than
  rendered as a player facing himself.
- **A live match has a score and no result.** 1-0 at 20' is not a win.
- `?range=`, `?order=` and `?limit=` reuse `params.go` verbatim. `limit` caps at
  500 as a guard, not a page size: a season cannot hold 500 appearances.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- Pure unit tests for the two derivations, including leap-day birthdays and the
  live-match case.
- Testcontainers integration tests: the computed age, a null birth date, a null
  headshot, an empty career, a stat line with no club, both not-found signals,
  opponent resolution from both sides, the half-open date window, `desc`+`limit`,
  and the excluded phantom row.
- Handler tests assert that every invalid id and parameter returns 400 **and never
  reaches the store**, and that absent values serialize as `null` rather than `""`
  or `0`.
- `TestMigrationsRoundTrip` proves `0007` rolls back to zero tables and zero roles.
- OpenAPI contract tests validate all three new paths and five new schemas.

Plan: `docs/superpowers/plans/2026-08-15-api-players.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** E5's identity block, season totals and career timeline →
  Tasks 3 and 5. E5's "headshots are not guaranteed; lay out for their absence" →
  `headshotUrl` is `*string`, asserted `null` in `TestAbsentPlayerFieldsSerializeAsNull`
  and seeded null in the integration data. E5's "`/gamelog`, `/splits`, `/stats`
  are dead — no fallback chain" → repeated in *Ingester prerequisites* and nothing
  in this plan calls them. E5's declared ceiling → the game-log endpoint is what
  lifts it, and the PR says so.
- **E7 boundary.** This plan delivers the game-log half of **T7.4** and explicitly
  not the percentile half. A percentile needs a population and a history; computing
  one from a single player's row would be a number with no denominator. It belongs
  to the `api-history` plan.
- **Two name collisions with the frontend, both deliberate.** E5's TypeScript also
  declares `PlayerProfile`, `GameLogRow` and `CareerStint`, with different fields —
  those mirror ESPN's `/overview` payload shape (`eventId`, `appearance`,
  `Record<string, number|null>`), while these mirror our own store (`matchId`,
  `starter`, a typed stat struct). They are not meant to be byte-identical, because
  they describe different sources. When the frontend switches its player page to
  this API, it adapts at the store seam, exactly as it does for matches.
- **Three queries for the season endpoint** (profile, career, season row), all
  primary-key or index lookups, all on the one rate-limit token the request paid.
  The profile read runs first so an unknown id costs one lookup and stops. If the
  season endpoint ever becomes hot enough to matter, the career read is the one to
  drop from it — a stat line does not need a career — but splitting it now would be
  optimising a query nobody has measured.
- **The index this endpoint needs is already the sibling's.** `match_player_stat`
  is keyed `(match_id, player_id)`, which only helps the box score's direction of
  travel; the game log reads by player across matches. The
  `api-leaders-and-box-scores` plan creates `match_player_stat_player_idx` for
  exactly this reason and says so in a comment, so `0007` adds no index. Verify it
  exists before shipping — without it every game log sequential-scans the largest
  table in the schema, which will not show up in any test and will show up in
  production.
- **`PlayerSeasonStats` is deliberately not `PlayerMatchStats`,** even though the
  sibling's type currently lists the same sixteen stats. They describe different
  subjects, and a type named `PlayerMatchStats` holding a season total is a name
  that mispredicts its contents. They have already diverged in fact: the sibling's
  carries a recomputed `shotAccuracy` that only makes sense per match, and a
  season line is where E7's per-90 rates will land. Reusing one struct now would
  buy sixteen saved lines and then have to be undone.
- **Deliberately not built:** a `?state=` filter on the game log (it would select
  the at most one match a player is currently playing), a cross-competition game
  log (a season stat line belongs to a competition, and merging them silently
  would mix Liga MX minutes into a World Cup total), and pagination (a season of
  appearances is roughly sixty rows; `limit` is a guard, and a `Link` header for
  sixty rows would be ceremony).
- **Interface churn.** `readerStore` gains three methods, so `server.go`,
  `store_players.go` and `server_test.go` change together. The sibling `api-*`
  plans each add methods to the same interface — land them one at a time, not in
  parallel on the same file.
- **Migration numbering is the one thing that cannot be resolved by reading this
  file.** Run `ls backend/migrations` first. If `0007` is taken, renumber and keep
  the `_players` suffix, and update both hardcoded file lists plus
  `migrations_test.go` in the same commit.
