import type { Match, BracketRound, Shootout, MatchSummaryData, TopScorer, NewsArticle, Group } from './types';
import type { Competition } from './competitions';
import { COMPETITIONS } from './competitions';
import { scoreboardUrl, standingsUrl, summaryUrl, bracketUrl, statisticsUrl, newsUrl } from './endpoints';
import { mapScoreboard } from './providers/espn-matches';
import { mapNews } from './providers/espn-news';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { mapTopScorers } from './providers/espn-stats';
import {
  mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups,
  mapSummaryVideos, mapSummaryShootout, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H,
} from './providers/espn-summary';
import { TtlCache } from './cache';

export interface DataStore {
  getMatches(comp: Competition): Promise<Match[]>;
  getStandings(comp: Competition): Promise<Group[]>;
  getBracket(comp: Competition): Promise<BracketRound[]>;
  getMatchSummary(comp: Competition, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getTopScorers(comp: Competition): Promise<TopScorer[]>;
  getNews(comp: Competition): Promise<NewsArticle[]>;
}

export interface DataDeps {
  fetchJson: (url: string) => Promise<unknown>;
  cache: TtlCache<unknown>;
}

// Penalty shootout aggregate parsed from a match note, e.g.
// "Paraguay advance 4-3 on penalties".
function parseShootout(note: string | null, homeName: string, awayName: string): Shootout | null {
  if (!note) return null;
  const m = note.match(/(\d+)\s*[-–]\s*(\d+)\s+on penalties/i);
  if (!m) return null;
  const aNum = Number(m[1]);
  const bNum = Number(m[2]);
  const winnerScore = Math.max(aNum, bNum);
  const loserScore = Math.min(aNum, bNum);
  const noteLower = note.toLowerCase();
  if (noteLower.includes(homeName.toLowerCase())) return { homeScore: winnerScore, awayScore: loserScore };
  if (noteLower.includes(awayName.toLowerCase())) return { homeScore: loserScore, awayScore: winnerScore };
  return { homeScore: aNum, awayScore: bNum };
}

const EMPTY_SUMMARY: MatchSummaryData = {
  scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
  videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [],
};

export function createDataStore(deps: DataDeps): DataStore {
  const key = (comp: Competition, k: string) => `${comp.id}:${k}`;

  async function getMatchSummary(
    comp: Competition, eventId: string, homeId: string, awayId: string, ttlMs = 12_000,
  ): Promise<MatchSummaryData> {
    const k = key(comp, `summary:${eventId}`);
    const cached = deps.cache.get(k) as MatchSummaryData | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(summaryUrl(comp.espnSlug, eventId));
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
    deps.cache.set(k, summary, ttlMs);
    return summary;
  }

  return {
    getMatchSummary,

    async getMatches(comp, ttlMs = 10_000): Promise<Match[]> {
      const k = key(comp, 'matches');
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(scoreboardUrl(comp.espnSlug));
      const matches = mapScoreboard(raw);
      const summaries = await Promise.all(
        matches.map((m) => getMatchSummary(comp, m.id, m.home.id, m.away.id).catch(() => EMPTY_SUMMARY)),
      );
      matches.forEach((m, i) => {
        m.scorers = summaries[i].scorers;
        m.cards = summaries[i].cards;
        m.stats = summaries[i].stats;
        m.winProbability = summaries[i].winProbability;
        m.shootoutDetail = summaries[i].shootoutDetail;
      });
      for (const m of matches) m.shootout = parseShootout(m.note, m.home.name, m.away.name);
      deps.cache.set(k, matches, ttlMs);
      return matches;
    },

    async getStandings(comp, ttlMs = 60_000): Promise<Group[]> {
      const k = key(comp, 'groups');
      const cached = deps.cache.get(k) as Group[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(standingsUrl(comp.espnSlug));
      const groups = mapStandings(raw);
      deps.cache.set(k, groups, ttlMs);
      return groups;
    },

    async getBracket(comp, ttlMs = 8_000): Promise<BracketRound[]> {
      const k = key(comp, 'bracket');
      const cached = deps.cache.get(k) as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(bracketUrl(comp.espnSlug, comp.bracketDatesRange));
      const rounds = mapBracket(raw);
      deps.cache.set(k, rounds, ttlMs);
      return rounds;
    },

    async getTopScorers(comp, ttlMs = 60_000): Promise<TopScorer[]> {
      const k = key(comp, 'topscorers');
      const cached = deps.cache.get(k) as TopScorer[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(statisticsUrl(comp.espnSlug));
      const scorers = mapTopScorers(raw);
      deps.cache.set(k, scorers, ttlMs);
      return scorers;
    },

    async getNews(comp, ttlMs = 90_000): Promise<NewsArticle[]> {
      const k = key(comp, 'news');
      const cached = deps.cache.get(k) as NewsArticle[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(newsUrl(comp.espnSlug));
      const news = mapNews(raw);
      deps.cache.set(k, news, ttlMs);
      return news;
    },
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': 'scorearc' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

export const dataStore: DataStore = createDataStore({
  fetchJson: defaultFetchJson,
  cache: new TtlCache(),
});

// Convenience re-export so route/page code can resolve a competition + store together.
export { COMPETITIONS };
