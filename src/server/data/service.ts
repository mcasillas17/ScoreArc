import type { Match, Group, BracketRound, Shootout, MatchSummaryData, TopScorer } from './types';
import { mapScoreboard } from './providers/espn-matches';
import { mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups, mapSummaryVideos, mapSummaryShootout, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H } from './providers/espn-summary';
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
  ): Promise<MatchSummaryData> {
    const key = `summary:${eventId}`;
    const cached = deps.cache.get(key) as MatchSummaryData | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(SUMMARY_URL(eventId));
    const summary: MatchSummaryData = {
      scorers: mapSummaryScorers(raw),
      cards: mapSummaryCards(raw),
      stats: mapSummaryStats(raw, homeId, awayId),
      winProbability: mapWinProbability(raw, homeId, awayId),
      lineups: mapSummaryLineups(raw, homeId, awayId),
      videos: mapSummaryVideos(raw),
      shootoutDetail: mapSummaryShootout(raw, homeId, awayId),
      info: mapSummaryInfo(raw),
      form: mapSummaryForm(raw, homeId, awayId),
      commentary: mapSummaryCommentary(raw),
      h2h: mapSummaryH2H(raw),
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

      // Enrich EVERY match in the live window: live/finished get scorers,
      // cards, stats and the shootout; scheduled matches still get the
      // odds-implied win probability for the pre-match card.
      const emptySummary: MatchSummaryData = {
        scorers: [],
        cards: [],
        stats: null,
        winProbability: null,
        lineups: null,
        videos: [],
        shootoutDetail: null,
        info: null,
        form: null,
        commentary: [],
        h2h: [],
      };
      const summaries = await Promise.all(
        matches.map((m) =>
          getMatchSummary(m.id, m.home.id, m.away.id).catch(() => emptySummary)
        )
      );
      matches.forEach((m, i) => {
        m.scorers = summaries[i].scorers;
        m.cards = summaries[i].cards;
        m.stats = summaries[i].stats;
        m.winProbability = summaries[i].winProbability;
        m.shootoutDetail = summaries[i].shootoutDetail;
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

    async getBracket(ttlMs = 8_000): Promise<BracketRound[]> {
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
  // `cache: 'no-store'` opts out of Next.js's fetch Data Cache so we always get
  // the current ESPN state — our own short-lived TtlCache is the only caching
  // layer, which keeps live scores/bracket fresh instead of served stale.
  const res = await fetch(url, {
    headers: { 'User-Agent': 'wc2026-bracket' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

export const dataService = createDataService({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});
