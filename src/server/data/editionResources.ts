import { resolveSeason, supportsResource, type CompetitionSeason, type EditionResource } from './competitions';
import type { DataStore } from './store';

// Larger fields require paged membership and roster reads before onboarding.
export const MAX_EDITION_TEAMS = 100;
export const MAX_SQUAD_PLAYERS = 100;

export function matchDerivedMembership(rc: CompetitionSeason) {
  return !supportsResource(rc.season, 'standings') || !!rc.season.computedTables;
}

export function resolveResource(competition: string, season: string, ...resources: EditionResource[]) {
  const scope = resolveSeason(competition, season);
  return scope && resources.every(resource => supportsResource(scope.season, resource)) ? scope : undefined;
}

export function resourceRead<Args extends unknown[], Result>(
  resource: EditionResource,
  read: (scope: CompetitionSeason, ...args: Args) => Promise<Result>,
) {
  return async (scope: CompetitionSeason, ...args: Args): Promise<Result> => {
    if (!supportsResource(scope.season, resource)) throw new Error('Unsupported edition resource');
    return read(scope, ...args);
  };
}

// Apply the same policy inside each source attempt, before caching, fallback or I/O.
export function withEditionResources(source: DataStore): DataStore {
  return {
    getMatches: resourceRead('scores', source.getMatches),
    getFixtures: resourceRead('scores', source.getFixtures),
    getLiveWindow: resourceRead('scores', source.getLiveWindow),
    getUpcoming: resourceRead('scores', source.getUpcoming),
    getEditionTeams: resourceRead('teams', source.getEditionTeams),
    getStandings: resourceRead('standings', source.getStandings),
    getBracket: resourceRead('bracket', source.getBracket),
    getMatchSummary: resourceRead('summary', source.getMatchSummary),
    getLeaders: resourceRead('leaders', source.getLeaders),
    getNews: resourceRead('news', source.getNews),
    getTeam: resourceRead('teams', source.getTeam),
    getSquad: resourceRead('squad', source.getSquad),
    getPlayer: resourceRead('players', source.getPlayer),
  };
}
