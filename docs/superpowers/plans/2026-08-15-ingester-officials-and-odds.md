# Ingester — Match Officials and Odds Line Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the referee from a string into a person you can ask questions about, and
turn the betting line from a single current number into a movement you can plot.

**Architecture:** Two more endpoints on the **core** host
(`sports.core.api.espn.com`), which T7.12 already taught the codebase to speak.
`/officials` returns fully embedded objects with stable ids — no `$ref` chasing — so a
referee becomes a canonical entity through the same crosswalk pattern `player` uses.
`/odds` returns ESPN's own `open`/`close`/`current` per provider, which is **three fixed
points, not a time series**; the movement between them only exists if we sample `current`
ourselves, which is what the snapshot table is for.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-history-and-trends-design.md`
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Tasks: T7.14** (officials) and **T7.15**
(odds) — both new; add them under E7
**Branch:** `feat/ingester-officials-and-odds`

---

## 🔴 One correction to the briefing this plan was commissioned from

The briefing describes `/odds` as giving **"line movement over time"**. It does not, and
building on that belief would produce a chart with three points on it labelled as a curve.

Verified 2026-08-15, `mex.1` event `401877018`:

```
count: 1                      <- ONE provider (DraftKings #100), not two.
                                 Bet 365 was not present on this match.
overUnder: 2.5, spread: 0.5, overOdds: -150, underOdds: 110
drawOdds: {"moneyLine": 320}
homeTeamOdds / awayTeamOdds: {favorite, underdog, moneyLine, spreadOdds, open, close, current, team}
top-level open / close / current: {over, under, total, draw}
```

`open`, `close` and `current` are **three snapshots ESPN computes**, not a series:

- `open` — the line when the market opened. Fixed.
- `close` — the line when it closed. Fixed once the match starts.
- `current` — right now, and it is the *only* one that changes.

So: **`open` and `close` are facts about the match** and belong in a two-row-per-provider
table. **Movement is something we have to record ourselves**, by sampling `current` on a
cadence, which is what `odds_snapshot` is. Conflating the two into one table with a
`phase` column and a `captured_at` in the key produces something that is idempotent for
neither.

Also note **provider count varies**. This match had one. The plan is written for N and
keys on the provider id; do not assume DraftKings and Bet 365 both appear.

---

## What is genuinely new here, and what is not

`match_detail.info.referee` **already exists**. `mapSummaryInfo` reads
`gameInfo.officials[]` off the site-host summary and stores the referee's *display name*
as a string in the `info` jsonb. So "who refereed this match" is already answered.

What is not answered, and is what this plan adds:

- **"Every match this referee has taken charge of."** A name in jsonb is not joinable, and
  two officials who share a surname are one string.
- **"Cards per match under this referee."** Needs the referee joined to `match_play` /
  `match_event`, which needs an id.
- **The full crew.** The core `/officials` endpoint carries `position` (Referee, Assistant
  Referee, Fourth Official) and `order`; the summary's `info` keeps only the referee.

`match_detail.win_probability` and T7.6's `win_prob_snapshot` are likewise **not**
duplicated by this plan. Those are the *normalised three-way probability with the margin
removed*. This stores the **raw market** — moneylines, spread, over/under — which is the
input to that derivation and is what you need to audit it or to compute a closing-line
value. They answer different questions and both are worth keeping.

---

## ⚠️ Merge order and migration numbering

Adds migrations **`0014_match_officials`** and **`0015_odds_snapshot`**. Prerequisites, in
order: `feat/canonical-identity-impl` → `feat/player-identity` → T7.1 (`0004`) → T7.6
(`0005`) → T7.7 (`0006`) → T7.12 (`0007`).

**T7.12 is a real prerequisite:** this plan uses `espn.RefID`, the core-host constant and
the `CorePlaysURL`-style builders it introduced.

```bash
ls backend/migrations/
grep -c "func RefID" backend/shared/espn/core.go
git show feat/canonical-identity-impl:backend/migrations/0001_init.up.sql | grep -A2 "^CREATE TABLE match ("
```

Expected: `0001` … `0007_play_stream.*`, the grep prints `1`, and
`id             uuid PRIMARY KEY`. If `core.go` does not exist, stop. If you still see
`0003_ingester_delete_grant` / `0004_ingester_hardening`, the prerequisites have not
merged — also stop.

> **`match_id` is `uuid` here on purpose — do not "correct" it to `text`.** On `main`
> `match.id` is `text` (the ESPN event id); `feat/canonical-identity-impl` re-keys it to
> `uuid`, which is the tree these plans are numbered and typed against. Changing
> `match_official`, `match_odds` and `odds_snapshot` to `text` would apply today and
> break when canonical identity lands. Full reasoning:
> `2026-08-15-ingester-standings-snapshots.md` → "Two things reviewers have already got
> wrong twice".

Numbers reserved after these: `0010_leader_category`, `0011_squad_and_season_stats`,
`0012_player_bio`, `0013_match_commentary`.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, confirmed failing for the stated reason.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN`, `INGESTER_LEASE_DSN`. Secrets via `fly secrets`.
- **No provider is the identity authority.** A referee gets a ScoreArc-minted uuid and the
  ESPN id lives only in a crosswalk, exactly as `player`/`player_external_ref` do. Do not
  make `official.id` the ESPN id, however convenient — that is the rule the entire
  canonical-identity branch exists to enforce.
- `odds_snapshot` is append-only: **no `DELETE` grant**.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/migrations/0014_match_officials.{up,down}.sql`
- `backend/migrations/0015_odds_snapshot.{up,down}.sql`
- `backend/migrations/migrations_test.go`
- `backend/shared/espn/core.go` — two more URL builders.
- `backend/shared/espn/officials.go`, `officials_test.go`
- `backend/shared/espn/odds.go`, `odds_test.go`
- `backend/shared/espn/testdata/espn-officials.json`, `espn-odds.json`
- `backend/shared/model/officials.go`, `backend/shared/model/odds.go`
- `backend/shared/source/source.go`, `espn.go`
- `backend/shared/store/identity.go` — `Store.Official`.
- `backend/shared/store/officials.go`, `backend/shared/store/odds.go` + integration tests.
- `backend/ingester/contracts.go`, `matches.go`, `runner.go`, `runner_test.go`
- `docs/backend/ARCHITECTURE.md`

---

### Task 1: Record both fixtures

- [ ] **Step 1: Record**

```bash
cd backend
B="http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/events/401877018/competitions/401877018"
curl -s "$B/officials" -o shared/espn/testdata/espn-officials.json
curl -s "$B/odds"      -o shared/espn/testdata/espn-odds.json
```

- [ ] **Step 2: Verify what they actually carry**

```bash
cd backend && node -e "
const o = require('./shared/espn/testdata/espn-officials.json');
console.log('officials count:', o.count);
for (const x of o.items) console.log(' ', x.id, '|', x.fullName, '|', x.position.name, '| order', x.order);
console.log('officials are embedded, not \$ref:', o.items.every(x => !x.\$ref || x.id));

const d = require('./shared/espn/testdata/espn-odds.json');
console.log('odds providers:', d.items.map(i => i.provider.name + '#' + i.provider.id).join(', '));
const i = d.items[0];
console.log('top-level keys:', Object.keys(i).join(','));
console.log('overUnder', i.overUnder, 'spread', i.spread, 'overOdds', i.overOdds, 'underOdds', i.underOdds);
console.log('drawOdds:', JSON.stringify(i.drawOdds));
console.log('home moneyLine', i.homeTeamOdds.moneyLine, '| away moneyLine', i.awayTeamOdds.moneyLine);
console.log('home open/close/current present:',
  !!i.homeTeamOdds.open, !!i.homeTeamOdds.close, !!i.homeTeamOdds.current);
console.log('propBets is a \$ref (do not follow):', !!i.propBets && !!i.propBets.\$ref);
"
```

Expected, and each line matters:

```
officials count: 1
  9078 | Salvador Pérez Villalobos | Referee | order 1
officials are embedded, not $ref: true
odds providers: DraftKings#100
top-level keys: $ref,provider,details,overUnder,spread,overOdds,underOdds,awayTeamOdds,homeTeamOdds,drawOdds,links,moneylineWinner,spreadWinner,open,close,current,propBets
overUnder 2.5 spread 0.5 overOdds -150 underOdds 110
drawOdds: {"moneyLine":320}
home moneyLine … | away moneyLine -170
home open/close/current present: true true true
propBets is a $ref (do not follow): true
```

Three readings to take from that. **`officials count: 1`** — Liga MX publishes the referee
only, so a crew table must handle one row as normally as four. **`odds providers:
DraftKings#100`** — one provider, so nothing may assume two. **`propBets` is a `$ref`** —
it is a separate request per provider per match and is not ingested; prop bets are not on
any roadmap epic and following it would be a request we cannot justify.

- [ ] **Step 3: Commit**

```bash
git add backend/shared/espn/testdata/espn-officials.json backend/shared/espn/testdata/espn-odds.json
git commit -m "test: record core-API officials and odds fixtures

mex.1 event 401877018. One official (Liga MX publishes the referee only)
and one provider (DraftKings) -- so nothing downstream may assume a full
crew or two bookmakers.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The schema

**Files:**
- Create: `backend/migrations/0014_match_officials.{up,down}.sql`
- Create: `backend/migrations/0015_odds_snapshot.{up,down}.sql`
- Test: `backend/migrations/migrations_test.go`

- [ ] **Step 1: Write the failing migration tests**

Append to `backend/migrations/migrations_test.go`:

```go
// A referee is a person, not a string. official.id is a uuid WE mint and the
// provider id lives only in the crosswalk -- the same rule player follows, and
// the rule the whole canonical-identity schema exists to enforce.
func TestOfficialsUseCanonicalIdentity(t *testing.T) {
	sql := readMigration(t, "0014_match_officials.up.sql")
	for _, required := range []string{
		"CREATE TABLE official",
		"id        uuid PRIMARY KEY",
		"CREATE TABLE official_external_ref",
		"PRIMARY KEY (source, source_id)",
		"CREATE TABLE match_official",
		"PRIMARY KEY (match_id, official_id)",
		"GRANT SELECT, INSERT, UPDATE ON official, official_external_ref, match_official TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0014_match_officials.up.sql missing %q", required)
		}
	}
	// The whole point of the crosswalk is that the provider id is not the key.
	if strings.Contains(sql, "id text PRIMARY KEY") {
		t.Fatal("official.id must be a minted uuid, not the provider id")
	}
}

