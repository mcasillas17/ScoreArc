# Reader API — Match Officials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the referee joinable. `match_detail.info.referee` already holds the referee's
display name as a string, which answers "who refereed this match" and nothing else — a name
in jsonb cannot be joined, two officials who share a surname are one string, and the
assistants and fourth official are dropped entirely. The ingester plan
`2026-08-15-ingester-officials-and-odds.md` is adding the identified relation. This plan is
the **read half**: four endpoints over `official` and `match_official`, and nothing else.

**Architecture:** No new tables and **no new migration**. `0008_match_officials` (owned by
the ingester plan) creates `official`, `official_external_ref` and `match_official`; this
plan reads two of those three. Three new store methods plus one extended one. The season
aggregate is the only new computation: cards come from a lateral `jsonb_array_elements` over
`match_detail.cards`, fouls from `match_detail.stats`, both guarded by `jsonb_typeof` so a
single badly typed value cannot 500 a whole competition. `/officials/{id}/matches` does not
get a second match query — `MatchFilter` grows an `OfficialID` predicate and its competition
scope becomes optional, which is the only change this plan makes to shared SQL.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** none — and that is deliberate, not an omission. There is no design document in
`docs/superpowers/specs/` for match officials. This slice comes from a **live capability
probe of ESPN's core host run on 2026-08-15**: the per-match `officials` sub-resource
returned HTTP 200 with **named officials carrying ids**, fully embedded rather than as
`$ref`s, and roles including *Referee*, *Assistant Referee*, *Fourth Official* and *VAR*.
The probe is the requirement; where a Spec line would normally point at a design doc, it
points at that date instead.

> An earlier framing of this plan also cited that probe as having ruled out xG and shot
> coordinates. **That briefing was withdrawn** — the core host's play stream does carry
> coordinates (`fieldPositionX/Y`, `fieldPosition2X/Y`, `goalPositionY/Z`, on roughly 96% of
> plays). Nothing in this plan depends on either claim, and the sentence is struck rather
> than corrected because availability of shot data is the `api-play-stream` and
> `api-commentary-and-shots` plans' subject, not this one's. It is noted here only so the
> withdrawn claim is not quoted onward from this file.

**Epic:** **E10 · Public API read surface** (new capability; it has no existing product epic
because the roadmap was written before the probe. It feeds E5 · Player pages and E7 ·
History & trends once the aggregates have a season behind them.)
**New roadmap task:** **T10.9** (Epic **E10 · Public API read surface**)
**Branch:** `feat/api-officials` off latest `origin/main`

**Prerequisites — both, in this order:**

1. **`docs/superpowers/plans/2026-08-15-ingester-officials-and-odds.md` must have landed.**
   It creates `0008_match_officials`, which is the entire schema this plan reads. Until it
   lands there is nothing to read and **this plan cannot start**. Task 1 is the verification
   gate for that.
2. **`docs/superpowers/plans/2026-08-15-api-match-reads.md` (T10.1) must have landed.** It
   creates `backend/reader/params.go` — `parseDateRange`, `parseLimit`, `parseOrder`,
   `parseState`, `parseEntityID`, `maxRangeDays`, `maxMatchLimit` — and the `MatchFilter`
   struct and `parseMatchFilter` helper this plan extends. This plan appends `parseUUID` to
   that file.

## Global Constraints

- **This plan creates no migration.** See Task 1's STOP block. An earlier draft created a
  `0013_officials` migration with its own `CREATE TABLE official` and `CREATE TABLE
  match_official`; that draft was wrong and has been replaced. Two `CREATE TABLE official`
  statements are not a merge conflict — they are a migration that fails on a live database.
- Extend the existing layering. Routes register in `App.router()` under the `/v1`
  subrouter; handlers live in `handlers_officials.go`; SQL lives in `store_officials.go`;
  the `readerStore` interface in `server.go` is the seam and `fakeReaderStore` in
  `server_test.go` implements it. **Adding a store method means editing all three.**
- **No string-built SQL.** Every value is a pgx placeholder. Nothing in this plan needs a
  dynamic fragment: each new query has one fixed `ORDER BY`, and the one shared statement
  this plan touches (`matchesSQL`) keeps the existing two-entry constant `ORDER BY` map
  from T10.1.
- **Reject, never silently fall back.** A malformed id is a 400 before any query runs. A
  `?season=` without a `?comp=` is a 400, not a guess at which competition was meant.
- **400 messages are built only from string constants in our own code.** Never
  `err.Error()` on a dependency error — `TestDependencyErrorsAreSanitized` exists because
  that leak class is real.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go` enforces:
  every object schema's `required` list equals its complete sorted property list, every
  object schema sets `additionalProperties: false`, every `GET` documents 200/405/500
  (+429 off `/healthz`), and **every** response — 200 and error alike — declares a
  `Cache-Control` header. Because `required` must list every property, **no response struct
  in this plan may use `omitempty`**.
- Rate limiting is unchanged and **this plan deliberately does not use `AllowCost`.** The
  `api-history` plan adds a weighted charge for endpoints whose payload scales with a
  caller-supplied window. Nothing here does: the season aggregate is bounded by the
  officials who worked a season, and the match list is hard-capped at 500 rows. Charging
  three tokens for a forty-row response would be a cost model that does not describe the
  cost. All four routes charge one token through the existing router-level middleware.
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`, `go test -race ./...`.
  **Docker must be running** — the reader's store and migration tests use testcontainers.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## What the ingester writes, and what this plan therefore depends on

The reader cannot invent these rows and does not own their schema. Until the ingester runs,
every endpoint here returns an honest empty or an honest 404 — never a fabricated official
and never a card rate over zero matches.

| Table | Written by | Read by this plan |
|---|---|---|
| `official` | `2026-08-15-ingester-officials-and-odds.md` Task 4 | all four endpoints |
| `match_official` | same | all four endpoints |
| `official_external_ref` | same | **not read.** See below. |

### `official_external_ref` — why this plan ignores it

`0008_match_officials` creates a third table the read-side draft did not anticipate:

```sql
CREATE TABLE official_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  official_id   uuid NOT NULL REFERENCES official(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
```

This is the **provider-id crosswalk**, the same shape `player` / `player_external_ref` uses,
and the ingester plan's Global Constraints state its purpose without ambiguity: *"No
provider is the identity authority. A referee gets a ScoreArc-minted uuid and the ESPN id
lives only in a crosswalk … Do not make `official.id` the ESPN id, however convenient — that
is the rule the entire canonical-identity branch exists to enforce."* That is read from
their SQL and their stated constraint, not inferred.

**This plan's reads do not need it.** Every read here starts from either a match id or our
own `official.id`; none of them starts from a provider id.

**And it must stay that way.** A tempting future request is "let `/v1/officials/{officialId}`
also accept an ESPN official id, it's easy, just join the crosswalk". Do not. That would
make the provider the identity authority through the back door of a public URL — a consumer
would build against ESPN ids, and re-keying would then be a breaking API change rather than
an internal one. `{officialId}` is our uuid, the OpenAPI parameter says so, and if a
provider-id lookup is ever genuinely wanted it belongs on its own explicitly-named route
(`/v1/officials/by-source/{source}/{sourceId}`), not smuggled into this one. That route is
**not** built here — nothing has asked for it.

### `match_official` has no `DELETE` grant, and that has a read-side consequence

The ingester plan grants `SELECT, INSERT, UPDATE` and explicitly declines `DELETE`: *"A crew
correction is an UPDATE of role, and an official removed from a sheet is rare enough not to
justify the grant."* That is their call and this plan does not reopen it.

But it is worth writing down what it means on this side, because it is invisible from the
write side. An official who is **withdrawn** from a crew before kickoff — not reassigned to
a different role, but removed entirely — leaves a row in `match_official` that nothing can
remove. The consequences, in order of how badly they hurt:

- `/matches/{id}/officials` lists a person who did not work the match.
- `/officials/{id}` and `/officials/{id}/matches` count a match they did not work.
- `/competitions/{comp}/{season}/officials` attributes that match's **cards** to them.

The third one is the one that matters, because it produces a plausible wrong number rather
than a visible wrong name. **This is a known limitation, not a defect this plan fixes** —
the fix belongs in the write path (either a `DELETE` grant or a `withdrawn_at` column), and
inventing a reader-side workaround would mean guessing which appearances are stale. Raise it
with the ingester plan's author if withdrawn crews turn out to be common; the probe saw
one-official and four-official crews but said nothing about withdrawals.

### The pre-existing `MatchInfo.referee` string stays exactly as it is

`match_detail.info` is a jsonb blob whose `MatchInfo` shape carries `referee` as a **plain
nullable string with no id**. This plan does not touch it, does not deprecate it, and does
not reconcile it with `match_official`.

- `info.referee` is **the provider's display string from the site host's `gameInfo`**. It is
  what ESPN's summary endpoint printed for that match, and `mapSummaryInfo` already stores it.
- `match_official` is **the identified relation from the core host's `/officials`
  sub-resource**. It is what ESPN's core endpoint returned as structured entities with ids.

These are two different upstream documents from two different hosts and **they can
legitimately disagree** — a late crew change published to one and not the other, a name
spelled differently, a `referee` that is `null` while the core host names four officials.
The integration seed in Task 1 reproduces exactly that case on the live world-cup final,
where `info.referee` is `null` and `match_official` names Howard Webb.

Nothing in this plan reconciles them, and that is the decision, not an oversight. A silent
reconciliation — preferring one, or writing the identified name back into `info` — would
hide a real upstream inconsistency behind a value that looks authoritative. Two visible
sources that occasionally disagree is a true description of what we hold. One source that
was quietly picked for us is not.

## What is capped, and to what

| Input | Rule | Failure |
|---|---|---|
| `{id}` on `/matches/{id}/officials` | must be a UUID, via `parseUUID` | 400 |
| `{officialId}` | must be a UUID, via `parseUUID` | 400 |
| `?comp=` on `/officials/{id}/matches` | must resolve in `a.registry` | 400 |
| `?season=` on `/officials/{id}/matches` | must resolve within `?comp=`; **`?season=` without `?comp=` is a 400** | 400 |
| `?range=` on `/officials/{id}/matches` | `YYYYMMDD-YYYYMMDD`, UTC, ordered, ≤ 92 days | 400 |
| `?state=`, `?order=` on `/officials/{id}/matches` | the T10.1 enums | 400 |
| `?limit=` on `/officials/{id}/matches` | integer `1..500`; **absent defaults to 500**, it does not mean "unlimited" | 400 |
| `/matches/{id}/officials` payload | one match's crew — one row on Liga MX, four on the competitions that publish a full crew | — |
| `/officials/{id}` payload | one row per (competition, season) we hold an appearance in — bounded by our own registry | — |
| `/competitions/{comp}/{season}/officials` payload | one row per (official, role) who worked that season — typically a few dozen | — |

Three entries deserve their reason spelled out.

**Ids are validated as UUIDs, not with `parseEntityID`.** `official.id` and `match.id` are
`uuid` columns under `0008_match_officials`. Binding a non-uuid string to a `$n::uuid`
placeholder raises `invalid input syntax for type uuid`, which the handler can only turn
into a 500. `parseUUID` turns it into the 400 it actually is, before any query runs.

**`?limit=` defaults to 500 here, and to unlimited on `/competitions/{comp}/{season}/matches`.**
That difference is not an inconsistency. A season's match list is bounded by the fixture
list — at most 380 rows for a 20-team double round-robin — which is *data*, not something a
caller can inflate. An official's match list has no such bound: it grows every week for as
long as that official works, across every competition we ingest, forever. "Absent means no
limit" on a career-length list is an unbounded read wearing a default. Callers who want the
recent end ask for `?order=desc`; callers who want more than 500 paginate with `?range=`.

**`/competitions/{comp}/{season}/officials` takes no `?limit=` at all.** Its bound is the
data: a season is worked by the officials a federation appoints, which is a few dozen, and
grouping by role multiplies that by the handful of roles a crew has. No caller input widens
it. Adding a limit would imply the caller controls the size, which would be false.

---

## File Structure

- `backend/reader/params.go` — one appended function, `parseUUID`, and its error constant.
- `backend/reader/store_officials.go` — **new.** `MatchOfficials`, `OfficialProfile`,
  `OfficialSeasons`, `perMatchRate`.
- `backend/reader/handlers_officials.go` — **new.** Four handlers.
- `backend/reader/types.go` — `Official`, `MatchOfficial`, `OfficialSeasonRef`,
  `OfficialProfile`, `OfficialSeason` (append).
- `backend/reader/store.go` — `MatchFilter.OfficialID`, an optional competition scope, and
  the guard that keeps "optional" from meaning "the whole table".
- `backend/reader/server.go` — `readerStore` gains three methods; four new routes.
- `backend/reader/server_test.go` — fake follows the interface; handler tests.
- `backend/reader/store_integration_test.go` — seed additions, the invariant assertion, and
  store coverage.
- `backend/reader/openapi_test.go` — four rows on the route table.
- `backend/reader/openapi.yaml` — four paths, five schemas, four parameters, two
  responses, one header.
- `backend/reader/README.md` — the new surface.

**Not in this list, on purpose:** `backend/migrations/*`, `backend/migrations/migrations_test.go`
and `backend/reader/migrations_integration_test.go`. This plan creates no migration.

---

### Task 1: Verify the officials schema this plan reads — do not create it

**Files:**
- Modify: `backend/reader/store_integration_test.go` (seed and one invariant test only)

