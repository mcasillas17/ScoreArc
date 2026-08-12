# Canonical Identity + Source Crosswalk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.
>
> **Executing without Superpowers?** This is a plain TDD checklist. Work top-to-bottom, run
> each step's command, confirm its `expect:`, and commit at each task's commit step. Ignore
> the header above.

**Goal:** Make ScoreArc own its entity ids — canonical `competition`/`season`/`team`/
`player`/`match` keyed by ids we mint — with a per-source crosswalk so ESPN becomes one
contributing source rather than the identity authority.

**Architecture:** Slugs for curated sets (`premier-league`, `eng-manchester-united`),
UUIDv7 for machine-generated sets (match, player). Per-entity `*_external_ref` tables map
`(source, source_id) → canonical_id` with real foreign keys. A `match` natural-key unique
constraint on `(competition, season, home, away, kickoff_date)` makes match identity
deterministic across sources. A new `Resolver` sits between the existing `source` and
`store` layers; the ESPN mappers are not restructured.

**Tech Stack:** Go 1.26, pgx/v5, google/uuid, golang-migrate, testcontainers, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-08-12-canonical-identity-design.md`

---

## Branch setup

`main` auto-deploys. Do all work on a feature branch.

- [ ] **Step 1: Branch**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git checkout main && git pull --ff-only
git checkout -b feat/canonical-identity-impl
```

`expect:` `Switched to a new branch 'feat/canonical-identity-impl'`

- [ ] **Step 2: Confirm the test environment**

