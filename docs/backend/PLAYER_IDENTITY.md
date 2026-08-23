# Player identity — the slug contract

**Status:** Proposed · 2026-08-22
**Applies to:** frontend player pages (E5) and the backend data model / API.
**Owners:** both sides. The frontend derives these slugs from provider data
today; the backend mints the same slugs as canonical player ids. If the two
algorithms drift, every player URL 404s on the day the frontend migrates to
our API — silently, per player. This document exists so they cannot drift.

## The rule

A player's public identifier is a **name slug**, scoped to a competition
season. Provider ids (ESPN athlete numbers) never appear in URLs, rendered
HTML, or API responses — same rule the team pages already follow
(`mex-america`, never `227`).

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
- The backend stores the slug as the player's public id alongside its internal
  UUIDv7; provider ids live only in `*_external_ref` crosswalk tables, per the
  canonical-identity design.

## Enforcement

The frontend test suite asserts no rendered `href` matches
`/(player|team)/[0-9]+` — a bare provider number in a public link fails CI.
The backend API contract tests should assert the same about response bodies.

## The deliberate exception

Internal match-detail fetches (`/api/.../match/{eventId}`) still use provider
event ids. They are client plumbing, not shareable URLs, and are replaced
wholesale by the API cutover (slice 1d). Do not extend this exception to
players or teams.
