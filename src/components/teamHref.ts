import type { Team } from '@/server/data/types';

/**
 * Where a crest leads, or undefined to leave it inert.
 *
 * teamBase is the competition-scoped prefix (`/c/liga-mx/2026-apertura/team`).
 * Callers that do not have one -- or teams without a real id, such as a
 * bracket placeholder -- get undefined, and TeamBadge renders no link.
 */
export function teamHref(teamBase: string | undefined, team: Pick<Team, 'id'>): string | undefined {
  if (!teamBase || !team.id) return undefined;
  return `${teamBase}/${encodeURIComponent(team.id)}`;
}
