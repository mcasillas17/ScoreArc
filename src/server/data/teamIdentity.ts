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
 * The canonical id for a provider's team id, or null when the club is not yet
 * curated.
 *
 * Null is a real answer, not a failure. A club ESPN knows and the seed does not
 * becomes a `provisional` row in the backend and has no canonical id until
 * someone curates it -- so it has no URL, and its crest stays unlinked rather
 * than pointing at a page that cannot resolve.
 */
export function canonicalTeamId(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  return providerToCanonical[String(providerId)] ?? null;
}

/**
 * The provider id to fetch for a canonical team id, or null if we do not know
 * that team. Used to turn a URL back into an upstream request.
 */
export function providerTeamId(canonicalId: string | null | undefined): string | null {
  if (!canonicalId) return null;
  return canonicalToProvider[String(canonicalId)] ?? null;
}