> ## STOP — schema ownership, read before writing any SQL
>
> An earlier draft of this plan created its own `0013_officials` migration with
> `CREATE TABLE official` and `CREATE TABLE match_official`. **That was wrong and
> has been replaced by this task.**
>
> **The write side owns this schema.**
> `docs/superpowers/plans/2026-08-15-ingester-officials-and-odds.md` Task 2 creates
> **`0008_match_officials`** (`official`, `official_external_ref`, `match_official`)
> and `0009_odds_snapshot`. Two `CREATE TABLE official` statements under different
> migration numbers are not a merge conflict — they are a second migration that
> fails on a live database, after the first one has already been applied.
>
> That plan's ledger also reserves `0010_leader_category`,
> `0011_squad_and_season_stats`, `0012_player_bio` and `0013_match_commentary`. The
> number the earlier draft claimed is now owned by commentary. **This plan claims no
> number at all.**
>
> **The ingester's columns are not the columns the draft assumed.** Every SQL
> statement in Tasks 2–5 has been rewritten against the real schema. Apply this
> table once, here, rather than rediscovering it four times:
>
> | The earlier draft assumed | `0008_match_officials` actually creates | What changes downstream |
> |---|---|---|
> | `official.id text` (the ESPN id) | `official.id uuid`, **ScoreArc-minted**; the ESPN id lives only in `official_external_ref` | ids in URLs are uuids; `parseUUID` replaces `parseEntityID`; every seed id is a uuid |
> | `official.name` | `official.full_name` | every `SELECT` renames the column; the JSON field stays `name` |
> | *(did not exist)* | `official_external_ref(source, source_id, official_id, first_seen_at, last_seen_at)` | **not read by this plan** — see "why this plan ignores it" above |
> | `match_official.match_id text` | `match_official.match_id uuid` | `$n::uuid` casts, not `$n::text` |
> | `match_official.official_id text` | `match_official.official_id uuid` | same |
> | `match_official.ordinal int NOT NULL DEFAULT 0` | **`match_official.ord int`, nullable** | Go field becomes `*int`; JSON becomes `[integer,"null"]`; `ORDER BY … NULLS LAST` |
> | *(did not exist)* | `match_official.role_id text`, nullable — `position.id` | exposed as `roleId` on `MatchOfficial`; **not** a grouping key, because grouping on a sometimes-null column would split one official's season in two |
> | `PRIMARY KEY (match_id, official_id, role)` | **`PRIMARY KEY (match_id, official_id)`** | one person holds **at most one role per match**. The draft's "two roles on one match" seed row is now illegal. This is the single most consequential difference — see Step 3. |
> | `GRANT DELETE ON match_official` | **no `DELETE` grant** — deliberate | the withdrawn-crew limitation documented above; no test asserts a grant that does not exist |
> | `match_official_official_idx (official_id)` | same | ✓ the index the `EXISTS` predicate in Task 4 relies on |
> | *(did not exist)* | `match_official_role_idx (official_id, role)` | serves "every match this person refereed **as referee**"; nothing here needs it, but it is why a role-scoped career query would also be cheap |
>
> **`role_id` is nullable and `ord` is nullable. Neither is defaulted anywhere in
> this plan.** An absent listing order is not order zero and an absent position id
> is not the empty string; both serialize as `null`.
>
> **One open question the executor must resolve, not guess at.** `0008_match_officials`
> declares `match_id uuid NOT NULL REFERENCES match(id)`, but
> `backend/migrations/0001_init.up.sql` on `main` declares `match.id text`. **A
> foreign key whose type differs from its target's will not create**, and Postgres
> reports the failure in terms that point at the wrong file. The ingester plan lists
> `feat/canonical-identity-impl` as its first prerequisite, which is presumably where
> `match.id` is re-keyed — but this plan has not verified that and will not assume
> it. Step 1 checks the real type. **If `match.id` is still `text` when you get here,
> stop and raise it against the ingester plan.** Do not paper over it by casting, and
> do not "fix" it by editing `0001_init.up.sql`, which is applied to production.

- [ ] **Step 1: Confirm the schema you are reading against**

```bash
ls backend/migrations
grep -rn "CREATE TABLE official\|CREATE TABLE match_official" backend/migrations/
```

Expected: a `0008_match_officials.up.sql` containing both `CREATE TABLE official` and
`CREATE TABLE match_official`. **If that file is absent, the ingester plan has not landed —
stop. There is nothing to read and no endpoint in this plan can return anything.**

```bash
grep -n "full_name\|role_id\|ord \|PRIMARY KEY" backend/migrations/0008_match_officials.up.sql
```

Expected: `full_name`, `role_id`, `ord`, and `PRIMARY KEY (match_id, official_id)`. **If any
column name differs from the reconciliation table above, that table is stale — fix the SQL
in Tasks 2–5 to match what is on disk, not what is written here.**

```bash
grep -n "^  id \|match_id" backend/migrations/0001_init.up.sql
grep -rn "ALTER TABLE match" backend/migrations/ | grep -i "uuid\|TYPE"
```

Expected: evidence that `match.id` is `uuid` by the time `0008` applies — either directly in
`0001_init.up.sql` or via a re-keying migration between them. **If `match.id` is still
`text`, stop** and raise the type mismatch against `2026-08-15-ingester-officials-and-odds.md`.
It is a real blocker for that plan, not something this one may work around.

```bash
grep -n "0008_match_officials" backend/reader/migrations_integration_test.go backend/reader/store_integration_test.go
```

Expected: `0008_match_officials.up.sql` already present in both hardcoded migration lists —
the ingester plan adds it. **If it is missing from `newIntegrationStore`'s list in
`store_integration_test.go`, add it there** (after the highest-numbered up file already in
the list); this plan's integration tests cannot run against a schema the harness never
applies. Do **not** add anything to `migrations_integration_test.go`'s down list — that file
mirrors the up list in reverse and the ingester plan owns both halves of its entry.

- [ ] **Step 2: Seed officials, crews and finished matches with cards**

> **Match ids are uuids by the time you reach this step** — Step 1 established that, and
> `0008`'s foreign key cannot exist otherwise. The literals below are therefore uuids. Team
> ids are **not** pinned by anything Step 1 checked, so the match inserts derive them from
> `team.abbr` rather than hardcoding `'arg'` / `'fra'`, and the world-cup crew row derives
> its match id from the seed's own live final rather than naming it. Both derivations exist
> so this seed survives whatever id form the surrounding `seedIntegrationData` is using.

> **Do not add matches to `world-cup` / `2026`.** `TestStoreIntegration`,
> `TestStoreMatchFilter` (T10.1) and `TestStoreSeasonCalendar` (T10.1) all assert **exact
> counts** on that competition-season. This seed adds matches to `laliga` / `2026-27` and
> `liga-mx` / `2026-apertura`, which no current test touches, and adds only a single
> `match_official` row against world-cup — which changes no match count. If a sibling plan
> has already claimed those two competitions, move to `serie-a` / `2026-27` and
> `bundesliga` / `2026-27` and adjust the assertions in Tasks 2–5 — but never into
> world-cup.

Append to `seedIntegrationData`'s `statements` slice in
`backend/reader/store_integration_test.go`, **after** the existing `top_scorer` insert:

```go
		// Officials are ScoreArc-minted uuids. The ESPN id lives in
		// official_external_ref, which this plan never reads - see the plan's
		// "why this plan ignores it".
		`INSERT INTO official (id, full_name) VALUES
			('0f1c1a00-0000-4000-8000-000000000001', 'Howard Webb'),
			('0f1c1a00-0000-4000-8000-000000000002', 'Ricardo Costa'),
			('0f1c1a00-0000-4000-8000-000000000003', 'Daniele Orsato'),
			('0f1c1a00-0000-4000-8000-000000000004', 'Marco Aguilar'),
			('0f1c1a00-0000-4000-8000-000000000005', 'Anthony Taylor')`,
		// Team ids are derived rather than hardcoded so this survives a re-keying
		// of team.id that has nothing to do with officials.
		`INSERT INTO match
			(id, comp_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, minute, status_detail, status_name, winner_id, note,
			 home_placeholder, away_placeholder)
		 SELECT v.id, v.comp_id, v.season_id, NULL, v.kickoff, v.state,
		        CASE WHEN v.home_abbr = 'ARG' THEN h.id ELSE a.id END,
		        CASE WHEN v.home_abbr = 'ARG' THEN a.id ELSE h.id END,
		        v.home_score, v.away_score, v.minute, v.status_detail, v.status_name,
		        NULL, NULL, false, false
		 FROM (VALUES
			('0f1c1a00-0000-4000-8000-00000000a001'::uuid, 'laliga',  '2026-27',       '2026-08-16T19:00:00Z'::timestamptz, 'finished', 'ARG', 2, 1, NULL::text, 'FT',   'STATUS_FULL_TIME'),
			('0f1c1a00-0000-4000-8000-00000000a002'::uuid, 'laliga',  '2026-27',       '2026-08-23T19:00:00Z'::timestamptz, 'finished', 'FRA', 0, 0, NULL,       'FT',   'STATUS_FULL_TIME'),
			('0f1c1a00-0000-4000-8000-00000000a003'::uuid, 'laliga',  '2026-27',       '2026-08-30T19:00:00Z'::timestamptz, 'live',     'ARG', 1, 0, '61''',     '61''', 'STATUS_IN_PROGRESS'),
			('0f1c1a00-0000-4000-8000-00000000a004'::uuid, 'liga-mx', '2026-apertura', '2026-08-20T02:00:00Z'::timestamptz, 'finished', 'ARG', 3, 2, NULL,       'FT',   'STATUS_FULL_TIME')
		 ) AS v(id, comp_id, season_id, kickoff, state, home_abbr, home_score, away_score, minute, status_detail, status_name)
		 CROSS JOIN (SELECT id FROM team WHERE abbr = 'ARG') AS h
		 CROSS JOIN (SELECT id FROM team WHERE abbr = 'FRA') AS a`,
		// a002's away fouls are the string "7", not the number 7. A stat typed
		// wrong upstream must cost that one match its foul total, not 500 the
		// whole competition. a004's fouls are JSON null on both sides - a
		// competition that publishes no foul counts must serialize null, never
		// zero, because zero fouls is a claim and absence is not.
		`INSERT INTO match_detail (match_id, cards, stats) VALUES
			('0f1c1a00-0000-4000-8000-00000000a001',
			 '[{"teamId":"arg","player":"Alba","minute":"12''","type":"yellow"},
			   {"teamId":"fra","player":"Benoit","minute":"38''","type":"yellow"},
			   {"teamId":"fra","player":"Carrasco","minute":"55''","type":"yellow"},
			   {"teamId":"fra","player":"Carrasco","minute":"57''","type":"red"}]',
			 '{"home":{"fouls":12},"away":{"fouls":10}}'),
			('0f1c1a00-0000-4000-8000-00000000a002',
			 '[{"teamId":"arg","player":"Duarte","minute":"22''","type":"yellow"},
			   {"teamId":"fra","player":"Etienne","minute":"71''","type":"yellow"}]',
			 '{"home":{"fouls":9},"away":{"fouls":"7"}}'),
			('0f1c1a00-0000-4000-8000-00000000a003',
			 '[{"teamId":"arg","player":"Fabra","minute":"9''","type":"yellow"},
			   {"teamId":"arg","player":"Gomez","minute":"18''","type":"yellow"},
			   {"teamId":"fra","player":"Herve","minute":"33''","type":"yellow"},
			   {"teamId":"fra","player":"Ibrahim","minute":"52''","type":"yellow"}]',
			 '{"home":{"fouls":5},"away":{"fouls":6}}'),
			('0f1c1a00-0000-4000-8000-00000000a004',
			 '[{"teamId":"arg","player":"Jara","minute":"44''","type":"yellow"}]',
			 '{"home":{"fouls":null},"away":{"fouls":null}}')`,
		// One person, at most one role per match - that is the primary key. ord
		// is ESPN's own display order and starts at 1; a004 leaves it null, and
		// a001's VAR leaves role_id null, so both nullable paths are exercised
		// rather than assumed.
		`INSERT INTO match_official (match_id, official_id, role, role_id, ord) VALUES
			('0f1c1a00-0000-4000-8000-00000000a001', '0f1c1a00-0000-4000-8000-000000000001', 'Referee',           '1',  1),
			('0f1c1a00-0000-4000-8000-00000000a001', '0f1c1a00-0000-4000-8000-000000000002', 'Assistant Referee', '2',  2),
			('0f1c1a00-0000-4000-8000-00000000a001', '0f1c1a00-0000-4000-8000-000000000003', 'VAR',               NULL, 3),
			('0f1c1a00-0000-4000-8000-00000000a002', '0f1c1a00-0000-4000-8000-000000000001', 'Referee',           '1',  1),
			('0f1c1a00-0000-4000-8000-00000000a002', '0f1c1a00-0000-4000-8000-000000000005', 'Fourth Official',   '4',  4),
			('0f1c1a00-0000-4000-8000-00000000a003', '0f1c1a00-0000-4000-8000-000000000001', 'Referee',           '1',  1),
			('0f1c1a00-0000-4000-8000-00000000a004', '0f1c1a00-0000-4000-8000-000000000004', 'Referee',           '1',  NULL)`,
		// The live world-cup final gets a crew while its match_detail.info.referee
		// stays null. That divergence is the point: two upstream hosts, two
		// answers, and nothing in the reader picks one. Derived rather than named
		// so it does not depend on the seed's match id form.
		`INSERT INTO match_official (match_id, official_id, role, role_id, ord)
		 SELECT m.id, '0f1c1a00-0000-4000-8000-000000000001', 'Referee', '1', 1
		 FROM match m
		 WHERE m.comp_id = 'world-cup' AND m.season_id = '2026' AND m.state = 'live'`,
```

The seed leaves the scheduled world-cup semifinal and the premier-league fixture with **no
crew at all**, so Task 2's "officials not recorded" 404 is exercised against a real row
rather than a missing one.

- [ ] **Step 3: Assert the invariant the aggregates silently depend on**

The ingester plan owns the migration and tests it there. This plan owns a read that is
**quietly wrong** if the key is missing, so it asserts it here too. The rule: if a missing
constraint would make an endpoint *fail*, trust the write plan's test; if it would make an
endpoint serve a plausible wrong number, assert it on the read side as well.

Append to `backend/reader/store_integration_test.go`:

```go
func TestOneOfficialAppearsOncePerMatch(t *testing.T) {
	_, pool := newIntegrationStore(t)
	ctx := context.Background()
	// The same person, the same match, a different role. Under
	// PRIMARY KEY (match_id, official_id) this must be refused.
	//
	// If it is accepted, /competitions/{comp}/{season}/officials counts that
	// match twice for that person AND runs the card lateral twice over it, so
	// both the numerator and the denominator double. The rate stays superficially
	// plausible while every count under it is wrong - which is exactly the class
	// of failure that never shows up in a smoke test.
	//
	// Note that (match_id, role) is deliberately NOT unique: two different people
	// are both 'Assistant Referee' on the same match, which is normal and
	// correct. The key that protects the aggregates is the one asserted here.
	if _, err := pool.Exec(ctx, `
		INSERT INTO match_official (match_id, official_id, role, role_id, ord)
		VALUES ('0f1c1a00-0000-4000-8000-00000000a001',
		        '0f1c1a00-0000-4000-8000-000000000001', 'Fourth Official', '4', 4)`,
	); err == nil {
		t.Fatal("one official was accepted twice on one match")
	}
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run "TestStoreIntegration|TestOneOfficialAppearsOncePerMatch"
```

Expected: both `ok`. `TestStoreIntegration` proves the new seed rows do not disturb the
existing world-cup assertions. If `TestOneOfficialAppearsOncePerMatch` fails with "one
official was accepted twice on one match", the applied `0008_match_officials` does not carry
`PRIMARY KEY (match_id, official_id)` — **stop and fix it in the ingester plan, not here.**

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_integration_test.go
git commit -m "test(reader): seed officials and pin the key the aggregates depend on

Reads 0008_match_officials rather than creating a second copy of it. The
primary key on (match_id, official_id) is asserted here as well as in the
ingester plan, because a missing key does not make the season aggregate
fail - it doubles both the match count and the cards counted against a
referee, and the resulting rate still looks plausible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `parseUUID`, and `GET /v1/matches/{id}/officials`

