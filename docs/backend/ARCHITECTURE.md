# ScoreArc Backend — Architecture

Self-contained design reference for the backend. The full original spec is
`docs/superpowers/specs/2026-07-22-backend-api-phase1-design.md` (its GCP infra
section is superseded by the Fly+Neon+R2 pivot; everything else here matches).

---

## 1. System diagram

```mermaid
flowchart LR
  ESPN["ESPN keyless public API"]
  Ingester["Go ingester<br/>private worker"]
  DB[("Neon Postgres")]
  Reader["Go reader<br/>public /v1 API"]
  R2["Cloudflare R2 + CDN"]
  Web["Next.js on Vercel"]
  Other["LED boards + third parties"]

  ESPN -->|"matches · standings · bracket · detail · scorers"| Ingester
  Ingester -->|"upsert with writer role"| DB
  Ingester -->|"mirror crests"| R2
  DB -->|"SELECT-only role"| Reader
  ESPN -->|"news only"| Reader
  Reader --> Web
  Reader --> Other
  R2 --> Web
```

- **Live vs historical is a first-class axis.** Current state is hot/mutable
  (upserted). A finished match is frozen (`finalized_at`) and immutable →
  historical results accrue for free. Time-series snapshots are append-only
  (Phase 2). The ingester behaves accordingly (upsert while live; write-and-freeze
  on finish).

---

## 2. The seam (why this is low-risk)

The frontend reads through **one interface**, `DataStore` (`src/server/data/store.ts`):

```ts
interface DataStore {
  getMatches(rc): Promise<Match[]>
  getStandings(rc): Promise<Group[]>
  getBracket(rc): Promise<BracketRound[]>
  getMatchSummary(rc, eventId, homeId, awayId): Promise<MatchSummaryData>
  getTopScorers(rc): Promise<TopScorer[]>
  getNews(rc): Promise<NewsArticle[]>
}
```

Today it's ESPN read-through + TTL cache. Phase 1 adds a second implementation,
`apiStore`, that calls our reader. **No page or component changes** — only the
seam swaps (slice 1d, behind a `DATA_SOURCE` flag with ESPN fallback). The
reader's JSON must deserialize into the existing types in
`src/server/data/types.ts`.

---

## 3. Database schema (Neon Postgres)

**Every id in this schema is one ScoreArc mints — no provider is the identity
authority.** Curated sets are slugs (`competition.id` = `premier-league`,
`team.id` = `eng-manchester-united` | `nat-mex`), machine-generated sets are
UUIDv7 (`match.id`, `player.id`). Provider ids live **only** in the
`*_external_ref` crosswalk tables, so a second source describes the same entity
instead of duplicating it. `competition_id`/`season_id` are still the **text
config keys** from `competitions.ts` (config stays the source of truth), but
they are now materialised as real `competition`/`season` rows that the other
tables reference. Rich per-match detail is **jsonb** (lossless, serves the
existing frontend types verbatim). **No `news` table** (proxied live).
`team.crest_url` holds **our R2/CDN URL**, and the team seed never overwrites a
stored crest — it only fills an empty one, so re-seeding on every start cannot
revert a mirrored crest to a provider hotlink. Full rationale:
`docs/superpowers/specs/2026-08-12-canonical-identity-design.md`.

> **Bracket note (important — the frontend does NOT derive brackets from the
> matches feed today).** Currently `DataStore.getBracket` fetches a *separate*
> ESPN bracket scoreboard (`bracketUrl(slug, season.bracketDatesRange)`) and runs
> `mapBracket` (`providers/espn-bracket.ts`), which has non-trivial winner +
> shootout logic. In our backend there is **no bracket table** — the reader
> rebuilds `BracketRound[]` from `match` rows — but that only works if the
> **ingester persists knockout matches with `match.round` set to the slug
> vocabulary in each season's `knockoutRounds`** (`round-of-32 … final`) plus
> `winner_id` and shootout. So: port `mapBracket` to Go, **fixture-test it against
> `src/server/data/__fixtures__/espn-bracket*.json`**, and have the reader group
> `match` rows by `round` into `BracketRound[]`. (Leaf ordering lives in
> `competitions.ts`/`radialBracketModel.ts` on the frontend — correctly not in
> the backend.) See §10.

Migrations: `backend/migrations/0001_init.*.sql` establishes the canonical
entities, crosswalk, Tier-1, ops, roles/grants, durability columns, indexes, and
the original `match`/`match_detail` history guards; `0002_snapshots.*.sql`
establishes Tier-3. Forward migrations add the later history surfaces, with
`0021_finalization_invariants.*.sql` extending C1 ("immutable once final") to
the six remaining finalized-fact tables. The old pre-launch `0003`/`0004` were
folded into `0001` before deployment; the current migrations bearing those
numbers are newer forward migrations.

