# Ingester — Touch-Level Play Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture ESPN's touch-level play stream — every pass, tackle, shot and its pitch
coordinates — before ESPN deletes it, and make the analysable subset queryable.

**Architecture:** A new provider against ESPN's **core** API host
(`sports.core.api.espn.com`), which the codebase does not currently use. Two
destinations, split on a rule: **every byte goes to a private R2 bucket as an immutable
gzipped archive**, and **the analysable event tier goes to Postgres as rows**. R2 holds
what we cannot re-fetch; Postgres holds what we query today. When the parser improves, R2
is re-processed into more rows — which is only possible because the raw bytes were kept.
The archive uses a **second** R2 bucket and a **second** client: the existing
`assets.Mirror` is bound to the public CDN bucket and requires a public base URL that a
private bucket does not have.

**Tech Stack:** Go 1.26, pgx v5, Postgres 16 (Neon), Cloudflare R2 via the existing
`shared/assets` S3 client, testcontainers-go.

**Spec:** `docs/superpowers/specs/2026-08-15-shot-log-design.md` (E6) and
`docs/superpowers/specs/2026-08-15-history-and-trends-design.md` (E7)
**Epic:** E7 in `docs/PRODUCT_ROADMAP.md` · **Tasks: T7.12** (ingestion) and **T7.13**
(retention probe + current-season backfill) — both new; add them under E7
**Branch:** `feat/ingester-play-stream`

---

## 🔴 Two verified facts contradict the briefing this plan was commissioned from

Both were established by direct request against the live API on 2026-08-15. Do not
silently work around them; they change what gets built.

### 1. Shot coordinates DO exist. The roadmap's "not building xG" rationale is now wrong.

`docs/PRODUCT_ROADMAP.md` states, under "Not building, and why":

> **xG** — Not in the ESPN payload and not anywhere in `src/`.
> **Heat maps** — No pass or touch coordinates exist in any response we can reach.

Both statements are false of the **core** API. Liga MX event `401877018`, a `Pass`:

```json
"fieldPositionX": 50,   "fieldPositionY": 50,
"fieldPosition2X": 39.5, "fieldPosition2Y": 50.9
```

and a `Shot On Target`:

```
fieldPositionX 77.2  fieldPositionY 25     <- where the shot was struck
fieldPosition2X 97.5 fieldPosition2Y 47.5  <- where it ended
goalPositionY 51.2   goalPositionZ 5.1     <- placement within the goal mouth
```

**546 of 567 sampled plays carried non-zero pitch coordinates.** An xG model needs shot
location, and shot location is right there.

**This plan does not build xG or a heat map.** It persists the coordinates so that
decision can be made on evidence instead of on a stale "the data does not exist". Whoever
picks that up must first update the roadmap's rejection table, because it currently
records a reason that is not true.

### 2. `limit` caps at 1000 and fails *silently* above it.

| `?limit=` | `pageSize` returned | `pageCount` |
|---|---|---|
| 100 | 100 | 16 |
| 400 | 400 | 4 |
| **1000** | **1000** | **2** |
| 1001 | **25** | **62** |
| 2000 | **25** | **62** |

Above 1000 the API does not error — it silently falls back to the default page size of
25, turning a 2-request fetch into a 62-request one. The briefing's suggested
`?limit=400` works but costs four round trips per match instead of two. **Use 1000, and
assert the returned `pageSize` matches what was asked**, or a future default change turns
one ingest cycle into 62× the requests with nothing in the logs.

### 3. The retention boundary is the SEASON, and what survives is not what you would assume

**Measured 2026-08-15, and this supersedes every earlier guess** (the briefing offered
"somewhere between ~1 week and ~10 months, plausibly season-boundary, NOT verified"):

| Match | Plays | Passes | Coord scale | Goal-mouth |
|---|---|---|---|---|
| Liga MX `401877018`, 2026-08-15 (today) | 1,542 | 549 | 0–100 | present |
| Liga MX `401877043`, 2026-07-17 (**30 days old, this season**) | 1,491 | 610 | 0–100 | present |
| Liga MX `401870615`, 2026-05-10 (**last season**) | 199 | **0** | **0–1** | **all zero** |
| Premier League `740921`, 2026-04-18 | 189 | **0** | **0–1** | **all zero** |
| MLS `727172`, 2025-08-09 | 198 | **0** | **0–1** | **all zero** |
| CONCACAF CC `401865469`, 2026-04-08 | 164 | **0** | **0–1** | **all zero** |

Three conclusions, each of which changes a design decision in this plan:

**(a) The boundary is the season, not an age.** A 30-day-old current-season match is
fully intact; a four-month-old previous-season match is not. So the backfill deadline is
**the end of this season** — urgent and schedulable, rather than a rolling daily loss.
Task 1's probe therefore samples *across the season boundary*, not across a sliding
window of days.

**(b) Historical geometry is in a DIFFERENT FRAME, not a rescale.** Prior-season shots
keep a pitch location, which looks like a free backfill and is not:

- the scale is **0–1**, not 0–100;
- `goalPositionY/Z` are **zero on every historical match sampled** (n=194 on `740685`,
  zero non-zero values) — goal-mouth placement does not survive at all;
- the frame appears **inverted** — historical shots cluster at low x (0.02–0.49) while
  current-season shots cluster high (69–95 on 0–100), so a `×100` puts every historical
  shot in the wrong half of the pitch.

**(c) Therefore the earlier claim that "a shot map and an xG model for a past season are
probably still recoverable" was too optimistic and has been removed.** Past-season shots
have a location in an unvalidated frame and no goal-mouth placement. Whether that frame
can be reconciled is a **measurement** — E9's T9.1 owns it — and until it reports, nothing
downstream may mix the two eras.

What this does **not** change: the touch tier is still the most perishable data we have,
and this season's is intact today. Task 7's backfill is scoped to the current season and
deliberately does not attempt prior ones.

---

## Storage split, and why

| Tier | Destination | Volume | Rationale |
|---|---|---|---|
| **Every play, raw JSON** | **R2 private raw bucket** (`R2_RAW_BUCKET`), gzipped, immutable | ~2 MB/match raw; JSON of this shape compresses ~10:1, so ~200 KB/match. At ~2,500 matches/season across nine competitions that is roughly **4.5 GB/season**. | This is the tier ESPN deletes. R2 has **zero egress** and is already in the stack. Keeping the bytes is what makes every future parser improvement a re-process instead of an impossibility. |
| **Analysable events** | Postgres `match_play` | ~180 rows/match → roughly **4 M rows/season**, order 600 MB. | Shots, goals, saves, assists, cards, subs, offsides, fouls and set pieces — the rows a shot map, an xG model, a game log and a recap actually read. |
| **Touch events** (pass, ball touch, tackle, take-on, aerial, clear, dispossessed, blocked pass, cross, attempted tackle, interception, out) | **R2 only** | The remaining ~1,350/match | Storing them in Postgres is ~35 M rows and ~5 GB per season of billed Neon storage to serve pass networks and heat maps — and the roadmap explicitly rejects heat maps, on the grounds that "it describes a match; it does not explain one". Keep the bytes, skip the rows, promote later if a real feature needs them. |

The split has a pleasing property worth stating: **the Postgres tier is almost exactly the
tier ESPN itself retains**, and R2 holds the tier it discards. If R2 were ever lost, we
would still hold what ESPN would still give us.

### Two R2 buckets, and why the existing client cannot serve both

`backend/shared/assets/r2.go` today assumes **one** bucket that is **public**. Its
`FromEnv` requires `R2_PUBLIC_BASE_URL` to be set, and `New` rejects anything that is not a
plain HTTPS origin. That is correct for what it does — mirror crests to a CDN — and wrong
for what this plan needs.

| | Public assets bucket | Private raw archive |
|---|---|---|
| Env | `R2_BUCKET` | `R2_RAW_BUCKET` |
| Contents | team crests, national flags, competition emblems | raw ESPN play-stream payloads |
| Public access | yes, `https://cdn.scorearc.futbol` via `R2_PUBLIC_BASE_URL` | **none** — no public access, no `r2.dev` URL, no custom domain |
| Client | `assets.Mirror` (existing) | `assets.Archive` (**new**, Task 5) |