**Files:**
- Modify: `backend/reader/params.go`
- Create: `backend/reader/store_officials.go`, `backend/reader/handlers_officials.go`
- Modify: `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/params_test.go`, `backend/reader/store_integration_test.go`, `backend/reader/server_test.go`

**Interfaces:**
- `parseUUID(raw string) (string, error)`
- `Store.MatchOfficials(ctx context.Context, matchID string) ([]MatchOfficial, error)`

**Why `parseUUID` and not `parseEntityID`.** `parseEntityID` accepts
`^[A-Za-z0-9._-]{1,64}$`, which is right for an opaque provider id in a `text` column. Both
ids on this route land in `uuid` columns. A string that passes `parseEntityID` but is not a
uuid reaches Postgres, raises `invalid input syntax for type uuid`, and becomes a 500 — a
client error reported as a server error. `parseUUID` is the narrower guard those columns
actually need.

> **Observation, not a change this plan makes.** T10.1's `handleMatchSummary` validates
> `/v1/matches/{id}` with `parseEntityID` and queries `match_detail.match_id`. If
> canonical-identity re-keyed that column to `uuid`, that route has the same
> 500-instead-of-400 defect today. It is out of scope here — it belongs to whoever owns
> canonical-identity's read-side sweep — but it is worth raising rather than silently fixing
> one route and leaving its neighbour broken.

**Why an empty crew is a 404 and not `[]`.** A match with no recorded officials returns
`404 {"error":"officials not recorded for this match"}`. An empty array would claim the
match was played without a referee, which never happens; what is true is that we do not hold
the data. Those are different facts and the status code is the cheapest place to keep them
apart. Contrast this deliberately with Task 5's `/competitions/{comp}/{season}/officials`,
where `[]` **is** honest — "no officiated matches held for this season yet" is a real,
reachable state of the world, and a 404 there would tell a client the season does not exist.

An unknown match id and a known match with no crew produce the **same** 404. That is on
purpose: we hold no "this match exists" fact that is worth a separate probe, and giving the
two cases different status codes would let a caller enumerate our match table by status code
alone.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParseUUID(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"0f1c1a00-0000-4000-8000-000000000001",
		"0F1C1A00-0000-4000-8000-00000000000A",
	} {
		if got, err := parseUUID(raw); err != nil || got != raw {
			t.Fatalf("uuid %q = %q, err %v", raw, got, err)
		}
	}
	// Every one of these passes parseEntityID and would reach Postgres as a
	// uuid parameter, where it becomes a 500 instead of the 400 it is.
	for _, raw := range []string{
		"",
		"off-webb",
		"401863609",
		"0f1c1a00-0000-4000-8000-00000000000",   // too short
		"0f1c1a00-0000-4000-8000-0000000000001", // too long
		"0f1c1a00_0000_4000_8000_000000000001",  // wrong separator
		"0f1c1a00-0000-4000-8000-00000000000g",  // not hex
		"0f1c1a00-0000-4000-8000-000000000001 ",
	} {
		if _, err := parseUUID(raw); err == nil {
			t.Fatalf("uuid %q was accepted", raw)
		}
	}
	if _, err := parseUUID("nope"); err == nil || err.Error() == "" {
		t.Fatal("missing message")
	}
}
```

Append to `backend/reader/store_integration_test.go`:

```go
// scanSeedID reads a single id out of the seed without hardcoding the form
// match.id happens to use. The seed's world-cup rows predate this plan and their
// id form is owned by whatever branch last re-keyed them.
func scanSeedID(ctx context.Context, store *Store, query string) (string, error) {
	var id string
	err := store.db.QueryRow(ctx, query).Scan(&id)
	return id, err
}

func TestStoreMatchOfficials(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("a crew comes back in the provider's listed order", func(t *testing.T) {
		officials, err := store.MatchOfficials(ctx, "0f1c1a00-0000-4000-8000-00000000a001")
		if err != nil {
			t.Fatal(err)
		}
		if len(officials) != 3 {
			t.Fatalf("officials = %+v", officials)
		}
		first := officials[0]
		if first.Official.ID != "0f1c1a00-0000-4000-8000-000000000001" || first.Official.Name != "Howard Webb" {
			t.Fatalf("first official = %+v", first)
		}
		if first.Role != "Referee" || first.Order == nil || *first.Order != 1 {
			t.Fatalf("first role = %+v", first)
		}
		if first.RoleID == nil || *first.RoleID != "1" {
			t.Fatalf("first roleId = %v", first.RoleID)
		}
		if officials[1].Role != "Assistant Referee" || officials[2].Role != "VAR" {
			t.Fatalf("crew order = %+v", officials)
		}
		// role_id is nullable and is not defaulted to "". An absent position id
		// is absent.
		if officials[2].RoleID != nil {
			t.Fatalf("absent roleId became %q", *officials[2].RoleID)
		}
	})

	t.Run("a one-official crew is as normal as a four-official one", func(t *testing.T) {
		// Liga MX publishes the referee only. ord is null there, and a null
		// listing order is not order zero.
		officials, err := store.MatchOfficials(ctx, "0f1c1a00-0000-4000-8000-00000000a004")
		if err != nil {
			t.Fatal(err)
		}
		if len(officials) != 1 || officials[0].Role != "Referee" {
			t.Fatalf("officials = %+v", officials)
		}
		if officials[0].Order != nil {
			t.Fatalf("absent ord became %d", *officials[0].Order)
		}
	})

	t.Run("a match with no crew is empty, and so is an unknown match", func(t *testing.T) {
		semifinal, err := scanSeedID(ctx, store,
			`SELECT id FROM match WHERE comp_id='world-cup' AND season_id='2026' AND state='scheduled'`)
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{semifinal, "0f1c1a00-0000-4000-8000-0000deadbeef"} {
			officials, err := store.MatchOfficials(ctx, id)
			if err != nil || officials == nil || len(officials) != 0 {
				t.Fatalf("%s officials = %#v, err %v", id, officials, err)
			}
		}
	})

	t.Run("the identified crew and info.referee are allowed to disagree", func(t *testing.T) {
		// info.referee is null on the live final while the core host named a
		// referee. Nothing reconciles them, and this test is the record that the
		// divergence is expected rather than a bug someone should go and fix.
		final, err := scanSeedID(ctx, store,
			`SELECT id FROM match WHERE comp_id='world-cup' AND season_id='2026' AND state='live'`)
		if err != nil {
			t.Fatal(err)
		}
		summary, err := store.MatchSummary(ctx, final)
		if err != nil {
			t.Fatal(err)
		}
		if summary.Info == nil || summary.Info.Referee != nil {
			t.Fatalf("info.referee = %+v, want nil", summary.Info)
		}
		officials, err := store.MatchOfficials(ctx, final)
		if err != nil || len(officials) != 1 || officials[0].Official.Name != "Howard Webb" {
			t.Fatalf("identified crew = %+v, err %v", officials, err)
		}
	})
}
```

Append to `backend/reader/server_test.go`:

```go
const testOfficialID = "0f1c1a00-0000-4000-8000-000000000001"
const testMatchID = "0f1c1a00-0000-4000-8000-00000000a001"