Backfills must finish before their finalization or archive seal is written.
The bounded operator correction path for the six migration-0021 tables is
documented below. The pre-existing `match` and `match_detail` guards remain
untouched and do not use that escape hatch.

### Canonical entities (ids ScoreArc mints)
- **competition**(id PK `text` slug, name, short_name, kind[`league|cup`], country, updated_at)
- **season**(PK (competition_id→competition, id `text` e.g. `2026-27`), label, has_bracket)
- **team**(id PK `text` slug, kind[`club|national`], name, short_name, abbr, country, crest_url, **provisional**, updated_at) — identity is curated in `backend/config/teams.seed.json`; a team the seed does not carry is minted `provisional` (`prov-espn-<id>`) so ingestion never blocks, and a partial index lists those awaiting curation.
- **player**(id PK `uuid` v7, full_name, known_as, birth_date, nationality, position, updated_at) — resolved from the provider's athlete id via `player_external_ref`, never from a display name: two players who share a name must not become one person. Note there is deliberately **no `team_id`** — a player's club is recorded per `appearance`, so a transfer needs no special handling.

### Source crosswalk (the only place provider ids live)
- **competition_external_ref** / **team_external_ref** / **player_external_ref** /
  **match_external_ref**(PK (source, source_id), *canonical id*→entity ON DELETE CASCADE, first_seen_at, last_seen_at) — the PK is `(source, source_id)`, not the canonical id, so **many** provider ids may map to **one** entity, which is exactly what merging duplicates produces. Each has an index on the canonical id for the reverse lookup.

