# T16.2 — Canonical identity and DTO parity — design and plan

> Executed inline (TDD, one commit per task). Steps use checkboxes. The T16.1
> harness (`src/server/data/contracts/reader-contract.json` and its three suites)
> is the acceptance test: every resolved gap's characterization becomes a
> positive assertion, never a deletion.

**Goal:** close the 14 registered T16.2 gaps and the three unregistered T16.2
items, or leave an item explicitly open for an owner decision, without
discarding information, rewriting finalized rows or cutting over the frontend.

**Architecture:** canonical ids stay canonical. Provider ↔ canonical
translation happens at named boundaries: the seed crosswalk for teams,
`match_external_ref` for matches, and a read-time side attribution for nested
scorer/card team references: stored detail keeps the provider's ids (finalized
rows are sealed), and the reader serves them as canonical sides.

**Tech stack:** TypeScript/Vitest, Go 1.26, pgx, testcontainers Postgres,
OpenAPI 3.1 (kin-openapi).

## Evidence gathered before design (2026-10-04)

- Live ESPN standings for all ten configured competitions (read-only GETs):
  World Cup groups, MLS conferences and both Leagues Cup tables arrive **out of
  rank order**; every table carries a complete `rank` permutation and all eight
  required stats; no table is empty, unnamed or overlapping another. The Go
  mapper's array-order ranks are therefore wrong in production today for the
  World Cup and MLS.
- Every real penalty shootout found (17 events: recorded fixtures plus World
  Cup 2006–2026, Leagues Cup 2023–2026, MLS and Liga MX playoff windows)
  carries the structured `competitors[].shootoutScore` on the lightweight
  scoreboard **and** a note; the Go anchored note rule and the current TS rule
  agree on all 17.
- Raw summaries are not archived (only play streams are), so already-finalized
  `match_detail` rows cannot be re-derived from bytes.
- The reader login has `SELECT` on `team_external_ref` (0001 grant), so
  read-time translation needs no migration.

## Design decisions

