# Player identity — the slug contract

**Status:** Proposed · 2026-08-22
**Applies to:** frontend player pages (E5) and the backend data model / API.
**Owners:** both sides. The frontend derives these slugs from provider data
today; under this proposal the backend will mint the same slugs as public
player ids. It does not yet: it keys players by canonical UUIDv7 through
`player_external_ref` and serves no player slug. T10.4 adds a canonical UUID profile route with
`playerSlug: null`; the proposed slug URL below is not an implemented reader
address. See [the player read contract](READER_CONTRACT.md#t104-player-contract). If the two algorithms drift, every player URL 404s on the day
the frontend migrates to our API — silently, per player. This document exists
so they cannot drift.

## The rule

A player's public identifier is a **name slug**, scoped to a competition
season. Provider ids (ESPN athlete numbers) never appear in URLs, rendered
HTML, or as a public identifier or link in an API response — same rule the team
pages already follow (`mex-america`, never `227`). Some response fields carry
them as provider-scoped values, by design, and lineup jersey URLs still embed
them as an open gap: see the exceptions below.

```
/c/liga-mx/2026-apertura/player/ali-avila
GET /v1/competitions/liga-mx/2026-apertura/players/ali-avila
```

## Slug algorithm

From the player's full display name, in order:

1. Unicode-normalize to NFD and strip combining marks (`é` → `e`, `ñ` → `n`).
   Same folding `TeamSearch.tsx` already uses.
2. Lowercase.
3. Fold the letters NFD cannot reach (they carry no combining mark, so step 1
   would *delete* them rather than fold them): `ø`→`o`, `đ`→`d`, `ð`→`d`,
   `ł`→`l`, `ß`→`ss`, `æ`→`ae`, `œ`→`oe`, `þ`→`th`.
4. Replace every run of characters outside `[a-z0-9]` with a single `-`.
5. Trim leading/trailing `-`.

`"Alí Ávila"` → `ali-avila` · `"N'Golo Kanté"` → `n-golo-kante` ·
`"Martin Ødegaard"` → `martin-odegaard` (not `martin-degaard`)

## Collisions

Two players in the **same competition season** producing the same slug: both
get the team abbreviation appended, folded by the same algorithm
(`rodrigo-lopez-qro`, `rodrigo-lopez-atl`). Deterministic — applied to both
sides of the collision, never just the newcomer. Same name **and** same team:
append shirt number after the abbr. Collisions across different competitions
are not collisions; the slug is season-scoped.

## Stability

- A published slug never changes. A player rename (marriage, transliteration
  fix) mints a new slug and the old one **redirects**; it is never reused for
  a different player.
- A transfer does not change the slug — it contains no team component unless
  collision-forced, and a collision-forced suffix is frozen at mint time.
- Proposed: the backend will store the slug as the player's public id
  alongside its internal UUIDv7. Implemented today: the UUIDv7 alone, which
  provider player ids map to only through `player_external_ref`, per the
  canonical-identity design. A scorer's `athleteId` is stored outside it as
  a provider-scoped value, never resolved there
  ([READER_CONTRACT, T16.2](READER_CONTRACT.md#t162-identity-and-dto-contract)).

## Enforcement

The frontend test suite asserts no rendered `href` matches
`/(player|team)/[0-9]+` — a bare provider number in a public link fails CI.
The backend API contract tests should assert the same about the public ids and
links in response bodies; the provider-scoped fields listed below are the
documented exceptions.

## The deliberate exception

Internal match-detail fetches (`/api/.../match/{eventId}`) still use provider
event ids. They are client plumbing, not shareable URLs, and are replaced
wholesale by the API cutover (slice 1d). Do not extend this exception to
players or teams.

Some responses carry the provider athlete id as a provider-scoped value, never
a public id and never in a URL: `Scorer.athleteId`, `LineupPlayer.athleteId`
and `StatLeader.athleteId`, which the route layer resolves to the player's slug
for links, and, on the frontend API, `SquadPlayer.id` and `PlayerProfile.id`.
The reader serves source-qualified nullable `Scorer.athleteId`,
`LineupPlayer.athleteId` and `StatLeader.athleteId`; its T10.4 profile `id` is
a canonical UUID. See [the T16.2 contract](READER_CONTRACT.md#t162-identity-and-dto-contract).

Existing lineup `jersey` image URLs can embed provider event and athlete ids;
T10.2 preserves those stored asset URLs. They are not public player route
identifiers. T10.4 does not synthesize headshot or flag URLs from provider ids.
