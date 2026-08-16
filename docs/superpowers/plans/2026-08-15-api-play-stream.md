# Reader API — Play Stream & Action Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the touch-level play stream — 1,200–1,550 typed events per match — and the per-player action counts derived from it. Tackles, interceptions, take-ons, aerials, dispossessions and passes are not in any leaderboard ScoreArc can reach today, and they are strongest on exactly the competitions where free providers give up: Liga MX and MLS.

**Architecture:** `match_play` is owned by the ingester's `0007_play_stream` and **read**, not created, here — Task 1 carries the reconciliation. The stream is served through keyset pagination on its provider-order column: 1,500 events is four pages, never one response. Every play-derived response carries a `PlayFidelity` block stating what we actually hold for that match, because ESPN prunes the touch tier for older fixtures and a thinner result must announce itself rather than look like a quiet match. Per-match action counts are a `GROUP BY` at read time; per-season counts are a stored aggregate — the one table this plan does create — because a season's worth of plays is not a query you run per request.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** none. This slice comes from a live capability probe on 2026-08-15, not from a design document — the probe's numbers are quoted in full below and are the requirements.
**Epic:** E6 in `docs/PRODUCT_ROADMAP.md` is the nearest relative, and this **supersedes its "parse shots out of prose" framing** — see "What this changes about E6".
**New roadmap task:** **T9.8** (Epic **E9 · Public API read surface**)
**Branch:** `feat/api-play-stream` off latest `origin/main`
**Prerequisites:** the `api-match-reads` plan (it creates `backend/reader/params.go`). Player names on action rows come from the `api-players` plan's `player` table via a LEFT JOIN and are null without it — a soft dependency, not a blocker.

## The probe — verified live 2026-08-15

ESPN's **core** host `sports.core.api.espn.com` returns touch-level plays per match:

| Competition | Plays returned |
|---|---|
| Liga MX | **1,542** |
| MLS | **1,484** |
| Leagues Cup | **1,318** |
| LaLiga | **1,235** |
| CONCACAF Champions Cup | **55** |

Each play carries `id`, `type` `{id, text, type}`, `text`, `clock` `{value, displayValue}`, `period`, `homeScore`, `awayScore`, `scoringPlay`, `scoreValue`, `priority`, `wallclock`, and the boolean flags `ownGoal`, `penaltyKick`, `redCard`, `yellowCard`, `substitution`, `shootout`. Observed types: Pass, Foul, Free Kick, Aerial, Clear, Ball touch, Throw In, Dispossessed, Tackle, Blocked Pass, Cross, Corner Awarded, Take On, Shot Blocked, Shot On Target, Shot Off Target, Assists Shot, Assist, Goal, Save, Offside, Interception, Substitution, and period markers. Team and athlete arrive as `$ref` URLs; the ingester resolves them to plain ids.

**The 55 is as important as the 1,542.** One competition returning a fortieth of another's volume is the same finding that made the E6 spec insist on a per-competition capability check rather than a global feature flag, and it is why every endpoint here carries fidelity in its response.

**Verified absent even in the play stream, so do not design for them:** injuries, transfers, and physical or tracking data.

## Plays carry geometry — verified 2026-08-15

An earlier draft of this plan said coordinates were absent and flagged the
ingester's `start_x` / `goal_z` columns as a contradiction to be resolved. **The
ingester was right and the draft was wrong.** Measured directly against the live
API:

| Field | Meaning |
|---|---|
| `fieldPositionX` / `fieldPositionY` | where the action starts |
| `fieldPosition2X` / `fieldPosition2Y` | where it ends |
| `goalPositionY` / `goalPositionZ` | placement within the goal mouth (shots only) |

Coverage: Liga MX event 401877018 → **979 of 1,000** plays carry non-zero
coordinates. LaLiga event 401882926 → **955 of 1,000**. A sampled shot reads
`fieldPosition 69.1/42.2 → 72.0/42.9`, `goalPositionY 49.9`, `goalPositionZ 19.0`,
against the text *"Attempt blocked. Luis Calzadilla (Atlante) right footed shot
from outside the box is blocked."*

**So `Play` carries the six coordinate fields, all nullable.** A shot map is now a
`SELECT`, not a prose parse.

Three consequences, stated because each one reverses something previously written
down:

1. **The E6 shot-log plan changes shape, not just emphasis.** Its `Shot` wire
   type gains geometry and its parser narrows further — see that plan's own
   correction block.
2. **Pass and carry geometry exists too** (start→end on non-shot plays), so pass
   maps and territory aggregates are *possible*. This plan does not design them:
   possible is not the same as specified, and a pass-network endpoint needs a
   design pass on what a "chain" is before it claims to serve one. But nothing
   downstream may refuse them on the grounds that the data does not exist.
3. **xG is no longer blocked by missing data.** It is a modelling decision now,
   not a data-availability one. **This plan still specifies no xG endpoint** —
   that is the user's call, no model exists, and coordinates are a necessary but
   not sufficient input. Any surviving claim elsewhere that xG is impossible, or
   that it requires a paid provider, is now false and should be struck.

## The retention fact that shapes every response

ESPN **prunes the touch-level tier for older matches, but not the shot tier and
not the geometry.** This is a sharper finding than the earlier draft's, and the
difference decides what is backfillable:

- **Perishable — the touch tier.** An October 2025 fixture returns zero Pass,
  zero Tackle, zero Take On. Full-fidelity touch data exists only from the day
  ingestion starts forward, plus whatever a current-season backfill catches.
- **Durable — shots and their coordinates.** That same October 2025 Premier
  League match still returns **161 of 194** plays with coordinates and **26 of 43
  shot-type plays** with coordinates. The shot tier and its geometry survive to at
  least ~10 months.

**So a history endpoint must not assume shot geometry begins at our ingest date.**
Past-season shot maps are very likely backfillable, and any read model that
hard-codes "geometry starts when we started" would foreclose that. The fidelity
tier describes the *touch* tier's completeness; it is not a statement about
whether shots are present.

An endpoint that quietly returns 40 key events where another match returns 1,542 plays is telling a user that one match had less football in it. Every play-derived response therefore carries:

```json
"fidelity": { "tier": "key-events", "playCount": 41, "distinctTypes": 6,
              "sourcePruned": true, "ingestedAt": "2026-08-15T09:00:00Z",
              "note": "Only key events are held for this match; the provider had already pruned the touch-level tier when it was ingested." }
```

This is not a debug field. It is the difference between a thin result and a false one.

## What this changes about E6

The E6 spec was written to extract shots by parsing commentary prose, because prose was the only shot source we had. It no longer is: shots now arrive **typed**, with athlete ids, as `Shot On Target` / `Shot Off Target` / `Shot Blocked` / `Goal` plays.

- **Shot discovery moves here.** A shot list is a filter on `match_play`, not a regex over sentences.
- **Prose still earns its plan.** Body part, pitch zone and assist type are in the sentence and nowhere else. The sibling `api-commentary-and-shots` plan (**T9.6**) keeps its parser, narrowed to enriching a shot the play stream already found.
- **Reconciliation gets stronger.** The play stream is a second independent ground truth alongside `rosters[].totalShots`. A parsed shot with no matching typed play is over-matching, which the E6 spec already says must fail loudly.

## The raw archive is not part of this surface

Raw ESPN play-stream JSON is archived to a **private** R2 bucket
(`R2_RAW_BUCKET=scorearc-espn-historic`) so parsers can be re-run against it when
they improve. **No endpoint in this plan — or any reader plan — reads from,
proxies, lists, or exposes an object key from that bucket.** Every public read is
served from Postgres: normalized rows the ingester has already written.

The consequence is deliberate and worth stating rather than discovering: **what
the ingester does not normalize is not reachable through the API, even though we
hold the raw JSON.** A field that exists in the archive and not in `match_play`
is, as far as this API is concerned, a field we do not have. That is the trade,
and it is exactly why `PlayFidelity` is on every response — an endpoint that
cannot serve the whole truth about a match must at least be able to say so.

A "raw payload" or "debug source" endpoint is therefore **not** a future
extension of this plan. If one is ever wanted it is a separate, authenticated,
non-public surface with its own design, not a query parameter on `/plays`.

The public bucket is the opposite case: crest, flag and emblem URLs in every
response point at `https://cdn.scorearc.futbol` because `team.crest_url` stores
our CDN URL, not ESPN's origin. The reader serves what is stored and rewrites
nothing — see the `api-match-reads` plan's Global Constraints.

## Global Constraints