func TestMatchOfficialsRoute(t *testing.T) {
	t.Parallel()
	order, roleID := 1, "1"
	store := &fakeReaderStore{matchOfficials: []MatchOfficial{{
		Official: Official{ID: testOfficialID, Name: "Howard Webb"},
		Role:     "Referee", RoleID: &roleID, Order: &order,
	}}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/matches/"+testMatchID+"/officials")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	// A crew does not change once it is announced, and it certainly does not
	// change during the match, so this caches for five minutes rather than
	// tracking the live cadence.
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestMatchOfficialsAreNotAnEmptyArray(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matchOfficials: []MatchOfficial{}}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/matches/"+testMatchID+"/officials")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	// "[] officials" would claim the match was played without a referee. The
	// truth is that we do not hold the data.
	if !strings.Contains(response.Body.String(), "officials not recorded for this match") {
		t.Fatalf("body = %s", response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestMatchOfficialsRequireAUUID(t *testing.T) {
	t.Parallel()
	// Both of these pass parseEntityID. Bound to a uuid column they would be a
	// 500; they are client errors and must be reported as such.
	for _, target := range []string{"/v1/matches/match-final/officials", "/v1/matches/401863609/officials"} {
		store := &fakeReaderStore{matchOfficials: []MatchOfficial{}}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, target)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", target, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", target)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestParseUUID|TestStoreMatchOfficials|TestMatchOfficials"
```

Expected: FAIL — `undefined: parseUUID`, `store.MatchOfficials undefined`, `unknown field
matchOfficials in struct literal of type fakeReaderStore`, `undefined: MatchOfficial`.

- [ ] **Step 3: Implement**

Append to `backend/reader/params.go`:

```go
// errUUID is a constant like every other message in this file: 400 bodies are
// echoed to clients and must never carry text from a dependency.
var errUUID = errors.New("id must be a UUID")

var uuidPattern = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// parseUUID validates an identifier that will be bound to a uuid column.
//
// parseEntityID is the right guard for an opaque provider id in a text column.
// It is the wrong guard here: a value that satisfies it but is not a uuid
// reaches Postgres, raises "invalid input syntax for type uuid", and surfaces as
// a 500 - a client error reported as a server error. This is the narrower check
// those columns actually need, and like every other parser in this file it
// rejects rather than falling back.
func parseUUID(raw string) (string, error) {
	if !uuidPattern.MatchString(raw) {
		return "", errUUID
	}
	return raw, nil
}
```

Append to `backend/reader/types.go`:

```go
// Official is the identity of a match official. ID is a ScoreArc-minted uuid,
// never the provider's id - that lives in official_external_ref and is not
// exposed by this API, because a public URL built on a provider id makes the
// provider the identity authority.
//
// Two fields on purpose: everything else we could attach - a federation, a
// nationality, a career total - is either not published or belongs on a read
// with its sample size, not on the identity.
type Official struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// MatchOfficial is one person in one role on one match.
//
// Role is the provider's own text, unmapped. RoleID is the provider's position
// id, a stabler machine value for the same thing - and it is nullable, so it is
// a pointer rather than a string that quietly becomes "". Order is the
// provider's listing position, the only seniority signal the source carries; it
// is nullable too, because Liga MX sends a one-official crew with no order at
// all, and an absent order is not order zero.
type MatchOfficial struct {
	Official Official `json:"official"`
	Role     string   `json:"role"`
	RoleID   *string  `json:"roleId"`
	Order    *int     `json:"order"`
}
```

Create `backend/reader/store_officials.go`:

```go
package main

import (
	"context"
	"math"
)

// A crew is one row on Liga MX and four on the competitions that publish a full
// crew. It needs no limit and no pagination: the bound is the size of an
// officiating team, which is data rather than caller input.
//
// ord is ESPN's own display order and it is nullable, so NULLS LAST keeps a crew
// with no stated order at the end rather than silently ahead of the referee.
// role and full_name are tiebreakers so the response is stable across reads
// rather than dependent on physical row order.
const matchOfficialsSQL = `
SELECT o.id, o.full_name, mo.role, mo.role_id, mo.ord
FROM match_official mo
JOIN official o ON o.id = mo.official_id
WHERE mo.match_id = $1::uuid
ORDER BY mo.ord NULLS LAST, mo.role, o.full_name`

func (s *Store) MatchOfficials(ctx context.Context, matchID string) ([]MatchOfficial, error) {
	rows, err := s.db.Query(ctx, matchOfficialsSQL, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	officials := make([]MatchOfficial, 0)
	for rows.Next() {
		var official MatchOfficial
		if err := rows.Scan(
			&official.Official.ID, &official.Official.Name,
			&official.Role, &official.RoleID, &official.Order,
		); err != nil {
			return nil, err
		}
		officials = append(officials, official)
	}
	return officials, rows.Err()
}

// perMatchRate divides a total by its sample size and rounds to two decimals.
//
// The rate is derived and it is always returned beside the counts it came from,
// so a consumer who needs full precision recomputes rather than trusts. Two
// decimals because the third decimal of a rate over a dozen matches is noise
// dressed as precision.
func perMatchRate(total float64, sample int) float64 {
	if sample <= 0 {
		return 0
	}
	return math.Round(total/float64(sample)*100) / 100
}
```

Create `backend/reader/handlers_officials.go`:

```go
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// officialsCacheSeconds is five minutes. Everything in this file except the
// match list is either an appointment (fixed once announced, and unchanged
// during the match) or an aggregate over finished matches (which only moves when
// a match finishes). None of it tracks the live cadence, so none of it uses
// liveMaxAge.
const officialsCacheSeconds = 300

func (a *App) handleMatchOfficials(writer http.ResponseWriter, request *http.Request) {
	id, err := parseUUID(chi.URLParam(request, "id"))
	if err != nil {
		// Safe to echo: every error out of params.go is a constant declared
		// there, never a wrapped dependency error.
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	officials, storeErr := a.store.MatchOfficials(request.Context(), id)
	if storeErr != nil {
		a.logger.Error("match officials", "id", id, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if len(officials) == 0 {
		// Not []. An empty array would say this match was played without a
		// referee; the truth is that we hold no record of who worked it. An
		// unknown match id lands here too, deliberately - we hold no
		// "match exists" fact worth a separate status code, and giving the two
		// cases different codes would let a caller enumerate the match table.
		writeError(writer, http.StatusNotFound, "officials not recorded for this match")
		return
	}
	cacheFor(writer, officialsCacheSeconds)
	writeJSON(writer, http.StatusOK, officials)
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	MatchOfficials(context.Context, string) ([]MatchOfficial, error)
```

and register the route inside the `/v1` subrouter:

```go
		router.Get("/matches/{id}/officials", a.handleMatchOfficials)
```

> chi matches `/matches/{id}` and `/matches/{id}/officials` as distinct patterns — the
> second has an extra static segment — so the two coexist without ordering tricks.

In `backend/reader/server_test.go`, add to the `fakeReaderStore` struct:

```go
	matchOfficials    []MatchOfficial
	matchOfficialsErr error
```

and the method:

```go
func (f *fakeReaderStore) MatchOfficials(context.Context, string) ([]MatchOfficial, error) {
	f.calls++
	return f.matchOfficials, f.matchOfficialsErr
}
```

In `backend/reader/openapi.yaml`, add the path after `/v1/matches/{id}`:

```yaml
  /v1/matches/{id}/officials:
    get:
      operationId: listMatchOfficials
      summary: List the officiating crew for one match
      description: >-
        Named officials with identifiers, in the order the provider listed them.
        Crew size varies by competition - some publish only the referee - so a
        one-row response is normal, not degraded.


        A match we hold no crew for returns 404 rather than an empty array: an
        empty array would claim the match was played without a referee, which is
        never true, whereas absent data often is. An unknown match id returns the
        same 404.


        This is a different source from MatchSummary.info.referee, which is the
        provider's display string from a different upstream host. The two can
        legitimately disagree and nothing reconciles them.
      parameters:
        - $ref: "#/components/parameters/MatchUUID"
      responses:
        "200":
          description: The officiating crew
          headers:
            Cache-Control: { $ref: "#/components/headers/HistoricalCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/MatchOfficial" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/OfficialsNotRecorded" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

Under `components.parameters`, add:

```yaml
    MatchUUID:
      name: id
      in: path
      required: true
      description: >-
        Match identifier, a UUID. Validated as a UUID before any query runs,
        because it is bound to a uuid column and a non-UUID would otherwise
        surface as a 500 rather than the 400 it is.
      schema: { type: string, format: uuid }
```

> This is a **new** parameter rather than a change to the existing `MatchID`, which
> `/v1/matches/{id}` still uses. Tightening that one is the canonical-identity read-side
> sweep's job, not this plan's, and changing a parameter another route depends on would be
> an unrelated behaviour change smuggled into this PR.

Under `components.headers`, add `HistoricalCacheControl` **if it is not already there**:

```yaml
    HistoricalCacheControl:
      description: public, max-age=300. A finished day does not change.
      schema: { type: string, example: "public, max-age=300" }
```

> The `api-history` plan adds a header with this exact name and description. If it has
> already landed, **reuse the existing entry and add nothing** — a duplicate key makes the
> YAML ambiguous and `loadOpenAPI` will fail on it. If this plan lands first, `api-history`
> will find it already present and should do the same.

Under `components.responses`, add:

```yaml
    OfficialsNotRecorded:
      description: No officiating crew is recorded for this match, or the match is unknown
      headers:
        Cache-Control: { $ref: "#/components/headers/NoStoreCacheControl" }
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Error" }
```

Under `components.schemas`, add:

```yaml
    Official:
      type: object
      additionalProperties: false
      required: [id, name]
      properties:
        id:
          type: string
          format: uuid
          description: >-
            ScoreArc identifier, not the provider's. The provider id is held in a
            private crosswalk and is deliberately not exposed: a public URL built
            on a provider id would make that provider the identity authority.
        name: { type: string }
    MatchOfficial:
      type: object
      additionalProperties: false
      required: [official, role, roleId, order]
      properties:
        official: { $ref: "#/components/schemas/Official" }
        role:
          type: string
          description: >-
            The provider's own role text, stored verbatim and never mapped to an
            enum. Observed values include Referee, Assistant Referee, Fourth
            Official and VAR, but this list is not exhaustive and must not be
            treated as one - an unrecognised role is data, not an error.
        roleId:
          type: [string, "null"]
          description: >-
            The provider's position identifier - a stabler machine value than the
            role text. Null when the provider omits it.
        order:
          type: [integer, "null"]
          description: >-
            The provider's listing position within the crew. It is the only
            seniority signal the source carries, it is not derived, and it is
            null rather than zero when the provider omits it.
```

Finally add the route to `TestOpenAPIValidatesActualRouteResponses`'s table in
`openapi_test.go` and seed the fake:

```go
		{target: "/v1/matches/0f1c1a00-0000-4000-8000-00000000a001/officials", template: "/v1/matches/{id}/officials"},
```

```go
		matchOfficials: []MatchOfficial{{
			Official: Official{ID: "0f1c1a00-0000-4000-8000-000000000001", Name: "Howard Webb"},
			Role:     "Referee",
		}},
```

> That fixture leaves `RoleID` and `Order` nil on purpose, so the route validation test
> proves the `null` branch against the document rather than only the populated one.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestParseUUID|TestStoreMatchOfficials|TestMatchOfficials|TestOpenAPI" && go vet ./reader
```

Expected: `ok`, and `go vet` silent. If `TestOpenAPIDocumentsOperationalResponses` fails,
the new 404 response is missing its `Cache-Control` header entry. If `loadOpenAPI` fails
with a duplicate-key error, `HistoricalCacheControl` was added twice — remove yours.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/params.go backend/reader/params_test.go backend/reader/store_officials.go backend/reader/handlers_officials.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): serve the identified officiating crew for a match

A match with no recorded crew is a 404, not an empty array - [] would claim
the match was played without a referee, and absent data is a different fact
from a match without officials. Role text and the provider's position id are
served verbatim rather than mapped, both nullable fields stay null rather
than defaulting, and info.referee is left exactly as it is: two upstream
hosts, two answers, and nothing here picks one.

parseUUID replaces parseEntityID on these routes. Both ids are bound to uuid
columns, where a value that satisfies parseEntityID but is not a uuid becomes
a 500 instead of the 400 it is.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `GET /v1/officials/{officialId}` — the profile

**Files:**
- Modify: `backend/reader/store_officials.go`, `backend/reader/handlers_officials.go`, `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/server_test.go`

**Interfaces:**
- `Store.OfficialProfile(ctx context.Context, officialID string) (*OfficialProfile, error)` —
  `ErrNotFound` when no `official` row exists.

**Why this counts every state and Task 5 counts only finished matches.** The profile is a
**coverage record**: "here is what we hold for this person". A scheduled fixture with an
assigned referee is something we hold, so it counts here. Task 5 is a **statistic**, and a
referee's card rate cannot include a match that has not been played. The two endpoints
therefore report different `matches` numbers for the same official and season, on purpose,
and the OpenAPI descriptions say so.

**Why two queries and not one.** Identity comes from `official`; coverage comes from the
join. Doing it as one `LEFT JOIN` would collapse "an official we have never heard of" and
"an official we know but hold no appearances for" into the same zero-row result, and those
are different answers — 404 versus a 200 with an empty `seasons` array. The second round
trip buys that distinction, which is exactly the kind of distinction this whole plan is
about.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreOfficialProfile(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("coverage is grouped by competition and season", func(t *testing.T) {
		profile, err := store.OfficialProfile(ctx, "0f1c1a00-0000-4000-8000-000000000001")
		if err != nil {
			t.Fatal(err)
		}
		if profile.Official.Name != "Howard Webb" {
			t.Fatalf("identity = %+v", profile.Official)
		}
		if len(profile.Seasons) != 2 {
			t.Fatalf("seasons = %+v", profile.Seasons)
		}
		laliga := profile.Seasons[0]
		if laliga.Competition != "laliga" || laliga.Season != "2026-27" {
			t.Fatalf("first season = %+v", laliga)
		}
		// Three: two finished and one live. The profile is a record of what we
		// hold, not a statistic - Task 5's aggregate is where "finished only"
		// applies, and it reports 2 for the same person and season.
		if laliga.Matches != 3 {
			t.Fatalf("laliga matches = %d, want 3", laliga.Matches)
		}
		if len(laliga.Roles) != 1 || laliga.Roles[0] != "Referee" {
			t.Fatalf("roles = %+v", laliga.Roles)
		}
		worldCup := profile.Seasons[1]
		if worldCup.Competition != "world-cup" || worldCup.Season != "2026" || worldCup.Matches != 1 {
			t.Fatalf("second season = %+v", worldCup)
		}
	})

	t.Run("an unknown official is not found", func(t *testing.T) {
		_, err := store.OfficialProfile(ctx, "0f1c1a00-0000-4000-8000-00000000ffff")
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown official error = %v, want ErrNotFound", err)
		}
	})

	t.Run("a known official with no appearances is empty, not missing", func(t *testing.T) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO official (id, full_name)
			 VALUES ('0f1c1a00-0000-4000-8000-00000000000e', 'Rookie Official')`); err != nil {
			t.Fatal(err)
		}
		profile, err := store.OfficialProfile(ctx, "0f1c1a00-0000-4000-8000-00000000000e")
		if err != nil {
			t.Fatalf("known official with no appearances errored: %v", err)
		}
		if profile.Seasons == nil || len(profile.Seasons) != 0 {
			t.Fatalf("seasons = %#v, want an empty slice", profile.Seasons)
		}
	})
}
```

`store_integration_test.go` already imports `errors` for `TestStoreIntegration`.

Append to `backend/reader/server_test.go`:

```go
func TestOfficialProfileRoute(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{officialProfile: &OfficialProfile{
		Official: Official{ID: testOfficialID, Name: "Howard Webb"},
		Seasons: []OfficialSeasonRef{{
			Competition: "laliga", Season: "2026-27", Matches: 3, Roles: []string{"Referee"},
		}},
	}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/officials/"+testOfficialID)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestUnknownOfficialIsNotFound(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{officialProfileErr: ErrNotFound}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/officials/0f1c1a00-0000-4000-8000-00000000ffff")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "official not found") {
		t.Fatalf("body = %s", response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestOfficialProfileRequiresAUUID(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{}
	// "9078" is the ESPN official id from the recorded probe fixture. It is a
	// 400 on purpose: this route addresses our identity, not the provider's.
	for _, target := range []string{"/v1/officials/off-webb", "/v1/officials/9078"} {
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, target)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", target, response.Code, response.Body.String())
		}
	}
	if store.calls != 0 {
		t.Fatal("an invalid id reached the store")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestStoreOfficialProfile|TestOfficialProfile|TestUnknownOfficial"
```

Expected: FAIL — `undefined: OfficialProfile`, `store.OfficialProfile undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// OfficialSeasonRef is one (competition, season) we hold appearances in for an
// official, with the roles they held there. Matches counts every state,
// including scheduled fixtures: this is a record of what we hold, not a
// statistic. The finished-only count lives on OfficialSeason and is deliberately
// a different number.
type OfficialSeasonRef struct {
	Competition string   `json:"competition"`
	Season      string   `json:"season"`
	Matches     int      `json:"matches"`
	Roles       []string `json:"roles"`
}

// OfficialProfile is an identity plus its coverage. It carries no career totals
// and no ratings: everything derived belongs on the season aggregate, where the
// sample size that produced it is visible beside it.
type OfficialProfile struct {
	Official Official            `json:"official"`
	Seasons  []OfficialSeasonRef `json:"seasons"`
}
```

Append to `backend/reader/store_officials.go`:

```go
const officialIdentitySQL = `SELECT id, full_name FROM official WHERE id = $1::uuid`

// Coverage, not statistics: every state counts, because a scheduled fixture with
// an assigned referee is something we hold.
//
// count(DISTINCT m.id) rather than count(*): under PRIMARY KEY (match_id,
// official_id) these are the same today, and this file does not get to depend on
// the column list of a primary key it does not own. The cost is nil and the
// failure mode it guards against is a wrong number rather than an error.
//
// The row count is bounded by our own registry: at most one row per competition
// per season we ingest.
const officialCoverageSQL = `
SELECT m.comp_id, m.season_id,
       count(DISTINCT m.id)::int                    AS matches,
       array_agg(DISTINCT mo.role ORDER BY mo.role) AS roles
FROM match_official mo
JOIN match m ON m.id = mo.match_id
WHERE mo.official_id = $1::uuid
GROUP BY m.comp_id, m.season_id
ORDER BY m.comp_id, m.season_id`

func (s *Store) OfficialProfile(ctx context.Context, officialID string) (*OfficialProfile, error) {
	// Identity first, and as its own query. Folding this into the join below
	// would make "an official we have never heard of" and "an official we know
	// but hold no appearances for" the same zero-row answer, and those are a 404
	// and a 200 respectively.
	profile := &OfficialProfile{Seasons: []OfficialSeasonRef{}}
	if err := s.db.QueryRow(ctx, officialIdentitySQL, officialID).Scan(
		&profile.Official.ID, &profile.Official.Name,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	rows, err := s.db.Query(ctx, officialCoverageSQL, officialID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var season OfficialSeasonRef
		if err := rows.Scan(&season.Competition, &season.Season, &season.Matches, &season.Roles); err != nil {
			return nil, err
		}
		if season.Roles == nil {
			season.Roles = []string{}
		}
		profile.Seasons = append(profile.Seasons, season)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return profile, nil
}
```

Widen `store_officials.go`'s import block:

```go
import (
	"context"
	"errors"
	"math"

	"github.com/jackc/pgx/v5"
)
```

Append to `backend/reader/handlers_officials.go`:

```go
func (a *App) handleOfficialProfile(writer http.ResponseWriter, request *http.Request) {
	officialID, err := parseUUID(chi.URLParam(request, "officialId"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	profile, storeErr := a.store.OfficialProfile(request.Context(), officialID)
	if errors.Is(storeErr, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "official not found")
		return
	}
	if storeErr != nil {
		a.logger.Error("official profile", "official", officialID, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// A known official with no appearances yet is an empty array, not a 404.
	// The identity exists; the coverage does not.
	if profile.Seasons == nil {
		profile.Seasons = []OfficialSeasonRef{}
	}
	cacheFor(writer, officialsCacheSeconds)
	writeJSON(writer, http.StatusOK, profile)
}
```

and add `"errors"` to that file's import block.

In `backend/reader/server.go`, add to `readerStore`:

```go
	OfficialProfile(context.Context, string) (*OfficialProfile, error)
```

and register:

```go
		router.Get("/officials/{officialId}", a.handleOfficialProfile)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore`:

```go
	officialProfile    *OfficialProfile
	officialProfileErr error
```

```go
func (f *fakeReaderStore) OfficialProfile(context.Context, string) (*OfficialProfile, error) {
	f.calls++
	return f.officialProfile, f.officialProfileErr
}
```

In `backend/reader/openapi.yaml`, add the parameter:

```yaml
    OfficialID:
      name: officialId
      in: path
      required: true
      description: >-
        ScoreArc identifier for a match official, a UUID. This is not the ESPN
        official id: provider ids are held in a private crosswalk and are
        deliberately not addressable here, because a public URL keyed on a
        provider id makes that provider the identity authority.
      schema: { type: string, format: uuid }
```

the response:

```yaml
    OfficialNotFound:
      description: No official is held under this identifier
      headers:
        Cache-Control: { $ref: "#/components/headers/NoStoreCacheControl" }
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Error" }
```

the schemas:

```yaml
    OfficialSeasonRef:
      type: object
      additionalProperties: false
      required: [competition, season, matches, roles]
      properties:
        competition: { type: string }
        season: { type: string }
        matches:
          type: integer
          description: >-
            Every match we hold an appearance for, in every state, including
            scheduled fixtures. This is a coverage count, not a statistic - it is
            deliberately larger than the matches field on OfficialSeason, which
            counts finished matches only.
        roles: { type: array, items: { type: string } }
    OfficialProfile:
      type: object
      additionalProperties: false
      required: [official, seasons]
      properties:
        official: { $ref: "#/components/schemas/Official" }
        seasons:
          type: array
          description: Empty when the official is known but no appearances are held yet.
          items: { $ref: "#/components/schemas/OfficialSeasonRef" }
```

and the path, after `/v1/matches/{id}/officials`:

```yaml
  /v1/officials/{officialId}:
    get:
      operationId: getOfficialProfile
      summary: Get an official's identity and the seasons we hold appearances in
      description: >-
        Identity plus one row per competition and season we hold an appearance
        for. An unknown identifier is a 404; a known official with no appearances
        yet is a 200 with an empty seasons array.
      parameters:
        - { $ref: "#/components/parameters/OfficialID" }
      responses:
        "200":
          description: Official profile
          headers:
            Cache-Control: { $ref: "#/components/headers/HistoricalCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/OfficialProfile" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/OfficialNotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

In `openapi_test.go`, add the row and seed the fake:

```go
		{target: "/v1/officials/0f1c1a00-0000-4000-8000-000000000001", template: "/v1/officials/{officialId}"},
```

```go
		officialProfile: &OfficialProfile{
			Official: Official{ID: "0f1c1a00-0000-4000-8000-000000000001", Name: "Howard Webb"},
			Seasons: []OfficialSeasonRef{{
				Competition: "laliga", Season: "2026-27", Matches: 3, Roles: []string{"Referee"},
			}},
		},
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestStoreOfficialProfile|TestOfficialProfile|TestUnknownOfficial|TestOpenAPI" && go vet ./reader
```

Expected: `ok`, `go vet` silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_officials.go backend/reader/handlers_officials.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): add the official profile endpoint

Identity plus the competitions and seasons we hold appearances in. Two
queries rather than one join, because an official we have never heard of
(404) and an official we know with no appearances yet (200, empty seasons)
are different answers and a single left join collapses them. The profile
counts every match state; only the season aggregate is finished-only.

{officialId} is our uuid and an ESPN official id is a 400 there. Exposing
the provider id in a public URL would make the provider the identity
authority, which is the rule official_external_ref exists to enforce.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `MatchFilter.OfficialID` and `GET /v1/officials/{officialId}/matches`

**Files:**
- Modify: `backend/reader/store.go`, `backend/reader/handlers_officials.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/server_test.go`

**Interfaces:**
- `MatchFilter` gains `OfficialID string`
- `Store.Matches` accepts an empty `competition` and/or `season` meaning "every one", guarded

> **PLACEHOLDER NUMBERING — READ THIS BEFORE EDITING `matchesSQL`.**
>
> T10.1 left `matchesSQL` with `$1` comp, `$2` season, `$3` from, `$4` to, `$5` state, and
> `LIMIT $6` inside `matchOrderSQL`. The **`api-teams` plan (T10.2) also extends this
> statement**: it inserts a `TeamID` predicate at `$6` and moves `LIMIT` to `$7`.
>
> This plan inserts an `OfficialID` predicate and moves `LIMIT` one further along. **Which
> number you use depends on whether `api-teams` has landed:**
>
> | State of `backend/reader/store.go` | `OfficialID` placeholder | `LIMIT` placeholder |
> |---|---:|---:|
> | no `TeamID` field on `MatchFilter` | `$6` | `$7` |
> | `TeamID` already present at `$6` | `$7` | `$8` |
>
> **Read the file, count the placeholders, and match the argument list in `Matches` to
> them.** A misnumbered placeholder here does **not** error — pgx binds the wrong argument
> to the wrong predicate and the query returns wrong rows with a 200. The integration test
> in Step 1 pins `OfficialID` and `Limit` together for exactly that reason: it is the only
> thing that catches the mistake. Whichever of the two plans lands second owns the
> reconciliation, and this note is the same on both sides.
>
> The code below is written for the **first** case (`api-teams` has not landed). If it has,
> shift both numbers by one and keep the `$6` team predicate where it is.

**Why `EXISTS` and not a `JOIN`.** Under `PRIMARY KEY (match_id, official_id)` a join would
not duplicate today, so this is not a bug fix — it is a choice about which question the SQL
asks. `EXISTS` asks "did this person work this match", returns each match once by
construction, and stays correct if the key ever widens to include `role` (which is exactly
the shape a crew-correction model would want, and exactly what an earlier draft of this plan
assumed). A join asks "give me the appearance rows" and then relies on a key it does not
state to avoid duplicating the match. `match_official_official_idx (official_id)` is what
makes the `EXISTS` cheap.

**Why the competition scope becomes optional, and why that needs a guard.** An official's
career crosses competitions; asking "every match this person worked" must not require naming
one. So `$1`/`$2` become NULL-tolerant like the other optional predicates. That opens a real
hazard — `Matches(ctx, "", "", MatchFilter{})` would return every match in the database — so
`Matches` refuses that combination outright. The guard is not reachable through the router
(`{officialId}` is a required path segment), which is precisely why it belongs in the store:
an unreachable hole is one refactor away from being reachable.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreMatchFilterByOfficial(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()
	const webb = "0f1c1a00-0000-4000-8000-000000000001"

	t.Run("an official's matches cross competitions when none is named", func(t *testing.T) {
		matches, err := store.Matches(ctx, "", "", MatchFilter{OfficialID: webb, Order: "asc"})
		if err != nil {
			t.Fatal(err)
		}
		// The world-cup final (2026-07-19) then the three laliga fixtures.
		if len(matches) != 4 {
			t.Fatalf("matches = %d: %+v", len(matches), matches)
		}
		want := []string{
			"0f1c1a00-0000-4000-8000-00000000a001",
			"0f1c1a00-0000-4000-8000-00000000a002",
			"0f1c1a00-0000-4000-8000-00000000a003",
		}
		for index, id := range want {
			if matches[index+1].ID != id {
				t.Fatalf("matches[%d] = %q, want %q", index+1, matches[index+1].ID, id)
			}
		}
	})

	t.Run("naming a competition narrows it", func(t *testing.T) {
		matches, err := store.Matches(ctx, "laliga", "2026-27", MatchFilter{OfficialID: webb, Order: "asc"})
		if err != nil || len(matches) != 3 {
			t.Fatalf("laliga matches = %+v, err %v", matches, err)
		}
		none, err := store.Matches(ctx, "world-cup", "2026", MatchFilter{
			OfficialID: "0f1c1a00-0000-4000-8000-000000000004", Order: "asc",
		})
		if err != nil || none == nil || len(none) != 0 {
			t.Fatalf("cross-competition leak = %#v, err %v", none, err)
		}
	})

	t.Run("a competition with no season is every season of it", func(t *testing.T) {
		matches, err := store.Matches(ctx, "laliga", "", MatchFilter{OfficialID: webb, Order: "asc"})
		if err != nil || len(matches) != 3 {
			t.Fatalf("season-less matches = %+v, err %v", matches, err)
		}
	})

	t.Run("limit and official move together", func(t *testing.T) {
		// This subtest is the placeholder-numbering guard. If LIMIT and the
		// official predicate are bound to each other's positions, this returns
		// wrong rows with no error at all.
		one := 1
		matches, err := store.Matches(ctx, "", "", MatchFilter{
			OfficialID: webb, Order: "desc", Limit: &one,
		})
		if err != nil || len(matches) != 1 ||
			matches[0].ID != "0f1c1a00-0000-4000-8000-00000000a003" {
			t.Fatalf("most recent = %+v, err %v", matches, err)
		}
		three := 3
		windowed, err := store.Matches(ctx, "", "", MatchFilter{
			OfficialID: webb, State: "finished", Order: "asc", Limit: &three,
		})
		if err != nil || len(windowed) != 2 {
			t.Fatalf("finished matches = %+v, err %v", windowed, err)
		}
	})

	t.Run("an unknown official is empty, not an error", func(t *testing.T) {
		matches, err := store.Matches(ctx, "", "", MatchFilter{
			OfficialID: "0f1c1a00-0000-4000-8000-00000000ffff", Order: "asc",
		})
		if err != nil || matches == nil || len(matches) != 0 {
			t.Fatalf("matches = %#v, err %v", matches, err)
		}
	})

	t.Run("an unscoped read is refused rather than served", func(t *testing.T) {
		// Unreachable through the router today. It is refused here because an
		// unreachable hole is one refactor from being reachable, and the failure
		// mode is "return the entire match table".
		if _, err := store.Matches(ctx, "", "", MatchFilter{Order: "asc"}); err == nil {
			t.Fatal("an unscoped match query was served")
		}
	})
}
```

Append to `backend/reader/server_test.go`:

```go
func TestOfficialMatchesReusesTheMatchFilter(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet,
		"/v1/officials/"+testOfficialID+"/matches?comp=laliga&season=2026-27&range=20260801-20260831&order=desc&limit=25")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if store.matchComp != "laliga" || store.matchSeason != "2026-27" {
		t.Fatalf("scope = %q/%q", store.matchComp, store.matchSeason)
	}
	filter := store.matchFilter
	if filter.OfficialID != testOfficialID || filter.Order != "desc" {
		t.Fatalf("filter = %+v", filter)
	}
	if filter.Limit == nil || *filter.Limit != 25 {
		t.Fatalf("limit = %v", filter.Limit)
	}
	if filter.From == nil || !filter.From.Equal(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("From = %v", filter.From)
	}
}

func TestOfficialMatchesDefaultsToACappedRead(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	if response := performRequest(router, http.MethodGet,
		"/v1/officials/"+testOfficialID+"/matches"); response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	// Unlike a season's fixture list, an official's match list has no bound in
	// the data: it grows for as long as that person works. Absent limit
	// therefore means 500, not unlimited.
	filter := store.matchFilter
	if filter.Limit == nil || *filter.Limit != maxMatchLimit {
		t.Fatalf("default limit = %v, want %d", filter.Limit, maxMatchLimit)
	}
	if store.matchComp != "" || store.matchSeason != "" {
		t.Fatalf("unscoped read did not stay unscoped: %q/%q", store.matchComp, store.matchSeason)
	}
}

func TestOfficialMatchesRejectsBadScopesBeforeAnyQuery(t *testing.T) {
	t.Parallel()
	base := "/v1/officials/" + testOfficialID + "/matches"
	for _, target := range []string{
		"/v1/officials/off-webb/matches",
		base + "?comp=not-real",
		base + "?comp=laliga&season=1066",
		// A season identifier means nothing without the competition it belongs
		// to. Guessing which competition was meant is exactly the silent
		// fallback this codebase refuses.
		base + "?season=2026-27",
		base + "?range=20260831-20260801",
		base + "?limit=501",
		base + "?order=DESC",
		base + "?state=post",
	} {
		store := &fakeReaderStore{matches: []Match{}}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, target)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", target, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", target)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s Cache-Control = %q", target, response.Header().Get("Cache-Control"))
		}
	}
}

func TestOfficialMatchesTracksTheLiveCadence(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{matches: []Match{{
		ID: testMatchID, State: espn.MatchStateLive, Scorers: []espn.Scorer{}, Cards: []espn.Card{},
	}}}
	response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(),
		http.MethodGet, "/v1/officials/"+testOfficialID+"/matches")
	// This one endpoint does return live matches, so it uses liveMaxAge rather
	// than the five-minute appointment cache.
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=10" {
		t.Fatalf("Cache-Control = %q", got)
	}
}
```

Extend `TestNilListDependenciesStillEncodeArrays`'s path list with the one new array route
that is legitimately empty:

```go
		"/v1/officials/0f1c1a00-0000-4000-8000-000000000001/matches",
```

> `/v1/matches/{id}/officials` is **not** added to that list. It 404s on an empty result by
> design, and adding it would assert the opposite of Task 2.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestStoreMatchFilterByOfficial|TestOfficialMatches"
```

Expected: FAIL — `unknown field OfficialID in struct literal of type MatchFilter`, and
`404` on every `/v1/officials/{id}/matches` request because the route does not exist.

- [ ] **Step 3: Implement**

In `backend/reader/store.go`, replace the `WHERE` clause of `matchesSQL`, the
`matchOrderSQL` map, the `MatchFilter` struct and the argument list in `Matches`:

```go
// matchesSQL is a single statement for every filter combination. Each optional
// predicate is a typed placeholder compared against NULL, so one prepared plan
// serves a windowed read, a state read, an official's career and a whole-season
// read - and no predicate is ever built by string concatenation.
//
// The competition scope is optional because an official's career crosses
// competitions. Matches() refuses a read that is scoped by neither a competition
// nor an official; see errUnscopedMatchQuery.
//
// The official predicate is EXISTS rather than a join: it asks "did this person
// work this match", which returns each match once by construction, instead of
// asking for the appearance rows and relying on a primary key this file does not
// own to avoid duplicating the match.
const matchesSQL = `
SELECT m.id, m.kickoff, m.state, m.minute, m.status_detail, m.status_name,
       m.home_score, m.away_score, m.winner_id, m.note,
       ht.id, ht.name, ht.abbr, ht.crest_url,
       at.id, at.name, at.abbr, at.crest_url,
       d.scorers, d.cards, d.stats, d.win_probability, d.shootout, d.shootout_detail
FROM match m
JOIN team ht ON ht.id = m.home_team_id
JOIN team at ON at.id = m.away_team_id
LEFT JOIN match_detail d ON d.match_id = m.id
WHERE ($1::text IS NULL OR m.comp_id   = $1)
  AND ($2::text IS NULL OR m.season_id = $2)
  AND ($3::timestamptz IS NULL OR m.kickoff >= $3)
  AND ($4::timestamptz IS NULL OR m.kickoff <  $4)
  AND ($5::text IS NULL OR m.state = $5)
  AND ($6::uuid IS NULL OR EXISTS (
        SELECT 1 FROM match_official mo
        WHERE mo.match_id = m.id AND mo.official_id = $6::uuid))
`

// matchOrderSQL holds the only fragment in this file that is concatenated rather
// than bound. Its key is the output of parseOrder, which returns one of exactly
// two constants, so no request text can reach the statement.
//
// LIMIT is $7 because the official predicate above took $6. Both values below
// and the argument list in Matches move together, and a mismatch returns wrong
// rows rather than an error - TestStoreMatchFilterByOfficial pins limit and
// official together for that reason.
var matchOrderSQL = map[string]string{
	"asc":  "ORDER BY m.kickoff, m.id LIMIT $7",
	"desc": "ORDER BY m.kickoff DESC, m.id DESC LIMIT $7",
}

// MatchFilter is the validated shape of a match query. Every field is optional;
// the zero value combined with a competition is "the whole season in kickoff
// order".
type MatchFilter struct {
	From       *time.Time // inclusive
	To         *time.Time // exclusive
	State      string     // "" means every state
	Order      string     // "asc" (default) or "desc"
	Limit      *int       // nil means no limit
	OfficialID string     // "" means every match; matches any recorded role
}

// errUnscopedMatchQuery is never echoed to a client - it is a programming error,
// not a request error, and a handler that hits it logs and returns 500. It
// exists because making the competition scope optional turned "forgot to pass a
// scope" from a compile-time impossibility into a runtime read of the entire
// match table.
var errUnscopedMatchQuery = errors.New(
	"match query must be scoped by a competition or an official")
```

and inside `Matches`, replace the argument preparation and the `Query` call:

```go
	if competition == "" && filter.OfficialID == "" {
		return nil, errUnscopedMatchQuery
	}
	var comp, seasonValue, state, officialID any
	// nil, not "": an empty string would be compared against real column values
	// and match nothing, turning "no filter" into "every row is hidden".
	if competition != "" {
		comp = competition
	}
	if season != "" {
		seasonValue = season
	}
	if filter.State != "" {
		state = filter.State
	}
	if filter.OfficialID != "" {
		officialID = filter.OfficialID
	}
	rows, err := s.db.Query(ctx, matchesSQL+clause,
		comp, seasonValue, filter.From, filter.To, state, officialID, filter.Limit)
```

`store.go` already imports `errors`. Leave the scan loop, `normalizeMatch` call and
`rows.Err()` return exactly as they are.

Append to `backend/reader/handlers_officials.go`:

```go
func (a *App) handleOfficialMatches(writer http.ResponseWriter, request *http.Request) {
	officialID, err := parseUUID(chi.URLParam(request, "officialId"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	query := request.URL.Query()
	competition, season := query.Get("comp"), query.Get("season")
	switch {
	case competition == "" && season != "":
		// A season identifier is only meaningful inside a competition. Guessing
		// which one was meant is the silent fallback this codebase refuses.
		writeError(writer, http.StatusBadRequest, "season requires comp")
		return
	case competition != "" && season != "":
		if _, _, ok := a.resolve(competition, season); !ok {
			writeError(writer, http.StatusBadRequest, "unknown competition or season")
			return
		}
	case competition != "":
		if _, ok := a.registry.Get(competition); !ok {
			writeError(writer, http.StatusBadRequest, "unknown competition")
			return
		}
	}

	filter, err := parseMatchFilter(request)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	filter.OfficialID = officialID
	if filter.Limit == nil {
		// Unlike a season's fixture list, this one has no bound in the data: it
		// grows every week for as long as this person works, across every
		// competition we ingest. "Absent means unlimited" would make the
		// cheapest request the most expensive one we serve.
		capped := maxMatchLimit
		filter.Limit = &capped
	}

	matches, storeErr := a.store.Matches(request.Context(), competition, season, filter)
	if storeErr != nil {
		a.logger.Error("official matches", "official", officialID, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// An official we have never heard of returns [], not 404. This endpoint is a
	// filter over matches, and "no matches for this filter" is a legitimate
	// empty - including when the filter names nobody. /v1/officials/{officialId}
	// is the endpoint that asserts existence; making this one assert it too
	// would cost a second query on every request to improve one error message.
	if matches == nil {
		matches = []Match{}
	}
	anyLive := false
	for _, match := range matches {
		if match.State == espn.MatchStateLive {
			anyLive = true
			break
		}
	}
	// The only endpoint in this file that tracks the live cadence: a crew is
	// fixed, but the matches it worked keep changing while they are being played.
	cacheFor(writer, liveMaxAge(anyLive))
	writeJSON(writer, http.StatusOK, matches)
}
```

Add `"github.com/mcasillas17/scorearc-backend/shared/espn"` to `handlers_officials.go`'s
import block.

In `backend/reader/server.go`, register:

```go
		router.Get("/officials/{officialId}/matches", a.handleOfficialMatches)
```

`readerStore` needs no change — this endpoint reuses `Matches`.

In `backend/reader/server_test.go`, record the scope in the fake so the handler tests can
assert on it:

```go
	matchComp   string
	matchSeason string
```

```go
func (f *fakeReaderStore) Matches(ctx context.Context, competition string, season string, filter MatchFilter) ([]Match, error) {
	f.calls++
	f.matchComp, f.matchSeason, f.matchFilter = competition, season, filter
	_, f.matchesHasDeadline = ctx.Deadline()
	return f.matches, f.matchesErr
}
```

In `backend/reader/openapi.yaml`, add two parameters:

```yaml
    CompetitionFilter:
      name: comp
      in: query
      required: false
      description: >-
        Restrict to one whitelisted competition. Absent means every competition
        we hold an appearance in.
      schema: { type: string, minLength: 1 }
    SeasonFilter:
      name: season
      in: query
      required: false
      description: >-
        Restrict to one season within comp. Supplying season without comp is a
        400: a season identifier is not meaningful on its own.
      schema: { type: string, minLength: 1 }
```

and the path:

```yaml
  /v1/officials/{officialId}/matches:
    get:
      operationId: listOfficialMatches
      summary: List the matches an official worked
      description: >-
        Matches with any recorded role for this official, oldest-first by
        default. Unlike a season's match list, this one is capped at 500 rows
        even when no limit is supplied: an official's career grows without bound,
        so an absent limit means 500 rather than unlimited. Use order=desc for
        the recent end and range= to page backwards.


        An unknown official returns an empty array rather than 404 - this is a
        filter over matches, and /v1/officials/{officialId} is the endpoint that
        asserts existence.
      parameters:
        - { $ref: "#/components/parameters/OfficialID" }
        - { $ref: "#/components/parameters/CompetitionFilter" }
        - { $ref: "#/components/parameters/SeasonFilter" }
        - { $ref: "#/components/parameters/Range" }
        - { $ref: "#/components/parameters/MatchStateFilter" }
        - { $ref: "#/components/parameters/Order" }
        - { $ref: "#/components/parameters/Limit" }
      responses:
        "200":
          description: Matches this official worked
          headers:
            Cache-Control: { $ref: "#/components/headers/LiveCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/Match" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

> `Range`, `MatchStateFilter`, `Order` and `Limit` are T10.1's parameter components, reused
> verbatim. `state` is documented even though the original task brief listed only `comp`,
> `season`, `range`, `order` and `limit`: this handler calls the shared `parseMatchFilter`,
> which parses `state` too, so `?state=finished` **works**. Documenting a parameter that
> works is cheaper and more honest than stripping a working one to match a shorter list.

In `openapi_test.go`, add the row:

```go
		{target: "/v1/officials/0f1c1a00-0000-4000-8000-000000000001/matches", template: "/v1/officials/{officialId}/matches"},
```

The fake's existing `matches` seed already makes this response non-trivial.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestStoreMatchFilter|TestOfficialMatches|TestMatches|TestNilList|TestOpenAPI"
```

Expected: `ok`. `TestStoreMatchFilter` and `TestMatchesQueryParameters` from T10.1 are the
guard that the placeholder renumbering did not break the existing limit and window
behaviour — if either fails, `LIMIT` and the official predicate are bound to each other's
positions.

```bash
cd backend && go test -race ./reader
```

Expected: `ok` — the whole suite still passes with the widened fake.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store.go backend/reader/handlers_officials.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): list the matches an official worked

MatchFilter gains OfficialID as an EXISTS predicate rather than a join: it
asks whether this person worked this match, which returns each match once by
construction instead of relying on a primary key this file does not own. The
competition scope becomes optional because a career crosses competitions,
and Matches refuses a read scoped by neither a competition nor an official
rather than returning the whole table.

LIMIT moves one placeholder along; a mismatch there returns wrong rows
instead of an error, so the integration test pins limit and official
together.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `GET /v1/competitions/{comp}/{season}/officials` — the aggregates

**Files:**
- Modify: `backend/reader/store_officials.go`, `backend/reader/handlers_officials.go`, `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/store_integration_test.go`, `backend/reader/server_test.go`

**Interfaces:**
- `Store.OfficialSeasons(ctx context.Context, competition, season string) ([]OfficialSeason, error)`

**The aggregates are the point of this plan, and they are gated on history.**

A referee's card rate over one match is not a fact about the referee; it is a fact about
that match. Two red cards in a cup tie says something about the tie. The same referee across
forty league fixtures says something about the referee. This endpoint cannot tell those
apart on its own — only accumulated data can — so it does the one honest thing available:
**it reports the sample size beside every rate.**

`matches` is a required field for exactly that reason. A consumer that receives
`cardsPerMatch: 5.5, matches: 2` can see that it holds a two-match sample and refuse to
render a league table of "strictest referees" from it. A consumer that receives
`cardsPerMatch: 5.5` alone cannot, and will render it. `foulMatches` is required for the
same reason and is a *different* number from `matches` — a competition that publishes fouls
for some matches and not others has a smaller foul sample than card sample, and collapsing
the two would attach a rate to a denominator that never applied to it.

**This endpoint therefore becomes meaningful only once E7's history accumulates.** Today,
against a season two weeks old, it returns arithmetically correct numbers over samples too
small to mean anything. That is not a defect to be fixed by hiding it; it is what the data
supports, and the sample sizes in the response are how a consumer finds out.

**Why the aggregate groups by role instead of filtering to referees.**

Attributing a card rate to a fourth official would be a fabricated statistic — the fourth
official did not show those cards. The obvious fix is `WHERE role = 'Referee'`, and it is
wrong twice: it pins provider text inside SQL, in a schema that deliberately stores role
verbatim precisely so an unfamiliar role survives; and it silently discards every row we
could not classify. Grouping by `(official, role)` instead means one row per person per role
they held, each honestly labelled, and the consumer decides which roles carry meaning for
the question they are asking. It costs a few more rows and it invents nothing.

**`role_id` is deliberately not a grouping key.** It is the stabler machine value and it
would be the better key — except it is nullable. A competition that sends `position.id` on
some matches and not others would split one official's season into two rows for the same
role, which is a worse failure than not having the stable id in this response at all. It is
exposed per-row on `/matches/{id}/officials`, where nothing is grouped.

**Why `count(*)` and not `count(DISTINCT m.id)` here.** The profile query uses `DISTINCT` as
cheap insurance. This one must not: if `PRIMARY KEY (match_id, official_id)` were ever lost,
a duplicated appearance would run the card lateral twice as well, doubling the numerator.
`count(DISTINCT m.id)` would fix only the denominator and produce a *more* plausible wrong
number than `count(*)` does. So this query depends on the key openly, and
`TestOneOfficialAppearsOncePerMatch` in Task 1 is what holds it.

**Only finished matches enter the aggregates.** A scheduled fixture with an assigned referee
contributes to that official's future workload — which is what `/officials/{id}` and
`/officials/{id}/matches` report — not to their card rate. A live match is excluded for the
same reason: its cards are not final.

**Fouls are `null`, never `0`, when a competition does not publish them.** `0` is a claim
that no fouls were committed. Absence is not that claim. `sum()` over an all-`NULL` column
returns `NULL` and is passed straight through; `foulMatches` is `0` beside it so the reason
is visible. And the numeric cast is guarded by `jsonb_typeof(...) = 'number'` on **both**
sides of the match: a single stat typed as a string upstream would otherwise raise
`invalid input syntax for type numeric` and 500 the entire competition's aggregate over one
bad row. Half a foul count is not a foul count, so a match with one good side and one bad
side contributes `NULL`, not the half it has.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreOfficialSeasons(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("one row per official per role, ordered by workload", func(t *testing.T) {
		seasons, err := store.OfficialSeasons(ctx, "laliga", "2026-27")
		if err != nil {
			t.Fatal(err)
		}
		if len(seasons) != 4 {
			t.Fatalf("rows = %d: %+v", len(seasons), seasons)
		}
		referee := seasons[0]
		if referee.Official.Name != "Howard Webb" || referee.Role != "Referee" {
			t.Fatalf("first row = %+v", referee)
		}
		// Two, not three: the third laliga fixture is live and never enters an
		// aggregate. If the finished filter were dropped this reads 3 and the
		// card counts change with it.
		if referee.Matches != 2 {
			t.Fatalf("matches = %d, want 2", referee.Matches)
		}
		if referee.YellowCards != 5 || referee.RedCards != 1 {
			t.Fatalf("cards = %d yellow / %d red", referee.YellowCards, referee.RedCards)
		}
		if referee.CardsPerMatch != 3 {
			t.Fatalf("cardsPerMatch = %v, want 3", referee.CardsPerMatch)
		}
		// The second fixture's away fouls are the string "7". That match
		// contributes no foul total at all - not the half it has - so the foul
		// sample is one match while the card sample is two.
		if referee.FoulMatches != 1 {
			t.Fatalf("foulMatches = %d, want 1", referee.FoulMatches)
		}
		if referee.Fouls == nil || *referee.Fouls != 22 {
			t.Fatalf("fouls = %v, want 22", referee.Fouls)
		}
		if referee.FoulsPerMatch == nil || *referee.FoulsPerMatch != 22 {
			t.Fatalf("foulsPerMatch = %v, want 22", referee.FoulsPerMatch)
		}

		// Ties on matches break by name, so the three single-match rows are
		// Anthony Taylor, Daniele Orsato, Ricardo Costa.
		if seasons[1].Official.Name != "Anthony Taylor" || seasons[1].Role != "Fourth Official" {
			t.Fatalf("second row = %+v", seasons[1])
		}
		// That fourth official's only match is the one with the unusable foul
		// stat, so the rate is null with a zero sample beside it rather than a
		// zero that looks like a measurement.
		if seasons[1].FoulMatches != 0 || seasons[1].Fouls != nil || seasons[1].FoulsPerMatch != nil {
			t.Fatalf("unusable fouls became a number: %+v", seasons[1])
		}
		if seasons[2].Role != "VAR" || seasons[3].Role != "Assistant Referee" {
			t.Fatalf("tail rows = %+v", seasons[2:])
		}
	})

	t.Run("a competition that publishes no fouls reports null, not zero", func(t *testing.T) {
		seasons, err := store.OfficialSeasons(ctx, "liga-mx", "2026-apertura")
		if err != nil {
			t.Fatal(err)
		}
		if len(seasons) != 1 || seasons[0].Official.Name != "Marco Aguilar" {
			t.Fatalf("rows = %+v", seasons)
		}
		row := seasons[0]
		if row.Matches != 1 || row.YellowCards != 1 || row.RedCards != 0 || row.CardsPerMatch != 1 {
			t.Fatalf("cards = %+v", row)
		}
		if row.FoulMatches != 0 || row.Fouls != nil || row.FoulsPerMatch != nil {
			t.Fatalf("fouls = %+v", row)
		}

		// The rule is about the wire, not the struct: zero fouls is a claim and
		// absence is not, and the difference has to survive serialization.
		encoded, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		body := string(encoded)
		for _, want := range []string{`"fouls":null`, `"foulsPerMatch":null`, `"foulMatches":0`} {
			if !strings.Contains(body, want) {
				t.Fatalf("serialized row missing %s: %s", want, body)
			}
		}
		for _, forbidden := range []string{`"fouls":0`, `"foulsPerMatch":0`} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("absence was serialized as zero: %s", body)
			}
		}
	})

	t.Run("a season with no officiated matches is empty, not an error", func(t *testing.T) {
		// Unlike /matches/{id}/officials, [] is the honest answer here: "we hold
		// no officiated matches for this season yet" is a real state of the
		// world, and a 404 would say the season does not exist.
		seasons, err := store.OfficialSeasons(ctx, "world-cup", "1998")
		if err != nil || seasons == nil || len(seasons) != 0 {
			t.Fatalf("seasons = %#v, err %v", seasons, err)
		}
	})

	t.Run("a live match never enters an aggregate", func(t *testing.T) {
		// The world-cup final is live and Howard Webb is its referee, so
		// world-cup/2026 has an appearance but no finished match to aggregate.
		seasons, err := store.OfficialSeasons(ctx, "world-cup", "2026")
		if err != nil || len(seasons) != 0 {
			t.Fatalf("world-cup aggregates = %+v, err %v", seasons, err)
		}
	})
}
```

Add `"encoding/json"` and `"strings"` to `store_integration_test.go`'s imports.

Append to `backend/reader/server_test.go`:

```go
func TestOfficialSeasonsRoute(t *testing.T) {
	t.Parallel()
	fouls, rate := 22.0, 11.0
	store := &fakeReaderStore{officialSeasons: []OfficialSeason{{
		Official: Official{ID: testOfficialID, Name: "Howard Webb"}, Role: "Referee",
		Matches: 2, YellowCards: 5, RedCards: 1, CardsPerMatch: 3,
		FoulMatches: 2, Fouls: &fouls, FoulsPerMatch: &rate,
	}}}
	router := newTestApp(t, store, &fakeNewsReader{}).router()

	response := performRequest(router, http.MethodGet, "/v1/competitions/laliga/2026-27/officials")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q", got)
	}
	// The sample size travels with every rate. A consumer that cannot see it
	// cannot tell a two-match sample from a forty-match one.
	if !strings.Contains(response.Body.String(), `"matches":2`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestOfficialSeasonsValidatesItsCompetition(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{}
	for _, target := range []string{
		"/v1/competitions/not-real/2026-27/officials",
		"/v1/competitions/laliga/1066/officials",
	} {
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, target)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d", target, response.Code)
		}
	}
	if store.calls != 0 {
		t.Fatal("an unknown competition reached the store")
	}
}
```

Extend `TestNilListDependenciesStillEncodeArrays`'s path list:

```go
		"/v1/competitions/world-cup/2026/officials",
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestStoreOfficialSeasons|TestOfficialSeasons"
```

Expected: FAIL — `undefined: OfficialSeason`, `store.OfficialSeasons undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// OfficialSeason is one official's record in one role over one competition
// season, computed from finished matches only.
//
// Every rate ships with the sample it was computed from, and they are separate
// samples: Matches is the card denominator, FoulMatches is the foul denominator,
// and a competition that publishes fouls unevenly makes them differ. A rate
// without its denominator is unfalsifiable, and this endpoint will spend its
// first season answering over samples of two or three - the denominators are how
// a consumer finds that out rather than being handed a number that looks solid.
//
// Fouls and FoulsPerMatch are nil when the competition publishes no usable foul
// counts. Nil serializes to null; zero would be a claim that no fouls occurred.
type OfficialSeason struct {
	Official      Official `json:"official"`
	Role          string   `json:"role"`
	Matches       int      `json:"matches"`
	YellowCards   int      `json:"yellowCards"`
	RedCards      int      `json:"redCards"`
	CardsPerMatch float64  `json:"cardsPerMatch"`
	FoulMatches   int      `json:"foulMatches"`
	Fouls         *float64 `json:"fouls"`
	FoulsPerMatch *float64 `json:"foulsPerMatch"`
}
```

Append to `backend/reader/store_officials.go`:

```go
// Per-official, per-role aggregates over the finished matches of one season.
//
// Grouped by role rather than filtered to 'Referee'. A fourth official did not
// show the cards in a match, so folding every role into one row would fabricate
// a statistic - but filtering on the literal 'Referee' would pin provider text
// inside SQL in a schema that stores role verbatim precisely so an unfamiliar
// role survives, and would silently drop every row it could not classify. One
// labelled row per role invents nothing and lets the consumer choose.
//
// role_id is NOT a grouping key even though it is the stabler machine value: it
// is nullable, and a competition that sends it unevenly would split one
// official's season into two rows for the same role.
//
// count(*), not count(DISTINCT m.id). A duplicated appearance would also run the
// card lateral twice, so DISTINCT would fix the denominator and leave the
// numerator doubled - a more plausible wrong number than the one it replaced.
// This query depends on PRIMARY KEY (match_id, official_id) openly, and
// TestOneOfficialAppearsOncePerMatch is what holds it.
//
// Only finished matches. A scheduled fixture with an assigned referee is future
// workload, not a card rate; a live match's cards are not final.
//
// Both laterals are CROSS JOIN LATERAL over aggregate subqueries, which always
// yield exactly one row, so neither can drop a match. Both are guarded by
// jsonb_typeof: cards may be absent or - through a bad upstream write - not an
// array at all, and a foul count may arrive as a string. CASE evaluates only the
// branch it selects, so the ::numeric cast never runs on a non-number and one
// malformed value cannot 500 an entire competition's aggregate.
//
// The foul total requires BOTH sides to be numeric. Half a match's fouls is not
// a foul count, so a half-typed match contributes NULL and is excluded from
// foul_matches rather than counted with a wrong total.
//
// No LIMIT: the bound is the officials a federation appoints for a season times
// the handful of roles a crew has. That is data, not caller input.
const officialSeasonsSQL = `
SELECT o.id, o.full_name, mo.role,
       count(*)::int                       AS matches,
       coalesce(sum(cards.yellow), 0)::int AS yellow_cards,
       coalesce(sum(cards.red), 0)::int    AS red_cards,
       count(fouls.total)::int             AS foul_matches,
       sum(fouls.total)::float8            AS fouls
FROM match_official mo
JOIN official o ON o.id = mo.official_id
JOIN match m    ON m.id = mo.match_id
LEFT JOIN match_detail d ON d.match_id = m.id
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE card ->> 'type' = 'yellow') AS yellow,
         count(*) FILTER (WHERE card ->> 'type' = 'red')    AS red
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(d.cards) = 'array' THEN d.cards ELSE '[]'::jsonb END
  ) AS card
) AS cards
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN jsonb_typeof(d.stats -> 'home' -> 'fouls') = 'number'
     AND jsonb_typeof(d.stats -> 'away' -> 'fouls') = 'number'
    THEN (d.stats -> 'home' ->> 'fouls')::numeric
       + (d.stats -> 'away' ->> 'fouls')::numeric
  END AS total
) AS fouls
WHERE m.comp_id = $1 AND m.season_id = $2 AND m.state = 'finished'
GROUP BY o.id, o.full_name, mo.role
ORDER BY matches DESC, o.full_name, mo.role`

func (s *Store) OfficialSeasons(ctx context.Context, competition, season string) ([]OfficialSeason, error) {
	rows, err := s.db.Query(ctx, officialSeasonsSQL, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seasons := make([]OfficialSeason, 0)
	for rows.Next() {
		var row OfficialSeason
		if err := rows.Scan(
			&row.Official.ID, &row.Official.Name, &row.Role,
			&row.Matches, &row.YellowCards, &row.RedCards,
			&row.FoulMatches, &row.Fouls,
		); err != nil {
			return nil, err
		}
		// count(*) over a GROUP BY is at least 1, so this denominator is safe -
		// but perMatchRate guards it anyway rather than relying on that argument
		// staying true after the next edit.
		row.CardsPerMatch = perMatchRate(float64(row.YellowCards+row.RedCards), row.Matches)
		// Absence stays absence. A rate is emitted only when there is a foul
		// total and a sample it applies to.
		if row.Fouls != nil && row.FoulMatches > 0 {
			rate := perMatchRate(*row.Fouls, row.FoulMatches)
			row.FoulsPerMatch = &rate
		}
		seasons = append(seasons, row)
	}
	return seasons, rows.Err()
}
```

Append to `backend/reader/handlers_officials.go`:

```go
func (a *App) handleOfficialSeasons(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	seasons, err := a.store.OfficialSeasons(request.Context(), competition, season)
	if err != nil {
		a.logger.Error("official seasons", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// [] is honest here, unlike on /matches/{id}/officials. "We hold no
	// officiated finished matches for this season yet" is a real state of the
	// world - it is in fact the state of every season until E7's history
	// accumulates - and a 404 would tell a client the season does not exist.
	if seasons == nil {
		seasons = []OfficialSeason{}
	}
	// Aggregates over finished matches only move when a match finishes.
	cacheFor(writer, officialsCacheSeconds)
	writeJSON(writer, http.StatusOK, seasons)
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	OfficialSeasons(context.Context, string, string) ([]OfficialSeason, error)
```

and register:

```go
		router.Get("/competitions/{comp}/{season}/officials", a.handleOfficialSeasons)
```

In `backend/reader/server_test.go`, add to `fakeReaderStore`:

```go
	officialSeasons    []OfficialSeason
	officialSeasonsErr error
```

```go
func (f *fakeReaderStore) OfficialSeasons(context.Context, string, string) ([]OfficialSeason, error) {
	f.calls++
	return f.officialSeasons, f.officialSeasonsErr
}
```

In `backend/reader/openapi.yaml`, add the schema:

```yaml
    OfficialSeason:
      type: object
      additionalProperties: false
      required: [official, role, matches, yellowCards, redCards, cardsPerMatch, foulMatches, fouls, foulsPerMatch]
      properties:
        official: { $ref: "#/components/schemas/Official" }
        role:
          type: string
          description: >-
            Provider role text, stored verbatim. Rows are grouped by role rather
            than filtered to referees: a fourth official did not show the cards
            in a match, and discarding roles we cannot classify would lose data.
            Choose the roles that answer your question.
        matches:
          type: integer
          description: >-
            Finished matches worked in this role. It is the denominator of
            cardsPerMatch and it is always present, because a rate without its
            sample size cannot be judged - and until season-long history
            accumulates, these samples are small.
        yellowCards: { type: integer }
        redCards: { type: integer }
        cardsPerMatch: { type: number, description: "(yellowCards + redCards) / matches, rounded to two decimals." }
        foulMatches:
          type: integer
          description: >-
            Finished matches with a usable foul count on both sides. A separate,
            usually smaller, denominator from matches - a competition that
            publishes fouls unevenly has fewer foul matches than card matches.
        fouls:
          type: [number, "null"]
          description: >-
            Total fouls across foulMatches, or null when the competition
            publishes no usable foul counts. Null, never zero: zero fouls is a
            claim, absence is not.
        foulsPerMatch:
          type: [number, "null"]
          description: fouls / foulMatches rounded to two decimals, or null when fouls is null.
```

and the path:

```yaml
  /v1/competitions/{comp}/{season}/officials:
    get:
      operationId: listSeasonOfficials
      summary: List per-official season aggregates for a competition
      description: >-
        One row per official per role, over finished matches only. Scheduled and
        live matches are excluded: an assigned referee is future workload, not a
        card rate.


        Every rate is returned beside the sample it was computed from. This
        endpoint becomes meaningful as accumulated history grows; against a young
        season it returns arithmetically correct numbers over samples of two or
        three, and the matches and foulMatches fields are how a consumer sees
        that rather than being handed a rate that looks solid.


        The response is bounded by the officials who worked the season - a few
        dozen, times the roles a crew has - so it takes no limit parameter. That
        bound is the data, not the caller.


        An empty array means we hold no officiated finished matches for this
        season yet, which is a real state and not an error.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
      responses:
        "200":
          description: Per-official season aggregates, most matches first
          headers:
            Cache-Control: { $ref: "#/components/headers/HistoricalCacheControl" }
          content:
            application/json:
              schema: { type: array, items: { $ref: "#/components/schemas/OfficialSeason" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

In `openapi_test.go`, add the row and seed the fake:

```go
		{target: "/v1/competitions/world-cup/2026/officials", template: "/v1/competitions/{comp}/{season}/officials"},
```

```go
		officialSeasons: []OfficialSeason{{
			Official: Official{ID: "0f1c1a00-0000-4000-8000-000000000001", Name: "Howard Webb"},
			Role:     "Referee",
			Matches:  2, YellowCards: 5, RedCards: 1, CardsPerMatch: 3, FoulMatches: 0,
		}},
```

> That fixture leaves `Fouls` and `FoulsPerMatch` nil on purpose, so the route validation
> test proves the `null` branch against the document rather than only the populated one.

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test -race ./reader && go vet ./reader
```

Expected: `ok`, `go vet` silent. If the `fouls` scan fails with a numeric conversion error,
the `::float8` cast is missing from `officialSeasonsSQL` — `sum()` over `numeric` returns
`numeric`, and the cast is what makes `*float64` the right destination.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_officials.go backend/reader/handlers_officials.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go backend/reader/openapi.yaml backend/reader/openapi_test.go
git commit -m "feat(reader): add per-official season aggregates

Cards from a lateral over match_detail.cards, fouls from match_detail.stats,
both guarded by jsonb_typeof so one badly typed value cannot 500 a whole
competition. Finished matches only - an assigned referee is future workload,
not a card rate. Fouls are null when a competition publishes none, never
zero, because zero fouls is a claim and absence is not.

Every rate ships with the sample it came from. A card rate over one match is
a fact about the match, not the referee, and until E7's history accumulates
these samples are small; matches and foulMatches are how a consumer sees
that instead of being handed a number that looks solid.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Document the surface and run the full gate

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document the endpoints**

In `backend/reader/README.md`, append after the "Query parameters" section that T10.1 added:

```markdown
## Match officials

Four routes turn the referee from a display string into an entity with an id. They read
`official` and `match_official`, created by migration `0008_match_officials`, which the
ingester owns — the reader creates no schema for officials.

| Route | Returns | Cache-Control |
|---|---|---|
| `GET /v1/matches/{id}/officials` | the crew for one match, in the provider's listed order | `public, max-age=300` |
| `GET /v1/officials/{officialId}` | identity plus the competitions and seasons we hold appearances in | `public, max-age=300` |
| `GET /v1/officials/{officialId}/matches` | matches this official worked, across competitions | `liveMaxAge` (10s live, else 60s) |
| `GET /v1/competitions/{comp}/{season}/officials` | per-official, per-role season aggregates | `public, max-age=300` |

`{officialId}` and the `{id}` on `/matches/{id}/officials` are **UUIDs** and are validated
as such before any query runs. Both land in `uuid` columns, where a non-UUID would surface
as a 500 rather than the 400 it is.

`{officialId}` is **our** identifier, not ESPN's. Provider ids live in
`official_external_ref` and are deliberately not addressable: a public URL keyed on a
provider id would make that provider the identity authority, which is the rule the crosswalk
exists to enforce.

`/v1/officials/{officialId}/matches` accepts `comp`, `season`, `range`, `state`, `order` and
`limit`. `season` without `comp` is a `400`. **`limit` defaults to 500 rather than
"unlimited"**, which differs from `/v1/competitions/{comp}/{season}/matches` on purpose: a
season's fixture list is bounded by the data, an official's career is not.

`/v1/competitions/{comp}/{season}/officials` takes no `limit`. Its size is bounded by the
officials a federation appoints, which no caller input widens.

Crew size varies by competition. **Liga MX publishes one official — the referee — where
others publish four.** A one-row response is complete, not truncated. Consumers must not
assume four rows, must not render empty "Assistant Referee" or "Fourth Official" slots to
pad a crew out, and must not label a one-row crew as incomplete: the roles present are the
roles the competition published, and a blank slot would assert that a person exists whom
nobody named.

### Two things this surface deliberately refuses to smooth over

**An empty result means different things on different routes, and the status codes say so.**
`/matches/{id}/officials` returns `404` when it holds no crew — an empty array would claim
the match was played without a referee, which is never true, whereas "we hold no record" is
often true. `/competitions/{comp}/{season}/officials` returns `[]` for the same shape of
absence, because "no officiated finished matches held yet" is a real state of the world and
a `404` would say the season does not exist.

**`MatchSummary.info.referee` and `/matches/{id}/officials` are two sources and may
disagree.** `info.referee` is the provider's display string from the site host's `gameInfo`;
`match_official` is the identified relation from the core host's `/officials`. Nothing
reconciles them. They can differ on a late crew change or a spelling, and a silent
reconciliation would hide a genuine upstream inconsistency behind a value that only looks
authoritative.

### Reading the aggregates honestly

Every rate on `/competitions/{comp}/{season}/officials` is returned beside the sample it was
computed from — `matches` for `cardsPerMatch`, `foulMatches` for `foulsPerMatch`, and those
two are different numbers whenever a competition publishes fouls unevenly. A card rate over
one or two matches is a fact about those matches, not about the referee. The endpoint
becomes meaningful as accumulated history grows; until then the denominators are the honest
warning label, and they are required fields for exactly that reason.

`fouls` and `foulsPerMatch` are `null`, never `0`, for a competition that publishes no
usable foul counts.

### Known limitation: withdrawn officials

`match_official` carries no `DELETE` grant — a crew correction is modelled as an `UPDATE` of
`role`. An official **withdrawn** from a crew before kickoff therefore leaves a row nothing
can remove, and that row counts toward their match totals and card aggregates. The fix
belongs in the write path (a `DELETE` grant or a `withdrawn_at` column), not in a
reader-side guess about which appearances are stale.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. **Docker must be running** for
`reader`, `migrations` and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2

MISSING="00000000-0000-4000-8000-000000000000"

# 400s: every one of these must cost no query.
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/officials/off-webb"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/officials/9078"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/match-final/officials"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/officials/$MISSING/matches?season=2026-27"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/officials/$MISSING/matches?comp=not-real"
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/officials/$MISSING/matches?limit=501"

# 404s: two different messages for two different absences.
curl -s "http://localhost:8080/v1/officials/$MISSING"
curl -s "http://localhost:8080/v1/matches/$MISSING/officials"

# 200s. Take a real id first:
#   OFF=$(psql -At "$READER_DSN" -c "SELECT id FROM official LIMIT 1")
curl -si "http://localhost:8080/v1/competitions/liga-mx/2026-apertura/officials" | head -n 12
curl -s  "http://localhost:8080/v1/competitions/liga-mx/2026-apertura/officials" | head -c 600
curl -si "http://localhost:8080/v1/officials/$OFF/matches?order=desc&limit=3" | head -n 12
```

Expected, in order: six `400`s; then `{"error":"official not found"}` and
`{"error":"officials not recorded for this match"}`; then a `200` with
`Cache-Control: public, max-age=300` and a JSON array whose rows each carry `matches`,
`cardsPerMatch`, `foulMatches` and either a numeric or a `null` `fouls`; then a `200` with
`Cache-Control: public, max-age=60` (or `10` if anything is live) and at most three match
objects.

Liga MX is the right competition to check by hand: the recorded probe fixture shows it
publishes **one** official per match, so a single-row crew and a single-row aggregate are
the expected output, not a sign that something is missing.

Until the ingester writes `official` and `match_official`, the aggregate returns `[]` and
the profile returns `404`. That is the correct output, not a broken deployment — confirm it
looks like that rather than like an error.

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document the match officials surface

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-officials
gh pr create --title "feat(reader): identified match officials and per-official season aggregates" --body "$(cat <<'EOF'
## What

`match_detail.info.referee` is a bare display name with no identifier, so nothing can be
asked of it — not "who else did this person referee", not "how many cards do they show", not
"did the same crew work both legs". A live capability probe of ESPN's core host on
**2026-08-15** confirmed the per-match `officials` sub-resource returns named officials
**with ids**, fully embedded rather than as `$ref`s.

The write side of that — `0008_match_officials` and the ingester that fills it — is owned by
`docs/superpowers/plans/2026-08-15-ingester-officials-and-odds.md`. **This PR is the read
half and creates no migration.** It adds four endpoints over the tables that plan creates:

- `GET /v1/matches/{id}/officials`
- `GET /v1/officials/{officialId}`
- `GET /v1/officials/{officialId}/matches`
- `GET /v1/competitions/{comp}/{season}/officials`

There is no design spec for this slice — it comes from the probe, and the plan says so where
a spec line would normally go.

## Approach

**The aggregates are the point, and they are gated on history.** A referee's card rate over
one match is a fact about that match, not about the referee.
`/competitions/{comp}/{season}/officials` becomes meaningful only once E7's history
accumulates, so it reports `matches` beside every rate — and `foulMatches` beside the foul
rate, which is a *different* denominator whenever a competition publishes fouls unevenly.
Both are required fields, so a consumer cannot receive a rate without the sample size that
produced it.

**Fouls are `null`, never `0`.** Zero fouls is a claim; absence is not. The numeric cast is
guarded by `jsonb_typeof(...) = 'number'` on both sides of a match, so one stat typed as a
string upstream costs that match its foul total instead of 500-ing the whole competition's
aggregate. A match with one good side and one bad side contributes `null` — half a foul
count is not a foul count.

**Aggregates group by role rather than filtering to `'Referee'`.** Filtering would pin
provider text inside SQL, in a schema that stores role verbatim precisely so an unfamiliar
role survives, and would silently discard every row it could not classify. One labelled row
per (official, role) invents nothing and lets the consumer choose. `role_id` is the stabler
machine value and is exposed per-row, but it is nullable and is therefore not a grouping key.

**Absence means different things on different routes, and the status codes say so.**
`/matches/{id}/officials` 404s on an empty crew: `[]` would claim the match was played
without a referee. `/competitions/{comp}/{season}/officials` returns `[]` for the same shape
of absence, because "no officiated matches held yet" is a real state and a 404 would say the
season does not exist.

**`info.referee` is untouched.** It is the provider's display string from the site host;
`match_official` is the identified relation from the core host. They can legitimately
disagree, nothing here reconciles them, and the integration seed reproduces exactly that
case — a `null` `info.referee` on a match whose crew we name. A silent reconciliation would
hide a real upstream inconsistency behind a value that only looks authoritative.

**Ids are UUIDs and are validated as such.** `parseUUID` joins `params.go` alongside
`parseEntityID`. Both ids on these routes land in `uuid` columns, where a value that
satisfies `parseEntityID` but is not a uuid becomes a 500 rather than the 400 it is.
`{officialId}` is our identifier — ESPN official ids are a 400, because a public URL keyed
on a provider id would make that provider the identity authority.

**One match query, not two.** `MatchFilter` gains `OfficialID` as an `EXISTS` predicate
rather than a `JOIN`: it asks whether this person worked this match, returning each match
once by construction, instead of relying on a primary key this file does not own. The
competition scope becomes optional because a career crosses competitions, and `Matches`
refuses a read scoped by neither a competition nor an official rather than returning the
whole table.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- The invariant the aggregates depend on — `PRIMARY KEY (match_id, official_id)` — is
  asserted **on the read side as well as in the ingester plan**, because a missing key does
  not make the aggregate fail: it doubles both the match count and the cards counted against
  a referee, and the resulting rate still looks plausible.
- Integration coverage of: crew ordering with a nullable `ord`; a one-official crew treated
  as normal rather than degraded; the finished-only rule (a live match with cards is
  excluded and would change every number if it were not); the string-typed foul stat being
  excluded rather than raising; the all-`null` foul competition serializing `"fouls":null`
  and not `"fouls":0`, asserted **on the marshalled JSON**, not on the struct.
- Handler tests assert that every rejected parameter returns 400 **and never reaches the
  store**, including `?season=` without `?comp=` and an ESPN official id in the path.
- The placeholder renumbering in `matchesSQL` is pinned by an integration subtest that
  exercises `limit` and `official` together, because a misnumbered placeholder returns wrong
  rows with a 200 rather than erroring.
- OpenAPI contract tests validate all four new paths and five new schemas, with fixtures
  that leave every nullable field nil so the `null` branches are validated too.

## Coordination

- **No migration.** `0008_match_officials` is owned by the ingester plan; this plan verifies
  it and reads it. An earlier draft created a duplicate `0013_officials`, which would have
  been a second `CREATE TABLE official` failing on a live database.
- **Raised, not resolved:** `0008_match_officials` declares `match_id uuid REFERENCES
  match(id)`, while `0001_init.up.sql` on `main` declares `match.id text`. A foreign key
  whose type differs from its target's will not create. The plan's Task 1 makes the executor
  check `match.id`'s real type and **stop** if it is still `text`, rather than working around
  it.
- **Also raised, not resolved:** if `match.id` is `uuid`, T10.1's `/v1/matches/{id}` validates
  with `parseEntityID` against a `uuid` column and has the same 500-instead-of-400 defect.
  That belongs to canonical-identity's read-side sweep.
- **Known limitation, documented not hidden:** `match_official` has no `DELETE` grant, so a
  withdrawn official leaves a row that counts toward their aggregates. The fix belongs in the
  write path.
- `matchesSQL`'s `LIMIT` placeholder is also renumbered by the `api-teams` plan. Whichever
  lands second reconciles; the plan states both numberings explicitly.
- `HistoricalCacheControl` is shared with the `api-history` plan — reuse it if present rather
  than adding a duplicate key.

Plan: `docs/superpowers/plans/2026-08-15-api-officials.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **This plan was wrong once and the record is kept.** The first draft created its own
  `0013_officials` migration with `CREATE TABLE official` and `CREATE TABLE match_official`,
  before `2026-08-15-ingester-officials-and-odds.md` existed on disk. It has been rewritten
  against that plan's `0008_match_officials`, and Task 1's STOP block carries the full
  column-by-column reconciliation so the executor applies it once rather than rediscovering
  it in four separate SQL statements. The single most consequential difference was the
  primary key: the draft assumed `(match_id, official_id, role)` and built a seed and two
  justifications on the idea that one person can hold two roles on one match. The real key
  is `(match_id, official_id)`, and every one of those has been reworked rather than patched.
- **Where the requirements came from.** There is no spec. Every endpoint traces to the
  2026-08-15 capability probe, which found identified officials carrying ids, with roles and
  a listing order. No field in any response model is derived from data we do not hold. An
  earlier framing of this plan additionally claimed the probe ruled out xG and shot
  coordinates; that briefing was withdrawn — coordinates do exist on the core host's play
  stream — and the claim has been struck from the header rather than restated, because it
  was never load-bearing here and belongs to the shot-log plans.
- **The honest weakness, stated rather than hidden.** `/competitions/{comp}/{season}/officials`
  is the most interesting endpoint here and the least useful today. It will spend its first
  season computing rates over samples of two and three. The design response is the
  denominators — `matches` and `foulMatches` are required fields — not a threshold that
  suppresses small samples. A suppression rule would be a second number to get wrong, and it
  would decide for the consumer what counts as enough evidence for a question the consumer
  has not told us.
- **Two denominators, not one.** `foulMatches` could have been dropped and `matches` reused
  as the foul denominator. That would attach a foul rate to a sample that never applied to it
  whenever a competition publishes fouls for some matches and not others — which the seed
  reproduces on the second laliga fixture. Two samples is one more field and one fewer lie.
- **The riskiest change is the placeholder renumbering in `matchesSQL`**, not anything to do
  with officials. A misnumbered `LIMIT` binds an integer to a text predicate — sometimes an
  error, sometimes wrong rows with a 200. Task 4 carries the numbering table, the
  reconciliation note for `api-teams`, and an integration subtest that exercises `limit` and
  `official` together specifically because unit-level tests cannot see it.
- **The second riskiest is making the competition scope optional.** `Matches(ctx, "", "", MatchFilter{})`
  would have returned the entire match table. `errUnscopedMatchQuery` is unreachable through
  the router today and is tested anyway, because "unreachable" is a property of the current
  router, not of the function.
- **Raised for someone else, not fixed here:** `0008_match_officials`'s `match_id uuid
  REFERENCES match(id)` against `0001_init.up.sql`'s `match.id text`. That FK cannot create.
  The ingester plan's prerequisite chain starts at `feat/canonical-identity-impl`, which is
  presumably where the re-keying happens, but this plan has not verified that and refuses to
  assume it. Task 1 Step 1 checks and stops.
- **Also raised, not fixed:** if `match.id` is `uuid`, then T10.1's `/v1/matches/{id}` route
  validates with `parseEntityID` and queries a `uuid` column, so it has the same
  500-instead-of-400 defect this plan fixes on its own routes. Fixing one route and leaving
  its neighbour broken in the same file would be worse than naming it; it belongs to
  canonical-identity's read-side sweep.
- **Deliberately not built: a `/v1/officials/by-source/{source}/{sourceId}` lookup.** It
  would be four lines over `official_external_ref` and nobody has asked for it. Building it
  speculatively is how a provider id ends up in a public URL by default.
- **Deliberately not built: a role enum or a canonical role vocabulary.** It would look
  tidier and it would throw away every role the probe did not happen to see. Reads group by
  role instead, which costs a few rows and loses nothing.
- **Deliberately not built: a career-totals block on `OfficialProfile`.** Totals across
  competitions with different disciplinary cultures are a number that means less the more
  data goes into it. The season aggregate is the right grain because a season is the unit a
  competition's officiating standards are set in.
- **Deliberately not built: `AllowCost` weighting.** The `api-history` plan added it for
  payloads that scale with a caller-supplied window. Nothing here does. Charging three tokens
  for a forty-row response would be a cost model that does not describe the cost.
- **Interface churn.** `readerStore` gains three methods, `MatchFilter` gains a field, and
  `params.go` gains one function. The other `api-*` plans edit the same files, so they should
  land one at a time rather than in parallel.
- **Seed coordination.** This plan adds matches to `laliga` / `2026-27` and `liga-mx` /
  `2026-apertura` and explicitly refuses to touch `world-cup` / `2026`, where three existing
  tests assert exact counts. It adds one `match_official` row against the world-cup final,
  which changes no match count and is derived from a query rather than a hardcoded id. A
  sibling plan that needs its own fixtures should pick another untouched competition for the
  same reason.
