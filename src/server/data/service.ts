import type { Match, Group, BracketRound, Scorer, Shootout } from './types';
import { mapScoreboard } from './providers/espn-matches';
import { mapSummaryScorers } from './providers/espn-summary';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { TtlCache } from './cache';

export const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
export const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';
export const BRACKET_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260719';
export const SUMMARY_URL = (id: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${id}`;

export interface DataDeps {
  fetchJson: (url: string) => Promise<unknown>;
  cache: TtlCache<unknown>;
}

function parseShootout(
  note: string | null,
  homeName: string,
  awayName: string
): Shootout | null {
  if (!note) return null;
  const m = note.match(/(\d+)\s*[-–]\s*(\d+)\s+on penalties/i);
  if (!m) return null;
  const aNum = Number(m[1]);
  const bNum = Number(m[2]);
  const winnerScore = Math.max(aNum, bNum);
  const loserScore = Math.min(aNum, bNum);
  const noteLower = note.toLowerCase();
  if (noteLower.includes(homeName.toLowerCase())) {
    return { homeScore: winnerScore, awayScore: loserScore };
  }
  if (noteLower.includes(awayName.toLowerCase())) {
    return { homeScore: loserScore, awayScore: winnerScore };
  }
  // fallback: first number → home, second → away
  return { homeScore: aNum, awayScore: bNum };
}

export function createDataService(deps: DataDeps) {
  async function getMatchScorers(eventId: string, ttlMs = 12_000): Promise<Scorer[]> {
    const key = `summary:${eventId}`;
    const cached = deps.cache.get(key) as Scorer[] | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(SUMMARY_URL(eventId));
    const scorers = mapSummaryScorers(raw);
    deps.cache.set(key, scorers, ttlMs);
    return scorers;
  }

  return {
    getMatchScorers,

    async getMatches(ttlMs = 10_000): Promise<Match[]> {
      const cached = deps.cache.get('matches') as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(SCOREBOARD_URL);
      const matches = mapScoreboard(raw);

      // Enrich live and finished matches with scorer data in parallel
      const enrichable = matches.filter(
        (m) => m.state === 'live' || m.state === 'finished'
      );
      const scorersResults = await Promise.all(
        enrichable.map((m) => getMatchScorers(m.id).catch((): Scorer[] => []))
      );
      enrichable.forEach((m, i) => {
        m.scorers = scorersResults[i];
      });

      // Parse penalty shootout from note
      for (const m of matches) {
        m.shootout = parseShootout(m.note, m.home.name, m.away.name);
      }

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