- Extend the existing layering. Routes register in `App.router()`; handlers in `handlers_plays.go`; SQL in `store_plays.go`; the `readerStore` interface in `server.go` grows and `fakeReaderStore` in `server_test.go` follows it.
- **No string-built SQL.** Play types and action metrics are jsonb keys or column values bound as parameters, never concatenated.
- **Reject, never silently fall back.** An unknown play type, an out-of-range period, a malformed cursor are all 400s.
- 400 messages come only from constants in our own code.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go` enforces: `required` equals the complete property list on every object schema, `additionalProperties: false` everywhere, 200/405/500 (+429) on every GET, and a `Cache-Control` header on **every** documented response. Because `required` must list every property, **no response struct may use `omitempty`**.
- Rate limiting: all `/v1` routes share the 10 rps / burst 30 per-IP bucket. The two aggregate endpoints charge 2 tokens via `AllowCost` — added by the `api-history` plan's Task 8; if that has not landed, add it here, the code is four lines and identical.
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`, `go test -race ./...`. **Docker must be running.**
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Ingester prerequisites

**`match_play` is not this plan's table.** `docs/superpowers/plans/2026-08-15-ingester-play-stream.md` owns it at migration `0007_play_stream`, along with `match_play_archive` and a `touch_tier` flag. This plan reads them and creates only the season roll-up. Task 1 carries the full column reconciliation and two blocking questions.

| Table | Owner | Written from | Notes |
|---|---|---|---|
| `match_play` | **ingester `0007_play_stream`** | the core host's plays feed, one row per play | `$ref` team and athlete URLs resolved by parsing the trailing id, never by fetching — ~1,500 plays × 2–3 refs is 4,500 round trips per match. |
| `match_play_archive` / `touch_tier` | **ingester `0007_play_stream`** | one row per match, written at ingest time | The fidelity signal. Decided from what actually arrived, not from the match date. |
| `player_action_count` | **this plan, `0012`** | a per-season roll-up of `match_play` | Recomputed per competition season, not per request. Confirm no ingester plan claims it before creating it. |

> **Upstream paging has a silent failure mode the ingester must handle.** The
> core API's `?limit` caps at **1000**, and `limit=1001` does not error — it
> silently degrades to `pageSize=25`. A single unpaged fetch therefore returns
> 1,000 of a 1,542-play match and looks complete, and an over-limit fetch returns
> 25 and looks like a quiet match. The ingester must paginate **and assert the
> returned `pageSize` matches what was requested**, failing the ingest rather
> than writing a short stream. This is a write-path concern, but it lands on the
> read side as a `fidelity.playCount` that is confidently wrong, which is the one
> failure this plan's fidelity block cannot detect — it reports what we hold, not
> what we should have held.

> **The play stream is distinct from `match_event`.** The unmerged `feat/player-identity` branch adds `0003_player_capture` with `appearance` and `match_event` — **key** events (goals, cards, substitutions) supporting participation. `match_play` is the **touch** stream: 1,500 rows where `match_event` holds 40. Both are correct, they answer different questions, and nothing here reconciles them. Do not fold one into the other; the roll-up would be a table of two different grains.

## What is capped, and to what

| Endpoint | Bound | Worst case |
|---|---|---|
| `/matches/{id}/plays` | `?limit=` 1–500 (default 200), keyset paged on `sequence` via `?after=` | 500 plays per response; a 1,542-play match is 4 pages |
| `/matches/{id}/plays/types` | one row per distinct type in the match | ~25 rows |
| `/matches/{id}/actions` | one row per player who touched the ball | ~40 rows; charges **2 tokens** |
| `/competitions/{comp}/{season}/players/{playerId}/actions` | one stored aggregate row | 1 row |
| `/competitions/{comp}/{season}/actions` | `?limit=` 1–200 (default 50) | 200 rows; charges **2 tokens** |
| `/competitions/{comp}/{season}/plays/coverage` | one row per fidelity tier | 3 rows |

**There is no unpaginated plays endpoint and there will not be one.** A caller who wants a whole match walks the cursor. A single 1,542-play response is roughly 400 KB of JSON bought with one rate-limit token, and offering it would make the cheapest request in the API the most expensive one we serve.

---

## File Structure

- `backend/migrations/0012_player_action_count.up.sql` / `.down.sql` — **the only table this plan creates.** `match_play` and its fidelity companion belong to the ingester's `0007_play_stream`; see Task 1.
- `backend/reader/store_plays.go` — `Plays`, `PlayTypes`, `MatchActions`, `PlayerSeasonActions`, `ActionLeaders`, `PlayCoverage`, `PlayFidelityFor`.
- `backend/reader/handlers_plays.go` — six handlers.
- `backend/reader/types.go` — the response models (append).
- `backend/reader/params.go` — `parsePlayType`, `parsePeriod`, `parseAfterSequence`, `parseActionMetric` (append).
- `backend/reader/server.go`, `server_test.go`, `store_integration_test.go`, `migrations_integration_test.go`, `openapi.yaml`, `openapi_test.go`, `README.md`.

---

### Task 1: Reconcile with the ingester's schema — do not create `match_play`

**Files:**
- Modify: `backend/reader/store_integration_test.go` (seed only)
- Create: `backend/migrations/0012_player_action_count.up.sql` / `.down.sql` (**only** the roll-up table — see below)