Both share one account id, one S3 endpoint (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`)
and one API token with **Object Read & Write** scoped to both buckets. Only the bucket name
differs. Setup steps live in `docs/backend/SETUP.md` §6 and are **not** restated here.

**Do not satisfy the existing validator with a dummy URL.** A private bucket has no public
base URL *by design*, and inventing `https://example.invalid/` to get past a check would
leave a plausible-looking CDN origin in the config that a later reader would try to serve
from. Task 5 splits client construction from the public-URL concern instead.

**Never hardcode a bucket name.** The env var names the **role** (`R2_RAW_BUCKET`); the
secret names the **resource** (`scorearc-espn-historic`). That way renaming a bucket is a
`fly secrets set`, not a code change and a redeploy. There is a grep in Task 8's gate that
fails if a bucket name appears in Go source.

---

## ⚠️ Merge order and migration numbering

Adds migration **`0007_play_stream`**. Prerequisites, in order:
`feat/canonical-identity-impl` → `feat/player-identity` → T7.1 (`0004`) → T7.6 (`0005`)
→ T7.7 (`0006`).

T7.7 is a real prerequisite, not just a number: this plan resolves a play's athlete
through `player_external_ref`, which only carries ESPN athlete ids because
`WriteParticipation` put them there.

```bash
ls backend/migrations/
git show feat/canonical-identity-impl:backend/migrations/0001_init.up.sql | grep -A2 "^CREATE TABLE match ("
```

Expected: `0001` … `0006_appearance_box_score.*`, and `id             uuid PRIMARY KEY`.
If `0006` is missing, or if you still see `0003_ingester_delete_grant` /
`0004_ingester_hardening`, **stop** — the prerequisites have not merged.

> **`match_id` is `uuid` here on purpose — do not "correct" it to `text`.** On `main`
> `match.id` is `text` (the ESPN event id), so `match_id uuid REFERENCES match(id)` reads
> like a type error that cannot apply. It applies against the **post-merge** tree:
> `feat/canonical-identity-impl` re-keys `match.id` to `uuid` and rewrites
> `match_detail`, `match_external_ref` and `win_prob_snapshot` to match, and
> `feat/player-identity` adds `appearance`/`match_event` on `uuid` too. Changing these
> tables to `text` would apply today and break the day canonical identity lands. The
> provider's event id is not lost — it lives in `match_external_ref`, which is what the
> crosswalk is for, and this plan's archive key deliberately uses it. Full reasoning:
> `2026-08-15-ingester-standings-snapshots.md` → "Two things reviewers have already got
> wrong twice".

Numbers reserved by sibling plans: `0008_match_officials` and `0009_odds_snapshot`
(`2026-08-15-ingester-officials-and-odds.md`), `0010_leader_category`,
`0011_squad_and_season_stats`, `0012_player_bio`, `0013_match_commentary`.

---

## Global Constraints

- **Never commit or merge to `main`.** Branch for all work (`AGENTS.md`).
- TDD: failing test first, confirmed failing for the stated reason.
- Backend gate: `cd backend && go build ./... && go test -race ./... && go vet ./...`
  — **Docker must be running** (testcontainers).
- Both `.up.sql` and `.down.sql`.
- Ingester connects with the **least-privilege login, never the DB owner**:
  `POOLED_DSN`, `INGESTER_LEASE_DSN`. R2 credentials and DSNs via `fly secrets`, never in
  a file.
- **Two R2 buckets.** `R2_BUCKET` is the existing **public** CDN bucket for crests;
  `R2_RAW_BUCKET` is the **private** archive bucket this plan writes to. One account, one
  API token with Object Read & Write scoped to both, one S3 endpoint — only the bucket name
  differs. Setup: `docs/backend/SETUP.md` §6.
- **Never hardcode a bucket name** in Go, in a `fly.toml`, or in a step of this plan. The
  env var names the role; the secret names the resource.
- **Never resolve a `$ref` by fetching it.** See Task 3 — this is the single most
  important implementation constraint in the plan.
- `match_play` is append-and-correct, not append-only: a play can be revised upstream
  (`modified` moves), so `INSERT … ON CONFLICT DO UPDATE`, but **no `DELETE` grant**.
- Conventional commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `backend/cmd/play-retention/main.go` — the retention probe (Task 1). A throwaway
  measurement tool, kept because the answer expires.
- `backend/migrations/0007_play_stream.up.sql` / `.down.sql`
- `backend/migrations/migrations_test.go` — new cases.
- `backend/shared/espn/core.go` — the core-host URL builders and `$ref` id parsing.
- `backend/shared/espn/plays.go` — `MapPlays`.
- `backend/shared/espn/plays_test.go`
- `backend/shared/espn/testdata/espn-plays.json` — recorded page 1.
- `backend/shared/espn/testdata/espn-plays-pruned.json` — recorded old match.
- `backend/shared/model/plays.go` — `Play`, `PlayCoordinates`, `PlayStream`.
- `backend/shared/source/espn.go` — `Plays(...)` on the `Source` interface.
- `backend/shared/assets/r2.go` — split client construction from the public-URL concern.
- `backend/shared/assets/archive.go` — the **private raw bucket** client. New file.
- `backend/shared/assets/archive_test.go`
- `backend/shared/store/plays.go` — `WritePlays`, `RecordPlayArchive`, `MatchesMissingPlays`.
- `backend/shared/store/plays_integration_test.go`
- `backend/ingester/contracts.go`, `backend/ingester/matches.go`, `backend/ingester/plays.go`
- `backend/ingester/runner_test.go`
- `docs/backend/ARCHITECTURE.md`

---

### Task 1: Measure the retention window before designing an SLA around a guess

**Files:**
- Create: `backend/cmd/play-retention/main.go`

The boundary has now been measured (see correction 3 above): it is the **season**, not an
age. Current-season matches are intact at 30 days; previous-season matches are pruned
regardless of how recently they were played.

**So why keep the probe?** Because that measurement is a single sweep across two
competitions on one day, and three things it cannot tell us matter:

1. **Whether the boundary is uniform across all nine competitions.** Liga MX and the
   Premier League agreed; Leagues Cup and the CONCACAF Champions Cup have different
   season shapes and were not tested at the boundary.
2. **Whether it is the season or a fixed horizon that merely looks like the season.**
   Liga MX's off-season gap (no finished matches in June) means the nearest samples
   either side of the cliff are ~10 weeks apart. A 60-day horizon and a season boundary
   are indistinguishable from that alone.
3. **Whether it moves.** This is provider behaviour, not a contract.

The probe is therefore a **standing instrument**, not a one-off: re-run it when coverage
looks wrong. It comes first for the same reason E6's T6.1 does — sampling two competitions
and generalising is how you ship an empty feature to a third.

- [ ] **Step 1: Write the probe**

Create `backend/cmd/play-retention/main.go`:

```go
// Command play-retention measures how far back ESPN keeps the touch-level tier
// of its play stream.
//
// It exists because the answer is not documented, is not stable, and expires:
// the whole ingestion SLA in T7.12 depends on it, and an SLA built on a guess
// is discovered to be wrong by a user rather than by us. Re-run it whenever
// coverage looks off.
//
//	go run ./cmd/play-retention -comp mex.1 -months 12
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

// touchTier is the vocabulary ESPN prunes. Verified 2026-08-15: event 740722
// (2025-11-30) returned 175 plays containing NONE of these, while event
// 401877018 (2026-08-15) returned 1542 containing all of them.
var touchTier = map[string]bool{
	"Pass": true, "Ball touch": true, "Tackle": true, "Take On": true,
	"Aerial": true, "Interception": true, "Dispossessed": true,
	"Blocked Pass": true, "Clear": true, "Cross": true,
	"Attempted tackle": true,
}

type probeResult struct {
	EventID   string    `json:"eventId"`
	Kickoff   time.Time `json:"kickoff"`
	AgeDays   int       `json:"ageDays"`
	Plays     int       `json:"plays"`
	TouchTier int       `json:"touchTier"`
	Coords    int       `json:"coordinates"`
}

func main() {
	comp := flag.String("comp", "mex.1", "ESPN competition slug")
	months := flag.Int("months", 12, "how far back to sample")
	flag.Parse()

	client := espn.New()
	ctx := context.Background()
	now := time.Now().UTC()

	var results []probeResult
	// One match per month back. Monthly resolution is enough to find a
	// season-boundary cliff; if the cliff turns out to be sharp, re-run with a
	// narrower window around it.
	for month := 0; month < *months; month++ {
		day := now.AddDate(0, -month, 0)
		window := day.AddDate(0, 0, -6).Format("20060102") + "-" + day.Format("20060102")
		var board struct {
			Events []struct {
				ID     string    `json:"id"`
				Date   time.Time `json:"date"`
				Status struct {
					Type struct {
						Completed bool `json:"completed"`
					} `json:"type"`
				} `json:"status"`
			} `json:"events"`
		}
		if err := client.GetJSON(ctx,
			espn.ScoreboardURLWithLimit(*comp, window, 100), &board); err != nil {
			fmt.Fprintf(os.Stderr, "scoreboard %s: %v\n", window, err)
			continue
		}
		var eventID string
		var kickoff time.Time
		for _, event := range board.Events {
			if event.Status.Type.Completed {
				eventID, kickoff = event.ID, event.Date
				break
			}
		}
		if eventID == "" {
			continue
		}

		stream, err := espn.FetchPlaysPage(ctx, client, *comp, eventID, 1)
		if err != nil {
			fmt.Fprintf(os.Stderr, "plays %s: %v\n", eventID, err)
			continue
		}
		result := probeResult{
			EventID: eventID, Kickoff: kickoff,
			AgeDays: int(now.Sub(kickoff).Hours() / 24),
			Plays:   stream.Total,
		}
		for _, play := range stream.Plays {
			if touchTier[play.TypeText] {
				result.TouchTier++
			}
			if play.Coordinates != nil {
				result.Coords++
			}
		}
		results = append(results, result)
	}

	sort.Slice(results, func(i, j int) bool { return results[i].AgeDays < results[j].AgeDays })
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(results)
}
```

`espn.FetchPlaysPage` and the model types arrive in Tasks 2–4; write the probe now so the
question it answers is framed before the schema is, but **run it in Step 2 of Task 5**,
once those exist. If you prefer to run it earlier, a one-off `curl | node` reproducing the
same counts is acceptable evidence — the requirement is the number, not the tool.

- [ ] **Step 2: Commit**

```bash
git add backend/cmd/play-retention/main.go
git commit -m "feat: add a probe for ESPN's play-stream retention window

The touch tier is pruned for older matches -- verified, event 740722
(2025-11-30) returns 175 plays with zero Pass/Ball touch/Tackle, while
401877018 (2026-08-15) returns 1542 with all of them -- but the window is
undocumented and unmeasured.

Every downstream decision (ingest cadence, whether a backfill is worth
writing, what we claim about historical coverage) depends on that number,
and an SLA built on a guess gets discovered by a user.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `match_play` table and the archive ledger

**Files:**
- Create: `backend/migrations/0007_play_stream.up.sql` / `.down.sql`
- Test: `backend/migrations/migrations_test.go`

- [ ] **Step 1: Write the failing migration test**

Append to `backend/migrations/migrations_test.go`:

```go
// The play stream is keyed on ESPN's own play id, not on an ordinal. A live
// match is re-fetched every 20s and plays are appended mid-match; an ordinal
// key would renumber on any insertion upstream and rewrite the wrong rows.
func TestPlayStreamKeysOnTheProviderPlayID(t *testing.T) {
	sql := readMigration(t, "0007_play_stream.up.sql")
	for _, required := range []string{
		"CREATE TABLE match_play",
		"PRIMARY KEY (match_id, source_id)",
		"start_x numeric(5,2)",
		"goal_z  numeric(5,2)",
		"CREATE TABLE match_play_archive",
		"touch_tier bool",
		"GRANT SELECT ON match_play, match_play_archive TO scorearc_reader",
		"GRANT SELECT, INSERT, UPDATE ON match_play, match_play_archive TO scorearc_ingester",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("0007_play_stream.up.sql missing %q", required)
		}
	}
	// Coordinates are the reason this table exists at all. A NOT NULL default
	// would put every unlocated play at the corner flag.
	if strings.Contains(sql, "start_x numeric(5,2) NOT NULL") {
		t.Fatal("coordinates must be nullable")
	}
	// A play retracted upstream is vanishingly rare and a DELETE grant here
	// would let a bug erase a stream ESPN will not serve again.
	if strings.Contains(sql, "GRANT DELETE ON match_play") {
		t.Fatal("match_play must not be deletable by the ingester")
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./migrations/ -run PlayStream
```

Expected: FAIL — `open 0007_play_stream.up.sql: no such file or directory`.

- [ ] **Step 3: Write the up migration**

Create `backend/migrations/0007_play_stream.up.sql`:

```sql
-- The analysable tier of ESPN's touch-level play stream.
--
-- Source: sports.core.api.espn.com (the CORE host, not the site host every
-- other mapper uses):
--   /v2/sports/soccer/leagues/{slug}/events/{id}/competitions/{id}/plays
--
-- WHAT IS AND IS NOT HERE. A match returns ~1,540 plays. This table takes the
-- ~180 that a shot map, an xG model, a game log or a recap actually reads --
-- shots, goals, saves, assists, cards, subs, offsides, fouls, set pieces. The
-- remaining ~1,350 touch events (pass, ball touch, tackle, take-on, aerial,
-- clear, cross, dispossessed, interception, blocked pass, out) are archived to
-- R2 in full and deliberately NOT rowed here: ~35M rows and ~5GB of billed
-- storage per season to serve pass networks and heat maps, and the roadmap
-- rejects heat maps on the grounds that they describe a match without
-- explaining one. The bytes are kept; promoting them to rows later is a
-- re-process, which is only possible because they were kept.
--
-- ESPN PRUNES THE TOUCH TIER AT THE SEASON BOUNDARY. Verified 2026-08-15: a
-- 30-day-old CURRENT-season match (401877043, 2026-07-17) returns 1491 plays
-- including 610 passes on a 0-100 coordinate scale with goal-mouth placement;
-- a PREVIOUS-season match (401870615, 2026-05-10) returns 199 plays with ZERO
-- passes, coordinates on a 0-1 scale, and goalPositionY/Z entirely zeroed.
-- Same result for eng.1, usa.1 and concacaf.champions.
--
-- So this table backfills further than a pass network does -- prior-season
-- SHOTS survive -- but NOT on comparable terms: their coordinates are in a
-- different, apparently inverted frame with no goal-mouth placement. Nothing
-- downstream may mix eras until E9's T9.1 reports whether the frames can be
-- reconciled. Task 7's backfill is scoped to the current season only.
CREATE TABLE match_play (
  match_id  uuid NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  -- ESPN's own play id. Keyed on it rather than on an ordinal because a live
  -- match is re-fetched every 20s and plays arrive mid-match: an ordinal key
  -- renumbers on any upstream insertion and rewrites the wrong rows, which is
  -- exactly the failure the `seq` key in 0003_player_capture avoids by being
  -- rewritten wholesale each time. This stream is too large to rewrite
  -- wholesale, so it gets a real key instead.
  source_id text NOT NULL,
  -- Provider order, for replay. Not the key.
  seq       int  NOT NULL,

  type_id   text NOT NULL,
  type_key  text NOT NULL,   -- type.type, machine value, e.g. 'shot-blocked'
  type_text text NOT NULL,   -- type.text, English display, e.g. 'Shot Blocked'

  -- Resolved from the $ref URLs by parsing the trailing id, NEVER by fetching
  -- them: a match carries ~1,500 plays with two or three refs each, so
  -- resolving by request is 4,500 round trips per match. Nullable because a
  -- play can name a team or athlete we have not ingested, and an unattributed
  -- play that happened beats a dropped one.
  team_id   text REFERENCES team(id),
  player_id uuid REFERENCES player(id) ON DELETE SET NULL,

  period        int,
  clock_value   int,
  clock_display text NOT NULL DEFAULT '',
  wallclock     timestamptz,

  home_score   int,
  away_score   int,
  scoring_play bool NOT NULL DEFAULT false,
  score_value  int,

  own_goal     bool NOT NULL DEFAULT false,
  penalty_kick bool NOT NULL DEFAULT false,
  yellow_card  bool NOT NULL DEFAULT false,
  red_card     bool NOT NULL DEFAULT false,
  substitution bool NOT NULL DEFAULT false,
  shootout     bool NOT NULL DEFAULT false,

  -- Pitch coordinates, 0-100 on each axis. These EXIST, contrary to the
  -- product roadmap's "no pass or touch coordinates exist in any response we
  -- can reach" -- verified 2026-08-15, 546 of 567 sampled plays carried
  -- non-zero values. start_* is where the action began, end_* where it
  -- finished, and goal_* is placement within the goal mouth on a shot
  -- (goalPositionY/Z; there is no meaningful goalPositionX).
  --
  -- Nullable, and (0,0) from the provider is stored as NULL: ESPN sends 0 as
  -- its unset sentinel -- the kickoff play carries 0/0 while a real pass
  -- carries 50/50 -- and writing 0 would put every unlocated play on the
  -- corner flag, which an xG model would then treat as a measurement.
  start_x numeric(5,2), start_y numeric(5,2),
  end_x   numeric(5,2), end_y   numeric(5,2),
  goal_y  numeric(5,2), goal_z  numeric(5,2),

  text text NOT NULL DEFAULT '',
  PRIMARY KEY (match_id, source_id)
);

CREATE INDEX match_play_order_idx  ON match_play (match_id, seq);
CREATE INDEX match_play_player_idx ON match_play (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX match_play_type_idx   ON match_play (type_key);
-- The shot-map query: every located shot in a match, or for a player.
CREATE INDEX match_play_located_idx
  ON match_play (match_id, type_key)
  WHERE start_x IS NOT NULL;

-- What is in R2, so a backfill knows what it still owes and a re-process knows
-- what it can read. One row per match, not per object.
CREATE TABLE match_play_archive (
  match_id    uuid PRIMARY KEY REFERENCES match(id) ON DELETE CASCADE,
  object_key  text NOT NULL,
  plays       int  NOT NULL,
  bytes       int  NOT NULL,
  -- Whether the archived payload contained the touch tier. False means we
  -- reached this match after ESPN pruned it, and no future re-process of this
  -- object will ever produce a pass network. Recording it is what stops a
  -- later agent concluding the parser is broken.
  touch_tier  bool NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_play_archive_touch_idx ON match_play_archive (touch_tier);

GRANT SELECT ON match_play, match_play_archive TO scorearc_reader;
GRANT SELECT, INSERT, UPDATE ON match_play, match_play_archive TO scorearc_ingester;
-- No DELETE. A play retracted upstream is vanishingly rare, and the cost of
-- being wrong about that is a stream ESPN will not serve again.
```

- [ ] **Step 4: Write the down migration**

Create `backend/migrations/0007_play_stream.down.sql`:

```sql
DROP TABLE IF EXISTS match_play_archive;
DROP TABLE IF EXISTS match_play;
```

Unlike the snapshot rollbacks, dropping here is correct: these tables are created whole by
this migration, and the R2 objects — the part that cannot be re-fetched — are untouched by
a Postgres rollback.

- [ ] **Step 5: Run and prove it applies**

```bash
cd backend && go test ./migrations/ && go test ./shared/store/ -run TestResolveTeamHitsTheCrosswalk
```

Expected: both `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0007_play_stream.up.sql \
        backend/migrations/0007_play_stream.down.sql \
        backend/migrations/migrations_test.go
git commit -m "feat: add match_play and the R2 archive ledger

The analysable tier of ESPN's touch-level stream -- ~180 rows a match of
the ~1,540 available. The other ~1,350 touch events are archived to R2 in
full and deliberately not rowed: ~35M rows and ~5GB of billed storage per
season to serve heat maps the roadmap rejects.

Keyed on ESPN's play id rather than an ordinal: a live match is re-fetched
every 20s and an ordinal key renumbers on upstream insertion.

Coordinates are nullable and (0,0) is stored as NULL -- ESPN uses 0 as its
unset sentinel, and writing it would put every unlocated play on the
corner flag.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The core host, pagination, and `$ref` id parsing

**Files:**
- Create: `backend/shared/espn/core.go`
- Test: `backend/shared/espn/core_test.go`

**Interfaces:**
- `func CorePlaysURL(slug, eventID string, page, limit int) string`
- `func RefID(ref string) string` — the trailing numeric id of a core `$ref`, or `""`.

> **This task contains the single most important constraint in the plan.**
> `team`, `participants[].athlete` and `participants[].position` on a play are **`$ref`
> URLs, not embedded objects**. A match has ~1,500 plays carrying two or three refs each.
> Resolving them by fetching is **~4,500 HTTP requests per match**, against a keyless
> public API, nine competitions at a time. It would get us rate-limited within one cycle
> and would take longer than the match. The id is in the URL; parse it.

- [ ] **Step 1: Write the failing test**

Create `backend/shared/espn/core_test.go`:

```go
package espn

import "testing"

func TestCorePlaysURL(t *testing.T) {
	// The core host is NOT the site host every other builder in this package
	// uses, and the event id appears twice: once as the event and once as the
	// competition. For soccer they are the same value; hard-coding one of them
	// would break the first time they are not.
	got := CorePlaysURL("mex.1", "401877018", 1, 1000)
	want := "http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1" +
		"/events/401877018/competitions/401877018/plays?limit=1000&page=1"
	if got != want {
		t.Fatalf("CorePlaysURL =\n%s\nwant\n%s", got, want)
	}
}

// Verified 2026-08-15: limit=1000 returns pageSize=1000, and limit=1001 returns
// pageSize=25 with NO error. Silently making 62 requests instead of 2 is worse
// than refusing, so the builder clamps.
func TestCorePlaysURLClampsToTheProviderCap(t *testing.T) {
	for _, limit := range []int{1001, 2000, 0, -1} {
		got := CorePlaysURL("mex.1", "1", 1, limit)
		if !strings.Contains(got, "limit=1000") {
			t.Fatalf("limit=%d produced %q, want it clamped to 1000", limit, got)
		}
	}
}

func TestCorePlaysURLEncodesItsInputs(t *testing.T) {
	if got := CorePlaysURL("mex.1", "../../secret", 1, 100); strings.Contains(got, "../") {
		t.Fatalf("CorePlaysURL = %q, want the event id encoded", got)
	}
}

// The whole point: a play's team/athlete/position arrive as $ref URLs, and a
// match has ~1,500 plays with two or three each. Fetching them is ~4,500
// requests per match against a keyless API. The id is in the URL.
func TestRefIDParsesWithoutFetching(t *testing.T) {
	cases := map[string]string{
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/seasons/2026/teams/223?lang=en&region=us":    "223",
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/seasons/2026/athletes/295847?lang=en":        "295847",
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/positions/20?lang=en&region=us":              "20",
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/events/401877018/competitions/401877018/plays/50929858?lang=en": "50929858",
	}
	for ref, want := range cases {
		if got := RefID(ref); got != want {
			t.Fatalf("RefID(%q) = %q, want %q", ref, got, want)
		}
	}
	// A ref shape we have not seen must yield "" so the caller stores NULL,
	// rather than yielding a fragment that resolves to the wrong entity.
	for _, bad := range []string{"", "not a url", "http://example.com/teams/", "http://example.com/teams/abc"} {
		if got := RefID(bad); got != "" {
			t.Fatalf("RefID(%q) = %q, want empty", bad, got)
		}
	}
}
```

Add `"strings"` to the imports.

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/espn/ -run "CorePlaysURL|RefID"
```

Expected: FAIL to compile — `undefined: CorePlaysURL` and `undefined: RefID`.

- [ ] **Step 3: Implement**

Create `backend/shared/espn/core.go`:

```go
package espn

import (
	"fmt"
	"net/url"
	"regexp"
)

// core is ESPN's "core" API host. It is a DIFFERENT host from `site` at the
// top of client.go, serves a different shape, and is the only place the
// touch-level play stream, the officials list and the full odds ladder live.
const core = "http://sports.core.api.espn.com/v2/sports/soccer/leagues"

// corePlayPageLimit is the provider's real page cap.
//
// Verified 2026-08-15 against mex.1 event 401877018 (1,542 plays):
//
//	limit=100  -> pageSize=100,  pageCount=16
//	limit=400  -> pageSize=400,  pageCount=4
//	limit=1000 -> pageSize=1000, pageCount=2
//	limit=1001 -> pageSize=25,   pageCount=62   <-- silent fallback, no error
//	limit=2000 -> pageSize=25,   pageCount=62
//
// Asking for more than 1000 does not fail, it quietly returns the default page
// size, turning a two-request fetch into a sixty-two-request one with nothing
// in the logs. Clamp here, and assert the returned pageSize at the call site.
const corePlayPageLimit = 1000

// CorePlaysURL builds one page of a match's play stream.
//
// The event id appears twice, as the event and as the competition. In soccer
// they are always the same value, but the path distinguishes them and
// collapsing that here would break the first time they diverge.
func CorePlaysURL(slug, eventID string, page, limit int) string {
	if limit <= 0 || limit > corePlayPageLimit {
		limit = corePlayPageLimit
	}
	if page < 1 {
		page = 1
	}
	event := url.PathEscape(eventID)
	return fmt.Sprintf("%s/%s/events/%s/competitions/%s/plays?limit=%d&page=%d",
		core, url.PathEscape(slug), event, event, limit, page)
}

// refIDRe pulls the last path segment before the query string, requiring it to
// be numeric. Numeric on purpose: a non-numeric tail is a ref shape we have not
// seen, and returning it would attribute a play to whatever entity happened to
// match that string.
var refIDRe = regexp.MustCompile(`/(\d+)(?:\?|$)`)

// RefID returns the entity id embedded in a core-API $ref URL.
//
// This function is why the play stream is affordable. A play's team, athlete
// and position arrive as $ref URLs rather than embedded objects:
//
//	"team": {"$ref": ".../seasons/2026/teams/223?lang=en&region=us"}
//
// A match carries ~1,500 plays with two or three refs each. Resolving them by
// following the URL is ~4,500 HTTP requests per match, against a keyless
// public API, for nine competitions concurrently -- rate-limited inside one
// cycle, and slower than the match it is describing.
//
// So: NEVER FETCH A $ref. Parse the id, and resolve it against the team and
// player crosswalks the ingester has already populated from the summary
// payloads.
func RefID(ref string) string {
	match := refIDRe.FindStringSubmatch(ref)
	if match == nil {
		return ""
	}
	return match[1]
}
```

- [ ] **Step 4: Run**

```bash
cd backend && go test ./shared/espn/ -run "CorePlaysURL|RefID" -v
```

Expected: four `--- PASS` lines.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/espn/core.go backend/shared/espn/core_test.go
git commit -m "feat: add the ESPN core-host URL builder and \$ref id parsing

RefID is what makes the play stream affordable. A play's team, athlete and
position arrive as \$ref URLs, and a match has ~1,500 plays with two or
three each -- resolving them by fetching is ~4,500 requests per match
against a keyless API, for nine competitions at once.

The page limit clamps at 1000 because limit=1001 does not error, it
silently returns pageSize=25 and pageCount=62. Verified against mex.1
event 401877018.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Record the fixtures and map the stream

**Files:**
- Create: `backend/shared/espn/testdata/espn-plays.json`,
  `backend/shared/espn/testdata/espn-plays-pruned.json`
- Create: `backend/shared/model/plays.go`, `backend/shared/espn/plays.go`,
  `backend/shared/espn/plays_test.go`

- [ ] **Step 1: Record both fixtures**

Two matches, deliberately: a fresh one with the full stream and a pruned one, so the
mapper is tested against both worlds it will actually meet.

```bash
cd backend
B="http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1"
curl -s "$B/events/401877018/competitions/401877018/plays?limit=1000&page=1" \
  -o shared/espn/testdata/espn-plays.json
curl -s "$B/events/740722/competitions/740722/plays?limit=1000&page=1" \
  -o shared/espn/testdata/espn-plays-pruned.json
```

- [ ] **Step 2: Verify they captured the two worlds**

```bash
cd backend && node -e "
for (const [label, file] of [['FRESH','espn-plays.json'], ['PRUNED','espn-plays-pruned.json']]) {
  const d = require('./shared/espn/testdata/' + file);
  const t = {}; for (const p of d.items) t[p.type.text] = (t[p.type.text]||0)+1;
  const coords = d.items.filter(p => p.fieldPositionX || p.fieldPositionY).length;
  console.log(label, 'count=' + d.count, 'pageSize=' + d.pageSize, 'pageCount=' + d.pageCount,
              'items=' + d.items.length, 'withCoords=' + coords);
  console.log('  Pass=' + (t['Pass']||0), 'Ball touch=' + (t['Ball touch']||0),
              'Tackle=' + (t['Tackle']||0), 'Shot On Target=' + (t['Shot On Target']||0));
  const shot = d.items.find(p => p.type.text === 'Shot On Target');
  if (shot) console.log('  shot coords:', shot.fieldPositionX, shot.fieldPositionY,
                        '->', shot.fieldPosition2X, shot.fieldPosition2Y,
                        '| goal', shot.goalPositionY, shot.goalPositionZ);
  console.log('  team is a \$ref:', !!(d.items.find(p=>p.team)||{}).team?.\$ref);
}
"
```

Expected, and read it carefully — it is the evidence the whole plan rests on:

```
FRESH count=1542 pageSize=1000 pageCount=2 items=1000 withCoords=~960
  Pass=… Ball touch=… Tackle=… Shot On Target=…
  shot coords: 77.2 25 -> 97.5 47.5 | goal 51.2 5.1
  team is a $ref: true
PRUNED count=175 pageSize=1000 pageCount=1 items=175 withCoords=149
  Pass=0 Ball touch=0 Tackle=0 Shot On Target=2
  shot coords: …
  team is a $ref: true
```

Three things must hold. `pageCount=2` on the fresh match proves **pagination is
mandatory**. `Pass=0 Tackle=0` on the pruned match with `Shot On Target=2` proves **the
touch tier is what ESPN deletes and the key-event tier is not**. `withCoords=149` on the
pruned match proves **coordinates survive pruning** — which is why the roadmap's "no
coordinates exist" line has to be corrected rather than worked around.

- [ ] **Step 3: Write the failing mapper test**

Create `backend/shared/espn/plays_test.go`:

```go
package espn

import (
	"os"
	"testing"
)

func loadPlays(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// pageCount is why this cannot be a single request. A fresh match is 1,542
// plays at a hard cap of 1,000 per page.
func TestMapPlaysReportsPagination(t *testing.T) {
	stream, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	if stream.Total != 1542 {
		t.Fatalf("Total = %d, want 1542", stream.Total)
	}
	if stream.PageCount != 2 {
		t.Fatalf("PageCount = %d, want 2 -- a single-request fetch would silently lose 542 plays",
			stream.PageCount)
	}
	if stream.PageSize != 1000 {
		t.Fatalf("PageSize = %d, want 1000 -- the provider silently degrades to 25 above its cap",
			stream.PageSize)
	}
	if len(stream.Plays) != 1000 {
		t.Fatalf("plays = %d, want 1000", len(stream.Plays))
	}
}

// The constraint. Refs are parsed, never fetched.
func TestMapPlaysResolvesRefsByParsing(t *testing.T) {
	stream, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	var withTeam, withAthlete int
	for _, play := range stream.Plays {
		if play.TeamSourceID != "" {
			withTeam++
		}
		if play.PlayerSourceID != "" {
			withAthlete++
		}
	}
	if withTeam == 0 {
		t.Fatal("no play carried a team id; the $ref was not parsed")
	}
	if withAthlete == 0 {
		t.Fatal("no play carried an athlete id; the participant $ref was not parsed")
	}
}

// Coordinates exist. This test is the standing refutation of the roadmap's
// "no pass or touch coordinates exist in any response we can reach".
func TestMapPlaysCarriesPitchCoordinates(t *testing.T) {
	stream, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	var located, shotsWithGoalMouth int
	for _, play := range stream.Plays {
		if play.Coordinates != nil {
			located++
			if play.Coordinates.GoalY != nil && play.Coordinates.GoalZ != nil {
				shotsWithGoalMouth++
			}
		}
	}
	if located < len(stream.Plays)/2 {
		t.Fatalf("located = %d of %d; the fixture had over 90%% coordinate coverage",
			located, len(stream.Plays))
	}
	if shotsWithGoalMouth == 0 {
		t.Fatal("no play carried goalPositionY/Z; shot placement was dropped")
	}
}

// ESPN sends 0 as its unset sentinel -- the kickoff play is 0/0 while a real
// pass is 50/50. Storing 0 would put every unlocated play on the corner flag,
// and an xG model would read that as a measurement.
func TestMapPlaysTreatsZeroZeroAsUnlocated(t *testing.T) {
	raw := []byte(`{"count":1,"pageIndex":1,"pageSize":1000,"pageCount":1,"items":[
	  {"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"},
	   "period":{"number":1},"clock":{"value":0,"displayValue":""},
	   "fieldPositionX":0,"fieldPositionY":0}]}`)
	stream, err := MapPlays(raw)
	if err != nil {
		t.Fatal(err)
	}
	if stream.Plays[0].Coordinates != nil {
		t.Fatalf("Coordinates = %#v for a 0/0 play, want nil", stream.Plays[0].Coordinates)
	}
}

// The pruned world. The mapper must handle it without complaint -- it is not
// an error, it is a nine-month-old match -- and the caller needs to be able to
// tell the two apart, which is what HasTouchTier is for.
func TestMapPlaysDetectsAPrunedStream(t *testing.T) {
	fresh, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	pruned, err := MapPlays(loadPlays(t, "espn-plays-pruned.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !fresh.HasTouchTier() {
		t.Fatal("the fresh fixture must report a touch tier")
	}
	if pruned.HasTouchTier() {
		t.Fatal("the pruned fixture must not report a touch tier")
	}
	// But its shots and their coordinates are still there -- which is why a
	// shot map backfills further than a pass network does, though NOT on
	// comparable terms: a pruned match's coordinates are on a 0-1 scale with
	// goal-mouth placement zeroed, so they cannot be plotted or trained on
	// alongside current-season shots until the frames are reconciled.
	var located int
	for _, play := range pruned.Plays {
		if play.Coordinates != nil {
			located++
		}
	}
	if located == 0 {
		t.Fatal("the pruned fixture lost its coordinates; it should not have")
	}
}

// The Postgres/R2 split, expressed as one predicate in one place.
func TestAnalysablePlaysAreTheKeyEventTier(t *testing.T) {
	for _, key := range []string{
		"goal", "own-goal", "shot-on-target", "shot-off-target", "shot-blocked",
		"save", "assist", "yellow-card", "red-card", "substitution",
		"offside", "foul", "corner-awarded", "free-kick", "penalty-kick",
	} {
		if !Analysable(Play{TypeKey: key}) {
			t.Fatalf("%q must be stored in Postgres", key)
		}
	}
	for _, key := range []string{
		"pass", "ball-touch", "tackle", "take-on", "aerial", "clear",
		"cross", "dispossessed", "interception", "blocked-pass", "out",
	} {
		if Analysable(Play{TypeKey: key}) {
			t.Fatalf("%q is touch tier and must stay in R2 only", key)
		}
	}
	// A type we have never seen is kept. An unknown key is far more likely to
	// be a new key event than a new kind of touch, and the cost of being wrong
	// is a few extra rows rather than a silently missing feature.
	if !Analysable(Play{TypeKey: "var-decision"}) {
		t.Fatal("an unrecognised type must default to stored, not dropped")
	}
	// Unless it is scoring, in which case there is no question at all.
	if !Analysable(Play{TypeKey: "pass", ScoringPlay: true}) {
		t.Fatal("a scoring play must be stored whatever its type")
	}
}
```

- [ ] **Step 4: Run and watch it fail**

```bash
cd backend && go test ./shared/espn/ -run MapPlays
```

Expected: FAIL to compile — `undefined: MapPlays`.

- [ ] **Step 5: Add the model**

Create `backend/shared/model/plays.go`:

```go
package model

import "time"

// Types in this file are INGESTER-INTERNAL, like participation.go: they are
// never serialized into match_detail's jsonb and never reach the reader, so
// they carry no json tags and adding a field here cannot change an API
// response.
//
// They stay in PROVIDER shape -- TeamSourceID, not a canonical id. Resolution
// belongs to the ingester, where the Store lives.

// PlayCoordinates is where on the pitch something happened.
//
// These EXIST. The product roadmap records, under "Not building, and why",
// that "no pass or touch coordinates exist in any response we can reach" --
// that is true of the SITE host and false of the CORE host. Verified
// 2026-08-15 on mex.1 event 401877018: 546 of 567 sampled plays carried
// non-zero values, and shots additionally carry placement within the goal
// mouth. An xG model needs shot location; shot location is here.
//
// Axes run 0-100. Start is where the action began, End where it finished.
// GoalY/GoalZ are the goal-mouth placement of a shot (there is no meaningful
// goalPositionX). Every field is a pointer because a play can be located
// without having a destination, and a shot without having been on frame.
type PlayCoordinates struct {
	StartX, StartY *float64
	EndX, EndY     *float64
	GoalY, GoalZ   *float64
}

// Play is one event in a match's touch-level stream.
type Play struct {
	SourceID string // ESPN's play id -- stable, and the key we store on
	Seq      int    // provider order, for replay

	TypeID   string
	TypeKey  string // type.type, the machine value: "shot-blocked"
	TypeText string // type.text, English display: "Shot Blocked"

	// Parsed out of the $ref URLs, NEVER fetched. See espn.RefID.
	TeamSourceID   string
	PlayerSourceID string

	Period       int
	ClockValue   int
	ClockDisplay string
	Wallclock    *time.Time

	HomeScore   *int
	AwayScore   *int
	ScoringPlay bool
	ScoreValue  *int

	OwnGoal      bool
	PenaltyKick  bool
	YellowCard   bool
	RedCard      bool
	Substitution bool
	Shootout     bool

	// nil when the provider located nothing, which includes the (0,0) it uses
	// as an unset sentinel.
	Coordinates *PlayCoordinates

	Text string
}

// PlayStream is one page of a match's plays plus the pagination the caller
// needs in order to know it is not done.
type PlayStream struct {
	Total     int
	PageIndex int
	PageSize  int
	PageCount int
	Plays     []Play
}

// touchTierKeys are the play types ESPN prunes for older matches. Verified
// 2026-08-15: event 740722 (2025-11-30) returned 175 plays containing none of
// these; event 401877018 (2026-08-15) returned 1542 containing all of them.
var touchTierKeys = map[string]bool{
	"pass": true, "ball-touch": true, "tackle": true, "take-on": true,
	"aerial": true, "clear": true, "cross": true, "dispossessed": true,
	"interception": true, "blocked-pass": true, "out": true,
	"attempted-tackle": true,
}

// HasTouchTier reports whether this stream still contains the perishable tier.
//
// The caller records the answer against the archive, because "this object will
// never yield a pass network" is a fact about the object that a later
// re-processing run cannot re-derive -- it would just see an empty result and
// conclude the parser is broken.
func (s PlayStream) HasTouchTier() bool {
	for _, play := range s.Plays {
		if touchTierKeys[play.TypeKey] {
			return true
		}
	}
	return false
}
```

- [ ] **Step 6: Write the mapper**

Create `backend/shared/espn/plays.go`:

```go
package espn

import (
	"encoding/json"
	"time"
)

type rawPlayPage struct {
	Count     int       `json:"count"`
	PageIndex int       `json:"pageIndex"`
	PageSize  int       `json:"pageSize"`
	PageCount int       `json:"pageCount"`
	Items     []rawPlay `json:"items"`
}

type rawPlay struct {
	ID   string      `json:"id"`
	Type rawPlayType `json:"type"`
	Text string      `json:"text"`

	// $ref-bearing objects. We read the ref STRING and parse it; we never
	// follow it. See RefID for the arithmetic on why.
	Team         *rawRef            `json:"team"`
	Participants []rawPlayParticipant `json:"participants"`

	Period rawPeriod `json:"period"`
	Clock  rawClock  `json:"clock"`

	HomeScore   *int   `json:"homeScore"`
	AwayScore   *int   `json:"awayScore"`
	ScoringPlay bool   `json:"scoringPlay"`
	ScoreValue  *int   `json:"scoreValue"`
	Wallclock   string `json:"wallclock"`

	OwnGoal      bool `json:"ownGoal"`
	PenaltyKick  bool `json:"penaltyKick"`
	YellowCard   bool `json:"yellowCard"`
	RedCard      bool `json:"redCard"`
	Substitution bool `json:"substitution"`
	Shootout     bool `json:"shootout"`

	FieldPositionX  *float64 `json:"fieldPositionX"`
	FieldPositionY  *float64 `json:"fieldPositionY"`
	FieldPosition2X *float64 `json:"fieldPosition2X"`
	FieldPosition2Y *float64 `json:"fieldPosition2Y"`
	GoalPositionY   *float64 `json:"goalPositionY"`
	GoalPositionZ   *float64 `json:"goalPositionZ"`
}

type rawPlayType struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Type string `json:"type"`
}

type rawPeriod struct {
	Number int `json:"number"`
}

type rawRef struct {
	Ref string `json:"$ref"`
}

type rawPlayParticipant struct {
	Athlete rawRef `json:"athlete"`
	Order   int    `json:"order"`
	Type    string `json:"type"`
}

// MapPlays turns one page of the core API's play stream into domain Plays.
//
// It does NOT fetch anything. Every id it produces is parsed out of a $ref
// string already in the payload.
func MapPlays(raw []byte) (model.PlayStream, error) {
	var page rawPlayPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return model.PlayStream{}, err
	}
	stream := model.PlayStream{
		Total:     page.Count,
		PageIndex: page.PageIndex,
		PageSize:  page.PageSize,
		PageCount: page.PageCount,
		Plays:     make([]model.Play, 0, len(page.Items)),
	}
	// Provider order is the match's order. The ordinal is offset by the page
	// so page two continues page one rather than restarting.
	base := (page.PageIndex - 1) * page.PageSize
	for index, item := range page.Items {
		play := model.Play{
			SourceID:     item.ID,
			Seq:          base + index,
			TypeID:       item.Type.ID,
			TypeKey:      item.Type.Type,
			TypeText:     item.Type.Text,
			Period:       item.Period.Number,
			ClockValue:   int(item.Clock.Value),
			ClockDisplay: item.Clock.DisplayValue,
			HomeScore:    item.HomeScore,
			AwayScore:    item.AwayScore,
			ScoringPlay:  item.ScoringPlay,
			ScoreValue:   item.ScoreValue,
			OwnGoal:      item.OwnGoal,
			PenaltyKick:  item.PenaltyKick,
			YellowCard:   item.YellowCard,
			RedCard:      item.RedCard,
			Substitution: item.Substitution,
			Shootout:     item.Shootout,
			Text:         item.Text,
			Coordinates:  mapPlayCoordinates(item),
		}
		if item.Team != nil {
			play.TeamSourceID = RefID(item.Team.Ref)
		}
		// participants[0] is the primary actor -- the passer, the shooter, the
		// fouler. Later entries are the receiver or the fouled player and are
		// deliberately not stored: one player-action per row is the same rule
		// match_event already follows, and a second column would make "how many
		// shots has this player taken" ambiguous.
		if len(item.Participants) > 0 {
			play.PlayerSourceID = RefID(item.Participants[0].Athlete.Ref)
		}
		if item.Wallclock != "" {
			if at, err := time.Parse(time.RFC3339, item.Wallclock); err == nil {
				play.Wallclock = &at
			}
		}
		stream.Plays = append(stream.Plays, play)
	}
	return stream, nil
}

// mapPlayCoordinates returns nil when nothing was located.
//
// ESPN uses 0 as its unset sentinel, not as the corner flag: the kickoff play
// carries fieldPositionX/Y of 0/0 while a real pass carries 50/50. Storing the
// zeros would put every unlocated play on the corner flag, and an xG model
// trained on that would treat the sentinel as a measurement.
func mapPlayCoordinates(item rawPlay) *model.PlayCoordinates {
	coordinates := &model.PlayCoordinates{
		StartX: located(item.FieldPositionX, item.FieldPositionY),
		StartY: located(item.FieldPositionY, item.FieldPositionX),
		EndX:   located(item.FieldPosition2X, item.FieldPosition2Y),
		EndY:   located(item.FieldPosition2Y, item.FieldPosition2X),
		GoalY:  nonZero(item.GoalPositionY),
		GoalZ:  nonZero(item.GoalPositionZ),
	}
	if coordinates.StartX == nil && coordinates.StartY == nil &&
		coordinates.EndX == nil && coordinates.EndY == nil &&
		coordinates.GoalY == nil && coordinates.GoalZ == nil {
		return nil
	}
	return coordinates
}

// located keeps a coordinate only when the PAIR is not the (0,0) sentinel. A
// genuine 0 on one axis -- a ball on the goal line, x=0 with y=50 -- is real
// and survives; only the pair being zero means "unset".
func located(value, partner *float64) *float64 {
	if value == nil {
		return nil
	}
	if *value == 0 && (partner == nil || *partner == 0) {
		return nil
	}
	return value
}

func nonZero(value *float64) *float64 {
	if value == nil || *value == 0 {
		return nil
	}
	return value
}

// analysableKeys is the Postgres tier. Everything else is archived to R2 and
// not rowed -- see the migration comment for the cost arithmetic.
var analysableKeys = map[string]bool{
	"goal": true, "own-goal": true, "shot-on-target": true,
	"shot-off-target": true, "shot-blocked": true, "save": true,
	"assist": true, "assists-shot": true, "yellow-card": true,
	"red-card": true, "substitution": true, "offside": true,
	"foul": true, "handball": true, "corner-awarded": true,
	"free-kick": true, "penalty-kick": true, "throw-in": true,
	"goal-kick": true, "kickoff": true, "halftime": true,
	"end-regular-time": true, "start-2nd-half": true,
}

// Analysable decides whether a play becomes a Postgres row.
//
// The default for an UNRECOGNISED type is to keep it. An unfamiliar key is far
// more likely to be a new key event (a VAR decision, a new card type) than a
// new kind of touch, and the cost of guessing wrong in that direction is a few
// hundred extra rows a season, against a silently missing feature in the
// other. Touch types are therefore listed explicitly and everything else is
// stored.
func Analysable(play model.Play) bool {
	if play.ScoringPlay || play.OwnGoal || play.YellowCard || play.RedCard ||
		play.Substitution || play.PenaltyKick {
		return true
	}
	if analysableKeys[play.TypeKey] {
		return true
	}
	return !model.IsTouchTier(play.TypeKey)
}
```

Add `"github.com/mcasillas17/scorearc-backend/shared/model"` to the imports, and export
the tier check from the model package by adding to `backend/shared/model/plays.go`:

```go
// IsTouchTier reports whether a play type belongs to the tier ESPN prunes.
func IsTouchTier(typeKey string) bool { return touchTierKeys[typeKey] }
```

Add the aliases to `backend/shared/espn/types.go`:

```go
type Play = model.Play
type PlayStream = model.PlayStream
type PlayCoordinates = model.PlayCoordinates
```

- [ ] **Step 7: Run**

```bash
cd backend && go test ./shared/espn/ -run "MapPlays|Analysable" -v
```

Expected: six `--- PASS` lines.

- [ ] **Step 8: Commit**

```bash
git add backend/shared/espn/testdata/espn-plays.json \
        backend/shared/espn/testdata/espn-plays-pruned.json \
        backend/shared/model/plays.go backend/shared/espn/plays.go \
        backend/shared/espn/plays_test.go backend/shared/espn/types.go
git commit -m "feat: map ESPN's touch-level play stream

Two fixtures on purpose: mex.1 401877018 (fresh, 1542 plays, pageCount 2)
and 740722 (2025-11-30, pruned to 175 with zero Pass/Ball touch/Tackle).
The mapper has to handle both, and the caller has to be able to tell them
apart, which is what HasTouchTier is for.

Pitch coordinates ARE present -- 546 of 567 sampled plays -- contradicting
the roadmap's 'no pass or touch coordinates exist in any response we can
reach', which is true of the site host and false of the core host. (0,0)
maps to nil because ESPN uses it as an unset sentinel, and writing it
would put every unlocated play on the corner flag.

Every id is parsed from a \$ref string. Nothing is fetched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Fetch the whole stream, and archive it to R2

**Files:**
- Modify: `backend/shared/source/source.go`, `backend/shared/source/espn.go`
- Modify: `backend/shared/assets/r2.go`
- Test: `backend/shared/source/espn_test.go`, `backend/shared/assets/r2_test.go`

**Interfaces:**
- `espn.FetchPlaysPage(ctx, client, slug, eventID string, page int) (model.PlayStream, error)`
- `Source` gains `Plays(ctx, comp config.Competition, eventID string) (model.PlayStream, []byte, error)`
  — the merged stream **and** the concatenated raw pages, because the raw bytes are the
  archive and re-serialising our own structs would archive our parser's blind spots
  instead of ESPN's data.
- `assets.Credentials` + `assets.NewArchive(creds, bucket)` + `assets.ArchiveFromEnv()` —
  a **second, private** R2 client that does not require a public base URL.
- `(*assets.Archive).Put(ctx, key string, body []byte) (int, error)` — gzip and put;
  returns the compressed size.
- `assets.PlayArchiveKey(source, competitionID, seasonID, providerEventID string) string`

- [ ] **Step 1: Write the failing source test**

Append to `backend/shared/source/espn_test.go`:

```go
// A fresh match is 1,542 plays at a 1,000 cap. A fetcher that stops after page
// one loses 542 of them -- including, since the stream is chronological, most
// of the second half.
func TestPlaysFollowsEveryPage(t *testing.T) {
	var requested []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Query().Get("page"))
		page := r.URL.Query().Get("page")
		items := `{"id":"a","type":{"id":"1","text":"Pass","type":"pass"},"period":{"number":1},"clock":{"value":0,"displayValue":""}}`
		if page == "2" {
			items = `{"id":"b","type":{"id":"2","text":"Goal","type":"goal"},"period":{"number":2},"clock":{"value":60,"displayValue":"60'"},"scoringPlay":true}`
		}
		fmt.Fprintf(w, `{"count":2,"pageIndex":%s,"pageSize":1,"pageCount":2,"items":[%s]}`, page, items)
	}))
	defer server.Close()

	source := NewESPNWithBase(espn.New(), server.URL)
	stream, raw, err := source.Plays(context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, "401877018")
	if err != nil {
		t.Fatal(err)
	}
	if len(requested) != 2 || requested[0] != "1" || requested[1] != "2" {
		t.Fatalf("requested pages %v, want [1 2]", requested)
	}
	if len(stream.Plays) != 2 {
		t.Fatalf("plays = %d, want 2 -- page two was dropped", len(stream.Plays))
	}
	// Sequence must continue across the page boundary, not restart.
	if stream.Plays[1].Seq <= stream.Plays[0].Seq {
		t.Fatalf("seq = %d then %d; page two restarted the ordinal",
			stream.Plays[0].Seq, stream.Plays[1].Seq)
	}
	if len(raw) == 0 {
		t.Fatal("no raw bytes returned; there would be nothing to archive")
	}
}

// The silent-degradation guard. If ESPN ever changes its default page size,
// asking for 1000 and being handed 25 turns one cycle into 62x the requests
// with nothing in the logs. Fail loudly instead.
func TestPlaysRefusesAnUnexpectedPageSize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"count":1542,"pageIndex":1,"pageSize":25,"pageCount":62,"items":[]}`)
	}))
	defer server.Close()

	_, _, err := NewESPNWithBase(espn.New(), server.URL).Plays(context.Background(),
		config.Competition{ESPNSlug: "mex.1"}, "401877018")
	if err == nil {
		t.Fatal("want an error when the provider ignores the requested page size")
	}
	if !strings.Contains(err.Error(), "page size") {
		t.Fatalf("err = %v, want it to name the page size", err)
	}
}

