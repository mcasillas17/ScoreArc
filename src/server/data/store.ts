import type {
  Match,
  BracketRound,
  Shootout,
  MatchSummaryData,
  StatLeader,
  NewsArticle,
  Group,
  TeamProfile,
} from './types';
import type { CompetitionSeason } from './competitions';
import {
  scoreboardUrl,
  standingsUrl,
  summaryUrl,
  bracketUrl,
  statisticsUrl,
  newsUrl,
  teamsUrl,
  teamUrl,
  teamRosterUrl,
  teamScheduleUrl,
} from './endpoints';
import { mapScoreboard } from './providers/espn-matches';
import { mapTeamProfile, mapTeamRoster, mapTeamSchedule } from './providers/espn-team';
import { splitLeagueTeamIds } from './providers/espn-teams';
import { computePhaseTables } from './leaguesCupTables';
import { computeOverallTable } from './mlsTables';
import { mapNews } from './providers/espn-news';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { mapLeaders } from './providers/espn-stats';
import {
  mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups,
  mapSummaryVideos, mapSummaryShootout, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H,
} from './providers/espn-summary';
import { TtlCache } from './cache';
import { nowWindowRange } from './dateRange';

// The store is keyed on a resolved (competition, season) pair. The ESPN league
// slug lives on the competition; per-season fetch details (e.g. the bracket
// date range) live on the season.
export interface DataStore {
  getMatches(rc: CompetitionSeason, range?: string): Promise<Match[]>;
  getFixtures(rc: CompetitionSeason, range: string): Promise<Match[]>;
  getLiveWindow(rc: CompetitionSeason): Promise<Match[]>;
  getUpcoming(rc: CompetitionSeason, limit?: number): Promise<Match[]>;
  getStandings(rc: CompetitionSeason): Promise<Group[]>;
  getBracket(rc: CompetitionSeason): Promise<BracketRound[]>;
  getMatchSummary(rc: CompetitionSeason, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getLeaders(rc: CompetitionSeason): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }>;
  getTopScorers(rc: CompetitionSeason): Promise<StatLeader[]>;
  getTopAssists(rc: CompetitionSeason): Promise<StatLeader[]>;
  getNews(rc: CompetitionSeason): Promise<NewsArticle[]>;
  getTeam(rc: CompetitionSeason, teamId: string): Promise<TeamProfile | null>;
}

// How many scorers the Golden Boot table shows.
export const TOP_SCORERS_SHOWN = 10;

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

