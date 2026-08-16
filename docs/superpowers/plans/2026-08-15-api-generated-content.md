# Reader API — Generated Content (Recaps, Previews, Digest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the reader API a read path for the three generated artefacts E8 asks
for — a match recap, a match preview and a daily competition digest — so that prose
written from our own rows can be served with the one thing the E8 spec insists on and
no consumer can forget: a `generated: true` label carried in the payload itself.

**Architecture:** Three new tables and three new `GET` routes. The reader's database
login is **SELECT-only** (`scorearc_reader`, enforced by migration `0001` and proved by
the `reader role is select only` subtest in `store_integration_test.go`), so this
service *physically cannot* generate anything at request time. It reads a row or it
returns a 404. That is not a discipline this plan asks anyone to keep — it is a
property of the role the process connects as, which is what turns E8's "generated once
per match and served from cache — verified by request count, not by inspection" into a
checkable fact: a request to the reader can only ever be a read. Generation belongs to
the ingester/worker and is out of this plan's scope.

**Tech Stack:** Go 1.26, chi v5, pgx v5, kin-openapi, testcontainers-go (Docker required).

**Spec:** `docs/superpowers/specs/2026-08-15-ai-recaps-design.md`
**Epic:** E8 in `docs/PRODUCT_ROADMAP.md` — this is the backend read half of **T8.1**,
**T8.2** and **T8.3**
**New roadmap task:** **T9.7** (Epic **E9 · Public API read surface**)
**Branch:** `feat/api-generated-content` off latest `origin/main`

**Depends on:** `docs/superpowers/plans/2026-08-15-api-match-reads.md`, which creates
`backend/reader/params.go`. Task 2 below extends that file; it cannot be applied before
the match-reads plan lands. The *content* of a digest depends on the `api-history`
plan's `standing_snapshot` series existing and on someone writing the generator, but
**this plan's read path does not** — it serves whatever rows the generator has written
and returns 404 when there are none. It can therefore land and be tested before any
generator exists.

## STOP — schema ownership. Read before Task 1.

**Check whether an ingester write-path plan already owns these tables before creating a migration.** Verified on disk 2026-08-15: the sibling ingester plans publish a ledger in `docs/superpowers/plans/2026-08-15-ingester-standings-snapshots.md` reserving `0003`–`0010`, whose last entry is **`0010_match_commentary`** — the number this plan's draft also claimed. Other ingester plans on disk take `0004`–`0009`, and **their numbers conflict with each other**, so trust `ls backend/migrations` over any plan's prose.

Generated content is a genuinely new category and is unlikely to be claimed by an ingester plan, so this plan's migration probably stands. Confirm it rather than assume it:

1. `ls backend/migrations` and `grep -rn "CREATE TABLE match_recap\|match_preview\|competition_digest" backend/migrations/`.
2. Take the **next free integer** from that listing, keeping the `_generated_content` suffix. Reader-owned numbers currently in flight: `0011` (odds, superseded — see the `api-history` plan), `0012` (`player_action_count`, `api-play-stream`), `0013` (officials, superseded — see `api-officials`), `0014` (`api-commentary-and-shots`).
3. **Check `match.id`'s type before writing the foreign keys.** Both `match_recap` and `match_preview` reference it. The ingester plans write `match_id uuid REFERENCES match(id)`; `0001_init.up.sql` on `main` declares `match.id text`. A foreign key whose type differs from its target's will not create, and Postgres reports the error against the wrong file. Raise the mismatch; do not work around it.

**One boundary this plan must hold.** Raw ESPN JSON is archived to a private R2 bucket (`scorearc-espn-historic`) for reprocessing. It is not part of the public surface, and neither is the model input: `input_digest` is stored and deliberately not served, and there is no endpoint that returns the structured payload a recap was generated from. A consumer gets the prose, the model name, the timestamp and the `generated` label — the audit trail is internal.

---

## Global Constraints

- Extend the existing layering. Routes register in `App.router()` under `/v1`; handlers
  live in a `handlers_*.go`; SQL lives in a `store_*.go`; the `readerStore` interface in
  `server.go` is the seam. **Adding a store method means editing three places:** the
  interface in `server.go`, `*Store` in `store_*.go`, and `fakeReaderStore` in
  `server_test.go`.
- **No string-built SQL.** Every value is a pgx placeholder. The one statement chosen
  rather than bound (recap table vs preview table) is selected from a two-entry
  package-level constant map keyed by a route-fixed constant, never by request text.
- **Reject, never silently substitute.** An unparseable `?date=` is a 400. A `?date=`
  we hold no digest for is a **404**, not the latest digest — serving Tuesday's
  anomalies under Wednesday's date would be a fabricated record, which is exactly the
  failure mode E8 exists to avoid.
- **400 messages are built only from string constants in our own code.** Never
  `err.Error()` on a dependency error — `TestDependencyErrorsAreSanitized` exists
  because that leak class is real.
- Every new endpoint goes into `backend/reader/openapi.yaml`. `openapi_test.go`
  enforces: every object schema's `required` list equals its full sorted property list,
  every object schema sets `additionalProperties: false`, every `GET` documents
  200/405/500 (+429 off `/healthz`), and **every** response — 200 and error alike —
  declares a `Cache-Control` header. Because `required` must list every property,
  **no response struct in this plan may use `omitempty`**.
- Rate limiting is unchanged: `a.rateLimit` is router-level and all three new routes
  inherit the 10 rps / burst 30 per-IP bucket. Only `/healthz` is exempt.
- **Do not hardcode a model id anywhere.** `model` is a `text` column the generator
  fills in and the reader echoes. Whoever writes the generator must check current model
  ids against the `claude-api` reference rather than typing one from memory — the E8
  spec says so explicitly. The only model strings in this plan are the fixture literal
  `"test-model"` in seed data, which is deliberately not a real id.
- Gate before a PR, from `backend/`: `go build ./...`, `go vet ./...`,
  `go test -race ./...`. **Docker must be running** — reader store and migration tests
  use testcontainers.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Ingester prerequisites (not built here — stated so the generator is not designed twice)

This plan builds the read path. Everything below is what the ingester/worker must
persist for these endpoints to return anything but a 404.

- **`match_recap`** — one row per finished match, written **once at full time**, never
  per request. The generation cost per match is fixed and small; per request it is
  unbounded. The model is handed the structured payload we already hold — final score,
  scorers with minutes, cards, the per-player box score from the
  `api-leaders-and-box-scores` plan's `match_player_stat`, and team stats — and writes
  prose from it. It is not asked to recall the match.
  - **Own goals must arrive in that payload marked as own goals.** E0 makes the
    distinction available. A recap that credits the beneficiary's "goalscorer"
    reintroduces E0's bug in prose, where it is far harder to spot than in a scorer
    list — nobody diffs a paragraph against a fixture.
  - A stat we do not hold is not mentioned. No "dominated possession" when
    `stats.home.possession` is null. Verified NOT available: populated injuries,
    transfers, tracking data. A recap must not reach for them.
  - **Corrected 2026-08-15:** an earlier draft listed *shot coordinates* here as
    unavailable. They are available — the typed play stream carries
    `fieldPositionX/Y`, `fieldPosition2X/Y` and `goalPositionY/Z` on roughly 96%
    of plays. That does not change what a recap may say: **xG is still not a
    field we hold**, because no model has been specified, so a recap must never
    mention or imply one. The rule is unchanged; only the reason is. A recap may
    describe a shot's *location* if the generator is given it, since that is a
    measured value; it may not describe its *quality*, which would be a number
    nobody computed.
  - T8.1's generator depends on E1's box-score shape, which is precisely why the E8
    spec deferred its prompt design. This plan specifies only the read path, which is
    stable regardless of how the prose is produced.
- **`match_preview`** — same grounding rules, written before kickoff from form (E7's
  T7.3) and head-to-head (`H2HMeeting` already exists in `src/server/data/types.ts` and
  `mapSummaryH2H` already populates it). A preview states what we know. It is **not** a
  prediction unless the model behind it publishes a Brier score.
