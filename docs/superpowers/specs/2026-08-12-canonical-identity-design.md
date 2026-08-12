# Canonical Identity + Source Crosswalk — Design

- **Date:** 2026-08-12
- **Status:** Approved (design); implementation plan to follow
- **Supersedes:** `VISION.md` §9's "IDs for teams/matches are ESPN's own ids (we reuse
  them as primary keys for idempotent ingestion)" — that line must be updated when this
  ships.
- **Scope:** the identity layer only. Player *appearances* and relational *match events*
  are the immediate follow-on slice (see "Follow-on work").

---

## 1. Problem

ScoreArc's database uses **ESPN's ids as its primary keys**. `team.id` is an ESPN team
id; `match.id` is an ESPN event id. That is fine while ESPN is the only source. It fails
the moment there is a second one:

- Two sources have different ids for the same club. Nothing expresses "these are the
  same team", so a second source can only ever create duplicates.
- A historical CSV has no ESPN ids at all, so decades of results cannot be attached to
  the clubs we already have.
- ESPN is keyless and undocumented. Its ids are not a contract, and today they are load-bearing
  for the entire platform.

There is a second, active loss. **Player identity is being discarded on every ingest.**
ESPN's summary payload carries `athlete.id`, but our mapper structs do not declare the
field, so every player is persisted as a display-name string inside a `match_detail`
jsonb blob. Verified against the recorded summary fixture:

| ESPN JSON path | athlete objects | carrying an id |
|---|---|---|
| `/rosters[]/roster[]` (lineups) | 52 | **52** |
| `/keyEvents[]/participants[]` (goals, cards) | 23 | **23** |
| `/header/competitions[]/details[]/participants[]` | 6 | **6** |
| `/commentary[]/play/participants[]` | 105 | 0 |

Only commentary is name-only, and that is display prose. Lineups and goal/card events
both carry stable ids, and we drop all of them. Player valuation — an explicit product
goal — is not buildable on name strings, which collide, change with accents, and follow
players across transfers.

**Why now:** nothing is deployed and the database does not exist. There is no data to
migrate and no API consumer to break. This change will never be cheaper.

## 2. Goals

1. ScoreArc owns its entity ids. No provider id is ever a primary key.
2. Any number of sources can be attached to the same canonical entity.
3. Match identity is deterministic across sources, so enrichment merges rather than
   duplicates.
4. Provider outages or id changes degrade data freshness, never identity.
5. Provenance: every fact records which source supplied it.

## 3. Non-goals

- Cross-source *player* merging (same human across ESPN and StatsBomb). The seam exists;
  the implementation is deferred until a second player source is actually integrated.
- Conflicting core-fact reconciliation (two sources disagreeing on a score). A precedence
  policy is designed for but not implemented until a second core-fact source exists.
- Global league coverage. The design must not *block* it; it does not build for it.
- Relational match events and appearances (see "Follow-on work").

## 4. Canonical entities

"Club" is the wrong entity name: the World Cup and Leagues Cup involve national teams.
The canonical entity is `team`, discriminated by `kind`.

| Entity | Id form | Example | Rationale |
|---|---|---|---|
| `competition` | slug | `premier-league` | Curated; matches existing `competitions.ts` |
| `season` | composite `(competition_id, id)` | `('premier-league','2026-27')` | Already established |
| `team` | slug | `eng-manchester-united`, `nat-mex` | ~200 rows, curated, self-documenting |
| `player` | UUIDv7 | — | Machine-generated; names are not unique |
| `match` | UUIDv7 | — | Machine-generated; too many for slugs |

Hybrid on purpose: slugs where a human curates and reads them, UUIDs where the machine
generates them.

### 4.1 Core schema

```sql
CREATE TABLE competition (
  id         text PRIMARY KEY,                    -- 'premier-league'
  name       text NOT NULL,
  short_name text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('league','cup')),
  country    text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE season (
  competition_id text NOT NULL REFERENCES competition(id),
  id             text NOT NULL,                   -- '2026-27'
  label          text NOT NULL,
  has_bracket    bool NOT NULL DEFAULT false,
  PRIMARY KEY (competition_id, id)
);

CREATE TABLE team (
  id          text PRIMARY KEY,                   -- 'eng-manchester-united' | 'nat-mex' | 'prov-espn-360'
  kind        text NOT NULL CHECK (kind IN ('club','national')),
  name        text NOT NULL,
  short_name  text,
  abbr        text NOT NULL,
  country     text,
  crest_url   text,
  provisional bool NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
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
  kickoff_date   date GENERATED ALWAYS AS ((kickoff AT TIME ZONE 'UTC')::date) STORED,
  round          text,
  state          text NOT NULL,
  home_score     int,
  away_score     int,
  minute         text,
  status_detail  text NOT NULL DEFAULT '',
  status_name    text NOT NULL DEFAULT '',
  winner_id      text REFERENCES team(id),
  note           text,
  home_placeholder bool NOT NULL DEFAULT false,
  away_placeholder bool NOT NULL DEFAULT false,
  bracket_required bool,
  finalized_at   timestamptz,
  source         text NOT NULL,                   -- provenance for core facts
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (competition_id, season_id) REFERENCES season(competition_id, id),
  UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)
);
```

