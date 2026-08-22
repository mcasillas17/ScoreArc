/**
 * The player slug contract -- the public identity of a player in a URL.
 *
 * This algorithm is published in docs/backend/PLAYER_IDENTITY.md and the
 * backend mints the same slugs as canonical player ids. Changing it here
 * without changing it there breaks every player URL at the API cutover, so
 * treat the doc as the spec and this file as one of its two implementations.
 *
 * Provider ids (ESPN athlete numbers) never appear in URLs -- the same rule
 * team pages follow via teamIdentity.ts. The slug is the key; the provider id
 * stays behind the DataStore seam.
 */

export interface SlugEntry {
  name: string;
  providerId: string;
  teamAbbr: string;
  jersey?: string | null;
}

export interface ResolvedPlayer {
  providerId: string;
  name: string;
}

/** NFD-fold accents, lowercase, collapse non-alphanumerics to hyphens. */
export function playerSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build slug -> player for one competition season, applying the collision
 * policy: a contested slug is withdrawn and BOTH claimants get their team
 * abbreviation appended; same name and same team fall back to jersey number.
 * Deterministic -- no entry's slug depends on iteration order.
 */
export function buildSlugMap(entries: SlugEntry[]): Map<string, ResolvedPlayer> {
  const byBase = new Map<string, SlugEntry[]>();
  for (const entry of entries) {
    const base = playerSlug(entry.name);
    if (!base) continue;
    const list = byBase.get(base);
    if (list) list.push(entry);
    else byBase.set(base, [entry]);
  }

  const map = new Map<string, ResolvedPlayer>();
  for (const [base, claimants] of Array.from(byBase.entries())) {
    if (claimants.length === 1) {
      map.set(base, { providerId: claimants[0].providerId, name: claimants[0].name });
      continue;
    }
    for (const entry of claimants) {
      const abbr = playerSlug(entry.teamAbbr);
      const sameTeam = claimants.some((c) => c !== entry && playerSlug(c.teamAbbr) === abbr);
      const suffix = sameTeam && entry.jersey ? `${abbr}-${playerSlug(String(entry.jersey))}` : abbr;
      map.set(`${base}-${suffix}`, { providerId: entry.providerId, name: entry.name });
    }
  }
  return map;
}
