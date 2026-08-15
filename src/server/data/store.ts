import type { Match, BracketRound, Shootout, MatchSummaryData, TopScorer, NewsArticle, Group } from './types';
import type { CompetitionSeason } from './competitions';
import { scoreboardUrl, standingsUrl, summaryUrl, bracketUrl, statisticsUrl, newsUrl, teamsUrl } from './endpoints';
import { mapScoreboard } from './providers/espn-matches';
import { splitLeagueTeamIds } from './providers/espn-teams';
import { computePhaseTables } from './leaguesCupTables';
import { computeOverallTable } from './mlsTables';
import { mapNews } from './providers/espn-news';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { mapTopScorers } from './providers/espn-stats';
import {
  mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups,
  mapSummaryVideos, mapSummaryShootout, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H,
} from './providers/espn-summary';
import { TtlCache } from './cache';

// The store is keyed on a resolved (competition, season) pair. The ESPN league
// slug lives on the competition; per-season fetch details (e.g. the bracket
// date range) live on the season.
export interface DataStore {
  getMatches(rc: CompetitionSeason): Promise<Match[]>;
  getStandings(rc: CompetitionSeason): Promise<Group[]>;
  getBracket(rc: CompetitionSeason): Promise<BracketRound[]>;
  getMatchSummary(rc: CompetitionSeason, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getTopScorers(rc: CompetitionSeason): Promise<TopScorer[]>;
  getNews(rc: CompetitionSeason): Promise<NewsArticle[]>;
}

export interface DataDeps {
  fetchJson: (url: string) => Promise<unknown>;
  cache: TtlCache<unknown>;
}

// ESPN scoreboard `dates` range (YYYYMMDD-YYYYMMDD) covering the Monday→Sunday
// calendar week that contains `now` (local time). Used so the matches feed
// returns the whole current week's fixtures, not just ESPN's default (today).
export function currentWeekRange(now: Date): string {
  const mondayOffset = (now.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat → days since Monday
  const mon = new Date(now);
  mon.setDate(now.getDate() - mondayOffset);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(mon)}-${fmt(sun)}`;
}

// Penalty shootout aggregate parsed from a match note, e.g.
// "Paraguay advance 4-3 on penalties".
export function parseShootout(note: string | null, homeName: string, awayName: string): Shootout | null {
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

// Fresh empty summary per call — never shared, so enrichment fallbacks can't
// alias each other's arrays.
function emptySummary(): MatchSummaryData {
  return {
    scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
    videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [],
  };
}

export function createDataStore(deps: DataDeps): DataStore {
  // Cache keys are scoped per competition AND season so editions never collide.
  const key = (rc: CompetitionSeason, k: string) => `${rc.competition.id}:${rc.season.id}:${k}`;
  const slug = (rc: CompetitionSeason) => rc.competition.espnSlug;

  // Build a cross-league cup's tables from its results. Two fetches: the
  // phase's full date range (it spans more than one calendar week, so the
  // current-week matches feed cannot see all of it), and the club list of the
  // league that forms the second table.
  async function computeTables(
    rc: CompetitionSeason,
    config: NonNullable<CompetitionSeason['season']['computedTables']>,
  ): Promise<Group[]> {
    const [rawPhase, rawSplit] = await Promise.all([
      deps.fetchJson(scoreboardUrl(slug(rc), config.datesRange)),
      deps.fetchJson(teamsUrl(config.splitLeagueSlug)),
    ]);
    const matches = mapScoreboard(rawPhase).map((m) => ({
      ...m,
      shootout: parseShootout(m.note, m.home.name, m.away.name),
    }));
    const groups = computePhaseTables(matches, splitLeagueTeamIds(rawSplit), config.cut);
    // Carry the configured display names so the view doesn't hardcode them.
    for (const g of groups) {
      g.name = g.id === 'liga-mx' ? config.groupLabels.split : config.groupLabels.primary;
    }
    return groups;
  }

  async function getMatchSummary(
    rc: CompetitionSeason, eventId: string, homeId: string, awayId: string, ttlMs = 12_000,
  ): Promise<MatchSummaryData> {
    const k = key(rc, `summary:${eventId}`);
    const cached = deps.cache.get(k) as MatchSummaryData | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(summaryUrl(slug(rc), eventId));
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

    async getMatches(rc, ttlMs = 10_000): Promise<Match[]> {
      const k = key(rc, 'matches');
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      // Fetch the whole current week (Mon→Sun) so the ticker sees every fixture,
      // not just ESPN's default single-day scoreboard.
      const raw = await deps.fetchJson(scoreboardUrl(slug(rc), currentWeekRange(new Date())));
      const matches = mapScoreboard(raw);
      const summaries = await Promise.all(
        matches.map((m) => getMatchSummary(rc, m.id, m.home.id, m.away.id).catch(() => emptySummary())),
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

    async getStandings(rc, ttlMs = 60_000): Promise<Group[]> {
      const k = key(rc, 'standings');
      const cached = deps.cache.get(k) as Group[] | undefined;
      if (cached) return cached;
      // Some competitions have no published table at all — ESPN's /standings
      // returns `{}` for the Leagues Cup even for finished seasons. Compute it
      // from results instead of returning nothing.
      const computed = rc.season.computedTables;
      if (computed) {
        const groups = await computeTables(rc, computed);
        deps.cache.set(k, groups, ttlMs);
        return groups;
      }
      const raw = await deps.fetchJson(standingsUrl(slug(rc)));
      const groups = mapStandings(raw);
      // A conference-split league also races for something league-wide that no
      // provider tabulates — MLS's Supporters' Shield. Merge it here so the view
      // receives it as one more table and needs no special case.
      const overall = rc.season.overallTable;
      if (overall) {
        const merged = computeOverallTable(groups, overall);
        if (merged) groups.push(merged);
      }
      deps.cache.set(k, groups, ttlMs);
      return groups;
    },

    async getBracket(rc, ttlMs = 8_000): Promise<BracketRound[]> {
      const k = key(rc, 'bracket');
      const cached = deps.cache.get(k) as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(bracketUrl(slug(rc), rc.season.bracketDatesRange));
      const rounds = mapBracket(raw);
      deps.cache.set(k, rounds, ttlMs);
      return rounds;
    },

    async getTopScorers(rc, ttlMs = 60_000): Promise<TopScorer[]> {
      const k = key(rc, 'topscorers');
      const cached = deps.cache.get(k) as TopScorer[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(statisticsUrl(slug(rc)));
      const scorers = mapTopScorers(raw);
      deps.cache.set(k, scorers, ttlMs);
      return scorers;
    },

    async getNews(rc, ttlMs = 90_000): Promise<NewsArticle[]> {
      const k = key(rc, 'news');
      const cached = deps.cache.get(k) as NewsArticle[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(newsUrl(slug(rc)));
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
