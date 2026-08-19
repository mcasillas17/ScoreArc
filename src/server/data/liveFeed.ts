import type { Match } from './types';
import type { Competition } from './competitions';

/**
 * One match, labelled with the competition it belongs to.
 *
 * `Match` carries no competition field, so a row in a list that mixes
 * competitions could not name its league without the client joining against a
 * second list. The label travels with the match instead.
 */
export interface LiveEntry {
  competition: { id: string; seasonId: string; name: string; shortName: string; emblem: string };
  match: Match;
}

/** The subset of a competition a list row needs. Deliberately not the whole
 *  Competition object: seasons and accents have no business in a payload the
 *  client polls every 30 seconds. */
export function competitionLabel(comp: Competition, seasonId: string): LiveEntry['competition'] {
  // seasonId travels too: a band row links straight to that competition's
  // matches page, and the bare /c/{comp} route redirects to the season root
  // rather than to the matches list.
  return { id: comp.id, seasonId, name: comp.name, shortName: comp.shortName, emblem: comp.emblem };
}

export function toLiveEntries(comp: Competition, seasonId: string, matches: Match[]): LiveEntry[] {
  const competition = competitionLabel(comp, seasonId);
  return matches.map((match) => ({ competition, match }));
}

export function sortEntriesByKickoff(entries: LiveEntry[]): LiveEntry[] {
  return [...entries].sort(
    (a, b) => new Date(a.match.kickoff).getTime() - new Date(b.match.kickoff).getTime(),
  );
}
