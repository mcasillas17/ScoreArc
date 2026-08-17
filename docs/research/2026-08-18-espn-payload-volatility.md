# ESPN payload volatility — an empirical audit

**Research date: 2026-08-17/18.** All timestamps below are UTC. Samples were taken with `curl`
(ESPN's WAF 403s Python's `urllib` and spoofed browser User-Agents from this host — plain `curl`'s
default UA works) and diffed field-by-field with a recursive JSON differ. Raw samples and diff
scripts live outside the repo; every number in this report is reproducible from them but they are
not checked in.

**Method actually run:** 3 fetch rounds per endpoint, at 08:03:58, 08:13:39, and 08:22:52 UTC on
2026-08-17 (≈9 min and ≈19 min gaps), across 26 targets spanning a finished match, a
penalty-shootout finished match, two scheduled (pre-kickoff) matches, four scoreboards, two
standings tables, two teams/rosters, and one athlete's three profile endpoints. **No match in any
of the nine tracked competitions was live at any point during the audit window** — see
[Caveats](#6-caveats) for exactly what that means for the win-probability and in-play questions.

---

## 1. Executive summary

1. **The ingester already does the single biggest thing right, and this audit's data confirms it
   was the correct call.** `backend/ingester/matches.go:159-163` and `schedule.go:23-26` stop
   fetching a match's summary/plays/officials/odds entirely once `FinalizedAt` is set — plays,
   officials, and final odds are captured exactly once, at finalization
   (`matches.go:298-312`, comment: *"bounds the core API to roughly two requests per match"*).
   Two finished matches (one straight full-time, one decided on penalties), sampled 3× over 19
   minutes, were **byte-for-byte identical on every single field** — scorers, boxscore, rosters,
   commentary, key events, shootout detail, h2h, form, and even the embedded `news` array. There
   is nothing left to trim here; the design is already zero-waste for finished matches.

2. **Season-cumulative fields hide inside otherwise-static "roster" and "athlete" payloads, and
   deserve a different write cadence than identity fields, even though they arrive on the same
   endpoint.** A roster entry's identity (`dateOfBirth`, `citizenship`, `birthPlace`, `height`,
   `weight`) was 100% stable across all samples, but the same object also carries `injuries`,
   `status`, and `transactions` — fields that plausibly change daily and are *not* covered by the
   ingester's existing once-per-day squad refresh being "enough," because squad *membership*
   (who's on the roster) and player *status* (injured/suspended) are different questions answered
   by the same call. This audit found zero movement in the 19-minute window (all sampled Arsenal
   players were `Active`, no injuries) — not because the fields are immutable, but because nothing
   newsworthy happened to this squad in 19 minutes. Not evidence of a longer-timescale conclusion;
   see §4.

3. **The clearest, highest-confidence "always/frequently changing and must be excluded from any
   hash" field is a wrapper timestamp already living inside two endpoints the ingester calls
   verbatim today** — `roster.timestamp` (changes on literally every fetch, confirmed at a 25-second
   gap) and `statistics.timestamp` (changes on a ~9-10 minute cache cycle, confirmed 3×). Neither
   is read by any Go mapper (`roster.go`, and the per-event `statistics` endpoint isn't called by
   the backend at all today — see §6), so today they cost nothing. But they are exactly the kind of
   field that would make a naive `sha256(response body)` comparison report "changed" on every poll
   of a match that has not actually changed. See §3 for the full list.

---

## 2. Field-volatility tables

Legend: **immutable** = zero observed change across all samples and expected never to change post
data-entry; **slow** = expected to change on a timescale of days-to-weeks (transfers, injuries,
squad list), zero observed change in this session's window; **live** = observed to change within
the ≤19-minute audit window; **always-changes** = changed on every single fetch regardless of
underlying data, confirmed at the shortest interval tested (25s).

### 2.1 `summary?event={id}` (site.api.espn.com) — finished matches

Two events sampled: `401863622` (Santos–Philadelphia Union, Leagues Cup, straight FT) and
`401871783` (Tigres–Toluca, CONCACAF Champions Cup, FT-Pens). 3 samples each, 08:03:58 → 08:22:52.

| Field / section | Class | Evidence |
|---|---|---|
| `header.competitions[0].competitors[].score`, `boxscore`, `keyEvents`, `commentary`, `rosters`, `shootout`, `odds` (embedded pickcenter array), `gameInfo.venue`/`attendance`, `lastFiveGames`, `headToHeadGames`, `leaders`, `standings` snapshot | **immutable** | 0 of 0 differing leaf paths across all 3 samples on both events — full recursive diff of the entire document, every field, every sample pair. |
| `meta.lastUpdatedAt` | **immutable (post-finalization)** | Identical (`2026-08-14T01:00:32Z` for the Leagues Cup match) across all 3 samples, 19 min apart. Not re-stamped on read. |
| `news.articles[]` (headline, images, lastModified, published) | **immutable in this sample** | 0 diff for both finished events. Contrast with the *scheduled* Real Madrid match (§2.3), where the same subtree changed within 9 minutes — this field's volatility tracks newsroom activity around the story, not the match/endpoint itself, and happened to be quiet for both sampled finished events. Not proof it's structurally frozen. |

**Answer to Q1 (does a finished match's summary ever change after full time?):** not observed to,
across 2 events × 3 samples × 19 minutes, on every field including the ones (news) most likely to
churn. Combined with the ingester's existing finalize-and-stop design (§1, finding 1), a finished
match's summary is confirmed dead weight to re-fetch — which the ingester already doesn't do.

### 2.2 Per-event `statistics?event={id}` (site.api.espn.com)

| Field | Class | Evidence |
|---|---|---|
| `stats[].leaders[]`, `league` block, all numeric team/player stat totals | **immutable** | 0 diff (aside from `.timestamp`, below) across both finished events, all 3 samples. |
| `.timestamp` (top-level) | **always-changes, but on a CDN cache cycle, not per-request** | `08:03:59Z → 08:04:24Z → 08:13:40Z` across fetches made at `08:03:58 / 08:13:39 / 08:22:52`. The served value lags the actual request by up to ~9 minutes and is *not* the true fetch time — it looks like an edge-cache regeneration stamp. It still changes on a large fraction of polls and must be excluded from any hash. |

Note: the Go backend does not currently call this per-event path at all —
`StatisticsURL` (`backend/shared/espn/client.go:69-75`) builds a season-level `/statistics` query,
not `?event=`. Sampled here because the task's endpoint list specified it; flagging the mismatch
in case it's a latent TODO rather than a deliberate omission.

### 2.3 `summary?event={id}` (site.api.espn.com) — scheduled (pre-kickoff) matches

`esp.1` event `401882923` (Elche–Deportivo, kickoff ~11h after first sample) and `mex.1` event
`401877011` (León–Necaxa, kickoff ~17h after first sample).

| Field | Class | Evidence |
|---|---|---|
| `odds[].homeTeamOdds.moneyLine` / `awayTeamOdds.moneyLine` / `drawOdds.moneyLine` (the exact fields `mapWinProbability` in `summary.go:845` reads) | **live, but quiet in this window** | esp.1: `130 / 255 / 205.0` at 08:03:58, identical at 08:13:39. No movement in a 9-minute window sampled ~11 hours before kickoff. mex.1: 0 diff on the whole odds block across the same window. |
| `meta.gameState` | immutable (`"pre"` throughout, as expected) | 0 diff |
| `news.articles[0]` (esp.1 only) | **live** | A new/reordered article appeared between 08:03:58 and 08:13:39 — every field under `news.articles[0].images[]` shifted position (a new lead image was published), `lastModified`/`published` moved to `08:03:45Z`. This is normal newsroom activity, unrelated to match state, and not read by `MapSummary` (confirmed: `rawSummary` in `summary.go` has no `News` field). |

**Odds pre-kickoff, for the record (Q3 partial answer — see full answer in §2.5):** `open`
(the true opening line) already differed from `current` at first sample — e.g. esp.1 away
moneyline `open +225` vs `current +255` — confirming the market moves *before* the ingester
would even see it, well before kickoff. `close` was `null` for both scheduled matches (not yet
set — it's written at kickoff), consistent with `match_odds`'s schema comment that `open`/`close`
are "fixed" facts distinct from the sampled `current` line.

### 2.4 Scoreboards, standings, teams, rosters

| Endpoint / field | Class | Evidence |
|---|---|---|
| `scoreboard` (eng.1/esp.1/mex.1/concacaf.leagues.cup) — event list, status, scores | **immutable in this window** | 0 diff across all 3 rounds for esp.1/mex.1/lcup. eng.1 had exactly 1 diff (below). |
| `scoreboard_eng1: events[0].competitions[0].tickets[0].numberAvailable` / `team_arsenal: team.nextEvent[0].competitions[0].tickets[...]` | **live** | `numberAvailable` `3017 → 3016`, `totalPostings` `1296 → 1295` over 19 minutes — secondary-market ticket-listing counters for an upcoming match, genuinely ticking down in near-real time. Not consumed by any current mapper (roster/team mappers don't reference `tickets`), but present in the raw payload and would defeat a content hash on the `teams/{id}` or `scoreboard` endpoints for any team with an upcoming home game. |
| `standings` (usa.1, eng.1) — `children[].standings.entries[].stats` | **immutable in this window** | 0 diff, both leagues, all 3 rounds. Expected: standings only change when a match finishes, and no tracked competition had a match conclude during the ~19-minute window. |
| `team.logos[].lastUpdated`, `standings…entries[].logo[].lastUpdated`, `league.logos[].lastUpdated` (all endpoints) | **immutable** (initially flagged as suspicious, then ruled out) | These looked like generated-at timestamps by name; every one of them was byte-identical across all diff pairs. They only change when ESPN actually swaps a crest asset — legitimate slow-changing metadata, not a hash hazard. Listed here to save the next person from re-suspecting them. |
| `teams/{id}/roster` — identity fields (`dateOfBirth`, `citizenship`, `citizenshipCountry`, `birthPlace`, `height`, `displayHeight`, `weight`, `displayWeight`, `position`, `jersey`) | **immutable in this window / slow by nature** | 0 diff, all 29 Arsenal + all Barcelona athletes, all 3 rounds. |
| `teams/{id}/roster` — `injuries[]`, `status`, `transactions` (per-athlete) | **slow, unmeasured beyond 19 min** | 0 diff observed (all `Active`, no injuries, for both squads sampled) — but this is a plausible-daily-change field by nature (injury news, suspensions) that happened to be quiet, not a field proven stable at any longer horizon. |
| `teams/{id}/roster` — `.timestamp` (top-level) | **always-changes, every single fetch** | `08:04:05Z → 08:04:32Z` at a **25-second** gap (Arsenal), and continuing to track exact fetch time at every subsequent round (`08:04:05 → 08:22:59`, `08:02:01 → 08:16:15` for Barcelona). This is the cleanest "always-changes" field found: it is the server's response-generation time, stamped fresh on every single call, live or not. Confirmed not read by `MapRoster` (`roster.go`). |

### 2.5 Odds — `/plays`, `/officials`, `/odds` (sports.core.api.espn.com), finished matches

| Field | Class | Evidence |
|---|---|---|
| `/plays?limit=1000` — every play, including `modified` per-play timestamp | **immutable** | 0 diff, both finished events, all 3 rounds, full-document diff (this endpoint returned 1000-1630KB documents; still byte-identical). |
| `/officials` | **immutable** | 0 diff, both finished events, all 3 rounds. Referee assignment for a completed match cannot change; the ingester already captures this once at finalization (`matches.go:298-312`). |
| `/odds` — `open`/`close`/`current` per provider | **immutable (current == close, frozen)** | For the finished Leagues Cup match: away moneyline `open +500 → close +280 → current +280`; home `open -235 → close -125 → current -125`. **`current` already equals `close` and neither moved across 19 minutes / 3 samples.** This directly answers Q3 for the post-finalization case: odds do not move after the match is decided; `current` locks to whatever the line was at kickoff (or, if in-play movement happened during the match itself, wherever it ended — see caveat below) and then holds. |

**Answer to Q3 (do odds change after a match finalizes?):** No — `current` was already frozen and
identical to `close` for both finished events, unchanged across 19 minutes of sampling. **Caveat:**
this proves *post-finalization* odds are dead weight to re-fetch (which matches the ingester's
existing one-time capture at finalization). It does **not** by itself prove `current` never moved
*during* the match (kickoff → full time) — no live match was available to observe that transition
directly; see §6.

### 2.6 Athlete profile endpoints (David Raya, id 196176, eng.1)

Sampled all three variants named in the task, though the backend today only calls `/bio`
(`AthleteBioURL`, `client.go:86-88`) — the base `common/v3/athletes/{id}` and `/overview` paths
are not currently fetched by the ingester at all.

| Endpoint | Field | Class | Evidence |
|---|---|---|---|
| `/bio` | `teamHistory[]` (club, seasons string) — the only field `MapAthleteBio` reads | **immutable in this window** | 0 diff, all 3 rounds, 19 minutes. |
| `common/v3/athletes/{id}` | `firstName/lastName/displayHeight/displayWeight/displayDOB/citizenship/jersey/position/team` | **immutable in this window** | 0 diff, all 3 rounds. |
| `common/v3/athletes/{id}` | `statsSummary` | **immutable in this window** | 0 diff — but this is a season-cumulative field by nature (like roster's stats), just quiet because no match was played in the window. |
| `/overview` | `statistics`, `nextGame`, `gameLog` | **immutable in this window** | 0 diff across all 19 minutes. |
| `/overview` | `news[]` | **live, and structurally dangerous for hashing** | A single new/reordered article between round 1 and round 3 produced **2087 differing leaf paths** in a naive positional diff — every index in the `news` array shifted by one, cascading through every nested field (author bios, image dimensions, category tags) of every subsequent article. This is a methodology note as much as a data point: list-reordering under positional diffing manufactures the appearance of hundreds of "changed fields" from one new article. A real implementation must either diff by article `id` (not index) or exclude `news` from comparison entirely — the latter is simpler and correct here since no mapper reads it. |

**Answer to Q5 (do athlete bios/profiles change within a season?):** Not observed to, on any field
actually mapped into the database, across 19 minutes. This is consistent with — not a stronger
claim than — the ingester's own 30-day bio-refresh TTL (`bioTTL`, referenced in
`backend/migrations/0012_player_bio.up.sql`'s comment and confirmed callable at
`ingester/bio.go`'s `refreshBios`), which already assumes bios are stable for a month. This audit
did not run long enough to independently confirm the 30-day figure; it only confirms the floor
(zero change in 19 minutes) is consistent with that assumption, not that 30 days is precisely
right.

---

## 3. Fields to exclude from any content hash

Exhaustive list of fields observed to change independent of any real change to match/player/team
data, across the endpoints sampled in this audit:

| Field path | Endpoint(s) | Behavior |
|---|---|---|
| `.timestamp` (top-level) | `site.api.espn.com/.../teams/{id}/roster` | Changes on **every single fetch** — confirmed at a 25-second gap. This is the response's own generation time, not a data timestamp. |
| `.timestamp` (top-level) | `site.api.espn.com/.../statistics?event={id}` | Changes roughly every ~9-10 minutes (CDN cache-regeneration artifact), independent of whether the underlying stats changed (they didn't, in 3 samples). |
| `meta.lastUpdatedAt` | `site.api.espn.com/.../summary?event={id}` | Did not change in this audit (finished matches only, already stable), but its name and position (payload-wrapper metadata) mark it as the same class of field as the two above — **exclude preemptively** even though no live/recent match was available to catch it moving. |
| `news.*` (entire subtree: `articles[]`/`news[]`, incl. nested `images[]`, `authors[]`, `categories[]`, `lastModified`, `published`, `nowId`, `dataSourceIdentifier`) | `summary?event={id}`, `common/v3/athletes/{id}/overview` | Newsroom-driven, unrelated to match/player state; changed within a 9-minute window on an actively-covered team. Also the field most likely to defeat positional-array diffing (§2.6) even when nothing about the *match* changed. No current mapper reads this subtree — safe to exclude wholesale. |
| `videos[]` (`lastModified` and siblings) | `summary?event={id}`, `common/v3/athletes/{id}` | Same class as `news` — editorial content, not match state. Not read by any mapper. |
| `team.nextEvent[].competitions[].tickets[]` (`numberAvailable`, `totalPostings`) | `teams/{id}`, `scoreboard` | Secondary-market ticket counters, observed decrementing in near-real time for an upcoming match. Not read by any current mapper but present in the raw body of two endpoints the ingester already calls. |

**Not on this list, despite superficially matching a "generated-at" naming pattern:**
`logos[].lastUpdated` (appears on every team/league object across every endpoint sampled) — this
is a genuine crest-asset-swap timestamp, byte-identical across all samples in this audit. Including
it in an exclusion list would be over-broad; it should participate in the hash normally.

---

## 4. Recommended re-fetch / re-write cadence per endpoint

| Endpoint | Current behavior (as implemented) | This audit's evidence | Recommendation |
|---|---|---|---|
| `summary`/`plays`/`officials`/`odds` for a **finished** match | Already stopped entirely at finalization (`FinalizedAt`), captured once (`matches.go:159-163, 298-312`) | 0 diff across 2 events × 3 samples × 19 min, every field | **No change — this is already correct and this audit is the confirming evidence.** |
| `summary` for a **live** match | Polled every 20s | **Unmeasured** — no live match available (§6) | Cannot recommend a change without live data. See §5 for the closest available proxy. |
| `summary`/`odds` for a **scheduled** match, far from kickoff | Polled every 5 min (slow tick) | 0-20 diffs (mostly `news`) over 9-19 min, 11-17h before kickoff; the actual odds market (`odds[].*.moneyLine`) was flat in this window | 5-minute cadence is already more frequent than needed this far out; **not recommending faster**. Whether cadence should tighten in the final 1-2 hours before kickoff is unmeasured — no sample was taken close enough to kickoff to know if the market accelerates. |
| `teams/{id}/roster` (squad membership + identity) | Refreshed once/day/team, budgeted, 30-min retry backoff (`ARCHITECTURE.md:122`) | 0 diff on all identity/membership fields, 19 min, 2 full squads | Once/day is already conservative relative to what's observed; **no change recommended.** The `injuries`/`status`/`transactions` sub-fields on the same payload are a distinct concern from membership — worth a follow-up specifically watching a squad with an active injury story, which this window did not have. |
| `athletes/{id}/bio` (team history) | Refreshed on 30-day TTL, budgeted 20/tick (`ARCHITECTURE.md:124`) | 0 diff, 19 min | Consistent with a 30-day TTL; this audit cannot confirm 30 days is the *right* number (would need a multi-week observation), only that it's not obviously too long. |
| `standings` | Snapshotted with `captured_on` (day) dedup key | 0 diff, both leagues, 19 min, no matches concluded in-window | Cadence is already tied to "once per day is enough since standings only move when a match ends" — this audit's zero-movement result is exactly what that design predicts, not new information. A tighter cadence would only matter within minutes of match completions, which this window didn't cover. |
| `win_prob_snapshot` (derived from `summary`'s embedded `odds[].moneyLine`, live matches only) | Written every live poll (20s), collapsed to one row/minute via `(match_id, captured_at)` unique index (`0005_win_prob_snapshot_idempotency.up.sql`) | **Unmeasured live**; pre-match proxy was flat over 9 min, 11h before kickoff | See §5 — the 1-minute bucketing already built into the schema is a defensible choice given the market-implied nature of the value, but this audit cannot confirm 20s poll / 1-minute bucket is the right ratio without live data. |

---

## 5. The win-probability answer

**Unmeasured — no live match in any of the nine tracked competitions (`eng.1`, `esp.1`, `ita.1`,
`ger.1`, `fra.1`, `mex.1`, `usa.1`, `concacaf.leagues.cup`, `concacaf.champions`) was available at
any point during this audit.** Every scoreboard checked returned only `pre` (scheduled, hours to
days out) or `post` (already finalized) events — see the raw scoreboard sample manifests. Per the
task's own instruction, this is reported as unmeasured rather than extrapolated from a finished
match.

What this audit *can* say, with the caveat that it is a proxy and not a substitute:

- `win_prob_snapshot`'s value is not an ESPN-native "win probability" field — it's **derived** in
  `mapWinProbability` (`backend/shared/espn/summary.go:845-869`) from the *same* three-way
  moneyline fields (`summary.odds[0].{homeTeamOdds,awayTeamOdds,drawOdds}.moneyLine`) sampled in
  §2.3, with the bookmaker margin normalized out. So "how fast does win probability move" and "how
  fast does the moneyline move" are the same question for this codebase.
- The one pre-match window observed (esp.1, `401882923`) showed **zero movement** in those three
  moneyline fields over 9 minutes, sampled ~11 hours before kickoff (`130 / 255 / 205.0` at both
  08:03:58 and 08:13:39).
- Architecture doc `ARCHITECTURE.md:129` states pre-match line movement is *deliberately* not
  recorded ("a scheduled fixture is polled on slow ticks all season and would produce ~288 rows a
  day describing a market nobody is watching yet") — consistent with what was observed: the
  pre-match market barely moves on a sub-hour timescale this far from kickoff.
- None of this speaks to in-play movement, which is the actually interesting regime (goals,
  red cards, and injury-time swings are exactly when win probability is supposed to move fastest,
  and exactly what a 20-second poll is trying to catch). **No data was collected on this.**

**No sampling-interval recommendation can be responsibly given without live data.** The honest
next step is to re-run this audit's `summary` sampler at 20-30 second intervals against a live
match's `odds[].moneyLine` fields the next time one is in progress in a tracked competition
(the closest upcoming kickoffs at audit time were `esp.1` `401882923` in ~11h and `mex.1`
events in ~17-19h), and compare against the existing 1-minute snapshot bucket to see whether it
over- or under-samples the real rate of change.

---

## 6. Caveats

- **No live match was observed.** This is the single largest gap. Every claim about in-play
  behavior — win-probability movement rate, whether `odds.current` moves during play (only
  pre-kickoff movement and post-finalization stability were directly observed), live-score/clock
  update frequency, whether `plays`/`commentary` arrays grow field-by-field or in batches — is
  unmeasured. The nearest tracked-competition kickoffs at audit time were 11-19 hours away, outside
  this session's practical window.
- **Sample depth is 3 rounds over 19 minutes**, not the days/weeks needed to directly observe
  roster changes, transfer-window activity, injury updates, or the true bio-refresh half-life.
  Every "slow" classification in §2 is inferred from *zero change in 19 minutes* plus the
  ingester's own existing TTL assumptions (30-day bio, daily squad) — it is not independent
  confirmation of those specific numbers.
- **The audit window (2026-08-17, ~08:00-08:25 UTC) fell in a quiet moment for the tracked
  leagues**: most of eng.1/esp.1/ita.1/ger.1/fra.1's 2026-27 seasons had not kicked off yet (all
  scoreboard events were `pre`), and Leagues Cup / CONCACAF Champions Cup had already concluded
  their sampled fixtures days earlier. A squad with an active injury story, a match nearer
  kickoff, or a competition mid-transfer-window would likely show more movement in the "slow"
  category than this window captured.
- **Positional list-diffing overstates change when order shifts** (§2.6) — the 2087-path diff on
  `/overview`'s `news[]` was one new article, not 2087 real changes. Any hash/diff implementation
  built from this report's findings should diff collections by stable id, not by array index, or
  exclude order-sensitive editorial arrays (`news`, `videos`) entirely, which this report already
  recommends doing regardless.
- **The per-event `statistics?event={id}` endpoint isn't currently called by the backend** (it
  calls a season-level `/statistics` instead — `client.go:69-75`). Findings for it are reported
  because the task specified this endpoint, but they may not be directly actionable against
  today's ingester code.
- **Single team/athlete sample.** Roster/bio findings rest on two clubs (Arsenal, Barcelona) and
  one athlete (David Raya) chosen for likely transfer-window relevance, not a random or
  stratified sample. A club mid-transfer-saga could look very different.