**The `UNIQUE` constraint on `match` is the keystone of this design.** It is the natural
key that makes match identity deterministic. The same fixture arriving later from a
historical CSV or StatsBomb resolves to the existing row instead of duplicating it. No
fuzzy matching is ever required for matches, provided teams resolve — which is why team
identity is curated rather than guessed.

`kickoff_date` is generated rather than supplied so sources that disagree on kickoff time
by minutes (common) still collide on the same day and resolve to one match.

### 4.2 Carried-over tables

These already exist and are **not** redesigned here, but the migration rewrite must
re-key their team references onto canonical ids:

| Table | Change |
|---|---|
| `match_detail` | Unchanged shape; `match_id` becomes `uuid` referencing `match(id)` |
| `standing` | `team_id` → canonical `team.id`; PK stays `(comp_id, season_id, team_id)` |
| `top_scorer` | Unchanged (denormalised abbr/name/crest — ESPN gives no team id here) |
| `standing_snapshot` | `team_id` → canonical |
| `win_prob_snapshot` | `match_id` → `uuid` |
| `ingest_run` | Unchanged |

`standing` keeps its plain-`INSERT` replacement semantics, so the mapper-level dedup fix
on branch `fix/ingester-hardening` remains required — a team appearing twice still aborts
the replacement transaction.

### 4.3 Crosswalk

One table per entity, **not** a single polymorphic table:

```sql
CREATE TABLE team_external_ref (
  source        text NOT NULL,                    -- 'espn' | 'statsbomb' | 'football-data-uk'
  source_id     text NOT NULL,
  team_id       text NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX team_external_ref_team_idx ON team_external_ref (team_id);
```

`player_external_ref`, `match_external_ref`, and `competition_external_ref` follow the
same shape against their own canonical tables.

Per-entity tables cost four near-identical schemas and buy **real foreign keys**. A
single polymorphic table cannot have one, because `canonical_id` would point at different
tables depending on `entity_type` — and referential integrity is the entire point of
owning the identity layer.

The primary key is `(source, source_id)`, so *many source ids may map to one canonical
entity*. That is deliberate: it is exactly what merging two duplicate records produces.

ESPN holds no privileged position. `('espn', '360', 'eng-manchester-united')` is one row;
another source adds its own beside it.

### 4.4 Provenance

- **Core facts** (score, state, kickoff) carry a `source` column naming who supplied the
  row's *current* values. It is overwritten whenever a source updates those fields, so it
  answers "who last wrote this", not "who has ever contributed". Full per-field history is
  out of scope until a second core-fact source exists.
- **Enrichment facts** that legitimately differ per source (xG, valuations) live in their
  own tables keyed `(entity_id, source)`. They are additive, not conflicting, so they need
  no precedence policy.
- **Conflicting core facts** are out of scope until a second core-fact source exists. The
  `source` column is what a precedence policy will later key off.

## 5. Resolution

### 5.1 Pipeline

Resolution is a new layer between the existing `source` and `store` packages:

```
source.Source  →  source-shaped records (provider ids)
                        ↓
                  Resolver             ← crosswalk lookup + in-memory cache
                        ↓
                  canonical ids attached
                        ↓
                  store                → canonical rows + provenance
```

The ESPN mappers **do not change shape**. They keep emitting provider-shaped data with
provider ids, which keeps their fixture-parity tests intact. Resolution is additive.

### 5.2 Interface

```go
// Resolver maps provider-scoped identities onto canonical ScoreArc ids.
// Implementations must be safe for concurrent use: the ingester resolves
// several competitions in parallel.
type Resolver interface {
    Competition(ctx context.Context, source, sourceID string) (string, error)
    Team(ctx context.Context, source string, ref TeamRef) (string, error)
    Match(ctx context.Context, source string, ref MatchRef) (uuid.UUID, error)
    Player(ctx context.Context, source string, ref PlayerRef) (uuid.UUID, error)
}
```

`TeamRef` / `PlayerRef` carry the provider id **plus** name, abbr, and country hints —
needed to create a usable provisional record and to make review lists legible.

### 5.3 Per-entity behaviour

| Entity | On hit | On miss |
|---|---|---|
| `competition` | Return canonical id | Error. The set is closed and configured; a miss is a config bug. |
| `team` | Return canonical id (cached) | **Create provisional** (§5.4) |
| `match` | Return canonical id | Resolve both teams, then upsert on the natural key |
| `player` | Return canonical id | Create player + crosswalk row |

Team and competition lookups are cached in memory. Roughly 200 entries, and every match
resolves two teams, so this removes the dominant query load.

