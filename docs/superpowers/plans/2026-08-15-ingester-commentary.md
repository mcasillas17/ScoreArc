# Ingester — Relational Match Commentary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the parts of ESPN's minute-by-minute commentary the current mapper throws
away — the sequence, the period, the clock value, the play type and the wallclock — in a
table E6's shot parser and E8's recap prompt can actually query.

**Architecture:** Commentary is **already persisted**. `mapSummaryCommentary` runs on every
summary and `match_detail.commentary` is a `jsonb` array served to the site. What it keeps
is `{minute, text}` and nothing else. This plan adds a **relational** `match_commentary`
table carrying the fields the mapper discards, alongside — not instead of — the jsonb.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-shot-log-design.md` (E6) and
`docs/superpowers/specs/2026-08-15-ai-recaps-design.md` (E8)
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Task: T7.11** (new — add under E7)
**Branch:** `feat/ingester-commentary`

---

## 🔴 Read this before deciding whether to build it at all

**"Match commentary is not persisted" is false.** `backend/shared/espn/summary.go` has
`mapSummaryCommentary`, `MapSummary` calls it, and `match_detail.commentary` has been a
`jsonb NOT NULL DEFAULT '[]'` column since migration `0001`. Raw commentary text has been
stored the whole time.

So the honest scope of this task is narrower than "persist commentary", and it is worth
being explicit about what is actually being added, because a smaller true reason is better
than a larger false one:

```go
// what the mapper keeps
out = append(out, CommentaryItem{Minute: c.Time.DisplayValue, Text: c.Text})
```

```jsonc
// what ESPN sends, per line (verified in shared/espn/testdata/espn-summary.json)
{
  "sequence": 1,
  "time": { "value": 0, "displayValue": "" },
  "text": "First Half begins.",
  "play": {
    "id": "49665236",
    "type": { "id": "80", "text": "Kickoff", "type": "kickoff" },
    "period": { "number": 1 },
    "clock": { "value": 0, "displayValue": "" },
    "wallclock": "2026-06-30T17:00:27Z"
  }
}
```

Measured on that fixture: **91 commentary lines, 86 of them carrying a `play` object, 17
matching "Assisted by"**, and `time.displayValue` is the **empty string** on a
meaningful fraction of them — kickoff, halftime and full-time lines all have it blank, so
the stored `minute` is `""` and the jsonb array cannot be reliably ordered by it.

That is the real gap, and it is four things:

1. **No order.** `sequence` is dropped. The jsonb array happens to arrive in order, but
   nothing enforces it and nothing can restore it after a merge.
2. **No period or clock value.** `time.value` is dropped, so "77th minute" is only
   recoverable from a display string that is sometimes empty.
3. **No play type.** `play.type.type` is dropped — the machine value E6's parser would key
   on instead of regexing English prose.
4. **Frozen at finalization.** `match_detail` is protected by the
   `protect_finalized_detail` trigger, so a finished match's commentary can never be
   corrected or re-parsed in place.

**What this plan does NOT do:** parse the commentary. E6's shot parser is downstream and is
explicitly gated on T6.1's per-competition coverage probe. This plan stores the raw lines
with their structure intact; it does not extract a single shot.

---

## The coverage caveat, carried from E6

Commentary coverage **varies by competition and has been observed at zero**. Sampled
2026-08-15: LaLiga 129 lines (15 "Assisted by"), CONCACAF Champions Cup 175 (22); earlier
sampling gave 112 / 96 / 122 / 173 across the Premier League, Liga MX, LaLiga and Serie A;
and **one competition-event combination returned zero**.

So: an empty commentary array is **normal**, not an error, and the writer must treat it
that way. This is the same reason T6.1 blocks E6's parser — sampling two competitions and
generalising is how you ship an empty feature to a third.

---

## ⚠️ Merge order and migration numbering

Adds migration **`0013_match_commentary`**. Prerequisites, in order:
`feat/canonical-identity-impl` → `feat/player-identity` → T7.1 (`0004`) → T7.6 (`0005`) →
T7.7 (`0006`) → T7.12 (`0007`) → T7.14/T7.15 (`0008`, `0009`) → T7.8 (`0010`) →
T7.9/T7.10 (`0011`, `0012`).

```bash
ls backend/migrations/
git show feat/canonical-identity-impl:backend/migrations/0001_init.up.sql | grep -A2 "^CREATE TABLE match ("
```

Expected: `0001` … `0012_player_bio.*`, and `id             uuid PRIMARY KEY`. If numbers
have shifted, take the next free one and adjust every filename and test reference in this
plan consistently. If you still see `0003_ingester_delete_grant` /
`0004_ingester_hardening`, the prerequisites have not merged — stop.

> **`match_commentary.match_id` is `uuid` on purpose — do not "correct" it to `text`.**
> On `main` `match.id` is `text` (the ESPN event id); `feat/canonical-identity-impl`
> re-keys it to `uuid`, which is the tree this plan is typed against — and
> `match_detail`, whose `commentary` jsonb this table sits beside, is re-keyed with it.
> Full reasoning: `2026-08-15-ingester-standings-snapshots.md` → "Two things reviewers
> have already got wrong twice".

**Consider whether T7.12 made this redundant before starting.** The core API's play stream
carries the same events with `type.type`, `period`, `clock`, `wallclock` **and pitch
coordinates**, and `match_play` already stores them. If E6's shot parser can work from
`match_play`, this table's remaining value is the **prose** — which is what E8's recap
prompt wants and what a shot parser does not. That is still a real reason, but it is a
smaller one, and it is worth confirming rather than assuming. Say which reason you are
building on in the PR.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, confirmed failing for the stated reason.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN`, `INGESTER_LEASE_DSN`. Secrets via `fly secrets`.
- **`match_detail.commentary` stays.** The reader serves it verbatim as
  `MatchSummaryData.commentary` and slice 1d's cutover depends on the shape. This table is
  additive.
