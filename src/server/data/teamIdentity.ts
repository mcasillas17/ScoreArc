import crosswalk from './teamCrosswalk.json';

/**
 * Our canonical team ids, and the provider ids they stand in for.
 *
 * URLs are addressed by the canonical id (`mex-america`), never by the
 * provider's number. Two reasons, and the second is the one that matters:
 *
 * 1. `/team/mex-america` says what it is; `/team/227` says nothing.
 * 2. The whole point of the backend build is to stop depending on ESPN. Baking
 *    ESPN's identifiers into our public URLs would mean every team link breaks
 *    on the day we switch providers -- and our own reader API is already
 *    addressed by canonical ids, so the two halves would disagree.
 *
 * The mapping is generated from backend/config/teams.seed.json, which is
 * curated by hand. Run `npm run export:teams` after editing the seed.
 */
const providerToCanonical: Record<string, string> = crosswalk;

const canonicalToProvider: Record<string, string> = Object.fromEntries(
  Object.entries(providerToCanonical).map(([provider, canonical]) => [canonical, provider]),
);

/**
 * The canonical id for a team id in either representation, or null when the
 * club is not yet curated.
 *
 * The ESPN store hands out provider ids (`227`); the reader API hands out our
 * canonical ids (`mex-america`). Both reach the same helpers -- teamHref, the
 * team index, follows -- so a canonical id canonicalizes to itself. The two id
 * spaces are disjoint (numbers vs slugs; teamIdentity.test.ts pins it), so the
 * answer is never ambiguous.
 *
 * Null is a real answer, not a failure. A club ESPN knows and the seed does not
 * becomes a `provisional` row in the backend (`prov-espn-360`) and has no
 * canonical id until someone curates it -- so it has no URL, and its crest
 * stays unlinked rather than pointing at a page that cannot resolve.
 */
export function canonicalTeamId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (Object.hasOwn(providerToCanonical, id)) return providerToCanonical[id];
  return Object.hasOwn(canonicalToProvider, id) ? id : null;
}

/**
 * The provider id to fetch for a canonical team id, or null if we do not know
 * that team. Used to turn a URL back into an upstream request.
 */
export function providerTeamId(canonicalId: string | null | undefined): string | null {
  if (!canonicalId) return null;
  return Object.hasOwn(canonicalToProvider, canonicalId) ? canonicalToProvider[canonicalId] : null;
}
