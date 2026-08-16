# Ingester — Squads, Season Stats and Athlete Career History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Know who is in every squad, what each of them has done across the season, and
which clubs they have played for — so a player page has a shirt number, a nationality and a
career, and a per-position percentile has a population to compute against.

**Architecture:** Two endpoints, at two very different cadences.
`/teams/{id}/roster` returns **all 35 players with their season statistics inline**, so a
whole squad costs **one** request — that is ~180 requests to cover nine competitions, daily.
`/athletes/{id}/bio` is **per player** and is therefore budgeted, TTL'd and bounded: it is
fetched only for players who have actually appeared, a fixed number per cycle, refreshed
monthly.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-team-pages-design.md` (E4) and
`docs/superpowers/specs/2026-08-15-player-pages-design.md` (E5) — the TypeScript halves of
the same two payloads
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Tasks: T7.9** (squad + season stats) and
**T7.10** (athlete profile + career history) — both new; add under E7
**Branch:** `feat/ingester-squad-and-athletes`

---

## Verified payload facts these tasks are built on

All checked against the live API on 2026-08-15, `mex.1` team `227` and athlete `297287`.

**`/teams/{id}/roster`** (site host, `…/soccer/mex.1/teams/227/roster`):

- `athletes[]` — **35** entries; **27** of them carry `statistics`. The other 8 have not
  played, and their absence is a fact, not an error.
- Each athlete carries `id`, `displayName`, `fullName`, `jersey`, `position.abbreviation`,
  `age`, **`dateOfBirth`** (`"2001-06-17T07:00Z"` — real ISO), `citizenship`
  (`"Mexico"`), `citizenshipCountry`.
- `statistics.splits.categories[]` — `general[7]`, `offensive[5]`, `goalKeeping[3]`.
  **Unlike the match summary, every position carries all fifteen names**, including
  goalkeeping stats for outfielders (zeroed) and offensive stats for keepers. Verified
  across G, D, M and F.
- `season` — `{"year":2026,"displayName":"2026-27 Liga BBVA MX","name":"Torneo Apertura"}`.
- `injuries` — present on every athlete and **empty on all 35**. The field existing is not
  the data existing. **No injuries feature is built on it, here or anywhere.**

**`/athletes/{id}/bio`** (a *different* host: `site.web.api.espn.com/apis/common/v3/…`):

```json
{"teamHistory": [{"id":"222","slug":"mex.queretaro","displayName":"Querétaro",
                  "logo":"…","seasons":"2025-CURRENT","links":[…]}]}
```

**`/athletes/{id}`** (same host) carries `athlete.{displayName, fullName, jersey, position,
team, age, citizenship, citizenshipCountry, statsSummary}` — but its date of birth is
`displayDOB: "23/9/2003"`, a **locale-formatted D/M/YYYY string**. The roster's ISO
`dateOfBirth` is strictly better, and is therefore where demographics come from. Do not
parse `displayDOB`; a `3/9` is unresolvable between March and September without knowing the
locale, and getting it wrong silently produces a wrong age.

---

## Two deliberate non-goals

**`/athletes/{id}/overview`'s game log is not ingested.** It returns the last five matches
per athlete. T7.7 already writes a per-match `appearance` row with a full box score for
**every** match the ingester sees, which is a complete season game log obtained for free.
Fetching `/overview` per athlete would be ~6,000 requests to duplicate a subset of data we
already hold. E5 uses it on the frontend for a player page that renders before the backend
cutover; the ingester does not need it.

**Injuries are not ingested.** Empty for all 35 athletes on the endpoint that carries the
field. There is nothing to store.

---

## ⚠️ Merge order and migration numbering

Adds **`0011_squad_and_season_stats`** and **`0012_player_bio`**. Prerequisites, in order:
`feat/canonical-identity-impl` → `feat/player-identity` → T7.1 (`0004`) → T7.6 (`0005`) →
T7.7 (`0006`) → T7.12 (`0007`) → T7.14/T7.15 (`0008`, `0009`) → T7.8 (`0010`).

**`feat/player-identity` is a hard prerequisite**: this plan resolves squad members through
`Store.Player` and the `player`/`player_external_ref` pair it introduces.

```bash
ls backend/migrations/
```

Expected: `0001` … `0010_leader_category.*`.

> **Execution note (2026-08-16):** latest `origin/main` had consolidated the prerequisite
> schema into `0001_init`, `0002_snapshots`, and `0003_player_capture`; the projected
> intermediate migration filenames were never published. The required canonical UUID player
> crosswalk, UUID matches, appearances, standings, and `Store.Player` were present. Exact and
> repo-wide searches plus the migration-directory listing confirmed that `0011` and `0012`
> were free, so the coordinator's explicit reservation of those numbers was used without
> renumbering.

> **Numbering and `match.id` type both assume the post-merge tree.** On `main`,
> `0003_ingester_delete_grant` / `0004_ingester_hardening` still exist and `match.id` is
> still `text`; `feat/canonical-identity-impl` deletes those two and re-keys `match.id` to
> `uuid`. `ls backend/migrations` at execution time is the only trustworthy source — if
> the numbers have shifted, take the next free one and shift the remaining sequence by the
> same offset, then update the shared registry in
> `2026-08-15-ingester-standings-snapshots.md`, which the other seven plans read.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, confirmed failing for the stated reason.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN`, `INGESTER_LEASE_DSN`. Secrets via `fly secrets`.
- **Request budget is a first-class constraint here**, not an afterthought. ESPN's API is
  keyless and unmetered by courtesy, not by contract. Any loop that is per-athlete must be
  bounded per cycle and TTL'd, and the bound must be a named constant with the arithmetic in
  its comment.