- **No parsing.** Not one regex over the prose. E6 owns that and is gated on T6.1.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/migrations/0013_match_commentary.{up,down}.sql`
- `backend/migrations/migrations_test.go`
- `backend/shared/model/commentary.go` — `CommentaryLine` (ingester-internal).
- `backend/shared/espn/summary.go` — the raw type gains the dropped fields.
- `backend/shared/espn/commentary.go` — `MapCommentaryLines`.
- `backend/shared/espn/commentary_test.go`
- `backend/shared/source/source.go` — `SummaryResult.Commentary`.
- `backend/shared/store/commentary.go` + integration test.
- `backend/ingester/{contracts,matches,runner_test}.go`
- `docs/backend/ARCHITECTURE.md`

---

### Task 1: The table

**Files:**
- Create: `backend/migrations/0013_match_commentary.{up,down}.sql`
- Test: `backend/migrations/migrations_test.go`

- [ ] **Step 1: Write the failing migration test**

Append to `backend/migrations/migrations_test.go`:

```go
// Commentary is ALREADY stored, as {minute, text} in match_detail.commentary
// jsonb. What is missing is everything else ESPN sends: the sequence, the
// period, the clock value, the play type and the wallclock. This table carries
// those; the jsonb stays, because the reader serves it verbatim.
func TestMatchCommentaryKeepsTheStructureTheJsonbDrops(t *testing.T) {
	sql := readMigration(t, "0013_match_commentary.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_commentary",
		"PRIMARY KEY (match_id, seq)",
		"period",
		"clock_value",
		"play_type",
		"wallclock",
		"GRANT SELECT, INSERT, UPDATE ON match_commentary TO scorearc_ingester",
		"GRANT DELETE ON match_commentary TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0013_match_commentary.up.sql missing %q", required)
		}
	}
	// The jsonb column is the reader's contract. Dropping it here would break
	// MatchSummaryData and slice 1d's cutover.
	if strings.Contains(sql, "match_detail DROP COLUMN") {
		t.Fatal("match_detail.commentary must stay; this table is additive")
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./migrations/ -run MatchCommentary
```

Expected: FAIL — `open 0013_match_commentary.up.sql: no such file or directory`.

- [ ] **Step 3: Write the migrations**

Create `backend/migrations/0013_match_commentary.up.sql`:

```sql
-- Minute-by-minute commentary, with the structure the jsonb column drops.
--
-- READ THIS BEFORE ASSUMING THIS TABLE IS NEW DATA. Commentary is already
-- persisted: mapSummaryCommentary runs on every summary and
-- match_detail.commentary has been a jsonb array since 0001. What that array
-- keeps is {minute, text}. What ESPN sends, verified in
-- shared/espn/testdata/espn-summary.json (91 lines, 86 with a `play` object):
--
--   sequence, time.value, time.displayValue, text,
--   play.type.{id,text,type}, play.period.number, play.clock.value,
--   play.wallclock
--
-- Four things are lost by keeping only two of those:
--
--   1. ORDER. `sequence` is dropped. The array happens to arrive ordered and
--      nothing guarantees it stays that way.
--   2. TIME. `time.value` is dropped, so the minute survives only as
--      `displayValue` -- which is the EMPTY STRING on kickoff, halftime and
--      full-time lines. Ordering or filtering by it silently loses them.
--   3. TYPE. play.type.type is dropped: the machine value ("kickoff",
--      "goal", "substitution") that a parser should key on instead of
--      regexing English prose that changes with locale.
--   4. MUTABILITY. match_detail is frozen by protect_finalized_detail once a
--      match finalizes, so a finished match's commentary can never be
--      corrected or re-parsed in place.
--
-- match_detail.commentary is NOT removed. The reader serves it verbatim as
-- MatchSummaryData.commentary and slice 1d's cutover depends on the shape.
-- This table is additive.
--
-- NOTHING HERE IS PARSED. E6's shot-log parser is downstream and is gated on
-- T6.1's per-competition coverage probe -- coverage varies and has been
-- observed at zero, which is exactly why the parser does not get written
-- against two samples.
CREATE TABLE match_commentary (
  match_id uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  -- ESPN's own `sequence`. Deterministic per match, so a live match re-fetched
  -- every 20s upserts instead of duplicating -- the same rule match_event uses
  -- and for the same reason.
  seq      int  NOT NULL,

  -- play.period.number. Nullable: 5 of the fixture's 91 lines carry no `play`
  -- object at all.
  period      int,
  -- play.clock.value / time.value, in ESPN's own units. Nullable rather than
  -- defaulted, because 0 is a real value (kickoff) and "unknown" must not
  -- collide with it.
  clock_value int,
  -- time.displayValue, verbatim -- INCLUDING the empty string, which is what a
  -- kickoff or halftime line carries. Storing "" as NULL would erase the
  -- distinction between "no minute given" and "a minute we failed to read".
  clock_display text NOT NULL DEFAULT '',

  -- play.type.type, the machine value, and play.type.text, the English label.
  -- Both, because the machine value is what a parser keys on and the label is
  -- what makes a stored row legible when the machine value turns out to be
  -- something nobody expected.
  play_type      text,
  play_type_text text,
  -- play.wallclock. The real-world instant, which is the only thing that lets
  -- commentary be joined against anything outside the match clock.
  wallclock timestamptz,

  text text NOT NULL,
  PRIMARY KEY (match_id, seq)
);

CREATE INDEX match_commentary_order_idx ON match_commentary (match_id, seq);
-- E6's parser and E8's recap prompt both start by selecting a subset of types.
CREATE INDEX match_commentary_type_idx ON match_commentary (play_type)
  WHERE play_type IS NOT NULL;

GRANT SELECT ON match_commentary TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_commentary TO scorearc_ingester;
-- Re-ingestion upserts 1..N then deletes the tail, exactly as match_event
-- does. A line retracted upstream must disappear rather than outlive the
-- correction. ALTER DEFAULT PRIVILEGES in 0001 covers only
-- SELECT/INSERT/UPDATE, so without this the delete raises 42501 inside the
-- ingester -- which is how curation once shipped permanently broken.
GRANT DELETE ON match_commentary TO scorearc_ingester;
```

Create `backend/migrations/0013_match_commentary.down.sql`:

```sql
-- Safe to drop outright: every row is reconstructible from
-- match_detail.commentary plus a re-fetch, and the jsonb column is untouched.
DROP TABLE IF EXISTS match_commentary;
```

- [ ] **Step 4: Run and prove it applies**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0013_match_commentary.*.sql backend/migrations/migrations_test.go
git commit -m "feat: add match_commentary for the structure the jsonb drops

Commentary was already persisted -- mapSummaryCommentary has run on every
summary since 0001 and match_detail.commentary is a jsonb array. What it
keeps is {minute, text}.

What is lost: sequence (so order is incidental), time.value (so the minute
survives only as a displayValue that is EMPTY on kickoff, halftime and
full-time lines), play.type.type (the machine value a parser should key on
rather than regexing English prose), and mutability (match_detail is
frozen by protect_finalized_detail once a match finalizes).

The jsonb column stays. The reader serves it verbatim and slice 1d depends
on the shape.

Nothing here parses anything: E6's shot parser is downstream and gated on
T6.1's coverage probe.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Read the fields the mapper walks past

**Files:**
- Create: `backend/shared/model/commentary.go`, `backend/shared/espn/commentary.go`,
  `backend/shared/espn/commentary_test.go`
- Modify: `backend/shared/espn/summary.go` (the raw type), `backend/shared/espn/types.go`

**Interfaces:**
- `model.CommentaryLine` — `{Seq int; Period, ClockValue *int; ClockDisplay string; PlayType, PlayTypeText string; Wallclock *time.Time; Text string}`.
- `func MapCommentaryLines(raw []byte) ([]model.CommentaryLine, error)` — a **sibling** of
  `mapSummaryCommentary`, not a replacement. The existing mapper keeps producing the jsonb
  the reader serves; this one produces the rows.

- [ ] **Step 1: Write the failing tests**

Create `backend/shared/espn/commentary_test.go`:

```go
package espn

import (
	"os"
	"testing"
)

// The measurements this task is justified by, asserted so they cannot silently
// stop being true.
func TestMapCommentaryLinesKeepsWhatTheJsonbDrops(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 91 {
		t.Fatalf("lines = %d, want 91 -- the recorded fixture's count", len(lines))
	}

	var withPlay, blankDisplay int
	for _, line := range lines {
		if line.PlayType != "" {
			withPlay++
		}
		if line.ClockDisplay == "" {
			blankDisplay++
		}
	}
	if withPlay != 86 {
		t.Fatalf("lines with a play type = %d, want 86", withPlay)
	}
	// The reason clock_value exists: a meaningful fraction of lines carry an
	// EMPTY displayValue, so the jsonb array cannot be ordered or filtered by
	// minute without losing them.
	if blankDisplay == 0 {
		t.Fatal("no line had a blank displayValue; the fixture has several")
	}

	// Sequence is what makes order a guarantee rather than a coincidence.
	for i := 1; i < len(lines); i++ {
		if lines[i].Seq <= lines[i-1].Seq {
			t.Fatalf("seq %d then %d at index %d; sequence is not monotonic",
				lines[i-1].Seq, lines[i].Seq, i)
		}
	}
}

// The first line of the fixture, field by field. A structural assertion beats
// a count: it fails when a field moves, not only when the file changes size.
func TestMapCommentaryLinesReadsTheKickoff(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	first := lines[0]
	if first.Seq != 1 {
		t.Fatalf("Seq = %d, want 1", first.Seq)
	}
	if first.Text != "First Half begins." {
		t.Fatalf("Text = %q", first.Text)
	}
	if first.PlayType != "kickoff" {
		t.Fatalf("PlayType = %q, want the MACHINE value kickoff, not the label", first.PlayType)
	}
	if first.PlayTypeText != "Kickoff" {
		t.Fatalf("PlayTypeText = %q, want the label Kickoff", first.PlayTypeText)
	}
	if first.Period == nil || *first.Period != 1 {
		t.Fatalf("Period = %v, want 1", first.Period)
	}
	// 0 is a real clock value at kickoff and must survive as 0, not as nil.
	if first.ClockValue == nil || *first.ClockValue != 0 {
		t.Fatalf("ClockValue = %v, want a measured 0", first.ClockValue)
	}
	// The empty display string is stored verbatim: "no minute given" and "a
	// minute we failed to read" are different facts.
	if first.ClockDisplay != "" {
		t.Fatalf("ClockDisplay = %q, want the empty string as sent", first.ClockDisplay)
	}
	if first.Wallclock == nil {
		t.Fatal("Wallclock is nil; the fixture carries play.wallclock")
	}
}

// A line with no `play` object still happened. 5 of the fixture's 91 have none.
func TestMapCommentaryLinesKeepsALineWithNoPlay(t *testing.T) {
	raw := []byte(`{"commentary":[
	  {"sequence":7,"time":{"value":12,"displayValue":"12'"},"text":"Substitution warming up."}]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(lines))
	}
	if lines[0].PlayType != "" || lines[0].Period != nil || lines[0].Wallclock != nil {
		t.Fatalf("line = %#v; a missing play object must leave those empty, not invented",
			lines[0])
	}
	// time.value is the fallback when play.clock is absent.
	if lines[0].ClockValue == nil || *lines[0].ClockValue != 12 {
		t.Fatalf("ClockValue = %v, want 12 from time.value", lines[0].ClockValue)
	}
}

// Coverage varies by competition and has been observed at ZERO. An empty array
// is a Tuesday, not a failure.
func TestMapCommentaryLinesAcceptsNoCommentary(t *testing.T) {
	lines, err := MapCommentaryLines([]byte(`{"commentary":[]}`))
	if err != nil {
		t.Fatalf("empty commentary must not be an error: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("lines = %d, want 0", len(lines))
	}
	if lines, err = MapCommentaryLines([]byte(`{}`)); err != nil || len(lines) != 0 {
		t.Fatalf("absent commentary key: lines=%d err=%v", len(lines), err)
	}
}

// The existing jsonb mapper must be untouched. Two mappers over one payload is
// only safe if the one the reader depends on does not move.
func TestMapSummaryCommentaryIsUnchanged(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	detail, err := MapSummary(raw)
	if err != nil {
		t.Fatal(err)
	}
	// mapSummaryCommentary drops empty-text entries; MapCommentaryLines does
	// not need to, because a row with a sequence and a type is useful even
	// without prose. The counts may therefore differ, and that is fine -- what
	// must not change is the jsonb shape the reader serves.
	if len(detail.Commentary) == 0 {
		t.Fatal("the jsonb commentary array is empty; the existing mapper regressed")
	}
	for _, item := range detail.Commentary {
		if item.Text == "" {
			t.Fatal("an empty-text entry reached the jsonb array; the existing filter regressed")
		}
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/espn/ -run Commentary
```

Expected: FAIL to compile — `undefined: MapCommentaryLines`. `TestMapSummaryCommentaryIsUnchanged`
compiles but is in the same file, so the package will not build until Step 4.

- [ ] **Step 3: Extend the raw type**

In `backend/shared/espn/summary.go`, replace `rawCommentaryItem` and add the play shape:

```go
type rawCommentaryItem struct {
	// ESPN's own ordinal. Dropped by mapSummaryCommentary, which is why the
	// jsonb array's order is a coincidence rather than a guarantee.
	Sequence int             `json:"sequence"`
	Time     rawClock        `json:"time"`
	Text     string          `json:"text"`
	Play     *rawCommentaryPlay `json:"play"`
}

// rawCommentaryPlay is the structure attached to 86 of the recorded fixture's
// 91 lines. A pointer because the other 5 have none, and a zero-valued struct
// would report period 0 and type "" as though they had been measured.
type rawCommentaryPlay struct {
	ID        string      `json:"id"`
	Type      rawPlayType `json:"type"`
	Period    rawPeriod   `json:"period"`
	Clock     rawClock    `json:"clock"`
	Wallclock string      `json:"wallclock"`
}
```

`rawPlayType` and `rawPeriod` already exist — T7.12 declared them in
`backend/shared/espn/plays.go`, in this same package. **Do not redeclare them.** If T7.12
has not landed, declare them here instead and delete the duplicates when it does.

- [ ] **Step 4: Write the mapper**

Create `backend/shared/espn/commentary.go`:

```go
package espn

import (
	"encoding/json"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// MapCommentaryLines reads commentary WITH the structure mapSummaryCommentary
// discards.
//
// It is a sibling of that function, not a replacement. mapSummaryCommentary
// produces []CommentaryItem, which is serialized into match_detail.commentary
// and served to the site as MatchSummaryData.commentary -- changing it would
// change an API response. This produces rows, and nothing it returns is
// serialized anywhere.
//
// It deliberately does NOT drop empty-text entries the way the jsonb mapper
// does. A line with a sequence, a period and a play type is useful to a parser
// even with no prose attached, and the jsonb mapper's filter exists because the
// site renders the text.
//
// Nothing here parses. E6 owns the shot parser and is gated on T6.1's
// per-competition coverage probe.
func MapCommentaryLines(raw []byte) ([]model.CommentaryLine, error) {
	var rs rawSummary
	if err := json.Unmarshal(raw, &rs); err != nil {
		return nil, err
	}
	lines := make([]model.CommentaryLine, 0, len(rs.Commentary))
	for index, item := range rs.Commentary {
		line := model.CommentaryLine{
			Seq:  item.Sequence,
			Text: item.Text,
			// Verbatim, INCLUDING the empty string. A kickoff, a halftime and
			// a full-time line all carry "" here, and normalising that to NULL
			// would erase the difference between "no minute given" and "a
			// minute we failed to read".
			ClockDisplay: item.Time.DisplayValue,
		}
		// time.value is the base reading; play.clock.value overrides it when
		// present, because it is the one attached to the event rather than to
		// the commentary line.
		clock := int(item.Time.Value)
		line.ClockValue = &clock

		if item.Play != nil {
			line.PlayType = item.Play.Type.Type
			line.PlayTypeText = item.Play.Type.Text
			period := item.Play.Period.Number
			line.Period = &period
			playClock := int(item.Play.Clock.Value)
			line.ClockValue = &playClock
			if item.Play.Wallclock != "" {
				if at, err := time.Parse(time.RFC3339, item.Play.Wallclock); err == nil {
					line.Wallclock = &at
				}
			}
		}
		// A payload with no `sequence` would collapse every line onto seq 0 and
		// the upsert would keep only the last. Fall back to the array index,
		// which is at least distinct, and which matches the order the jsonb
		// array is already assumed to be in.
		if line.Seq == 0 && index > 0 {
			line.Seq = index + 1
		}
		lines = append(lines, line)
	}
	return lines, nil
}
```

Create `backend/shared/model/commentary.go`:

```go
package model

import "time"

// CommentaryLine is one line of match commentary with the structure ESPN sends
// and match_detail.commentary drops.
//
// Ingester-internal, like the participation and play types: no json tags, never
// serialized into match_detail, never reaches the reader. The jsonb array the
// reader DOES serve is CommentaryItem in types.go, which stays exactly as it
// is.
type CommentaryLine struct {
	// ESPN's `sequence`. The reason order is a guarantee here and a
	// coincidence in the jsonb array.
	Seq int

	// nil when the line carried no `play` object -- 5 of 91 on the recorded
	// fixture. A zero-valued int would claim period 0 was measured.
	Period *int
	// play.clock.value, or time.value when there is no play. A pointer because
	// 0 is a real reading at kickoff and must not collide with "unknown".
	ClockValue *int
	// time.displayValue verbatim, empty string included. Kickoff, halftime and
	// full-time lines all carry "", which is exactly why ClockValue exists.
	ClockDisplay string

	// play.type.type, the machine value ("kickoff", "goal"), and
	// play.type.text, the English label. Both: the machine value is what a
	// parser keys on, the label is what makes a stored row legible when the
	// machine value turns out to be something nobody expected.
	PlayType     string
	PlayTypeText string

	// play.wallclock. The only field that lets commentary be joined against
	// anything outside the match clock.
	Wallclock *time.Time

	Text string
}
```

Add `type CommentaryLine = model.CommentaryLine` to `backend/shared/espn/types.go`.

- [ ] **Step 5: Run**

```bash
cd backend && go test ./shared/espn/ -run "Commentary|MapSummary" -v
```

Expected: the five new cases pass **and** every pre-existing `MapSummary` case still
passes. Two mappers over one payload is only safe if the one the reader depends on has not
moved.

- [ ] **Step 6: Commit**

```bash
git add backend/shared/model/commentary.go backend/shared/espn/commentary.go \
        backend/shared/espn/commentary_test.go backend/shared/espn/summary.go \
        backend/shared/espn/types.go
git commit -m "feat: read commentary sequence, period, clock, type and wallclock

A sibling of mapSummaryCommentary, not a replacement: that one produces
the jsonb array the reader serves verbatim, and changing it would change
an API response.

Unlike the jsonb mapper this keeps empty-text lines. A line with a
sequence, a period and a play type is useful to a parser without prose;
the jsonb filter exists because the site renders the text.

Verified against the recorded fixture: 91 lines, 86 with a play object,
and several with an EMPTY time.displayValue -- which is why clock_value
had to exist at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Write the rows

**Files:**
- Create: `backend/shared/store/commentary.go` + integration test
- Modify: `backend/shared/source/{source,espn}.go`, `backend/ingester/{contracts,matches,runner_test}.go`

**Interfaces:**
- `SummaryResult` gains `Commentary []model.CommentaryLine` — beside `Participation`, and
  for the same reason: it is resolved and written separately and never reaches the reader.
- `func (s *Store) WriteCommentary(ctx context.Context, matchID uuid.UUID, lines []model.CommentaryLine) (int, error)`

- [ ] **Step 1: Write the failing integration tests**

Create `backend/shared/store/commentary_integration_test.go`:

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func commentaryFixture(count int) []model.CommentaryLine {
	period, clock := 1, 0
	lines := make([]model.CommentaryLine, 0, count)
	for i := range count {
		lines = append(lines, model.CommentaryLine{
			Seq: i + 1, Period: &period, ClockValue: &clock,
			PlayType: "pass", PlayTypeText: "Pass", Text: "Something happened.",
		})
	}
	return lines
}

// A live match is re-fetched every 20s and commentary GROWS. Re-ingestion must
// converge on the longer list, not accumulate two copies of the first half.
func TestWriteCommentaryUpsertsAsTheMatchGrows(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(10)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25)); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 25 {
		t.Fatalf("rows = %d after 10 then 25 lines, want 25", rows)
	}
}

// A line retracted upstream must disappear, or the phantom outlives the
// correction. This is the tail delete, and it is why the DELETE grant exists.
func TestWriteCommentaryPrunesARetractedTail(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(20)); err != nil {
		t.Fatal(err)
	}
	var maxSeq int
	if err := pool.QueryRow(ctx,
		`SELECT coalesce(max(seq), 0) FROM match_commentary WHERE match_id=$1`,
		matchID).Scan(&maxSeq); err != nil {
		t.Fatal(err)
	}
	if maxSeq != 20 {
		t.Fatalf("max seq = %d after a shortened list, want 20", maxSeq)
	}
}

// Coverage has been observed at ZERO for a competition. An empty list must be
// a no-op, NOT a delete: a live summary can momentarily return without
// commentary, and treating that as "this match now has none" would erase good
// rows on a transient blip -- the same rule WriteParticipation applies.
func TestWriteCommentaryTreatsEmptyAsAbsenceOfEvidence(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	if _, err := store.WriteCommentary(ctx, matchID, commentaryFixture(25)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteCommentary(ctx, matchID, nil); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 25 {
		t.Fatalf("rows = %d after an empty payload, want the 25 preserved", rows)
	}
}

// Nulls survive as nulls. A line with no play object must not acquire a
// period 0 and a play type of "".
func TestWriteCommentaryKeepsAbsentFieldsNull(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	at := time.Date(2026, 8, 15, 19, 42, 0, 0, time.UTC)
	clock := 0
	if _, err := store.WriteCommentary(ctx, matchID, []model.CommentaryLine{
		{Seq: 1, ClockValue: &clock, ClockDisplay: "", Text: "First Half begins."},
		{Seq: 2, PlayType: "goal", PlayTypeText: "Goal", Wallclock: &at, Text: "Goal!"},
	}); err != nil {
		t.Fatal(err)
	}
	var period *int
	var playType *string
	var wallclock *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT period, play_type, wallclock FROM match_commentary WHERE match_id=$1 AND seq=1`,
		matchID).Scan(&period, &playType, &wallclock); err != nil {
		t.Fatal(err)
	}
	if period != nil || playType != nil || wallclock != nil {
		t.Fatalf("period=%v play_type=%v wallclock=%v, want all NULL", period, playType, wallclock)
	}
}

// Production writes as scorearc_ingester, including the tail DELETE. A missing
// grant is a 42501 inside the ingester, not a failing test.
func TestWriteCommentaryAsTheIngesterRole(t *testing.T) {
	// … same shape as TestWriteStandingSnapshotAsTheIngesterRole: create a
	// login role, GRANT scorearc_ingester to it, reconnect on the rewritten
	// DSN, write 25 lines then 20, and assert the tail was pruned.
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/store/ -run WriteCommentary
```

Expected: FAIL to compile — `store.WriteCommentary undefined`.

- [ ] **Step 3: Implement**

Create `backend/shared/store/commentary.go` following `WriteParticipation`'s structure
exactly:

- Return `(0, nil)` immediately for an empty slice — **absence of evidence only**. This is
  the single most important line in the file and is the reason
  `TestWriteCommentaryTreatsEmptyAsAbsenceOfEvidence` exists.
- Open a transaction, `pgx.Batch` the upserts:
  ```sql
  INSERT INTO match_commentary (
      match_id, seq, period, clock_value, clock_display,
      play_type, play_type_text, wallclock, text)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (match_id, seq) DO UPDATE SET
      period         = EXCLUDED.period,
      clock_value    = EXCLUDED.clock_value,
      clock_display  = EXCLUDED.clock_display,
      play_type      = EXCLUDED.play_type,
      play_type_text = EXCLUDED.play_type_text,
      wallclock      = EXCLUDED.wallclock,
      text           = EXCLUDED.text
  ```
- Then the tail delete, keyed on the **highest sequence written** rather than on a count,
  because `seq` comes from ESPN and is not guaranteed to be `1..N`:
  ```sql
  DELETE FROM match_commentary WHERE match_id=$1 AND seq > $2
  ```
- Empty strings for `play_type`/`play_type_text` must be passed as SQL `NULL` — reuse the
  existing `nullIfEmpty` helper in `shared/store/seed.go`. Without it,
  `TestWriteCommentaryKeepsAbsentFieldsNull` fails and the
  `match_commentary_type_idx WHERE play_type IS NOT NULL` partial index indexes every row.

Then add `Commentary []model.CommentaryLine` to `source.SummaryResult`, populate it in
`(*ESPN).Summary` from `espn.MapCommentaryLines(raw)`, add
`WriteCommentary(context.Context, uuid.UUID, []model.CommentaryLine) (int, error)` to the
ingester's `repository` interface, and call it in `matches.go` **immediately after
`WriteParticipation`**, with the same additive error handling:

```go
			// Additive, like participation: recorded and never allowed to stop
			// a scoreline. Commentary coverage varies by competition and has
			// been observed at zero, so a failure here is often not a failure
			// at all.
			if _, err := r.repo.WriteCommentary(ctx, identity.MatchID, summary.Commentary); err != nil {
				operationErrors = append(operationErrors,
					fmt.Errorf("match %s commentary: %w", match.ID, err))
			}
```

- [ ] **Step 4: Run the whole suite**

```bash
cd backend && go test -race ./...
```

Expected: every package `ok`. `fakeRepository` needs `WriteCommentary`.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/store/commentary.go \
        backend/shared/store/commentary_integration_test.go \
        backend/shared/source/source.go backend/shared/source/espn.go \
        backend/ingester/contracts.go backend/ingester/matches.go \
        backend/ingester/runner_test.go
git commit -m "feat: persist commentary as rows alongside the jsonb

Upsert on (match_id, seq) then delete the tail, exactly as match_event
does: a live match's commentary grows every 20s and must converge, and a
line retracted upstream must disappear rather than outlive the correction.

An EMPTY payload is a no-op, not a delete. Coverage varies by competition
and has been observed at zero, and a live summary can momentarily return
without commentary -- treating that as 'this match now has none' would
erase good rows on a transient blip.

Additive: recorded, never blocking a scoreline.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Doc, gate and PR

- [ ] **Step 1: Document**

Add to `docs/backend/ARCHITECTURE.md` under `### Tier 1`:

```markdown
- **match_commentary**(PK (match_id→match, **seq** = ESPN's `sequence`), period, clock_value, clock_display, play_type, play_type_text, wallclock, text) — minute-by-minute commentary **with the structure `match_detail.commentary` drops** (T7.11). That jsonb column is unchanged and is still what the reader serves as `MatchSummaryData.commentary`; it keeps `{minute, text}` only. This table adds the four things that loses: order (`sequence`), a numeric clock (`time.displayValue` is the **empty string** on kickoff, halftime and full-time lines), the machine play type (`play.type.type`, so a parser need not regex English prose), and mutability (`match_detail` is frozen by `protect_finalized_detail` once a match finalizes). Upserted then tail-deleted, like `match_event`; an **empty payload is a no-op, not a delete**, because commentary coverage varies by competition and has been observed at zero. **Nothing here is parsed** — E6's shot-log parser is downstream and gated on T6.1's coverage probe.
```

- [ ] **Step 2: Full gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok`, vet silent.

- [ ] **Step 3: Prove it, and measure coverage while you are there**

```bash
cd backend
docker run -d --name scorearc-comm -e POSTGRES_PASSWORD=postgres -p 55438:5432 postgres:16-alpine
sleep 5
for f in migrations/*.up.sql; do docker exec -i scorearc-comm psql -U postgres -q < "$f"; done
docker exec -i scorearc-comm psql -U postgres -q <<'SQL'
CREATE ROLE ingest_local LOGIN PASSWORD 'ingest_local';
GRANT ingest_local TO postgres;
GRANT scorearc_ingester TO ingest_local;
GRANT USAGE ON SCHEMA public TO ingest_local;
SQL
export POOLED_DSN='postgres://ingest_local:ingest_local@localhost:55438/postgres?sslmode=disable'
export INGESTER_LEASE_DSN="$POOLED_DSN"
go run ./ingester -once
go run ./ingester -once

docker exec -i scorearc-comm psql -U postgres -q <<'SQL'
-- Per-competition coverage. This is real evidence for E6's T6.1, obtained for
-- free, and it is more useful than the two-competition sample the roadmap has.
SELECT m.competition_id,
       count(DISTINCT c.match_id)                     AS matches_with_commentary,
       count(*)                                       AS lines,
       count(c.play_type)                             AS with_play_type,
       count(*) FILTER (WHERE c.text ILIKE '%assisted by%') AS assisted_by
  FROM match_commentary c JOIN match m ON m.id = c.match_id
 GROUP BY 1 ORDER BY 3 DESC;
SQL
docker rm -f scorearc-comm
```

Expected: lines per competition varying widely, some competitions possibly at **zero rows
entirely** — which is the documented behaviour, not a failure. Running twice matters:
`lines` must not double.

**Put this table in the PR.** It is the per-competition coverage measurement E6's T6.1 needs
and it costs nothing to produce here.

- [ ] **Step 4: Open the PR**

```bash
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: match_commentary carries the structure the jsonb drops

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/ingester-commentary
gh pr create --title "feat: store commentary as rows, with the structure the jsonb drops (T7.11)" --body "$(cat <<'EOF'
## 🔴 First, a correction to the premise

**"Match commentary is not persisted" is false.** `mapSummaryCommentary` has run on every
summary since the beginning and `match_detail.commentary` has been a `jsonb NOT NULL DEFAULT
'[]'` column since migration `0001`. Raw commentary text has been stored the whole time.

So this PR is narrower than "persist commentary", and the smaller true reason is worth
stating plainly. The jsonb keeps `{minute, text}`. ESPN sends, per line:

```
sequence, time.value, time.displayValue, text,
play.type.{id,text,type}, play.period.number, play.clock.value, play.wallclock
```

Four things are lost by keeping two of those:

1. **Order.** `sequence` is dropped; the array's ordering is a coincidence.
2. **A numeric clock.** `time.value` is dropped, so the minute survives only as
   `displayValue` — which is the **empty string** on kickoff, halftime and full-time lines.
   Ordering or filtering the jsonb by minute silently loses them.
3. **The machine play type.** `play.type.type` is dropped — the value a parser should key on
   instead of regexing English prose.
4. **Mutability.** `match_detail` is frozen by `protect_finalized_detail` once a match
   finalizes, so a finished match's commentary can never be corrected or re-parsed in place.

Measured on `shared/espn/testdata/espn-summary.json`: **91 lines, 86 with a `play` object,
17 matching "Assisted by"**, several with a blank `displayValue`.

## What this does not do

**It does not parse anything.** Not one regex over the prose. E6's shot-log parser is
downstream and is explicitly gated on T6.1's per-competition coverage probe — coverage
varies and **has been observed at zero**, which is exactly why a parser does not get written
against two samples.

`match_detail.commentary` is **not** removed. The reader serves it verbatim as
`MatchSummaryData.commentary` and slice 1d's cutover depends on the shape.

## Worth checking before merging

If **T7.12 (the play stream)** has landed, `match_play` already carries the same events with
`type.type`, `period`, `clock`, `wallclock` **and pitch coordinates**. If E6's parser can
work from that table, this one's remaining value is the **prose** — which E8's recap prompt
wants and a shot parser does not. Still a real reason, but a smaller one. I built on
<state which>.

## Design decisions

- **Keyed on ESPN's `sequence`**, upserted then tail-deleted, exactly like `match_event`: a
  live match's commentary grows every 20 seconds and must converge, and a retracted line
  must disappear rather than outlive the correction.
- **The tail delete is keyed on the highest `seq` written**, not on a count — `seq` comes
  from the provider and is not guaranteed to be `1..N`.
- **An empty payload is a no-op, not a delete.** A live summary can momentarily return
  without commentary, and treating that as "this match now has none" would erase good rows on
  a transient blip. Same rule `WriteParticipation` already applies.
- **`clock_display` stores the empty string verbatim.** "No minute given" and "a minute we
  failed to read" are different facts, and `clock_value` exists precisely because the display
  string is sometimes blank.
- **`MapCommentaryLines` keeps empty-text lines**, unlike the jsonb mapper. A line with a
  sequence, a period and a play type is useful to a parser without prose; the jsonb filter
  exists because the site renders the text.
- **Additive error handling**: recorded, never blocking a scoreline.

## Coverage measurement, included

The end-to-end run produces a per-competition table of lines, play-type coverage and
"Assisted by" counts. That is real evidence for **E6's T6.1**, obtained for free here, and it
is broader than the two-competition sample the roadmap currently records. It is in this PR's
comments.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Fixture-backed: the 91/86 counts, monotonic sequence, a field-by-field read of the kickoff
  line (machine type vs label, a measured `0` clock, the empty display string), a line with
  no `play` object, and empty/absent commentary not being an error.
- **A guard that the existing jsonb mapper is unchanged** — two mappers over one payload is
  only safe if the one the reader depends on does not move.
- Real Postgres: growth converges, a shortened list prunes its tail, an empty payload
  preserves, absent fields stay NULL, and the writes run **as `scorearc_ingester`** including
  the tail DELETE its narrow grant exists for.

Plan: `docs/superpowers/plans/2026-08-15-ingester-commentary.md`
EOF
)"
```

- [ ] **Step 5: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **This plan's main contribution is honesty about its own scope.** The task was framed as
  "persist commentary"; commentary was already persisted. Rather than build the framing, the
  plan states what is actually missing, measures it against the recorded fixture, and offers
  an explicit "check whether T7.12 made this redundant" gate before Task 1.
- **Naming consistency.** `seq` is ESPN's `sequence` in the migration, `Seq` on
  `CommentaryLine`, and the `ON CONFLICT` target. `play_type` is the **machine** value and
  `play_type_text` the label, in that order everywhere.
- **Ordering hazard.** Task 2 Step 3 uses `rawPlayType` and `rawPeriod`, which T7.12 declares
  in the same package. Redeclaring them is a compile error that will look like a mistake in
  this plan; it is a merge-order symptom. If T7.12 has not landed, declare them here and
  delete the duplicates when it does.
- **The thing most likely to be got wrong.** Passing `""` for `play_type` instead of SQL
  NULL. It stores, it reads back, and it quietly makes the partial index
  `WHERE play_type IS NOT NULL` cover every row — an index that is 100% of the table and
  therefore useless. `nullIfEmpty` already exists in `shared/store/seed.go`; use it.
</content>