// open/close are FIXED points ESPN computes; `current` is the only thing that
// moves. They are two tables because they are idempotent on different keys,
// and one table with a phase column plus captured_at is idempotent on neither.
func TestOddsSeparatesFixedLinesFromSamples(t *testing.T) {
	sql := readMigration(t, "0015_odds_snapshot.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_odds",
		"PRIMARY KEY (match_id, provider_id, phase)",
		"phase text NOT NULL CHECK (phase IN ('open','close'))",
		"CREATE TABLE odds_snapshot",
		"PRIMARY KEY (match_id, provider_id, captured_at)",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0015_odds_snapshot.up.sql missing %q", required)
		}
	}
	if strings.Contains(sql, "GRANT DELETE ON odds_snapshot") {
		t.Fatal("odds_snapshot must stay append-only for the ingester")
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./migrations/ -run "Officials|Odds"
```

Expected: FAIL — both files missing.

- [ ] **Step 3: Write `0014_match_officials.up.sql`**

```sql
-- Referees become people.
--
-- match_detail.info.referee already holds the referee's DISPLAY NAME as a
-- string, read off the site host's gameInfo. That answers "who refereed this
-- match" and nothing else: a name in jsonb is not joinable, two officials who
-- share a surname are one string, and the assistants and fourth official are
-- dropped entirely.
--
-- Source: the CORE host's /officials, which -- unlike the play stream -- sends
-- fully EMBEDDED objects with stable ids. No $ref chasing.
--
-- id is a uuid WE mint, and the ESPN id lives only in the crosswalk. This is
-- the same shape player/player_external_ref uses and it is not negotiable:
-- keying on the provider id is precisely what the canonical-identity schema
-- exists to prevent.
CREATE TABLE official (
  id        uuid PRIMARY KEY,
  full_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE official_external_ref (
  source        text NOT NULL,
  source_id     text NOT NULL,
  official_id   uuid NOT NULL REFERENCES official(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX official_external_ref_target_idx ON official_external_ref (official_id);

-- The crew. Liga MX publishes ONE official (the referee); other competitions
-- publish four. Nothing here may assume either -- `ord` is ESPN's own display
-- order and `role` its position name, so a one-row crew and a four-row crew
-- store identically.
CREATE TABLE match_official (
  match_id    uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  official_id uuid NOT NULL REFERENCES official(id),
  role        text NOT NULL,          -- position.name: 'Referee', 'Assistant Referee'
  role_id     text,                   -- position.id, for a stable machine value
  ord         int,                    -- ESPN's `order`
  PRIMARY KEY (match_id, official_id)
);
CREATE INDEX match_official_official_idx ON match_official (official_id);
-- "Every match this person refereed" is the query the whole table exists for.
CREATE INDEX match_official_role_idx ON match_official (official_id, role);

GRANT SELECT ON official, official_external_ref, match_official TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON official, official_external_ref, match_official TO scorearc_ingester;
-- No DELETE. A crew correction is an UPDATE of role, and an official removed
-- from a sheet is rare enough not to justify the grant.
```

`0014_match_officials.down.sql`:

```sql
DROP TABLE IF EXISTS match_official;
DROP TABLE IF EXISTS official_external_ref;
DROP TABLE IF EXISTS official;
```

- [ ] **Step 4: Write `0015_odds_snapshot.up.sql`**

```sql
-- The raw betting market, in two tables because it is two different things.
--
-- ESPN's /odds gives, per provider: `open`, `close` and `current`. These are
-- THREE SNAPSHOTS IT COMPUTES, not a time series -- a common misreading, and
-- one that produces a "line movement" chart with three points on it.
--
--   open    the line when the market opened.  Fixed.
--   close   the line when it closed.          Fixed once the match starts.
--   current right now.  The ONLY one that moves.
--
-- So `open` and `close` are facts about the match, keyed on (match, provider,
-- phase) and upserted; movement is something WE record, by sampling `current`
-- on a cadence into an append-only table keyed on (match, provider, time).
-- One table with a phase column AND a captured_at is idempotent on neither.
--
-- This is NOT a duplicate of win_prob_snapshot. That stores the normalised
-- three-way probability with the bookmaker margin removed. This stores the raw
-- moneylines, spread and total that derivation is computed FROM -- which is
-- what you need in order to audit it, or to compute a closing-line value.
--
-- Provider count varies: mex.1 event 401877018 returned ONE (DraftKings).
-- Everything keys on provider_id so two, or none, work the same.

CREATE TABLE match_odds (
  match_id       uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  provider_id    text NOT NULL,
  provider_name  text NOT NULL,
  phase          text NOT NULL CHECK (phase IN ('open','close')),
  -- American moneylines, as the provider states them. Stored as sent rather
  -- than converted to an implied probability: the conversion is lossy (it
  -- cannot be inverted without knowing the margin) and belongs in a query, not
  -- in an ingest that can never be re-run for a match that has finished.
  home_moneyline int,
  draw_moneyline int,
  away_moneyline int,
  spread         numeric(5,2),
  over_under     numeric(5,2),
  over_odds      int,
  under_odds     int,
  -- When WE observed it. ESPN does not say when the line opened or closed, so
  -- this is honestly named: it is our observation time, not the market's.
  observed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, provider_id, phase)
);

CREATE TABLE odds_snapshot (
  match_id       uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  provider_id    text NOT NULL,
  -- Truncated to the minute in UTC by the writer, exactly as
  -- win_prob_snapshot is, so a 20-second live poll yields one row a minute and
  -- a plotted line has evenly spaced x values.
  captured_at    timestamptz NOT NULL,
  home_moneyline int,
  draw_moneyline int,
  away_moneyline int,
  spread         numeric(5,2),
  over_under     numeric(5,2),
  over_odds      int,
  under_odds     int,
  PRIMARY KEY (match_id, provider_id, captured_at)
);
CREATE INDEX odds_snapshot_match_idx ON odds_snapshot (match_id, captured_at);

GRANT SELECT ON match_odds, odds_snapshot TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_odds, odds_snapshot TO scorearc_ingester;
-- No DELETE on odds_snapshot: a market that has closed cannot be re-sampled.
```

`0015_odds_snapshot.down.sql`:

```sql
DROP TABLE IF EXISTS odds_snapshot;
DROP TABLE IF EXISTS match_odds;
```

- [ ] **Step 5: Run and prove both apply**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0014_match_officials.*.sql \
        backend/migrations/0015_odds_snapshot.*.sql \
        backend/migrations/migrations_test.go
git commit -m "feat: add official identity and the two odds tables

Officials follow player/player_external_ref exactly: a minted uuid with
the ESPN id in a crosswalk. match_detail.info.referee already holds the
name as a string, which answers 'who refereed this' and nothing joinable.

Odds are two tables because they are two things. ESPN's open/close are
fixed points it computes and are keyed (match, provider, phase); movement
is something we record by sampling `current`, keyed (match, provider,
time). One table with both keys is idempotent on neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Map the two payloads

**Files:**
- Modify: `backend/shared/espn/core.go`
- Create: `backend/shared/model/officials.go`, `backend/shared/model/odds.go`,
  `backend/shared/espn/officials.go`, `backend/shared/espn/odds.go`, and their tests.

**Interfaces:**
- `CoreOfficialsURL(slug, eventID string) string`, `CoreOddsURL(slug, eventID string) string`
- `MapOfficials(raw []byte) ([]model.MatchOfficial, error)`
- `MapOdds(raw []byte) ([]model.ProviderOdds, error)`

- [ ] **Step 1: Write the failing tests**

Create `backend/shared/espn/officials_test.go`:

```go
package espn

import (
	"os"
	"testing"
)

func TestCoreOfficialsAndOddsURLs(t *testing.T) {
	base := "http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1" +
		"/events/401877018/competitions/401877018"
	if got := CoreOfficialsURL("mex.1", "401877018"); got != base+"/officials" {
		t.Fatalf("CoreOfficialsURL = %s", got)
	}
	if got := CoreOddsURL("mex.1", "401877018"); got != base+"/odds" {
		t.Fatalf("CoreOddsURL = %s", got)
	}
}

// Liga MX publishes ONE official. A crew mapper that assumes four, or that
// indexes into the array to find "the referee", breaks on the first
// competition that publishes a different crew.
func TestMapOfficialsHandlesAOneManCrew(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-officials.json")
	if err != nil {
		t.Fatal(err)
	}
	crew, err := MapOfficials(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(crew) != 1 {
		t.Fatalf("crew = %d, want 1 -- the fixture is a Liga MX match", len(crew))
	}
	if crew[0].SourceID != "9078" {
		t.Fatalf("SourceID = %q, want 9078", crew[0].SourceID)
	}
	if crew[0].FullName != "Salvador Pérez Villalobos" {
		t.Fatalf("FullName = %q", crew[0].FullName)
	}
	if crew[0].Role != "Referee" {
		t.Fatalf("Role = %q, want Referee", crew[0].Role)
	}
}

// An official with no id cannot be resolved to a person, and inventing one
// keyed on a display name is exactly the collision player_external_ref exists
// to avoid.
func TestMapOfficialsDropsAnIdentitylessEntry(t *testing.T) {
	raw := []byte(`{"count":2,"items":[
	  {"id":"1","fullName":"Real Referee","position":{"name":"Referee","id":"1"},"order":1},
	  {"fullName":"Nameless","position":{"name":"Assistant Referee","id":"2"},"order":2}]}`)
	crew, err := MapOfficials(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(crew) != 1 || crew[0].SourceID != "1" {
		t.Fatalf("crew = %#v, want only the entry carrying an id", crew)
	}
}

func TestMapOfficialsAcceptsAnEmptyCrew(t *testing.T) {
	crew, err := MapOfficials([]byte(`{"count":0,"items":[]}`))
	if err != nil {
		t.Fatalf("an empty crew must not be an error: %v", err)
	}
	if len(crew) != 0 {
		t.Fatalf("crew = %d, want 0", len(crew))
	}
}
```

Create `backend/shared/espn/odds_test.go`:

```go
package espn

import (
	"os"
	"testing"
)

// The correction this plan exists to encode: open, close and current are three
// distinct readings, and only `current` moves.
func TestMapOddsSeparatesOpenCloseAndCurrent(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-odds.json")
	if err != nil {
		t.Fatal(err)
	}
	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	// One provider on this fixture. Nothing may assume two.
	if len(providers) != 1 {
		t.Fatalf("providers = %d, want 1", len(providers))
	}
	p := providers[0]
	if p.ProviderID != "100" || p.ProviderName != "DraftKings" {
		t.Fatalf("provider = %s/%s", p.ProviderID, p.ProviderName)
	}
	if p.Open == nil || p.Close == nil || p.Current == nil {
		t.Fatalf("open=%v close=%v current=%v; all three are present on the fixture",
			p.Open, p.Close, p.Current)
	}
	// The away side was the favourite at -170. Read from `current`, which is
	// the reading the top-level moneyLine mirrors.
	if p.Current.AwayMoneyline == nil || *p.Current.AwayMoneyline != -170 {
		t.Fatalf("current away moneyline = %v, want -170", p.Current.AwayMoneyline)
	}
	if p.Current.OverUnder == nil || *p.Current.OverUnder != 2.5 {
		t.Fatalf("current over/under = %v, want 2.5", p.Current.OverUnder)
	}
	if p.Current.DrawMoneyline == nil || *p.Current.DrawMoneyline != 320 {
		t.Fatalf("current draw moneyline = %v, want 320", p.Current.DrawMoneyline)
	}
}

// A market that has not opened is normal, especially for a fixture weeks away
// and for competitions no book prices. Nil, not zero -- a moneyline of 0 is
// not a price, it is a missing one.
func TestMapOddsLeavesAnAbsentMarketNil(t *testing.T) {
	providers, err := MapOdds([]byte(`{"count":1,"items":[
	  {"provider":{"id":"100","name":"DraftKings"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 {
		t.Fatalf("providers = %d, want 1", len(providers))
	}
	if providers[0].Open != nil || providers[0].Close != nil {
		t.Fatalf("open=%v close=%v, want nil for an unpriced match",
			providers[0].Open, providers[0].Close)
	}
}

func TestMapOddsAcceptsNoProviders(t *testing.T) {
	providers, err := MapOdds([]byte(`{"count":0,"items":[]}`))
	if err != nil {
		t.Fatalf("no providers must not be an error: %v", err)
	}
	if len(providers) != 0 {
		t.Fatalf("providers = %d, want 0", len(providers))
	}
}
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd backend && go test ./shared/espn/ -run "Officials|MapOdds|CoreOfficials"
```

Expected: FAIL to compile — `undefined: CoreOfficialsURL`, `undefined: MapOfficials`,
`undefined: MapOdds`.

- [ ] **Step 3: Add the URL builders**

Append to `backend/shared/espn/core.go`:

```go
// CoreOfficialsURL is the match crew. Unlike the play stream, these objects are
// fully embedded -- id, name and position all present -- so nothing here needs
// RefID.
func CoreOfficialsURL(slug, eventID string) string {
	return coreCompetitionURL(slug, eventID) + "/officials"
}

// CoreOddsURL is the per-provider betting market.
//
// Its `propBets` field is a $ref and is deliberately NOT followed: that is one
// more request per provider per match, prop bets appear on no roadmap epic,
// and an unjustified request against a keyless public API is how the whole
// ingest gets rate-limited.
func CoreOddsURL(slug, eventID string) string {
	return coreCompetitionURL(slug, eventID) + "/odds"
}

func coreCompetitionURL(slug, eventID string) string {
	event := url.PathEscape(eventID)
	return fmt.Sprintf("%s/%s/events/%s/competitions/%s",
		core, url.PathEscape(slug), event, event)
}
```

Refactor `CorePlaysURL` to build on `coreCompetitionURL` so the path is written once.

- [ ] **Step 4: Add the models**

Create `backend/shared/model/officials.go`:

```go
package model

// MatchOfficial is one member of a match's crew, in provider shape.
//
// Ingester-internal: never serialized into match_detail, never reaches the
// reader. SourceID is ESPN's official id, which the store resolves to a
// canonical uuid through official_external_ref.
type MatchOfficial struct {
	SourceID string
	FullName string
	Role     string // position.name: "Referee", "Assistant Referee"
	RoleID   string // position.id
	Order    int
}
```

Create `backend/shared/model/odds.go`:

```go
package model

// OddsLine is one reading of a betting market.
//
// Every field is a pointer. A missing moneyline is a market that has not
// opened, not a price of zero -- and the difference matters, because zero is a
// perfectly expressible American moneyline shape that no book would ever post.
//
// Moneylines are American and are stored as the provider states them. The
// conversion to an implied probability is deliberately NOT done here: it is
// lossy without the margin, and an ingest for a finished match can never be
// re-run to correct it. mapWinProbability does that conversion separately, for
// display; this keeps the input.
type OddsLine struct {
	HomeMoneyline *int
	DrawMoneyline *int
	AwayMoneyline *int
	Spread        *float64
	OverUnder     *float64
	OverOdds      *int
	UnderOdds     *int
}

// ProviderOdds is one bookmaker's three readings of one match.
//
// Open and Close are FIXED points ESPN computes. Current is the only one that
// moves, and the movement between successive Currents only exists if we record
// them -- which is what odds_snapshot is for. Any of the three may be nil: a
// fixture weeks out has no close, and a competition no book prices has none of
// them.
type ProviderOdds struct {
	ProviderID   string
	ProviderName string
	Open         *OddsLine
	Close        *OddsLine
	Current      *OddsLine
}
```

- [ ] **Step 5: Write the mappers**

Create `backend/shared/espn/officials.go`:

```go
package espn

import (
	"encoding/json"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type rawOfficialPage struct {
	Items []rawOfficialItem `json:"items"`
}

type rawOfficialItem struct {
	ID       string          `json:"id"`
	FullName string          `json:"fullName"`
	Position rawOfficialSlot `json:"position"`
	Order    int             `json:"order"`
}

type rawOfficialSlot struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

// MapOfficials reads a match's crew.
//
// Crew size varies and is never assumed: Liga MX publishes one official (the
// referee), other competitions publish four. There is deliberately no "find
// the referee" helper here -- the role is on the row, and a caller that wants
// the referee filters on it.
func MapOfficials(raw []byte) ([]model.MatchOfficial, error) {
	var page rawOfficialPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, err
	}
	crew := make([]model.MatchOfficial, 0, len(page.Items))
	for _, item := range page.Items {
		// No id, no person. Falling back to the display name would key a human
		// on a string, which is the collision official_external_ref exists to
		// prevent.
		if item.ID == "" || item.FullName == "" {
			continue
		}
		crew = append(crew, model.MatchOfficial{
			SourceID: item.ID,
			FullName: item.FullName,
			Role:     item.Position.Name,
			RoleID:   item.Position.ID,
			Order:    item.Order,
		})
	}
	return crew, nil
}
```

Create `backend/shared/espn/odds.go`:

```go
package espn

import (
	"encoding/json"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type rawOddsPage struct {
	Items []rawOddsItem `json:"items"`
}

type rawOddsItem struct {
	Provider     rawOddsProvider `json:"provider"`
	OverUnder    *float64        `json:"overUnder"`
	Spread       *float64        `json:"spread"`
	OverOdds     *float64        `json:"overOdds"`
	UnderOdds    *float64        `json:"underOdds"`
	HomeTeamOdds rawSideOdds     `json:"homeTeamOdds"`
	AwayTeamOdds rawSideOdds     `json:"awayTeamOdds"`
	DrawOdds     rawDrawOdds     `json:"drawOdds"`
}

type rawOddsProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// rawSideOdds carries both the flattened top-level moneyLine (which mirrors
// `current`) and the three nested readings.
type rawSideOdds struct {
	MoneyLine *float64      `json:"moneyLine"`
	Open      *rawOddsPhase `json:"open"`
	Close     *rawOddsPhase `json:"close"`
	Current   *rawOddsPhase `json:"current"`
}

type rawDrawOdds struct {
	MoneyLine *float64 `json:"moneyLine"`
}

type rawOddsPhase struct {
	MoneyLine *rawOddsValue `json:"moneyLine"`
	Spread    *rawOddsValue `json:"spread"`
}

// rawOddsValue is ESPN's price object. `american` is the string form ("-170",
// "+320") and is the one we store: `value` is a DECIMAL price (1.58 for -170),
// and silently mixing the two would put a decimal odd in an American column
// with no error anywhere.
type rawOddsValue struct {
	American string `json:"american"`
}

// MapOdds reads every provider's market for a match.
//
// Open and Close are FIXED readings ESPN computes; Current is the only one that
// changes. This is the correction the whole plan turns on: /odds does not give
// line movement, it gives three points, and movement only exists if we sample
// Current on a cadence.
//
// Provider count varies -- mex.1 event 401877018 returned one (DraftKings) --
// so nothing indexes into the list.
func MapOdds(raw []byte) ([]model.ProviderOdds, error) {
	var page rawOddsPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, err
	}
	out := make([]model.ProviderOdds, 0, len(page.Items))
	for _, item := range page.Items {
		if item.Provider.ID == "" {
			continue
		}
		out = append(out, model.ProviderOdds{
			ProviderID:   item.Provider.ID,
			ProviderName: item.Provider.Name,
			Open:         phaseLine(item, phaseOpen),
			Close:        phaseLine(item, phaseClose),
			Current:      currentLine(item),
		})
	}
	return out, nil
}

type oddsPhase int

const (
	phaseOpen oddsPhase = iota
	phaseClose
)

func phaseLine(item rawOddsItem, phase oddsPhase) *model.OddsLine {
	home := sidePhase(item.HomeTeamOdds, phase)
	away := sidePhase(item.AwayTeamOdds, phase)
	if home == nil && away == nil {
		return nil
	}
	line := &model.OddsLine{
		HomeMoneyline: americanMoneyline(home),
		AwayMoneyline: americanMoneyline(away),
		Spread:        spreadValue(home),
	}
	// ESPN publishes no historical draw price or total: drawOdds and overUnder
	// are current-only. Leaving them nil on open/close is honest; copying the
	// current value into them would claim the draw never moved.
	return line
}

func currentLine(item rawOddsItem) *model.OddsLine {
	if item.HomeTeamOdds.MoneyLine == nil && item.AwayTeamOdds.MoneyLine == nil &&
		item.OverUnder == nil {
		return nil
	}
	return &model.OddsLine{
		HomeMoneyline: intPtr(item.HomeTeamOdds.MoneyLine),
		DrawMoneyline: intPtr(item.DrawOdds.MoneyLine),
		AwayMoneyline: intPtr(item.AwayTeamOdds.MoneyLine),
		Spread:        item.Spread,
		OverUnder:     item.OverUnder,
		OverOdds:      intPtr(item.OverOdds),
		UnderOdds:     intPtr(item.UnderOdds),
	}
}

func sidePhase(side rawSideOdds, phase oddsPhase) *rawOddsPhase {
	if phase == phaseOpen {
		return side.Open
	}
	return side.Close
}

func americanMoneyline(phase *rawOddsPhase) *int {
	if phase == nil || phase.MoneyLine == nil {
		return nil
	}
	return parseAmerican(phase.MoneyLine.American)
}

func spreadValue(phase *rawOddsPhase) *float64 {
	if phase == nil || phase.Spread == nil {
		return nil
	}
	if value := parseAmerican(phase.Spread.American); value != nil {
		asFloat := float64(*value)
		return &asFloat
	}
	return nil
}
```

Add `parseAmerican(string) *int` and `intPtr(*float64) *int` helpers to the same file:
`parseAmerican` strips a leading `+` and returns nil on any parse failure; `intPtr` returns
nil for nil or a non-integral value. Both must return **nil rather than zero** on failure,
for the reason stated in `model.OddsLine`.

- [ ] **Step 6: Run**

```bash
cd backend && go test ./shared/espn/ -run "Officials|MapOdds|CoreOfficials" -v
```

Expected: seven `--- PASS` lines across the two test files.

- [ ] **Step 7: Commit**

```bash
git add backend/shared/espn/core.go backend/shared/espn/officials.go \
        backend/shared/espn/odds.go backend/shared/espn/officials_test.go \
        backend/shared/espn/odds_test.go backend/shared/model/officials.go \
        backend/shared/model/odds.go
git commit -m "feat: map the core-API officials and odds payloads

Crew size and provider count both vary -- the fixture has one official and
one bookmaker -- so neither mapper indexes into its list.

Odds are read as three distinct readings, not a series: open and close are
fixed points ESPN computes and only current moves. Moneylines are stored
from the `american` string, not from `value`, which is a DECIMAL price
(1.58 for -170) and would land in an American column with no error.

propBets is a \$ref and is deliberately not followed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Resolve, store, and sample

**Files:**
- Modify: `backend/shared/store/identity.go` — `Store.Official`.
- Create: `backend/shared/store/officials.go`, `backend/shared/store/odds.go` and their
  integration tests.
- Modify: `backend/shared/source/{source,espn}.go`, `backend/ingester/*`.

**Interfaces:**
- `func (s *Store) Official(ctx context.Context, source string, ref OfficialRef) (uuid.UUID, error)`
  — a direct structural copy of `Store.Player`, including its mint-and-adopt race handling.
- `func (s *Store) WriteMatchOfficials(ctx, matchID uuid.UUID, crew []model.MatchOfficial, officialIDs map[string]uuid.UUID) error`
- `func (s *Store) WriteMatchOdds(ctx, matchID uuid.UUID, providers []model.ProviderOdds) error`
  — the `open`/`close` rows.
- `func (s *Store) WriteOddsSnapshot(ctx, matchID uuid.UUID, providers []model.ProviderOdds, capturedAt time.Time) error`
  — the `current` sample, minute-truncated.
- `Source` gains `Officials(ctx, comp, eventID)` and `Odds(ctx, comp, eventID)`.

- [ ] **Step 1: Write the failing integration tests**

Create `backend/shared/store/officials_integration_test.go` and
`backend/shared/store/odds_integration_test.go` covering, at minimum:

```go
// Two matches refereed by the same person must resolve to ONE official. That
// is the entire reason this is not a string in jsonb.
func TestOfficialResolvesToOnePersonAcrossMatches(t *testing.T) { /* … */ }

// A crew that shrinks or grows between polls upserts in place.
func TestWriteMatchOfficialsIsIdempotent(t *testing.T) { /* … */ }

// open/close are keyed on phase, so re-ingesting a match rewrites the same two
// rows per provider rather than appending.
func TestWriteMatchOddsKeepsOneRowPerPhase(t *testing.T) { /* … */ }

// The sample table is the opposite: successive minutes are the movement.
func TestOddsSnapshotAccumulatesPerMinute(t *testing.T) { /* … */ }

// Same-minute re-polls collapse, exactly as win_prob_snapshot does.
func TestOddsSnapshotCollapsesAMinute(t *testing.T) { /* … */ }

// Production writes as scorearc_ingester, and a missing grant is a 42501
// inside the ingester rather than a failing test.
func TestWriteOddsAsTheIngesterRole(t *testing.T) { /* … */ }
```

Write them in the style of `snapshots_integration_test.go` from T7.1/T7.6 — same
`newIntegrationStore` / `mustSeedTwoTeams` / `mustSeedSeason` / `mustSeedMatch` helpers,
same `strings.Replace` DSN trick for the role test, same explicit assertion messages that
say what the failure means rather than just what it was.

- [ ] **Step 2: Run and watch them fail**

```bash
cd backend && go test ./shared/store/ -run "Official|Odds"
```

Expected: FAIL to compile — `store.Official undefined`, `store.WriteMatchOdds undefined`.

- [ ] **Step 3: Implement `Store.Official`**

Add to `backend/shared/store/identity.go`, immediately after `Store.Player`:

```go
// OfficialRef is a provider-scoped match-official identity.
type OfficialRef struct {
	SourceID string
	FullName string
}

// Official resolves a provider official id to a canonical official id,
// creating the official on a miss.
//
// This is Store.Player's structure, deliberately duplicated rather than
// abstracted: the two differ in table, column and error text, and a generic
// "resolve any entity" helper here would be three type parameters and a
// reflection escape hatch to save twenty lines. If a THIRD such entity
// appears, generalise then.
//
// The crosswalk upsert's RETURNING is what arbitrates a race, exactly as in
// Player: a loser that finds someone else's id there abandons the row it just
// minted and adopts the winner, rather than repointing the mapping at itself
// and silently splitting one human into two.
func (s *Store) Official(ctx context.Context, source string, ref OfficialRef) (uuid.UUID, error) {
	// … mirror Store.Player exactly, substituting official/official_external_ref
	// and official_id, and reading full_name only.
}
```

Implement it by copying `Store.Player` and substituting the table, column and error
strings. Do not "improve" it in passing — the race handling and the `DO UPDATE … RETURNING`
choice are load-bearing and are explained in `Player`'s doc comment.

- [ ] **Step 4: Implement the writers and the source methods**

`WriteMatchOfficials` upserts `ON CONFLICT (match_id, official_id) DO UPDATE SET role, role_id, ord`.

`WriteMatchOdds` upserts `ON CONFLICT (match_id, provider_id, phase) DO UPDATE`, and
**skips a provider whose phase line is nil** rather than writing a row of nulls — a row
with no prices in it is indistinguishable from a market that was priced at nothing.

`WriteOddsSnapshot` truncates to the minute in UTC (`capturedAt.UTC().Truncate(time.Minute)`,
which is safe for minutes for the reason spelled out in T7.6) and upserts
`ON CONFLICT (match_id, provider_id, captured_at) DO UPDATE`.

Add `Officials` and `Odds` to the `Source` interface and implement them on `ESPN` using
`CoreOfficialsURL` / `CoreOddsURL` and the existing `e.get`.

- [ ] **Step 5: Wire the ingester**

Two different cadences, for two different reasons:

**Officials — once, at finalization.** The crew does not change during a match, and the
appointment is published before kickoff but is only guaranteed accurate afterwards.
Call it from `capturePlays`'s neighbourhood in `matches.go`, in the same `didFinalize`
branch T7.12 uses.

**Odds — sampled while live, and captured at finalization.** Add to
`backend/ingester/odds.go`:

```go
const oddsRunKind = "odds"

// captureOdds records the market.
//
// While a match is LIVE it samples `current` into odds_snapshot -- that
// sampling IS the line movement, because ESPN's own open/close/current is
// three fixed points and not a series.
//
// At finalization it additionally writes open and close, which are settled by
// then and never change again.
func (r *runner) captureOdds(
	ctx context.Context,
	comp config.Competition,
	identity store.MatchIdentity,
	providerEventID string,
	finalized bool,
) {
	start := time.Now()
	providers, err := r.source.Odds(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, oddsRunKind, start, err)
		return
	}
	if len(providers) == 0 {
		// Normal. Not every competition is priced by a book, and a fixture
		// weeks out may have no market at all.
		r.recordRun(ctx, comp.ID, oddsRunKind, start, nil)
		return
	}
	if err := r.repo.WriteOddsSnapshot(ctx, identity.MatchID, providers, time.Now()); err != nil {
		r.log.Warn("odds snapshot", "match", providerEventID, "err", err)
	}
	if finalized {
		if err := r.repo.WriteMatchOdds(ctx, identity.MatchID, providers); err != nil {
			r.log.Warn("match odds", "match", providerEventID, "err", err)
		}
	}
	r.recordRun(ctx, comp.ID, oddsRunKind, start, nil)
}
```

Call it beside T7.6's win-probability snapshot for the live case, and in the `didFinalize`
branch with `finalized: true`.

Both writes are **additive**: recorded in `ingest_run`, never allowed to block a scoreline.
Same reasoning as `WriteParticipation` and the win-probability snapshot, and the opposite
of T7.1's standings snapshot — a missed minute of a market is one point on a line still
being sampled; a missed standings day is irrecoverable league history.

- [ ] **Step 6: Run the full suite**

```bash
cd backend && go test -race ./...
```

Expected: every package `ok`. `fakeRepository` needs the four new methods.

- [ ] **Step 7: Commit**

```bash
git add backend/shared/store/identity.go backend/shared/store/officials.go \
        backend/shared/store/odds.go backend/shared/store/*_integration_test.go \
        backend/shared/source/source.go backend/shared/source/espn.go \
        backend/ingester/odds.go backend/ingester/contracts.go \
        backend/ingester/matches.go backend/ingester/runner_test.go
git commit -m "feat: resolve match officials and record odds movement

Store.Official mirrors Store.Player exactly, including its mint-and-adopt
race handling -- duplicated rather than abstracted, because a generic
entity resolver here would be three type parameters and a reflection
escape hatch to save twenty lines.

Odds get two cadences: `current` is sampled into odds_snapshot while a
match is live, because that sampling IS the movement, and open/close are
written once at finalization, because they are fixed by then.

Both additive: recorded in ingest_run, never blocking a scoreline.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Doc, gate and PR

- [ ] **Step 1: Document the tables**

Add to `docs/backend/ARCHITECTURE.md` under `### Tier 1`:

```markdown
- **official**(id PK `uuid`, full_name, updated_at) / **official_external_ref**(PK (source, source_id), official_id→official) / **match_official**(PK (match_id→match, official_id→official), role, role_id, ord) — the match crew, from the core host's `/officials` (T7.14), which sends fully embedded objects with stable ids. `match_detail.info.referee` already held the referee's *display name*; this makes the person joinable, so "every match this referee took charge of" and "cards per match under this referee" become queries. Crew size varies — Liga MX publishes the referee alone, other competitions publish four — and nothing assumes either.
```

and under `### Tier 3`:

```markdown
- **match_odds**(PK (match_id→match, provider_id, phase ∈ `open|close`), provider_name, home/draw/away_moneyline, spread, over_under, over_odds, under_odds, observed_at) — ESPN's own opening and closing lines, which are **fixed points it computes, not a series**. Upserted.
- **odds_snapshot**(PK (match_id→match, provider_id, captured_at truncated to the minute UTC), home/draw/away_moneyline, spread, over_under, over_odds, under_odds) — append-only. **This is where line movement actually comes from**: `/odds` returns only `open`/`close`/`current`, so the movement between successive `current` readings exists only because we sample it while a match is live. Distinct from `win_prob_snapshot`, which holds the *normalised three-way probability with the margin removed*; this holds the **raw market it is derived from**, which is what you need to audit that derivation or compute a closing-line value. Provider count varies (one, DraftKings, on the recorded fixture). `propBets` is a `$ref` and is deliberately never followed.
```

- [ ] **Step 2: Full gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok`, vet silent.

- [ ] **Step 3: Prove it on a real match**

```bash
cd backend
docker run -d --name scorearc-odds -e POSTGRES_PASSWORD=postgres -p 55435:5432 postgres:16-alpine
sleep 5
for f in migrations/*.up.sql; do docker exec -i scorearc-odds psql -U postgres -q < "$f"; done
docker exec -i scorearc-odds psql -U postgres -q <<'SQL'
CREATE ROLE ingest_local LOGIN PASSWORD 'ingest_local';
GRANT ingest_local TO postgres;
GRANT scorearc_ingester TO ingest_local;
GRANT USAGE ON SCHEMA public TO ingest_local;
SQL
export POOLED_DSN='postgres://ingest_local:ingest_local@localhost:55435/postgres?sslmode=disable'
export INGESTER_LEASE_DSN="$POOLED_DSN"
go run ./ingester -once
docker exec -i scorearc-odds psql -U postgres -q <<'SQL'
SELECT o.full_name, mo.role, count(*) AS matches
  FROM match_official mo JOIN official o ON o.id = mo.official_id
 GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10;
SELECT provider_id, phase, count(*) FROM match_odds GROUP BY 1,2;
SELECT count(*) AS samples, count(DISTINCT match_id) AS matches FROM odds_snapshot;
SQL
docker rm -f scorearc-odds
```

Expected: named referees with roles; `match_odds` holding at most two rows per provider per
match (`open` and `close`, never more); and `odds_snapshot` counts that are zero if nothing
was live, which is correct and not a failure — say so in the PR rather than claiming
coverage you did not get.

- [ ] **Step 4: Open the PR**

```bash
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: record the officials and odds tables

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/ingester-officials-and-odds
gh pr create --title "feat: match officials as people, and real odds line movement (T7.14, T7.15)" --body "$(cat <<'EOF'
## What

Two more core-host endpoints: `/officials` and `/odds`.

## 🔴 A correction to the framing this was commissioned under

`/odds` was described as giving **"line movement over time"**. It does not. Verified
2026-08-15 on `mex.1` event `401877018`, it gives **three fixed readings per provider**:

- `open` — the line when the market opened. Fixed.
- `close` — the line when it closed. Fixed once the match starts.
- `current` — right now, and the only one that moves.

Building a "line movement" chart on that produces three points labelled as a curve. So this
PR splits them:

- **`match_odds`** — `open` and `close`, keyed `(match, provider, phase)`, upserted. Facts
  about the match.
- **`odds_snapshot`** — our own minute-by-minute sampling of `current` while the match is
  live, keyed `(match, provider, captured_at)`, append-only. **This is where movement
  actually comes from.**

One table with a `phase` column *and* a `captured_at` would be idempotent on neither.

Also: **the fixture returned ONE provider (DraftKings), not two.** Nothing here assumes
Bet 365 is present.

## Not a duplicate of `win_prob_snapshot`

T7.6 stores the **normalised three-way probability with the bookmaker margin removed**.
This stores the **raw moneylines, spread and total that derivation is computed from** —
which is what you need to audit the derivation, or to compute a closing-line value. Both
are worth keeping and the doc says why.

## Not a duplicate of `match_detail.info.referee` either

That already holds the referee's *display name*, from the site host. What it cannot do is
join: a name in jsonb is not a person, two officials sharing a surname are one string, and
the assistants are dropped. `official` + `official_external_ref` + `match_official` make
"every match this referee took charge of" and "cards per match under this referee"
queryable, and keep the whole crew.

**Crew size varies** — Liga MX publishes the referee alone, others publish four. Nothing
indexes into the array to "find the referee"; the role is on the row.

## Decisions worth reviewing

- **`official.id` is a minted uuid, not the ESPN id.** `Store.Official` is a structural copy
  of `Store.Player` including its mint-and-adopt race handling, duplicated rather than
  abstracted — a generic entity resolver here would be three type parameters and a
  reflection escape hatch to save twenty lines. If a third such entity appears, generalise
  then.
- **Moneylines come from the `american` string, not `value`.** `value` is a *decimal* price
  (1.58 for −170). Reading it would put a decimal odd in an American column with no error
  anywhere.
- **Prices are stored as posted, not converted to implied probability.** The conversion is
  lossy without the margin and an ingest for a finished match can never be re-run to fix it.
- **`propBets` is a `$ref` and is never followed** — one more request per provider per match
  for something on no roadmap epic.
- **Both writes are additive**: recorded in `ingest_run`, never blocking a scoreline. That is
  deliberately the opposite of T7.1's standings snapshot, which returns its error, because a
  missed market minute is one point on a line still being sampled and a missed standings day
  is irrecoverable.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Fixture-backed mappers, including a one-official crew, an identityless entry being
  dropped, an unpriced match staying nil rather than zero, and zero providers not being an
  error.
- Real Postgres: one official resolving to one person across two matches, crew upsert
  idempotency, at most two `match_odds` rows per provider per match, per-minute snapshot
  accumulation and same-minute collapse, and the writes executed **as `scorearc_ingester`**.

Plan: `docs/superpowers/plans/2026-08-15-ingester-officials-and-odds.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **The load-bearing correction.** `/odds` is three points, not a series. It is stated in the
  plan header, in the migration comment, in `model.ProviderOdds`'s doc comment, in
  `MapOdds`'s doc comment, and in the PR body. That repetition is deliberate: the wrong
  belief is the natural reading of the field names, so it has to be contradicted everywhere
  someone would form it.
- **Naming consistency.** `phase` is the CHECK-constrained column (Task 2), the `oddsPhase`
  enum (Task 3), and the `WriteMatchOdds` conflict target (Task 4). `Current` maps to
  `odds_snapshot` and never to `match_odds`.
- **Ordering hazard.** Task 3 refactors `CorePlaysURL` onto the new `coreCompetitionURL`
  helper. T7.12's `TestCorePlaysURL` asserts the exact string and must still pass — run
  `go test ./shared/espn/ -run CorePlaysURL` after that refactor, not only the new tests.
- **What is deliberately absent.** Prop bets, in-play markets beyond the three-way and the
  total, and any implied-probability conversion at ingest time. Each is a request or a lossy
  transform we cannot justify against a keyless public API and an ingest that cannot be
  re-run.
</content>