| Item | Decision |
|---|---|
| `match-id` | Intentional representation difference. Ids are opaque, store-scoped tokens: each store round-trips its own list-row ids into its own summary address; the crosswalk is `match_external_ref (source, source_id) → match.id`. Proved in Postgres through the real resolver. Per-method cutover must keep the window methods and `getMatchSummary` on the same source (recorded for T16.3/T16.5). |
| `team-id` | Intentional representation difference. Translation is the curated seed crosswalk, identical in both languages (full-map Go test over `teamCrosswalk.json`). |
| team helper | `canonicalTeamId` accepts a provider **or** canonical id (the two id spaces are disjoint: numeric vs slug), so `teamHref`, the team index and follows produce identical results for reader ids; provisional `prov-…` ids stay unlinked in both. |
| `nested-team-id` | Read-time translation in the reader (`attribution.go`): a stored scorer/card team reference becomes the canonical id of the side it names, matched against each side's `team_external_ref` ids for the match's source (selected in the same statement), or `null` when it names neither side or both — never defaulted to home/away. `match_detail` keeps the provider's ids as written; one mechanism serves legacy, finalized and new rows alike without rewriting sealed rows, so the ingester write path is unchanged. `Scorer.teamId`/`Card.teamId` become `string \| null` in both contracts. |
| `scorer-identity` | Stored and served `ownGoal` (`boolean \| null`) and `athleteId` (provider athlete id, `string \| null`). Rows written before this change recover both at read time from the match's captured `match_event` goals when every scorer aligns with one (side, minute, penalty, shootout, in order); otherwise they decode to `null` (unknown), never `false`. `playerSlug` stays a route-layer enrichment: `withSummaryPlayerSlugs` resolves it from `athleteId` exactly as for the frontend store; no name-based matching. |
| `standings-rank` | Go ports the TS rule: order by ESPN's `rank` stat when it is a complete 1..n permutation, else array order. |
| `standings-dedup` | Rows kept in a later table keep their true provider positions (not renumbered), so a zone cut never shifts. Cross-table membership (a team kept in two provider tables) is **left open for an owner decision**: the one-row-per-team `standing` key (and `standing_snapshot`'s per-team uniqueness) cannot hold it; options are a multi-table standing model or a shared first-table rule. No configured competition publishes overlapping tables today. |
| `standings-malformed` | The ingester's rule is the contract: a table with no entries or a row missing team identity or one of the eight required stats rejects the payload. The frontend mapper stops zero-filling and throws; a payload with no tables stays a legitimate empty `[]`. Review round 1: an envelope with no `children` array and a row with an empty team id reject in TS as in Go, and a stat-only failure (`StandingsStatsError`) still yields its team identities to the team and player indexes through `standingTeams`. |
| `group-label` | An unnamed provider table is labeled with the competition short name in both (frontend adopts the reader's rule); named tables are unchanged. |
| `placeholder-crest` | `null` in both (frontend stops passing ESPN's `""` through). Browser verification found the same `""` pass-through in the TS match-list, team-schedule and leader mappers, which Go already treats as absent; fixed there too. |
| `bracket-round-name` | Contract decision, no behavior change: `name` is an additive English label for API consumers; the frontend localizes from `slug`. Proved equal to the frontend's English catalog label for every slug. |
| `round-slug-type` | OpenAPI `BracketRound.slug` and `BracketMatch.round` become the six-slug enum; Go mapper, reader order and the TS union are proved equal. |
| `shootout-source` | One precedence everywhere: summary-header `shootoutScore` (where a summary is held) → scoreboard competitor `shootoutScore` → anchored scoreboard note → `null`. Structured values must be non-negative integers and not both zero; a malformed structured value rejects the scoreboard in both languages (the frontend window loader already did). Lightweight feeds use the scoreboard tiers only (no summary fan-out). Regulation scores are untouched. Review round 1: a scoreboard total is a non-negative integer or a digit string in both languages (the summary header keeps its existing wider rule); a summary header counts only for its own event and sides; a finished match's decisive aggregate names the winner over the flags in both mappers and in the ingester's finalization, and a live partial shootout names none. Round 2: the same live rule on both bracket mappers and the Go summary recovery path; the reader serves a finished row's winner from its stored decisive aggregate (sealed rows finalized earlier); the frontend summary cache is keyed by event and sides; a go-db EXPLAIN test pins the read-time lookups to their indexes. Round 3: the reader serves no winner for a match that is not finished; a bracket-only match carries the bracket's structured totals into the summary precedence; a rejected standings payload is cached like an accepted one. Round 4: only a finalized row's stored aggregate outranks its stored winner (an unsealed one may still be a live partial). Round 5 supersedes the read-time winner from rounds 2 and 4: a sealed aggregate may itself be a retained live partial, so the reader serves the stored winner (none when not finished) and the historical disagreement is a documented data-acceptance gap; the final detail write now stores only final shootout evidence; the team schedule takes the scoreboard tiers. Round 6: a level served aggregate falls back to ESPN's own flag (carried off the wire as `WinnerFlagID`), never to a superseded aggregate's winner (`espn.ResolveWinner`, TS store). |
| `live-minute`, `bracket-live-minute` | A live event without a display clock is `minute: null` in every mapper; the reader also serves stored `''` as `null`. |
| leader crest keys | Leader crests mirror under the leader team's canonical id (`teams/<canonical>`) through `mirrorCrest`, the team-crest path, resolving the leader's provider team id with the same crosswalk as standings (curated, or provisional when unseeded). A leader without a provider team id, or whose team cannot be resolved, keeps its upstream URL unmirrored — no key from the URL or a display name. |
| CDN allowlist | `safeCrest` adds exactly `cdn.scorearc.futbol`; every allowed host now also requires HTTPS on the default port. Lookalikes, subdomains, the parent domain and other hosts stay rejected. `OG_VERSION` is unchanged: the site has never generated a share URL with a CDN crest (the frontend is ESPN-backed), so no cached preview can change. |

## Tasks

### Task 1 — team identity helper and crosswalk parity
- [x] TS: failing tests in `teamIdentity.test.ts` (canonical input returns itself, provisional/unknown → null, provider/canonical spaces disjoint) and `teamHref` equality for reader vs frontend ids.
- [x] Implement in `src/server/data/teamIdentity.ts`; run `npx vitest run src/server/data/teamIdentity.test.ts`.
- [x] Go: `reader_contract_test.go` asserts `teamCrosswalk.json` equals the seed's ESPN map exactly.
- [x] Commit `fix: make the canonical team helper accept reader ids`.

### Task 2 — clockless live minute
- [x] Failing tests: TS `espn-matches`/`espn-bracket` clockless and empty-clock cases; Go `matches_test`/`bracket_test`; reader integration serves stored `''` as `null`.
- [x] TS `status.displayClock || null`; Go set minute only for a non-empty clock; reader SQL `NULLIF(m.minute, '')` on match, bracket and team-schedule projections.
- [x] Harness: `queries.liveMinute` and `bracket.liveClockless` expect `null` in both; positive assertions replace the two characterizations.
- [x] Commit `fix: serve a clockless live minute as null`.

### Task 3 — bracket placeholder crest, round slugs and names
- [x] TS `mapBracketTeam` `t.logo || t.logos?.[0]?.href || null`; vector `frontendPlaceholder.away.crestUrl = null`.
- [x] OpenAPI enum on `BracketRound.slug` and `BracketMatch.round`; Go test: enum == `knockoutRoundOrder` == `bracketRoundOrder` == vector slugs; TS test: same list == `KnockoutRoundSlug` and `readerRoundNames[slug] === en[roundLabelKey(slug)]`.
- [x] Commit `fix: align bracket placeholder crests and round slug contract`.

### Task 4 — standings
- [x] Go: port `inTableOrder`; rows kept after first-table dedup keep their true positions; tests for recorded order, duplicate/partial rank fallback, dedup ranks.
- [x] TS: reject empty tables and rows missing team identity or a required stat; legitimate-empty `{}`/`{children: []}` stays `[]`; unnamed table labeled with `rc.competition.shortName`.
- [x] Harness: `standings-rank`, `standings-malformed`, `group-label` become positive; `standings-dedup` narrowed to cross-table membership (stays registered, owner decision).
- [x] Commit `fix: align standings order, validation and labels`.

### Task 5 — shootout aggregate precedence
- [x] TS: `shootoutAggregate` + anchored `parseShootout` in `espn-matches.ts`; `mapScoreboard` applies scoreboard tiers; `getMatches` prefers the held summary header.
- [x] Go: scoreboard competitor `shootoutScore` carried on `model.Match` (not serialized) as the middle tier in `source.mapSummary`.
- [x] Shared synthetic precedence vectors (header-only, scoreboard-only, note-only, conflicts, invalid, both-zero) run in both languages.
- [x] Commit `fix: one shootout aggregate precedence in both languages`.

### Task 6 — scorer identity and nested team ids
- [x] Go model: `Scorer{TeamID *string, OwnGoal *bool, AthleteID *string}`, `Card{TeamID *string}`; mapper fills `ownGoal`/`athleteId`.
- [x] Reader: match, schedule and summary SQL return each side's `team_external_ref` source ids for `m.source`; `attributeDetail` on read (no ingester write change).
- [x] OpenAPI `Scorer`/`Card`; TS types `teamId: string | null`, `ownGoal: boolean | null`.
- [x] Harness: positive TS/Go/go-db proofs (legacy provider ids and new canonical rows both served canonically; own goal; athlete id → `withSummaryPlayerSlugs`; unattributable → `null`; legacy `ownGoal` → `null`).
- [x] Commit `fix: canonical nested team ids and scorer identity`.

### Task 7 — leader crest keys and CDN allowlist
- [x] Go: `StatLeader.TeamSourceID` (not serialized); `mirrorLeader` resolves the canonical team and reuses `mirrorCrest`; tests for curated, provisional and unresolved teams.
- [x] TS: `safeCrest` accepts `https://cdn.scorearc.futbol/…`; rejects lookalikes, subdomains, parent domain, `http`, non-default port; og route renders a CDN crest.
- [x] Commit `fix: slug-stable leader crests and the ScoreArc CDN crest host`.

### Task 8 — match/team identity translation proofs and docs
- [x] go-db: match minted by the real resolver; `match_external_ref` maps the provider event id to the served UUID; the list id addresses `/v1/matches/{id}`.
- [x] TS: summary addressed by provider id; reader UUIDs never reach the ESPN store in the harness.
- [x] Update `READER_CONTRACT.md`, `CURRENT_STATE.md` §5/§8, `PRODUCT_ROADMAP.md` T16.2 narrowly.
- [x] Commit `docs: record T16.2 identity and DTO contract`.

## Rollout and data notes

- No migration. Reader-side translation is read-only; the new `ownGoal`/
  `athleteId` keys reach new detail writes only. Finalized rows keep their
  stored bytes; the reader serves their team references canonically, and their
  `ownGoal`/`athleteId` from aligned `match_event` rows or as `null`.
- Ingester and reader can deploy in either order: an old reader ignores the new
  JSON keys, and a new reader translates both old and new rows.
