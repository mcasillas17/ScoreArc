# Frontend scoreboard windows

## Evidence and scope — September 29, 2026 UTC

This repair started from origin/main at aa8aa2141750db7115a912d46f48d78663241b8a.
Before PR delivery, the owner requested incorporating cleanup PR #191 at
9a65d8cb2385284d932cf70a8a035b716e9b61f2. The integration keeps its moved date
helpers, fixed TTLs, shared client fetch helper and removal of the unused live API.
After PR #193 merged at 91753fd, its overlapping monthly reader was consolidated
into this bounded loader. Its removal of the duplicate bracket URL builder remains.
The now-unused Eastern-day helper and month enumerator are replaced by the loader's
existing UTC/provider-boundary regression coverage: provider-local partitions are
padded, while public windows still select the exact requested UTC dates.
Backend PR #183 (969e512) repaired the Go path; the frontend still called ESPN
with hyphenated date ranges. The frontend remains ESPN-backed. No reader cutover,
production operation, migration or additional competition is part of this change.

Bounded probes using Node fetch (the application's transport) at approximately
07:24 UTC reproduced mex.1 September range HTTP 400, with “Failed to get events
endpoint.” The compact dates=202609&limit=1000 selector returned HTTP 200 with
34 matches; LaLiga returned 39. Adding page=2 repeated page 1 byte-for-byte, so
pagination is not a completeness mechanism. The public website returned a CDN
502 page, while the local application reproduced its own sanitized JSON 502.
These identify distinct observed boundaries; a CDN 502 alone does not establish
its origin cause. The browser reproduced both unavailable views before the fix.

Recorded regression excerpts in
src/server/data/__fixtures__/scoreboard-window-recorded.json retain provider
provenance and raw fields needed by the existing match/bracket mappers. January
2026 Liga MX includes a match at February 1 01:10 UTC that is absent from the
February selector. Clausura uses the previous provider year, and historical
phase slugs can contain the public calendar year. December 2022 World Cup
results verify historical round metadata.

## Shared retrieval and budgets

scoreboardWindow.ts translates every explicit scoreboard window in store.ts
to compact month selectors. Calendar, live windows, enriched matches, upcoming
matches, computed Leagues Cup tables and dated brackets share this loader.
Undated bracket reads keep the provider's existing default behavior, with bounded
transport. Components and public query shapes remain unchanged.

The loader intersects inclusive UTC dates with the existing season bounds, reads
months touched by a one-day guard at either edge, and then filters to that exact
intersection. The guard covers the observed provider-local day offset without
assuming an undocumented provider timezone. Raw provider identities, round slugs,
notes, shootout metadata and within-month ordering survive until the existing mapper
runs. Identical raw duplicates merge in first-seen order independent of object key order.

| Budget | Limit |
| --- | --- |
| Public explicit range | Existing 92-day span cap |
| Public summary enrichment | Existing 14-day span cap |
| Scoreboard requests | At most 6 monthly requests, sequential, no retries |
| Scoreboard elapsed time | 15 seconds for the complete window |
| Scoreboard response / aggregate body | 4 MiB / 16 MiB |
| Provider event ceiling | Reject a month with 1,000 or more events |
| Summary enrichment | Retained unique matches only, at most 4 concurrent calls |
| Enriched read | 15 seconds including scoreboard; each summary at most 4 MiB |
| Undated bracket read | One request, 15 seconds, 4 MiB |

Caller cancellation is checked before every scoreboard request and summary batch;
the matches API forwards request cancellation. The native transport aborts and
bounds body reads. Summary errors retain the existing best-effort fallback, while
a cancelled/expired overall enriched read cannot populate its result cache.

Conflicting duplicates, invalid league/season scope, malformed mapper inputs,
ignored month selectors, explicit incomplete pagination metadata and observable
truncation fail the entire window. A valid empty response remains a successful
empty array. A failed partition never becomes a cached empty result or renews
freshness. Existing sanitized errors and telemetry remain intact.

Keys retain competition, season, window and consumer isolation; upcoming keys also
include their forward window and limit. Existing TTLs remain: calendar 120s, live
15s, enriched matches 10s, upcoming 60s. The Now browser poll still uses the public
calendar-range route (120s); server-rendered Now/live reads use 15s. This repair
does not change that pre-existing freshness distinction.

The computed Leagues Cup phase ends August 14 UTC, including the final three
August 13 local matches. Its previous August 13 endpoint would omit those matches
once exact UTC filtering is enforced. The corrected window retains all 54 phase
matches, 36 teams with three matches each, and the same qualification rules.

## Validation and remaining limits

Failing-first regressions cover boundaries, historical/split editions, exact scope,
duplicate conflicts, empty results, failed partitions, malformed/truncated bodies,
bytes, timeouts/cancellation, request limits, cache isolation, enrichment scope and
concurrency. Store, API and localized page checks accompany the loader tests.
npm test (88 files, 1,249 tests), npx tsc --noEmit, npm run lint and npm run build
passed after incorporating #191; the build ran with the dev server stopped.
The same checks passed again after resolving #193's overlap (1,249 tests), followed
by real-browser Liga MX and LaLiga Now/calendar checks on the merged working tree.
ESLint retains five existing warnings. The required competition exporter passed
with no generated JSON drift. The owner's additional GPT-6 Luna Ponytail review
found no actionable complexity issues; it supplements the configured Knights panel.

Real-browser checks used localhost with real ESPN reads: Liga MX and LaLiga
Now/calendar, month navigation, July 31 local/August 1 UTC matches, World Cup 2022
calendar/bracket, Leagues Cup computed tables, home results and the upcoming banner.
Representative 390px mobile and 1440px desktop layouts had no horizontal overflow.
A temporary local transport failure returned 503 only for ESPN scoreboard reads:
EN/ES Now and calendar rendered unavailable states, not successful emptiness.
Both languages no longer promise that the other view works. The normal server was
restored; no failure switch was added to the product.

ESPN is keyless and its month selector is an observed contract. Silent omissions
below the limit without completeness metadata cannot be detected. Boundary padding
assumes the observed calendar offset is within one day. Conflicting live duplicates
fail rather than guessing which payload is authoritative. No speculative pagination,
daily fan-out or retry hides these limitations.

This is local repair evidence, not post-merge production acceptance. After an
owner-authorized merge/release, verify both views, month navigation, boundary and
historical results, sanitized failure behavior and freshness on the deployed SHA.
No merge or deployment is performed by this task.