- **`competition_digest`** — the anomaly digest is a **query over `standing_snapshot`**
  (the `api-history` plan reads the same series), with the model writing only the
  sentence. Each item carries the evidence row the SQL found. Building it the other way
  round — asking a model to find the trend — produces a system that hallucinates trends,
  which the spec names as the worst possible failure mode for a stats platform.
- **`input_digest`** on all three tables is the hash of the structured input the model
  was given. It exists so a regeneration can be *detected* rather than guessed at. It is
  stored and **deliberately not served** — see Task 3.

## What is capped, and to what

| Input | Rule | Failure |
|---|---|---|
| `{id}` on `/recap`, `/preview` | `parseEntityID`, `^[A-Za-z0-9._-]{1,64}$` | 400 |
| `?date=` on `/digest` | `parseDay`, exactly `YYYY-MM-DD`, UTC | 400 |
| `?date=` absent | the most recent digest held: `ORDER BY digest_date DESC LIMIT 1` | — |
| `?date=` names a day with no digest | **404**, never the latest digest | 404 |
| `{comp}`/`{season}` | `a.resolve` against `competitions.json` | 400 |
| digest `items` | one row per day; the array is written by our own generator, so it is **data, not caller-controlled input** — same distinction as the season fixture list in the match-reads plan | — |
| a digest item with an empty `evidence` array | dropped by the store and logged; never served | — |

No `?limit=`, `?order=` or `?range=` here: a recap is one row keyed by match id, and a
digest is one row keyed by `(comp, season, day)`. There is nothing to page.

---

## File Structure

- `backend/migrations/0010_generated_content.up.sql` — **new.** Three tables, one index,
  one grant.
- `backend/migrations/0010_generated_content.down.sql` — **new.** Exact inverse.
- `backend/migrations/migrations_test.go` — one assertion on the new files.
- `backend/reader/params.go` — `parseDay` (extends the match-reads plan's file).
- `backend/reader/params_test.go` — `parseDay` table test.
- `backend/reader/types.go` — `GeneratedText`, `DigestEvidence`, `DigestItem`, `Digest`.
- `backend/reader/store_generated.go` — **new.** `GeneratedText`, `CompetitionDigest`,
  `retainSourcedItems`, `ErrNotGenerated`.
- `backend/reader/store_generated_test.go` — **new.** `retainSourcedItems`, no Docker.
- `backend/reader/handlers_generated.go` — **new.** Three handlers.
- `backend/reader/server.go` — two interface methods, three routes.
- `backend/reader/server_test.go` — fake follows the interface; handler tests.
- `backend/reader/store_integration_test.go` — seed rows + store coverage.
- `backend/reader/migrations_integration_test.go` — the new migration in both lists.
- `backend/reader/openapi.yaml` — one parameter, two headers, four schemas, three paths.
- `backend/reader/openapi_test.go` — three rows in the route table.
- `backend/reader/README.md` — the generated-content contract.

---

### Task 1: The `0010_generated_content` migration

**Migration numbers are first-come.** A sibling agent is writing ingester write-path
plans concurrently. **Run `ls backend/migrations` first**; if `0010` is already taken,
renumber to the next free integer and keep the `_generated_content` suffix, then use
that number consistently in every list below. For reference: `0005` comes from
`api-leaders-and-box-scores`, `0006` from `api-teams`, `0007` from `api-players`,
`0008` from `api-history` and `0009` from `api-commentary-and-shots`.

**Files:**
- Create: `backend/migrations/0010_generated_content.up.sql`
- Create: `backend/migrations/0010_generated_content.down.sql`
- Modify: `backend/migrations/migrations_test.go`
- Modify: `backend/reader/migrations_integration_test.go`, `backend/reader/store_integration_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/migrations/migrations_test.go`:

```go
func TestGeneratedContentMigration(t *testing.T) {
	up, err := os.ReadFile("0010_generated_content.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"CREATE TABLE match_recap",
		"CREATE TABLE match_preview",
		"CREATE TABLE competition_digest",
		"REFERENCES match(id) ON DELETE CASCADE",
		"input_digest text NOT NULL",
		"competition_digest_recent_idx",
		"GRANT DELETE ON competition_digest TO scorearc_ingester",
	} {
		if !strings.Contains(string(up), required) {
			t.Fatalf("migration missing %q", required)
		}
	}

	down, err := os.ReadFile("0010_generated_content.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"REVOKE DELETE ON competition_digest FROM scorearc_ingester",
		"DROP TABLE IF EXISTS competition_digest",
		"DROP TABLE IF EXISTS match_preview",
		"DROP TABLE IF EXISTS match_recap",
	} {
		if !strings.Contains(string(down), required) {
			t.Fatalf("rollback missing %q", required)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./migrations -run TestGeneratedContentMigration
```

Expected: FAIL — `open 0010_generated_content.up.sql: no such file or directory`.

- [ ] **Step 3: Implement**

Create `backend/migrations/0010_generated_content.up.sql`:

```sql
-- Prose a model wrote from our own rows. The reader connects as scorearc_reader,
-- which is SELECT-only, so nothing in this schema can be written at request time:
-- a recap exists because the generator wrote it, or it does not exist.
--
-- input_digest is the hash of the structured payload the model was given. It is
-- stored so a regeneration can be detected rather than guessed at, and it is
-- deliberately not exposed by the reader.
CREATE TABLE match_recap (
  match_id     text PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  body         text NOT NULL,
  model        text NOT NULL,
  generated_at timestamptz NOT NULL,
  input_digest text NOT NULL
);

CREATE TABLE match_preview (
  match_id     text PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  body         text NOT NULL,
  model        text NOT NULL,
  generated_at timestamptz NOT NULL,
  input_digest text NOT NULL
);

-- One digest per competition season per UTC day. items is the model's sentences,
-- each carrying the evidence row the SQL found; the reader refuses to serve an
-- item whose evidence array is empty.
CREATE TABLE competition_digest (
  comp_id      text NOT NULL,
  season_id    text NOT NULL,
  digest_date  date NOT NULL,
  generated_at timestamptz NOT NULL,
  model        text NOT NULL,
  items        jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (comp_id, season_id, digest_date)
);
-- The reader's default read is "the most recent digest for this season", which is
-- a backwards index scan of exactly one row.
CREATE INDEX competition_digest_recent_idx ON competition_digest (comp_id, season_id, digest_date DESC);

-- Recaps and previews are upserted by primary key, so the ingester's inherited
-- INSERT/UPDATE is enough. A digest for a day is replaced wholesale when it is
-- regenerated, so it needs DELETE - granted on that table alone.
GRANT DELETE ON competition_digest TO scorearc_ingester;
```

Create `backend/migrations/0010_generated_content.down.sql`:

```sql
-- Exact inverse. TestMigrationsRoundTrip asserts that a full down leaves zero
-- tables and zero roles, so every object created above is dropped here. The
-- index dies with its table; the grant is revoked first for symmetry with 0003.
REVOKE DELETE ON competition_digest FROM scorearc_ingester;
DROP TABLE IF EXISTS competition_digest;
DROP TABLE IF EXISTS match_preview;
DROP TABLE IF EXISTS match_recap;
```

`SELECT` for `scorearc_reader` and `SELECT, INSERT, UPDATE` for `scorearc_ingester` are
not granted here and do not need to be: `0001_init.up.sql` ran
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ...`, and this migration is applied by
the same owner, so tables created by it inherit those grants automatically. `DELETE` is
not in the default set, which is why it is granted explicitly.

Now add the file to **both** hardcoded migration lists. In
`backend/reader/store_integration_test.go`, `newIntegrationStore`:

```go
	for _, migration := range []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0010_generated_content.up.sql",
	} {
```

In `backend/reader/migrations_integration_test.go`, `TestMigrationsRoundTrip` — up files
in order, then **down files in exact reverse**:

```go
	files := []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
		"../migrations/0010_generated_content.up.sql",
		"../migrations/0010_generated_content.down.sql",
		"../migrations/0004_ingester_hardening.down.sql",
		"../migrations/0003_ingester_delete_grant.down.sql",
		"../migrations/0002_snapshots.down.sql",
		"../migrations/0001_init.down.sql",
	}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./migrations && go test ./reader -run TestMigrationsRoundTrip