### Tier 1 — current state (hot, upserted by the ingester)
- **match**(id PK `uuid` v7, competition_id, season_id, round, kickoff, **kickoff_date** (generated, UTC date), state[`scheduled|live|finished`], home_team_id→team, away_team_id→team, home_score, away_score, minute, status_detail, status_name, winner_id→team, note, home_placeholder, away_placeholder, bracket_required, **finalized_at**, source, updated_at) — FK to `season(competition_id,id)`; **UNIQUE (competition_id, season_id, home_team_id, away_team_id, kickoff_date)** is the natural key that makes the same fixture from a second source resolve to one row; indexes on `(competition_id,season_id,kickoff)`, `state`, and unfinalized history. `updated_at` records the last persisted content change: an ingest that resolves to the same row does not refresh it.
- **match_detail**(match_id PK→match, scorers jsonb, cards jsonb, stats jsonb, win_probability jsonb, shootout jsonb, shootout_detail jsonb, lineups jsonb, videos jsonb, info jsonb, form jsonb, h2h jsonb, commentary jsonb, updated_at)
- **match_commentary**(PK (match_id→match, **seq** = ESPN's `sequence`), period, clock_value, clock_display, play_type, play_type_text, wallclock, text) — minute-by-minute commentary **with the structure `match_detail.commentary` drops** (T7.11). That jsonb column is unchanged and remains the reader's `MatchSummaryData.commentary` contract; it keeps `{minute, text}` only. This table adds guaranteed order (`sequence`), a numeric clock (`play.clock.value`, falling back to `time.value`; the recorded pre-match, kickoff, and match-end entries have an empty `time.displayValue`), the machine play type (`play.type.type`, so consumers need not regex English prose), and mutability (`match_detail` is frozen by `protect_finalized_detail` once a match finalizes). Rows are upserted and then tail-pruned like `match_event`; an **empty payload is a no-op, not a delete**, because commentary coverage varies by competition and has been observed at zero. Missing numeric provider fields remain SQL `NULL`, distinct from a measured zero. A failed write leaves a finished match unfinalized so the next cycle retries before freezing its detail. **Nothing here is parsed** — E6's shot-log parser is downstream and gated on T6.1's coverage probe.
- **standing**(PK (competition_id,season_id,team_id→team), group_id, group_name, rank, played, wins, draws, losses, goals_for, goals_against, goal_difference, points, advanced, source, updated_at) — `group_id`/`group_name` (e.g. "A"/"Group A") are nullable: populated for multi-group competitions (e.g. World Cup group stage), null for single-table leagues.
- **top_scorer**(PK (competition_id, season_id, **category**, rank), player, team_abbr, team_name, team_crest_url, goals, matches, source) — any season leaderboard, not only goals. `category` is `goals` | `assists`, both written from a **single** `/statistics` fetch (T7.8): `assistsLeaders` ships in the same response as `goalsLeaders`, 50 rows each, and was previously discarded. `category` is in the primary key because rank is only unique within a board. The reader's `/top-scorers` filters `category = 'goals'` to keep its existing contract. Team is denormalized (ESPN's stats give abbr/name/crest, no id). The table keeps its name deliberately — renaming it to `season_leader` would rewrite the reader's query, its OpenAPI schema and its fixtures for no behavioural gain.
- **appearance**(PK (match_id→match, player_id→player), team_id→team, starter, shirt_number, position) — who was in the squad, **including substitutes**; the `lineups` jsonb above keeps starters only because that is what the site renders. This is the table that makes "minutes played" computable.
- **match_event**(PK (match_id→match, **seq**), player_id→player NULL, team_id→team, type[`goal|own_goal|yellow|red|sub_on|sub_off`], minute, penalty, shootout, detail) — one row per player-action, so a substitution is two rows rather than one row with two players. `seq` is a deterministic ordinal, **not** a surrogate uuid: a live summary is re-fetched every 20s and a surrogate key would duplicate every goal on every poll. `player_id` is nullable because an event the provider reports without an athlete id still happened — we record it unattributed rather than inventing a player. `penalty` is a flag, not a type, so penalties stay inside `type = 'goal'`.
- **squad_membership**(PK (competition_id, season_id, team_id→team, player_id→player), shirt_number, position, source, updated_at) — who is in a squad, per season (T7.9). Season-scoped so a transfer is a second row rather than an overwrite. Refreshed **once per UTC day** from `/teams/{id}/roster`: nine competitions × ~20 clubs = ~180 requests, against ~52,000 if it ran on every slow tick. Successful teams are remembered independently; a failed team alone retries after 30 minutes. The team list comes from `standing`.
- **player_season_stat**(PK (competition_id, season_id, player_id→player), team_id→team, appearances, sub_ins, goals, assists, shots, shots_on_target, offsides, fouls_committed, fouls_suffered, own_goals, yellow_cards, red_cards, saves, goals_conceded, shots_faced, source, updated_at) — **the provider's** season aggregate, deliberately not derived from summing `appearance`. The two will disagree: ours covers only matches the ingester has seen, ESPN's covers the whole season and competitions we do not ingest. Keeping both makes the disagreement visible. All nullable — 8 of 35 roster athletes carry no statistics block at all — and a missing provider statistic remains SQL `NULL`, never a synthetic `0`.
- **player_team_history**(PK (player_id→player, team_source_id, seasons), team_name, ord, source) — career clubs from `/athletes/{id}/bio` (T7.10), on the **common/v3 host**. `team_source_id` is the provider's id and **not** a FK to `team`: a career spans competitions we will never curate. `seasons` is ESPN's own string (`"2025-CURRENT"`), stored verbatim because the vocabulary is undocumented. Fetched on a budget — only players with an `appearance`, 20 per slow tick, 30-day TTL via `player.bio_fetched_at`.
- **player** additionally carries **birth_date** and **nationality**, filled from the roster payload's ISO `dateOfBirth`/`citizenship`. Never from the per-athlete endpoint's `displayDOB` (`"23/9/2003"`), which is locale-formatted and ambiguous below the 13th.

### Tier 3 — time-series (created now, WRITTEN in Phase 2 via `emitSnapshots()`)
- **standing_snapshot**(id bigserial, competition_id, season_id, team_id→team, captured_at, rank, points, goal_difference, played) — append-only.
- **win_prob_snapshot**(id bigserial, match_id→match ON DELETE CASCADE, captured_at (minute bucket, UTC), observed_at (untruncated poll-start time), home, draw, away numeric(5,2)) — append-only, **WRITTEN** by the ingester since T7.6, for matches in state `live` only. `UNIQUE (match_id, captured_at)` collapses the 20-second live poll to one row per minute; same-minute conflicts update only when `observed_at` is at least as recent, so a delayed response cannot replace fresher data. The values are **market-implied** — the first betting provider's three-way moneyline with the margin removed, per `mapWinProbability` — and are not a ScoreArc forecast. Scheduled detail is now TTL-throttled (>24 hours to kickoff every six hours, 24 hours down to more than one hour hourly, and the final hour every slow tick), but pre-match snapshots remain deliberately out of scope: even 4–24 rows per day for every future fixture would accumulate an unused market curve. Postponed or suspended fixtures whose kickoff has passed remain in the final-hour band and continue at slow-tick cadence.

### Ops
- **ingest_run**(id bigserial, competition_id, kind, started_at, finished_at, ok, error) — observability. Beyond per-operation runs it also records the identity events a human has to act on: `provisional_team` (a club nobody has curated), `team_promotion` (a curation that could not complete), and `player_capture` (a match where the provider sent no athlete ids — without this, total capture failure and a match where nothing happened are the same empty table).
- **match_final_capture_status**(PK (match_id→match, kind[`officials|fixed_odds`]), attempt_count, last_attempted_at, retry_at NULL, completed_at NULL, last_error) — internal post-finalization capture ledger for additive enrichment that can succeed or fail independently of score/detail finalization. Officials and fixed odds each get one row per match; valid empty crews and no-market odds write **completed** rows with no fact rows, while failures persist the next retry time and last error. This table is operational only: the public reader is explicitly denied access, and the ingester gets `SELECT`/`INSERT`/`UPDATE` only — never `DELETE`.

### Roles (least privilege — enforces the read-only public path)
- `scorearc_reader` → **SELECT only** (the public reader connects as this).
- `scorearc_ingester` → SELECT/INSERT/UPDATE plus narrowly scoped DELETE for
  atomic standings/scorer replacement, curation promotion, participation,
  squad and career-history replacement, and audit retention (only it writes).
  Every DELETE grant is named table-by-table; `ALTER DEFAULT PRIVILEGES`
  deliberately does **not** include DELETE, so a new table that needs it must
  say so — a missing grant surfaces as a 42501 inside the ingester, which is how
  curation once shipped permanently broken.
- `ALTER DEFAULT PRIVILEGES` mirrors these so future tables inherit them.

### Finalized-history invariants (migration 0021)

Migration 0021 makes C1 ("immutable once final") a database invariant for
`appearance`, `match_event`, `match_commentary`, `match_play`,
`match_official`, and `match_odds`. It does not replace or modify the
pre-existing `match` and `match_detail` guards. The six tables cannot share one
blanket `finalized_at` rule because plays, officials, and final odds are
legitimately captured after the match finalization transition:

| Table | Seal | Rejected after the seal |
|---|---|---|
| `appearance` | `match.finalized_at` | `INSERT`, `UPDATE`, `DELETE` |
| `match_event` | `match.finalized_at` | `INSERT`, `UPDATE`, `DELETE` |
| `match_commentary` | `match.finalized_at` | `INSERT`, `UPDATE`, `DELETE` |
| `match_play` | matching `match_play_archive` ledger row | `INSERT`, `UPDATE`, `DELETE` |
| `match_official` | `match.finalized_at` | `UPDATE`, `DELETE` |
| `match_odds` | `match.finalized_at` | `UPDATE`, `DELETE` |

The play archive ledger is the play-stream completion marker: sealing
`match_play` at `finalized_at` would prevent the durable retry path from filling
rows after an R2 failure. Officials and odds leave `INSERT` legal so their
normal finalization-transition captures can add facts after `finalized_at`; a
later rewrite or deletion is still rejected. Fixed-odds retries created by
migration 0016 also converge if the row is identical except for `observed_at`:
the guard preserves the original value. A changed market fact is not a retry
and remains immutable.

Every migration-0021 rejection raises SQLSTATE `SA001`.
`store.IsImmutableViolation` recognizes that code through wrapped writer
errors. This class means **writer defect, not transient failure**: it must be
surfaced rather than retried. The classifier is available for that policy, but
no production caller uses it yet.

Curation gets one narrow exception: an `UPDATE` may repoint `team_id` away from
a row that is still marked provisional, provided no fact changes in the same
write. Repointing between curated teams, changing any other fact, or repointing
`player_id` remains blocked with `SA001`. There is also a pre-existing promotion
gap: `promoteProvisionalTeam` does not repoint `appearance.team_id` or
`match_event.team_id`. If either table still references the provisional team,
the promotion's final team deletion fails with FK SQLSTATE `23503`. Closing
that gap is **OUT OF SCOPE for T7.18**, rather than an implicit follow-up owned
by this invariant slice.

A deliberate correction to one of these six tables requires both explicit
intent and elevated table privilege. Use the direct DSN and a bounded,
explicit transaction as a migration owner or operator role that holds
`TRUNCATE` on the target table:

```sql
BEGIN;
SET LOCAL scorearc.allow_final_writes = 'on';
-- bounded correction to the sealed table
COMMIT;
```

The GUC alone is insufficient; the guard also checks `TRUNCATE`. The
least-privilege ingester must never receive that privilege, and database-owner
credentials must never appear in application configuration.

The final local measurement over three 50,000-row samples was **5.304
microseconds per guarded row**, below the 25-microsecond product budget. An
equivalent one-primary-key-probe reference trigger measured 4.832 microseconds,
so migration 0021 was **1.10x** the same-database control. Hosted runner classes
vary enough that the absolute budget is reported but cannot be enforced
portably; standard CI therefore requires the migration guard's median to remain
within **1.5x** of that interleaved control. `EXPLAIN (ANALYZE, BUFFERS)` confirms
the seal is the intended single `match_pkey` probe with two shared-buffer hits.

---

## 4. Ingester (slice 1b — implemented Go worker)

- Always-on (Fly `min_machines_running = 1`), **no public HTTP**.
- A dedicated direct/unpooled pgx connection holds a PostgreSQL advisory lock.
  Normal writes use `POOLED_DSN`; lease health is checked independently during
  each cycle so losing the singleton session cancels work and terminates.
- Active competitions poll every 20 seconds while any match is live and every
  five minutes otherwise. Slow cycles reconcile the current season, retry
  failed reconciliation after 30 minutes, and refresh successful reconciliation
  daily. Normal scoreboards use a rolling `-30d/+7d` window with foreign-season
  events filtered; full-season backfills reject season mismatches.
- Scheduled-match detail follows kickoff-aware cadence: more than 24 hours out it
  is re-fetched every six hours; from 24 hours down to more than one hour out it
  is re-fetched hourly; and at or inside the final hour it follows the five-minute
  slow tick itself. The final-hour band uses `slowTick`, not the age of
  `match_detail.updated_at`, because that timestamp is written after provider
  latency; an `age == 5m` threshold would skip the immediately following tick
  and turn a five-minute target into roughly ten minutes. A scheduled→live
  transition always re-fetches immediately, and a malformed kickoff fails open.
  The measured baseline was 82 candidates × 288 slow ticks = 23,616 ESPN summary
  requests and `match_detail` rewrites per day, with 0/82 details changed in the
  audit. The predicted ~692 requests per day (~97% reduction) is only a
  uniform-distribution estimate for future scheduled candidates; it excludes
  postponed or suspended fixtures with past kickoffs, which retain slow-tick
  cadence.
- Work is bounded to three competitions concurrently. Two successful empty
  polls are required before a competition becomes dormant; failed polls reset
  that sequence and preserve known live cadence.
- Provider ids are **resolved to canonical ids before anything is written**
  (`backend/shared/store/identity.go`). The ingester calls `Store.Team` and
  `Store.Match`: each looks `(source, source_id)` up in the crosswalk, falling back
  to the curated team seed or the `match` natural key. A team the seed does not carry
  becomes a `provisional` row rather than failing the poll — logged and recorded in
  `ingest_run` — and curation repoints its supported references instead of creating
  a duplicate. The current promotion helper does not repoint `appearance.team_id`
  or `match_event.team_id`; if either reference exists, full promotion fails closed
  with FK SQLSTATE `23503` (the T7.18 out-of-scope gap documented above). A match
  crosswalk hit is verified against the competition and season being ingested, so
  one provider event id cannot carry facts across competitions.
  `Store.Competition` and `Store.Player` exist for the same crosswalk but have no
  production caller yet: the ingester takes the competition from its own config
  (`comp.ID`), and player identity is written by the follow-on slice. The ESPN mappers
  still speak ESPN ids; nothing downstream of the resolver does.
- Current state is idempotently upserted. State cannot regress except
  live→scheduled for ESPN's explicit postponed or suspended status. Sparse payloads preserve
  known scores, winners, detail arrays, and bracket placeholders.
- Before writing an existing match, the ingester applies those preservation,
  finalization, and state-regression rules in memory and compares the resulting
  row with the values the match upsert would persist. It skips the SQL upsert
  when no content would change; absent provider numerics remain SQL `NULL`
  rather than becoming zero. This keeps `match.updated_at` meaningful and avoids
  generating dead tuples for stable fixtures without changing finalization or
  reader behavior. A production sample found 82 redundant updates per five-minute
  slow tick across 2,578 matches, so the stable case avoids approximately 23,616
  tuple writes per day. This is an ingester-only write-path optimization: the
  database finalization and state-regression protections still apply, and it
  requires no migration or reader/OpenAPI contract change.
- The durable unfinalized-match query orders candidates by `match.updated_at`
  and caps each pass at 500. Preserving timestamps on no-op rows has no paging
  consequence at or below that cap; with a theoretical backlog above 500,
  selection fairness across the full backlog is not guaranteed and the paging
  strategy should be revisited.
- Odds mapping is field-local at the PostgreSQL boundary: nested-string and
  flattened numeric spread/total values that would overflow `numeric(5,2)` after
  PostgreSQL-equivalent two-decimal rounding become SQL `NULL` only for that one
  field, so one malformed book cannot roll back another provider's rows.
- Unlike the frontend's legacy `post → finished` mapping, the ingester keeps
  unknown incomplete `post` statuses mutable (`live`) and maps postponed or
  suspended matches to `scheduled`; only provider-confirmed or explicitly
  terminal statuses become immutable history.
- Final match and detail data commit in one transaction. Database triggers make
  finalized rows immutable. Failed finals remain queryable through the
  unfinalized backlog; persisted `bracket_required` classification prevents a
  restart from losing knockout safety.
- Once a match finalizes, the ingester immediately attempts both additive
  full-time captures: officials and fixed odds. An explicit empty crew or a
  no-market odds response is a durable completion, not a missing row to retry.
- Bracket metadata is authoritative for knockout round, placeholders, and
  shootout winner. A bracket outage blocks only candidates still requiring that
  metadata; group-stage matches continue finalizing, while knockout candidates
  require confirmation from the current successful bracket response before
  immutable finalization.
- Standings and season-leader replacements are transactional. Standings replace
  independently of crest mirroring; empty or suspiciously partial payloads
  preserve the prior snapshot rather than deleting valid rows and remain
  retryable failures.
- Each goals/assists leader category mirrors crest URLs in its mapped in-memory
  board before persistence, then performs exactly one guarded transactional
  replacement per refresh. Empty categories still preserve existing rows. This
  ordering is safe because leader crest mirroring depends only on that board and
  the mirror cache/R2, never on persisted `top_scorer` rows. ESPN statistics
  responses carry unreliable season metadata, so leaderboard season scoping
  relies on the requested statistics URL rather than rejecting the payload's
  reported year.
- On the 300-row production `top_scorer` table, the former provider-write then
  mirrored-rewrite path caused +600/-600 tuple writes per slow tick
  (~345,600 writes/day) and briefly exposed provider hotlinks. The
  mirror-then-write invariant removes both the redundant pass and that window.
- Crest downloads allow only validated public HTTP(S) sources, enforce
  redirects/content type/size/deadline limits, and upload deterministic R2 keys.
- Every provider/store operation and global audit-pruning pass records an
  `ingest_run`. Old audit rows are pruned in bounded batches.
- Every slow tick also sweeps the durable final-capture backlog: at most 10 due
  officials/fixed-odds tasks per competition, each retried no more than once
  every 30 minutes. Because the backlog lives in Postgres, retries survive
  process restarts; once a kind completes it is never selected again. Officials
  retries refetch only officials. Fixed-odds retries refetch and rewrite only
  fixed open/close rows — they do **not** create a post-match current-line
  sample. These failures remain additive: they keep their own `officials`,
  `odds`, and `final_capture_backlog` telemetry, never block score/detail
  finalization, and do not change the existing live CURRENT-price sampling.
- `go run ./ingester -once` performs one complete slow reconciliation without a
  fixed whole-cycle deadline; individual operations remain bounded.

### Live write reduction policy
- `commentary`, `appearance`, and `event` tables converge the whole latest
  non-empty set in one set-based statement, write only changed rows, and prune
  retracted rows where the table contract allows it.
- Late commentary edits are caught because every keyed row is content-compared,
  not just the tail. Duplicate commentary sequences and duplicate canonical
  players are deduplicated before the set upsert, with the last occurrence
  winning, so SQLSTATE 21000 does not surface.
- Unmeasured provider stats stay SQL NULL. Appearance change detection compares
  the stored row to the effective post-COALESCE value, so missing stats neither
  erase known values nor trigger rewrites.
- Time-series sample writes are skipped only when both the minute bucket and the
  value repeat. A new minute with the same value, or a changed value in the same
  minute, still writes.
- Successful live sample audits are limited to once per (competition, kind) per
  five minutes; failures are recorded immediately.
- `player_capture` is emitted only when a participation write actually changes
  stored rows and there is an unidentified participant or event. A first payload
  with only unidentified participants that resolves to zero writable rows can
  produce no `player_capture` row.
- Measured regression baseline: 246 commentary statements for 36 lines over 12
  simulated ticks. Projected whole-match reduction: about 47,000 to about 2,090
  statements, and about 46,000 to about 1,400 tuple versions. These are
  projections, not production measurements.
- No migration was needed: no column, table, index, constraint, or grant changed,
  and the existing table keys and grants already support this.
- Provider in-play behavior remains unmeasured; these projections need
  validation on the first live match.

```mermaid
sequenceDiagram
  participant S as Scheduler
  participant L as Direct lease
  participant E as ESPN
  participant P as Neon Postgres
  participant R as Cloudflare R2

  S->>L: acquire/check advisory lock
  loop active competitions (max 3)
    S->>E: rolling or full-season scoreboard
    opt bracket season
      S->>E: bracket feed
    end
    S->>P: load durable unfinalized backlog
    S->>P: monotonic match/team upserts
    S->>E: summary for live/final candidates
    S->>P: atomic detail + final freeze
    S->>E: standings
    S->>P: guarded transactional standings replacement
    S->>E: goals/assists leaders (one statistics fetch)
    S->>R: validated leader crest mirror (in-memory board)
    S->>P: guarded transactional leader replacement
    S->>P: ingest_run audit
  end
```

---

## 5. Reader (slice 1c — implemented public Go REST API)

- Public, autoscaling, scale-to-zero. Versioned under `/v1`.
- Endpoints mirror the 6 `DataStore` methods:
  - `GET /v1/competitions/{comp}/{season}/matches`
  - `GET /v1/competitions/{comp}/{season}/standings`
  - `GET /v1/competitions/{comp}/{season}/bracket`  (computed read-model)
  - `GET /v1/competitions/{comp}/{season}/top-scorers`
  - `GET /v1/matches/{id}`  (summary/detail)
  - `GET /v1/competitions/{comp}/news`  → **live proxy to ESPN** (short TTL cache), NOT DB-served.
- **Response shapes match the frontend types.** Publish an **OpenAPI** doc as the
  shared contract. The implementation and OpenAPI 3.1 document live in
  `backend/reader/`; contract tests load the document and validate every public
  response model.
- **Cacheable:** `Cache-Control` (short TTL for live, longer for finished/static)
  so consumers—and an optional future API CDN—can cache and shield the DB.
- **Rate-limited** per IP (app-level to start). Open read tier now; API
  keys/quotas deferred until a consumer needs them.
- The limiter tracks at most 10,000 clients with LRU eviction. `/v1` dependency
  work has a ten-second context deadline. Health checks are rate-limit-exempt
  but DB pings are coalesced and cached for two seconds; health and all error
  responses are explicitly `no-store`.

### Reader request flow

```mermaid
sequenceDiagram
  participant C as Consumer
  participant F as Fly HTTP proxy
  participant R as Reader
  participant G as Competition registry
  participant D as Neon Postgres
  participant E as ESPN news

  C->>F: GET /v1/...
  F->>R: request + Fly-Client-IP
  R->>R: CORS · security headers · rate limit
  alt competition/season endpoint
    R->>G: whitelist comp + season
    G-->>R: canonical config
    R->>D: parameterized SELECT
    D-->>R: typed rows/jsonb
  else news endpoint
    R->>G: whitelist competition
    R->>R: 90 s TTL cache + singleflight
    R->>E: fetch on cache miss
    E-->>R: ESPN JSON
  end
  R-->>C: exact frontend JSON + Cache-Control
```

The process has explicit read/header/write/idle timeouts and graceful signal
shutdown. Empty public collections are normalized to `[]` at both top-level and
nested response locations.

---

## 6. Security model

- **Public:** only the reader (curated, read-only, versioned). **Private:** the
  DB (Neon, not exposed to the public — the reader is the only thing consumers
  reach) and the ingester (no public HTTP).
- **Injection-proof by construction:** parameterized queries only (**sqlc** or
  pgx placeholders) — no string-built SQL exists; typed/whitelisted inputs
  (`comp`/`season` validated against `competitions.json`; ids are opaque
  parameters); no free-form query surface. The reader DB user is **SELECT-only**,
  so the public path physically cannot write.
- **Secrets** (DB DSNs, R2 keys) live in **Fly secrets** / GitHub Actions
  secrets — never in code.
- **TLS everywhere** (Fly HTTPS; Neon requires `sslmode=require`).
- **App rate limiting now; optional future API CDN caching** as
  defense-in-depth/scale. Cloudflare currently fronts R2 assets, not the Fly
  reader origin.
- **Client IP trust boundary:** the direct Fly HTTP deployment uses a valid
  `Fly-Client-IP` value and otherwise the TCP peer. The reader deliberately
  ignores `X-Forwarded-For`. Adding another proxy in front of Fly requires a
  reviewed trusted-proxy policy before rollout.

---

## 7. Frontend cutover (slice 1d)

- Add `apiStore` implementing `DataStore` by calling the reader `/v1` endpoints
  and deserializing into the existing types.
- `DATA_SOURCE` env flag (`espn` | `api`) selects the implementation; default
  `espn` until parity is verified, then flip to `api`.
- During rollout, `apiStore` **falls back to the ESPN store on error** so a
  backend issue never dark-pages the site.
- Set `SCOREARC_API_BASE` (the reader's public URL) in Vercel env.

---

## 8. Testing strategy

- **Go mappers:** unit tests against the recorded ESPN JSON fixtures (parity with
  the TS mappers) — copy/reference `src/server/data/__fixtures__/`.
- **Repository layer:** reader tests apply the real migrations to ephemeral
  Postgres 16 via **Testcontainers**, seed representative data, exercise every
  SQL read model, and prove the reader role cannot INSERT/UPDATE/DELETE/DDL.
- **Reader handlers/middleware:** fast fakes cover all routes, registry
  validation, sanitized dependency failures, CORS, cache headers, health, client
  IP selection, rate limiting, and server timeout configuration.
- **News:** mapper edge cases plus deterministic TTL, failure, defensive-copy,
  race, and concurrent singleflight coverage.
- **Contract:** tests load and validate `backend/reader/openapi.yaml`, require
  exact object fields, and validate representative JSON for every endpoint
  response. Slice 1d will additionally parse real reader output in `apiStore`.
- **Frontend:** `apiStore` unit test against a mocked reader response.

---

## 9. Deferred to later phases (do NOT build in Phase 1)

- **Athlete `/overview` game logs** — not ingested. It returns the last five matches per
  athlete; `appearance` + the T7.7 box score already give a full season log for every match
  the ingester sees, so this would be ~6,000 requests to duplicate a subset of what we hold.
- **Injuries** — not ingested. The `injuries` array is present on every roster athlete and
  **empty on all 35**. The field existing is not the data existing.
- **Phase 2** — time-series *writes* + an analytics store. Options when we get
  there: **BigQuery** (usable cross-cloud via API even off GCP), **R2 + DuckDB /
  MotherDuck** (data-lake on the object storage we already have — natural fit),
  **ClickHouse Cloud**, or just partitioned Neon/Postgres until it outgrows it.
  The `emitSnapshots()` hook + snapshot tables are the seam; whatever we pick
  attaches there without reshaping Phase 1.
- **Phase 3** — historical backfill. **Revised 2026-08-15:** xG no longer needs an
  external source. ESPN's *core* host serves shot geometry directly and T7.12/T7.13
  persist it, so scraping and open data (football-data.co.uk, StatsBomb; FBref/Understat
  are ToS-gray and rate-limited) are **not** on the critical path for xG. They remain
  options for pre-2026 *results*, which our own ingestion cannot reach.
- **Phase 4** — own ML precomputed into the DB (**xG = epic E9**, trained on our own
  persisted `match_play` geometry; odds=Dixon-Coles, season sim=Monte Carlo,
  similarity=clustering→pgvector). E9's spec is
  `docs/superpowers/specs/2026-08-15-expected-goals-design.md`; note its hard
  prerequisite is T7.12/T7.13, because a model cannot be trained on data we did not keep.
- **Phase 5** — Claude language layer (auto match summaries via Haiku + Batch API;
  conversational Q&A via **tool-use over our own endpoints**, not text-to-SQL;
  "matches like this" via embeddings + pgvector). Don't train an LLM.
- **LED board** — a physical scoreboard (Adafruit Matrix Portal S3 + HUB75
  panels) that just polls a compact `/v1/…` endpoint when built.

---

## 10. Pinned contracts and slice boundaries

The prose above is not enough to implement directly — nail these down (in each
slice's plan) so the Go output matches the frontend verbatim. The **source of
truth is the TS**: `src/server/data/types.ts` (shapes), `providers/espn-*.ts`
(mapping), `endpoints.ts` (ESPN URLs), `store.ts` (how each method is assembled),
`__fixtures__/` (recorded ESPN JSON to test against).

**1b — Ingester (implemented)**
- **Mapper → table map:** `espn-matches.ts` → `match`; `espn-summary.ts`
  (scorers/cards/stats/winProb/lineups/videos/info/form/h2h/commentary/shootout) →
  `match_detail` **jsonb** columns; `espn-standings.ts` → `standing`;
  `espn-stats.ts` → `top_scorer`; `espn-bracket.ts` → knockout `match` rows (see
  the bracket note in §3). `espn-news.ts` is **not** ingested (reader proxies it).
- **ESPN URLs to port:** `endpoints.ts` — `scoreboardUrl(slug, datesRange)`,
  `standingsUrl`, `summaryUrl`, `bracketUrl`, `statisticsUrl`, `newsUrl`. Which
  comps/seasons + date ranges to poll come from `backend/config/competitions.json`.
- **jsonb payloads must equal the `types.ts` shapes** so the reader can hand them
  back unchanged — fixture-test the Go mappers against `__fixtures__/`.
- **"Live" detection** for the fast/slow cadence: any polled `match.state == 'live'`.
- **Freeze predicate:** on `state → finished`, write finals, set `finalized_at`,
  and skip re-upsert while `finalized_at IS NOT NULL`.
- **Asset idempotency:** skip the download if the object already exists in R2
  (HEAD) or `team.crest_url` already points at our CDN.
- Governing implementation details and validation evidence live in
  `docs/superpowers/specs/2026-08-10-internal-ingester-service-design.md` and
  `docs/superpowers/plans/2026-08-10-internal-ingester-service.md`.

**1c — Reader (implemented)**
- **Endpoint → type map:** each `/v1/…` response must deserialize into exactly
  `Match[]` / `Group[]` / `BracketRound[]` / `MatchSummaryData` / `TopScorer[]` /
  `NewsArticle[]` from `types.ts`. Write a field-by-field map in the plan.
- **`/news` drops season:** `newsUrl(slug)` is comp-only; the endpoint is
  `/v1/competitions/{comp}/news` and `apiStore.getNews` builds it from
  `rc.competition`, ignoring season.
- **Query layer:** pick **sqlc** (recommended — compile-checked, parameterized) or
  `pgx` placeholders; either way, no string-built SQL.
- Add a `/healthz` route (used by the deploy check in SETUP §7).
- The machine-readable contract is `backend/reader/openapi.yaml`; behavior and
  local-operation notes are in `backend/reader/README.md`.

**1d — Cutover**
- `apiStore` lives at `src/server/data/apiStore.ts`, implementing `DataStore`.
- Selection happens where the concrete store is chosen in `src/server/data/store.ts`
  (find where the ESPN store is instantiated); switch on `process.env.DATA_SOURCE`
  (`espn` default | `api`), reading the reader base from `SCOREARC_API_BASE`.
- `apiStore` wraps each call in try/catch and **falls back to the ESPN store on
  error** during rollout.