// A match with no stream is not an error. Plenty of competitions have none --
// CONCACAF Champions Cup returned 55 plays where Liga MX returned 1,542, and
// some will return zero.
func TestPlaysAcceptsAnEmptyStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"count":0,"pageIndex":1,"pageSize":1000,"pageCount":0,"items":[]}`)
	}))
	defer server.Close()

	stream, _, err := NewESPNWithBase(espn.New(), server.URL).Plays(context.Background(),
		config.Competition{ESPNSlug: "concacaf.champions"}, "1")
	if err != nil {
		t.Fatalf("an empty stream must not be an error: %v", err)
	}
	if len(stream.Plays) != 0 {
		t.Fatalf("plays = %d, want 0", len(stream.Plays))
	}
}
```

`NewESPNWithBase` is a constructor that overrides the core host for tests; add it beside
`NewESPN`, storing the base on the `ESPN` struct and defaulting to the real host. Add
`"fmt"`, `"net/http"`, `"net/http/httptest"`, `"strings"` to the imports.

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/source/ -run Plays
```

Expected: FAIL to compile — `undefined: NewESPNWithBase` and
`source.Plays undefined`.

- [ ] **Step 3: Implement the paging fetch**

Add to `backend/shared/espn/plays.go`:

```go
// FetchPlaysPage retrieves one page. Exported so the retention probe can ask
// for page one without pulling the whole stream.
func FetchPlaysPage(
	ctx context.Context,
	client *Client,
	slug, eventID string,
	page int,
) (model.PlayStream, error) {
	var raw json.RawMessage
	if err := client.GetJSON(ctx, CorePlaysURL(slug, eventID, page, corePlayPageLimit), &raw); err != nil {
		return model.PlayStream{}, err
	}
	return MapPlays(raw)
}
```

Add `Plays` to `backend/shared/source/source.go`'s `Source` interface:

```go
	// Plays returns a match's full touch-level stream AND the raw pages that
	// produced it. The raw bytes are what gets archived: re-serialising our own
	// structs would archive our parser's blind spots instead of ESPN's data,
	// and the entire point of the archive is that a better parser can be run
	// over it later.
	Plays(context.Context, config.Competition, string) (model.PlayStream, []byte, error)