```

Expected: both `ok`. If the round-trip reports `rollback left tables=3`, the down file
is not in the list or is misordered. (Docker must be running.)

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0010_generated_content.up.sql backend/migrations/0010_generated_content.down.sql backend/migrations/migrations_test.go backend/reader/migrations_integration_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): add generated-content tables for recaps, previews and digests

Three tables the generator writes and the reader only ever reads. The
reader's login is SELECT-only, so nothing here can be produced at request
time. input_digest is stored so a regeneration is detectable; DELETE is
granted on competition_digest alone because a day's digest is replaced
wholesale while recaps and previews are upserted by key.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `parseDay` — the `?date=` parameter

**Files:**
- Modify: `backend/reader/params.go`
- Test: `backend/reader/params_test.go`

**Interfaces:**
- `parseDay(raw string) (time.Time, error)` — exactly `YYYY-MM-DD` in UTC.

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/params_test.go`:

```go
func TestParseDay(t *testing.T) {
	t.Parallel()
	day, err := parseDay("2026-07-19")
	if err != nil {
		t.Fatalf("valid day rejected: %v", err)
	}
	if !day.Equal(time.Date(2026, 7, 19, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("day = %v", day)
	}
}

func TestParseDayRejectsEverythingElse(t *testing.T) {
	t.Parallel()
	// A digest is keyed by a calendar day. One grammar, UTC, no fallback: an
	// unparseable date must not quietly become "the latest digest", because the
	// caller would then be shown one day's anomalies under another day's date.
	for _, raw := range []string{
		"",
		"20260719",
		"2026-7-19",
		"2026-07-19T00:00:00Z",
		"2026-02-30",
		"2026-13-01",
		"2026-07-19 ",
		"2026-07-19'--",
		"latest",
	} {
		if _, err := parseDay(raw); err == nil {
			t.Fatalf("date %q was accepted", raw)
		}
	}
	if _, err := parseDay("nope"); err == nil || err.Error() != "date must be YYYY-MM-DD in UTC" {
		t.Fatalf("date message = %v", err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run TestParseDay
```

Expected: FAIL — `undefined: parseDay`.

- [ ] **Step 3: Implement**

In `backend/reader/params.go`, add to the constant block:

```go
	// dayLayout is the ISO calendar day used by ?date=. It is the same grammar
	// competition_digest.digest_date stores, so a value that round-trips through
	// the API is the value in the primary key.
	dayLayout = "2006-01-02"
```

add to the `var` block:

```go
	errDay = errors.New("date must be YYYY-MM-DD in UTC")
```

and append the function:

```go
// parseDay validates ?date= as a single UTC calendar day.
//
// time.ParseInLocation rejects a wrong length, an impossible date ("2026-02-30"
// fails rather than rolling into March) and any trailing text, so this one call
// covers the whole grammar. There is no fallback: an absent ?date= is handled by
// the caller as "the latest digest", and a malformed one is a 400.
func parseDay(raw string) (time.Time, error) {
	day, err := time.ParseInLocation(dayLayout, raw, time.UTC)
	if err != nil {
		return time.Time{}, errDay
	}
	return day, nil
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go test ./reader -run TestParse && go vet ./reader
```

Expected: `ok  github.com/mcasillas17/scorearc-backend/reader`, `go vet` silent.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/params.go backend/reader/params_test.go
git commit -m "feat(reader): validate ?date= as a single UTC calendar day

parseDay joins the other parameter validators: one grammar, UTC, a
constant error message, and no silent fallback to the latest digest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The store reads and the evidence guard

**Files:**
- Create: `backend/reader/store_generated.go`
- Create: `backend/reader/store_generated_test.go`
- Modify: `backend/reader/types.go`, `backend/reader/server.go`, `backend/reader/server_test.go`
- Test: `backend/reader/store_integration_test.go`

**Interfaces:**
- `Store.GeneratedText(ctx, matchID, kind string) (*GeneratedText, error)` — `ErrNotFound`
  when the match does not exist, `ErrNotGenerated` when it exists but has no row.
- `Store.CompetitionDigest(ctx, comp, season string, day *time.Time) (*Digest, int, error)`
  — the `int` is how many items were dropped for having no evidence.

- [ ] **Step 1: Write the failing test**

Create `backend/reader/store_generated_test.go` (pure, no Docker):

```go
package main

import "testing"

func TestRetainSourcedItemsDropsUnsourcedClaims(t *testing.T) {
	t.Parallel()
	// The spec's direction of travel: SQL finds the fact, the model writes the
	// sentence. An item with no evidence is a claim with no source - it is what a
	// system that hallucinates trends produces - so it is dropped here rather than
	// served and trusted downstream.
	items := []DigestItem{
		{Kind: "table-climb", Headline: "Up four", SubjectType: "team", Evidence: []DigestEvidence{{Label: "Rank change", Value: "5th to 1st"}}},
		{Kind: "vibes", Headline: "Looking sharp", SubjectType: "team", Evidence: []DigestEvidence{}},
		{Kind: "vibes", Headline: "Also sharp", SubjectType: "team", Evidence: nil},
		{Kind: "clean-sheet-run", Headline: "Four in a row", SubjectType: "team", Evidence: []DigestEvidence{{Label: "Clean sheets", Value: "4"}}},
	}
	kept, dropped := retainSourcedItems(items)
	if dropped != 2 {
		t.Fatalf("dropped = %d, want 2", dropped)
	}
	if len(kept) != 2 || kept[0].Kind != "table-climb" || kept[1].Kind != "clean-sheet-run" {
		t.Fatalf("kept = %+v", kept)
	}
	for _, item := range kept {
		if len(item.Evidence) == 0 {
			t.Fatalf("kept an unsourced item: %+v", item)
		}
	}
}

func TestRetainSourcedItemsAlwaysReturnsAnArray(t *testing.T) {
	t.Parallel()
	kept, dropped := retainSourcedItems(nil)
	if kept == nil || len(kept) != 0 || dropped != 0 {
		t.Fatalf("kept = %#v, dropped = %d", kept, dropped)
	}
}
```

Append to `backend/reader/store_integration_test.go`:

```go
func TestStoreGeneratedContent(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("a written recap is served whole", func(t *testing.T) {
		recap, err := store.GeneratedText(ctx, "match-final", generatedKindRecap)
		if err != nil {
			t.Fatal(err)
		}
		if recap.MatchID != "match-final" || recap.Kind != generatedKindRecap || !recap.Generated {
			t.Fatalf("recap = %+v", recap)
		}
		if recap.Model != "test-model" || recap.GeneratedAt != "2026-07-19T21:30:00Z" {
			t.Fatalf("recap provenance = %+v", recap)
		}
		if recap.Body == "" {
			t.Fatal("recap body is empty")
		}
	})

	t.Run("a match with no recap and a match that does not exist are different errors", func(t *testing.T) {
		// Both are 404s at the edge, but they are distinguishable in a log: one
		// means the generator has not run, the other means the caller made an id up.
		if _, err := store.GeneratedText(ctx, "match-semi", generatedKindRecap); !errors.Is(err, ErrNotGenerated) {
			t.Fatalf("ungenerated recap error = %v, want ErrNotGenerated", err)
		}
		if _, err := store.GeneratedText(ctx, "match-final", generatedKindPreview); !errors.Is(err, ErrNotGenerated) {
			t.Fatalf("ungenerated preview error = %v, want ErrNotGenerated", err)
		}
		if _, err := store.GeneratedText(ctx, "not-a-match", generatedKindRecap); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown match error = %v, want ErrNotFound", err)
		}
	})

	t.Run("an absent date means the most recent digest", func(t *testing.T) {
		digest, dropped, err := store.CompetitionDigest(ctx, "world-cup", "2026", nil)
		if err != nil {
			t.Fatal(err)
		}
		if digest.Date != "2026-07-19" || digest.CompID != "world-cup" || digest.SeasonID != "2026" || !digest.Generated {
			t.Fatalf("latest digest = %+v", digest)
		}
		if dropped != 1 || len(digest.Items) != 1 || digest.Items[0].Kind != "table-climb" {
			t.Fatalf("items = %+v, dropped = %d", digest.Items, dropped)
		}
		if len(digest.Items[0].Evidence) != 1 || digest.Items[0].Evidence[0].Label != "Rank change" {
			t.Fatalf("evidence = %+v", digest.Items[0].Evidence)
		}
		if digest.Items[0].SubjectID == nil || *digest.Items[0].SubjectID != "arg" {
			t.Fatalf("subjectId = %v", digest.Items[0].SubjectID)
		}
	})

	t.Run("a named date returns that day and nothing else", func(t *testing.T) {
		day := time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)
		digest, _, err := store.CompetitionDigest(ctx, "world-cup", "2026", &day)
		if err != nil {
			t.Fatal(err)
		}
		if digest.Date != "2026-07-15" || len(digest.Items) != 1 || digest.Items[0].Kind != "form-collapse" {
			t.Fatalf("dated digest = %+v", digest)
		}

		// A day we hold nothing for is not quietly answered with the latest.
		missing := time.Date(2026, 7, 17, 0, 0, 0, 0, time.UTC)
		if _, _, err := store.CompetitionDigest(ctx, "world-cup", "2026", &missing); !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing date error = %v, want ErrNotFound", err)
		}
		if _, _, err := store.CompetitionDigest(ctx, "world-cup", "1998", nil); !errors.Is(err, ErrNotFound) {
			t.Fatalf("empty season error = %v, want ErrNotFound", err)
		}
	})

	t.Run("the reader cannot write the prose it serves", func(t *testing.T) {
		// This is the mechanism behind "generated once per match, served from
		// cache": a request to the reader can only ever be a read.
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		if _, err := conn.Exec(ctx, "SET ROLE scorearc_reader"); err != nil {
			t.Fatal(err)
		}
		denied := []string{
			`INSERT INTO match_recap (match_id, body, model, generated_at, input_digest)
			 VALUES ('match-semi', 'invented', 'x', now(), 'x')`,
			`UPDATE match_recap SET body = 'rewritten' WHERE match_id = 'match-final'`,
			`DELETE FROM competition_digest WHERE comp_id = 'world-cup'`,
		}
		for _, statement := range denied {
			if _, err := conn.Exec(ctx, statement); err == nil {
				t.Fatalf("reader unexpectedly executed %q", statement)
			}
		}
	})
}
```

Extend `seedIntegrationData` in the same file with three statements, appended to the
`statements` slice. `match-semi` deliberately keeps no recap and no preview so the 404
path is a real row-absence rather than a mocked one, and one digest item deliberately
ships an empty `evidence` array so the guard is proved against persisted data:

```go
		`INSERT INTO match_recap (match_id, body, model, generated_at, input_digest) VALUES
			('match-final',
			 'Argentina and France finished level at 2-2 in the final. Lionel Messi scored in the 23rd minute.',
			 'test-model', '2026-07-19T21:30:00Z', 'sha256:0000000000000000')`,
		`INSERT INTO competition_digest (comp_id, season_id, digest_date, generated_at, model, items) VALUES
			('world-cup', '2026', '2026-07-15', '2026-07-16T06:00:00Z', 'test-model',
			 '[{"kind":"form-collapse","headline":"France have lost three in a row","body":"France arrive at the final having lost three of their last five.","subjectType":"team","subjectId":"fra","evidence":[{"label":"Last five","value":"L L W L W"}]}]')`,
		`INSERT INTO competition_digest (comp_id, season_id, digest_date, generated_at, model, items) VALUES
			('world-cup', '2026', '2026-07-19', '2026-07-20T06:00:00Z', 'test-model',
			 '[{"kind":"table-climb","headline":"Argentina top Group A","body":"Argentina finished the group stage with a maximum nine points.","subjectType":"team","subjectId":"arg","evidence":[{"label":"Rank change","value":"4th to 1st"}]},
			   {"kind":"vibes","headline":"Argentina look sharp","body":"They just look good out there.","subjectType":"team","subjectId":"arg","evidence":[]}]')`,
```

`'test-model'` is a fixture string chosen precisely because it is **not** a real model
id — see the global constraint.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestRetainSourcedItems|TestStoreGeneratedContent"
```

Expected: FAIL — `undefined: retainSourcedItems`, `undefined: DigestItem`,
`store.GeneratedText undefined`.

- [ ] **Step 3: Implement**

Append to `backend/reader/types.go`:

```go
// GeneratedText is any prose a model wrote from our own rows. Generated is
// always true and always present: a consumer must not be able to render this
// text without knowing what it is. The E8 spec's rule is that the label is not
// buried, so it lives in the payload rather than in a UI convention that the
// second consumer of this API will not know about.
//
// The model's input hash (input_digest) is stored but not carried here. It is an
// operational field for detecting a regeneration; exposing an opaque hash invites
// consumers to build behaviour on it, and we would then owe them its stability.
type GeneratedText struct {
	MatchID     string `json:"matchId"`
	Body        string `json:"body"`
	Model       string `json:"model"`
	GeneratedAt string `json:"generatedAt"`
	Generated   bool   `json:"generated"`
	Kind        string `json:"kind"` // "recap" | "preview"
}

// DigestEvidence is the fact a digest item was written from. SQL finds the fact;
// the model writes the sentence. An item with no evidence is a claim with no
// source and must never be served.
type DigestEvidence struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type DigestItem struct {
	Kind        string           `json:"kind"`        // e.g. table-climb, form-collapse, clean-sheet-run
	Headline    string           `json:"headline"`
	Body        string           `json:"body"`
	SubjectType string           `json:"subjectType"` // team | player | competition
	SubjectID   *string          `json:"subjectId"`
	Evidence    []DigestEvidence `json:"evidence"`
}

type Digest struct {
	CompID      string       `json:"compId"`
	SeasonID    string       `json:"seasonId"`
	Date        string       `json:"date"` // YYYY-MM-DD
	GeneratedAt string       `json:"generatedAt"`
	Model       string       `json:"model"`
	Generated   bool         `json:"generated"`
	Items       []DigestItem `json:"items"`
}
```

Create `backend/reader/store_generated.go`:

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// The two kinds of per-match prose. These are route-fixed constants, never
// request text: /recap and /preview each pass their own literal.
const (
	generatedKindRecap   = "recap"
	generatedKindPreview = "preview"
)

// ErrNotGenerated means the match exists but nothing has been written for it.
// It is distinct from ErrNotFound so the edge can say which of the two happened
// - both are 404s to a client, but only one of them is our backlog.
var ErrNotGenerated = errors.New("not generated")

// The LEFT JOIN is what makes the two 404s distinguishable in one round trip:
// no row at all means the match id is unknown, a row with a NULL body means the
// generator has not run for it. input_digest is intentionally not selected.
const matchRecapSQL = `
SELECT r.body, r.model, r.generated_at
FROM match m
LEFT JOIN match_recap r ON r.match_id = m.id
WHERE m.id = $1`

const matchPreviewSQL = `
SELECT p.body, p.model, p.generated_at
FROM match m
LEFT JOIN match_preview p ON p.match_id = m.id
WHERE m.id = $1`

// generatedTextSQL is the only statement selection in this file that is chosen
// rather than bound. Its key is a package constant fixed by the route, so no
// request text can reach it.
var generatedTextSQL = map[string]string{
	generatedKindRecap:   matchRecapSQL,
	generatedKindPreview: matchPreviewSQL,
}