### 5.4 Provisional teams

An earlier draft made a team miss a hard error. That is wrong for a live product: a newly
promoted club would silently drop all of its matches until someone hand-curated it.

Instead, a miss **auto-creates** a team with a derived slug (`prov-espn-360`),
`provisional = true`, carrying the provider's real name so the site still renders
correctly. Ingestion never blocks.

Curation is then a rename-and-merge **inside our own system**: point the crosswalk rows at
the curated team, repoint foreign keys, delete the provisional row. That is tractable
precisely because we own the ids — which is the argument for this whole design in
miniature. The review list is `SELECT * FROM team WHERE provisional`.

Every provisional creation emits a warning log and an `ingest_run` record.

## 6. The team seed

### 6.1 Bootstrap

A one-time Go command (`backend/cmd/seed-teams`):

1. Pulls scoreboards and standings for all configured competitions.
2. Collects distinct teams keyed by provider id.
3. Derives `kind` from the competition (`fifa.world` → `national`, else `club`) and a
   country prefix from the competition slug (`eng.1` → `eng-`).
4. Proposes slugs and emits `backend/config/teams.seed.json`.
5. A human reviews and commits it.

Machine-generated, human-approved. The file is named `.seed.` deliberately so it is never
confused with the *generated* `competitions.json`, which `AGENTS.md` says must never be
hand-edited. This one is authored and reviewed; that one is derived.

### 6.2 Keeping it honest

Three layers, none of which block unrelated work:

1. **PR CI — hermetic, no network.** The seed is internally valid: unique slugs, unique
   `(source, source_id)` pairs, no empty names, every `kind` legal.
2. **Scheduled drift check.** A weekly cron workflow queries the live provider and reports
   teams absent from the seed. Catches promotions and new competitions without failing
   anyone's pull request.
3. **Runtime.** Provisional creations warn and land in the review list.

## 7. Impact on existing code

Nothing is deployed, so this is a rewrite rather than a migration.

- **Migrations** — rewrite `0001`–`0004` into a clean canonical set. There is no data to
  preserve and no reason to carry the archaeology of a schema that has never run.
- **`shared/model`** — `Team` gains `Kind`; ids become canonical. Provider-shaped types
  keep provider ids until resolution.
- **`shared/store`** — writes canonical ids; the `match` upsert keys on the natural key.
- **`shared/espn`** — mappers unchanged in shape; the `rawAthlete` / `rawParticipant`
  structs gain the `id` field they currently omit, so player identity stops being lost
  (consumed by the follow-on slice).
- **`reader`** — serves canonical ids. The response *shape* is unchanged.
- **Frontend `types.ts`** — `Team.id` becomes a canonical slug. Ids are opaque strings to
  the frontend, compared for equality only (`winnerId`, bracket legs), so no component
  logic changes. Verify the bracket and standings views against a seeded database.
- **`VISION.md` §9** — update the ESPN-ids-as-primary-keys statement.

## 8. Testing

- **Resolver unit tests** against a fake store: hit, miss-creates-provisional, cache
  behaviour, and concurrent resolution.
- **Determinism test** — the same fixture presented with two different provider ids and
  kickoff times minutes apart resolves to exactly **one** match row. This is the property
  the whole design exists to provide, so it is tested directly.
- **Seed validity** — unique slugs and source ids, legal kinds, no empty names.
- **Integration (testcontainers)** — full resolve-and-write cycle against real Postgres,
  including the natural-key collision path and provisional creation.
- **Existing mapper fixture-parity tests** must remain untouched and green. If they need
  changing, resolution has leaked into the mappers and the design has been violated.

## 9. Follow-on work

In dependency order. Each is its own spec or plan.

1. **Player capture** — `appearance` and relational `match_event` tables consuming the
   athlete ids this design makes available. Immediate next slice; it is what turns player
   data from jsonb prose into queryable facts.
2. **Historical results + odds backfill** — free CSV sources attach to canonical teams via
   the crosswalk. Unblocked by this design.
3. **Event-level / xG data** — licence review required first, given the public API.
4. **Second live source** — redundancy and richer coverage; paid.
5. **Player valuation model** — depends on 1 and benefits greatly from 3.
6. **Snapshot writes** — `standing_snapshot` and `win_prob_snapshot` exist but nothing
   writes them; history is being lost every cycle.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Curated seed goes stale | Three-layer defence (§6.2); provisional creation means staleness degrades curation quality, never availability |
| Provisional teams accumulate unnoticed | Indexed review list, warning logs, `ingest_run` records, weekly drift report |
| Natural key wrong for two-legged ties | Same fixture, same day, same teams is one match; two legs differ by date. Neutral-venue reversals need the test in §8 to cover both orderings |
| Slug churn on club rename | Slug is an id, not a display name. Renaming a club changes `name`, never `id` |
| Scope creep into full event modelling | Explicitly deferred (§3, §9) |
