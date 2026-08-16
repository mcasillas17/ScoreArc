# Ingester — Per-Match Player Box Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist what every player actually did in every match — goals, assists, shots,
shots on target, offsides, fouls, cards, own goals, saves, goals conceded, shots faced —
so "how has this player performed over the season" stops being an impossible query.

**Architecture:** `feat/player-identity` already writes one `appearance` row per player
per match, resolved to a canonical `player.id`. That row currently carries *whether* a
player was there and nothing about *what happened*. The numbers are already in the
payload the ingester fetches: `rosters[].roster[].stats[]` on the summary. `mapSquad`
walks straight past that array. This plan reads it, by **name never by index**, onto
nullable columns on the existing `appearance` row — no new table, no new request, no new
identity work.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-history-and-trends-design.md` (E7) and
`docs/superpowers/specs/2026-08-15-assists-and-box-score-design.md` (E1, the TypeScript
half of the same payload)
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Task: T7.7** (new — add under E7)
**Branch:** `feat/ingester-box-score`

---

## The one rule that governs the whole plan

**The stat set varies by position. A stat the provider does not send is `NULL`, never `0`.**

Verified against the recorded fixture `backend/shared/espn/testdata/espn-summary.json`
(Ivory Coast v Norway, ESPN event 760490) on 2026-08-15:

```
G      (14 stats): appearances, foulsCommitted, foulsSuffered, goalAssists,
                   goalsConceded, ownGoals, redCards, saves, shotsFaced,
                   shotsOnTarget, subIns, totalGoals, totalShots, yellowCards
CD-L   (14 stats): ... offsides ... and NO saves
```

A goalkeeper has no `offsides` entry; an outfielder has no `saves` entry. Writing `0`
for either would state that the keeper was onside all match and that the centre-back made
no saves — the second of which is true but unmeasured, and the first of which is a
category error. Both would then be averaged into a per-position percentile in T7.4 and
quietly wreck it. Every stat column is nullable and every mapper lookup is by
`stats[].name`.

---

## ⚠️ Merge order and migration numbering

This plan adds migration **`0006_appearance_box_score`** and extends
`Store.WriteParticipation`, which does not exist on `main`. Prerequisites, in order:

1. **`feat/canonical-identity-impl`** — rewrites `0001`, deletes `0003_ingester_delete_grant`
   and `0004_ingester_hardening`.
2. **`feat/player-identity`** — adds `0003_player_capture.*` (the `appearance` and
   `match_event` tables), `model.SquadPlayer`, `espn.MapParticipation` and
   `Store.WriteParticipation`. **This plan edits all four of those.**
3. T7.1 (`0004_*`) and T7.6 (`0005_*`).

```bash
ls backend/migrations/
grep -c "func (s \*Store) WriteParticipation" backend/shared/store/participation.go
```

Expected: `0001` … `0005_*` present, and the grep prints `1`. If
`shared/store/participation.go` does not exist, `feat/player-identity` has not merged —
**stop**, because this plan would otherwise re-invent the appearance writer it is meant to
extend.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, and confirm it fails for the stated reason.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN` for writes, `INGESTER_LEASE_DSN` for the direct/unpooled advisory-lock
  session. Secrets via `fly secrets`.
- **Parity with the TypeScript half.** E1's T1.3 reads the same array into
  `PlayerMatchStats` on the frontend. The two must agree on which ESPN stat name maps to
  which field, exactly as the own-goal rule must agree between the two paths — otherwise
  the same match reports different numbers depending on which path served it.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/migrations/0006_appearance_box_score.up.sql` / `.down.sql` — new. Thirteen
  nullable integer columns on `appearance`.
- `backend/migrations/migrations_test.go` — one new case.
- `backend/shared/model/participation.go` — `PlayerMatchStats`; `SquadPlayer.Stats`.
- `backend/shared/espn/types.go` — the `PlayerMatchStats` alias.
- `backend/shared/espn/summary.go` — `rawRosterPlayer.Stats`, `rawPlayerStat`.
- `backend/shared/espn/participation.go` — `mapSquad` reads the array.
- `backend/shared/espn/participation_test.go` — fixture-backed cases.
- `backend/shared/store/participation.go` — the appearance upsert carries the numbers.
- `backend/shared/store/participation_integration_test.go` — new cases.
- `docs/backend/ARCHITECTURE.md` — the `appearance` bullet.

---

### Task 1: Nullable stat columns on `appearance`

**Files:**
- Create: `backend/migrations/0006_appearance_box_score.up.sql`
- Create: `backend/migrations/0006_appearance_box_score.down.sql`
- Test: `backend/migrations/migrations_test.go`

**Which stats, and which are deliberately dropped.** The fixture carries fifteen names.
Thirteen become columns. Two do not:

- `appearances` — always `1` on a row that exists. The row is the appearance.
- `subIns` — derivable from `appearance.starter` plus the `sub_on` rows
  `0003_player_capture` already writes. Storing it a third time invites the three copies
  to disagree.

- [ ] **Step 1: Write the failing migration test**

Append to `backend/migrations/migrations_test.go`:

```go
// The stat set VARIES BY POSITION -- verified in espn-summary.json, where a
// goalkeeper has no `offsides` entry and an outfielder has no `saves` entry.
// A NOT NULL DEFAULT 0 column would record "the keeper was onside all match"
// and "the centre-back made no saves" as measurements, and T7.4's per-position
// percentiles would then average those inventions.
func TestAppearanceBoxScoreColumnsAreNullable(t *testing.T) {
	sql := readMigration(t, "0006_appearance_box_score.up.sql")
	for _, required := range []string{
		"ALTER TABLE appearance",
		"goals            int",
		"assists          int",
		"shots            int",
		"shots_on_target  int",
		"offsides         int",
		"fouls_committed  int",
		"fouls_suffered   int",
		"own_goals        int",
		"yellow_cards     int",
		"red_cards        int",
		"saves            int",
		"goals_conceded   int",
		"shots_faced      int",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0006_appearance_box_score.up.sql missing %q", required)
		}
	}
	for _, forbidden := range []string{"NOT NULL", "DEFAULT 0"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("box score columns must be nullable; found %q", forbidden)
		}
	}
}

