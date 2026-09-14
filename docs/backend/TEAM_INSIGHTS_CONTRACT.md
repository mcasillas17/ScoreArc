# Team insights: bounded contract foundation

September 13, 2026. This is a test/documentation slice of T16.1, **not full
DataStore parity, an apiStore implementation, or permission to cut over**. ESPN
remains the production source. No reader routes, DTOs, SQL, migrations,
infrastructure or deployment configuration change in this slice.

Sources inspected: `src/server/data/{store,types,teamIdentity}.ts`,
`providers/espn-team.ts`, `backend/reader/{server,handlers,store,types}.go`,
`backend/reader/openapi.yaml`, and `docs/CURRENT_STATE.md` §5. The older Go DTO
comments claiming an exact frontend mirror or a base-URL-only migration are not
a parity guarantee. The concrete inventory below supersedes that interpretation.

## All 14 DataStore methods

In this table `C` means `/v1/competitions/{comp}/{season}`. Every listed reader
route is GET. “Candidate” means a related existing route, not a compatible
replacement. The seven data routes are matches, standings, bracket, top-scorers,
news, match summary and team. `/healthz` is operational, not an eighth data route.

| DataStore method and frontend contract | Reader candidate / DTO | Supported surface and concrete gap |
| --- | --- | --- |
| `getMatches(rc, range?) → Match[]` | `C/matches`, `Match[]` | Competition/season SQL scope, ascending kickoff/id, scores and match state. Reader returns the full season with stored detail; no date range, state, detail or limit parameters. Frontend defaults to a current-week window and enriches per-match summaries. Identity and nested DTO differences remain. |
| `getFixtures(rc, range) → Match[]` | `C/matches` | Same base projection, but no requested date window or lightweight/no-enrichment contract. Frontend uses a separate 120-second cache. |
| `getLiveWindow(rc) → Match[]` | `C/matches` | No frontend `nowWindowRange` equivalent; frontend window cache is 15 seconds. The reader's 10/60-second live-dependent HTTP cache is not this window selection. |
| `getUpcoming(rc, limit=12) → Match[]` | `C/matches` | No forward-window, scheduled-only or limit semantics. Frontend uses a 28-day window, ascending kickoff, then truncation. |
| `getStandings(rc) → Group[]` | `C/standings`, `Group[]` | Stored standings exist. Frontend computes Leagues Cup tables and adds the MLS overall table; reader has neither derived view. Group metadata and full DTO parity remain untested here. |
| `getBracket(rc) → BracketRound[]` | `C/bracket`, `BracketRound[]` | Stored bracket projection exists; frontend fetches configured bracket date range. Full round, team identity and detail parity are unproven by this slice. |
| `getMatchSummary(rc,eventId,homeId,awayId) → MatchSummaryData` | `/v1/matches/{id}`, `MatchSummary` | Reader uses a canonical UUID, not the frontend ESPN event id, and no competition/side arguments. Unknown or malformed IDs return 404. Scorer own-goal/athlete fields, richer statistics and lineup fields differ; nested provider team IDs remain a placement risk. |
| `getLeaders(rc) → {scorers,assists}` | `C/top-scorers`, `TopScorer[]` | Only goals rows are selected. No combined object or assists category. Reader uses `goals`, frontend `StatLeader.value`; athlete/team identity fields differ. |
| `getTopScorers(rc) → StatLeader[]` | `C/top-scorers`, `TopScorer[]` | Ordered goal leaderboard exists; `goals` versus `value`, missing athlete/team identity and hashed leader crest keys prevent direct substitution. |
| `getTopAssists(rc) → StatLeader[]` | None | No assists route; `topScorersSQL` hardcodes `category = 'goals'`. |
| `getNews(rc) → NewsArticle[]` | `/v1/competitions/{comp}/news`, `NewsArticle[]` | Competition news exists. Both source behaviors are competition-based despite the frontend season cache key. Reader returns 502 on upstream failure; full payload parity is not tested here. |
| `getTeam(rc,teamId) → TeamProfile|null` | `C/teams/{teamId}`, `TeamProfile` | Canonical team identity, record, squad and scoped schedule exist. Frontend uses provider IDs internally and four ESPN requests. Reader lacks structured `standing`, per-match `scope`, and `scheduleAvailability`. Location remains null, standing summary is generated differently, and a failed child query fails the entire reader request rather than retaining optional blocks. |
| `getSquad(rc,teamId) → SquadPlayer[]` | Embedded `TeamProfile.squad` only | No independent roster route; extracting from team requires the other queries too. Null statistics versus an all-null measured block is represented, but reader age/headshot stay null. Canonical player UUIDs differ from provider athlete IDs. |
| `getPlayer(rc,athleteId) → PlayerProfile|null` | None | No profile/game-log/career route. No player identifier translation contract in this slice. |