```

and implement it in `backend/shared/source/espn.go`:

```go
func (e *ESPN) Plays(
	ctx context.Context,
	comp config.Competition,
	eventID string,
) (model.PlayStream, []byte, error) {
	var merged model.PlayStream
	var pages [][]byte

	for page := 1; ; page++ {
		url := espn.CorePlaysURLOn(e.coreBase, comp.ESPNSlug, eventID, page, playPageLimit)
		raw, err := e.get(ctx, url)
		if err != nil {
			return model.PlayStream{}, nil, err
		}
		stream, err := espn.MapPlays(raw)
		if err != nil {
			return model.PlayStream{}, nil, err
		}
		// A provider that quietly hands back its default page size instead of
		// the one asked for turns a 2-request fetch into 62. It has a documented
		// cliff at limit>1000 and no error, so this is the only place it can be
		// caught.
		if len(stream.Plays) > 0 && stream.PageSize != playPageLimit {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s: requested page size %d, provider returned %d",
				eventID, playPageLimit, stream.PageSize)
		}
		pages = append(pages, raw)
		if page == 1 {
			merged = stream
		} else {
			merged.Plays = append(merged.Plays, stream.Plays...)
		}
		if page >= stream.PageCount || stream.PageCount == 0 {
			break
		}
		// A runaway pageCount would loop forever against a keyless API. Ten
		// pages at 1000 each is 10,000 plays, roughly six times the largest
		// match observed.
		if page >= 10 {
			return model.PlayStream{}, nil, fmt.Errorf(
				"espn plays %s: pageCount %d exceeds the sane bound", eventID, stream.PageCount)
		}
	}
	return merged, bytes.Join(pages, []byte("\n")), nil
}