- A stat the provider omits is `NULL`, never `0` — the same rule as T7.7.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/migrations/0011_squad_and_season_stats.{up,down}.sql`
- `backend/migrations/0012_player_bio.{up,down}.sql`
- `backend/migrations/migrations_test.go`
- `backend/shared/espn/{client,roster,bio}.go` and their tests
- `backend/shared/espn/testdata/espn-team-roster.json`, `espn-athlete-bio.json`
- `backend/shared/model/squad.go`
- `backend/shared/source/{source,espn}.go`
- `backend/shared/store/{squad,bio}.go` + integration tests
- `backend/ingester/{contracts,runner,squad,runner_test}.go`
- `docs/backend/ARCHITECTURE.md`

---

### Task 1: Record both fixtures and read what is really in them

- [x] **Step 1: Record**

```bash
cd backend
curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227/roster" \
  -o shared/espn/testdata/espn-team-roster.json
curl -s "https://site.web.api.espn.com/apis/common/v3/sports/soccer/mex.1/athletes/297287/bio" \
  -o shared/espn/testdata/espn-athlete-bio.json
```

Note the two different hosts. The roster is on `site.api.espn.com`; the bio is on
`site.web.api.espn.com/apis/common/v3`. Requesting the bio from the site host returns
`{"code":404}` — verified, and it is a silent-looking 404 rather than an error, so a
misdirected URL presents as "this player has no history".

- [x] **Step 2: Verify**

```bash
cd backend && node -e "
const r = require('./shared/espn/testdata/espn-team-roster.json');
console.log('athletes:', r.athletes.length, '| with statistics:', r.athletes.filter(a=>a.statistics).length);
console.log('season:', JSON.stringify(r.season));
const a = r.athletes.find(x=>x.statistics);
console.log('sample:', a.id, a.displayName, '| jersey', a.jersey, '| pos', a.position.abbreviation,
            '| dob', a.dateOfBirth, '| citizenship', a.citizenship);
console.log('categories:', a.statistics.splits.categories.map(c=>c.name+'['+c.stats.length+']').join(','));
const names = a.statistics.splits.categories.flatMap(c=>c.stats.map(s=>s.name));
console.log('stat names (' + names.length + '):', names.sort().join(', '));
console.log('injuries populated anywhere:', r.athletes.some(x => (x.injuries||[]).length > 0));

const b = require('./shared/espn/testdata/espn-athlete-bio.json');
console.log('bio keys:', Object.keys(b).join(','));
console.log('teamHistory:', b.teamHistory.map(t => t.id + '=' + t.displayName + ' (' + t.seasons + ')').join(' | '));
"
```

Expected:

```
athletes: 35 | with statistics: 27
season: {"year":2026,"displayName":"2026-27 Liga BBVA MX","type":14277,"name":"Torneo Apertura"}
sample: 49306 Fernando Tapia | jersey 21 | pos G | dob 2001-06-17T07:00Z | citizenship Mexico
categories: general[7],offensive[5],goalKeeping[3]
stat names (15): appearances, foulsCommitted, foulsSuffered, goalAssists, goalsConceded,
                 offsides, ownGoals, redCards, saves, shotsFaced, shotsOnTarget, subIns,
                 totalGoals, totalShots, yellowCards
injuries populated anywhere: false
bio keys: teamHistory
teamHistory: 222=Querétaro (2025-CURRENT)
```

> **Recorded-payload note (2026-08-16):** ESPN enriched athlete `297287` after this plan was
> written. The committed fixture now has four ordered history entries: Querétaro, Pumas UNAM,
> Monterrey, and Mexico U17. The endpoint shape and mapping contract are unchanged.

Two readings. **`with statistics: 27` of 35** — eight squad members have not played, and a
mapper that assumes `statistics` is present will nil-panic on the ninth. **`injuries
populated anywhere: false`** — the field is there and the data is not; this is the same
trap the E4 team-pages plan calls out, and it is checked here for the same reason.

- [x] **Step 3: Commit**

```bash
git add backend/shared/espn/testdata/espn-team-roster.json \
        backend/shared/espn/testdata/espn-athlete-bio.json
git commit -m "test: record team roster and athlete bio fixtures

