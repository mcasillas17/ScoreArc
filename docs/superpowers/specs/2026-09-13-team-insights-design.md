# Team insights and local follows — first milestone

Status: implementation scope authorized by the September 13 request. This is a
bounded subset of T16.1 and T19.1, not completion of either task or epic.

## Product boundary

Extend the existing team page (header, form/next match, squad, schedule) and home
digest. Keep ESPN read-through behind `DataStore`; no apiStore switch, shadow
traffic, infrastructure, migrations, ingester repair, credentials, or deployment.
The [data-rights decision](../../decisions/2026-09-01-data-rights-gate.md) stays
open: this adds deterministic rendering within the existing site, no new public
API, distribution channel, model training, or generated prose.

Scheduling exception: team-only browser-local follows on the current source may
precede E16 dogfooding. Player/competition follows, T19.2 ranked feeds, accounts,
notifications, and generated briefs remain gated and out of scope.

## Performance contract

Use the selected competition and season only. Explicitly select the ESPN season
in schedule requests and validate returned event league, season year, split
season where applicable, and team participation. Preserve nullable scores. Keep
the existing cache keys/TTL and four-request team load; failed optional blocks
retain the page and expose unavailable status instead of pretending to be empty.

Pure shared functions select known played final statuses (full time, after extra
time, after penalties). Canceled, abandoned, postponed, suspended, awarded,
forfeit, unknown statuses, invalid dates/scores, wrong scope/team are excluded.
Extra-time goals count. Shootout goals do not; a shootout tie is D even if the
provider names a winner. Conflicting duplicate result facts are excluded rather
than choosing a convenient answer. Sort by kickoff then id, newest first, without
mutating inputs. Deduplicate before selecting windows.

Recent means at most the last five eligible matches, with actual sample size,
date range, W/D/L, goals for/against, and clean sheets. Compare only when ten
eligible matches exist: last five versus immediately preceding five, both date
ranges/samples visible. Show counts and goals per match; deltas are recent minus
previous, neutral numeric wording. No causal claims, scorer trends, freshness or
completeness claims. Every counted match opens the existing detail dialog; the
previous period's evidence is available too. Explain exclusions and the scope.

## Follows and UI

One follow per curated canonical team, with a preferred competition and validated
display name. Never key by locale, season, or provider id. Resolve current-season
home links from competition config. Store a bounded, versioned, validated JSON
document in localStorage. Migrate a defined prior version; do not overwrite
unknown future versions. Unavailable/quota storage uses shared in-memory state
with a visible persistence warning. Handle corrupt data, removal, cross-tab
events, and initialization without saved-state overwrite or hydration mismatch.

Follow/Following is a keyboard-operable pressed button with team-specific names.
Home's Your teams section is a shortcut list with no per-team network fan-out;
the default digest remains. All copy uses existing English/Spanish translators.
Reuse badges, detail UI, telemetry, dark tokens and round form chips. Support
320/390/560px and desktop, reduced motion, long names, and visible focus.

## Contract foundation

Inventory all 14 DataStore methods against the seven current reader routes,
DTOs and OpenAPI. Implement a shared recorded/vector contract slice covering
team identity, schedule and match fields this milestone uses. TypeScript and Go
consume the same vectors; validate Go serialization against OpenAPI and test
types/nullability, canonical identities, ordering, scope and real query/error
semantics. Assert known gaps explicitly rather than normalizing them away. No
claim of full reader parity or successful cutover follows from this harness.

## Acceptance

Behavioral tests cover perspective, draws/shootouts, exceptional states, unknown
scores, order/duplicates, scope, 0/small/10+ samples, storage lifecycle and drift.
Run full Vitest, typecheck, lint, production build (without concurrent dev writes),
Go build/race tests/vet for Go changes, and actual browser checks in both locales
for América, a European club, and a team with ten eligible matches. Independently
review all six dimensions with the configured Sol/Terra panel, fix findings,
review documented state, push all commits and open a non-draft PR. No merge or
deploy. Leave the local dev server and specific inspection URLs available.