const playPageLimit = 1000
```

Add `"bytes"` to the imports, a `coreBase string` field on `ESPN` defaulting to the real
host in `NewESPN`, `NewESPNWithBase` setting it, and `espn.CorePlaysURLOn(base, …)` as the
host-parameterised form of `CorePlaysURL` (with `CorePlaysURL` delegating to it using the
`core` constant).

The archive body is the pages joined by newlines — **JSON Lines, one page object per
line** — rather than a synthesised single document. It is trivially streamable, appending a
late-arriving page is a concatenation, and nothing is reshaped on the way in.

- [ ] **Step 4a: Write the failing archive tests**

Create `backend/shared/assets/archive_test.go`:

```go
package assets

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type recordingPutter struct {
	bucket, key      string
	body             []byte
	contentEncoding  string
	calls            int
}

func (r *recordingPutter) HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	return nil, errors.New("archive must not HEAD; it always overwrites")
}

func (r *recordingPutter) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	r.calls++
	r.bucket, r.key = *in.Bucket, *in.Key
	if in.ContentEncoding != nil {
		r.contentEncoding = *in.ContentEncoding
	}
	body, err := io.ReadAll(in.Body)
	if err != nil {
		return nil, err
	}
	r.body = body
	return &s3.PutObjectOutput{}, nil
}

// The requirement this whole refactor exists for: a PRIVATE bucket has no
// public base URL, and constructing its client must not demand one. Before the
// split, the only way to build an R2 client at all was assets.New, which
// rejects an empty or non-HTTPS R2_PUBLIC_BASE_URL.
func TestArchiveNeedsNoPublicBaseURL(t *testing.T) {
	archive, err := NewArchive(Credentials{
		AccountID: "acct", AccessKeyID: "key", SecretAccessKey: "secret",
	}, "some-private-bucket")
	if err != nil {
		t.Fatalf("NewArchive: %v", err)
	}
	if archive == nil {
		t.Fatal("NewArchive returned nil")
	}
}

func TestNewArchiveRequiresABucket(t *testing.T) {
	if _, err := NewArchive(Credentials{
		AccountID: "acct", AccessKeyID: "key", SecretAccessKey: "secret",
	}, ""); err == nil {
		t.Fatal("want an error when no bucket is named")
	}
}

func TestArchivePutsGzippedBytesUnderTheGivenKey(t *testing.T) {
	putter := &recordingPutter{}
	archive := &Archive{client: putter, bucket: "raw-bucket"}

	payload := []byte(`{"count":1542}` + "\n" + `{"count":1542}`)
	size, err := archive.Put(context.Background(), "plays/espn/mex/2026/1.ndjson.gz", payload)
	if err != nil {
		t.Fatal(err)
	}
	if putter.bucket != "raw-bucket" {
		t.Fatalf("bucket = %q, want the raw bucket", putter.bucket)
	}
	if putter.key != "plays/espn/mex/2026/1.ndjson.gz" {
		t.Fatalf("key = %q", putter.key)
	}
	if putter.contentEncoding != "gzip" {
		t.Fatalf("contentEncoding = %q, want gzip", putter.contentEncoding)
	}
	if size != len(putter.body) {
		t.Fatalf("reported size %d, actually wrote %d", size, len(putter.body))
	}
	// Round-trip: an archive we cannot read back is not an archive.
	reader, err := gzip.NewReader(strings.NewReader(string(putter.body)))
	if err != nil {
		t.Fatalf("stored bytes are not gzip: %v", err)
	}
	restored, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(payload) {
		t.Fatal("round-trip changed the payload")
	}
}

// The key must be derivable from ESPN's own ids alone, so an object is
// identifiable without the database that indexed it.
func TestPlayArchiveKeyLayout(t *testing.T) {
	got := PlayArchiveKey("espn", "premier-league", "2026-27", "401877018")
	want := "plays/espn/premier-league/2026-27/401877018.ndjson.gz"
	if got != want {
		t.Fatalf("PlayArchiveKey = %q, want %q", got, want)
	}
	// A competition or season id with a slash in it would silently create a
	// nested prefix and break the one-prefix-per-season listing.
	if strings.Contains(PlayArchiveKey("espn", "a/b", "c", "1"), "a/b") {
		t.Fatal("path separators in an id must be escaped, not interpolated")
	}
}
```

```bash
cd backend && go test ./shared/assets/ -run "Archive|PlayArchiveKey"
```

Expected: FAIL to compile — `undefined: NewArchive`, `undefined: Credentials`,
`undefined: Archive`, `undefined: PlayArchiveKey`.

- [ ] **Step 4b: Split client construction out of the public-URL concern**

In `backend/shared/assets/r2.go`, extract the credentials and the S3 client so that
building a client no longer implies having a CDN in front of it. Replace the `Config`
declaration and add:

```go
// Credentials are the parts shared by every R2 bucket: one account, one API
// token with Object Read & Write scoped to both buckets, one S3 endpoint. Only
// the bucket name differs between them.
type Credentials struct {
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
}

// Config is a PUBLIC bucket: one that is served from a CDN origin. The public
// base URL is required here and only here.
type Config struct {
	Credentials
	Bucket        string
	PublicBaseURL string
}

func (c Credentials) complete() bool {
	return c.AccountID != "" && c.AccessKeyID != "" && c.SecretAccessKey != ""
}

// newS3Client builds the R2 client. It knows nothing about public URLs, which
// is the point: the raw archive bucket is private -- no public access, no
// r2.dev URL, no custom domain -- and before this split the only way to
// construct a client was assets.New, whose validator rejects an empty
// PublicBaseURL. Passing a dummy URL to get past that would leave a
// plausible-looking CDN origin in the config for someone to later serve from.
func newS3Client(creds Credentials) *s3.Client {
	return s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(fmt.Sprintf("https://%s.r2.cloudflarestorage.com", creds.AccountID)),
		Credentials: credentials.NewStaticCredentialsProvider(
			creds.AccessKeyID, creds.SecretAccessKey, ""),
		UsePathStyle: true,
	})
}

func credentialsFromEnv() Credentials {
	return Credentials{
		AccountID:       os.Getenv("R2_ACCOUNT_ID"),
		AccessKeyID:     os.Getenv("R2_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
	}
}
```

Then rewrite `New` to keep its existing public-URL validation verbatim and call
`newS3Client(config.Credentials)` in place of its inline `s3.New(...)`, and rewrite
`FromEnv` to build `Config{Credentials: credentialsFromEnv(), Bucket: os.Getenv("R2_BUCKET"), PublicBaseURL: os.Getenv("R2_PUBLIC_BASE_URL")}`
and gate on `config.Credentials.complete() && config.Bucket != "" && config.PublicBaseURL != ""`.

**The public path's behaviour must not change.** Run its existing suite before moving on:

```bash
cd backend && go test ./shared/assets/ -run "Mirror|FromEnv" -v
```

Expected: every pre-existing case still `--- PASS`. If `FromEnv` now returns a mirror where
it used to return `(nil, false, nil)`, the completeness gate lost a condition.

- [ ] **Step 4c: Add the private archive client**

Create `backend/shared/assets/archive.go`:

```go
package assets

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const archiveOperationTimeout = 60 * time.Second

// Archive writes immutable raw payloads to the PRIVATE R2 bucket.
//
// It is a separate type from Mirror, not a method on it, because the two have
// opposite requirements. Mirror exists to put an image where a browser can
// fetch it: it needs a public base URL, it validates content types, it refuses
// hosts outside espncdn.com, and it HEADs first so an asset already mirrored is
// not downloaded twice. Archive exists to keep bytes nobody can fetch again: it
// has no public URL by design, it reshapes nothing, and it always overwrites,
// because a re-archive of a live match is a LONGER stream and skipping it would
// freeze the object at first-half length.
//
// The bucket name arrives from the environment and is never a literal in this
// package. R2_RAW_BUCKET names the ROLE; the secret names the RESOURCE. A
// bucket rename is then `fly secrets set`, not a code change and a redeploy.
type Archive struct {
	client objectClient
	bucket string
}

// ArchiveFromEnv builds the raw-archive client, or reports that it is not
// configured.
//
// Deliberately does NOT read R2_PUBLIC_BASE_URL. The raw bucket has no public
// access, no r2.dev URL and no custom domain; requiring one would be requiring
// a value that does not and should not exist.
func ArchiveFromEnv() (*Archive, bool, error) {
	creds := credentialsFromEnv()
	bucket := os.Getenv("R2_RAW_BUCKET")
	if !creds.complete() || bucket == "" {
		return nil, false, nil
	}
	archive, err := NewArchive(creds, bucket)
	return archive, true, err
}

func NewArchive(creds Credentials, bucket string) (*Archive, error) {
	if bucket == "" {
		return nil, fmt.Errorf("R2 archive requires a bucket name")
	}
	if !creds.complete() {
		return nil, fmt.Errorf("R2 archive requires account id, access key and secret")
	}
	return &Archive{client: newS3Client(creds), bucket: bucket}, nil
}

// Put stores a gzipped payload and returns the COMPRESSED size, which is what
// gets billed and what match_play_archive.bytes records.
//
// Nothing here inspects or reshapes the body. The entire value of the archive
// is that a better parser can be run over it later, and a parser can only
// improve on bytes that were stored exactly as they arrived.
func (a *Archive) Put(ctx context.Context, key string, body []byte) (int, error) {
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(body); err != nil {
		return 0, fmt.Errorf("gzip archive %s: %w", key, err)
	}
	if err := writer.Close(); err != nil {
		return 0, fmt.Errorf("gzip archive %s: %w", key, err)
	}
	compressed := buffer.Bytes()

	// A longer timeout than the asset mirror's 15s: a full match is ~2 MB raw
	// and the write happens once, not on a request path.
	putCtx, cancel := context.WithTimeout(ctx, archiveOperationTimeout)
	defer cancel()
	if _, err := a.client.PutObject(putCtx, &s3.PutObjectInput{
		Bucket:          aws.String(a.bucket),
		Key:             aws.String(key),
		Body:            bytes.NewReader(compressed),
		ContentType:     aws.String("application/x-ndjson"),
		ContentEncoding: aws.String("gzip"),
	}); err != nil {
		return 0, fmt.Errorf("put archive %s: %w", key, err)
	}
	return len(compressed), nil
}

// PlayArchiveKey is the object layout:
//
//	plays/{source}/{competition}/{season}/{providerEventID}.ndjson.gz
//
// Four decisions, each on purpose:
//
//   - SOURCE first, under `plays/`. A second provider one day writes the same
//     match and must not collide with ESPN's copy of it.
//   - COMPETITION then SEASON, so an entire season is one prefix — listable,
//     re-processable and expirable with a single scan, which is the only
//     lifecycle operation this data will ever need.
//   - The PROVIDER'S event id, not our canonical match uuid. The object is then
//     identifiable from ESPN's own ids alone: if the database were lost, or
//     while comparing an object against the live API, the key still says which
//     event it is. match_play_archive.object_key stores the full key, so the
//     join back to a canonical match is one column and costs nothing.
//   - ONE OBJECT PER MATCH, not per page. A match is the unit of reprocessing;
//     pages are an artefact of whatever `limit` we happened to send, and the
//     same match is 2 objects at limit=1000 and 62 at the default. The pages
//     are joined as NDJSON, one page object per line, so nothing is reshaped
//     and appending a late page is a concatenation.
//
// Every segment is escaped: an id containing a slash would silently create a
// nested prefix and break the one-prefix-per-season listing.
func PlayArchiveKey(source, competitionID, seasonID, providerEventID string) string {
	return fmt.Sprintf("plays/%s/%s/%s/%s.ndjson.gz",
		url.PathEscape(source), url.PathEscape(competitionID),
		url.PathEscape(seasonID), url.PathEscape(providerEventID))
}
```

- [ ] **Step 4d: Wire the archive into the ingester's dependencies**

`Archive` is **not** a `crestMirror`. Add a separate narrow interface to
`backend/ingester/contracts.go`:

```go
// rawArchive is the PRIVATE bucket. Deliberately not folded into crestMirror:
// that interface exposes BaseURL(), which the raw bucket does not have and
// must not be given a plausible-looking value for.
type rawArchive interface {
	Put(context.Context, string, []byte) (int, error)
}
```

Add `archive rawArchive` to the `runner` struct, and in `backend/ingester/main.go`, beside
the existing mirror wiring:

```go
	var archive rawArchive
	if configured, ok, err := assets.ArchiveFromEnv(); err != nil {
		log.Error("configure R2 raw archive", "err", err)
		return 1
	} else if ok {
		archive = configured
	} else {
		// Not fatal, and loud on purpose. The ingester keeps working without
		// it -- but the touch tier it is failing to keep is the most
		// perishable data in the system, and a silent Warn here is a season
		// quietly not being archived.
		log.Warn("R2 raw archive disabled; the play stream will NOT be kept",
			"hint", "set R2_RAW_BUCKET and the R2 credentials via `fly secrets`")
	}
```

and pass `archive: archive` into the `worker := &runner{...}` literal.

- [ ] **Step 4e: Run the assets tests**

```bash
cd backend && go test ./shared/assets/ -v
```

Expected: the four new archive cases pass **and** every pre-existing mirror case still
passes. The split is only correct if the public path is untouched.

- [ ] **Step 5: Run both packages**

```bash
cd backend && go test ./shared/source/ ./shared/assets/ -v
```

Expected: `TestPlaysFollowsEveryPage`, `TestPlaysRefusesAnUnexpectedPageSize`,
`TestPlaysAcceptsAnEmptyStream`, the four archive cases, **and every pre-existing mirror
case** all `--- PASS`.

- [ ] **Step 6: Run the retention probe and record the answer**

Now that `FetchPlaysPage` exists, Task 1's probe runs:

```bash
cd backend && go run ./cmd/play-retention -comp mex.1 -months 12 | tee /tmp/retention-mex1.json
cd backend && go run ./cmd/play-retention -comp eng.1 -months 12 | tee /tmp/retention-eng1.json
```

Expected: a JSON array, one entry per month, `ageDays` ascending. Read where `touchTier`
falls to `0`. **Write that number into the PR body and into `ARCHITECTURE.md`.** A window
you measured is an SLA; a window you assumed is a future incident.

Sample two competitions, not one — CONCACAF Champions Cup returned 55 plays where Liga MX
returned 1,542, so coverage varies by competition and the retention window may too.

- [ ] **Step 7: Commit**

```bash
git add backend/shared/source/source.go backend/shared/source/espn.go \
        backend/shared/source/espn_test.go backend/shared/espn/plays.go \
        backend/shared/assets/r2.go backend/shared/assets/r2_test.go
git add backend/shared/assets/archive.go backend/shared/assets/archive_test.go \
        backend/ingester/main.go backend/ingester/contracts.go
git commit -m "feat: fetch the full play stream and archive it to the private R2 bucket

Paginates: a fresh match is 1,542 plays at a hard cap of 1,000, so a
single-request fetch silently loses most of the second half. Errors if the
provider hands back a page size other than the one asked for -- it has a
documented cliff at limit>1000 where it returns 25 with no error, which
would turn one cycle into 62x the requests.

The RAW pages are archived, joined as JSON Lines, not our re-serialised
structs: the point of the archive is that a better parser can be run over
it later, and archiving our own output would preserve our blind spots
instead of ESPN's data.

Adds a SECOND R2 client for the private raw bucket (R2_RAW_BUCKET). It
cannot be assets.Mirror: that requires R2_PUBLIC_BASE_URL and validates it
as an HTTPS origin, and the raw bucket has no public URL by design.
Rather than pass a dummy value past that validator -- which would leave a
plausible-looking CDN origin in the config -- client construction is split
out of the public-URL concern.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Persist, resolving ids without fetching

**Files:**
- Create: `backend/shared/store/plays.go`, `backend/shared/store/plays_integration_test.go`
- Modify: `backend/ingester/contracts.go`, `backend/ingester/plays.go` (new),
  `backend/ingester/matches.go`, `backend/ingester/runner_test.go`

**Interfaces:**
- `func (s *Store) WritePlays(ctx context.Context, matchID uuid.UUID, plays []model.Play, teamIDs map[string]string, playerIDs map[string]uuid.UUID) (int, error)`
- `func (s *Store) RecordPlayArchive(ctx context.Context, matchID uuid.UUID, key string, plays, bytes int, touchTier bool) error`
- `func (s *Store) ResolveKnownPlayers(ctx context.Context, source string, sourceIDs []string) (map[string]uuid.UUID, error)`
  — **one query for the whole match**, against `player_external_ref`.

**The resolution rule.** A play names its athlete by `$ref`. We already have that athlete
in `player_external_ref`, because `WriteParticipation` resolved the squad from the summary
before the plays were fetched. So resolution is **one `WHERE source_id = ANY($2)` query per
match**, not `Store.Player` per play — which would be ~1,500 round trips and would *mint*
canonical players for anyone the squad sheet omitted. A play naming an unknown athlete
stores `player_id = NULL`; the play still happened.

- [ ] **Step 1: Write the failing tests**

Create `backend/shared/store/plays_integration_test.go`:

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func playsFixture() []model.Play {
	x, y := 77.2, 25.0
	return []model.Play{
		{SourceID: "50929858", Seq: 0, TypeKey: "pass", TypeText: "Pass",
			TeamSourceID: "359", PlayerSourceID: "295847", Period: 1},
		{SourceID: "50929900", Seq: 1, TypeKey: "shot-on-target", TypeText: "Shot On Target",
			TeamSourceID: "359", PlayerSourceID: "295847", Period: 1,
			Coordinates: &model.PlayCoordinates{StartX: &x, StartY: &y}},
		{SourceID: "50929999", Seq: 2, TypeKey: "goal", TypeText: "Goal",
			TeamSourceID: "359", PlayerSourceID: "999999", ScoringPlay: true, Period: 2},
	}
}

// Re-ingestion is an upsert on ESPN's play id, so a live match polled every
// 20s converges instead of accumulating.
func TestWritePlaysIsIdempotentOnTheProviderID(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	playerID, err := store.Player(ctx, "espn", PlayerRef{SourceID: "295847", FullName: "Federico Viñas"})
	if err != nil {
		t.Fatal(err)
	}
	teamIDs := map[string]string{"359": "eng-arsenal"}
	playerIDs := map[string]uuid.UUID{"295847": playerID}

	for range 3 {
		if _, err := store.WritePlays(ctx, matchID, playsFixture(), teamIDs, playerIDs); err != nil {
			t.Fatalf("WritePlays: %v", err)
		}
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match_play`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 3 {
		t.Fatalf("stored %d rows after three writes of three plays, want 3", rows)
	}
}

// An athlete the squad sheet never mentioned must NOT mint a canonical player.
// Minting from the play stream would create a person per unrecognised ref,
// at ~1,500 refs a match, with no name to give them.
func TestWritePlaysLeavesAnUnknownAthleteUnattributed(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	playerID, _ := store.Player(ctx, "espn", PlayerRef{SourceID: "295847", FullName: "Federico Viñas"})
	if _, err := store.WritePlays(ctx, matchID, playsFixture(),
		map[string]string{"359": "eng-arsenal"},
		map[string]uuid.UUID{"295847": playerID}); err != nil {
		t.Fatal(err)
	}

	var storedPlayer *uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT player_id FROM match_play WHERE source_id='50929999'`).Scan(&storedPlayer); err != nil {
		t.Fatal(err)
	}
	if storedPlayer != nil {
		t.Fatalf("player_id = %v for an unknown athlete, want NULL", storedPlayer)
	}
	var players int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player`).Scan(&players); err != nil {
		t.Fatal(err)
	}
	if players != 1 {
		t.Fatalf("player rows = %d, want 1 -- the stream minted a person", players)
	}
	// The play itself is still there. It happened.
	var goals int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM match_play WHERE scoring_play`).Scan(&goals); err != nil {
		t.Fatal(err)
	}
	if goals != 1 {
		t.Fatalf("scoring plays = %d, want 1 -- an unattributed goal must not be dropped", goals)
	}
}