Liga MX Querétaro 227 and athlete 297287, from two different ESPN hosts --
the bio lives on site.web.api.espn.com/apis/common/v3 and returns a bare
{\"code\":404} from the site host, which reads as 'no history' rather than
as an error.

35 roster athletes, 27 with statistics, injuries empty on all of them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `squad_membership` and `player_season_stat` — T7.9

**Files:**
- Create: `backend/migrations/0011_squad_and_season_stats.{up,down}.sql`
- Test: `backend/migrations/migrations_test.go`

- [x] **Step 1: Write the failing migration test**

```go
// Squad membership is per season, not per player: a player belongs to a club
// in a season, and a transfer is a second row rather than an overwrite -- the
// same reason `appearance` records the team per match instead of on `player`.
func TestSquadAndSeasonStatsAreSeasonScoped(t *testing.T) {
	sql := readMigration(t, "0011_squad_and_season_stats.up.sql")
	for _, required := range []string{
		"CREATE TABLE squad_membership",
		"PRIMARY KEY (competition_id, season_id, team_id, player_id)",
		"CREATE TABLE player_season_stat",
		"PRIMARY KEY (competition_id, season_id, player_id)",
		"ALTER TABLE player",
		"GRANT SELECT, INSERT, UPDATE ON squad_membership, player_season_stat TO scorearc_ingester",
		"GRANT DELETE ON squad_membership TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0011_squad_and_season_stats.up.sql missing %q", required)
		}
	}
	// Eight of 35 roster athletes had no statistics block at all. NOT NULL
	// would force a zero onto a player who has not played.
	if strings.Contains(sql, "appearances int NOT NULL") {
		t.Fatal("season stat columns must be nullable")
	}
}
```

- [x] **Step 2: Run, watch it fail, then write the migration**

```bash
cd backend && go test ./migrations/ -run SquadAndSeasonStats
```

Expected: FAIL — file missing.

Create `backend/migrations/0011_squad_and_season_stats.up.sql`:

```sql
-- Who is in a squad, and what they have done this season.
--
-- Source: /teams/{id}/roster on the site host, which returns ALL 35 players
-- WITH their season statistics inline. A whole squad table is one request, not
-- 35 -- which is what makes covering nine competitions daily affordable at
-- ~180 requests.

-- Membership is keyed on the SEASON, not on the player, for the same reason
-- appearance records team per match: a transfer is then a second row rather
-- than an overwrite, and last season's squad stays true.
CREATE TABLE squad_membership (
  competition_id text NOT NULL,
  season_id      text NOT NULL,
  team_id        text NOT NULL REFERENCES team(id),
  player_id      uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  shirt_number   int,
  position       text,
  source         text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season_id, team_id, player_id),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);
CREATE INDEX squad_membership_player_idx ON squad_membership (player_id);

-- The provider's own season aggregate.
--
-- This is deliberately NOT derived from summing `appearance` rows, and the two
-- will sometimes disagree. Ours covers only matches the ingester has seen;
-- ESPN's covers the whole season including whatever it saw before we existed,
-- and includes competitions we do not ingest. Keeping the provider's number
-- alongside our own is what makes the disagreement visible instead of silently
-- picking a side.
--
-- Keyed WITHOUT team_id on purpose: a player transferred mid-season has one
-- season total, and the provider reports it against their current club.
-- team_id is carried as a column so the current club is recoverable.
--
-- EVERY STAT COLUMN IS NULLABLE. Eight of 35 athletes on the recorded fixture
-- carry no statistics block at all -- they have not played -- and a NOT NULL
-- DEFAULT 0 would record "played zero matches and took zero shots" as a
-- measurement about a player nobody has measured.
CREATE TABLE player_season_stat (
  competition_id  text NOT NULL,
  season_id       text NOT NULL,
  player_id       uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  team_id         text REFERENCES team(id),
  appearances     int,
  sub_ins         int,
  goals           int,
  assists         int,
  shots           int,
  shots_on_target int,
  offsides        int,
  fouls_committed int,
  fouls_suffered  int,
  own_goals       int,
  yellow_cards    int,
  red_cards       int,
  saves           int,
  goals_conceded  int,
  shots_faced     int,
  source          text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season_id, player_id),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);
CREATE INDEX player_season_stat_team_idx ON player_season_stat (competition_id, season_id, team_id);

-- Demographics from the roster payload, which carries a real ISO dateOfBirth.
-- The per-athlete endpoint offers only displayDOB ("23/9/2003"), a
-- locale-formatted string whose day and month cannot be told apart below 13,
-- so it is never parsed.
ALTER TABLE player
  ADD COLUMN IF NOT EXISTS birth_date  date,
  ADD COLUMN IF NOT EXISTS nationality text;

GRANT SELECT ON squad_membership, player_season_stat TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON squad_membership, player_season_stat TO scorearc_ingester;
-- A player who leaves a club must leave its squad list, or the phantom
-- outlives the transfer. Narrow on purpose: squad_membership only.
-- player_season_stat gets no DELETE -- a season total for a departed player is
-- still true.
GRANT DELETE ON squad_membership TO scorearc_ingester;
```

`0011_squad_and_season_stats.down.sql`:

```sql
DROP TABLE IF EXISTS player_season_stat;
DROP TABLE IF EXISTS squad_membership;
-- birth_date and nationality are left in place. They are additive columns on
-- an existing table, they are cheap, and dropping them would discard
-- demographics for every player already resolved.
```

- [x] **Step 3: Run and prove it applies**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`.

- [x] **Step 4: Commit**

```bash
git add backend/migrations/0011_squad_and_season_stats.*.sql backend/migrations/migrations_test.go
git commit -m "feat: add squad membership and season stat tables

Keyed on the season, not on the player, so a transfer is a second row
rather than an overwrite -- the same reason appearance records team per
match.

player_season_stat keeps the PROVIDER's aggregate rather than deriving one
by summing appearances. The two will disagree: ours covers only matches we
have seen, ESPN's covers the whole season and competitions we do not
ingest. Keeping both makes the disagreement visible instead of silently
picking a side.

Every stat column nullable: 8 of 35 roster athletes carry no statistics
block at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Map and write the roster

**Files:**
- `backend/shared/espn/client.go` (URL builder), `backend/shared/espn/roster.go`,
  `roster_test.go`, `backend/shared/model/squad.go`,
  `backend/shared/source/{source,espn}.go`, `backend/shared/store/squad.go` + test.

**Interfaces:**
- `func TeamRosterURL(slug, teamID string) string`
- `func MapRoster(raw []byte) (model.Squad, error)` — `model.Squad` is
  `{TeamSourceID string; Players []model.SquadMember}`, each member carrying `SourceID`,
  `FullName`, `Number *int`, `Position`, `BirthDate *time.Time`, `Nationality string`,
  `Stats *model.PlayerSeasonStats`.
- `func (s *Store) ReplaceSquad(ctx, competitionID, seasonID, teamID, source string, members []model.SquadMember, playerIDs map[string]uuid.UUID) error`

- [x] **Step 1: Write the failing tests**

Create `backend/shared/espn/roster_test.go` with, at minimum:

```go
func TestTeamRosterURL(t *testing.T) {
	want := "https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/teams/227/roster"
	if got := TeamRosterURL("mex.1", "227"); got != want {
		t.Fatalf("TeamRosterURL = %s, want %s", got, want)
	}
	if got := TeamRosterURL("mex.1", "../secret"); strings.Contains(got, "../") {
		t.Fatalf("TeamRosterURL = %q, want the team id encoded", got)
	}
}

// 35 athletes, 27 with statistics. A mapper that assumes the block is present
// nil-panics on the 28th.
func TestMapRosterKeepsPlayersWhoHaveNotPlayed(t *testing.T) {
	squad, err := MapRoster(loadFixture(t, "espn-team-roster.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(squad.Players) != 35 {
		t.Fatalf("players = %d, want 35", len(squad.Players))
	}
	var withStats int
	for _, p := range squad.Players {
		if p.Stats != nil {
			withStats++
		}
	}
	if withStats != 27 {
		t.Fatalf("players with stats = %d, want 27", withStats)
	}
	// The eight without are still squad members. Dropping them would make a
	// squad list silently shorter than the squad.
	if len(squad.Players)-withStats != 8 {
		t.Fatalf("players without stats = %d, want 8", len(squad.Players)-withStats)
	}
}

// Stats are read by name across all three categories, never by index. Unlike
// the match summary, this payload gives every position all fifteen names --
// but the order within a category is still ESPN's.
func TestMapRosterReadsStatsAcrossCategoriesByName(t *testing.T) {
	squad, err := MapRoster(loadFixture(t, "espn-team-roster.json"))
	if err != nil {
		t.Fatal(err)
	}
	var keeper *model.SquadMember
	for i := range squad.Players {
		if squad.Players[i].Position == "G" && squad.Players[i].Stats != nil {
			keeper = &squad.Players[i]
			break
		}
	}
	if keeper == nil {
		t.Fatal("the fixture has a goalkeeper with statistics")
	}
	// general, offensive and goalKeeping all have to be walked: a mapper that
	// reads only categories[0] gets seven of fifteen.
	if keeper.Stats.Appearances == nil {
		t.Fatal("Appearances (general) is nil")
	}
	if keeper.Stats.Goals == nil {
		t.Fatal("Goals (offensive) is nil -- only the general category was read")
	}
	if keeper.Stats.Saves == nil {
		t.Fatal("Saves (goalKeeping) is nil -- only two categories were read")
	}
}

// The roster carries a real ISO dateOfBirth. The per-athlete endpoint's
// displayDOB ("23/9/2003") is locale-formatted and is never parsed.
func TestMapRosterReadsIsoBirthDate(t *testing.T) {
	squad, err := MapRoster(loadFixture(t, "espn-team-roster.json"))
	if err != nil {
		t.Fatal(err)
	}
	var dated int
	for _, p := range squad.Players {
		if p.BirthDate != nil {
			dated++
		}
	}
	if dated == 0 {
		t.Fatal("no birth dates parsed; the fixture carries dateOfBirth on every athlete")
	}
}
```

Store test, in `backend/shared/store/squad_integration_test.go`:

```go
// A player who leaves must leave the squad list. Without the tail delete the
// phantom outlives the transfer, and a squad page shows 36 players.
func TestReplaceSquadDropsADepartedPlayer(t *testing.T) { /* … */ }

// …but their season total stays. It is still true.
func TestReplaceSquadKeepsADepartedPlayersSeasonStat(t *testing.T) { /* … */ }

// A player with no statistics block writes membership and NO season-stat row,
// rather than a row of zeros.
func TestReplaceSquadWritesNoStatRowForAnUnplayedPlayer(t *testing.T) { /* … */ }

// Production writes as scorearc_ingester, including the tail DELETE that the
// narrow squad_membership grant exists for.
func TestReplaceSquadAsTheIngesterRole(t *testing.T) { /* … */ }
```

Write these in the style of `participation_integration_test.go`, reusing
`newIntegrationStore`, `mustSeedTwoTeams`, `mustSeedSeason` and the
`strings.Replace` DSN trick.

- [x] **Step 2: Run, watch them fail, then implement**

```bash
cd backend && go test ./shared/espn/ ./shared/store/ -run "Roster|ReplaceSquad"
```

Expected: FAIL to compile — `undefined: MapRoster`, `store.ReplaceSquad undefined`.

Implement:

- `TeamRosterURL(slug, teamID)` in `client.go`, beside the existing builders, using
  `url.PathEscape` on both segments.
- `MapRoster` walking `athletes[] → statistics.splits.categories[] → stats[]` and building a
  `map[string]*int` **by name across all three categories**, then filling
  `model.PlayerSeasonStats` from it. The name→field mapping is identical to T7.7's
  `PlayerMatchStats` plus `appearances` and `subIns`, which are meaningful here (a season
  total is not always 1) even though they are dropped per match.
- `Source.Roster(ctx, comp, teamSourceID)` returning `model.Squad`.
- `Store.ReplaceSquad` doing: resolve each member via `Store.Player` (which mints — correct
  here, because the roster gives a name), upsert `squad_membership`, **delete the tail**
  (`WHERE competition_id=$1 AND season_id=$2 AND team_id=$3 AND NOT (player_id = ANY($4))`),
  upsert `player_season_stat` **only for members with a non-nil `Stats`**, and fill
  `player.birth_date` / `player.nationality` with `COALESCE` so a later payload without them
  cannot blank an earlier one.

- [x] **Step 3: Run**

```bash
cd backend && go test -race ./shared/espn/ ./shared/store/ -run "Roster|ReplaceSquad" -v
```

Expected: every case `--- PASS`.

- [x] **Step 4: Commit**

```bash
git add backend/shared/espn/client.go backend/shared/espn/roster.go \
        backend/shared/espn/roster_test.go backend/shared/model/squad.go \
        backend/shared/source/source.go backend/shared/source/espn.go \
        backend/shared/store/squad.go backend/shared/store/squad_integration_test.go
git commit -m "feat: map and store team rosters with inline season stats

One request per team returns all 35 players WITH their season statistics,
so a whole squad table costs one call rather than 35.

Stats are read by name across all three categories -- general, offensive
and goalKeeping. A mapper that reads categories[0] gets seven of fifteen.

The eight players with no statistics block keep their squad membership and
get no season-stat row, rather than a row of zeros about someone nobody
has measured.

Birth dates come from this payload's ISO dateOfBirth, never from the
per-athlete endpoint's displayDOB, which is locale-formatted D/M/YYYY and
ambiguous below the 13th.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Refresh squads on a daily cadence

**Files:**
- Create: `backend/ingester/squad.go`
- Modify: `backend/ingester/{contracts,runner,main,runner_test}.go`

**The request arithmetic, which is the design.** Nine competitions × ~20 clubs = ~180
requests for a complete refresh. At once a day that is negligible; on every slow tick it
would be ~52,000 requests a day. The cadence is therefore **daily**, gated exactly like
T7.1's standings snapshot: an in-process `map[string]time.Time` of the UTC day already
refreshed, keyed `comp/season`, re-earned after a restart.

Which teams? The ones in `standing` for that competition and season, which the ingester
already writes and which is the definitive list of who is in the competition.

- [x] **Step 1: Write the failing tests**

```go
// ~180 requests once a day is negligible; on every slow tick it is ~52,000.
func TestSquadRefreshRunsOncePerDay(t *testing.T) {
	repo := &fakeRepository{}
	worker := newTestRunner(repo)
	worker.runCycle(context.Background(), true)
	worker.runCycle(context.Background(), true)

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.squadCalls != len(repo.standingTeamIDs) {
		t.Fatalf("squad refreshes = %d across two slow ticks, want one per team (%d)",
			repo.squadCalls, len(repo.standingTeamIDs))
	}
}

// One club's roster failing must not stop the other nineteen.
func TestSquadRefreshContinuesPastOneFailure(t *testing.T) { /* … */ }

// A fast tick must never trigger it. The fast interval is 20s.
func TestSquadRefreshSkipsFastTicks(t *testing.T) {
	repo := &fakeRepository{}
	newTestRunner(repo).runCycle(context.Background(), false)
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.squadCalls != 0 {
		t.Fatalf("squad refreshes = %d on a fast tick, want 0", repo.squadCalls)
	}
}
```

- [x] **Step 2: Implement**

Create `backend/ingester/squad.go` with `refreshSquads(ctx, comp, season, teamIDs map[string]string) error`,
following `snapshotStandings`'s shape from T7.1: check the in-process day gate, iterate the
teams from the standings refresh (which already has provider→canonical ids in hand), call
`r.source.Roster` then `r.repo.ReplaceSquad` per team, join the errors, record one
`ingest_run` of kind `squads`, and set the day only on overall success.

Bound the concurrency the way `mirrorTopScorers` already does — a `chan struct{}` semaphore
of 5 — so twenty roster fetches do not go out at once.

Call it from `refreshStandings` after the snapshot, on `slowTick` only, and add
`squadsRefreshed map[string]time.Time` to the `runner` struct **and to `main.go`'s literal**
(the same nil-map trap T7.1 flags).

- [x] **Step 3: Run**

```bash
cd backend && go test -race ./ingester/ -v -run Squad
cd backend && go test -race ./...
```

Expected: the three cases pass, then every package `ok`.

- [x] **Step 4: Commit**

```bash
git add backend/ingester/squad.go backend/ingester/contracts.go \
        backend/ingester/runner.go backend/ingester/main.go backend/ingester/runner_test.go
git commit -m "feat: refresh squads once per UTC day

Nine competitions times ~20 clubs is ~180 requests for a complete refresh.
Once a day that is negligible; on every slow tick it is ~52,000.

The team list comes from `standing`, which the ingester already writes and
which is the definitive list of who is in the competition. Concurrency is
bounded at 5, matching the existing crest mirror.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Career history, on a budget — T7.10

**Files:**
- Create: `backend/migrations/0012_player_bio.{up,down}.sql`,
  `backend/shared/espn/bio.go` + test, `backend/shared/store/bio.go` + test,
  `backend/ingester/bio.go`

**The budget, stated before the code.** `/bio` is **one request per player**. Nine
competitions × 20 clubs × 35 players ≈ **6,300 players**. Fetching all of them in one cycle
would be a denial-of-service against a keyless public API we do not pay for. So:

- **Only players who have appeared.** A squad member who has never been on a team sheet has
  no page anyone will visit. `appearance` is the filter.
- **A hard per-cycle bound**, `bioBatchSize = 20`, on slow ticks only. At one slow tick every
  five minutes that is 5,760 fetches a day — the whole population inside 30 hours, then
  nothing.
- **A 30-day TTL.** A career history changes on a transfer, which is measured in months.
  `player.bio_fetched_at` drives it, so the work is self-limiting and survives restarts
  because the state is in the database rather than in the process.

- [x] **Step 1: Migration**

`0012_player_bio.up.sql`:

```sql
-- A player's club history.
--
-- Source: /athletes/{id}/bio on site.web.api.espn.com/apis/common/v3 -- a
-- DIFFERENT host from the roster. The site host returns a bare {"code":404}
-- for this path, which reads as "this player has no history" rather than as a
-- misconfiguration.
CREATE TABLE player_team_history (
  player_id      uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  -- The provider's team id, NOT a canonical team_id. A career includes clubs
  -- in competitions we do not ingest and will never curate, so a FK to team()
  -- would force us to mint a provisional row for every club a player has ever
  -- been at. The name is carried alongside so the row renders without a join.
  team_source_id text NOT NULL,
  team_name      text NOT NULL,
  -- ESPN's own string, verbatim: "2025-CURRENT", "2019-2023". Kept unparsed
  -- because the vocabulary is undocumented and a wrong parse silently
  -- rewrites a career.
  seasons        text NOT NULL,
  ord            int  NOT NULL,
  source         text NOT NULL,
  PRIMARY KEY (player_id, team_source_id, seasons)
);
CREATE INDEX player_team_history_player_idx ON player_team_history (player_id, ord);

-- Drives the TTL and the per-cycle bound. In the database rather than in the
-- process so the budget survives a restart -- an in-memory cursor would make
-- every redeploy re-fetch the population from the top.
ALTER TABLE player ADD COLUMN IF NOT EXISTS bio_fetched_at timestamptz;
CREATE INDEX player_bio_stale_idx ON player (bio_fetched_at NULLS FIRST);

GRANT SELECT ON player_team_history TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON player_team_history TO scorearc_ingester;
-- A career entry corrected upstream must be able to disappear, or the wrong
-- club outlives the correction.
GRANT DELETE ON player_team_history TO scorearc_ingester;
```

`0012_player_bio.down.sql`:

```sql
DROP TABLE IF EXISTS player_team_history;
DROP INDEX IF EXISTS player_bio_stale_idx;
ALTER TABLE player DROP COLUMN IF EXISTS bio_fetched_at;
```

- [x] **Step 2: Mapper**

`AthleteBioURL(slug, athleteID)` on the **common/v3 host** — add a
`webCommon(slug)` helper mirroring the E5 plan's TypeScript
`https://site.web.api.espn.com/apis/common/v3/sports/soccer/{slug}`, and a test asserting
the exact URL, because pointing it at the site host produces a silent 404.

`MapAthleteBio(raw []byte) ([]model.TeamHistoryEntry, error)` reading
`teamHistory[].{id, displayName, seasons}` in order, dropping entries with no `id`, and
returning an empty slice — not an error — for `{"code":404}` or an absent `teamHistory`.
**Test that 404 case explicitly**; it is the shape a mistyped slug produces and it must not
look like success with data.

- [x] **Step 3: The bounded refresher**

`Store.PlayersNeedingBio(ctx, source string, staleBefore time.Time, limit int) (map[string]uuid.UUID, error)`:

```sql
SELECT r.source_id, p.id
FROM player p
JOIN player_external_ref r ON r.player_id = p.id AND r.source = $1
WHERE (p.bio_fetched_at IS NULL OR p.bio_fetched_at < $2)
  AND EXISTS (SELECT 1 FROM appearance a WHERE a.player_id = p.id)
ORDER BY p.bio_fetched_at NULLS FIRST
LIMIT $3
```

`EXISTS (SELECT 1 FROM appearance …)` is the "has actually played" filter and is the single
largest saving in the whole plan: it removes every squad member who has never been on a team
sheet, which on the recorded fixture is 8 of 35 — roughly a fifth of the population.

`Store.ReplaceTeamHistory(ctx, playerID uuid.UUID, source string, entries []model.TeamHistoryEntry) error`
upserts then deletes the tail, and **always sets `bio_fetched_at = now()` even when the
history is empty** — otherwise a player ESPN has no history for is re-fetched on every
cycle forever, which is the exact opposite of a budget.

`backend/ingester/bio.go`'s `refreshBios(ctx)` runs on slow ticks only, once globally rather
than per competition (the population is global), with:

```go
const (
	// One request per player, and ~6,300 players across nine competitions. At
	// one slow tick every five minutes this covers the whole population in
	// about 30 hours and then goes quiet, which is the point.
	bioBatchSize = 20
	// A career history changes on a transfer. Months, not minutes.
	bioTTL = 30 * 24 * time.Hour
)
```

- [x] **Step 4: Test, run, commit**

```bash
cd backend && go test -race ./... && go vet ./...
```

Expected: every package `ok`, vet silent.

> **Rollback evidence (2026-08-16):** a Testcontainers PostgreSQL 16 test applies every up
> migration, runs `0012.down` then `0011.down`, proves all three owned tables and
> `player.bio_fetched_at` are gone while the pre-existing demographic columns remain, then
> reapplies both up migrations successfully.

Cover, at minimum: the batch never exceeds `bioBatchSize`; a player with no `appearance`
row is never selected; a player whose bio came back empty is **not** re-selected on the next
cycle; and a `{"code":404}` body maps to an empty history rather than an error.

```bash
git add backend/migrations/0012_player_bio.*.sql backend/shared/espn/bio.go \
        backend/shared/espn/bio_test.go backend/shared/store/bio.go \
        backend/shared/store/bio_integration_test.go backend/ingester/bio.go \
        backend/ingester/contracts.go backend/ingester/runner.go \
        backend/ingester/runner_test.go backend/migrations/migrations_test.go
git commit -m "feat: fetch player career history on a bounded budget

/bio is one request per player and there are ~6,300 players. Fetching them
all in a cycle would be a denial-of-service against a keyless public API
we do not pay for.

So: only players with an appearance row (8 of 35 squad members on the
recorded fixture have never played), 20 per slow tick, and a 30-day TTL
driven by player.bio_fetched_at -- in the database rather than in the
process, so a redeploy does not restart the sweep from the top.

bio_fetched_at is stamped even when the history comes back empty.
Otherwise a player ESPN has nothing for is re-fetched forever, which is
the opposite of a budget.

teamHistory.seasons is stored verbatim: the vocabulary is undocumented and
a wrong parse silently rewrites a career.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Doc, gate and PR

- [x] **Step 1: Document**

Add to `docs/backend/ARCHITECTURE.md` under `### Tier 1`:

```markdown
- **squad_membership**(PK (competition_id, season_id, team_id→team, player_id→player), shirt_number, position, source, updated_at) — who is in a squad, per season (T7.9). Season-scoped so a transfer is a second row rather than an overwrite. Refreshed **once per UTC day** from `/teams/{id}/roster`: nine competitions × ~20 clubs = ~180 requests, against ~52,000 if it ran on every slow tick. The team list comes from `standing`.
- **player_season_stat**(PK (competition_id, season_id, player_id→player), team_id→team, appearances, sub_ins, goals, assists, shots, shots_on_target, offsides, fouls_committed, fouls_suffered, own_goals, yellow_cards, red_cards, saves, goals_conceded, shots_faced, source, updated_at) — **the provider's** season aggregate, deliberately not derived from summing `appearance`. The two will disagree: ours covers only matches the ingester has seen, ESPN's covers the whole season and competitions we do not ingest. Keeping both makes the disagreement visible. All nullable — 8 of 35 roster athletes carry no statistics block at all.
- **player_team_history**(PK (player_id→player, team_source_id, seasons), team_name, ord, source) — career clubs from `/athletes/{id}/bio` (T7.10), on the **common/v3 host**. `team_source_id` is the provider's id and **not** a FK to `team`: a career spans competitions we will never curate. `seasons` is ESPN's own string (`"2025-CURRENT"`), stored verbatim because the vocabulary is undocumented. Fetched on a budget — only players with an `appearance`, 20 per slow tick, 30-day TTL via `player.bio_fetched_at`.
- **player** additionally carries **birth_date** and **nationality**, filled from the roster payload's ISO `dateOfBirth`/`citizenship`. Never from the per-athlete endpoint's `displayDOB` (`"23/9/2003"`), which is locale-formatted and ambiguous below the 13th.
```

Add a short note under "Deferred":

```markdown
- **Athlete `/overview` game logs** — not ingested. It returns the last five matches per
  athlete; `appearance` + the T7.7 box score already give a full season log for every match
  the ingester sees, so this would be ~6,000 requests to duplicate a subset of what we hold.
- **Injuries** — not ingested. The `injuries` array is present on every roster athlete and
  **empty on all 35**. The field existing is not the data existing.
```

- [x] **Step 2: Full gate and a real run**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Then, against a scratch Postgres as the least-privilege login (same recipe as the sibling
plans, port `55437`), run `go run ./ingester -once` and check:

```sql
SELECT competition_id, count(DISTINCT team_id) AS clubs, count(*) AS players
  FROM squad_membership GROUP BY 1 ORDER BY 1;
SELECT count(*) AS with_stats FROM player_season_stat;
SELECT count(*) AS players, count(birth_date) AS dated, count(nationality) AS national
  FROM player;
```

Expected: ~20 clubs per competition and roughly 35 players each; `with_stats` strictly
**less** than the membership count (the players who have not appeared); and `dated` close to
`players`. If `with_stats` equals the membership count, the mapper is writing zero rows for
unplayed athletes and Task 3's rule did not land.

`player_team_history` will be near-empty after one `-once` run — the bio sweep does 20 per
slow tick by design. That is correct; say so in the PR rather than treating it as a failure.

> **Execution evidence (2026-08-16):** the post-sync full gate completed in the required
> order: locked dependency install, nine-competition export with no diff, 25 Vitest files /
> 210 tests, strict TypeScript, lint, production build, Go build, full race suite, and vet.
> Lint/build retained six warnings in untouched frontend components, and `npm ci` reported
> eight audit findings in the unchanged lockfile. A scratch PostgreSQL 16 run connected as
> non-superuser `ingest_local` inheriting `scorearc_ingester`, completed `-once` in 52.7s
> with zero failures, and wrote nine competitions: 6,903 memberships, 3,519 season-stat
> rows, 5,299 players (5,101 dated / 5,083 nationalities), and 66 history rows. The stat-row
> count is strictly below membership, as required.

- [ ] **Step 3: PR**

```bash
git push -u origin feat/ingester-squad-and-athletes
gh pr create --title "feat: squads, season stats and player career history (T7.9, T7.10)" --body "$(cat <<'EOF'
## What

Two endpoints at two very different cadences, because they cost very different amounts.

**`/teams/{id}/roster` — daily.** Returns **all 35 players with their season statistics
inline**, so a whole squad table is *one* request. Nine competitions × ~20 clubs = ~180
requests a day.

**`/athletes/{id}/bio` — budgeted.** One request *per player*, ~6,300 players. Only players
with an `appearance` row, **20 per slow tick**, **30-day TTL** via `player.bio_fetched_at`.
The whole population is covered in about 30 hours and then it goes quiet.

## Decisions worth reviewing

- **Squad membership is season-scoped**, so a transfer is a second row rather than an
  overwrite — the same reason `appearance` records the team per match.
- **`player_season_stat` keeps the PROVIDER's aggregate** rather than summing `appearance`.
  The two will disagree: ours covers only matches we have seen, ESPN's covers the whole
  season and competitions we do not ingest. Keeping both makes the disagreement visible
  instead of silently picking a side.
- **8 of 35 roster athletes carry no `statistics` block.** They keep their squad membership
  and get **no** `player_season_stat` row — not a row of zeros about someone nobody has
  measured. Every column is nullable and there is an end-to-end check that the stat-row count
  is strictly less than the membership count.
- **Birth dates come from the roster's ISO `dateOfBirth`.** The per-athlete endpoint offers
  only `displayDOB: "23/9/2003"` — locale-formatted, with day and month indistinguishable
  below the 13th. It is never parsed.
- **`player_team_history.team_source_id` is the provider's id, not a FK to `team`.** A career
  spans competitions we will never curate, and a FK would force a provisional row for every
  club a player has ever been at.
- **`seasons` is stored verbatim** (`"2025-CURRENT"`). The vocabulary is undocumented and a
  wrong parse silently rewrites a career.
- **`bio_fetched_at` is stamped even when the history is empty**, or a player ESPN has
  nothing for is re-fetched forever — the opposite of a budget.
- **Two hosts.** The roster is on `site.api.espn.com`; the bio is on
  `site.web.api.espn.com/apis/common/v3`. The site host returns a bare `{"code":404}` for the
  bio path, which reads as "no history" rather than as a misconfiguration — so there is an
  explicit URL test and an explicit 404-body test.

## Deliberately not built

- **`/overview` game logs.** It returns five matches per athlete; `appearance` + the T7.7 box
  score already give a full season log for every match we ingest. ~6,000 requests to
  duplicate a subset of what we hold.
- **Injuries.** The array is on every roster athlete and **empty on all 35**. The field
  existing is not the data existing.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Fixture-backed: 35 players / 27 with stats, stats read by name across all three categories
  (a mapper reading `categories[0]` gets seven of fifteen), ISO birth dates, and a
  `{"code":404}` body mapping to an empty history rather than an error.
- Real Postgres: a departed player leaves the squad but keeps their season total, an unplayed
  player gets no stat row, the bio batch never exceeds its bound, a player with no
  `appearance` is never selected, an empty bio is not re-selected, and the writes run **as
  `scorearc_ingester`** including the narrow `squad_membership` DELETE grant.

Plan: `docs/superpowers/plans/2026-08-15-ingester-squad-and-athletes.md`
EOF
)"
```

- [ ] **Step 4: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **This plan is mostly about request budget.** Two numbers govern it: **180/day** for
  rosters and **6,300 total** for bios. Both appear in a code comment next to the constant
  that enforces them, not only here.
- **Naming consistency.** `PlayerSeasonStats` (T7.9) is the season aggregate and is distinct
  from T7.7's `PlayerMatchStats`; they share thirteen field names deliberately and
  `PlayerSeasonStats` adds `Appearances` and `SubIns`, which are meaningful over a season and
  redundant within a match.
- **Ordering hazard.** Task 4 adds `squadsRefreshed` to the `runner` struct; `main.go`'s
  literal must initialise it or the first successful refresh nil-map-panics in production.
  `go vet` will not catch it. Same trap as T7.1's `snapshotted`.
- **The thing most likely to be got wrong.** Reading `statistics.splits.categories[0]` and
  stopping. It compiles, it returns data, and it silently drops eight of fifteen stats
  including every goalkeeping number. `TestMapRosterReadsStatsAcrossCategoriesByName` exists
  only to catch that.
</content>