Testcontainers needs the Colima socket exported. Every `go test` command in this plan
assumes these are set in your shell:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
docker info >/dev/null && echo "docker ok"
```

`expect:` `docker ok`. If you use Docker Desktop instead of Colima, unset both variables.

---

## File structure

| File | Responsibility |
|---|---|
| `backend/migrations/0001_init.up.sql` | **Rewritten.** Canonical entities, crosswalks, carried-over tables, roles, grants, triggers |
| `backend/migrations/0002_snapshots.up.sql` | **Rewritten.** Snapshot tables re-keyed to canonical ids |
| `backend/migrations/0003_*`, `0004_*` | **Deleted.** Folded into 0001 |
| `backend/config/teams.seed.json` | Authored team registry (id, kind, name, abbr, country, per-source refs) |
| `backend/config/teams.go` | Embeds + parses + validates the seed |
| `backend/shared/store/identity.go` | `Resolver`: crosswalk lookups, provisional creation, natural-key match resolution |
| `backend/shared/store/seed.go` | Applies the seed into `team` + `team_external_ref` at startup |
| `backend/cmd/seed-teams/main.go` | One-time bootstrap that proposes `teams.seed.json` from live ESPN |
| `backend/shared/store/matches.go` | **Modified.** Writes canonical ids |
| `backend/ingester/*.go` | **Modified.** Resolves before writing |
| `backend/reader/store.go` | **Modified.** Scans `uuid` match ids |

The resolver lives in `shared/store` rather than a new package: it queries the crosswalk
tables, so it is a persistence concern, and this avoids both a second connection pool and
a circular dependency between `store` and a `resolve` package. It gets its own file so the
package stays navigable.

---

### Task 1: Canonical schema migration

**Files:**
- Modify: `backend/migrations/0001_init.up.sql` (full rewrite)
- Modify: `backend/migrations/0001_init.down.sql` (full rewrite)
- Modify: `backend/migrations/0002_snapshots.up.sql`, `0002_snapshots.down.sql`
- Delete: `backend/migrations/0003_ingester_delete_grant.{up,down}.sql`
- Delete: `backend/migrations/0004_ingester_hardening.{up,down}.sql`
- Modify: `backend/migrations/migrations_test.go`

- [ ] **Step 1: Write the failing migration-content test**

Replace the entire contents of `backend/migrations/migrations_test.go` with:

```go
package migrations

import (
	"os"
	"strings"
	"testing"
)

func readMigration(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The canonical schema must key every entity on ids we mint, expose a
// per-source crosswalk with real foreign keys, and keep the hardening that
// used to live in 0004.
func TestInitDefinesCanonicalSchema(t *testing.T) {
	sql := readMigration(t, "0001_init.up.sql")
	for _, required := range []string{
		"CREATE TABLE competition",
		"CREATE TABLE season",
		"CREATE TABLE team",
		"CREATE TABLE player",
		"CREATE TABLE match",
		"CREATE TABLE team_external_ref",
		"CREATE TABLE player_external_ref",
		"CREATE TABLE match_external_ref",
		"CREATE TABLE competition_external_ref",
		// The natural key that makes match identity deterministic.
		"UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)",
		"kickoff_date date GENERATED ALWAYS AS",
		"provisional",
		// Hardening folded in from the old 0004.
		"protect_match_history",
		"protect_finalized_detail",
		"match_unfinalized_idx",
		"ingest_run_started_idx",
		// Least-privilege roles and grants, folded in from 0001/0003/0004.
		"CREATE ROLE scorearc_reader",
		"CREATE ROLE scorearc_ingester",
		"GRANT DELETE ON standing, top_scorer TO scorearc_ingester",
		"GRANT DELETE ON ingest_run TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0001_init.up.sql missing %q", required)
		}
	}
}

// No table may use a provider id as its primary key.
func TestInitDoesNotKeyOnProviderIDs(t *testing.T) {
	sql := readMigration(t, "0001_init.up.sql")
	for _, forbidden := range []string{"espn_id", "espn_team_id", "espn_event_id"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("0001_init.up.sql leaks a provider id column %q", forbidden)
		}
	}
}

func TestSnapshotsUseCanonicalKeys(t *testing.T) {
	sql := readMigration(t, "0002_snapshots.up.sql")
	for _, required := range []string{
		"CREATE TABLE standing_snapshot",
		"CREATE TABLE win_prob_snapshot",
		"REFERENCES team(id)",
		"match_id  uuid",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0002_snapshots.up.sql missing %q", required)
		}
	}
}

func TestInitialRollbackRevokesDefaultPrivileges(t *testing.T) {
	sql := readMigration(t, "0001_init.down.sql")
	for _, required := range []string{
		"ALTER DEFAULT PRIVILEGES",
		"FROM scorearc_reader",
		"FROM scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}

// The superseded migrations must be gone, not left to be applied by accident.
func TestSupersededMigrationsRemoved(t *testing.T) {
	for _, gone := range []string{
		"0003_ingester_delete_grant.up.sql",
		"0004_ingester_hardening.up.sql",
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s should have been folded into 0001 and deleted", gone)
		}
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd backend && go test ./migrations/
```

`expect:` FAIL — `0001_init.up.sql missing "CREATE TABLE competition"`.

- [ ] **Step 3: Delete the superseded migrations**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc/backend
git rm migrations/0003_ingester_delete_grant.up.sql migrations/0003_ingester_delete_grant.down.sql
git rm migrations/0004_ingester_hardening.up.sql migrations/0004_ingester_hardening.down.sql
```

`expect:` four `rm` lines.

- [ ] **Step 4: Write the canonical schema**

Replace the entire contents of `backend/migrations/0001_init.up.sql` with:

```sql
-- ScoreArc canonical schema.
--
-- Every entity is keyed by an id ScoreArc mints: slugs for the curated sets
-- (competition, season, team) and UUIDv7 for the machine-generated sets
-- (player, match). Provider ids live ONLY in the *_external_ref crosswalk
-- tables, so no provider is the identity authority and several providers can
-- describe the same entity.

-- ---------- canonical entities ----------

CREATE TABLE competition (
  id         text PRIMARY KEY,                     -- 'premier-league'
  name       text NOT NULL,
  short_name text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('league','cup')),
  country    text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE season (
  competition_id text NOT NULL REFERENCES competition(id),
  id             text NOT NULL,                    -- '2026-27'
  label          text NOT NULL,
  has_bracket    bool NOT NULL DEFAULT false,
  PRIMARY KEY (competition_id, id)
);

CREATE TABLE team (
  id          text PRIMARY KEY,                    -- 'eng-manchester-united' | 'nat-mex' | 'prov-espn-360'
  kind        text NOT NULL CHECK (kind IN ('club','national')),
  name        text NOT NULL,
  short_name  text,
  abbr        text NOT NULL,
  country     text,
  crest_url   text,
  provisional bool NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Partial index: the review list for teams awaiting curation.
CREATE INDEX team_provisional_idx ON team (provisional) WHERE provisional;

CREATE TABLE player (
  id          uuid PRIMARY KEY,
  full_name   text NOT NULL,
  known_as    text,
  birth_date  date,
  nationality text,
  position    text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  id             uuid PRIMARY KEY,
  competition_id text NOT NULL,
  season_id      text NOT NULL,
  home_team_id   text NOT NULL REFERENCES team(id),
  away_team_id   text NOT NULL REFERENCES team(id),
  kickoff        timestamptz NOT NULL,
  -- Generated so two sources whose kickoff times differ by minutes still
  -- collide on the same natural key and resolve to one match.
  kickoff_date date GENERATED ALWAYS AS ((kickoff AT TIME ZONE 'UTC')::date) STORED,
  round            text,
  state            text NOT NULL,
  home_score       int,
  away_score       int,
  minute           text,
  status_detail    text NOT NULL DEFAULT '',
  status_name      text NOT NULL DEFAULT '',
  winner_id        text REFERENCES team(id),
  note             text,
  home_placeholder bool NOT NULL DEFAULT false,
  away_placeholder bool NOT NULL DEFAULT false,
  bracket_required bool,
  finalized_at     timestamptz,
  source           text NOT NULL,                  -- who last wrote these core facts
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id),
  UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)
);
CREATE INDEX match_comp_season_idx ON match (competition_id, season_id, kickoff);
CREATE INDEX match_state_idx       ON match (state);
CREATE INDEX match_unfinalized_idx
  ON match (competition_id, season_id, kickoff)
  WHERE state = 'finished' AND finalized_at IS NULL;

-- ---------- source crosswalk ----------
-- PRIMARY KEY (source, source_id) permits MANY source ids mapping to ONE
-- canonical entity, which is exactly what merging duplicates produces.

CREATE TABLE competition_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  competition_id text NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX competition_external_ref_target_idx ON competition_external_ref (competition_id);

CREATE TABLE team_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  team_id       text NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX team_external_ref_target_idx ON team_external_ref (team_id);

CREATE TABLE player_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  player_id     uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX player_external_ref_target_idx ON player_external_ref (player_id);

CREATE TABLE match_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  match_id      uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX match_external_ref_target_idx ON match_external_ref (match_id);

-- ---------- carried-over tables, re-keyed ----------

CREATE TABLE match_detail (
  match_id        uuid PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  scorers         jsonb NOT NULL DEFAULT '[]',
  cards           jsonb NOT NULL DEFAULT '[]',
  stats           jsonb,
  win_probability jsonb,
  shootout        jsonb,
  shootout_detail jsonb,
  lineups         jsonb,
  videos          jsonb NOT NULL DEFAULT '[]',
  info            jsonb,
  form            jsonb,
  h2h             jsonb NOT NULL DEFAULT '[]',
  commentary      jsonb NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE standing (
  competition_id  text NOT NULL,
  season_id       text NOT NULL,
  team_id         text NOT NULL REFERENCES team(id),
  group_id        text,
  group_name      text,
  rank            int  NOT NULL,
  played          int  NOT NULL DEFAULT 0,
  wins            int  NOT NULL DEFAULT 0,
  draws           int  NOT NULL DEFAULT 0,
  losses          int  NOT NULL DEFAULT 0,
  goals_for       int  NOT NULL DEFAULT 0,
  goals_against   int  NOT NULL DEFAULT 0,
  goal_difference int  NOT NULL DEFAULT 0,
  points          int  NOT NULL DEFAULT 0,
  advanced        bool NOT NULL DEFAULT false,
  source          text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season_id, team_id),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);

CREATE TABLE top_scorer (
  competition_id text NOT NULL,
  season_id      text NOT NULL,
  rank           int  NOT NULL,
  player         text NOT NULL,
  team_abbr      text,               -- ESPN stats give no team id here, so
  team_name      text,               -- these stay denormalised
  team_crest_url text,
  goals          int  NOT NULL,
  matches        int,
  source         text NOT NULL,
  PRIMARY KEY (competition_id, season_id, rank),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id)
);

CREATE TABLE ingest_run (
  id          bigserial PRIMARY KEY,
  comp_id     text,
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          bool,
  error       text
);
CREATE INDEX ingest_run_started_idx ON ingest_run (started_at);

-- ---------- protection triggers ----------

CREATE FUNCTION scorearc_protect_match_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.state = 'live' AND NEW.state = 'scheduled'
     AND NEW.status_name NOT IN ('STATUS_POSTPONED', 'STATUS_SUSPENDED'))
     OR (OLD.state = 'finished' AND NEW.state <> 'finished') THEN
    RAISE EXCEPTION 'match state cannot regress';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'finalized match history is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER protect_match_history
BEFORE UPDATE ON match
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_match_history();

CREATE FUNCTION scorearc_protect_finalized_detail() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM match WHERE id = OLD.match_id AND finalized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'finalized match detail is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER protect_finalized_detail
BEFORE UPDATE ON match_detail
FOR EACH ROW EXECUTE FUNCTION scorearc_protect_finalized_detail();

-- ---------- least-privilege roles ----------

CREATE ROLE scorearc_reader;
CREATE ROLE scorearc_ingester;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO scorearc_ingester;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO scorearc_ingester;
-- Replacement writes need DELETE on exactly these tables and no others.
GRANT DELETE ON standing, top_scorer TO scorearc_ingester;
GRANT DELETE ON ingest_run TO scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO scorearc_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO scorearc_ingester;
```

- [ ] **Step 5: Write the rollback**

Replace the entire contents of `backend/migrations/0001_init.down.sql` with:

```sql
DROP TRIGGER IF EXISTS protect_finalized_detail ON match_detail;
DROP TRIGGER IF EXISTS protect_match_history ON match;
DROP FUNCTION IF EXISTS scorearc_protect_finalized_detail();
DROP FUNCTION IF EXISTS scorearc_protect_match_history();

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM scorearc_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM scorearc_ingester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE ON SEQUENCES FROM scorearc_ingester;

DROP TABLE IF EXISTS ingest_run;
DROP TABLE IF EXISTS top_scorer;
DROP TABLE IF EXISTS standing;
DROP TABLE IF EXISTS match_detail;
DROP TABLE IF EXISTS match_external_ref;
DROP TABLE IF EXISTS player_external_ref;
DROP TABLE IF EXISTS team_external_ref;
DROP TABLE IF EXISTS competition_external_ref;
DROP TABLE IF EXISTS match;
DROP TABLE IF EXISTS player;
DROP TABLE IF EXISTS team;
DROP TABLE IF EXISTS season;
DROP TABLE IF EXISTS competition;

DROP ROLE IF EXISTS scorearc_ingester;
DROP ROLE IF EXISTS scorearc_reader;
```

- [ ] **Step 6: Re-key the snapshot tables**

Replace the entire contents of `backend/migrations/0002_snapshots.up.sql` with:

```sql
CREATE TABLE standing_snapshot (
  id              bigserial PRIMARY KEY,
  competition_id  text NOT NULL,
  season_id       text NOT NULL,
  team_id         text NOT NULL REFERENCES team(id),
  captured_at     timestamptz NOT NULL,
  rank            int NOT NULL,
  points          int NOT NULL,
  goal_difference int NOT NULL,
  played          int NOT NULL
);
CREATE INDEX standing_snapshot_key_idx
  ON standing_snapshot (competition_id, season_id, captured_at);

CREATE TABLE win_prob_snapshot (
  id          bigserial PRIMARY KEY,
  match_id  uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL,
  home numeric(5,2) NOT NULL,
  draw numeric(5,2) NOT NULL,
  away numeric(5,2) NOT NULL
);
CREATE INDEX win_prob_snapshot_match_idx ON win_prob_snapshot (match_id, captured_at);
```

And `backend/migrations/0002_snapshots.down.sql` with:

```sql
DROP TABLE IF EXISTS win_prob_snapshot;
DROP TABLE IF EXISTS standing_snapshot;
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd backend && go test ./migrations/
```

`expect:` `ok  github.com/mcasillas17/scorearc-backend/migrations`

- [ ] **Step 8: Verify the schema actually applies to a real Postgres**

This catches SQL errors the string tests cannot. `migrations_integration_test.go` in the
reader package already applies every migration against a testcontainer.

```bash
cd backend && go test ./reader/ -run TestMigrationsRoundTrip -v 2>&1 | tail -20
```

`expect:` `--- PASS: TestMigrationsRoundTrip`. If it fails with a SQL error, fix the DDL
before continuing — everything downstream assumes this schema applies cleanly.

- [ ] **Step 9: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/migrations/
git commit -m "feat(db)!: canonical schema with per-source crosswalk

Every entity is now keyed by an id ScoreArc mints; provider ids live only in
the *_external_ref tables. match gains a natural-key unique constraint on
(competition, season, home, away, kickoff_date) so the same fixture from a
second source resolves to one row instead of duplicating.

Folds the old 0003 and 0004 into 0001 — nothing is deployed and the database
does not exist, so there is no history worth preserving.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 2: Team seed format and loader

**Files:**
- Create: `backend/config/teams.seed.json`
- Create: `backend/config/teams.go`
- Create: `backend/config/teams_test.go`

- [ ] **Step 1: Write the failing test**

Create `backend/config/teams_test.go`:

```go
package config

import "testing"

func TestLoadTeamsSeedIsValid(t *testing.T) {
	seed, err := LoadTeams()
	if err != nil {
		t.Fatalf("LoadTeams: %v", err)
	}
	if len(seed) == 0 {
		t.Fatal("team seed is empty")
	}

	slugs := map[string]struct{}{}
	refs := map[string]string{} // "source\x00sourceID" -> slug
	for _, team := range seed {
		if team.ID == "" || team.Name == "" || team.Abbr == "" {
			t.Fatalf("team %+v has incomplete identity", team)
		}
		if team.Kind != "club" && team.Kind != "national" {
			t.Fatalf("team %q has illegal kind %q", team.ID, team.Kind)
		}
		if _, dup := slugs[team.ID]; dup {
			t.Fatalf("duplicate team slug %q", team.ID)
		}
		slugs[team.ID] = struct{}{}

		if len(team.Refs) == 0 {
			t.Fatalf("team %q has no source refs, so nothing can resolve to it", team.ID)
		}
		for source, sourceID := range team.Refs {
			key := source + "\x00" + sourceID
			if existing, dup := refs[key]; dup {
				t.Fatalf("source ref %s/%s maps to both %q and %q",
					source, sourceID, existing, team.ID)
			}
			refs[key] = team.ID
		}
	}
}

func TestLoadTeamsRejectsDuplicateSourceRefs(t *testing.T) {
	raw := []byte(`[
		{"id":"a","kind":"club","name":"A","abbr":"A","refs":{"espn":"1"}},
		{"id":"b","kind":"club","name":"B","abbr":"B","refs":{"espn":"1"}}
	]`)
	if _, err := parseTeams(raw); err == nil {
		t.Fatal("expected duplicate source ref to be rejected")
	}
}

func TestLoadTeamsRejectsIllegalKind(t *testing.T) {
	raw := []byte(`[{"id":"a","kind":"franchise","name":"A","abbr":"A","refs":{"espn":"1"}}]`)
	if _, err := parseTeams(raw); err == nil {
		t.Fatal("expected illegal kind to be rejected")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd backend && go test ./config/ -run TestLoadTeams
```

`expect:` FAIL — `undefined: LoadTeams`.

- [ ] **Step 3: Create a minimal seed file**

Create `backend/config/teams.seed.json`. This is a **hand-authored, reviewed** registry —
unlike `competitions.json`, which is generated and must never be hand-edited. Task 3 adds a
command that proposes the full contents; start with two rows so the loader can be built and
tested now:

```json
[
  {
    "id": "nat-mex",
    "kind": "national",
    "name": "Mexico",
    "shortName": "Mexico",
    "abbr": "MEX",
    "country": "mex",
    "refs": { "espn": "203" }
  },
  {
    "id": "mex-cruz-azul",
    "kind": "club",
    "name": "Cruz Azul",
    "shortName": "Cruz Azul",
    "abbr": "CAZ",
    "country": "mex",
    "refs": { "espn": "230" }
  }
]
```

> The two `espn` ids above are placeholders for bootstrapping only. Task 3's command
> replaces this whole file with real values pulled from ESPN, and Task 3 Step 6 verifies
> them. Do not ship these.

- [ ] **Step 4: Write the loader**

Create `backend/config/teams.go`:

```go
package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed teams.seed.json
var rawTeams []byte

// SeedTeam is one row of the authored team registry. Refs maps a source name
// ("espn") to that source's id for this team, which is what the crosswalk is
// populated from. A team with no refs can never be resolved, so it is rejected.
type SeedTeam struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Name      string            `json:"name"`
	ShortName string            `json:"shortName"`
	Abbr      string            `json:"abbr"`
	Country   string            `json:"country"`
	CrestURL  *string           `json:"crestUrl"`
	Refs      map[string]string `json:"refs"`
}

// LoadTeams parses the embedded, validated team seed.
func LoadTeams() ([]SeedTeam, error) { return parseTeams(rawTeams) }

func parseTeams(input []byte) ([]SeedTeam, error) {
	var teams []SeedTeam
	if err := json.Unmarshal(input, &teams); err != nil {
		return nil, fmt.Errorf("parse teams.seed.json: %w", err)
	}
	if len(teams) == 0 {
		return nil, fmt.Errorf("team seed is empty")
	}
	slugs := make(map[string]struct{}, len(teams))
	refs := make(map[string]string, len(teams))
	for _, team := range teams {
		if team.ID == "" || team.Name == "" || team.Abbr == "" {
			return nil, fmt.Errorf("team %q has incomplete identity", team.ID)
		}
		if team.Kind != "club" && team.Kind != "national" {
			return nil, fmt.Errorf("team %q has illegal kind %q", team.ID, team.Kind)
		}
		if _, exists := slugs[team.ID]; exists {
			return nil, fmt.Errorf("duplicate team slug %q", team.ID)
		}
		slugs[team.ID] = struct{}{}
		if len(team.Refs) == 0 {
			return nil, fmt.Errorf("team %q has no source refs", team.ID)
		}
		for source, sourceID := range team.Refs {
			if source == "" || sourceID == "" {
				return nil, fmt.Errorf("team %q has an empty source ref", team.ID)
			}
			key := source + "\x00" + sourceID
			if existing, exists := refs[key]; exists {
				return nil, fmt.Errorf(
					"source ref %s/%s maps to both %q and %q", source, sourceID, existing, team.ID)
			}
			refs[key] = team.ID
		}
	}
	return teams, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && go test ./config/
```

`expect:` `ok  github.com/mcasillas17/scorearc-backend/config`

- [ ] **Step 6: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/config/teams.seed.json backend/config/teams.go backend/config/teams_test.go
git commit -m "feat(config): authored team seed with per-source refs

teams.seed.json is hand-authored and reviewed, unlike the generated
competitions.json. Validation rejects duplicate slugs, duplicate source refs,
illegal kinds, and teams with no refs (which could never be resolved).

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 3: Bootstrap command for the seed

**Files:**
- Create: `backend/cmd/seed-teams/main.go`

- [ ] **Step 1: Write the command**

Create `backend/cmd/seed-teams/main.go`:

```go
// Command seed-teams proposes backend/config/teams.seed.json from live ESPN.
// It is a ONE-TIME bootstrap plus an occasional top-up: it prints JSON to
// stdout for a human to review and commit. It never writes the file itself,
// because the seed is the curated identity spine and must not change without
// review.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// slugify renders a display name as a url-safe slug: "Manchester United" ->
// "manchester-united".
func slugify(name string) string {
	lowered := strings.ToLower(strings.TrimSpace(name))
	return strings.Trim(nonSlug.ReplaceAllString(lowered, "-"), "-")
}

// countryPrefix derives a namespace from the ESPN competition slug, so two
// clubs with the same name in different countries cannot collide:
// "eng.1" -> "eng", "concacaf.leagues.cup" -> "concacaf".
func countryPrefix(espnSlug string) string {
	parts := strings.Split(espnSlug, ".")
	if len(parts) == 0 || parts[0] == "" {
		return "x"
	}
	return parts[0]
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "seed-teams:", err)
		os.Exit(1)
	}
}

func run() error {
	registry, err := config.Load()
	if err != nil {
		return err
	}
	src := source.NewESPN(espn.New())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Keyed by ESPN team id so a club appearing in two competitions (e.g. a
	// Liga MX side also in Leagues Cup) is collected exactly once.
	seen := map[string]config.SeedTeam{}

	for _, comp := range registry.List() {
		season, ok := comp.Seasons[comp.CurrentSeasonId]
		if !ok {
			continue
		}
		kind := "club"
		if comp.ESPNSlug == "fifa.world" {
			kind = "national"
		}
		prefix := countryPrefix(comp.ESPNSlug)

		var teams []model.Team
		matches, err := src.Scoreboard(ctx, comp, season, true)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warn: scoreboard %s: %v\n", comp.ID, err)
		}
		for _, match := range matches {
			teams = append(teams, match.Home, match.Away)
		}
		standings, err := src.Standings(ctx, comp, season)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warn: standings %s: %v\n", comp.ID, err)
		}
		for _, standing := range standings {
			teams = append(teams, standing.Team)
		}

		for _, team := range teams {
			if team.ID == "" || team.Name == "" {
				continue
			}
			if _, exists := seen[team.ID]; exists {
				continue
			}
			slug := prefix + "-" + slugify(team.Name)
			if kind == "national" {
				slug = "nat-" + strings.ToLower(team.Abbr)
			}
			seen[team.ID] = config.SeedTeam{
				ID:        slug,
				Kind:      kind,
				Name:      team.Name,
				ShortName: team.Name,
				Abbr:      team.Abbr,
				Country:   prefix,
				Refs:      map[string]string{"espn": team.ID},
			}
		}
	}

	out := make([]config.SeedTeam, 0, len(seen))
	for _, team := range seen {
		out = append(out, team)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })

	// Slug collisions must be resolved by a human, not silently renamed.
	slugs := map[string]string{}
	for _, team := range out {
		if existing, dup := slugs[team.ID]; dup {
			fmt.Fprintf(os.Stderr,
				"COLLISION: slug %q proposed for espn:%s and espn:%s — disambiguate by hand\n",
				team.ID, existing, team.Refs["espn"])
		}
		slugs[team.ID] = team.Refs["espn"]
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(out)
}
```

- [ ] **Step 2: Build it**

```bash
cd backend && go build ./cmd/seed-teams
```

`expect:` no output, exit 0.

- [ ] **Step 3: Generate the proposed seed**

```bash
cd backend && go run ./cmd/seed-teams > /tmp/teams.seed.json
```

`expect:` a JSON array on stdout and possibly `warn:` lines on stderr for competitions
whose season has not started. Any `COLLISION:` line must be resolved by hand before
continuing.

- [ ] **Step 4: Sanity-check the output**

```bash
python3 -c "
import json
d=json.load(open('/tmp/teams.seed.json'))
print('teams:', len(d))
print('kinds:', {t['kind'] for t in d})
print('sample:', d[0])
assert len({t['id'] for t in d}) == len(d), 'duplicate slugs'
assert all(t['refs'].get('espn') for t in d), 'missing espn ref'
print('OK')
"
```

`expect:` `teams:` a number in the low hundreds, `kinds: {'club', 'national'}`, and `OK`.

- [ ] **Step 5: Install and review the seed**

```bash
cp /tmp/teams.seed.json backend/config/teams.seed.json
```

Read the file. Fix any slug that reads badly (abbreviations, punctuation, duplicated
country prefixes). This is the curation step and it is the point of the whole task.

- [ ] **Step 6: Verify the real seed passes validation**

```bash
cd backend && go test ./config/
```

`expect:` `ok  github.com/mcasillas17/scorearc-backend/config`

- [ ] **Step 7: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/cmd/seed-teams/main.go backend/config/teams.seed.json
git commit -m "feat(config): bootstrap command for the team seed

Proposes teams.seed.json from live ESPN across every configured competition,
keyed by ESPN team id so a club in two competitions is collected once. Prints
to stdout rather than writing the file: the seed is the curated identity spine
and changes to it are reviewed, not generated in place.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 4: Apply the seed into the database

**Files:**
- Create: `backend/shared/store/seed.go`
- Create: `backend/shared/store/seed_integration_test.go`

- [ ] **Step 1: Write the failing integration test**

Create `backend/shared/store/seed_integration_test.go`:

```go
package store

import (
	"context"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
)

func TestApplyTeamSeedIsIdempotent(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	seed := []config.SeedTeam{
		{ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
		{ID: "nat-mex", Kind: "national", Name: "Mexico", Abbr: "MEX",
			Country: "mex", Refs: map[string]string{"espn": "203"}},
	}

	for range 2 { // applying twice must not duplicate or error
		if err := store.ApplyTeamSeed(ctx, seed); err != nil {
			t.Fatalf("ApplyTeamSeed: %v", err)
		}
	}

	var teams, refs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team`).Scan(&teams); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team_external_ref`).Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if teams != 2 || refs != 2 {
		t.Fatalf("teams=%d refs=%d, want 2 and 2 after two applies", teams, refs)
	}

	// The seed must never mark a curated team provisional.
	var provisional bool
	if err := pool.QueryRow(ctx,
		`SELECT provisional FROM team WHERE id='eng-arsenal'`).Scan(&provisional); err != nil {
		t.Fatal(err)
	}
	if provisional {
		t.Fatal("seeded team was marked provisional")
	}

	// Re-seeding must refresh mutable fields.
	seed[0].Name = "Arsenal FC"
	if err := store.ApplyTeamSeed(ctx, seed); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := pool.QueryRow(ctx,
		`SELECT name FROM team WHERE id='eng-arsenal'`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Arsenal FC" {
		t.Fatalf("name = %q, want the re-seeded value", name)
	}
}
```

> `newIntegrationStore(t)` does not exist in this package yet — Task 5 Step 1 creates it.
> Write this test now; it will not compile until then. That is expected and the next task
> resolves it.

- [ ] **Step 2: Write the implementation**

Create `backend/shared/store/seed.go`:

```go
package store

import (
	"context"

	"github.com/mcasillas17/scorearc-backend/config"
)

const teamSeedUpsertSQL = `
INSERT INTO team (id, kind, name, short_name, abbr, country, crest_url, provisional, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, false, now())
ON CONFLICT (id) DO UPDATE SET
	kind = EXCLUDED.kind,
	name = EXCLUDED.name,
	short_name = EXCLUDED.short_name,
	abbr = EXCLUDED.abbr,
	country = EXCLUDED.country,
	-- Never clobber a mirrored crest with a null from the seed.
	crest_url = COALESCE(EXCLUDED.crest_url, team.crest_url),
	-- Curating a team is exactly how a provisional row stops being provisional.
	provisional = false,
	updated_at = now()`

const teamRefUpsertSQL = `
INSERT INTO team_external_ref (source, source_id, team_id, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, now(), now())
ON CONFLICT (source, source_id) DO UPDATE SET
	team_id = EXCLUDED.team_id,
	last_seen_at = now()`

// ApplyTeamSeed writes the curated team registry and its source crosswalk
// rows. It is idempotent and runs at ingester startup, so curating a team in
// the seed file promotes any provisional row that already claimed its source
// ids.
func (s *Store) ApplyTeamSeed(ctx context.Context, seed []config.SeedTeam) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, team := range seed {
		if _, err := tx.Exec(ctx, teamSeedUpsertSQL,
			team.ID, team.Kind, team.Name, nullIfEmpty(team.ShortName),
			team.Abbr, nullIfEmpty(team.Country), team.CrestURL,
		); err != nil {
			return err
		}
		for source, sourceID := range team.Refs {
			if _, err := tx.Exec(ctx, teamRefUpsertSQL, source, sourceID, team.ID); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
```

- [ ] **Step 3: Defer running the test**

This test needs the harness from Task 5. Continue to Task 5, then run both together at
Task 5 Step 5.

- [ ] **Step 4: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/shared/store/seed.go backend/shared/store/seed_integration_test.go
git commit -m "feat(store): idempotent team seed application

Writes the curated registry and its crosswalk rows. Re-seeding promotes a
provisional team to curated, which is how a team that ESPN introduced between
curation passes gets adopted.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 5: Resolver — teams and competitions

**Files:**
- Create: `backend/shared/store/identity.go`
- Create: `backend/shared/store/identity_integration_test.go`

- [ ] **Step 1: Create the integration harness**

Create `backend/shared/store/identity_integration_test.go` with the harness plus the first
tests. The harness mirrors `reader/store_integration_test.go`'s pattern.

```go
package store

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// newIntegrationStore boots a throwaway Postgres, applies every migration in
// order, and returns a Store plus an admin pool for assertions.
func newIntegrationStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("scorearc"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = container.Terminate(ctx) })

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	files, err := filepath.Glob(filepath.Join("..", "..", "migrations", "*.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("apply %s: %v", filepath.Base(file), err)
		}
	}

	store, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store, pool
}

func mustSeed(t *testing.T, store *Store) {
	t.Helper()
	if err := store.ApplyTeamSeed(context.Background(), []config.SeedTeam{
		{ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestResolveTeamHitsTheCrosswalk(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	id, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"})
	if err != nil {
		t.Fatalf("Team: %v", err)
	}
	if id != "eng-arsenal" {
		t.Fatalf("resolved %q, want the curated slug eng-arsenal", id)
	}
}

func TestResolveTeamCreatesProvisionalOnMiss(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	id, err := store.Team(ctx, "espn", TeamRef{
		SourceID: "99999", Name: "Newly Promoted FC", Abbr: "NPF",
	})
	if err != nil {
		t.Fatalf("Team: %v", err)
	}
	if !strings.HasPrefix(id, "prov-espn-") {
		t.Fatalf("provisional id = %q, want a prov-espn- prefix", id)
	}

	var name string
	var provisional bool
	if err := pool.QueryRow(ctx,
		`SELECT name, provisional FROM team WHERE id=$1`, id).Scan(&name, &provisional); err != nil {
		t.Fatal(err)
	}
	// The provider's real name must be carried so the site still renders.
	if name != "Newly Promoted FC" || !provisional {
		t.Fatalf("name=%q provisional=%v, want the real name and provisional=true", name, provisional)
	}

	// Resolving the same unknown team again must reuse the row, not create another.
	again, err := store.Team(ctx, "espn", TeamRef{SourceID: "99999", Name: "Newly Promoted FC", Abbr: "NPF"})
	if err != nil {
		t.Fatal(err)
	}
	if again != id {
		t.Fatalf("second resolve = %q, want the same provisional id %q", again, id)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM team WHERE provisional`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("provisional teams = %d, want 1", count)
	}
}

func TestResolveTeamCachesLookups(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeed(t, store)

	if _, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"}); err != nil {
		t.Fatal(err)
	}
	// Deleting the crosswalk row proves the second lookup came from cache.
	if _, err := pool.Exec(ctx, `DELETE FROM team_external_ref WHERE source_id='359'`); err != nil {
		t.Fatal(err)
	}
	id, err := store.Team(ctx, "espn", TeamRef{SourceID: "359", Name: "Arsenal", Abbr: "ARS"})
	if err != nil {
		t.Fatalf("cached lookup failed: %v", err)
	}
	if id != "eng-arsenal" {
		t.Fatalf("cached resolve = %q, want eng-arsenal", id)
	}
}
```

The import block above already lists everything this file needs except the config package —
add `"github.com/mcasillas17/scorearc-backend/config"` to it.

- [ ] **Step 2: Run to confirm it fails**

```bash
cd backend && go test ./shared/store/ -run TestResolveTeam
```

`expect:` FAIL to compile — `store.Team undefined`, `TeamRef undefined`.

- [ ] **Step 3: Write the resolver**

Create `backend/shared/store/identity.go`:

```go
package store

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5"
)

// ErrUnknownCompetition means a source referenced a competition that is not in
// our configured registry. Competitions are a closed, configured set, so this
// is a configuration bug rather than upstream drift.
var ErrUnknownCompetition = errors.New("unknown competition for source")

// TeamRef is a provider-scoped team identity plus the hints needed to create a
// usable provisional row and to make the review list legible.
type TeamRef struct {
	SourceID string
	Name     string
	Abbr     string
	Kind     string // "club" | "national"; defaults to "club" when empty
}

// teamCache memoises crosswalk hits. The curated set is ~200 rows and every
// match resolves two teams, so this removes the dominant query load.
type identityCache struct {
	mu    sync.RWMutex
	teams map[string]string // "source\x00sourceID" -> canonical team id
}

func newIdentityCache() *identityCache {
	return &identityCache{teams: make(map[string]string)}
}

func (c *identityCache) get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	id, ok := c.teams[key]
	return id, ok
}

func (c *identityCache) put(key, id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.teams[key] = id
}

func cacheKey(source, sourceID string) string { return source + "\x00" + sourceID }

// Team resolves a provider team id to a canonical team id, creating a
// provisional team on a miss so ingestion never blocks on curation.
func (s *Store) Team(ctx context.Context, source string, ref TeamRef) (string, error) {
	if ref.SourceID == "" {
		return "", fmt.Errorf("team ref has no source id")
	}
	key := cacheKey(source, ref.SourceID)
	if id, ok := s.identity.get(key); ok {
		return id, nil
	}

	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var teamID string
	err := s.pool.QueryRow(opCtx,
		`SELECT team_id FROM team_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&teamID)
	if err == nil {
		s.identity.put(key, teamID)
		return teamID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	teamID, err = s.createProvisionalTeam(opCtx, source, ref)
	if err != nil {
		return "", err
	}
	s.identity.put(key, teamID)
	return teamID, nil
}

// createProvisionalTeam mints a deterministic slug for an uncurated team. The
// slug encodes the source and its id so the same unknown team always lands on
// the same row, and so the review list shows where it came from.
func (s *Store) createProvisionalTeam(ctx context.Context, source string, ref TeamRef) (string, error) {
	kind := ref.Kind
	if kind != "national" {
		kind = "club"
	}
	name := ref.Name
	if name == "" {
		name = "Unknown " + source + " team " + ref.SourceID
	}
	slug := fmt.Sprintf("prov-%s-%s", source, ref.SourceID)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
INSERT INTO team (id, kind, name, abbr, provisional, updated_at)
VALUES ($1, $2, $3, $4, true, now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
		slug, kind, name, ref.Abbr,
	); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, teamRefUpsertSQL, source, ref.SourceID, slug); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return slug, nil
}

// Competition resolves a provider competition id via the crosswalk. Unlike
// teams, a miss is an error: the set is closed and configured.
func (s *Store) Competition(ctx context.Context, source, sourceID string) (string, error) {
	opCtx, cancel := boundedContext(ctx)
	defer cancel()
	var id string
	err := s.pool.QueryRow(opCtx,
		`SELECT competition_id FROM competition_external_ref WHERE source=$1 AND source_id=$2`,
		source, sourceID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("%w: %s/%s", ErrUnknownCompetition, source, sourceID)
	}
	return id, err
}
```

- [ ] **Step 4: Add the cache to the Store**

Modify `backend/shared/store/store.go`. Change the struct:

```go
type Store struct {
	pool *pgxpool.Pool
}
```

to:

```go
type Store struct {
	pool     *pgxpool.Pool
	identity *identityCache
}
```

and in `New`, change the final return from:

```go
	return &Store{pool: pool}, nil
```

to:

```go
	return &Store{pool: pool, identity: newIdentityCache()}, nil
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && go test ./shared/store/ -run 'TestResolveTeam|TestApplyTeamSeed' -v 2>&1 | tail -20
```

`expect:` `--- PASS` for `TestApplyTeamSeedIsIdempotent`, `TestResolveTeamHitsTheCrosswalk`,
`TestResolveTeamCreatesProvisionalOnMiss`, and `TestResolveTeamCachesLookups`.

- [ ] **Step 6: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/shared/store/identity.go backend/shared/store/identity_integration_test.go backend/shared/store/store.go
git commit -m "feat(store): team and competition resolution through the crosswalk

Team misses create a provisional row carrying the provider's real name, so a
newly promoted club never blocks ingestion — curating it later is a rename and
merge inside our own system. Competition misses are errors, because that set is
closed and configured.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 6: Resolver — matches on the natural key

**Files:**
- Modify: `backend/shared/store/identity.go`
- Modify: `backend/shared/store/identity_integration_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/shared/store/identity_integration_test.go`:

```go
// The property this whole design exists to provide: the same fixture arriving
// from two different sources, with different provider ids and kickoff times
// minutes apart, must resolve to exactly ONE canonical match.
func TestResolveMatchIsDeterministicAcrossSources(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	first, err := store.Match(ctx, "espn", MatchRef{
		SourceID:      "401",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("first Match: %v", err)
	}

	// A different source, its own id, kickoff 15 minutes later.
	second, err := store.Match(ctx, "football-data-uk", MatchRef{
		SourceID:      "E0-2026-08-21-ARS-CHE",
		CompetitionID: "premier-league",
		SeasonID:      "2026-27",
		HomeTeamID:    "eng-arsenal",
		AwayTeamID:    "eng-chelsea",
		Kickoff:       time.Date(2026, 8, 21, 19, 15, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("second Match: %v", err)
	}

	if first != second {
		t.Fatalf("resolved to two matches (%s, %s), want one", first, second)
	}
	var matches, refs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_external_ref`).Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if matches != 1 || refs != 2 {
		t.Fatalf("matches=%d refs=%d, want 1 match with 2 source refs", matches, refs)
	}
}

// Reversing home and away is a DIFFERENT fixture (the return leg), so it must
// resolve to its own match.
func TestResolveMatchTreatsReversedLegsAsDistinct(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)

	kickoff := time.Date(2026, 8, 21, 19, 0, 0, 0, time.UTC)
	home, err := store.Match(ctx, "espn", MatchRef{
		SourceID: "401", CompetitionID: "premier-league", SeasonID: "2026-27",
		HomeTeamID: "eng-arsenal", AwayTeamID: "eng-chelsea", Kickoff: kickoff,
	})
	if err != nil {
		t.Fatal(err)
	}
	away, err := store.Match(ctx, "espn", MatchRef{
		SourceID: "402", CompetitionID: "premier-league", SeasonID: "2026-27",
		HomeTeamID: "eng-chelsea", AwayTeamID: "eng-arsenal", Kickoff: kickoff,
	})
	if err != nil {
		t.Fatal(err)
	}
	if home == away {
		t.Fatal("reversed legs collapsed into one match")
	}
	var matches int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 2 {
		t.Fatalf("matches = %d, want 2", matches)
	}
}

func mustSeedTwoTeams(t *testing.T, store *Store) {
	t.Helper()
	if err := store.ApplyTeamSeed(context.Background(), []config.SeedTeam{
		{ID: "eng-arsenal", Kind: "club", Name: "Arsenal", Abbr: "ARS",
			Country: "eng", Refs: map[string]string{"espn": "359"}},
		{ID: "eng-chelsea", Kind: "club", Name: "Chelsea", Abbr: "CHE",
			Country: "eng", Refs: map[string]string{"espn": "363"}},
	}); err != nil {
		t.Fatal(err)
	}
}

func mustSeedSeason(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
INSERT INTO competition (id, name, short_name, kind)
VALUES ('premier-league','Premier League','EPL','league')
ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO season (competition_id, id, label) VALUES ('premier-league','2026-27','2026-27')
ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
}
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd backend && go test ./shared/store/ -run TestResolveMatch
```

`expect:` FAIL to compile — `store.Match undefined`, `MatchRef undefined`.

- [ ] **Step 3: Write the implementation**

Append to `backend/shared/store/identity.go`:

```go
// MatchRef is a provider-scoped match identity. The canonical natural key is
// (competition, season, home, away, kickoff DATE) — deliberately date-grained,
// because sources routinely disagree on kickoff time by minutes.
type MatchRef struct {
	SourceID      string
	CompetitionID string
	SeasonID      string
	HomeTeamID    string
	AwayTeamID    string
	Kickoff       time.Time
}

// Match resolves a provider match to a canonical match id. On a crosswalk miss
// it upserts against the natural key, so a fixture already ingested from
// another source is adopted rather than duplicated.
func (s *Store) Match(ctx context.Context, source string, ref MatchRef) (uuid.UUID, error) {
	if ref.SourceID == "" {
		return uuid.Nil, fmt.Errorf("match ref has no source id")
	}
	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var matchID uuid.UUID
	err := s.pool.QueryRow(opCtx,
		`SELECT match_id FROM match_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&matchID)
	if err == nil {
		return matchID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}

	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(opCtx)

	// Adopt an existing match on the natural key if one is already there.
	err = tx.QueryRow(opCtx, `
SELECT id FROM match
WHERE competition_id=$1 AND season_id=$2 AND home_team_id=$3 AND away_team_id=$4
	AND kickoff_date=($5 AT TIME ZONE 'UTC')::date`,
		ref.CompetitionID, ref.SeasonID, ref.HomeTeamID, ref.AwayTeamID, ref.Kickoff,
	).Scan(&matchID)
	if errors.Is(err, pgx.ErrNoRows) {
		matchID, err = uuid.NewV7()
		if err != nil {
			return uuid.Nil, err
		}
		if _, err := tx.Exec(opCtx, `
INSERT INTO match (id, competition_id, season_id, home_team_id, away_team_id,
	kickoff, state, source, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,now())`,
			matchID, ref.CompetitionID, ref.SeasonID, ref.HomeTeamID, ref.AwayTeamID,
			ref.Kickoff, source,
		); err != nil {
			return uuid.Nil, err
		}
	} else if err != nil {
		return uuid.Nil, err
	}

	if _, err := tx.Exec(opCtx, `
INSERT INTO match_external_ref (source, source_id, match_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	match_id = EXCLUDED.match_id, last_seen_at = now()`,
		source, ref.SourceID, matchID,
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(opCtx); err != nil {
		return uuid.Nil, err
	}
	return matchID, nil
}
```

Add `"time"` and `"github.com/google/uuid"` to the import block in `identity.go`.

- [ ] **Step 4: Promote the uuid dependency**

`google/uuid` is currently an indirect dependency. Promote it:

```bash
cd backend && go get github.com/google/uuid@v1.6.0 && go mod tidy
grep -n "google/uuid" go.mod
```

`expect:` a `github.com/google/uuid v1.6.0` line **without** the `// indirect` comment.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && go test ./shared/store/ -run TestResolveMatch -v 2>&1 | tail -15
```

`expect:` `--- PASS: TestResolveMatchIsDeterministicAcrossSources` and
`--- PASS: TestResolveMatchTreatsReversedLegsAsDistinct`.

- [ ] **Step 6: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/shared/store/identity.go backend/shared/store/identity_integration_test.go backend/go.mod backend/go.sum
git commit -m "feat(store): deterministic match resolution on the natural key

A crosswalk miss adopts an existing match keyed on (competition, season, home,
away, kickoff DATE) rather than creating a duplicate. Date-grained on purpose:
sources routinely disagree on kickoff time by minutes. This is the property
that makes multi-source enrichment merge instead of fork.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 7: Resolver — players

**Files:**
- Modify: `backend/shared/store/identity.go`
- Modify: `backend/shared/store/identity_integration_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/shared/store/identity_integration_test.go`:

```go
func TestResolvePlayerCreatesOnceAndReuses(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	first, err := store.Player(ctx, "espn", PlayerRef{SourceID: "253989", FullName: "Erling Haaland"})
	if err != nil {
		t.Fatalf("Player: %v", err)
	}
	second, err := store.Player(ctx, "espn", PlayerRef{SourceID: "253989", FullName: "Erling Haaland"})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("same source player resolved to %s then %s", first, second)
	}

	var players int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player`).Scan(&players); err != nil {
		t.Fatal(err)
	}
	if players != 1 {
		t.Fatalf("players = %d, want 1", players)
	}

	// A different source id is a different player until cross-source merging
	// exists — it must NOT be guessed by name.
	other, err := store.Player(ctx, "statsbomb", PlayerRef{SourceID: "sb-1", FullName: "Erling Haaland"})
	if err != nil {
		t.Fatal(err)
	}
	if other == first {
		t.Fatal("players from different sources were merged by name; merging is out of scope")
	}
}

func TestResolvePlayerRequiresSourceID(t *testing.T) {
	store, _ := newIntegrationStore(t)
	if _, err := store.Player(context.Background(), "espn", PlayerRef{FullName: "No Id"}); err == nil {
		t.Fatal("expected an error when the player ref has no source id")
	}
}
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd backend && go test ./shared/store/ -run TestResolvePlayer
```

`expect:` FAIL to compile — `store.Player undefined`, `PlayerRef undefined`.

- [ ] **Step 3: Write the implementation**

Append to `backend/shared/store/identity.go`:

```go
// PlayerRef is a provider-scoped player identity. Cross-source merging (the
// same human from two providers) is deliberately NOT attempted here: names
// collide, change with accents, and follow transfers. Two sources yield two
// canonical players until a merge step exists.
type PlayerRef struct {
	SourceID    string
	FullName    string
	KnownAs     string
	Nationality string
	Position    string
}

// Player resolves a provider player id to a canonical player id, creating the
// player on a miss.
func (s *Store) Player(ctx context.Context, source string, ref PlayerRef) (uuid.UUID, error) {
	if ref.SourceID == "" {
		return uuid.Nil, fmt.Errorf("player ref has no source id")
	}
	if ref.FullName == "" {
		return uuid.Nil, fmt.Errorf("player ref %s/%s has no name", source, ref.SourceID)
	}
	opCtx, cancel := boundedContext(ctx)
	defer cancel()

	var playerID uuid.UUID
	err := s.pool.QueryRow(opCtx,
		`SELECT player_id FROM player_external_ref WHERE source=$1 AND source_id=$2`,
		source, ref.SourceID,
	).Scan(&playerID)
	if err == nil {
		return playerID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}

	tx, err := s.pool.Begin(opCtx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(opCtx)

	playerID, err = uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(opCtx, `
INSERT INTO player (id, full_name, known_as, nationality, position, updated_at)
VALUES ($1,$2,$3,$4,$5,now())`,
		playerID, ref.FullName, nullIfEmpty(ref.KnownAs),
		nullIfEmpty(ref.Nationality), nullIfEmpty(ref.Position),
	); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(opCtx, `
INSERT INTO player_external_ref (source, source_id, player_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	player_id = EXCLUDED.player_id, last_seen_at = now()`,
		source, ref.SourceID, playerID,
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(opCtx); err != nil {
		return uuid.Nil, err
	}
	return playerID, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./shared/store/ -run TestResolvePlayer -v 2>&1 | tail -10
```

`expect:` `--- PASS: TestResolvePlayerCreatesOnceAndReuses` and
`--- PASS: TestResolvePlayerRequiresSourceID`.

- [ ] **Step 5: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/shared/store/identity.go backend/shared/store/identity_integration_test.go
git commit -m "feat(store): player resolution through the crosswalk

Creates a canonical player on a crosswalk miss. Cross-source merging is
deliberately not attempted: names collide, change with accents, and follow
transfers, so two sources yield two canonical players until a real merge step
exists. A test pins that non-behaviour so nobody adds name matching by accident.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 8: Seed competitions and seasons from the registry

**Files:**
- Modify: `backend/shared/store/seed.go`
- Modify: `backend/shared/store/seed_integration_test.go`

The `match` table has a foreign key to `season`, so competitions and seasons must exist
before any match is written. They come from the already-generated `competitions.json`.

- [ ] **Step 1: Write the failing test**

Append to `backend/shared/store/seed_integration_test.go`:

```go
func TestApplyCompetitionSeedPopulatesSeasonsAndRefs(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	registry, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	for range 2 { // idempotent
		if err := store.ApplyCompetitionSeed(ctx, registry.List()); err != nil {
			t.Fatalf("ApplyCompetitionSeed: %v", err)
		}
	}

	var comps, seasons, refs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM competition`).Scan(&comps); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM season`).Scan(&seasons); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM competition_external_ref`).Scan(&refs); err != nil {
		t.Fatal(err)
	}
	if comps != len(registry.List()) || refs != len(registry.List()) {
		t.Fatalf("comps=%d refs=%d, want %d each", comps, refs, len(registry.List()))
	}
	if seasons < comps {
		t.Fatalf("seasons = %d, want at least one per competition (%d)", seasons, comps)
	}

	// The ESPN slug must resolve to our canonical competition id.
	id, err := store.Competition(ctx, "espn", "eng.1")
	if err != nil {
		t.Fatalf("Competition: %v", err)
	}
	if id != "premier-league" {
		t.Fatalf("resolved %q, want premier-league", id)
	}
}
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd backend && go test ./shared/store/ -run TestApplyCompetitionSeed
```

`expect:` FAIL to compile — `store.ApplyCompetitionSeed undefined`.

- [ ] **Step 3: Write the implementation**

Append to `backend/shared/store/seed.go`:

```go
const competitionUpsertSQL = `
INSERT INTO competition (id, name, short_name, kind, updated_at)
VALUES ($1,$2,$3,$4,now())
ON CONFLICT (id) DO UPDATE SET
	name = EXCLUDED.name, short_name = EXCLUDED.short_name,
	kind = EXCLUDED.kind, updated_at = now()`

const seasonUpsertSQL = `
INSERT INTO season (competition_id, id, label, has_bracket)
VALUES ($1,$2,$3,$4)
ON CONFLICT (competition_id, id) DO UPDATE SET
	label = EXCLUDED.label, has_bracket = EXCLUDED.has_bracket`

const competitionRefUpsertSQL = `
INSERT INTO competition_external_ref (source, source_id, competition_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	competition_id = EXCLUDED.competition_id, last_seen_at = now()`

// ApplyCompetitionSeed writes competitions and their seasons from the
// generated registry, plus the ESPN slug crosswalk. Match rows have a foreign
// key to season, so this must run before any ingest.
func (s *Store) ApplyCompetitionSeed(ctx context.Context, comps []config.Competition) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, comp := range comps {
		// A competition with any bracket season is a cup; otherwise a league.
		kind := "league"
		for _, season := range comp.Seasons {
			if season.HasBracket {
				kind = "cup"
				break
			}
		}
		if _, err := tx.Exec(ctx, competitionUpsertSQL,
			comp.ID, comp.Name, comp.ShortName, kind); err != nil {
			return err
		}
		for _, season := range comp.Seasons {
			if _, err := tx.Exec(ctx, seasonUpsertSQL,
				comp.ID, season.ID, season.Label, season.HasBracket); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, competitionRefUpsertSQL,
			"espn", comp.ESPNSlug, comp.ID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./shared/store/ -run 'TestApplyCompetitionSeed|TestApplyTeamSeed' -v 2>&1 | tail -10
```

`expect:` `--- PASS` for both.

- [ ] **Step 5: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/shared/store/seed.go backend/shared/store/seed_integration_test.go
git commit -m "feat(store): seed competitions, seasons, and their ESPN crosswalk

match has a foreign key to season, so the configured registry must be applied
before any ingest. Competition kind is derived from whether any season has a
bracket.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 9: Write canonical ids from the store layer

**Files:**
- Modify: `backend/shared/store/matches.go`
- Modify: `backend/shared/store/competitions.go`
- Modify: `backend/shared/store/teams.go`

This task rewrites the write path to take canonical ids. `model.Match` still carries
provider ids in its `Home.ID`/`Away.ID` fields, so the ingester (Task 10) resolves first and
passes the canonical ids alongside.

- [ ] **Step 1: Change the match upsert signature and SQL**

In `backend/shared/store/matches.go`, replace `matchUpsertSQL` and `UpsertMatch` and
`matchArgs` with:

```go
// MatchIdentity is the canonical identity the resolver produced for a provider
// match. It is passed alongside model.Match, whose Home.ID/Away.ID still hold
// provider ids.
type MatchIdentity struct {
	MatchID       uuid.UUID
	CompetitionID string
	SeasonID      string
	HomeTeamID    string
	AwayTeamID    string
	WinnerTeamID  *string
	Source        string
}

const matchUpsertSQL = `
UPDATE match SET
	round = CASE
		WHEN $16 AND $15 IS FALSE THEN NULL
		ELSE COALESCE(NULLIF($2, ''), match.round)
	END,
	kickoff = $3,
	state = $4,
	home_team_id = $5,
	away_team_id = $6,
	home_score = COALESCE($7, match.home_score),
	away_score = COALESCE($8, match.away_score),
	minute = $9,
	status_detail = $10,
	status_name = $11,
	winner_id = CASE WHEN $16 THEN $12 ELSE COALESCE($12, match.winner_id) END,
	note = COALESCE($13, match.note),
	home_placeholder = CASE
		WHEN NOT $16 AND match.home_team_id = $5 THEN match.home_placeholder ELSE $14 END,
	away_placeholder = CASE
		WHEN NOT $16 AND match.away_team_id = $6 THEN match.away_placeholder ELSE $17 END,
	bracket_required = CASE
		WHEN $16 THEN $15
		WHEN match.bracket_required IS TRUE THEN true
		ELSE COALESCE($15, match.bracket_required)
	END,
	source = $18,
	updated_at = now()
WHERE match.id = $1
	AND match.finalized_at IS NULL
	AND NOT (
		(match.state = 'live' AND $4 = 'scheduled'
			AND $11 NOT IN ('STATUS_POSTPONED', 'STATUS_SUSPENDED'))
		OR (match.state = 'finished' AND $4 <> 'finished')
	)`

// UpsertMatch updates the canonical match row the resolver already created.
// The resolver INSERTs on first sight, so this is always an UPDATE; the WHERE
// clause preserves the monotonic state guard and finalization immutability.
func (s *Store) UpsertMatch(ctx context.Context, identity MatchIdentity, match model.Match) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, matchUpsertSQL, matchArgs(identity, match)...)
	return err
}

func matchArgs(identity MatchIdentity, match model.Match) []any {
	var round any
	if match.Round != "" {
		round = match.Round
	}
	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	if err != nil {
		kickoff = time.Time{}
	}
	return []any{
		identity.MatchID, round, kickoff, string(match.State),
		identity.HomeTeamID, identity.AwayTeamID,
		match.HomeScore, match.AwayScore, match.Minute,
		match.StatusDetail, match.StatusName, identity.WinnerTeamID, match.Note,
		match.HomePlaceholder, match.BracketRequired, match.BracketConfirmed,
		match.AwayPlaceholder, identity.Source,
	}
}
```

Add `"github.com/google/uuid"` to the import block.

- [ ] **Step 2: Update the remaining match functions to canonical ids**

In the same file, change these signatures and their SQL parameters:

- `UpsertMatchDetail(ctx, matchID uuid.UUID, detail model.MatchDetail)` — change the
  `matchID string` parameter to `uuid.UUID`; the SQL is unchanged.
- `FinalizeMatch(ctx context.Context, identity MatchIdentity, match model.Match, detail model.MatchDetail) (bool, error)` —
  replace the `compID, seasonID string` parameters with `identity MatchIdentity`, key the
  `SELECT ... FOR UPDATE` and the `UPDATE` on `id=$1` using `identity.MatchID`, and drop
  `comp_id`/`season_id` from the `SET` clause (the resolver owns them).
- `ExistingMatches(ctx context.Context, competitionID, seasonID string, ids []uuid.UUID) (map[uuid.UUID]MatchRow, error)` —
  the `ids` parameter **and the returned map key** both become `uuid.UUID`; rename the
  columns `comp_id`/`season_id` to `competition_id`/`season_id`. Scan `m.id` into a
  `uuid.UUID` and key the result map on it.
- `ReplaceTopScorers(ctx context.Context, competitionID, seasonID, source string, scorers []model.TopScorer) error` —
  add the `source` parameter and bind it to the new `source` column in the INSERT.
- `UnfinalizedMatches` — same column rename; scan `m.id` into a `uuid.UUID`.

Add a `ID uuid.UUID` field to `MatchRow` so callers can pass it back to `MatchIdentity`.

- [ ] **Step 3: Rename the competition columns in the replacement writes**

In `backend/shared/store/competitions.go`, change every `comp_id` to `competition_id` in
the `standing` and `top_scorer` statements, add the `source` column to both INSERTs (value
`$N` bound to a new `source string` parameter), and change both signatures to
`ReplaceStandings(ctx context.Context, competitionID, seasonID, source string, standings []model.Standing, teamIDs map[string]string) error`
where `teamIDs` maps provider team id to canonical team id. Use `teamIDs[standing.Team.ID]`
for the `team_id` column, and drop the inline `teamUpsertSQL` loop — the resolver and seed
own team rows now.

Return an error if any `standing.Team.ID` is missing from `teamIDs`, since writing a
standing for an unresolved team would violate the foreign key.

- [ ] **Step 4: Build**

```bash
cd backend && go build ./shared/...
```

`expect:` compile errors only in `ingester/` and `reader/`, which Tasks 10 and 11 fix. If
`shared/` itself does not compile, fix it before continuing.

- [ ] **Step 5: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/shared/store/
git commit -m "feat(store)!: write canonical ids

Match writes are now UPDATEs against the row the resolver created, keyed by
canonical id, preserving the monotonic state guard and finalization
immutability. Standings take a provider-to-canonical team id map and refuse to
write a row for an unresolved team.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 10: Wire the ingester through the resolver

**Files:**
- Modify: `backend/ingester/contracts.go`
- Modify: `backend/ingester/matches.go`
- Modify: `backend/ingester/runner.go`
- Modify: `backend/ingester/main.go`

- [ ] **Step 1: Extend the repository interface**

In `backend/ingester/contracts.go`, replace the `repository` interface with:

```go
type repository interface {
	// identity
	Team(context.Context, string, store.TeamRef) (string, error)
	Competition(context.Context, string, string) (string, error)
	Match(context.Context, string, store.MatchRef) (uuid.UUID, error)
	Player(context.Context, string, store.PlayerRef) (uuid.UUID, error)
	ApplyTeamSeed(context.Context, []config.SeedTeam) error
	ApplyCompetitionSeed(context.Context, []config.Competition) error

	// facts
	SetTeamCrest(context.Context, string, string) error
	UpsertMatch(context.Context, store.MatchIdentity, model.Match) error
	UpsertMatchDetail(context.Context, uuid.UUID, model.MatchDetail) error
	FinalizeMatch(context.Context, store.MatchIdentity, model.Match, model.MatchDetail) (bool, error)
	ExistingMatches(context.Context, string, string, []uuid.UUID) (map[uuid.UUID]store.MatchRow, error)
	UnfinalizedMatches(context.Context, string, string) ([]model.Match, error)
	ReplaceStandings(context.Context, string, string, string, []model.Standing, map[string]string) error
	ReplaceTopScorers(context.Context, string, string, string, []model.TopScorer) error
	LogIngestRun(context.Context, *string, string, time.Time, time.Time, bool, string) error
	PruneIngestRuns(context.Context, time.Time) (int64, error)
}
```

Add imports for `config`, `uuid`, and `store`. Note `UpsertTeams` is gone — team rows are
owned by the seed and the resolver.

- [ ] **Step 2: Add a resolution helper**

Create the helper the match loop uses. Add to `backend/ingester/matches.go`:

```go
const sourceESPN = "espn"

// teamKindFor reports whether a competition fields national teams or clubs.
// Only the World Cup fields national teams; Leagues Cup has a bracket but is
// contested by clubs, so bracket presence is NOT the right signal.
func teamKindFor(comp config.Competition) string {
	if comp.ESPNSlug == "fifa.world" {
		return "national"
	}
	return "club"
}

// resolveMatch turns a provider-shaped match into its canonical identity,
// resolving both teams (creating provisional rows on a miss) and then the
// match itself on the natural key.
func (r *runner) resolveMatch(
	ctx context.Context,
	comp config.Competition,
	seasonID string,
	match model.Match,
) (store.MatchIdentity, error) {
	competitionID := comp.ID
	kind := teamKindFor(comp)
	homeID, err := r.repo.Team(ctx, sourceESPN, store.TeamRef{
		SourceID: match.Home.ID, Name: match.Home.Name, Abbr: match.Home.Abbr, Kind: kind,
	})
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("resolve home team: %w", err)
	}
	awayID, err := r.repo.Team(ctx, sourceESPN, store.TeamRef{
		SourceID: match.Away.ID, Name: match.Away.Name, Abbr: match.Away.Abbr, Kind: kind,
	})
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("resolve away team: %w", err)
	}
	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("match %s has unparseable kickoff %q", match.ID, match.Kickoff)
	}
	matchID, err := r.repo.Match(ctx, sourceESPN, store.MatchRef{
		SourceID: match.ID, CompetitionID: competitionID, SeasonID: seasonID,
		HomeTeamID: homeID, AwayTeamID: awayID, Kickoff: kickoff,
	})
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("resolve match: %w", err)
	}

	// winnerId arrives as a provider team id and must be translated too.
	var winner *string
	switch {
	case match.WinnerID == nil:
	case *match.WinnerID == match.Home.ID:
		winner = &homeID
	case *match.WinnerID == match.Away.ID:
		winner = &awayID
	}

	return store.MatchIdentity{
		MatchID: matchID, CompetitionID: competitionID, SeasonID: seasonID,
		HomeTeamID: homeID, AwayTeamID: awayID, WinnerTeamID: winner, Source: sourceESPN,
	}, nil
}
```

- [ ] **Step 3: Thread identities through `processMatches`**

In `processMatches`, immediately after the `for _, match := range matches {` line and the
`ctx.Err()` check, insert:

```go
		identity, err := r.resolveMatch(ctx, comp, season.ID, match)
		if err != nil {
			operationErrors = append(operationErrors, fmt.Errorf("match %s resolve: %w", match.ID, err))
			continue
		}
```

Then replace every downstream call in that loop:

- `existing[match.ID]` → `existing[identity.MatchID]`
- `r.repo.UpsertTeams(...)` → delete the call and its error branch entirely
- `r.repo.UpsertMatch(ctx, comp.ID, season.ID, match)` → `r.repo.UpsertMatch(ctx, identity, match)`
- `r.repo.UpsertMatchDetail(ctx, match.ID, detail)` → `r.repo.UpsertMatchDetail(ctx, identity.MatchID, detail)`
- `r.repo.FinalizeMatch(ctx, comp.ID, season.ID, match, detail)` → `r.repo.FinalizeMatch(ctx, identity, match, detail)`
- `existing[match.ID] = store.MatchRow{...}` → `existing[identity.MatchID] = store.MatchRow{...}`

`processMatches` keeps its existing `comp config.Competition` and `season config.Season`
parameters — `resolveMatch` needs the whole `comp` for `teamKindFor`, so no signature
change is required here.

- [ ] **Step 4: Resolve ids for the `ExistingMatches` lookup**

In `ingestCompSeason`, the `ids` slice is built from provider ids. Resolve them first:

```go
	ids := make([]uuid.UUID, 0, len(candidates))
	matches := make([]model.Match, 0, len(candidates))
	for _, match := range candidates {
		identity, err := r.resolveMatch(ctx, comp, season.ID, match)
		if err != nil {
			continue // reported per-match in processMatches
		}
		ids = append(ids, identity.MatchID)
		matches = append(matches, match)
	}
```

Resolution is cached for teams and cheap for matches after first sight, so resolving twice
per cycle is acceptable and keeps the change local.

- [ ] **Step 5: Resolve teams for standings**

In `refreshStandings`, build the provider→canonical map before writing:

```go
	teamIDs := make(map[string]string, len(rows))
	for _, row := range rows {
		canonical, resolveErr := r.repo.Team(ctx, sourceESPN, store.TeamRef{
			SourceID: row.Team.ID, Name: row.Team.Name, Abbr: row.Team.Abbr,
			Kind: teamKindFor(comp),
		})
		if resolveErr != nil {
			return resolveErr
		}
		teamIDs[row.Team.ID] = canonical
	}
	err = r.repo.ReplaceStandings(ctx, comp.ID, season.ID, sourceESPN, rows, teamIDs)
```

`teamKindFor` was already defined in Step 2.

- [ ] **Step 6: Apply the seeds at startup**

In `backend/ingester/main.go`, immediately after `repo` is created and before the lease is
acquired, add:

```go
	seedCtx, cancelSeed := context.WithTimeout(ctx, 30*time.Second)
	if err := repo.ApplyCompetitionSeed(seedCtx, registry.List()); err != nil {
		cancelSeed()
		log.Error("apply competition seed", "err", err)
		return 1
	}
	teams, err := config.LoadTeams()
	if err != nil {
		cancelSeed()
		log.Error("load team seed", "err", err)
		return 1
	}
	if err := repo.ApplyTeamSeed(seedCtx, teams); err != nil {
		// The seed does NOT fail on a single team it could not curate: that
		// team keeps resolving through its provisional row and ApplyTeamSeed
		// logs it. An error here means the seed could not be applied AT ALL
		// (connection, malformed registry), so continuing would ingest against
		// a schema with no teams in it.
		cancelSeed()
		log.Error("apply team seed", "err", err)
		return 1
	}
	cancelSeed()
```

Competition seeding stays fatal for the same reason it always was: `match` has a foreign
key to `season`, so with no competitions there is nothing to ingest into. A team that
could not be curated is different in kind — it degrades one club, not the process — so
`ApplyTeamSeed` reports those through the log and returns nil.

- [ ] **Step 7: Build and run the ingester tests**

```bash
cd backend && go build ./... && go test ./ingester/ 2>&1 | tail -20
```

`expect:` build succeeds; `ok github.com/mcasillas17/scorearc-backend/ingester`. The
existing ingester tests use a fake repository — update the fake to satisfy the new
interface, returning deterministic canonical ids (e.g. `"team-" + sourceID`) so the
existing behavioural assertions still hold.

- [ ] **Step 8: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/ingester/
git commit -m "feat(ingester)!: resolve provider ids to canonical ids before writing

Every match resolves both teams and itself through the crosswalk before any
fact is written, and winnerId is translated from a provider team id to a
canonical one. UpsertTeams is gone: team rows are owned by the seed and the
resolver, so the ingester can no longer mint them as a side effect.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 11: Update the reader for canonical ids

**Files:**
- Modify: `backend/reader/store.go`
- Modify: `backend/reader/server.go`
- Modify: `backend/reader/store_integration_test.go`

- [ ] **Step 1: Rename columns and scan uuid match ids**

In `backend/reader/store.go`, change every `m.comp_id` to `m.competition_id` and every
`comp_id` to `competition_id` in the `standing` and `top_scorer` queries. Change the
`Matches`, `Bracket`, and `MatchSummary` scans so `m.id` scans into a `uuid.UUID`, then
render it with `.String()` into the existing `Match.ID string` response field.

`MatchSummary(ctx, id string)` keeps a `string` parameter — the route param is a string —
but parse it first and return no rows for an unparseable id:

```go
func (s *Store) MatchSummary(ctx context.Context, id string) (*MatchSummary, error) {
	matchID, err := uuid.Parse(id)
	if err != nil {
		return nil, nil // an unparseable id is simply not found
	}
	...
}
```

- [ ] **Step 2: Update the integration seed**

In `backend/reader/store_integration_test.go`, `newIntegrationStore` seeds base data with
string ids. Update its INSERTs to the canonical schema: insert `competition` and `season`
rows first, `team` rows with slug ids and a `kind`, then `match` rows with literal UUIDs and
a `source` column. Keep the same fixture semantics (a live ARG–FRA 2–2 at minute `84'`, a
scheduled TBD–ARG, and a different-competition row) so the existing assertions still hold.

- [ ] **Step 3: Run the reader suite**

```bash
cd backend && go test ./reader/... 2>&1 | tail -20
```

`expect:` `ok github.com/mcasillas17/scorearc-backend/reader`

- [ ] **Step 4: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add backend/reader/
git commit -m "feat(reader): serve canonical ids

Column renames plus uuid match ids rendered as strings. The response SHAPE is
unchanged, so the OpenAPI contract and the frontend are unaffected.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 12: Seed drift check

**Files:**
- Create: `.github/workflows/seed-drift.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Team seed drift

on:
  schedule:
    - cron: "0 6 * * 1"   # Mondays 06:00 UTC
  workflow_dispatch: {}

jobs:
  drift:
    name: report teams missing from the seed
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: backend/go.mod
      - name: Compare live ESPN against teams.seed.json
        run: |
          cd backend
          go run ./cmd/seed-teams > /tmp/proposed.json
          python3 - <<'PY'
          import json, sys
          proposed = {t['refs']['espn'] for t in json.load(open('/tmp/proposed.json'))}
          seeded  = {sid for t in json.load(open('config/teams.seed.json'))
                          for src, sid in t['refs'].items() if src == 'espn'}
          missing = proposed - seeded
          if missing:
              print(f"{len(missing)} team(s) known to ESPN are absent from teams.seed.json:")
              for espn_id in sorted(missing):
                  print("  espn id", espn_id)
              print("\nRun: cd backend && go run ./cmd/seed-teams > config/teams.seed.json")
              print("then review and commit.")
              sys.exit(1)
          print("teams.seed.json covers every team ESPN currently reports")
          PY
```

- [ ] **Step 2: Validate the YAML**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
ruby -ryaml -e 'YAML.safe_load(File.read(".github/workflows/seed-drift.yml"), aliases: true); puts "valid YAML"'
```

`expect:` `valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/seed-drift.yml
git commit -m "ci: weekly team seed drift check

Reports teams ESPN knows that the curated seed does not. Scheduled rather than
on pull requests, so a promotion never blocks unrelated work — runtime
provisional creation is the availability backstop.

Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 13: Documentation

**Files:**
- Modify: `VISION.md`
- Modify: `AGENTS.md`
- Modify: `BACKEND_HANDOFF.md`

- [ ] **Step 1: Correct VISION §9**

In `VISION.md`, find:

```
IDs for teams/matches are ESPN's own ids (we reuse them as primary keys for idempotent ingestion).
```

Replace with:

```
IDs for teams/matches are **ours**, not ESPN's. ESPN's ids live only in the
`*_external_ref` crosswalk tables, which map `(source, source_id)` to a
canonical id — so a second source describes the same entity instead of
duplicating it. See `docs/superpowers/specs/2026-08-12-canonical-identity-design.md`.
```

- [ ] **Step 2: Document the seed in AGENTS.md**

Add to the "Backend (Go)" section:

```markdown
- **Team identity is curated.** `backend/config/teams.seed.json` is **hand-authored and
  reviewed** — unlike the generated `competitions.json`, which must never be hand-edited.
  Regenerate a proposal with `cd backend && go run ./cmd/seed-teams`, then review before
  committing. An unseeded team does not break ingestion: it becomes a `provisional` row
  (`SELECT * FROM team WHERE provisional`) until curated.
```

- [ ] **Step 3: Update the handoff's "what's done" list**

In `BACKEND_HANDOFF.md` §4, add:

```markdown
8. **Canonical identity** — ScoreArc mints its own entity ids; provider ids live in
   per-source crosswalk tables. `match` carries a natural-key unique constraint so the
   same fixture from a second source resolves to one row. See
   `docs/superpowers/specs/2026-08-12-canonical-identity-design.md`.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
git add VISION.md AGENTS.md BACKEND_HANDOFF.md
git commit -m "docs: canonical identity supersedes ESPN-ids-as-primary-keys

Co-Authored-By: Codex <noreply@openai.com>"
```

---

## Final verification

Run the complete gate before opening a pull request.

- [ ] **Backend build, vet, and full race suite**

```bash
cd backend
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
go build ./... && go vet ./... && go test -race ./...
```

`expect:` every package `ok`, no failures.

- [ ] **Frontend gate — must be untouched by this change**

```bash
cd /Users/elopenmike/build/Apps/Futbol/ScoreArc
npx tsc --noEmit && npm test
```

`expect:` typecheck silent; `Tests  167 passed (167)` or more. The frontend treats ids as
opaque strings, so **any** frontend failure here means a response shape changed and the
design was violated.

- [ ] **Verify the crosswalk actually holds ESPN's ids and nothing else does**

```bash
cd backend
grep -rn "espn" --include="*.sql" migrations/ | grep -v "external_ref" || echo "no provider ids outside the crosswalk"
```

`expect:` `no provider ids outside the crosswalk`

- [ ] **Open a pull request; do not merge.** Merging is the user's decision.

---

## Deferred to the next slice

Named here so they are not silently dropped:

- **`appearance` and relational `match_event` tables** consuming the ESPN athlete ids that
  Task 7's resolver makes usable. The `rawAthlete` and `rawParticipant` structs in
  `backend/shared/espn/summary.go` still need an `ID` field added.
- **Snapshot writes** — `standing_snapshot` and `win_prob_snapshot` exist and nothing
  writes them.
- **The scheduled-match summary re-fetch** — `needsSummary` returns true for every
  scheduled match on each slow tick.