func TestAppearanceBoxScoreRollbackDropsOnlyTheColumns(t *testing.T) {
	sql := readMigration(t, "0006_appearance_box_score.down.sql")
	if !strings.Contains(sql, "DROP COLUMN IF EXISTS goals_conceded") {
		t.Fatalf("rollback missing a column drop:\n%s", sql)
	}
	if strings.Contains(sql, "DROP TABLE") {
		t.Fatal("the rollback must not drop appearance itself")
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./migrations/ -run AppearanceBoxScore
```

Expected: FAIL — `open 0006_appearance_box_score.up.sql: no such file or directory`.

- [ ] **Step 3: Write the up migration**

Create `backend/migrations/0006_appearance_box_score.up.sql`:

```sql
-- What a player DID, on the row that already records that they were there.
--
-- The numbers come from rosters[].roster[].stats[] on the match summary, which
-- the ingester already fetches and MapParticipation already walks past. No new
-- endpoint and no new request.
--
-- EVERY COLUMN IS NULLABLE, AND THAT IS THE POINT. ESPN's stat set varies by
-- position: verified in shared/espn/testdata/espn-summary.json, a goalkeeper
-- row carries `saves`, `goalsConceded` and `shotsFaced` but no `offsides`,
-- while an outfielder carries `offsides` and no `saves`. A NOT NULL DEFAULT 0
-- would turn "not measured" into "measured as zero", and T7.4's per-position
-- percentiles would then average the invention.
--
-- `own_goals` here is the count of own goals THIS PLAYER put into their own
-- net. It is a different attribution from match_event, where an own goal is
-- credited to the team that BENEFITS with the opposition player named -- which
-- is ESPN's convention, not ours. Both are correct; they answer different
-- questions, and this comment is here so nobody "reconciles" them.
--
-- Deliberately absent: `appearances` (always 1 on a row that exists) and
-- `subIns` (derivable from starter plus the sub_on rows in 0003; a third copy
-- would only give the three something to disagree about).
ALTER TABLE appearance
  ADD COLUMN goals            int,
  ADD COLUMN assists          int,
  ADD COLUMN shots            int,
  ADD COLUMN shots_on_target  int,
  ADD COLUMN offsides         int,
  ADD COLUMN fouls_committed  int,
  ADD COLUMN fouls_suffered   int,
  ADD COLUMN own_goals        int,
  ADD COLUMN yellow_cards     int,
  ADD COLUMN red_cards        int,
  ADD COLUMN saves            int,
  ADD COLUMN goals_conceded   int,
  ADD COLUMN shots_faced      int;

-- "Every match this player has played, newest first" is the query behind both
-- a player page's game log (T7.4) and any per-position percentile. 0003
-- already indexes appearance(player_id); nothing further is needed until a
-- season filter proves slow, and an index added on a guess is an index nobody
-- can remove.
```

- [ ] **Step 4: Write the down migration**

Create `backend/migrations/0006_appearance_box_score.down.sql`:

```sql
-- Drops the columns, never the appearances. A summary for a finished match can
-- usually be re-fetched, but the appearance rows themselves encode identity
-- resolution that would have to be redone.
ALTER TABLE appearance
  DROP COLUMN IF EXISTS shots_faced,
  DROP COLUMN IF EXISTS goals_conceded,
  DROP COLUMN IF EXISTS saves,
  DROP COLUMN IF EXISTS red_cards,
  DROP COLUMN IF EXISTS yellow_cards,
  DROP COLUMN IF EXISTS own_goals,
  DROP COLUMN IF EXISTS fouls_suffered,
  DROP COLUMN IF EXISTS fouls_committed,
  DROP COLUMN IF EXISTS offsides,
  DROP COLUMN IF EXISTS shots_on_target,
  DROP COLUMN IF EXISTS shots,
  DROP COLUMN IF EXISTS assists,
  DROP COLUMN IF EXISTS goals;
```

- [ ] **Step 5: Run and prove the SQL applies**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0006_appearance_box_score.up.sql \
        backend/migrations/0006_appearance_box_score.down.sql \
        backend/migrations/migrations_test.go
git commit -m "feat: add nullable box-score columns to appearance

Thirteen columns for what a player did, on the row that already records
that they were there. The numbers are in rosters[].roster[].stats[] on a
summary the ingester already fetches.

Every column nullable on purpose: the stat set varies by position --
verified in espn-summary.json, a keeper has no offsides entry and an
outfielder has no saves entry -- so a NOT NULL DEFAULT 0 would turn 'not
measured' into 'measured as zero' and poison T7.4's percentiles.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Read the stats array, by name

**Files:**
- Modify: `backend/shared/model/participation.go`
- Modify: `backend/shared/espn/types.go`
- Modify: `backend/shared/espn/summary.go`
- Modify: `backend/shared/espn/participation.go`
- Test: `backend/shared/espn/participation_test.go`

**Interfaces:**
- `model.PlayerMatchStats` — thirteen `*int` fields. Ingester-internal, no JSON tags,
  never serialized into `match_detail`.
- `model.SquadPlayer` gains `Stats *PlayerMatchStats` — `nil` when the provider sent no
  `stats` array at all, which is different from an array whose entries are missing.

- [ ] **Step 1: Write the failing mapper tests**

Append to `backend/shared/espn/participation_test.go`:

```go
// The core rule, against the recorded fixture. A goalkeeper's row carries
// saves/goalsConceded/shotsFaced and NO offsides; an outfielder's carries
// offsides and NO saves. Both absences must arrive as nil, because the
// alternative is recording an unmeasured stat as a measured zero.
func TestMapParticipationReadsPerPositionStats(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	part, err := MapParticipation(raw, "4789", "464")
	if err != nil {
		t.Fatal(err)
	}

	var keeper, outfielder *SquadPlayer
	for i := range part.Home {
		p := &part.Home[i]
		if p.Stats == nil {
			continue
		}
		if p.Position == "G" && keeper == nil {
			keeper = p
		}
		if p.Position != "G" && p.Position != "SUB" && outfielder == nil {
			outfielder = p
		}
	}
	if keeper == nil || outfielder == nil {
		t.Fatalf("fixture gave keeper=%v outfielder=%v; both are needed", keeper, outfielder)
	}

	if keeper.Stats.Saves == nil {
		t.Fatal("keeper Saves is nil; the fixture carries a saves entry for G")
	}
	if keeper.Stats.Offsides != nil {
		t.Fatalf("keeper Offsides = %d, want nil -- ESPN sends no offsides for G",
			*keeper.Stats.Offsides)
	}
	if outfielder.Stats.Offsides == nil {
		t.Fatal("outfielder Offsides is nil; the fixture carries an offsides entry")
	}
	if outfielder.Stats.Saves != nil {
		t.Fatalf("outfielder Saves = %d, want nil -- ESPN sends no saves for outfielders",
			*outfielder.Stats.Saves)
	}
}

// Lookup is by name. The array order is ESPN's and has changed between
// payloads before; an index-based read is a silent mis-attribution rather than
// an error, which is the worst failure mode available here.
func TestMapParticipationLooksStatsUpByName(t *testing.T) {
	raw := []byte(`{
	  "rosters": [{
	    "team": {"id": "1"},
	    "roster": [{
	      "starter": true, "jersey": "9",
	      "athlete": {"id": "77", "displayName": "Striker"},
	      "position": {"abbreviation": "F"},
	      "stats": [
	        {"name": "yellowCards",  "value": 1},
	        {"name": "totalShots",   "value": 5},
	        {"name": "totalGoals",   "value": 2},
	        {"name": "goalAssists",  "value": 1},
	        {"name": "shotsOnTarget","value": 3},
	        {"name": "ownGoals",     "value": 0}
	      ]
	    }]
	  }]
	}`)
	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	if len(part.Home) != 1 || part.Home[0].Stats == nil {
		t.Fatalf("home = %#v, want one player with stats", part.Home)
	}
	s := part.Home[0].Stats
	// Shuffled on purpose: read positionally, totalGoals would come back as 5.
	if s.Goals == nil || *s.Goals != 2 {
		t.Fatalf("Goals = %v, want 2", s.Goals)
	}
	if s.Shots == nil || *s.Shots != 5 {
		t.Fatalf("Shots = %v, want 5", s.Shots)
	}
	if s.Assists == nil || *s.Assists != 1 {
		t.Fatalf("Assists = %v, want 1", s.Assists)
	}
	if s.ShotsOnTarget == nil || *s.ShotsOnTarget != 3 {
		t.Fatalf("ShotsOnTarget = %v, want 3", s.ShotsOnTarget)
	}
	// A stat the provider DID send as zero is a measurement and stays zero.
	if s.OwnGoals == nil || *s.OwnGoals != 0 {
		t.Fatalf("OwnGoals = %v, want a measured 0", s.OwnGoals)
	}
	// A stat the provider never sent stays nil.
	if s.Saves != nil {
		t.Fatalf("Saves = %v, want nil", s.Saves)
	}
}

// No stats array at all is a different thing from an array with gaps, and the
// store relies on the difference: nil means "the provider said nothing", which
// must never overwrite numbers a previous poll established.
func TestMapParticipationLeavesStatsNilWhenAbsent(t *testing.T) {
	raw := []byte(`{"rosters":[{"team":{"id":"1"},"roster":[
	  {"starter":true,"jersey":"9","athlete":{"id":"77","displayName":"Striker"},
	   "position":{"abbreviation":"F"}}]}]}`)
	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	if part.Home[0].Stats != nil {
		t.Fatalf("Stats = %#v, want nil when the payload has no stats array", part.Home[0].Stats)
	}
}

// A non-integral or negative count is a payload we do not understand. Record
// nothing rather than truncating it into a plausible-looking number.
func TestMapParticipationRejectsImpossibleCounts(t *testing.T) {
	raw := []byte(`{"rosters":[{"team":{"id":"1"},"roster":[
	  {"starter":true,"jersey":"9","athlete":{"id":"77","displayName":"Striker"},
	   "position":{"abbreviation":"F"},
	   "stats":[{"name":"totalGoals","value":1.5},{"name":"totalShots","value":-3},
	            {"name":"goalAssists","value":2}]}]}]}`)
	part, err := MapParticipation(raw, "1", "2")
	if err != nil {
		t.Fatal(err)
	}
	s := part.Home[0].Stats
	if s.Goals != nil {
		t.Fatalf("Goals = %d from value 1.5, want nil", *s.Goals)
	}
	if s.Shots != nil {
		t.Fatalf("Shots = %d from value -3, want nil", *s.Shots)
	}
	if s.Assists == nil || *s.Assists != 2 {
		t.Fatalf("Assists = %v, want 2 -- one bad entry must not discard the row", s.Assists)
	}
}
```

Add `"os"` to that file's imports if it is not already there.

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/espn/ -run MapParticipation
```

Expected: FAIL to compile — `p.Stats undefined (type SquadPlayer has no field or method Stats)`.

- [ ] **Step 3: Add the model type**

Append to `backend/shared/model/participation.go`:

```go
// PlayerMatchStats is what one player did in one match, as the provider
// measured it.
//
// Every field is a POINTER, and that is the entire design. ESPN's stat set
// varies by position: a goalkeeper's row carries saves, goalsConceded and
// shotsFaced but no offsides; an outfielder's carries offsides and no saves.
// nil means "the provider did not measure this", zero means "the provider
// measured this and it was zero", and collapsing the two would put an
// invention into every per-position percentile computed downstream.
//
// The field names are ScoreArc's; the ESPN names they are read from are on the
// right. They are looked up by name in the stats array, never by index -- the
// order is ESPN's and an index read would mis-attribute silently.
type PlayerMatchStats struct {
	Goals         *int // totalGoals
	Assists       *int // goalAssists
	Shots         *int // totalShots
	ShotsOnTarget *int // shotsOnTarget
	Offsides      *int // offsides       -- absent for goalkeepers
	FoulsCommitted *int // foulsCommitted
	FoulsSuffered  *int // foulsSuffered
	// OwnGoals counts own goals THIS PLAYER put into their own net. It is a
	// different attribution from match_event, where ESPN credits an own goal to
	// the team that BENEFITS and names the opposition player. Both are correct;
	// they answer different questions.
	OwnGoals      *int // ownGoals
	YellowCards   *int // yellowCards
	RedCards      *int // redCards
	Saves         *int // saves         -- absent for outfielders
	GoalsConceded *int // goalsConceded
	ShotsFaced    *int // shotsFaced
}
```

and add the field to `SquadPlayer`:

```go
type SquadPlayer struct {
	SourceID string // "" when the provider omitted the athlete id
	Name     string
	Number   *int
	Position string
	Starter  bool
	// Stats is nil when the payload carried no stats array for this player at
	// all -- which is NOT the same as an array with gaps in it. The store
	// relies on the difference: nil must never overwrite numbers an earlier
	// poll established.
	Stats *PlayerMatchStats
}
```

Add the alias to `backend/shared/espn/types.go`, beside the existing participation
aliases:

```go
type PlayerMatchStats = model.PlayerMatchStats
```

- [ ] **Step 4: Decode the array**

In `backend/shared/espn/summary.go`, extend `rawRosterPlayer` and add the entry type:

```go
type rawRosterPlayer struct {
	Starter  bool            `json:"starter"`
	Jersey   string          `json:"jersey"`
	Athlete  rawAthlete      `json:"athlete"`
	Position rawPosition     `json:"position"`
	Stats    []rawPlayerStat `json:"stats"`
}

// rawPlayerStat is deliberately NOT rawStatEntry: that type carries only
// name+displayValue (it serves the team boxscore, which is string-formatted),
// whereas a player's stat carries a numeric `value`. Value is a pointer so an
// explicit JSON null is distinguishable from an absent key -- both end as a
// nil column, but only one of them is a payload change worth noticing.
type rawPlayerStat struct {
	Name  string   `json:"name"`
	Value *float64 `json:"value"`
}
```

- [ ] **Step 5: Map it**

In `backend/shared/espn/participation.go`, replace `mapSquad`:

```go
func mapSquad(entry *rawRosterEntry) []SquadPlayer {
	out := make([]SquadPlayer, 0, len(entry.Roster))
	for _, p := range entry.Roster {
		var number *int
		if n, err := strconv.Atoi(p.Jersey); err == nil {
			number = &n
		}
		out = append(out, SquadPlayer{
			SourceID: string(p.Athlete.ID),
			Name:     p.Athlete.DisplayName,
			Number:   number,
			Position: p.Position.Abbreviation,
			Starter:  p.Starter,
			Stats:    mapPlayerStats(p.Stats),
		})
	}
	return out
}

// mapPlayerStats reads the per-match numbers BY NAME.
//
// By name, never by index: the array order is ESPN's, it has no documented
// stability, and an index read would mis-attribute a value rather than fail --
// three goals reported as three yellow cards, with nothing anywhere to notice.
//
// Returns nil when the provider sent no array at all, so the store can tell
// "nothing was said" from "everything was said and some of it was missing".
func mapPlayerStats(entries []rawPlayerStat) *PlayerMatchStats {
	if len(entries) == 0 {
		return nil
	}
	stats := &PlayerMatchStats{}
	targets := map[string]**int{
		"totalGoals":     &stats.Goals,
		"goalAssists":    &stats.Assists,
		"totalShots":     &stats.Shots,
		"shotsOnTarget":  &stats.ShotsOnTarget,
		"offsides":       &stats.Offsides,
		"foulsCommitted": &stats.FoulsCommitted,
		"foulsSuffered":  &stats.FoulsSuffered,
		"ownGoals":       &stats.OwnGoals,
		"yellowCards":    &stats.YellowCards,
		"redCards":       &stats.RedCards,
		"saves":          &stats.Saves,
		"goalsConceded":  &stats.GoalsConceded,
		"shotsFaced":     &stats.ShotsFaced,
	}
	// `appearances` is always 1 on a row that exists, and `subIns` is
	// derivable from Starter plus the sub_on events. Both are dropped rather
	// than stored a second and third time.
	for _, entry := range entries {
		target, wanted := targets[entry.Name]
		if !wanted {
			continue
		}
		count, ok := wholeCount(entry.Value)
		if !ok {
			// A fractional or negative count is a payload we do not
			// understand. Leaving it nil records "unknown"; truncating it
			// would record a plausible-looking number that is not a
			// measurement. One bad entry never discards the rest of the row.
			continue
		}
		*target = &count
	}
	return stats
}

func wholeCount(value *float64) (int, bool) {
	if value == nil || *value < 0 || math.Trunc(*value) != *value {
		return 0, false
	}
	return int(*value), true
}
```

Add `"math"` to that file's imports.

- [ ] **Step 6: Run the mapper tests**

```bash
cd backend && go test ./shared/espn/ -run MapParticipation -v
```

Expected: the four new cases pass alongside the ones `feat/player-identity` already added
— `TestMapParticipationReadsPerPositionStats`,
`TestMapParticipationLooksStatsUpByName`,
`TestMapParticipationLeavesStatsNilWhenAbsent`,
`TestMapParticipationRejectsImpossibleCounts`.

- [ ] **Step 7: Commit**

```bash
git add backend/shared/model/participation.go backend/shared/espn/types.go \
        backend/shared/espn/summary.go backend/shared/espn/participation.go \
        backend/shared/espn/participation_test.go
git commit -m "feat: read per-match player stats from the summary rosters

rosters[].roster[].stats[] was already in every payload the ingester
fetches and mapSquad walked straight past it.

Read by name, never by index: the array order is ESPN's, and an index read
mis-attributes silently -- three goals reported as three yellow cards with
nothing anywhere to notice.

Every field is a pointer. A keeper has no offsides entry and an outfielder
has no saves entry; nil is 'not measured' and 0 is 'measured as zero', and
collapsing them would put an invention into every percentile downstream.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Persist the numbers on the appearance row

**Files:**
- Modify: `backend/shared/store/participation.go`
- Test: `backend/shared/store/participation_integration_test.go`

- [ ] **Step 1: Write the failing integration tests**

Append to `backend/shared/store/participation_integration_test.go`:

```go
// The numbers land on the row that already says the player was there.
func TestWriteParticipationStoresTheBoxScore(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	goals, shots, saves := 2, 5, 0
	part := &model.MatchParticipation{
		HomeTeamSourceID: "359", AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{{
			SourceID: "77", Name: "Striker", Position: "F", Starter: true,
			Stats: &model.PlayerMatchStats{Goals: &goals, Shots: &shots},
		}, {
			SourceID: "88", Name: "Keeper", Position: "G", Starter: true,
			Stats: &model.PlayerMatchStats{Saves: &saves},
		}},
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", part); err != nil {
		t.Fatalf("WriteParticipation: %v", err)
	}

	var storedGoals, storedShots *int
	var storedOffsides, storedSaves *int
	if err := pool.QueryRow(ctx, `
SELECT a.goals, a.shots, a.offsides, a.saves
FROM appearance a
JOIN player_external_ref r ON r.player_id = a.player_id
WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='77'`,
		matchID).Scan(&storedGoals, &storedShots, &storedOffsides, &storedSaves); err != nil {
		t.Fatal(err)
	}
	if storedGoals == nil || *storedGoals != 2 {
		t.Fatalf("goals = %v, want 2", storedGoals)
	}
	if storedShots == nil || *storedShots != 5 {
		t.Fatalf("shots = %v, want 5", storedShots)
	}
	// The whole rule: not measured stays NULL, and never becomes 0.
	if storedOffsides != nil {
		t.Fatalf("offsides = %d, want NULL -- it was never measured", *storedOffsides)
	}
	if storedSaves != nil {
		t.Fatalf("saves = %d on an outfielder, want NULL", *storedSaves)
	}

	var keeperSaves *int
	if err := pool.QueryRow(ctx, `
SELECT a.saves FROM appearance a
JOIN player_external_ref r ON r.player_id = a.player_id
WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='88'`,
		matchID).Scan(&keeperSaves); err != nil {
		t.Fatal(err)
	}
	// A measured zero is a measurement.
	if keeperSaves == nil || *keeperSaves != 0 {
		t.Fatalf("keeper saves = %v, want a measured 0", keeperSaves)
	}
}

// A live match is re-polled every 20 seconds and the numbers climb. Later must
// win, or the box score freezes at the first minute of the match.
func TestWriteParticipationUpdatesAClimbingBoxScore(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	write := func(goals int) {
		t.Helper()
		g := goals
		if _, err := store.WriteParticipation(ctx, "espn", matchID,
			"eng-arsenal", "eng-chelsea", &model.MatchParticipation{
				HomeTeamSourceID: "359", AwayTeamSourceID: "363",
				Home: []model.SquadPlayer{{
					SourceID: "77", Name: "Striker", Position: "F", Starter: true,
					Stats: &model.PlayerMatchStats{Goals: &g},
				}},
			}); err != nil {
			t.Fatal(err)
		}
	}
	write(1)
	write(3)

	var goals *int
	if err := pool.QueryRow(ctx,
		`SELECT goals FROM appearance WHERE match_id=$1`, matchID).Scan(&goals); err != nil {
		t.Fatal(err)
	}
	if goals == nil || *goals != 3 {
		t.Fatalf("goals = %v, want the later observation 3", goals)
	}
}

// A poll that comes back with a roster but NO stats block must not erase
// numbers an earlier poll established. Absence of evidence only -- the same
// rule WriteParticipation already applies to an empty payload.
func TestWriteParticipationKeepsStatsWhenAPollOmitsThem(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	goals := 2
	withStats := &model.MatchParticipation{
		HomeTeamSourceID: "359", AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{{
			SourceID: "77", Name: "Striker", Position: "F", Starter: true,
			Stats: &model.PlayerMatchStats{Goals: &goals},
		}},
	}
	withoutStats := &model.MatchParticipation{
		HomeTeamSourceID: "359", AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{{
			SourceID: "77", Name: "Striker", Position: "F", Starter: true,
		}},
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", withStats); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteParticipation(ctx, "espn", matchID,
		"eng-arsenal", "eng-chelsea", withoutStats); err != nil {
		t.Fatal(err)
	}

	var stored *int
	if err := pool.QueryRow(ctx,
		`SELECT goals FROM appearance WHERE match_id=$1`, matchID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == nil || *stored != 2 {
		t.Fatalf("goals = %v after a statless poll, want the earlier 2 preserved", stored)
	}
}
```

`mustSeedMatch` is the helper T7.6 added to `snapshots_integration_test.go`; it is in the
same package, so it is already in scope.

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/store/ -run WriteParticipation
```

Expected: FAIL to compile —
`unknown field Stats in struct literal of type model.SquadPlayer` will already be gone
after Task 2, so the failure is at the assertions:
`goals = <nil>, want 2` — the column exists but nothing writes it.

- [ ] **Step 3: Extend the upsert**

In `backend/shared/store/participation.go`, replace the appearance `tx.Exec` inside the
`if squadPresent {` block:

```go
			if _, err := tx.Exec(opCtx, `
INSERT INTO appearance (
  match_id, player_id, team_id, starter, shirt_number, position,
  goals, assists, shots, shots_on_target, offsides,
  fouls_committed, fouls_suffered, own_goals,
  yellow_cards, red_cards, saves, goals_conceded, shots_faced)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
ON CONFLICT (match_id, player_id) DO UPDATE SET
  team_id      = EXCLUDED.team_id,
  starter      = EXCLUDED.starter,
  shirt_number = EXCLUDED.shirt_number,
  position     = EXCLUDED.position,
  -- COALESCE, not a bare EXCLUDED. A live match is re-polled every 20s and a
  -- poll that comes back without a stats block -- which happens -- would
  -- otherwise NULL out numbers an earlier poll established. Absence of
  -- evidence only, the same rule the empty-payload guard above applies. A
  -- stat can therefore never go from a number back to unknown, which is the
  -- correct trade: nothing upstream retracts a measurement, it only revises
  -- it, and a revision arrives as a number.
  goals           = COALESCE(EXCLUDED.goals,           appearance.goals),
  assists         = COALESCE(EXCLUDED.assists,         appearance.assists),
  shots           = COALESCE(EXCLUDED.shots,           appearance.shots),
  shots_on_target = COALESCE(EXCLUDED.shots_on_target, appearance.shots_on_target),
  offsides        = COALESCE(EXCLUDED.offsides,        appearance.offsides),
  fouls_committed = COALESCE(EXCLUDED.fouls_committed, appearance.fouls_committed),
  fouls_suffered  = COALESCE(EXCLUDED.fouls_suffered,  appearance.fouls_suffered),
  own_goals       = COALESCE(EXCLUDED.own_goals,       appearance.own_goals),
  yellow_cards    = COALESCE(EXCLUDED.yellow_cards,    appearance.yellow_cards),
  red_cards       = COALESCE(EXCLUDED.red_cards,       appearance.red_cards),
  saves           = COALESCE(EXCLUDED.saves,           appearance.saves),
  goals_conceded  = COALESCE(EXCLUDED.goals_conceded,  appearance.goals_conceded),
  shots_faced     = COALESCE(EXCLUDED.shots_faced,     appearance.shots_faced)`,
				append([]any{
					matchID, r.playerID, r.teamID, r.player.Starter,
					r.player.Number, nullIfEmpty(r.player.Position),
				}, boxScoreArgs(r.player.Stats)...)...,
			); err != nil {
				return stats, fmt.Errorf("upsert appearance: %w", err)
			}
```

and add the argument builder at the bottom of the file:

```go
// boxScoreArgs flattens the thirteen box-score columns in the exact order the
// INSERT lists them. A nil PlayerMatchStats yields thirteen nils, which the
// COALESCE in the upsert turns into "change nothing" -- so a poll with no
// stats block is a no-op on the numbers rather than an erasure.
//
// The columns are listed here in one place, in one order, so adding a
// fourteenth stat is one edit to the INSERT and one to this slice rather than
// a hunt through positional placeholders.
func boxScoreArgs(stats *model.PlayerMatchStats) []any {
	if stats == nil {
		return make([]any, 13)
	}
	return []any{
		stats.Goals, stats.Assists, stats.Shots, stats.ShotsOnTarget,
		stats.Offsides, stats.FoulsCommitted, stats.FoulsSuffered,
		stats.OwnGoals, stats.YellowCards, stats.RedCards,
		stats.Saves, stats.GoalsConceded, stats.ShotsFaced,
	}
}
```

- [ ] **Step 4: Run the store tests**

```bash
cd backend && go test ./shared/store/ -run WriteParticipation -v
```

Expected: the three new cases pass alongside the ones `feat/player-identity` added,
including `TestWriteParticipationAsTheIngesterRole` — which now also proves the
least-privilege role can write the new columns, because they are on a table it already
had `INSERT, UPDATE` on. No new grant is needed and none should be added.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/store/participation.go \
        backend/shared/store/participation_integration_test.go
git commit -m "feat: persist the per-match box score on appearance

Thirteen nullable columns filled from the stats array MapParticipation now
reads. No new table and no new grant -- appearance is already writable by
scorearc_ingester.

COALESCE rather than bare EXCLUDED on every stat: a live match is polled
every 20s and a poll that returns a roster without a stats block would
otherwise erase numbers an earlier poll established. Same absence-of-
evidence rule the empty-payload guard already applies.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Record a real own goal and test the Go mapper against it

**Files:**
- Create: `backend/shared/espn/testdata/espn-summary-own-goal.json`
- Test: `backend/shared/espn/participation_test.go`

**Why this is in this plan.** `mapPlayerEvents` in `shared/espn/participation.go` — the
file Task 2 just edited — classifies own goals with `strings.Contains(kind, "own")`, and
its own comment admits the problem:

```go
// Unverified: no own goal appears in any recorded fixture. Detail keeps
// ESPN's own label, so if this guess is wrong it is fixable from stored
// rows rather than by re-fetching a finished match.
```

An untested branch that decides which team a goal belongs to is not a small gap. E0 is
fixing the identical defect on the TypeScript side and **records a fixture to do it**;
the Go side should test against the **same match**, or the two paths can diverge on the
one event type where divergence changes a scoreline.

This also matters for T7.7 specifically: `appearance.own_goals` counts own goals the
player put into their **own** net, while `match_event` follows ESPN's convention of
crediting the **beneficiary** team. Those two attributions are only safely different if
the event classification underneath them is right.

- [ ] **Step 1: Record the fixture**

```bash
cd backend
curl -s "https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/summary?event=401863609" \
  -o shared/espn/testdata/espn-summary-own-goal.json
```

- [ ] **Step 2: Verify it captured the event we need**

```bash
cd backend && node -e "
const d = require('./shared/espn/testdata/espn-summary-own-goal.json');
for (const e of d.keyEvents.filter(e => e.scoringPlay)) {
  console.log(e.team.id, JSON.stringify(e.type.type), e.participants[0].athlete.displayName, e.clock.displayValue);
}
console.log('teams:', d.rosters.map(r => r.team.id + '=' + r.team.displayName).join(', '));
"
```

Expected, exactly:

```
226 "own-goal" Devin Padelford 32'
17362 "goal" Mauricio Gonzalez 59'
17362 "goal" Joaquín Pereyra 75'
17362 "goal" Joaquín Pereyra 87'
teams: 17362=Minnesota United FC, 226=Atlante
```

Read that carefully — it is the whole defect. The 32' goal is credited to **Atlante
(226)**, and the player named is **Devin Padelford, who plays for Minnesota**. ESPN
credits the team that benefits and names the opposition player who put it in. There is
**no `ownGoal` boolean** on the key event; `type.type` is the only signal.

- [ ] **Step 3: Write the failing test**

Append to `backend/shared/espn/participation_test.go`:

```go
// The own-goal branch in mapPlayerEvents has never been executed against real
// data -- its own comment says so. It decides which TEAM a goal is attributed
// to, so an untested guess here is a wrong scoreline, and the TypeScript side
// (E0) is being fixed against this exact match. The two must agree or the same
// event reports differently depending on which path served it.
func TestMapParticipationClassifiesARealOwnGoal(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary-own-goal.json")
	if err != nil {
		t.Fatal(err)
	}
	// Minnesota United (17362) at home, Atlante (226) away.
	part, err := MapParticipation(raw, "17362", "226")
	if err != nil {
		t.Fatal(err)
	}

	var ownGoals, goals []PlayerEvent
	for _, e := range part.Events {
		switch e.Type {
		case PlayerEventOwnGoal:
			ownGoals = append(ownGoals, e)
		case PlayerEventGoal:
			goals = append(goals, e)
		}
	}

	if len(ownGoals) != 1 {
		t.Fatalf("own goals = %d, want exactly 1", len(ownGoals))
	}
	og := ownGoals[0]
	if og.PlayerName != "Devin Padelford" {
		t.Fatalf("own-goal scorer = %q, want Devin Padelford", og.PlayerName)
	}
	// ESPN's convention, preserved deliberately: the event belongs to the team
	// that BENEFITED. Re-attributing it to Padelford's own side here would be
	// "helpful" and wrong -- it would credit Minnesota with a goal they did not
	// score, and the site would show a 4-0 as 3-1.
	if og.TeamSourceID != "226" {
		t.Fatalf("own goal attributed to team %q, want 226 (Atlante, the beneficiary)",
			og.TeamSourceID)
	}
	if og.Minute != "32'" {
		t.Fatalf("minute = %q, want 32'", og.Minute)
	}
	// The provider's own label, kept verbatim, is what makes a future
	// misclassification fixable from stored rows.
	if og.Detail == "" {
		t.Fatal("Detail is empty; ESPN's own label must be preserved")
	}

	// And the ordinary goals must NOT be swept up by the own-goal branch.
	if len(goals) != 3 {
		t.Fatalf("ordinary goals = %d, want 3", len(goals))
	}
	for _, g := range goals {
		if g.TeamSourceID != "17362" {
			t.Fatalf("goal by %s attributed to %q, want 17362", g.PlayerName, g.TeamSourceID)
		}
	}
}

// The classifier keys on type.type, not on the English label, because the label
// is locale-dependent prose and the machine value is not. A fixture cannot
// prove that on its own, so assert it directly.
func TestOwnGoalIsClassifiedFromTheMachineValue(t *testing.T) {
	raw := []byte(`{"keyEvents":[{
	  "type":{"id":"97","text":"Gol en propia puerta","type":"own-goal"},
	  "scoringPlay":true,"team":{"id":"226"},
	  "clock":{"displayValue":"32'"},
	  "participants":[{"athlete":{"id":"1","displayName":"Defender"}}]}]}`)
	part, err := MapParticipation(raw, "17362", "226")
	if err != nil {
		t.Fatal(err)
	}
	if len(part.Events) != 1 || part.Events[0].Type != PlayerEventOwnGoal {
		t.Fatalf("events = %#v, want one own_goal classified from type.type despite "+
			"non-English display text", part.Events)
	}
}
```

- [ ] **Step 4: Run**

```bash
cd backend && go test ./shared/espn/ -run "OwnGoal" -v
```

Expected: both cases `--- PASS`. If `TestMapParticipationClassifiesARealOwnGoal` fails on
the team id, **do not "fix" it by re-attributing the goal to the other side** — read the
Step 2 output again. ESPN's convention is the beneficiary, the TypeScript side keeps it,
and the `(OG)` suffix is how the UI makes it legible rather than by moving the goal.

If it fails because the event was classified as an ordinary `goal`, the
`strings.Contains(kind, "own")` branch is being shadowed by the `e.ScoringPlay` case
above it — check the ordering in `mapPlayerEvents`, since an own goal is *also* a scoring
play and the switch is first-match-wins.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/espn/testdata/espn-summary-own-goal.json \
        backend/shared/espn/participation_test.go
git commit -m "test: cover the own-goal branch against a real own goal

mapPlayerEvents classified own goals with strings.Contains(kind, \"own\")
and its own comment admitted no own goal appeared in any recorded fixture.
That branch decides which TEAM a goal belongs to, so an untested guess is
a wrong scoreline.

Uses the same match E0 records on the TypeScript side (Leagues Cup
401863609): the 32' own goal is credited to Atlante with Minnesota's Devin
Padelford named. The two paths must agree or the same event reports
differently depending on which served it.

Also asserts the classification keys on type.type rather than the English
label, which is locale-dependent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Doc, gate, and a real run

- [ ] **Step 1: Update the architecture doc**

In `docs/backend/ARCHITECTURE.md`, replace the `appearance` bullet under `### Tier 1`:

```markdown
- **appearance**(PK (match_id→match, player_id→player), team_id→team, starter, shirt_number, position, **goals, assists, shots, shots_on_target, offsides, fouls_committed, fouls_suffered, own_goals, yellow_cards, red_cards, saves, goals_conceded, shots_faced**) — who was in the squad, **including substitutes**, and what they did. The box-score columns come from `rosters[].roster[].stats[]` on the summary the ingester already fetches (T7.7) and are **all nullable**: ESPN's stat set varies by position — a goalkeeper's row has no `offsides` entry, an outfielder's has no `saves` — so `NULL` means "not measured" and `0` means "measured as zero". They are upserted with `COALESCE` so a poll that omits the stats block cannot erase an earlier one. `own_goals` here counts own goals the player put into their own net, which is a *different attribution* from `match_event`, where ESPN credits the own goal to the team that benefits and names the opposition player.
```

- [ ] **Step 2: Full gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok`, vet silent.

- [ ] **Step 3: Prove it against a real finished match**

```bash
cd backend
docker run -d --name scorearc-box -e POSTGRES_PASSWORD=postgres -p 55434:5432 postgres:16-alpine
sleep 5
for f in migrations/*.up.sql; do docker exec -i scorearc-box psql -U postgres -q < "$f"; done
docker exec -i scorearc-box psql -U postgres -q <<'SQL'
CREATE ROLE ingest_local LOGIN PASSWORD 'ingest_local';
GRANT ingest_local TO postgres;
GRANT scorearc_ingester TO ingest_local;
GRANT USAGE ON SCHEMA public TO ingest_local;
SQL
export POOLED_DSN='postgres://ingest_local:ingest_local@localhost:55434/postgres?sslmode=disable'
export INGESTER_LEASE_DSN="$POOLED_DSN"
go run ./ingester -once

docker exec -i scorearc-box psql -U postgres -q <<'SQL'
SELECT
  count(*)                                        AS appearances,
  count(goals)                                    AS with_goals,
  count(saves)                                    AS with_saves,
  count(offsides)                                 AS with_offsides,
  count(*) FILTER (WHERE position = 'G')          AS keepers,
  count(offsides) FILTER (WHERE position = 'G')   AS keepers_with_offsides
FROM appearance;
SQL
docker rm -f scorearc-box
```

Expected: `appearances` in the hundreds; `with_goals` close to `appearances` (every
position reports `totalGoals`); `with_saves` **much smaller** than `appearances`; and —
the assertion that matters — **`keepers_with_offsides` is `0`** while `keepers` is not.
If `keepers_with_offsides` equals `keepers`, something is writing a default zero and
Task 2's `mapPlayerStats` is not returning nil for absent names.

- [ ] **Step 4: Open the PR**

```bash
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: appearance now carries the per-match box score

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/ingester-box-score
gh pr create --title "feat: persist the per-match player box score (T7.7)" --body "$(cat <<'EOF'
## What

Every player's per-match numbers — goals, assists, shots, shots on target, offsides,
fouls committed and suffered, own goals, cards, saves, goals conceded, shots faced — now
land on the `appearance` row that `feat/player-identity` already writes.

**No new endpoint and no new request.** `rosters[].roster[].stats[]` is on every match
summary the ingester already fetches, and `mapSquad` was walking straight past it.

## The rule this PR is built around

**The stat set varies by position, so a stat the provider does not send is `NULL`, never
`0`.** Verified in `shared/espn/testdata/espn-summary.json`: a goalkeeper's row carries
`saves`, `goalsConceded` and `shotsFaced` and **no `offsides`**; an outfielder's carries
`offsides` and **no `saves`**.

A `NOT NULL DEFAULT 0` column would record "the keeper was onside all match" and "the
centre-back made no saves" as measurements, and T7.4's per-position percentiles would then
average those inventions. Every column is nullable, every model field is a pointer, and
there is a real-database assertion that goalkeepers have zero non-null `offsides`.

## Other decisions worth reviewing

- **Lookup is by `stats[].name`, never by index.** The array order is ESPN's and an index
  read mis-attributes *silently* — three goals reported as three yellow cards, with nothing
  anywhere to notice.
- **`COALESCE` on every stat in the upsert.** A live match is polled every 20 seconds and a
  poll that returns a roster with no stats block would otherwise erase numbers an earlier
  poll established. Same absence-of-evidence rule `WriteParticipation` already applies to
  an empty payload.
- **`appearances` and `subIns` are deliberately not stored.** The first is always `1` on a
  row that exists; the second is derivable from `starter` plus the `sub_on` rows. A third
  copy only gives the three something to disagree about.
- **`own_goals` here is a different attribution from `match_event`.** This column counts
  own goals *this player* put into their own net. `match_event` follows ESPN's convention:
  credited to the team that *benefits*, with the opposition player named. Both are correct;
  a comment in the migration and the model says so, so nobody "reconciles" them.
- **No new grant.** `appearance` is already `INSERT, UPDATE` for `scorearc_ingester`, and
  the existing `TestWriteParticipationAsTheIngesterRole` now covers the new columns.

## Parity

E1's T1.3 reads the same array on the TypeScript side. The ESPN-name → field mapping is
documented in `model.PlayerMatchStats` and must match `PlayerMatchStats` in
`src/server/data/types.ts`, for the same reason the own-goal rule must: otherwise the same
match reports different numbers depending on which path served it.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Mapper: per-position nils against the recorded fixture; a deliberately shuffled stats
  array that an index-based read would fail; absent array → nil; fractional and negative
  values → nil without discarding the rest of the row.
- Store: measured zero survives as zero, unmeasured stays NULL, a climbing live score
  updates, and a statless poll does not erase.
- `go run ./ingester -once` against a scratch Postgres as the least-privilege login:
  `count(offsides) FILTER (WHERE position = 'G')` is `0`.

Plan: `docs/superpowers/plans/2026-08-15-ingester-box-score.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **Coverage.** The position-varying stat set is asserted three times, in three places
  that fail for different reasons: the migration test (no `NOT NULL`/`DEFAULT 0`), the
  mapper test (nil for absent names, against the real fixture), and the real-run query
  (`keepers_with_offsides = 0`). One of those alone would be a rule; three is a rule that
  survives a refactor.
- **Naming consistency.** The thirteen names are fixed in Task 1 Step 3 (SQL), Task 2
  Step 3 (`PlayerMatchStats`, with the ESPN name in a trailing comment on each field),
  Task 2 Step 5 (`targets` map), and Task 3 Step 3 (`boxScoreArgs`, in the same order as
  the INSERT). If you add a fourteenth stat, all four change.
- **Ordering hazard.** `boxScoreArgs` returns a positional slice appended to six fixed
  arguments. Its order **must** match the INSERT's column list. That coupling is why the
  slice and the column list are adjacent in the same file and why the comment on
  `boxScoreArgs` says so — do not sort either list alphabetically afterwards.
- **What this deliberately does not do.** No minutes played (the payload has no
  substitution clock beyond the `sub_on`/`sub_off` events already stored), no xG and no
  shot coordinates — neither exists anywhere in any response we can reach, per the
  roadmap's "Not building, and why".
</content>
