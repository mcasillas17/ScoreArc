import type { Match, Group, BracketRound, Scorer, Card, Shootout, MatchStats, WinProbability, MatchLineups, TopScorer } from './types';
import { mapScoreboard } from './providers/espn-matches';
import { mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups } from './providers/espn-summary';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { mapTopScorers } from './providers/espn-stats';
import { TtlCache } from './cache';

export const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
export const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';
export const BRACKET_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260719';
export const STATISTICS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/statistics';
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
  async function getMatchSummary(
    eventId: string,
    homeId: string,
    awayId: string,
    ttlMs = 12_000
  ): Promise<{
    scorers: Scorer[];
    cards: Card[];
    stats: MatchStats | null;
    winProbability: WinProbability | null;
    lineups: MatchLineups | null;
  }> {
    const key = `summary:${eventId}`;
    const cached = deps.cache.get(key) as
      | {
          scorers: Scorer[];
          cards: Card[];
          stats: MatchStats | null;
          winProbability: WinProbability | null;
          lineups: MatchLineups | null;
        }
      | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(SUMMARY_URL(eventId));
    const summary = {
      scorers: mapSummaryScorers(raw),
      cards: mapSummaryCards(raw),
      stats: mapSummaryStats(raw, homeId, awayId),
      winProbability: mapWinProbability(raw, homeId, awayId),
      lineups: mapSummaryLineups(raw, homeId, awayId),
    };
    deps.cache.set(key, summary, ttlMs);
    return summary;
  }

  return {
    getMatchSummary,

    async getMatches(ttlMs = 10_000): Promise<Match[]> {
      const cached = deps.cache.get('matches') as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(SCOREBOARD_URL);
      const matches = mapScoreboard(raw);

      // Enrich live and finished matches with scorer data in parallel
      const enrichable = matches.filter(
        (m) => m.state === 'live' || m.state === 'finished'
      );
      const summaries = await Promise.all(
        enrichable.map((m) =>
          getMatchSummary(m.id, m.home.id, m.away.id).catch(() => ({
            scorers: [] as Scorer[],
            cards: [] as Card[],
            stats: null as MatchStats | null,
            winProbability: null as WinProbability | null,
            lineups: null as MatchLineups | null,
          }))
        )
      );
      enrichable.forEach((m, i) => {
        m.scorers = summaries[i].scorers;
        m.cards = summaries[i].cards;
        m.stats = summaries[i].stats;
        m.winProbability = summaries[i].winProbability;
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

    async getBracket(ttlMs = 12_000): Promise<BracketRound[]> {
      const cached = deps.cache.get('bracket') as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(BRACKET_URL);
      const rounds = mapBracket(raw);
      deps.cache.set('bracket', rounds, ttlMs);
      return rounds;
    },

    async getTopScorers(ttlMs = 60_000): Promise<TopScorer[]> {
      const cached = deps.cache.get('topscorers') as TopScorer[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(STATISTICS_URL);
      const scorers = mapTopScorers(raw);
      deps.cache.set('topscorers', scorers, ttlMs);
      return scorers;
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