// ESPN scoreboard `dates` range covering today through `days` ahead. Used by
// the fixture banner, which must see past the end of the current week: a
// season starting next Friday has fixtures, and a banner that says otherwise
// is wrong rather than merely empty.
export function forwardRange(now: Date, days = 28): string {
  const end = new Date(now);
  end.setDate(now.getDate() + days);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(now)}-${fmt(end)}`;
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
  // Both leaderboards arrive in ONE /statistics response. Fetch it once, map
  // both, cache the pair — rendering two tables must not mean two requests for
  // a payload we already hold. A free function rather than a store method so
  // the two getters cannot be detached from their `this`.
  async function loadLeaders(
    rc: CompetitionSeason,
    ttlMs = 60_000,
  ): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }> {
    const k = key(rc, 'leaders');
    const cached = deps.cache.get(k) as { scorers: StatLeader[]; assists: StatLeader[] } | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(statisticsUrl(slug(rc)));
    // Ten is the Golden Boot race; twenty is a list nobody scrolls. The mapper
    // keeps its wider default for any caller that wants the tail.
    const boards = {
      scorers: mapLeaders(raw, 'goalsLeaders', TOP_SCORERS_SHOWN),
      assists: mapLeaders(raw, 'assistsLeaders', TOP_SCORERS_SHOWN),
    };
    deps.cache.set(k, boards, ttlMs);
    return boards;
  }

  // One unenriched scoreboard read. Shared by getFixtures and getLiveWindow,
  // which differ only in cache key and TTL — a calendar month is settled for
  // two minutes, a live scoreline is not.
  async function loadWindow(
    rc: CompetitionSeason,
    range: string,
    cacheKey: string,
    ttlMs: number,
  ): Promise<Match[]> {
    const k = key(rc, cacheKey);
    const cached = deps.cache.get(k) as Match[] | undefined;
    if (cached) return cached;
    const raw = await deps.fetchJson(scoreboardUrl(slug(rc), range));
    const matches = mapScoreboard(raw)
      .map((m) => ({ ...m, shootout: parseShootout(m.note, m.home.name, m.away.name) }))
      .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
    deps.cache.set(k, matches, ttlMs);
    return matches;
  }

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

    async getMatches(rc, range?: string, ttlMs = 10_000): Promise<Match[]> {
      const window = range ?? currentWeekRange(new Date());
      // The range is part of the identity of this result. Without it in the
      // key, the first window fetched is served for every later one.
      const k = key(rc, `matches:${window}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(scoreboardUrl(slug(rc), window));
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

    // A calendar month of results, with NO summary enrichment.
    //
    // getMatches fetches one summary per match, which is right for a live
    // matchday of ten fixtures and ruinous for a month of forty -- the same
    // trap getUpcoming avoids. A calendar row needs kickoff, teams, state and
    // score; the match popup fetches the summary when a match is actually
    // clicked.
    //
    // Longer TTL than getMatches for the same reason: a finished month does
    // not change.
    async getFixtures(rc, range: string, ttlMs = 120_000): Promise<Match[]> {
      return loadWindow(rc, range, `fixtures:${range}`, ttlMs);
    },

    // The window the live band and the "Now" view read. Same unenriched
    // scoreboard as getFixtures, on its own cache key and a far shorter TTL:
    // the band polls every 30s, and serving it a 120s-old entry would render
    // "67'" beside a two-minute-old scoreline.
    async getLiveWindow(rc, ttlMs = 15_000): Promise<Match[]> {
      const range = nowWindowRange(new Date());
      return loadWindow(rc, range, `live:${range}`, ttlMs);
    },

    // The next fixtures, however far out they are.
    //
    // getMatches deliberately looks only at the current Monday→Sunday week and
    // enriches every match with its full summary. That is right for a live
    // matchday and wrong for a fixture banner: a league whose next match falls
    // next week returns nothing, which is why five of nine competitions showed
    // an empty banner while between them holding 132 scheduled fixtures.
    //
    // This fetches a forward window and does NO summary enrichment — a banner
    // needs kickoff, teams and state, and pulling a summary per match would
    // turn one request into thirty.
    async getUpcoming(rc, limit = 12, ttlMs = 60_000): Promise<Match[]> {
      const k = key(rc, `upcoming:${limit}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(scoreboardUrl(slug(rc), forwardRange(new Date())));
      const upcoming = mapScoreboard(raw)
        .filter((m) => m.state === 'scheduled')
        .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
        .slice(0, limit);
      deps.cache.set(k, upcoming, ttlMs);
      return upcoming;
    },

    // A club within one competition. Three payloads fetched in parallel and
    // cached as one.
    //
    // The failure modes are deliberately different. Identity is what the page
    // is, so a failed profile fetch is null and the route 404s. The squad and
    // the schedule are blocks on that page, so a failure there degrades to an
    // empty block -- losing the whole page because the fixture list timed out
    // would be a worse answer than showing the club without it.
    async getTeam(rc, teamId: string, ttlMs = 120_000): Promise<TeamProfile | null> {
      const k = key(rc, `team:${teamId}`);
      const cached = deps.cache.get(k) as TeamProfile | undefined;
      if (cached) return cached;

      try {
        const [rawProfile, rawRoster, rawSchedule] = await Promise.all([
          deps.fetchJson(teamUrl(slug(rc), teamId)),
          deps.fetchJson(teamRosterUrl(slug(rc), teamId)).catch(() => null),
          deps.fetchJson(teamScheduleUrl(slug(rc), teamId)).catch(() => null),
        ]);

        const base = mapTeamProfile(rawProfile);
        if (!base) return null;

        const profile: TeamProfile = {
          ...base,
          squad: rawRoster ? mapTeamRoster(rawRoster) : [],
          schedule: rawSchedule ? mapTeamSchedule(rawSchedule) : [],
        };
        deps.cache.set(k, profile, ttlMs);
        return profile;
      } catch {
        return null;
      }
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

    getLeaders: loadLeaders,

    async getTopScorers(rc): Promise<StatLeader[]> {
      return (await loadLeaders(rc)).scorers;
    },

    async getTopAssists(rc): Promise<StatLeader[]> {
      return (await loadLeaders(rc)).assists;
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