func TestWritePlaysStoresCoordinates(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	if _, err := store.WritePlays(ctx, matchID, playsFixture(),
		map[string]string{"359": "eng-arsenal"}, map[string]uuid.UUID{}); err != nil {
		t.Fatal(err)
	}
	var x, y *float64
	if err := pool.QueryRow(ctx,
		`SELECT start_x, start_y FROM match_play WHERE source_id='50929900'`).Scan(&x, &y); err != nil {
		t.Fatal(err)
	}
	if x == nil || *x != 77.2 || y == nil || *y != 25 {
		t.Fatalf("coordinates = %v/%v, want 77.2/25", x, y)
	}
	// The pass has none, and must be NULL rather than 0.
	var passX *float64
	if err := pool.QueryRow(ctx,
		`SELECT start_x FROM match_play WHERE source_id='50929858'`).Scan(&passX); err != nil {
		t.Fatal(err)
	}
	if passX != nil {
		t.Fatalf("unlocated play stored start_x = %v, want NULL", *passX)
	}
}

// One query for the whole match, not one per play.
func TestResolveKnownPlayersIsOneLookup(t *testing.T) {
	store, _ := newIntegrationStore(t)
	ctx := context.Background()
	first, _ := store.Player(ctx, "espn", PlayerRef{SourceID: "1", FullName: "One"})
	second, _ := store.Player(ctx, "espn", PlayerRef{SourceID: "2", FullName: "Two"})

	resolved, err := store.ResolveKnownPlayers(ctx, "espn", []string{"1", "2", "3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 2 || resolved["1"] != first || resolved["2"] != second {
		t.Fatalf("resolved = %v, want exactly the two known athletes", resolved)
	}
	if _, minted := resolved["3"]; minted {
		t.Fatal("an unknown athlete was resolved; nothing here may mint a player")
	}
}

// The archive ledger records whether the touch tier was present, because a
// later re-processing run cannot re-derive it -- it would see an empty result
// and conclude the parser is broken.
func TestRecordPlayArchiveRemembersThePrunedCase(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()
	mustSeedTwoTeams(t, store)
	mustSeedSeason(t, pool)
	matchID := mustSeedMatch(t, store)

	if err := store.RecordPlayArchive(ctx, matchID,
		"plays/premier-league/2026-27/"+matchID.String()+".ndjson.gz", 175, 20480, false); err != nil {
		t.Fatal(err)
	}
	var touchTier bool
	var plays int
	if err := pool.QueryRow(ctx,
		`SELECT touch_tier, plays FROM match_play_archive WHERE match_id=$1`,
		matchID).Scan(&touchTier, &plays); err != nil {
		t.Fatal(err)
	}
	if touchTier || plays != 175 {
		t.Fatalf("touch_tier=%v plays=%d, want false/175", touchTier, plays)
	}

	// Re-archiving a match that has since been re-fetched with the full stream
	// must upgrade the row, not duplicate it.
	if err := store.RecordPlayArchive(ctx, matchID,
		"plays/premier-league/2026-27/"+matchID.String()+".ndjson.gz", 1542, 204800, true); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT touch_tier, plays FROM match_play_archive WHERE match_id=$1`,
		matchID).Scan(&touchTier, &plays); err != nil {
		t.Fatal(err)
	}
	if !touchTier || plays != 1542 {
		t.Fatalf("touch_tier=%v plays=%d after re-archive, want true/1542", touchTier, plays)
	}
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend && go test ./shared/store/ -run "WritePlays|ResolveKnownPlayers|RecordPlayArchive"
```

Expected: FAIL to compile — `store.WritePlays undefined`.

- [ ] **Step 3: Implement the store**

Create `backend/shared/store/plays.go`:

```go
package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// ResolveKnownPlayers maps provider athlete ids to canonical player ids in ONE
// query.
//
// It resolves; it never mints. Store.Player creates a player on a miss, which
// is right when the caller has a squad sheet with a name on it and wrong here:
// a play names its athlete by $ref and nothing else, so minting would create a
// nameless person per unrecognised ref, ~1,500 refs a match. Anyone the squad
// sheet named is already in the crosswalk, because WriteParticipation ran
// against the same match's summary before the plays were fetched. Everyone
// else stays unattributed, which is the honest answer.
func (s *Store) ResolveKnownPlayers(
	ctx context.Context,
	source string,
	sourceIDs []string,
) (map[string]uuid.UUID, error) {
	resolved := make(map[string]uuid.UUID, len(sourceIDs))
	if len(sourceIDs) == 0 {
		return resolved, nil
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx,
		`SELECT source_id, player_id FROM player_external_ref
		 WHERE source=$1 AND source_id = ANY($2)`, source, sourceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID string
		var playerID uuid.UUID
		if err := rows.Scan(&sourceID, &playerID); err != nil {
			return nil, err
		}
		resolved[sourceID] = playerID
	}
	return resolved, rows.Err()
}

// WritePlays upserts the analysable tier of a match's stream.
//
// Keyed on ESPN's play id, so a live match re-fetched every 20 seconds
// converges rather than accumulating, and a play revised upstream is corrected
// in place. There is deliberately no tail DELETE -- unlike match_event, which
// is small enough to rewrite wholesale, this is ~180 rows a match and a
// retracted play is vanishingly rare next to the cost of a bug erasing a
// stream ESPN will not serve again.
func (s *Store) WritePlays(
	ctx context.Context,
	matchID uuid.UUID,
	plays []model.Play,
	teamIDs map[string]string,
	playerIDs map[string]uuid.UUID,
) (int, error) {
	if len(plays) == 0 {
		return 0, nil
	}
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(ctx, tx)

	batch := &pgx.Batch{}
	for _, play := range plays {
		var teamID any
		if canonical, ok := teamIDs[play.TeamSourceID]; ok && canonical != "" {
			teamID = canonical
		}
		var playerID any
		if canonical, ok := playerIDs[play.PlayerSourceID]; ok {
			playerID = canonical
		}
		var startX, startY, endX, endY, goalY, goalZ any
		if c := play.Coordinates; c != nil {
			startX, startY = deref(c.StartX), deref(c.StartY)
			endX, endY = deref(c.EndX), deref(c.EndY)
			goalY, goalZ = deref(c.GoalY), deref(c.GoalZ)
		}
		batch.Queue(playUpsertSQL,
			matchID, play.SourceID, play.Seq,
			play.TypeID, play.TypeKey, play.TypeText,
			teamID, playerID,
			play.Period, play.ClockValue, play.ClockDisplay, play.Wallclock,
			play.HomeScore, play.AwayScore, play.ScoringPlay, play.ScoreValue,
			play.OwnGoal, play.PenaltyKick, play.YellowCard, play.RedCard,
			play.Substitution, play.Shootout,
			startX, startY, endX, endY, goalY, goalZ,
			play.Text)
	}
	results := tx.SendBatch(ctx, batch)
	for index := range plays {
		if _, err := results.Exec(); err != nil {
			_ = results.Close()
			return 0, fmt.Errorf("play %d (%s): %w", index, plays[index].SourceID, err)
		}
	}
	if err := results.Close(); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(plays), nil
}

func deref(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

const playUpsertSQL = `
INSERT INTO match_play (
	match_id, source_id, seq, type_id, type_key, type_text,
	team_id, player_id, period, clock_value, clock_display, wallclock,
	home_score, away_score, scoring_play, score_value,
	own_goal, penalty_kick, yellow_card, red_card, substitution, shootout,
	start_x, start_y, end_x, end_y, goal_y, goal_z, text)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
ON CONFLICT (match_id, source_id) DO UPDATE SET
	seq = EXCLUDED.seq,
	type_id = EXCLUDED.type_id, type_key = EXCLUDED.type_key,
	type_text = EXCLUDED.type_text,
	-- COALESCE on identity: a later poll that fails to resolve an athlete
	-- already resolved must not un-attribute the play.
	team_id   = COALESCE(EXCLUDED.team_id,   match_play.team_id),
	player_id = COALESCE(EXCLUDED.player_id, match_play.player_id),
	period = EXCLUDED.period, clock_value = EXCLUDED.clock_value,
	clock_display = EXCLUDED.clock_display, wallclock = EXCLUDED.wallclock,
	home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
	scoring_play = EXCLUDED.scoring_play, score_value = EXCLUDED.score_value,
	own_goal = EXCLUDED.own_goal, penalty_kick = EXCLUDED.penalty_kick,
	yellow_card = EXCLUDED.yellow_card, red_card = EXCLUDED.red_card,
	substitution = EXCLUDED.substitution, shootout = EXCLUDED.shootout,
	start_x = COALESCE(EXCLUDED.start_x, match_play.start_x),
	start_y = COALESCE(EXCLUDED.start_y, match_play.start_y),
	end_x   = COALESCE(EXCLUDED.end_x,   match_play.end_x),
	end_y   = COALESCE(EXCLUDED.end_y,   match_play.end_y),
	goal_y  = COALESCE(EXCLUDED.goal_y,  match_play.goal_y),
	goal_z  = COALESCE(EXCLUDED.goal_z,  match_play.goal_z),
	text = EXCLUDED.text`

// RecordPlayArchive notes what went to R2.
//
// touchTier is the field that matters. A re-processing run six months from now
// cannot re-derive whether an object ever contained passes: it would find none
// and conclude the parser is broken. Recording it at write time is the only
// moment the answer is knowable.
func (s *Store) RecordPlayArchive(
	ctx context.Context,
	matchID uuid.UUID,
	key string,
	plays, bytes int,
	touchTier bool,
) error {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	_, err := s.pool.Exec(ctx, `
INSERT INTO match_play_archive (match_id, object_key, plays, bytes, touch_tier, archived_at)
VALUES ($1,$2,$3,$4,$5,now())
ON CONFLICT (match_id) DO UPDATE SET
	object_key = EXCLUDED.object_key,
	plays      = EXCLUDED.plays,
	bytes      = EXCLUDED.bytes,
	-- Once true, always true: a match archived live carries the touch tier,
	-- and a later re-archive after ESPN pruned it must not downgrade the
	-- record of what the object contains.
	touch_tier = match_play_archive.touch_tier OR EXCLUDED.touch_tier,
	archived_at = now()`,
		matchID, key, plays, bytes, touchTier)
	return err
}
```

- [ ] **Step 4: Run**

```bash
cd backend && go test ./shared/store/ -run "WritePlays|ResolveKnownPlayers|RecordPlayArchive" -v
```

Expected: five `--- PASS` lines.

> **Note on `TestRecordPlayArchiveRemembersThePrunedCase`.** The `touch_tier` upsert is
> `OR`, so the test's second call (upgrading `false` → `true`) passes. If you write the
> test to downgrade `true` → `false` instead, expect it to stay `true` — that is the
> intended behaviour, not a bug.

- [ ] **Step 5: Wire it into the ingester**

Create `backend/ingester/plays.go`:

```go
package main

import (
	"context"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const playStreamRunKind = "play_stream"

// capturePlays fetches, archives and stores a match's touch-level stream.
//
// It is called for FINISHED matches only, and once. A live match's stream is
// re-fetched every 20 seconds and is 1,500 plays over two pages -- eighteen
// requests a minute per live match, which is the difference between polite and
// rate-limited on a keyless API. The stream is complete at full time and ESPN
// does not prune it for weeks, so once is enough and once is what we do.
func (r *runner) capturePlays(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	identity store.MatchIdentity,
	providerEventID string,
) {
	start := time.Now()
	stream, raw, err := r.source.Plays(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, playStreamRunKind, start, err)
		r.log.Warn("fetch play stream", "match", providerEventID, "err", err)
		return
	}
	if len(stream.Plays) == 0 {
		// Not an error. CONCACAF Champions Cup returned 55 plays where Liga MX
		// returned 1,542, and some competitions will return none at all -- the
		// same per-competition coverage variance E6's T6.1 exists to measure.
		r.recordRun(ctx, comp.ID, playStreamRunKind, start, nil)
		return
	}

	// Archive first, to the PRIVATE raw bucket. The bytes are the
	// irreplaceable part; rows can be rebuilt from them, and they cannot be
	// rebuilt from rows.
	//
	// r.archive is the raw bucket, NOT r.mirror. The mirror is the public
	// CDN bucket for crests and has a public base URL; this one has none by
	// design.
	if r.archive != nil {
		key := assets.PlayArchiveKey(r.source.Name(), comp.ID, season.ID, providerEventID)
		if size, archiveErr := r.archive.Put(ctx, key, raw); archiveErr != nil {
			r.log.Warn("archive play stream", "match", providerEventID, "err", archiveErr)
		} else if recordErr := r.repo.RecordPlayArchive(ctx, identity.MatchID, key,
			len(stream.Plays), size, stream.HasTouchTier()); recordErr != nil {
			r.log.Warn("record play archive", "match", providerEventID, "err", recordErr)
		}
	} else {
		// Loud, because this is the perishable tier. A silent skip here is a
		// season of touch data quietly not being kept.
		r.log.Warn("no raw archive configured; play stream not kept",
			"match", providerEventID, "plays", len(stream.Plays))
	}

	analysable := make([]model.Play, 0, len(stream.Plays)/8)
	athleteIDs := make([]string, 0, len(stream.Plays)/8)
	teamIDs := map[string]string{}
	for _, play := range stream.Plays {
		if !espn.Analysable(play) {
			continue
		}
		analysable = append(analysable, play)
		if play.PlayerSourceID != "" {
			athleteIDs = append(athleteIDs, play.PlayerSourceID)
		}
	}
	// The two team refs are known already: they are this match's own sides.
	teamIDs[identity.HomeTeamSourceID] = identity.HomeTeamID
	teamIDs[identity.AwayTeamSourceID] = identity.AwayTeamID

	// One lookup for the whole match. Never Store.Player per play: that is
	// ~1,500 round trips and it MINTS, which would create a nameless person for
	// every athlete the squad sheet omitted.
	playerIDs, err := r.repo.ResolveKnownPlayers(ctx, r.source.Name(), athleteIDs)
	if err != nil {
		r.recordRun(ctx, comp.ID, playStreamRunKind, start, err)
		r.log.Warn("resolve play athletes", "match", providerEventID, "err", err)
		return
	}
	written, err := r.repo.WritePlays(ctx, identity.MatchID, analysable, teamIDs, playerIDs)
	r.recordRun(ctx, comp.ID, playStreamRunKind, start, err)
	if err != nil {
		r.log.Warn("write plays", "match", providerEventID, "err", err)
		return
	}
	r.log.Info("play stream", "match", providerEventID,
		"fetched", len(stream.Plays), "stored", written, "touchTier", stream.HasTouchTier())
}
```

`store.MatchIdentity` needs `HomeTeamSourceID` and `AwayTeamSourceID` added beside the
existing `HomeTeamID`/`AwayTeamID`; the resolver already has both values in hand when it
builds the identity.

Add the three methods to `backend/ingester/contracts.go`:

```go
	WritePlays(context.Context, uuid.UUID, []model.Play, map[string]string, map[string]uuid.UUID) (int, error)
	ResolveKnownPlayers(context.Context, string, []string) (map[string]uuid.UUID, error)
	RecordPlayArchive(context.Context, uuid.UUID, string, int, int, bool) error
```

and call it in `backend/ingester/matches.go`, inside the summary block, immediately after
the win-probability snapshot from T7.6 — but **only on the transition to finished**, which
is exactly where `didFinalize` is already true:

```go
					} else if didFinalize {
						result.finalized = true
						matchActive = false
						// The stream is complete at full time and ESPN keeps it
						// for weeks. Fetching it once here, rather than every
						// 20s while live, is the difference between two
						// requests a match and eighteen a minute.
						r.capturePlays(ctx, comp, season, identity, match.ID)
						existing[identity.MatchID] = store.MatchRow{
```

- [ ] **Step 6: Run the full suite**

```bash
cd backend && go test -race ./...
```

Expected: every package `ok`. `fakeRepository` needs the three new methods; add them
alongside the existing ones, recording their arguments the way `WriteParticipation` does.

- [ ] **Step 7: Commit**

```bash
git add backend/shared/store/plays.go backend/shared/store/plays_integration_test.go \
        backend/ingester/plays.go backend/ingester/contracts.go \
        backend/ingester/matches.go backend/ingester/runner_test.go
git commit -m "feat: persist the analysable play tier and archive the rest

Fetched once, on the transition to finished. A live match's stream is
1,500 plays over two pages; re-fetching it every 20s is eighteen requests
a minute per live match against a keyless API, and the stream is complete
at full time anyway.

Athletes are resolved with ONE query against player_external_ref, not
Store.Player per play. Store.Player mints, and minting from a stream that
identifies people only by \$ref would create a nameless person for every
athlete the squad sheet omitted -- ~1,500 refs a match. An unknown athlete
gets player_id NULL; the play still happened.

R2 is written before Postgres: the bytes are the irreplaceable part, rows
can be rebuilt from them and they cannot be rebuilt from rows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Backfill the current season, now — T7.13

**Files:**
- Create: `backend/cmd/play-backfill/main.go`
- Modify: `backend/shared/store/plays.go` (`MatchesMissingPlays`)

**This task is time-critical and is not optional.** ESPN prunes the touch tier. The
current season's matches still have it *today*; the ones played in week one will not
have it forever. Every day this is not run, the earliest matches of the season move
closer to being permanently key-event-only.

Prior seasons are **already lost** at touch level and this tool deliberately does not try
to fetch them — though a separate pass would still recover their **shots and coordinates**,
which Task 4's pruned fixture proves survive. That is a follow-up worth doing and is
explicitly out of scope here.

- [ ] **Step 1: Add the query**

Append to `backend/shared/store/plays.go`:

```go
// MatchesMissingPlays lists finished matches in a season whose stream has never
// been archived, oldest first.
//
// Oldest first is the whole point: the oldest match is the one closest to being
// pruned, so a backfill that is interrupted has still saved the most perishable
// end of the range.
func (s *Store) MatchesMissingPlays(
	ctx context.Context,
	competitionID, seasonID, source string,
	limit int,
) (map[uuid.UUID]string, error) {
	ctx, cancel := boundedContext(ctx)
	defer cancel()
	rows, err := s.pool.Query(ctx, `
SELECT m.id, r.source_id
FROM match m
JOIN match_external_ref r ON r.match_id = m.id AND r.source = $3
LEFT JOIN match_play_archive a ON a.match_id = m.id
WHERE m.competition_id = $1 AND m.season_id = $2
  AND m.state = 'finished'
  AND a.match_id IS NULL
ORDER BY m.kickoff
LIMIT $4`, competitionID, seasonID, source, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pending := map[uuid.UUID]string{}
	for rows.Next() {
		var matchID uuid.UUID
		var sourceID string
		if err := rows.Scan(&matchID, &sourceID); err != nil {
			return nil, err
		}
		pending[matchID] = sourceID
	}
	return pending, rows.Err()
}
```

- [ ] **Step 2: Write the backfill command**

Create `backend/cmd/play-backfill/main.go`:

```go
// Command play-backfill captures the play stream for finished matches that
// never got one.
//
// RUN THIS SOON AND RUN IT OFTEN UNTIL IT REPORTS NOTHING PENDING.
//
// ESPN prunes the touch-level tier for older matches -- verified 2026-08-15,
// a match from 2025-11-30 returned 175 plays with zero Pass/Ball touch/Tackle
// where a same-day match returned 1,542 with all of them. Matches already
// played this season still have their full stream today. They will not
// forever, and no provider will give it back.
//
// Prior seasons are already lost at touch level and are deliberately not
// attempted here. Their SHOTS and coordinates do survive, which is a separate
// and worthwhile backfill.
//
//	go run ./cmd/play-backfill -comp premier-league -batch 50
//	go run ./cmd/play-backfill -all -batch 50
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func main() { os.Exit(run()) }

func run() int {
	compID := flag.String("comp", "", "competition id; omit with -all")
	all := flag.Bool("all", false, "every configured competition")
	batch := flag.Int("batch", 50, "matches per competition per run")
	pause := flag.Duration("pause", 500*time.Millisecond, "delay between matches")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	dsn := os.Getenv("POOLED_DSN")
	if dsn == "" {
		log.Error("POOLED_DSN is required")
		return 1
	}
	// No lease. This is a one-shot operator tool that only ever INSERTs rows
	// the running ingester has decided it does not have, and taking the
	// singleton advisory lock would mean stopping production ingestion to run
	// a backfill.
	ctx := context.Background()
	registry, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		return 1
	}
	repo, err := store.New(ctx, dsn)
	if err != nil {
		log.Error("connect store", "err", err)
		return 1
	}
	defer repo.Close()
	// The PRIVATE raw bucket, via R2_RAW_BUCKET. Not assets.FromEnv(), which
	// builds the public CDN mirror for crests and demands a public base URL
	// the raw bucket does not have.
	//
	// Fatal here, unlike in the ingester: a backfill whose whole purpose is to
	// keep bytes, running without anywhere to keep them, would report success
	// while saving nothing.
	archive, ok, err := assets.ArchiveFromEnv()
	if err != nil || !ok {
		log.Error("R2_RAW_BUCKET and R2 credentials are required; the archive is the point",
			"err", err)
		return 1
	}
	provider := source.NewESPN(espn.New())

	comps := registry.List()
	if !*all {
		comp, found := registry.Get(*compID)
		if !found {
			log.Error("unknown competition", "comp", *compID)
			return 1
		}
		comps = []config.Competition{comp}
	}

	failures := 0
	for _, comp := range comps {
		season := comp.Seasons[comp.CurrentSeasonId]
		pending, err := repo.MatchesMissingPlays(ctx, comp.ID, season.ID, provider.Name(), *batch)
		if err != nil {
			log.Error("list pending", "comp", comp.ID, "err", err)
			failures++
			continue
		}
		log.Info("backfill start", "comp", comp.ID, "season", season.ID, "pending", len(pending))
		for matchID, eventID := range pending {
			stream, raw, err := provider.Plays(ctx, comp, eventID)
			if err != nil {
				log.Warn("fetch", "match", eventID, "err", err)
				failures++
				time.Sleep(*pause)
				continue
			}
			key := assets.PlayArchiveKey(provider.Name(), comp.ID, season.ID, eventID)
			size, err := archive.Put(ctx, key, raw)
			if err != nil {
				log.Warn("archive", "match", eventID, "err", err)
				failures++
				time.Sleep(*pause)
				continue
			}
			if err := repo.RecordPlayArchive(ctx, matchID, key,
				len(stream.Plays), size, stream.HasTouchTier()); err != nil {
				log.Warn("record", "match", eventID, "err", err)
				failures++
			}
			log.Info("backfilled", "comp", comp.ID, "match", eventID,
				"plays", len(stream.Plays), "touchTier", stream.HasTouchTier(), "bytes", size)
			// Politeness, not correctness. A keyless public API is a courtesy
			// and this loop is the least time-critical thing in the system,
			// even though its DATA is the most time-critical.
			time.Sleep(*pause)
		}
	}
	if failures > 0 {
		log.Error("backfill finished with failures", "failures", failures)
		return 1
	}
	log.Info("backfill complete")
	return 0
}
```

The backfill archives to R2 and records the ledger but does **not** write `match_play`
rows. That is deliberate: rows are cheap to regenerate from the archive and the archive is
not regenerable at all, so a backfill under time pressure does the irreversible half first.
A follow-up pass over `match_play_archive` populates the rows whenever convenient.

- [ ] **Step 3: Run it, per competition, and watch the touch-tier rate**

```bash
cd backend
# All five from `fly secrets`, never from a file. R2_RAW_BUCKET is the PRIVATE
# archive bucket; R2_BUCKET (the public CDN one) is not needed here and is not
# read by this command.
export POOLED_DSN='<the least-privilege ingester DSN>'
export R2_ACCOUNT_ID='<...>' R2_ACCESS_KEY_ID='<...>' R2_SECRET_ACCESS_KEY='<...>'
export R2_RAW_BUCKET='<the private raw bucket name>'
go run ./cmd/play-backfill -all -batch 50 2>&1 | tee /tmp/backfill-1.log
grep -c '"touchTier":true'  /tmp/backfill-1.log
grep -c '"touchTier":false' /tmp/backfill-1.log
```

Expected: `backfilled` lines with `plays` in the hundreds-to-1,500 range, and — the number
that matters — **`touchTier:true` for the great majority**. A high `touchTier:false` count
means you have reached matches ESPN has already pruned, and the count tells you exactly how
much was lost before this shipped. Put both numbers in the PR.

Re-run until `pending` reports `0` for every competition.

- [ ] **Step 4: Commit**

```bash
git add backend/cmd/play-backfill/main.go backend/shared/store/plays.go
git commit -m "feat: add a current-season play-stream backfill

ESPN prunes the touch tier for older matches. This season's early
fixtures still have it today and will not forever, and no provider gives
it back.

Oldest first, so an interrupted run has still saved the most perishable
end of the range. Archives to R2 and records the ledger but does not write
match_play rows: rows regenerate from the archive, the archive regenerates
from nothing, so the irreversible half goes first.

Takes no advisory lease -- a backfill must not require stopping production
ingestion.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Doc, gate and PR

- [ ] **Step 1: Document the schema and the measured window**

In `docs/backend/ARCHITECTURE.md`, add under `### Tier 1`:

```markdown
- **match_play**(PK (match_id→match, **source_id** = ESPN's play id), seq, type_id, type_key, type_text, team_id→team NULL, player_id→player NULL, period, clock_value, clock_display, wallclock, home_score, away_score, scoring_play, score_value, own_goal, penalty_kick, yellow_card, red_card, substitution, shootout, **start_x, start_y, end_x, end_y, goal_y, goal_z**, text) — the analysable tier of ESPN's touch-level stream, from the **core** host (`sports.core.api.espn.com`), fetched once on the transition to finished (T7.12). Keyed on the provider's play id, not an ordinal: a live match is re-fetched every 20s and an ordinal renumbers on upstream insertion. `team`/`athlete` arrive as `$ref` URLs and the id is **parsed, never fetched** — a match has ~1,500 plays with 2–3 refs each, so following them is ~4,500 requests per match. **Pitch coordinates exist** (0–100 per axis; `goal_*` is shot placement in the goal mouth) and are nullable, with the provider's `(0,0)` unset sentinel stored as NULL.
- **match_play_archive**(match_id PK→match, object_key, plays, bytes, **touch_tier**, archived_at) — the ledger of what went to R2. `touch_tier` records whether the archived payload still contained passes/touches/tackles, because a later re-processing run cannot re-derive it: it would find none and conclude the parser is broken. `bytes` is the **compressed** size, which is what is billed.
```

and a note on the two buckets:

```markdown
### R2 buckets

Two buckets, one account, one API token with **Object Read & Write** scoped to both, one
S3 endpoint. Only the bucket name differs. Setup: `docs/backend/SETUP.md` §6.

| Env | Access | Contents | Client |
|---|---|---|---|
| `R2_BUCKET` | **public**, served from `R2_PUBLIC_BASE_URL` (`https://cdn.scorearc.futbol`) | team crests, national flags, competition emblems | `assets.Mirror` |
| `R2_RAW_BUCKET` | **private** — no public access, no `r2.dev` URL, no custom domain | raw ESPN play-stream payloads, gzipped NDJSON | `assets.Archive` |

`assets.Archive` deliberately does **not** read `R2_PUBLIC_BASE_URL`: a private bucket has
no public URL by design, and passing a dummy value to satisfy `assets.New`'s validator
would leave a plausible-looking CDN origin in the config for someone to later serve from.
Client construction (`newS3Client`) is therefore separate from the public-URL concern.

Archive key layout, one object per match:

```
plays/{source}/{competition}/{season}/{providerEventID}.ndjson.gz
```

Source first so a second provider cannot collide with ESPN's copy; competition and season
next so a whole season is one listable, re-processable, expirable prefix; the **provider's**
event id last so an object is identifiable from ESPN's own ids without the database that
indexed it (`match_play_archive.object_key` carries the full key for the join back).
One object per match rather than per page, because a match is the unit of reprocessing and
pages are an artefact of whichever `limit` was sent — the same match is 2 pages at
`limit=1000` and 62 at the default.

Bucket names never appear in Go source, `fly.toml` or a plan step: the env var names the
role, the secret names the resource, so a rename is `fly secrets set` rather than a
redeploy.
```

and add a short subsection recording the probe's answer:

```markdown
### Play-stream retention (measured 2026-08-15, T7.13)

ESPN serves the full play stream for the **current season only**. The boundary is the
season, **not** an age.

| Match | Plays | Passes | Coord scale | Goal-mouth |
|---|---|---|---|---|
| Liga MX, 2026-07-17 (this season, 30 days old) | 1,491 | 610 | 0–100 | present |
| Liga MX, 2026-05-10 (last season) | 199 | 0 | **0–1** | **all zero** |
| Premier League, 2026-04-18 | 189 | 0 | **0–1** | **all zero** |
| MLS, 2025-08-09 | 198 | 0 | **0–1** | **all zero** |

Consequences:

- **Prior-season touch data is unrecoverable.** Passes, tackles, take-ons: gone.
- **Prior-season shots survive, but not on comparable terms** — a 0–1 coordinate frame
  that appears inverted relative to the current one, with goal-mouth placement zeroed.
  Reconciling the frames is E9's T9.1; until it reports, **no consumer may mix eras**.
- **The backfill deadline is the end of this season**, not a rolling window.
  `cmd/play-backfill` covers the current season and deliberately attempts nothing older.
- `cmd/play-retention` is a **standing instrument**: re-run it when coverage looks wrong,
  and at each season rollover. This is provider behaviour, not a contract.
```

Fill the table above from the probe's own output if it disagrees with these figures —
they were measured on 2026-08-15 and the behaviour may move. **Never ship this section
with an unmeasured claim in it**; a wrong window in a doc is worse than no section,
because the next reader will believe it.

- [ ] **Step 2: Confirm the roadmap and specs are already correct — do not re-edit them**

The coordinate discovery was acted on **before** this plan was executed. Verify rather
than repeat:

```bash
grep -n "xG" docs/PRODUCT_ROADMAP.md | head -20
ls docs/superpowers/specs/2026-08-15-expected-goals-design.md
```

Expected: **no `| **xG** |` row** in the "Not building, and why" table — xG is committed
epic **E9** — a rewritten **Heat maps** row that gives a product reason rather than "no
coordinates exist", a `### E9 · Expected goals` task block, and the E9 spec file present.

If any of that is missing, the correction was lost in a merge. **Stop and say so** rather
than re-deriving it here; the roadmap is the index every future agent reads first, and two
agents independently editing it is how a correction gets half-applied.

This plan's own contribution to the docs is `ARCHITECTURE.md` only (Step 1).

- [ ] **Step 3: Full gate**

```bash
cd backend && go build ./... && go test -race ./... && go vet ./...
```

Expected: build silent, every package `ok`, vet silent.

- [ ] **Step 4: Confirm no `$ref` is ever fetched**

```bash
grep -rn '\$ref' backend/ --include=*.go | grep -v _test.go
grep -rn "GetJSON\|e.get(" backend/shared/source/espn.go
```

Expected: the first prints only the `rawRef` struct tag and comments — **no call passing a
`$ref` value to an HTTP client**. The second prints the six existing endpoint fetches plus
the plays paging loop, and nothing per-play. If a `$ref` reaches `GetJSON`, stop: that is
the 4,500-requests-per-match failure and it will not show up in tests, only in production
rate limits.

- [ ] **Step 5: Confirm secret and bucket-name discipline**

```bash
grep -rn "postgres://\|R2_\|ACCESS_KEY" backend/ --include=*.go --include=*.toml --include=*.yml | grep -v _test.go
```

Expected: environment-variable *names* only, never values. `R2_RAW_BUCKET` should appear
exactly once in non-test Go source — in `assets.ArchiveFromEnv`.

```bash
grep -rn "scorearc-espn-historic\|scorearc-assets" backend/ docs/superpowers/plans/
```

Expected: **nothing**. The env var names the role; the secret names the resource. A bucket
name in Go source, in a `fly.toml`, or in a plan step means renaming a bucket becomes a code
change and a redeploy instead of a `fly secrets set`. Setup steps for both buckets live in
`docs/backend/SETUP.md` §6 and are not restated in code or plans.

- [ ] **Step 6: Open the PR**

```bash
# NOTE: docs/PRODUCT_ROADMAP.md and the E6/E7/E9 specs were ALREADY corrected on
# 2026-08-15, before this plan was executed. Do not re-correct them here; only
# ARCHITECTURE.md needs the schema and retention sections this plan adds.
git add docs/backend/ARCHITECTURE.md
git commit -m "docs: record the play stream schema and its measured retention window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/ingester-play-stream
gh pr create --title "feat: capture ESPN's touch-level play stream before it is pruned (T7.12, T7.13)" --body "$(cat <<'EOF'
## What

Ingests ESPN's **core**-host play stream — ~1,540 events per match, down to individual
passes and tackles, **with pitch coordinates**. Two destinations: every byte to the
**private** R2 archive bucket (`R2_RAW_BUCKET`) as an immutable gzipped object, and the
~180-row analysable tier to Postgres.

## 🔴 Two facts in the briefing were wrong. Please read this section.

**1. Shot coordinates exist.** `docs/PRODUCT_ROADMAP.md` rejected xG because "not in the
ESPN payload", and heat maps because "no pass or touch coordinates exist in any response we
can reach". Both are true of the **site** host and false of the **core** host. Verified
2026-08-15 on `mex.1` event `401877018`:

```
Shot On Target: fieldPositionX 77.2  fieldPositionY 25
                fieldPosition2X 97.5 fieldPosition2Y 47.5
                goalPositionY 51.2   goalPositionZ 5.1
```

979 of 1,000 sampled plays on that match carried non-zero coordinates; 955 of 1,000 on
LaLiga `401882926`. **This has since been acted on**: the roadmap's rejection table no
longer contains xG, which is now committed epic **E9**
(`docs/superpowers/specs/2026-08-15-expected-goals-design.md`), and E6 has been rescoped.
This PR **persists** the geometry — it does not build the model. E9 is gated on this PR
landing, because a model cannot be trained on data we did not keep.

**2. `limit` caps at 1000 and degrades silently above it.** `limit=1000` → `pageSize=1000`,
`pageCount=2`. `limit=1001` → `pageSize=25`, `pageCount=62`, **no error**. The briefing
suggested `?limit=400`, which works but costs 4 round trips instead of 2. The source now
clamps to 1000 and **errors** if the returned page size is not what it asked for, because
otherwise a provider default change turns one ingest cycle into 62× the requests with
nothing in the logs.

**3. The retention boundary is the SEASON, not an age — and what survives is not what you
would assume.** Measured across dates and competitions:

| Match | Plays | Passes | Coord scale | Goal-mouth |
|---|---|---|---|---|
| Liga MX, 2026-07-17 (this season, 30 days old) | 1,491 | 610 | 0–100 | present |
| Liga MX, 2026-05-10 (last season) | 199 | 0 | **0–1** | **all zero** |
| Premier League, 2026-04-18 | 189 | 0 | **0–1** | **all zero** |
| MLS, 2025-08-09 | 198 | 0 | **0–1** | **all zero** |

A 30-day-old current-season match is intact; a four-month-old previous-season match is
not. So the deadline is **season end**, not a rolling window — urgent but schedulable.

And prior-season shots are **not** a free backfill: their coordinates are on a 0–1 scale
that appears **inverted** relative to the current frame (historical shots cluster at
x 0.02–0.49, current-season shots at 69–95 on 0–100), with `goalPositionY/Z` **zeroed on
every historical match sampled**. An earlier draft of this plan claimed past-season xG was
"probably still recoverable"; that was too optimistic and has been corrected. Whether the
frames reconcile is E9's T9.1.

## The measured retention window

Filled from `cmd/play-retention`'s output — see the table above and the
`ARCHITECTURE.md` section this PR adds. Re-run the probe at each season rollover; this is
provider behaviour, not a contract.

## Backfill (T7.13) — done, with numbers

`cmd/play-backfill` ran across all nine competitions:
`touchTier:true` on **<X>** matches, `touchTier:false` on **<Y>**. The second number is
exactly how much touch-level data was already gone before this shipped.

Prior seasons are deliberately not attempted: their touch tier is unrecoverable and their
shot geometry is in a frame we have not yet reconciled.

## Design decisions worth reviewing

- **`$ref`s are parsed, never fetched.** A play's team, athlete and position are `$ref`
  URLs. ~1,500 plays × 2–3 refs = ~4,500 requests per match against a keyless API. `RefID`
  pulls the trailing numeric id out of the URL, and there is a grep in the plan's gate that
  fails if a `$ref` ever reaches an HTTP client.
- **Athletes resolve with one query, and never mint.** `ResolveKnownPlayers` hits
  `player_external_ref` once per match. `Store.Player` is deliberately *not* used: it
  creates on a miss, and a stream that identifies people only by `$ref` would mint a
  nameless person per unrecognised athlete. An unknown athlete gets `player_id = NULL` and
  the play is still stored — it happened.
- **Touch events go to R2 only.** Rowing them is ~35M rows and ~5GB of billed Neon storage
  per season to serve pass networks and heat maps the roadmap rejects. The bytes are kept,
  so promoting them later is a re-process. Pleasingly, the Postgres tier is almost exactly
  the tier ESPN itself retains.
- **R2 is written before Postgres.** The bytes are irreplaceable; rows can be rebuilt from
  them and they cannot be rebuilt from rows.
- **A second R2 client, for the second bucket.** The archive goes to the **private**
  `R2_RAW_BUCKET`, not the public CDN bucket. It could not reuse `assets.Mirror`:
  `FromEnv`/`New` require `R2_PUBLIC_BASE_URL` and validate it as a plain HTTPS origin, and
  a private bucket has no public URL *by design*. Rather than feed the validator a dummy
  value — which would leave a plausible-looking CDN origin in the config for someone to
  later serve from — client construction is split out of the public-URL concern and
  `assets.Archive` is its own type. The public mirror's behaviour is unchanged and its
  existing suite is part of the gate.
- **Archive key: `plays/{source}/{competition}/{season}/{providerEventID}.ndjson.gz`, one
  object per match.** Source first so a second provider cannot collide with ESPN's copy;
  competition and season next so a season is one listable/expirable prefix; **the provider's
  event id, not our canonical uuid**, so an object is identifiable from ESPN's own ids
  without the database that indexed it. One object per match because a match is the unit of
  reprocessing and pages are an artefact of whichever `limit` we sent — the same match is 2
  pages at `limit=1000` and 62 at the default. Gzipped NDJSON, one page object per line, so
  nothing is reshaped and a late page is a concatenation.
- **No bucket name appears in code or in the plan.** The env var names the role, the secret
  names the resource; there is a grep in the gate that fails otherwise.
- **A missing archive is a loud `Warn`, not a silent skip.** In the ingester it is
  non-fatal — a scoreline still beats an archive — but the log says the play stream is not
  being kept, because the alternative is a season quietly not being archived. In the
  **backfill** it is fatal: a tool whose entire purpose is keeping bytes must not report
  success with nowhere to keep them.
- **Fetched once, on the transition to finished.** A live match's stream is two pages every
  20 seconds — eighteen requests a minute per live match. The stream is complete at full
  time and ESPN keeps it for weeks.
- **`match_play_archive.touch_tier`** records whether an object ever contained passes,
  because a re-processing run six months on cannot re-derive it — it would find none and
  conclude the parser is broken.

## Still absent, confirmed

No xG values (only the inputs), no injuries, no transfers, no physical data. Nothing here
is designed for them.

## Testing

- `go build ./...`, `go test -race ./...`, `go vet ./...` clean (Docker running).
- Two recorded fixtures on purpose — a fresh match (1,542 plays, `pageCount=2`) and a pruned
  one (175, zero touch events, coordinates intact) — so the mapper is tested against both
  worlds it will meet.
- Pagination, the page-size guard, empty streams, `(0,0)` → NULL, the Postgres/R2 tier
  predicate, upsert idempotency across three writes, unknown athletes staying unattributed
  without minting, and the archive ledger's `touch_tier` upgrade.

Plan: `docs/superpowers/plans/2026-08-15-ingester-play-stream.md`
EOF
)"
```

- [ ] **Step 7: Stop.** Do not merge — that is the user's call.

---

## Self-review notes

- **What this plan is really about.** Not the schema — the schema is easy. It is about two
  numbers: ~4,500 (requests per match if you follow `$ref`s) and the retention window
  (unknown until Task 1 runs). Both are called out where the code that depends on them
  lives, not only here.
- **Ordering.** Task 1 (probe) is first by intent even though it runs in Task 5 Step 6,
  because framing the question before the schema is what stops the schema encoding a guess.
  Task 7 (backfill) is last in the file but is the most time-critical thing in it; if the
  branch is going to sit in review, run Task 7 against production first.
- **Naming consistency.** `RefID` (Task 3) is used in `MapPlays` (Task 4) and grepped for
  in the gate (Task 8 Step 4). `Analysable` (Task 4) is the single place the Postgres/R2
  split is decided and is called once, in `capturePlays` (Task 6). `HasTouchTier` (Task 4)
  is written to `match_play_archive.touch_tier` (Task 6) and read by the backfill's log line
  (Task 7).
- **Ordering hazard.** `store.MatchIdentity` gains `HomeTeamSourceID`/`AwayTeamSourceID` in
  Task 6 Step 5. Every construction site of that struct — in the resolver and in
  `runner_test.go` — must set them, or plays will resolve to no team at all and the
  `team_id` column will be uniformly NULL with every test still green.
- **Second ordering hazard.** Task 5 Step 4b refactors `assets.New`/`assets.FromEnv`, which
  the **already-shipped crest mirror** depends on. Its existing suite must pass unchanged
  before Step 4c is written; the split is only correct if the public path is untouched. A
  `FromEnv` that returns a mirror where it used to return `(nil, false, nil)` has lost a
  condition from the completeness gate, and the ingester would then try to mirror crests to
  a CDN origin it does not have.
- **Global constraint added late, worth repeating.** The archive bucket is **private**. No
  code path may derive a URL for an object in it, and `assets.Archive` deliberately has no
  `BaseURL()` — which is also why it is not folded into the ingester's `crestMirror`
  interface.
- **The thing most likely to be got wrong.** Calling `Store.Player` instead of
  `ResolveKnownPlayers`. It compiles, it passes a naive test, and it quietly creates tens of
  thousands of nameless player rows while making ~1,500 round trips per match.
</content>