func (s *Store) GeneratedText(ctx context.Context, matchID, kind string) (*GeneratedText, error) {
	statement, known := generatedTextSQL[kind]
	if !known {
		// Unreachable through the router - the handlers pass constants - but a
		// store that trusted its caller here would be one refactor from a hole.
		return nil, fmt.Errorf("unknown generated text kind %q", kind)
	}
	var body, model *string
	var generatedAt *time.Time
	if err := s.db.QueryRow(ctx, statement, matchID).Scan(&body, &model, &generatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if body == nil || model == nil || generatedAt == nil {
		return nil, ErrNotGenerated
	}
	return &GeneratedText{
		MatchID:     matchID,
		Body:        *body,
		Model:       *model,
		GeneratedAt: isoTime(*generatedAt),
		Generated:   true,
		Kind:        kind,
	}, nil
}

// A NULL $3 means "the most recent digest"; a non-NULL $3 pins the day. Because
// the day is a predicate rather than an ordering hint, a date we hold nothing for
// returns no rows instead of silently sliding to another day's digest.
const competitionDigestSQL = `
SELECT digest_date, generated_at, model, items
FROM competition_digest
WHERE comp_id = $1 AND season_id = $2
  AND ($3::date IS NULL OR digest_date = $3)
ORDER BY digest_date DESC
LIMIT 1`

func (s *Store) CompetitionDigest(ctx context.Context, competition, season string, day *time.Time) (*Digest, int, error) {
	var digestDate, generatedAt time.Time
	var model string
	var items []byte
	if err := s.db.QueryRow(ctx, competitionDigestSQL, competition, season, day).
		Scan(&digestDate, &generatedAt, &model, &items); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}

	var decoded []DigestItem
	if err := jsonInto(items, &decoded); err != nil {
		return nil, 0, err
	}
	kept, dropped := retainSourcedItems(decoded)

	return &Digest{
		CompID:      competition,
		SeasonID:    season,
		Date:        digestDate.Format(time.DateOnly),
		GeneratedAt: isoTime(generatedAt),
		Model:       model,
		Generated:   true,
		Items:       kept,
	}, dropped, nil
}

// retainSourcedItems drops any persisted digest item that arrives with no
// evidence, and reports how many it dropped.
//
// The spec's direction of travel is that SQL finds the fact and the model writes
// the sentence; building it the other way round produces a system that
// hallucinates trends. This function is where the API enforces that direction:
// an item with no evidence is an unsourced claim, and the read path refuses to
// serve it rather than letting a caller decide whether to believe it. The count
// is returned rather than logged here because Store holds no logger, and a
// dropped item means the generator persisted something it should not have -
// which is worth an ERROR line at the edge.
func retainSourcedItems(items []DigestItem) ([]DigestItem, int) {
	kept := make([]DigestItem, 0, len(items))
	dropped := 0
	for _, item := range items {
		if len(item.Evidence) == 0 {
			dropped++
			continue
		}
		kept = append(kept, item)
	}
	return kept, dropped
}
```

In `backend/reader/server.go`, add to `readerStore`:

```go
	GeneratedText(context.Context, string, string) (*GeneratedText, error)
	CompetitionDigest(context.Context, string, string, *time.Time) (*Digest, int, error)
```

and add `"time"` to that file's imports (it is already there for `requestTimeout`).

In `backend/reader/server_test.go`, add to the `fakeReaderStore` struct:

```go
	generated     *GeneratedText
	generatedErr  error
	generatedKind string
	digest        *Digest
	digestDropped int
	digestErr     error
	digestDay     *time.Time
	digestCalls   int
```

and the two methods:

```go
func (f *fakeReaderStore) GeneratedText(_ context.Context, _ string, kind string) (*GeneratedText, error) {
	f.calls++
	f.generatedKind = kind
	return f.generated, f.generatedErr
}