The TypeScript test's `Record<keyof DataStore, string>` inventory makes adding or
removing a method a compile-time inventory update, rather than silently retaining
an outdated count.

## Shared vectors and exact boundaries

`src/server/data/contracts/team-insights.json` contains a reduced recorded
América event (401877014), a synthetic scheduled match with unknown scores,
explicit reader UUID test identities, expected complete wire objects, scope,
canonical/provider identity, ignored-query examples and public error vectors.
The first event's retained fields are unchanged from the existing recorded
schedule. The TS test also runs the full recorded input to prevent the reduction
from inventing a supported shape. UUIDs are test identities, not a production
match crosswalk. Timestamp lexical forms are preserved: ESPN minute precision
and reader RFC3339 seconds are compared as instants, explicitly.

The TypeScript checks exercise the actual profile/schedule mappers and curated
team crosswalk, exact match fields/arrays/nulls, chronological ordering, record
and structured standing, and unsupported reader fields. Independent expected
TypeScript shapes pin team identity strings and nullable crest; match identity,
kickoff, state union, nullable minute/scores/winner/note and optional scope; and
profile metadata, nullable record/standing and optional availability. The
schedule element is checked against the same independent match field shape.
`tsc --noEmit` evaluates these `expectTypeOf` assertions; ordinary Vitest
execution only exercises runtime behavior. Extra fields outside this bounded
shape are not a claim of coverage, and no return-annotation-only check establishes
field compatibility. The
legacy raw mapper treats malformed input as `[]`; that ambiguity is asserted,
not relabeled as availability. A recorded scoped-mapper assertion also checks the selected season, attached
scope, empty-success versus unavailable, and rejection of the other Liga MX
split. Broader performance eligibility tests live separately.

Go consumes the same JSON. Exact DTO serialization detects dropped/changed
fields, then the committed OpenAPI schemas validate the serialized objects.
Negative schema checks reject a missing required nullable score and a string
score. Explicit gap assertions pin absent `standing`, `scheduleAvailability`
and `scope` in both reader objects and OpenAPI. These assertions should fail
when those gaps are implemented so the documented contract can be updated.

`TestTeamContractHTTPQueriesAndErrors` uses actual routing and handlers with a
fake storage dependency. It proves the handler currently **ignores** range,
state, detail and limit query parameters (even malformed values), and that
OpenAPI declares no matches query parameters. It checks 400 unknown scope,
404 unknown team, canonical rather than provider route addressing, 500 dependency
failure, safe error body and `no-store`, and no database call for invalid scope.
It does not claim fake data proves SQL behavior.

`TestTeamContractStoreIntegration` uses real Testcontainers Postgres and the
SELECT-only reader. It inserts the shared match vectors, exercises `Store.Team`,
checks exact wire fields and nullable scores, and asserts a complete ordered ID
list. Existing seed rows supply a different competition, different season and
unrelated teams; all must be excluded. A same-kickoff pair inserted in reverse
order verifies the SQL ID tie-breaker. The recorded América crest differs from
the seed's null crest; this single known metadata difference is explicit in the
assertion, not a general normalization pass.

## Running and extending the slice

```sh
npx vitest run src/server/data/contracts
npx tsc --noEmit
cd backend
go test ./reader -run 'TestTeamContract(Serialization|HTTPQueriesAndErrors)$' -count=1
# Docker + the active Colima socket environment from AGENTS.md are required:
go test ./reader -run '^TestTeamContractStoreIntegration$' -count=1
```

A deliberate expected home-score mutation from 3 to 99 was detected by both the
exact mapper assertion and the cross-language comparison; it was restored before
final checks. Independently changing the expected score type from nullable to
non-nullable caused `tsc` errors at both the match and schedule-element shape
assertions; the type mutation was restored. Tests alone do not establish
ingestion coverage or availability.
The shared score and identity vectors cover only the fields used by this
milestone; they do not establish scorer/lineup/stats/leader/bracket/news parity,
production event/player crosswalks, asset allowlisting, historical completeness,
or parity of all 14 methods. Those gaps and the data-rights gate remain open in
`CURRENT_STATE.md` and the product roadmap.
