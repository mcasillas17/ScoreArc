import type { Match } from './types';
import { supportsResource, type Competition, type Season, type TeamStyle } from './competitions';

/**
 * One match, labelled with the competition it belongs to.
 *
 * `Match` carries no competition field, so a row in a list that mixes
 * competitions could not name its league without the client joining against a
 * second list. The label travels with the match instead.
 */
export interface LiveEntry {
  competition: { id: string; seasonId: string; name: string; shortName: string; emblem: string; logo?: string; logoInvert?: boolean;
    /** Set when the edition has match summaries: the card opens the detail popup in place. */
    popup?: { teamStyle: TeamStyle; teams: boolean; players: boolean } };
  match: Match;
}

/** The subset of a competition a list row needs. Deliberately not the whole
 *  Competition object: seasons and accents have no business in the home
 *  page's embedded payload. */
export function competitionLabel(comp: Competition, seasonId: string, season?: Season): LiveEntry['competition'] {
  // seasonId travels too: a band row links straight to that competition's
  // matches page, and the bare /c/{comp} route redirects to the season root
  // rather than to the matches list.
  return {
    id: comp.id,
    seasonId,
    name: comp.name,
    shortName: comp.shortName,
    emblem: comp.emblem,
    logo: comp.logo,
    logoInvert: comp.logoInvert,
    popup: season && supportsResource(season, 'summary')
      ? { teamStyle: comp.teamStyle, teams: supportsResource(season, 'teams'), players: supportsResource(season, 'players') }
      : undefined,
  };
}
