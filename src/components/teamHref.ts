import type { Team } from '@/server/data/types';
import { canonicalTeamId } from '@/server/data/teamIdentity';

/**
 * Where a crest leads, or undefined to leave it inert.
 *
 * teamBase is the competition-scoped prefix (`/c/liga-mx/2026-apertura/team`),
 * and the last segment is our canonical id (`mex-america`), never the
 * provider's number -- see teamIdentity.ts for why.
 *
 * Undefined when there is no teamBase, or when the club is not curated yet: an
 * uncurated club has no canonical id, so it has no page, so its crest must not
 * pretend otherwise.
 */
export function teamHref(teamBase: string | undefined, team: Pick<Team, 'id'>): string | undefined {
  if (!teamBase) return undefined;
  const canonical = canonicalTeamId(team.id);
  if (!canonical) return undefined;
  return `${teamBase}/${encodeURIComponent(canonical)}`;
}
