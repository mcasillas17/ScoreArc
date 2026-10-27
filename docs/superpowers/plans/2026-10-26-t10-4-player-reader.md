# T10.4 canonical player reader implementation plan

**Goal:** close `T10.4-player` with a bounded read for `getPlayer`, without a source switch, migration, deployment or merge.
**Spec:** the approved T10.4 task, `docs/backend/READER_CONTRACT.md` and `2026-08-12-canonical-identity-design.md`; apply the August players plan's intent to main `57d649b`.
**Architecture:** one composite `GET /v1/competitions/{comp}/{season}/players/{playerId}` in the existing reader/snapshot seam. Reuse `player`, `player_season_stat`, `squad_membership`, `player_team_history`, `appearance`, `match_event` and the restricted participation view. SQL uses placeholders, fixed limits and batched reads.

## Decisions and bounds

- Canonical lowercase UUID only; malformed/provider identifiers return 400; an unknown canonical UUID returns 404. No slug is minted from a name or provider id. Additive `playerSlug` stays null pending an approved lookup.
- Profile identity survives missing optional rows. Age is derived from birth date in UTC; unknown flag/headshot stay null because neither is stored. The season-stat team's canonical identity wins; latest scoped squad membership is the fallback. Jersey is from that membership only.
- Totals default/max 15 named stored measurements (empty without a season-stat row). Preserve null versus measured zero; do not sum incomplete appearances or invent ESPN's combined starts/substitute display.
- Game log default/max 5, newest first with UUID tie-break. Scope is the requested competition and season; unlike the provider overview, it cannot mix competitions. Select played-evidence rows, not unused or uncertain bench memberships; unknown start/sub status is an empty label. Share T10.2's stats evidence helper. A maximum of 2,000 candidate roster rows and 512 events per candidate are inspected; overflow fails closed. No per-match application queries.
- Career default/max 50 in provider order, with stable tie-breaks. Source-qualified team crosswalk joins yield canonical team ids/crests, or null ids/crests with names/seasons retained. This nullable career team id is a documented translation from the provider shape.
- All optional blocks use null/empty only for absent data. Database errors fail with sanitized 500; response size is capped at 1 MiB. Success cache is 60 seconds; errors no-store; existing ten-second deadline/rate limit apply.
- No UI, ingester, production, schema-version or deployment changes. Canonical game-log event ids are match UUIDs and cut over with all match-id methods in T16.3.

## Tasks (failing first)

- [x] Add route/real-Postgres contract tests for identity, null/zero, evidence, scope, ordering, caps, invalid input and sanitized failures. Run `go test ./reader -run 'TestPlayer'`; expect missing route failures before implementation.
- [x] Implement `players.go`, shared participation inference, interface/router/fake wiring and exact OpenAPI schemas. Run focused player, box-score, OpenAPI and snapshot tests; expect pass.
- [x] Replace the gap with positive shared TypeScript/Go/OpenAPI/Postgres vectors. Update method inventory, affected identity/reader docs and roadmap. Run contract suites and typecheck; expect pass.
- [x] Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`; `go build ./...`, `go test -race ./...`, `go vet ./...` with the active Colima socket. Smoke-check local dev without changing sources.
Required delivery gate: Knights Astra/Sol/Luna implementation panel, repairs until clean, then separate fresh final panel. Stage/commit only reviewed task-owned changes with Codex trailer, push normally and open an active PR. No merge or deployment.

## Review focus

Unknown slugs and same-name players cannot become guessed links. Transferred players retain per-match teams. Incomplete captures cannot invent bench appearances or measured zero. Canonical match UUIDs never mix with provider ids. Inspect query bounds and least-privilege reads, including absent optional rows and response overflow. T10.3 edits overlapping files independently; the second merged PR must rebase.