func (f *fakeReaderStore) CompetitionDigest(_ context.Context, _ string, _ string, day *time.Time) (*Digest, int, error) {
	f.calls++
	f.digestCalls++
	f.digestDay = day
	return f.digest, f.digestDropped, f.digestErr
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestRetainSourcedItems|TestStoreGeneratedContent"
```

Expected: build clean, `ok`. (Docker must be running.)

- [ ] **Step 5: Commit**

```bash
git add backend/reader/store_generated.go backend/reader/store_generated_test.go backend/reader/types.go backend/reader/server.go backend/reader/server_test.go backend/reader/store_integration_test.go
git commit -m "feat(reader): read recaps, previews and digests from the store

One LEFT JOIN distinguishes an unknown match from a match with nothing
generated for it, so the two 404s are separable in a log. The digest read
pins its day as a predicate rather than an ordering hint, so a date we
hold nothing for cannot be answered with another day's anomalies, and
retainSourcedItems drops any item that arrives without evidence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The three endpoints

**Files:**
- Create: `backend/reader/handlers_generated.go`
- Modify: `backend/reader/server.go`, `backend/reader/openapi.yaml`, `backend/reader/openapi_test.go`
- Test: `backend/reader/server_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/reader/server_test.go`:

```go
func TestGeneratedResponsesAreAlwaysLabelled(t *testing.T) {
	t.Parallel()
	subject := "arg"
	// Every fake below claims Generated: false. The label is a property of the
	// endpoint, not of the row, so the handler must assert it before writing -
	// no store bug and no future caller can serve unlabelled prose.
	store := &fakeReaderStore{
		generated: &GeneratedText{MatchID: "1", Body: "Prose.", Model: "test-model", GeneratedAt: "2026-07-19T21:30:00Z", Generated: false, Kind: "recap"},
		digest: &Digest{
			CompID: "world-cup", SeasonID: "2026", Date: "2026-07-19",
			GeneratedAt: "2026-07-20T06:00:00Z", Model: "test-model", Generated: false,
			Items: []DigestItem{{Kind: "table-climb", Headline: "Up", Body: "Body.", SubjectType: "team", SubjectID: &subject, Evidence: []DigestEvidence{{Label: "Rank change", Value: "4th to 1st"}}}},
		},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	// The fake also claims Kind "recap" on both routes; kind is route-fixed, so
	// /preview must correct it rather than echo what the store handed back.
	for path, wantKind := range map[string]string{
		"/v1/matches/1/recap":                    "recap",
		"/v1/matches/1/preview":                  "preview",
		"/v1/competitions/world-cup/2026/digest": "",
	} {
		response := performRequest(router, http.MethodGet, path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body %s", path, response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if generated, ok := body["generated"].(bool); !ok || !generated {
			t.Fatalf("%s generated = %v, want true and present", path, body["generated"])
		}
		if wantKind != "" && (body["kind"] != wantKind || store.generatedKind != wantKind) {
			t.Fatalf("%s kind = %v, store saw %q", path, body["kind"], store.generatedKind)
		}
	}
}

func TestGeneratedTextMissingCasesAreDistinguishable(t *testing.T) {
	t.Parallel()
	// The reader is SELECT-only: it cannot generate on demand, so "not written
	// yet" is a 404, never an empty string and never a placeholder sentence.
	tests := []struct {
		path    string
		err     error
		message string
	}{
		{path: "/v1/matches/1/recap", err: ErrNotFound, message: "match not found"},
		{path: "/v1/matches/1/recap", err: ErrNotGenerated, message: "recap not available for this match"},
		{path: "/v1/matches/1/preview", err: ErrNotFound, message: "match not found"},
		{path: "/v1/matches/1/preview", err: ErrNotGenerated, message: "preview not available for this match"},
	}
	for _, tt := range tests {
		store := &fakeReaderStore{generatedErr: tt.err}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, tt.path)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, body %s", tt.path, response.Code, response.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["error"] != tt.message {
			t.Fatalf("%s error = %q, want %q", tt.path, body["error"], tt.message)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s cached a 404: %q", tt.path, response.Header().Get("Cache-Control"))
		}
	}
}

func TestGeneratedRoutesValidateTheirInput(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/v1/matches/not%20an%20id/recap",
		"/v1/matches/not%20an%20id/preview",
		"/v1/competitions/not-real/2026/digest",
		"/v1/competitions/world-cup/2026/digest?date=20260719",
		"/v1/competitions/world-cup/2026/digest?date=2026-13-01",
		"/v1/competitions/world-cup/2026/digest?date=latest",
	} {
		store := &fakeReaderStore{}
		response := performRequest(newTestApp(t, store, &fakeNewsReader{}).router(), http.MethodGet, path)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body %s", path, response.Code, response.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("%s reached the store", path)
		}
	}
}

func TestDigestDateSelectsADayAndNeverSubstitutes(t *testing.T) {
	t.Parallel()
	digest := &Digest{CompID: "world-cup", SeasonID: "2026", Date: "2026-07-19", GeneratedAt: "2026-07-20T06:00:00Z", Model: "test-model", Items: []DigestItem{}}

	dated := &fakeReaderStore{digest: digest}
	if response := performRequest(newTestApp(t, dated, &fakeNewsReader{}).router(), http.MethodGet,
		"/v1/competitions/world-cup/2026/digest?date=2026-07-19"); response.Code != http.StatusOK {
		t.Fatalf("dated status = %d", response.Code)
	}
	if dated.digestDay == nil || !dated.digestDay.Equal(time.Date(2026, 7, 19, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("digestDay = %v", dated.digestDay)
	}

	latest := &fakeReaderStore{digest: digest}
	if response := performRequest(newTestApp(t, latest, &fakeNewsReader{}).router(), http.MethodGet,
		"/v1/competitions/world-cup/2026/digest"); response.Code != http.StatusOK {
		t.Fatalf("latest status = %d", response.Code)
	}
	if latest.digestDay != nil {
		t.Fatalf("absent date became %v", latest.digestDay)
	}

	// A date with no digest is a 404 with its own message. Falling back to the
	// latest would present one day's anomalies under another day's date.
	missing := &fakeReaderStore{digestErr: ErrNotFound}
	response := performRequest(newTestApp(t, missing, &fakeNewsReader{}).router(), http.MethodGet,
		"/v1/competitions/world-cup/2026/digest?date=2026-07-17")
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusNotFound || body["error"] != "no digest for that date" {
		t.Fatalf("missing date = %d %s", response.Code, response.Body.String())
	}
}

func TestGeneratedCachePolicies(t *testing.T) {
	t.Parallel()
	store := &fakeReaderStore{
		generated: &GeneratedText{MatchID: "1", Body: "Prose.", Model: "test-model", GeneratedAt: "2026-07-19T21:30:00Z", Kind: "recap"},
		digest:    &Digest{CompID: "world-cup", SeasonID: "2026", Date: "2026-07-19", GeneratedAt: "2026-07-20T06:00:00Z", Model: "test-model", Items: []DigestItem{}},
	}
	router := newTestApp(t, store, &fakeNewsReader{}).router()
	for path, want := range map[string]string{
		"/v1/matches/1/recap":                    "public, max-age=3600",
		"/v1/matches/1/preview":                  "public, max-age=3600",
		"/v1/competitions/world-cup/2026/digest": "public, max-age=300",
	} {
		response := performRequest(router, http.MethodGet, path)
		if got := response.Header().Get("Cache-Control"); got != want {
			t.Fatalf("%s Cache-Control = %q, want %q", path, got, want)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./reader -run "TestGenerated|TestDigestDate"
```

Expected: FAIL — every route returns `404 {"error":"not found"}` because none is
registered yet.

- [ ] **Step 3: Implement**

Create `backend/reader/handlers_generated.go`:

```go
package main

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	// A recap or a preview is written once and is never rewritten in place - a
	// regeneration is a new row with a new input_digest - so an hour of edge
	// caching is bounded by the generator's own once-per-match discipline.
	generatedMaxAge = 3600
	// A digest is written once per day but a late-arriving day changes which
	// digest "latest" means, so the default read gets a shorter life.
	digestMaxAge = 300
)

// generatedMissingMessage keeps the two absences distinguishable in a log: a
// match we do not hold and a match nobody has written prose for are both 404s,
// but only the second one is our backlog.
var generatedMissingMessage = map[string]string{
	generatedKindRecap:   "recap not available for this match",
	generatedKindPreview: "preview not available for this match",
}

func (a *App) handleMatchRecap(writer http.ResponseWriter, request *http.Request) {
	a.serveGeneratedText(writer, request, generatedKindRecap)
}

func (a *App) handleMatchPreview(writer http.ResponseWriter, request *http.Request) {
	a.serveGeneratedText(writer, request, generatedKindPreview)
}

// serveGeneratedText serves prose the generator already wrote.
//
// It never generates. It cannot: this process connects as scorearc_reader, which
// migration 0001 grants SELECT and nothing else, and the "reader role is select
// only" integration test proves it. So a match with no recap is a 404 - not an
// on-demand generation, not an empty string, and not a placeholder sentence that
// would read like a real one.
func (a *App) serveGeneratedText(writer http.ResponseWriter, request *http.Request, kind string) {
	id, err := parseEntityID(chi.URLParam(request, "id"))
	if err != nil {
		// Safe to echo: every error out of params.go is a constant declared there.
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	text, storeErr := a.store.GeneratedText(request.Context(), id, kind)
	switch {
	case errors.Is(storeErr, ErrNotFound):
		writeError(writer, http.StatusNotFound, "match not found")
		return
	case errors.Is(storeErr, ErrNotGenerated):
		writeError(writer, http.StatusNotFound, generatedMissingMessage[kind])
		return
	case storeErr != nil:
		a.logger.Error("generated text", "id", id, "kind", kind, "err", storeErr)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	case text == nil:
		// A store that returns neither a value nor an error is a bug, and a nil
		// dereference in a public handler is a panic. recoverJSON exists because
		// that class is real; this branch means we never reach it.
		a.logger.Error("generated text returned no value and no error", "id", id, "kind", kind)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	// The label is a property of the endpoint, not of the row. Asserting it here
	// means no store bug and no future implementation of readerStore can serve
	// model-written prose that a consumer could mistake for a measured record.
	text.Generated = true
	text.Kind = kind
	cacheFor(writer, generatedMaxAge)
	writeJSON(writer, http.StatusOK, text)
}

func (a *App) handleDigest(writer http.ResponseWriter, request *http.Request) {
	competition := chi.URLParam(request, "comp")
	season := chi.URLParam(request, "season")
	if _, _, ok := a.resolve(competition, season); !ok {
		writeError(writer, http.StatusBadRequest, "unknown competition or season")
		return
	}
	var day *time.Time
	if raw := request.URL.Query().Get("date"); raw != "" {
		parsed, err := parseDay(raw)
		if err != nil {
			writeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		day = &parsed
	}

	digest, dropped, err := a.store.CompetitionDigest(request.Context(), competition, season, day)
	switch {
	case errors.Is(err, ErrNotFound):
		if day != nil {
			// Deliberately not the latest digest. Substituting a different day
			// would present Tuesday's anomalies as Wednesday's.
			writeError(writer, http.StatusNotFound, "no digest for that date")
			return
		}
		writeError(writer, http.StatusNotFound, "no digest for this competition season")
		return
	case err != nil:
		a.logger.Error("digest", "competition", competition, "season", season, "err", err)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	case digest == nil:
		a.logger.Error("digest returned no value and no error", "competition", competition, "season", season)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return
	}
	if dropped > 0 {
		// The generator persisted a claim with no source. The read path already
		// refused to serve it; this line is how anyone finds out.
		a.logger.Error("digest items dropped for missing evidence",
			"competition", competition, "season", season, "date", digest.Date, "dropped", dropped)
	}
	if digest.Items == nil {
		digest.Items = []DigestItem{}
	}
	digest.Generated = true
	cacheFor(writer, digestMaxAge)
	writeJSON(writer, http.StatusOK, digest)
}
```

In `backend/reader/server.go`, register the three routes inside the `/v1` subrouter:

```go
		router.Get("/competitions/{comp}/{season}/digest", a.handleDigest)
		router.Get("/matches/{id}/recap", a.handleMatchRecap)
		router.Get("/matches/{id}/preview", a.handleMatchPreview)
```

Now `backend/reader/openapi.yaml`. Under `components.parameters`, append:

```yaml
    DigestDate:
      name: date
      in: query
      required: false
      description: >-
        UTC calendar day, YYYY-MM-DD. Absent means the most recent digest held for
        the season. A named day we hold no digest for is a 404 rather than the
        latest digest, so a caller can never be shown one day's anomalies under
        another day's date.
      schema: { type: string, format: date }
```

Under `components.headers`, append:

```yaml
    GeneratedCacheControl:
      description: >-
        public, max-age=3600. A recap or preview is written once and never
        rewritten in place, so it is safe to cache for an hour.
      schema: { type: string, example: "public, max-age=3600" }
    DigestCacheControl:
      description: public, max-age=300.
      schema: { type: string, example: "public, max-age=300" }
```

Widen the shared `NotFound` response, which now covers more than a match summary:

```yaml
    NotFound:
      description: The requested match, recap, preview or digest is not held
      headers:
        Cache-Control: { $ref: "#/components/headers/NoStoreCacheControl" }
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Error" }
```

Add the three paths after `/v1/matches/{id}`:

```yaml
  /v1/matches/{id}/recap:
    get:
      operationId: getMatchRecap
      summary: Get the automatically generated recap for one match
      description: >-
        Prose a model wrote from this match's own stored rows. generated is always
        true and always present. The reader connects to Postgres as a SELECT-only
        role and cannot generate: a match with no recap written is a 404, never an
        on-demand generation and never a placeholder.
      parameters:
        - { $ref: "#/components/parameters/MatchID" }
      responses:
        "200":
          description: The stored recap
          headers:
            Cache-Control: { $ref: "#/components/headers/GeneratedCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/GeneratedText" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
  /v1/matches/{id}/preview:
    get:
      operationId: getMatchPreview
      summary: Get the automatically generated preview for one match
      description: >-
        Same grounding and labelling rules as the recap, written before kickoff
        from form and head-to-head. A preview states what we hold; it is not a
        prediction.
      parameters:
        - { $ref: "#/components/parameters/MatchID" }
      responses:
        "200":
          description: The stored preview
          headers:
            Cache-Control: { $ref: "#/components/headers/GeneratedCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/GeneratedText" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
  /v1/competitions/{comp}/{season}/digest:
    get:
      operationId: getCompetitionDigest
      summary: Get a day's anomaly digest for a competition season
      description: >-
        What was unusual on one UTC day. Each item carries the evidence it was
        written from: SQL finds the fact, the model writes the sentence. An item
        persisted without evidence is dropped by the reader rather than served.
      parameters:
        - { $ref: "#/components/parameters/Comp" }
        - { $ref: "#/components/parameters/Season" }
        - { $ref: "#/components/parameters/DigestDate" }
      responses:
        "200":
          description: The stored digest for that day, or the most recent one held
          headers:
            Cache-Control: { $ref: "#/components/headers/DigestCacheControl" }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Digest" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
        "500": { $ref: "#/components/responses/InternalError" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
```

and the four schemas under `components.schemas`:

```yaml
    GeneratedText:
      type: object
      additionalProperties: false
      required: [matchId, body, model, generatedAt, generated, kind]
      properties:
        matchId: { type: string }
        body: { type: string }
        model: { type: string, description: "Identifier of the model that wrote this text, recorded by the generator." }
        generatedAt: { type: string, format: date-time }
        generated:
          type: boolean
          enum: [true]
          description: >-
            Always true and always present. This text was written by a model from
            our stored data; a consumer must not be able to render it without
            knowing that.
        kind: { type: string, enum: [recap, preview] }
    DigestEvidence:
      type: object
      additionalProperties: false
      required: [label, value]
      properties:
        label: { type: string }
        value: { type: string }
    DigestItem:
      type: object
      additionalProperties: false
      required: [kind, headline, body, subjectType, subjectId, evidence]
      properties:
        kind: { type: string, description: "Anomaly family, such as table-climb, form-collapse or clean-sheet-run." }
        headline: { type: string }
        body: { type: string }
        subjectType: { type: string, enum: [team, player, competition] }
        subjectId: { type: [string, "null"] }
        evidence:
          type: array
          minItems: 1
          items: { $ref: "#/components/schemas/DigestEvidence" }
          description: >-
            The facts this item was written from. Never empty - an item with no
            evidence is an unsourced claim and is dropped before it is served.
    Digest:
      type: object
      additionalProperties: false
      required: [compId, seasonId, date, generatedAt, model, generated, items]
      properties:
        compId: { type: string }
        seasonId: { type: string }
        date: { type: string, format: date, description: "UTC calendar day, YYYY-MM-DD." }
        generatedAt: { type: string, format: date-time }
        model: { type: string }
        generated: { type: boolean, enum: [true] }
        items: { type: array, items: { $ref: "#/components/schemas/DigestItem" } }
```

Finally, in `backend/reader/openapi_test.go`, seed the fake in
`TestOpenAPIValidatesActualRouteResponses` and add three rows to its table:

```go
		generated: &GeneratedText{MatchID: "1", Body: "Argentina drew 2-2 with France.", Model: "test-model", GeneratedAt: "2026-07-19T21:30:00Z", Generated: true, Kind: "recap"},
		digest: &Digest{
			CompID: "world-cup", SeasonID: "2026", Date: "2026-07-19",
			GeneratedAt: "2026-07-20T06:00:00Z", Model: "test-model", Generated: true,
			Items: []DigestItem{{Kind: "table-climb", Headline: "Argentina top Group A", Body: "A maximum nine points.", SubjectType: "team", SubjectID: nil, Evidence: []DigestEvidence{{Label: "Rank change", Value: "4th to 1st"}}}},
		},
```

```go
		{target: "/v1/matches/1/recap", template: "/v1/matches/{id}/recap"},
		{target: "/v1/matches/1/preview", template: "/v1/matches/{id}/preview"},
		{target: "/v1/competitions/world-cup/2026/digest", template: "/v1/competitions/{comp}/{season}/digest"},
	}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd backend && go build ./... && go test ./reader -run "TestGenerated|TestDigestDate|TestOpenAPI"
```

Expected: `ok`. If `TestOpenAPIObjectSchemasAreExact` fails, a `required` array is
missing a property — every field of every struct above is required, and no struct uses
`omitempty`. If `TestOpenAPIDocumentsOperationalResponses` fails, one of the three new
`200` responses is missing its `Cache-Control` header entry.

```bash
cd backend && go test -race ./reader
```

Expected: `ok` — the pre-existing suite still passes with the widened interface.

- [ ] **Step 5: Commit**

```bash
git add backend/reader/handlers_generated.go backend/reader/server.go backend/reader/openapi.yaml backend/reader/openapi_test.go backend/reader/server_test.go
git commit -m "feat(reader): serve match recaps, previews and the anomaly digest

Three read-only endpoints for prose the generator already wrote. Each
response carries generated: true as a required field asserted by the
handler, because the E8 spec says the label is not buried and a UI
convention is not a contract. The reader is SELECT-only, so nothing here
is generated on demand: an unwritten recap is a 404, and a ?date= we hold
nothing for is a 404 rather than a different day's digest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Document the surface and run the full gate

**Files:**
- Modify: `backend/reader/README.md`

- [ ] **Step 1: Document the contract**

In `backend/reader/README.md`, append a section after "Request behavior":

```markdown
## Generated content

Three endpoints serve prose a model wrote from our own rows:

| Endpoint | Returns | Cache-Control |
|---|---|---|
| `GET /v1/matches/{id}/recap` | `GeneratedText` | `public, max-age=3600` |
| `GET /v1/matches/{id}/preview` | `GeneratedText` | `public, max-age=3600` |
| `GET /v1/competitions/{comp}/{season}/digest?date=YYYY-MM-DD` | `Digest` | `public, max-age=300` |

Rules that hold on all three:

- **`generated: true` is a required field on every response.** It is never omitted
  and the handler asserts it before writing. The label belongs in the payload, not
  in a UI convention that a second consumer of this API would not know about.
- **The reader never generates.** It connects as `scorearc_reader`, which holds
  `SELECT` and nothing else — an integration test proves the role cannot `INSERT`,
  `UPDATE`, `DELETE` or `CREATE`. A match with no recap written is a `404`
  (`recap not available for this match`), never an on-demand generation, an empty
  string, or a placeholder sentence. This is also what makes "generated once per
  match, served from cache" checkable by request count: a request to this service
  can only ever be a read.
- **Every digest item carries its evidence.** SQL finds the fact; the model writes
  the sentence. `evidence` is a required, non-empty array, and an item persisted
  without one is dropped by the store and logged rather than served.
- **`input_digest` is stored but not served.** It is the hash of the structured
  input the model was given, so a regeneration can be detected rather than guessed
  at. It is an operational field: exposing an opaque hash invites consumers to
  build on it, and we would then owe them its stability.
- **`?date=` never substitutes.** Absent means the most recent digest held. A named
  day we hold nothing for is a `404`, because answering with a different day would
  present that day's anomalies under the requested date.
- The `model` field is whatever the generator recorded. This service never chooses
  a model; check the `claude-api` reference for current model ids rather than
  hardcoding one.
```

- [ ] **Step 2: Full gate**

```bash
cd backend
go build ./...
go vet ./...
go test -race ./...
```

Expected: build silent, vet silent, every package `ok`. Docker must be running for
`reader`, `migrations` and `shared/store`.

- [ ] **Step 3: Verify by hand against a live database**

```bash
cd backend/reader
DATABASE_URL="$READER_DSN" PORT=8080 go run . &
sleep 2
curl -si "http://localhost:8080/v1/matches/401863609/recap" | head -n 12
curl -s  "http://localhost:8080/v1/matches/401863609/recap" | grep -o '"generated":[a-z]*'
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/matches/not%20an%20id/recap"
curl -s  "http://localhost:8080/v1/matches/000000000/recap"
curl -si "http://localhost:8080/v1/competitions/premier-league/2026-27/digest" | head -n 12
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/v1/competitions/premier-league/2026-27/digest?date=20260819"
curl -s  "http://localhost:8080/v1/competitions/premier-league/2026-27/digest?date=1998-07-12"
```

Expected, in order: a `200` with `Cache-Control: public, max-age=3600` (or a `404`
`{"error":"recap not available for this match"}` if no generator has run yet — which is
the correct answer, not a failure of this plan); `"generated":true`; `400`;
`{"error":"match not found"}`; a `200` with `Cache-Control: public, max-age=300` or a
`404` `{"error":"no digest for this competition season"}`; `400` for the wrong date
grammar; `{"error":"no digest for that date"}` for a valid day we hold nothing for.

- [ ] **Step 4: Open the PR**

```bash
git add backend/reader/README.md
git commit -m "docs(reader): document the generated-content contract

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/api-generated-content
gh pr create --title "feat(reader): recap, preview and digest read endpoints" --body "$(cat <<'EOF'
## What

E8 specifies three generated artefacts — a match recap, a match preview and a daily
anomaly digest — and the reader API had nowhere to put any of them. This adds the
storage and the read path: migration `0010_generated_content`, and three endpoints.

- `GET /v1/matches/{id}/recap` → `GeneratedText` (T8.1)
- `GET /v1/matches/{id}/preview` → `GeneratedText` (T8.3)
- `GET /v1/competitions/{comp}/{season}/digest?date=YYYY-MM-DD` → `Digest` (T8.2)

The generator itself is out of scope. This is the half that is stable regardless of how
the prose gets written, which is why it can land before E1's box-score shape settles.

## Approach

**The label lives in the payload.** `generated: true` is a required field on every
response, asserted by the handler rather than trusted from the row, so no store bug and
no future implementation of `readerStore` can serve model-written prose that a consumer
could mistake for a measured record. The E8 spec says the label must not be buried; a UI
convention is not a contract, and this API will have more than one consumer.

**The reader physically cannot generate.** It connects as `scorearc_reader`, which
migration `0001` grants `SELECT` and nothing else, and an existing integration test
proves the role cannot `INSERT`, `UPDATE`, `DELETE` or `CREATE`. So a match with no
recap is a `404` — never an on-demand generation, never an empty string, never a
placeholder sentence that would read like a real one. That role boundary is also what
makes E8's "generated once per match and served from cache — verified by request count,
not by inspection" a property of the architecture rather than a discipline: a request to
this service can only ever be a read.

**Every digest item carries its evidence.** The spec is explicit that SQL finds the fact
and the model writes the sentence, and that building it the other way round produces a
system that hallucinates trends. `evidence` is a required, non-empty array, and the
store drops — and the handler logs — any persisted item that arrives without one, so an
unsourced claim cannot reach a client even if the generator writes one.

**`?date=` never substitutes.** Absent means the latest digest held; a named day we hold
nothing for is a `404`, because answering with a different day would present that day's
anomalies under the requested date.

`input_digest` is stored and deliberately not served: it exists so a regeneration is
detectable, and exposing an opaque hash would invite consumers to depend on it.

## Testing

- `go build ./...`, `go vet ./...`, `go test -race ./...` all clean.
- `parseDay` table test rejects `20260719`, `2026-7-19`, `2026-02-30`, `2026-13-01` and
  a trailing quote.
- Handler tests assert the `generated` label is forced true even when the store claims
  false, that `/recap` and `/preview` pass their own route-fixed kind, that an unknown
  match and an ungenerated recap return different 404 messages, and that every rejected
  parameter returns 400 **without reaching the store**.
- Testcontainers integration tests cover the latest-digest read, the pinned-date read,
  the missing-date 404, the evidence guard against a persisted empty-evidence item, and
  a direct check that `scorearc_reader` cannot insert, update or delete generated rows.
- `TestMigrationsRoundTrip` applies `0010` up and down and still ends at zero tables.
- OpenAPI contract tests validate all three new paths and all four new schemas.

Plan: `docs/superpowers/plans/2026-08-15-api-generated-content.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's decision.

---

## Self-review notes

- **Spec coverage.** E8's "the recap is labelled as automatically generated — not
  buried, labelled" → a required `generated: true` on every response, asserted at the
  handler (Task 4). "Generated once per match and served from cache, verified by request
  count" → the SELECT-only role, which makes request-time generation impossible rather
  than merely discouraged (Tasks 1 and 3). "AI writes the sentence; SQL finds the fact"
  → `evidence` required and non-empty, with `retainSourcedItems` enforcing it (Task 3).
  "Never invent a scorer, a minute or a statistic" and "own goals are described as own
  goals" belong to the generator's prompt, which this plan does not write — they are
  recorded in **Ingester prerequisites** so the next agent does not have to re-derive
  them from the spec.
- **Deliberately not built: a chatbot.** The spec rules it out and the reasoning holds
  at the API layer too. A `/ask` endpoint would be a free-form query surface on a public
  service whose whole security argument is that it has none
  (`docs/backend/ARCHITECTURE.md` §6), and it would fail silently — once per user,
  invisibly — where a wrong recap fails visibly and gets fixed.
- **Deliberately not built: request-time generation.** Not merely unimplemented — made
  impossible by the role the process connects as. If someone later wants on-demand
  recaps, they will have to change the database grant, which is a reviewable diff rather
  than a quiet handler edit.
- **Deliberately not served: any generated number presented as a measured one.** These
  responses carry no counts, ranks or percentages of their own. Every figure a consumer
  can render comes from `evidence`, which is the row SQL found, or from the existing
  measured endpoints. The prose field is prose.
- **Deliberately not served: `input_digest`.** Stored for operational detection of a
  regeneration; not a public field.
- **Cache honesty.** The 3600-second lifetime assumes a recap is written once. If a
  generator is ever built that rewrites a recap in place, that number is a lie and must
  come down — which is exactly what `input_digest` exists to make detectable.
- **Interface churn.** `readerStore` gains two methods. The sibling `api-*` plans each
  add methods to `server.go`, `server_test.go` and `openapi.yaml`, so they should land
  one at a time rather than in parallel on the same files.
- **Migration numbering.** `0010` is claimed on a first-come basis; Task 1 says to check
  `ls backend/migrations` and renumber if a concurrent ingester plan took it. The number
  appears in four places — the two filenames and the two hardcoded lists — and all four
  must agree or `TestMigrationsRoundTrip` will report leftover tables.
- **Dependency:** `parseEntityID` and the `params.go` file itself come from
  `docs/superpowers/plans/2026-08-15-api-match-reads.md`. `parseDay` is added here and
  is available to any later plan that needs a single calendar day.
