import type { Match, Group, BracketRound } from './types';
import { mapScoreboard } from './providers/espn-matches';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { TtlCache } from './cache';

export const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
export const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';
export const BRACKET_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260719';

export interface DataDeps {
  fetchJson: (url: string) => Promise<unknown>;
  cache: TtlCache<unknown>;
}

export function createDataService(deps: DataDeps) {
  return {
    async getMatches(ttlMs = 20_000): Promise<Match[]> {
      const cached = deps.cache.get('matches') as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(SCOREBOARD_URL);
      const matches = mapScoreboard(raw);
      deps.cache.set('matches', matches, ttlMs);
      return matches;
    },
    async getGroups(ttlMs = 60_000): Promise<Group[]> {
      const cached = deps.cache.get('groups') as Group[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(STANDINGS_URL);
      const groups = mapStandings(raw);
      deps.cache.set('groups', groups, ttlMs);
      return groups;
    },
    async getBracket(ttlMs = 20_000): Promise<BracketRound[]> {
      const cached = deps.cache.get('bracket') as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(BRACKET_URL);
      const rounds = mapBracket(raw);
      deps.cache.set('bracket', rounds, ttlMs);
      return rounds;
    },
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': 'wc2026-bracket' } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

export const dataService = createDataService({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});