> ## STOP — read this before writing a line of SQL
>
> An earlier draft of this plan created `match_play` and `match_play_fidelity`
> at `0012_play_stream`. **That was wrong and has been replaced by this task.**
> `docs/superpowers/plans/2026-08-15-ingester-play-stream.md` already exists and
> **owns `match_play` at migration `0007_play_stream`**, together with
> `match_play_archive` and a `touch_tier bool`. The write side owns the schema;
> two `CREATE TABLE match_play` statements are not a merge conflict, they are a
> migration that fails on a live database.
>
> **So this plan creates exactly one table — `player_action_count`, the season
> roll-up — and reads everything else.** Confirm before you start that the
> roll-up is not also claimed by an ingester plan; if it is, drop this migration
> too and read theirs.
>
> ### Column reconciliation you must apply throughout Tasks 2–4
>
> Every SQL statement below is written against the draft's own column names.
> Before running anything, open the ingester plan's migration and rewrite them.
> The known differences, as of 2026-08-15:
>
> | This plan says | The ingester's `0007_play_stream` says | Note |
> |---|---|---|
> | `sequence` (our ordinal, primary key) | `seq` (provider order) **and** `source_id` (ESPN's play id) as the key `(match_id, source_id)` | Their reasoning is sound and better than the draft's: a live match is re-fetched every 20s and plays arrive mid-match, so an ordinal key renumbers on any upstream insertion and rewrites the wrong rows. **Order and paginate on `seq`; do not key on it.** |
> | `play_id` | `source_id` | rename in every statement |
> | `match_play_fidelity` table | `match_play_archive` + `touch_tier bool` | repoint `PlayFidelityFor` at theirs and map their representation onto the `PlayFidelity` response shape, which is a wire contract and does not change |
> | `match_id text`, `player_id text` | `match_id uuid`, `player_id uuid` | **see the blocking note below** |
>
> ### Two blocking questions the executor must resolve, not guess at
>
> **1. `match.id` is `text` on `main`, and the ingester plan writes
> `match_id uuid REFERENCES match(id)`.** A foreign key whose type differs from
> its target's will not create, and Postgres points the error at the wrong file.
> This affects every reader plan that writes a `match_id` foreign key, not just
> this one. Check `match.id`'s actual type first:
>
> ```bash
> cd backend && grep -n "id  *text PRIMARY KEY\|id  *uuid PRIMARY KEY" migrations/0001_init.up.sql
> ```
>
> If it still says `text`, the canonical-identity re-keying has not landed and
> the ingester plan's `uuid` columns are written against a future schema. Do not
> paper over it here — raise it.
>
> **2. ~~Do coordinates exist?~~ RESOLVED — they do.** An earlier draft flagged
> the ingester's `start_x` / `goal_z` columns as contradicting a "no coordinates"
> capability finding. **The finding was wrong; the ingester is right.** Verified
> 2026-08-15: `fieldPositionX/Y`, `fieldPosition2X/Y` and `goalPositionY/Z` are
> present on ~96% of plays. What remains for the executor is only a **naming**
> reconciliation, not an existence question:
>
> | This plan's wire field | Ingester column | Note |
> |---|---|---|
> | `fieldPositionX` / `fieldPositionY` | `start_x` / `start_y` | confirm the `_y` name; only `start_x` was quoted in their test |
> | `fieldPosition2X` / `fieldPosition2Y` | their end-position pair | find the actual names |
> | `goalPositionY` / `goalPositionZ` | `goal_y` / `goal_z` | `goal_z` confirmed |
>
> Their migration test asserts coordinates are **nullable** and fails if any is
> declared `NOT NULL` — for the reason this plan gives in the `Play` struct: a
> `NOT NULL DEFAULT 0` puts every unlocated play at the corner flag. Keep that
> property; do not "tidy" it away.

- [ ] **Step 1: Confirm the schema you are reading against**

```bash
ls backend/migrations
cd backend && grep -rn "CREATE TABLE match_play\|touch_tier\|source_id" migrations/ | head
```

Expected: a `0007_play_stream.up.sql` creating `match_play` keyed
`(match_id, source_id)` plus `match_play_archive` with `touch_tier`.
**If that file does not exist, the ingester's play-stream plan has not landed —
stop and land it first.** There is nothing to read until it does.

Record the answers to both blocking questions above before continuing.

- [ ] **Step 2: Create only the season roll-up**

Create `backend/migrations/0012_player_action_count.up.sql`:

```sql
-- Season action totals, rolled up by the ingester rather than aggregated per
-- request: a season of plays is roughly half a million rows per competition,
-- and a GROUP BY over it is not something a public endpoint should buy with
-- one rate-limit token. The per-MATCH equivalent is aggregated at read time,
-- because ~1,550 rows is cheap; that asymmetry is the whole reason this table
-- exists.
--
-- counts is jsonb keyed by the play type. A type a player never performed is
-- ABSENT, not zero -- the same rule as the per-position box score, because
-- "no take-ons recorded" and "attempted none" are different claims and only
-- one of them is ours to make.
--
-- player_id's type must match player.id. If the canonical-identity re-keying
-- has landed that is uuid; on main today it is text. Task 1 Step 1 settles it.
CREATE TABLE player_action_count (
  comp_id    text NOT NULL,
  season_id  text NOT NULL,
  player_id  text NOT NULL,
  team_id    text,
  matches    int  NOT NULL DEFAULT 0,
  counts     jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comp_id, season_id, player_id)
);
CREATE INDEX player_action_count_player_idx ON player_action_count (player_id);

-- A recomputed season replaces its roll-up wholesale.
GRANT DELETE ON player_action_count TO scorearc_ingester;
```

Create `backend/migrations/0012_player_action_count.down.sql`:

```sql
DROP TABLE IF EXISTS player_action_count;
```

> **Migration numbering.** The ingester ledger owns `0003`–`0010`; `0011` is the
> `api-history` plan's odds table, `0013` is `api-officials`, `0014` is
> `api-commentary-and-shots`. **Run `ls backend/migrations` first** and take the
> next free integer if that has shifted, keeping the `_player_action_count`
> suffix.

Add the up file to `newIntegrationStore`'s migration list in `store_integration_test.go`, and add **both** files to the `files` slice in `migrations_integration_test.go` — the up file last among the ups, the down file first among the downs, so the round-trip still ends at zero tables.

- [ ] **Step 3: Seed against the ingester's column names**

Seed a full-fidelity match and a pruned one in `seedIntegrationData`, so every later task can prove the difference. **The `match_play` inserts below use this plan's draft column names and will not run as written** — rewrite them against `0007_play_stream`'s actual columns (`source_id`, `seq`, and its fidelity representation) using the reconciliation table above. That rewrite is the point of this step; do it once here and Tasks 2–4 follow from it.

```go
		`INSERT INTO match_play
			(match_id, sequence, play_id, type_id, type_key, type_text, text, period,
			 clock_value, clock_display, team_id, player_id, assist_player_id,
			 home_score, away_score, scoring_play, score_value)
		 VALUES
			('match-final', 1, 'p1', '1', 'pass',           'Pass',           'Pass by Messi',      1,  60, '1''',  'arg', 'p-messi',  NULL,       0, 0, false, 0),
			('match-final', 2, 'p2', '2', 'tackle',         'Tackle',         'Tackle by Mbappe',   1, 120, '2''',  'fra', 'p-mbappe', NULL,       0, 0, false, 0),
			('match-final', 3, 'p3', '3', 'take-on',        'Take On',        'Take on by Messi',   1, 180, '3''',  'arg', 'p-messi',  NULL,       0, 0, false, 0),
			('match-final', 4, 'p4', '4', 'shot-on-target', 'Shot On Target', 'Saved shot',         1, 240, '4''',  'arg', 'p-messi',  NULL,       0, 0, false, 0),
			('match-final', 5, 'p5', '5', 'goal',           'Goal',           'Goal! Messi scores', 1, 300, '5''',  'arg', 'p-messi',  'p-di-maria', 1, 0, true,  1),
			('match-final', 6, 'p6', '2', 'tackle',         'Tackle',         'Tackle by Mbappe',   2, 3000, '50''', 'fra', 'p-mbappe', NULL,      1, 0, false, 0)`,
		`INSERT INTO match_play (match_id, sequence, play_id, type_id, type_key, type_text, text, period, team_id, player_id)
		 VALUES ('other-comp', 1, 'q1', '5', 'goal', 'Goal', 'Goal', 1, 'arg', 'p-messi')`,
		`INSERT INTO match_play_fidelity (match_id, tier, play_count, distinct_types, source_pruned, ingested_at)
		 VALUES ('match-final', 'full', 6, 5, false, '2026-07-19T21:00:00Z'),
		        ('other-comp',  'key-events', 1, 1, true, '2026-08-15T09:00:00Z')`,
		`INSERT INTO player_action_count (comp_id, season_id, player_id, team_id, matches, counts)
		 VALUES
			('world-cup', '2026', 'p-messi',  'arg', 1, '{"pass": 41, "take-on": 7, "shot-on-target": 3, "goal": 1}'),
			('world-cup', '2026', 'p-mbappe', 'fra', 1, '{"pass": 33, "tackle": 5}')`,
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestMigrationsRoundTrip|TestStoreIntegration"
```

Expected: both `ok`. The round-trip still ends with zero tables and zero roles.
If the seed fails with `column "sequence" of relation "match_play" does not
exist`, Step 3's rewrite was not done — go back and do it rather than adding the
column.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0012_player_action_count.up.sql backend/migrations/0012_player_action_count.down.sql backend/reader/migrations_integration_test.go backend/reader/store_integration_test.go
git commit -m "feat(db): add the season action roll-up

Per-match action counts aggregate at read time over ~1,550 rows; a
season is roughly half a million per competition and is rolled up
instead. match_play itself belongs to the ingester's 0007_play_stream --
this plan reads it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fidelity, and the paginated play read

**Files:**
- Create: `backend/reader/store_plays.go`, `backend/reader/handlers_plays.go`
- Modify: `backend/reader/types.go`, `backend/reader/params.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/params_test.go`

**Interfaces:**
- `Store.PlayFidelityFor(ctx, matchID string) (PlayFidelity, error)`
- `Store.Plays(ctx, matchID string, filter PlayFilter) ([]Play, error)`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParsePlayParameters(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"pass", "shot-on-target", "take-on", "ball-touch"} {
		if got, err := parsePlayType(raw); err != nil || got != raw {
			t.Fatalf("type %q = %q, err %v", raw, got, err)
		}
	}
	if got, err := parsePlayType(""); err != nil || got != "" {
		t.Fatalf("absent type = %q, err %v", got, err)
	}
	// The type is bound as a parameter, so an unknown one would return an
	// empty page rather than an error. That is worse than a 400: a caller
	// cannot tell a typo from a quiet match.
	for _, raw := range []string{"Pass", "shot_on_target", "pass;drop", "xG", "shot on target"} {
		if _, err := parsePlayType(raw); err == nil {
			t.Fatalf("type %q was accepted", raw)
		}
	}

	for raw, want := range map[string]int{"": 0, "1": 1, "2": 2, "5": 5} {
		if got, err := parsePeriod(raw); err != nil || got != want {
			t.Fatalf("period %q = %d, err %v", raw, got, err)
		}
	}
	for _, raw := range []string{"0", "8", "-1", "first", "1.5"} {
		if _, err := parsePeriod(raw); err == nil {
			t.Fatalf("period %q was accepted", raw)
		}
	}

	if got, err := parseAfterSequence(""); err != nil || got != 0 {
		t.Fatalf("absent cursor = %d, err %v", got, err)
	}
	if got, err := parseAfterSequence("500"); err != nil || got != 500 {
		t.Fatalf("cursor = %d, err %v", got, err)
	}
	for _, raw := range []string{"-1", "abc", "1e3", "999999999999"} {
		if _, err := parseAfterSequence(raw); err == nil {
			t.Fatalf("cursor %q was accepted", raw)
		}
	}
}
```

Append to `backend/reader/store_integration_test.go`:

```go
func TestStorePlays(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("plays come back in sequence order", func(t *testing.T) {
		plays, err := store.Plays(ctx, "match-final", PlayFilter{Limit: 500})
		if err != nil {
			t.Fatal(err)
		}
		if len(plays) != 6 || plays[0].Sequence != 1 || plays[5].Sequence != 6 {
			t.Fatalf("plays = %+v", plays)
		}
		if plays[4].TypeKey != "goal" || !plays[4].ScoringPlay || plays[4].AssistPlayerID == nil {
			t.Fatalf("goal play = %+v", plays[4])
		}
		// A play with no assisting player must be null, not an empty string:
		// "nobody assisted" and "we do not know who" are the same absence, and
		// "" would look like a named player whose name we lost.
		if plays[0].AssistPlayerID != nil {
			t.Fatalf("absent assist materialised: %+v", plays[0])
		}
	})

	t.Run("the cursor is keyset, not offset", func(t *testing.T) {
		first, err := store.Plays(ctx, "match-final", PlayFilter{Limit: 2})
		if err != nil || len(first) != 2 || first[1].Sequence != 2 {
			t.Fatalf("page one = %+v, err %v", first, err)
		}
		second, err := store.Plays(ctx, "match-final", PlayFilter{After: 2, Limit: 2})
		if err != nil || len(second) != 2 || second[0].Sequence != 3 {
			t.Fatalf("page two = %+v, err %v", second, err)
		}
		// Walking to the end returns fewer than the limit, which is how the
		// handler knows there is no next cursor.
		last, err := store.Plays(ctx, "match-final", PlayFilter{After: 4, Limit: 500})
		if err != nil || len(last) != 2 {
			t.Fatalf("final page = %+v, err %v", last, err)
		}
	})

	t.Run("type and period filters", func(t *testing.T) {
		tackles, err := store.Plays(ctx, "match-final", PlayFilter{TypeKey: "tackle", Limit: 500})
		if err != nil || len(tackles) != 2 {
			t.Fatalf("tackles = %+v, err %v", tackles, err)
		}
		second, err := store.Plays(ctx, "match-final", PlayFilter{Period: 2, Limit: 500})
		if err != nil || len(second) != 1 || second[0].Sequence != 6 {
			t.Fatalf("second half = %+v, err %v", second, err)
		}
		byPlayer, err := store.Plays(ctx, "match-final", PlayFilter{PlayerID: "p-mbappe", Limit: 500})
		if err != nil || len(byPlayer) != 2 {
			t.Fatalf("player plays = %+v, err %v", byPlayer, err)
		}
	})

	t.Run("fidelity distinguishes a pruned match from a quiet one", func(t *testing.T) {
		full, err := store.PlayFidelityFor(ctx, "match-final")
		if err != nil || full.Tier != "full" || full.SourcePruned || full.PlayCount != 6 {
			t.Fatalf("full fidelity = %+v, err %v", full, err)
		}
		pruned, err := store.PlayFidelityFor(ctx, "other-comp")
		if err != nil || pruned.Tier != "key-events" || !pruned.SourcePruned {
			t.Fatalf("pruned fidelity = %+v, err %v", pruned, err)
		}
		// A match we have never ingested plays for is tier "none" with a note,
		// not an error - the caller still gets an answer about what we hold.
		unknown, err := store.PlayFidelityFor(ctx, "match-semi")
		if err != nil || unknown.Tier != "none" || unknown.PlayCount != 0 {
			t.Fatalf("unknown fidelity = %+v, err %v", unknown, err)
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestParsePlayParameters|TestStorePlays"
```

Expected: FAIL — `undefined: parsePlayType`, `undefined: PlayFilter`, `store.Plays undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/params.go`:

```go
const (
	defaultPlayLimit = 200
	maxPlayLimit     = 500
	maxPeriod        = 7 // 90 minutes, extra time, and a shootout
)

// playTypes is the observed type vocabulary from the 2026-08-15 probe. The
// value is bound as a SQL parameter, so this list is not what stands between
// us and injection - it is what turns a typo into a 400 rather than an empty
// page, and a caller cannot tell an empty page from a quiet match.
var playTypes = map[string]bool{
	"pass": true, "foul": true, "free-kick": true, "aerial": true, "clear": true,
	"ball-touch": true, "throw-in": true, "dispossessed": true, "tackle": true,
	"blocked-pass": true, "cross": true, "corner-awarded": true, "take-on": true,
	"shot-blocked": true, "shot-on-target": true, "shot-off-target": true,
	"assists-shot": true, "assist": true, "goal": true, "save": true,
	"offside": true, "interception": true, "substitution": true,
	"period-start": true, "period-end": true,
}

var (
	errPlayType = errors.New("type is not a recognised play type")
	errPeriod   = errors.New("period must be an integer between 1 and 7")
	errCursor   = errors.New("after must be a non-negative integer sequence")
)

// parsePlayType validates ?type=. Empty means every type.
func parsePlayType(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if !playTypes[raw] {
		return "", errPlayType
	}
	return raw, nil
}

// parsePeriod validates ?period=. Zero means every period.
func parsePeriod(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxPeriod {
		return 0, errPeriod
	}
	return value, nil
}

// parseAfterSequence validates the keyset cursor. Zero means "from the start",
// which is also what an absent cursor means - the sequence is 1-based
// precisely so that zero can carry that meaning without a pointer.
func parseAfterSequence(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > 1_000_000 {
		return 0, errCursor
	}
	return value, nil
}
```

Append to `backend/reader/types.go`:

```go
// PlayFidelity states what we hold for one match. It is on every play-derived
// response and is not optional: ESPN prunes the touch tier for older fixtures,
// so a thin result must announce itself rather than read as a quiet match.
type PlayFidelity struct {
	Tier          string  `json:"tier"` // full | key-events | none
	PlayCount     int     `json:"playCount"`
	DistinctTypes int     `json:"distinctTypes"`
	SourcePruned  bool    `json:"sourcePruned"`
	IngestedAt    *string `json:"ingestedAt"`
	Note          string  `json:"note"`
}

// Play is one touch-level event.
type Play struct {
	Sequence       int     `json:"sequence"`
	PlayID         string  `json:"playId"`
	TypeKey        string  `json:"typeKey"`  // filterable slug, e.g. "shot-blocked"
	TypeText       string  `json:"typeText"` // display text, e.g. "Shot Blocked"
	Text           string  `json:"text"`
	Period         int     `json:"period"`
	ClockValue     *int    `json:"clockValue"` // seconds
	ClockDisplay   string  `json:"clockDisplay"`
	Wallclock      *string `json:"wallclock"`
	TeamID         *string `json:"teamId"`
	PlayerID       *string `json:"playerId"`
	AssistPlayerID *string `json:"assistPlayerId"`
	HomeScore      *int    `json:"homeScore"`
	AwayScore      *int    `json:"awayScore"`
	ScoringPlay    bool    `json:"scoringPlay"`
	ScoreValue     int     `json:"scoreValue"`

	// Geometry. All six are nullable and roughly 96% populated on a live
	// competition (979/1000 on Liga MX event 401877018, 955/1000 on LaLiga
	// 401882926, measured 2026-08-15). Serve null when absent - a play we could
	// not locate must not be placed at the corner flag, which is exactly what a
	// zero default would do.
	//
	// fieldPosition* are pitch coordinates: 1 and 2 are where the action starts
	// and ends. goalPosition* locate a shot within the goal mouth and are
	// present on shot-type plays only.
	FieldPositionX  *float64 `json:"fieldPositionX"`
	FieldPositionY  *float64 `json:"fieldPositionY"`
	FieldPosition2X *float64 `json:"fieldPosition2X"`
	FieldPosition2Y *float64 `json:"fieldPosition2Y"`
	GoalPositionY   *float64 `json:"goalPositionY"`
	GoalPositionZ   *float64 `json:"goalPositionZ"`

	OwnGoal        bool    `json:"ownGoal"`
	PenaltyKick    bool    `json:"penaltyKick"`
	RedCard        bool    `json:"redCard"`
	YellowCard     bool    `json:"yellowCard"`
	Substitution   bool    `json:"substitution"`
	Shootout       bool    `json:"shootout"`
}

// PlayPage is one keyset page. NextAfter is null on the last page, so a caller
// walks until it is null rather than guessing from a count.
type PlayPage struct {
	MatchID   string       `json:"matchId"`
	Fidelity  PlayFidelity `json:"fidelity"`
	Plays     []Play       `json:"plays"`
	NextAfter *int         `json:"nextAfter"`
}
```

Create `backend/reader/store_plays.go`:

```go
package main

import (
	"context"
	"time"
)

// PlayFilter is the validated shape of the /plays query string.
type PlayFilter struct {
	TypeKey  string
	PlayerID string
	Period   int
	After    int // exclusive keyset cursor on sequence; 0 means from the start
	Limit    int
}

const playsSQL = `
SELECT sequence, play_id, type_key, type_text, text, period,
       clock_value, clock_display, wallclock,
       team_id, player_id, assist_player_id,
       home_score, away_score, scoring_play, score_value,
       own_goal, penalty_kick, red_card, yellow_card, substitution, shootout
FROM match_play
WHERE match_id = $1
  AND sequence > $2
  AND ($3::text IS NULL OR type_key = $3)
  AND ($4::text IS NULL OR player_id = $4)
  AND ($5::int  IS NULL OR period = $5)
ORDER BY sequence
LIMIT $6`

func (s *Store) Plays(ctx context.Context, matchID string, filter PlayFilter) ([]Play, error) {
	var typeKey, playerID, period any
	if filter.TypeKey != "" {
		typeKey = filter.TypeKey
	}
	if filter.PlayerID != "" {
		playerID = filter.PlayerID
	}
	if filter.Period != 0 {
		period = filter.Period
	}
	rows, err := s.db.Query(ctx, playsSQL,
		matchID, filter.After, typeKey, playerID, period, filter.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	plays := make([]Play, 0, filter.Limit)
	for rows.Next() {
		var play Play
		var wallclock *time.Time
		if err := rows.Scan(
			&play.Sequence, &play.PlayID, &play.TypeKey, &play.TypeText, &play.Text, &play.Period,
			&play.ClockValue, &play.ClockDisplay, &wallclock,
			&play.TeamID, &play.PlayerID, &play.AssistPlayerID,
			&play.HomeScore, &play.AwayScore, &play.ScoringPlay, &play.ScoreValue,
			&play.OwnGoal, &play.PenaltyKick, &play.RedCard, &play.YellowCard,
			&play.Substitution, &play.Shootout,
		); err != nil {
			return nil, err
		}
		if wallclock != nil {
			stamp := isoTime(*wallclock)
			play.Wallclock = &stamp
		}
		plays = append(plays, play)
	}
	return plays, rows.Err()
}

// Reads the ingester's fidelity representation, NOT a table this plan creates.
// 0007_play_stream expresses it as match_play_archive plus a touch_tier bool;
// rewrite this statement against those columns per Task 1's reconciliation
// table, and map their representation onto PlayFidelity, which is a wire
// contract and does not change.
const playFidelitySQL = `
SELECT tier, play_count, distinct_types, source_pruned, ingested_at
FROM match_play_fidelity
WHERE match_id = $1`

// fidelityNotes are the sentences a consumer shows verbatim. They live here
// rather than in the UI because the API is the thing that knows why a result
// is thin, and every consumer would otherwise invent its own wording for it.
var fidelityNotes = map[string]string{
	"full":       "Full touch-level plays are held for this match.",
	"key-events": "Only key events are held for this match; the provider had already pruned the touch-level tier when it was ingested.",
	"none":       "No plays are held for this match.",
}

func (s *Store) PlayFidelityFor(ctx context.Context, matchID string) (PlayFidelity, error) {
	var fidelity PlayFidelity
	var ingestedAt time.Time
	err := s.db.QueryRow(ctx, playFidelitySQL, matchID).Scan(
		&fidelity.Tier, &fidelity.PlayCount, &fidelity.DistinctTypes,
		&fidelity.SourcePruned, &ingestedAt,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Never ingested is a real, reportable state - the caller asked what we
		// hold, and "nothing" is an answer, not an error.
		return PlayFidelity{Tier: "none", Note: fidelityNotes["none"]}, nil
	case err != nil:
		return PlayFidelity{}, err
	}
	stamp := isoTime(ingestedAt)
	fidelity.IngestedAt = &stamp
	fidelity.Note = fidelityNotes[fidelity.Tier]
	return fidelity, nil
}
```

Add `"errors"` and `"github.com/jackc/pgx/v5"` to that file's imports.

Create `backend/reader/handlers_plays.go`:

```go
package main

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// playAggregateCost is charged on top of the router-level token for the two
// endpoints that aggregate rather than page. A page is bounded at 500 rows; an
// aggregate walks a whole match or a whole season.
const playAggregateCost = 1

func (a *App) handlePlays(writer http.ResponseWriter, request *http.Request) {
	matchID, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	query := request.URL.Query()
	filter := PlayFilter{}

	if filter.TypeKey, err = parsePlayType(query.Get("type")); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if raw := query.Get("player"); raw != "" {
		if filter.PlayerID, err = parseEntityID(raw); err != nil {
			writeError(writer, http.StatusBadRequest, err.Error())
			return
		}
	}
	if filter.Period, err = parsePeriod(query.Get("period")); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if filter.After, err = parseAfterSequence(query.Get("after")); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := parseLimit(query.Get("limit"), maxPlayLimit)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	filter.Limit = defaultPlayLimit
	if limit != nil {
		filter.Limit = *limit
	}

	fidelity, err := a.store.PlayFidelityFor(request.Context(), matchID)
	if err != nil {
		a.logger.Error("play fidelity", "match", matchID, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	plays, err := a.store.Plays(request.Context(), matchID, filter)
	if err != nil {
		a.logger.Error("plays", "match", matchID, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}

	page := PlayPage{MatchID: matchID, Fidelity: fidelity, Plays: plays}
	if page.Plays == nil {
		page.Plays = []Play{}
	}
	// A full page implies there may be more. A short page is the end, which is
	// why the cursor is null rather than the last sequence: a caller walks
	// until nextAfter is null and never has to compare counts.
	if len(page.Plays) == filter.Limit && filter.Limit > 0 {
		next := page.Plays[len(page.Plays)-1].Sequence
		page.NextAfter = &next
	}
	// Plays accumulate while a match is live and are immutable after it.
	cacheFor(writer, liveMaxAge(fidelity.Tier != "none" && page.NextAfter != nil))
	writeJSON(writer, http.StatusOK, page)
}

var _ = errors.Is // retained for the handlers added in Tasks 3 and 4
```

> **On the cache heuristic.** `liveMaxAge` is keyed on whether more pages exist,
> not on match state, because the reader does not join `match` here and a
> mid-walk page is the case where a short TTL actually matters. If Task 4's
> review prefers the true match state, join it — but do not leave both.

In `server.go`, add `Plays(context.Context, string, PlayFilter) ([]Play, error)` and `PlayFidelityFor(context.Context, string) (PlayFidelity, error)` to `readerStore`, and register `router.Get("/matches/{id}/plays", a.handlePlays)`. Mirror both onto `fakeReaderStore`.

In `openapi.yaml`, add a `PlayType`, `PlayerFilter`, `Period` and `After` parameter, the `PlayFidelity`, `Play` and `PlayPage` schemas (every property in `required`, `additionalProperties: false`), and the path with `LiveCacheControl`. Add `{target: "/v1/matches/1/plays", template: "/v1/matches/{id}/plays"}` to the `openapi_test.go` route table and seed the fake with one play and a `full` fidelity.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve the play stream with keyset pagination

1,542 plays is four pages, never one response: a single unpaginated
response would be 400 KB bought with one rate-limit token. Every page
carries the match's fidelity, because ESPN prunes the touch tier for
older fixtures and a thin result must announce itself rather than read
as a quiet match.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Play types and per-match action counts

**Files:**
- Modify: `backend/reader/store_plays.go`, `backend/reader/handlers_plays.go`, `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`

**Why `/plays/types` exists.** `?type=` is only useful if a caller can discover what types a match actually contains, and the vocabulary varies by competition — the CONCACAF match with 55 plays does not carry the 25 types the Liga MX match does. Twenty-five small rows makes filtering discoverable without downloading four pages to find out.

- [ ] **Step 1: Write the failing test**

```go
func TestStorePlayTypesAndActions(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("play types come back with counts, most frequent first", func(t *testing.T) {
		types, err := store.PlayTypes(ctx, "match-final")
		if err != nil {
			t.Fatal(err)
		}
		if len(types) != 5 {
			t.Fatalf("types = %+v", types)
		}
		if types[0].TypeKey != "tackle" || types[0].Count != 2 || types[0].TypeText != "Tackle" {
			t.Fatalf("most frequent type = %+v", types[0])
		}
	})

	t.Run("per-match actions group by player and team", func(t *testing.T) {
		actions, err := store.MatchActions(ctx, "match-final")
		if err != nil {
			t.Fatal(err)
		}
		byPlayer := map[string]PlayerActionCounts{}
		for _, entry := range actions {
			byPlayer[entry.PlayerID] = entry
		}
		messi := byPlayer["p-messi"]
		if messi.TeamID == nil || *messi.TeamID != "arg" || messi.Total != 4 {
			t.Fatalf("messi = %+v", messi)
		}
		if messi.Counts["take-on"] != 1 || messi.Counts["pass"] != 1 {
			t.Fatalf("messi counts = %+v", messi.Counts)
		}
		// A type the player never performed is ABSENT from the map, not zero.
		// "No take-ons recorded" and "attempted none" are different claims and
		// only one of them is ours to make.
		if _, present := messi.Counts["tackle"]; present {
			t.Fatalf("a zero was materialised: %+v", messi.Counts)
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStorePlayTypesAndActions
```

Expected: FAIL — `store.PlayTypes undefined`, `store.MatchActions undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
type PlayTypeCount struct {
	TypeKey  string `json:"typeKey"`
	TypeText string `json:"typeText"`
	Count    int    `json:"count"`
}

// PlayerActionCounts is one player's touches in one match, keyed by play type.
// Counts omits any type the player did not perform - absence means "not
// recorded", and writing a zero would turn that into a measurement.
type PlayerActionCounts struct {
	PlayerID string         `json:"playerId"`
	Player   *string        `json:"player"` // null until the player table is populated
	TeamID   *string        `json:"teamId"`
	Total    int            `json:"total"`
	Counts   map[string]int `json:"counts"`
}

type MatchActions struct {
	MatchID  string               `json:"matchId"`
	Fidelity PlayFidelity         `json:"fidelity"`
	Players  []PlayerActionCounts `json:"players"`
}
```

Append to `backend/reader/store_plays.go`:

```go
const playTypesSQL = `
SELECT type_key, min(type_text) AS type_text, count(*)::int AS plays
FROM match_play
WHERE match_id = $1
GROUP BY type_key
ORDER BY plays DESC, type_key`

func (s *Store) PlayTypes(ctx context.Context, matchID string) ([]PlayTypeCount, error) {
	rows, err := s.db.Query(ctx, playTypesSQL, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	types := make([]PlayTypeCount, 0)
	for rows.Next() {
		var entry PlayTypeCount
		if err := rows.Scan(&entry.TypeKey, &entry.TypeText, &entry.Count); err != nil {
			return nil, err
		}
		types = append(types, entry)
	}
	return types, rows.Err()
}

// A match holds at most ~1,550 plays across ~40 players, so this aggregates at
// read time. The season equivalent does not, and that asymmetry is deliberate:
// see player_action_count's comment in 0012.
//
// The LEFT JOIN on player is soft: the api-players plan populates that table,
// and until it does every name is null rather than the endpoint failing.
const matchActionsSQL = `
SELECT p.player_id, pl.name, p.team_id, p.type_key, count(*)::int AS plays
FROM match_play p
LEFT JOIN player pl ON pl.id = p.player_id
WHERE p.match_id = $1 AND p.player_id IS NOT NULL
GROUP BY p.player_id, pl.name, p.team_id, p.type_key
ORDER BY p.player_id, p.type_key`

func (s *Store) MatchActions(ctx context.Context, matchID string) ([]PlayerActionCounts, error) {
	rows, err := s.db.Query(ctx, matchActionsSQL, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	players := make([]PlayerActionCounts, 0)
	index := make(map[string]int)
	for rows.Next() {
		var playerID, typeKey string
		var name, teamID *string
		var count int
		if err := rows.Scan(&playerID, &name, &teamID, &typeKey, &count); err != nil {
			return nil, err
		}
		position, exists := index[playerID]
		if !exists {
			players = append(players, PlayerActionCounts{
				PlayerID: playerID, Player: name, TeamID: teamID,
				Counts: map[string]int{},
			})
			position = len(players) - 1
			index[playerID] = position
		}
		players[position].Counts[typeKey] = count
		players[position].Total += count
	}
	return players, rows.Err()
}
```

> **A note on the `player` join.** If the `api-players` plan has not landed,
> `player` does not exist and this statement fails at query time rather than at
> build time. Either land that plan first, or drop the join and the `Player`
> field together — do not leave a join against a table that may be absent.

Add `handlePlayTypes` and `handleMatchActions` to `handlers_plays.go`, both validating the id with `parseEntityID`, both attaching `PlayFidelityFor`, and `handleMatchActions` charging `playAggregateCost` via `a.limiter.AllowCost(clientIP(request), playAggregateCost)`. Cache both with `cacheFor(writer, 60)`. Register:

```go
			router.Get("/matches/{id}/plays/types", a.handlePlayTypes)
			router.Get("/matches/{id}/actions", a.handleMatchActions)
```

> chi matches `/matches/{id}/plays/types` before `/matches/{id}/plays` because
> the longer pattern is more specific; both are static after the wildcard, so no
> ordering trick is needed. Register them adjacently anyway so a reader sees the
> pair.

Extend `readerStore` and `fakeReaderStore`, and add both paths, the `PlayTypeCount`, `PlayerActionCounts` and `MatchActions` schemas and both `openapi_test.go` table entries.

> **`Counts` is a `map[string]int` and therefore an open object.** The OpenAPI
> schema for it is `{type: object, additionalProperties: {type: integer}}` — the
> one place in this API where `additionalProperties` is not `false`, because the
> key set is data rather than contract. `TestOpenAPIObjectSchemasAreExact` only
> inspects schemas that declare `properties`, so a pure `additionalProperties`
> map does not trip it; verify that when you run the test rather than assuming.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`. If `TestOpenAPIObjectSchemasAreExact` flags the counts map, give it an explicit empty `properties: {}` and an empty `required: []` alongside the `additionalProperties` schema rather than weakening the test.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve play types and per-match action counts

Tackles, interceptions, take-ons, aerials and dispossessions per player
per match - none of which is reachable from any endpoint ScoreArc has
today. A type a player did not perform is absent from the map, never
zero: absence means not recorded, and a zero would make it a
measurement.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Season action totals, the action leaderboard, and coverage

**Files:**
- Modify: `backend/reader/store_plays.go`, `backend/reader/handlers_plays.go`, `backend/reader/types.go`, `backend/reader/params.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/params_test.go`

**This is the differentiator.** A "most take-ons in Liga MX" board does not exist on any free service. It exists here because we keep the plays.

- [ ] **Step 1: Write the failing test**

```go
func TestStoreSeasonActions(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("a player's season totals", func(t *testing.T) {
		actions, err := store.PlayerSeasonActions(ctx, "world-cup", "2026", "p-messi")
		if err != nil {
			t.Fatal(err)
		}
		if actions.Matches != 1 || actions.Counts["take-on"] != 7 || actions.Total != 52 {
			t.Fatalf("messi season = %+v", actions)
		}
		if _, missing := actions.Counts["tackle"]; missing {
			t.Fatalf("a zero was materialised: %+v", actions.Counts)
		}
		if _, err := store.PlayerSeasonActions(ctx, "world-cup", "2026", "nobody"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown player error = %v, want ErrNotFound", err)
		}
	})

	t.Run("the leaderboard ranks by one action type", func(t *testing.T) {
		leaders, err := store.ActionLeaders(ctx, "world-cup", "2026", "pass", 50)
		if err != nil {
			t.Fatal(err)
		}
		if len(leaders) != 2 || leaders[0].PlayerID != "p-messi" || leaders[0].Value != 41 {
			t.Fatalf("pass leaders = %+v", leaders)
		}
		// A player with no rows for the metric is excluded, not listed on
		// zero: a leaderboard of people who did not do a thing is not a
		// leaderboard.
		tackles, err := store.ActionLeaders(ctx, "world-cup", "2026", "tackle", 50)
		if err != nil || len(tackles) != 1 || tackles[0].PlayerID != "p-mbappe" {
			t.Fatalf("tackle leaders = %+v, err %v", tackles, err)
		}
	})

	t.Run("coverage reports what fidelity a season holds", func(t *testing.T) {
		coverage, err := store.PlayCoverage(ctx, "world-cup", "2026")
		if err != nil {
			t.Fatal(err)
		}
		if coverage.SeasonMatches != 5 {
			t.Fatalf("season matches = %d", coverage.SeasonMatches)
		}
		byTier := map[string]int{}
		for _, tier := range coverage.Tiers {
			byTier[tier.Tier] = tier.Matches
		}
		if byTier["full"] != 1 {
			t.Fatalf("tiers = %+v", coverage.Tiers)
		}
		// Matches with no fidelity row at all are counted, not omitted: an
		// unmeasured match is the honest majority early on and hiding it would
		// make coverage look complete.
		if coverage.Unmeasured != 4 {
			t.Fatalf("unmeasured = %d", coverage.Unmeasured)
		}
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestStoreSeasonActions
```

Expected: FAIL — `store.PlayerSeasonActions undefined`, `store.ActionLeaders undefined`, `store.PlayCoverage undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/params.go`:

```go
const (
	defaultActionLeaderLimit = 50
	maxActionLeaderLimit     = 200
)

// parseActionMetric validates ?metric= on the action leaderboard. It shares
// the play-type vocabulary because an action IS a play type - a second list
// would be two things to keep in step.
func parseActionMetric(raw string) (string, error) {
	if raw == "" {
		return "", errPlayType
	}
	return parsePlayType(raw)
}
```

> `metric` is required rather than defaulted. There is no obvious default
> action, and silently ranking by passes would be a choice the caller did not
> make and cannot see.

Append to `backend/reader/types.go`:

```go
type PlayerSeasonActions struct {
	CompID   string         `json:"compId"`
	SeasonID string         `json:"seasonId"`
	PlayerID string         `json:"playerId"`
	TeamID   *string        `json:"teamId"`
	Matches  int            `json:"matches"`
	Total    int            `json:"total"`
	Counts   map[string]int `json:"counts"`
}

type ActionLeader struct {
	Rank        int      `json:"rank"`
	PlayerID    string   `json:"playerId"`
	Player      *string  `json:"player"`
	TeamID      *string  `json:"teamId"`
	Metric      string   `json:"metric"`
	Value       int      `json:"value"`
	Matches     int      `json:"matches"`
	PerMatch    *float64 `json:"perMatch"`
}

type PlayCoverageTier struct {
	Tier    string `json:"tier"`
	Matches int    `json:"matches"`
}

// PlayCoverage is the season-level honesty report. Unmeasured is matches with
// no fidelity row at all, which is the majority early on and must be visible.
type PlayCoverage struct {
	CompID        string             `json:"compId"`
	SeasonID      string             `json:"seasonId"`
	SeasonMatches int                `json:"seasonMatches"`
	Unmeasured    int                `json:"unmeasured"`
	Tiers         []PlayCoverageTier `json:"tiers"`
}
```

Append to `backend/reader/store_plays.go`:

```go
const playerSeasonActionsSQL = `
SELECT team_id, matches, counts
FROM player_action_count
WHERE comp_id = $1 AND season_id = $2 AND player_id = $3`

func (s *Store) PlayerSeasonActions(ctx context.Context, competition, season, playerID string) (PlayerSeasonActions, error) {
	actions := PlayerSeasonActions{
		CompID: competition, SeasonID: season, PlayerID: playerID,
		Counts: map[string]int{},
	}
	var counts []byte
	err := s.db.QueryRow(ctx, playerSeasonActionsSQL, competition, season, playerID).
		Scan(&actions.TeamID, &actions.Matches, &counts)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return PlayerSeasonActions{}, ErrNotFound
	case err != nil:
		return PlayerSeasonActions{}, err
	}
	if err := jsonInto(counts, &actions.Counts); err != nil {
		return PlayerSeasonActions{}, err
	}
	for _, count := range actions.Counts {
		actions.Total += count
	}
	return actions, nil
}

// The metric is a jsonb key bound as $3, never concatenated. jsonb_typeof
// guards the cast so one badly typed roll-up cannot 500 a whole leaderboard,
// and the same guard in the WHERE clause is what excludes a player who has no
// entry for the metric rather than listing them on zero.
const actionLeadersSQL = `
SELECT a.player_id, pl.name, a.team_id, a.matches,
       (a.counts ->> $3::text)::int AS value
FROM player_action_count a
LEFT JOIN player pl ON pl.id = a.player_id
WHERE a.comp_id = $1 AND a.season_id = $2
  AND jsonb_typeof(a.counts -> $3::text) = 'number'
ORDER BY value DESC, a.player_id
LIMIT $4`

func (s *Store) ActionLeaders(ctx context.Context, competition, season, metric string, limit int) ([]ActionLeader, error) {
	rows, err := s.db.Query(ctx, actionLeadersSQL, competition, season, metric, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	leaders := make([]ActionLeader, 0)
	for rows.Next() {
		leader := ActionLeader{Metric: metric}
		if err := rows.Scan(&leader.PlayerID, &leader.Player, &leader.TeamID, &leader.Matches, &leader.Value); err != nil {
			return nil, err
		}
		leader.Rank = len(leaders) + 1
		if leader.Matches > 0 {
			rate := float64(leader.Value) / float64(leader.Matches)
			leader.PerMatch = &rate
		}
		leaders = append(leaders, leader)
	}
	return leaders, rows.Err()
}

const playCoverageSQL = `
SELECT count(*)::int AS season_matches,
       count(*) FILTER (WHERE f.match_id IS NULL)::int AS unmeasured
FROM match m
LEFT JOIN match_play_fidelity f ON f.match_id = m.id -- rewrite: see Task 1
WHERE m.comp_id = $1 AND m.season_id = $2`

const playCoverageTiersSQL = `
SELECT f.tier, count(*)::int
FROM match m
JOIN match_play_fidelity f ON f.match_id = m.id -- rewrite: see Task 1
WHERE m.comp_id = $1 AND m.season_id = $2
GROUP BY f.tier
ORDER BY f.tier`

func (s *Store) PlayCoverage(ctx context.Context, competition, season string) (PlayCoverage, error) {
	coverage := PlayCoverage{CompID: competition, SeasonID: season, Tiers: []PlayCoverageTier{}}
	if err := s.db.QueryRow(ctx, playCoverageSQL, competition, season).
		Scan(&coverage.SeasonMatches, &coverage.Unmeasured); err != nil {
		return PlayCoverage{}, err
	}
	rows, err := s.db.Query(ctx, playCoverageTiersSQL, competition, season)
	if err != nil {
		return PlayCoverage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var tier PlayCoverageTier
		if err := rows.Scan(&tier.Tier, &tier.Matches); err != nil {
			return PlayCoverage{}, err
		}
		coverage.Tiers = append(coverage.Tiers, tier)
	}
	return coverage, rows.Err()
}
```

Add three handlers to `handlers_plays.go`:

- `handlePlayerSeasonActions` — resolves the competition, validates `{playerId}` with `parseEntityID`, maps `ErrNotFound` to a 404 `"no action counts held for this player in this competition season"`, caches 300.
- `handleActionLeaders` — resolves the competition, requires `?metric=` via `parseActionMetric`, takes `?limit=` through `parseLimit(raw, maxActionLeaderLimit)` defaulting to `defaultActionLeaderLimit`, charges `playAggregateCost`, caches 300.
- `handlePlayCoverage` — resolves the competition, caches 300.

Register:

```go
			router.Get("/competitions/{comp}/{season}/players/{playerId}/actions", a.handlePlayerSeasonActions)
			router.Get("/competitions/{comp}/{season}/actions", a.handleActionLeaders)
			router.Get("/competitions/{comp}/{season}/plays/coverage", a.handlePlayCoverage)
```

> The first route shares its prefix with the `api-players` plan's
> `/competitions/{comp}/{season}/players/{playerId}` and `/game-log`. chi handles
> the three fine, but whichever plan lands second must check that all three are
> registered and that none was lost to a copy-paste — a missing route is a 404
> that looks like missing data.

Extend `readerStore` and `fakeReaderStore`, and add all three paths, the four new schemas, a `Metric` parameter, and three `openapi_test.go` table entries.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/
git commit -m "feat(reader): serve season action totals, leaderboards and coverage

A most-take-ons board does not exist on any free service; it exists here
because we keep the plays. Coverage counts unmeasured matches rather than
omitting them, since that is the honest majority early on and hiding it
would make coverage look complete.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Docs, full gate and PR

- [ ] **Step 1: Document**

Append to `backend/reader/README.md`:

```markdown
## Play stream

| Endpoint | Serves |
|---|---|
| `/v1/matches/{id}/plays` | the touch-level stream, keyset paged |
| `/v1/matches/{id}/plays/types` | which play types this match contains |
| `/v1/matches/{id}/actions` | per-player action counts for one match |
| `/v1/competitions/{comp}/{season}/players/{playerId}/actions` | a player's season totals |
| `/v1/competitions/{comp}/{season}/actions?metric=` | the season action leaderboard |
| `/v1/competitions/{comp}/{season}/plays/coverage` | what fidelity the season holds |

**Pagination.** `/plays` returns at most 500 rows. Walk it with
`?after=<sequence>` until `nextAfter` is `null`. There is no unpaginated form: a
1,542-play match is roughly 400 KB, and offering it in one response would make
the cheapest request in the API the most expensive one served.

**Fidelity is on every play-derived response.** ESPN prunes the touch-level tier
for older matches, so our store holds full plays only from the date ingestion
started forward. `fidelity.tier` is `full`, `key-events` or `none`, and
`fidelity.note` is a sentence a consumer can show verbatim. A thin result
announces itself; it never reads as a quiet match.

**Absent counts are absent.** `counts` omits any play type a player did not
perform. A missing key means "not recorded"; it is not a zero.

`/matches/{id}/actions` and `/competitions/{comp}/{season}/actions` charge 2
tokens against the per-IP bucket instead of 1, because they aggregate rather
than page.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. Docker must be running.

- [ ] **Step 3: Verify by hand**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/401863609/plays?type=Pass"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/401863609/plays?period=9"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/401863609/plays?after=-1"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/liga-mx/2026-27/actions"
curl -s "http://localhost:8080/v1/matches/401863609/plays?limit=2" | head -c 600
curl -s "http://localhost:8080/v1/competitions/liga-mx/2026-27/plays/coverage"
```

Expected: `400` (capital `Pass` is not the slug), `400`, `400`, `400` (metric is
required), then a page with `fidelity`, two plays and a non-null `nextAfter`,
then a coverage object whose `unmeasured` is honest about how much of the season
predates ingestion.

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document the play stream surface and its caps

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-play-stream
gh pr create --title "feat(reader): the touch-level play stream and action counts" --body "$(cat <<'EOF'
## What

Six endpoints over ESPN's core-host play feed: the paginated stream itself, its
type vocabulary, per-match action counts, a player's season totals, a season
action leaderboard, and a coverage report.

Verified live 2026-08-15: Liga MX 1,542 plays per match · MLS 1,484 · Leagues
Cup 1,318 · LaLiga 1,235 · **CONCACAF Champions Cup 55**.

Tackles, interceptions, take-ons, aerials and dispossessions are not reachable
from any endpoint ScoreArc has today, and the coverage is strongest on Liga MX
and MLS — exactly where free providers stop.

## Approach

**Pagination is not optional.** 1,542 plays is roughly 400 KB. Served in one
response it would be the cheapest request in the API to make and the most
expensive to serve, bought with a single rate-limit token. `/plays` is keyset
paged on our own `sequence` column — not on ESPN's opaque play id, because a
cursor must survive the provider renumbering — capped at 500 rows, with
`nextAfter` null on the last page so a caller walks rather than counts.

**Fidelity is a response field, not a footnote.** ESPN prunes the touch tier for
older matches: an October 2025 fixture returns zero Pass and zero Tackle. Without
`fidelity`, a pruned match and a quiet match are the same 40-row response, and
the API would be telling users one match had less football in it. Every
play-derived response carries the tier, the counts and a sentence a consumer can
show verbatim.

**But the shot tier and its geometry are durable.** That same October 2025 match
still returns 161/194 plays and 26/43 shot plays with coordinates. So plays carry
`fieldPositionX/Y`, `fieldPosition2X/Y` and `goalPositionY/Z` — all nullable,
~96% populated on a live competition — and **past-season shot maps are very
likely backfillable.** Nothing here assumes geometry begins at our ingest date.

**A shot map is now a SELECT.** An earlier draft of this plan asserted the play
stream carried no coordinates and that xG was therefore impossible. That was
wrong on the facts. xG remains unbuilt because nobody has specified a model, not
because the inputs are missing — a materially different reason, and the plan says
so rather than leaving a stale impossibility claim standing.

**Absence stays absence.** `counts` omits a play type the player did not
perform. A zero would turn "not recorded" into a measurement — the same rule the
box score and the squad table already follow.

**Two grains, not one table.** `match_play` is the touch stream; `match_event`
from the ingester's `0003_player_capture` is the ~40 key events participation is
built on. Both are correct, they answer different questions, and nothing here
reconciles them.

## What this changes about E6

The E6 spec was written to find shots by parsing commentary prose, because prose
was the only shot source. It is not any more — shots arrive typed with athlete
ids. Shot **discovery** moves to this plan; the sibling commentary plan keeps its
parser, narrowed to the qualifiers only prose carries (body part, zone, assist
type). Reconciliation gets stronger: the play stream is now a second independent
ground truth alongside `rosters[].totalShots`.

## Still not available

Injuries, transfers and tracking data — all verified absent in the play stream.

## Available, and deliberately not designed here

Pass and carry geometry (start→end on non-shot plays) is present, so pass maps
and territory aggregates are possible. This plan does not specify them: possible
is not specified, and a pass-network endpoint needs a design pass on what a
"chain" is first. Nothing downstream should refuse them on data-availability
grounds. Likewise xG — coordinates exist, no model does, and choosing to build
one is the user's call.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` clean.
- Testcontainers coverage for sequence ordering, keyset paging across three
  pages, type/period/player filters, null-vs-empty assist ids, all three
  fidelity tiers including a match never ingested, absent-not-zero counts, the
  leaderboard excluding players with no entry for the metric, and coverage
  counting unmeasured matches.
- Parameter tests reject a display-cased type, an out-of-range period and a
  negative cursor before any query runs.

Plan: `docs/superpowers/plans/2026-08-15-api-play-stream.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Coverage of the brief.** Match event timeline, paginated and filterable →
  Tasks 2 and 3. Per-player action counts per match and per season → Tasks 3 and
  4. Per-competition coverage gating → Task 4's `/plays/coverage`, plus the
  `play-stream` capability the sibling `api-commentary-and-shots` plan adds to
  `competition_coverage`. Retention honesty → `PlayFidelity` on every
  play-derived response.
- **Referees and odds are not here.** Officials are the `api-officials` plan
  (**T9.9**); odds are the `api-history` plan's Task 7, because line movement is
  snapshot-shaped time series and belongs beside the win-probability series.
- **Deliberately not built.** No unpaginated plays endpoint. No pass network or
  possession-chain derivation — both are real and both need a design pass on
  what a "chain" is before an endpoint claims to serve one. No xG endpoint —
  **not** because the data is missing (coordinates are present on ~96% of plays)
  but because no model exists and specifying one is the user's decision.
- **Type consistency.** `PlayFilter`, `Play`, `PlayPage`, `PlayFidelity`,
  `PlayTypeCount`, `PlayerActionCounts`, `MatchActions`, `PlayerSeasonActions`,
  `ActionLeader`, `PlayCoverageTier` and `PlayCoverage` are each declared once
  and referenced under those names in the handlers, the fake store and
  openapi.yaml. `parsePlayType`, `parsePeriod`, `parseAfterSequence` and
  `parseActionMetric` are added to the `params.go` created by the
  `api-match-reads` plan.
- **Two soft dependencies, both named at their call site.** The `player` LEFT
  JOIN needs the `api-players` plan's table; `AllowCost` needs the `api-history`
  plan's Task 8. Neither is load-bearing for the endpoints' shape, and both are
  four-line fixes if this lands first.
- **One hard dependency and two unresolved questions, all in Task 1.** The hard
  dependency is the ingester's `0007_play_stream`, without which there is
  nothing to read. One question remains open — `match.id`'s type (`text` on
  `main`, `uuid` in the ingester plans) — and is stated as a blocker rather than
  assumed away, because a wrong answer produces a plan that looks correct and
  does not run. The second question, whether coordinates exist, is **resolved:
  they do**, and the draft that said otherwise was working from a briefing that
  turned out to be false.
- **The draft this replaced created `match_play` itself.** That was caught by
  reading the sibling plans rather than by a test, which is worth saying out
  loud: migration ownership is not something the Go test suite can enforce
  across two branches, so it has to be checked by hand before Task 1.
