import type {
  Match,
  BracketRound,
  Shootout,
  MatchSummaryData,
  StatLeader,
  NewsArticle,
  Group,
  TeamProfile,
  SquadPlayer,
  PlayerProfile,
} from './types';
import type { CompetitionSeason } from './competitions';
import {
  scoreboardUrl,
  standingsUrl,
  summaryUrl,
  statisticsUrl,
  newsUrl,
  teamsUrl,
  teamUrl,
  teamRosterUrl,
  teamScheduleUrl,
  athleteUrl, athleteOverviewUrl, athleteBioUrl,
} from './endpoints';
import { mapScoreboard } from './providers/espn-matches';
import { mapTeamProfile, mapTeamRoster, mapScopedTeamSchedule, splitLeagueTeamIds } from './providers/espn-team';
import { uniqueTeamMatches } from './teamPerformance';
import { mapAthleteProfile, mapAthleteOverview, mapAthleteBio } from './providers/espn-athlete';
import { computePhaseTables } from './leaguesCupTables';
import { computeOverallTable } from './mlsTables';
import { mapNews } from './providers/espn-news';
import { mapStandings } from './providers/espn-standings';
import { mapBracket } from './providers/espn-bracket';
import { mapLeaders } from './providers/espn-stats';
import {
  mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups,
  mapSummaryVideos, mapSummaryShootout, mapSummaryShootoutTotals, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H,
} from './providers/espn-summary';
import { TtlCache } from './cache';
import { currentWeekRange, forwardRange, nowWindowRange } from './dateRange';
import { fetchScoreboardWindow, boundedFetchJson, type ScoreboardFetchJson } from './scoreboardWindow';

// The store is keyed on a resolved (competition, season) pair. The ESPN league
// slug lives on the competition; per-season fetch details (e.g. the bracket
// date range) live on the season.
export interface DataStore {
  getMatches(rc: CompetitionSeason, range?: string, signal?: AbortSignal): Promise<Match[]>;
  getFixtures(rc: CompetitionSeason, range: string, signal?: AbortSignal): Promise<Match[]>;
  getLiveWindow(rc: CompetitionSeason): Promise<Match[]>;
  getUpcoming(rc: CompetitionSeason, limit?: number, signal?: AbortSignal): Promise<Match[]>;
  getStandings(rc: CompetitionSeason): Promise<Group[]>;
  getBracket(rc: CompetitionSeason): Promise<BracketRound[]>;
  getMatchSummary(rc: CompetitionSeason, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getLeaders(rc: CompetitionSeason): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }>;
  getNews(rc: CompetitionSeason): Promise<NewsArticle[]>;
  getTeam(rc: CompetitionSeason, teamId: string): Promise<TeamProfile | null>;
  getSquad(rc: CompetitionSeason, teamId: string): Promise<SquadPlayer[]>;
  getPlayer(rc: CompetitionSeason, athleteId: string): Promise<PlayerProfile | null>;
}

// How many scorers the Golden Boot table shows.
const TOP_SCORERS_SHOWN = 10;

interface DataDeps {
  fetchJson: ScoreboardFetchJson;
  cache: TtlCache<unknown>;
}

// Re-exported: the scoreboard mapper owns the shootout precedence now.
export { parseShootout } from './providers/espn-matches';

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

  // Both leaderboards arrive in ONE /statistics response. Fetch it once, map
  // both, cache the pair — rendering two tables must not mean two requests for
  // a payload we already hold.
  async function loadLeaders(
    rc: CompetitionSeason,
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
    deps.cache.set(k, boards, 60_000);
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
    signal?: AbortSignal,
  ): Promise<Match[]> {
    signal?.throwIfAborted();
    const k = key(rc, cacheKey);
    const cached = deps.cache.get(k) as Match[] | undefined;
    if (cached) return cached;
    const raw = await fetchScoreboardWindow(rc, range, deps.fetchJson, signal);
    const matches = mapScoreboard(raw)
      .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
    deps.cache.set(k, matches, ttlMs);
    return matches;
  }

  async function computeTables(
    rc: CompetitionSeason,
    config: NonNullable<CompetitionSeason['season']['computedTables']>,
  ): Promise<Group[]> {
    const [rawPhase, rawSplit] = await Promise.all([
      fetchScoreboardWindow(rc, config.datesRange, deps.fetchJson),
      deps.fetchJson(teamsUrl(config.splitLeagueSlug)),
    ]);
    const matches = mapScoreboard(rawPhase);
    const groups = computePhaseTables(matches, splitLeagueTeamIds(rawSplit), config.cut);
    // Carry the configured display names so the view doesn't hardcode them.
    for (const g of groups) {
      g.name = g.id === 'liga-mx' ? config.groupLabels.split : config.groupLabels.primary;
    }
    return groups;
  }

  // One summary read, cached with the header's shootout totals. MatchSummaryData
  // has no aggregate (neither does the reader's summary), but getMatches already
  // holds this summary and the header outranks the scoreboard's evidence.
  type LoadedSummary = { data: MatchSummaryData; shootout: Shootout | null };
  async function loadSummary(
    rc: CompetitionSeason, eventId: string, homeId: string, awayId: string, signal?: AbortSignal,
  ): Promise<LoadedSummary> {
    const k = key(rc, `summary:${eventId}`);
    const cached = deps.cache.get(k) as LoadedSummary | undefined;
    if (cached) return cached;
    signal?.throwIfAborted();
    const raw = await deps.fetchJson(summaryUrl(slug(rc), eventId), signal
      ? { signal, maxBytes: 4 * 1024 * 1024 } : undefined);
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
    const loaded = { data: summary, shootout: mapSummaryShootoutTotals(raw) };
    deps.cache.set(k, loaded, 12_000);
    return loaded;
  }

  async function getMatchSummary(
    rc: CompetitionSeason, eventId: string, homeId: string, awayId: string, signal?: AbortSignal,
  ): Promise<MatchSummaryData> {
    return (await loadSummary(rc, eventId, homeId, awayId, signal)).data;
  }

  return {
    getMatchSummary,

    async getMatches(rc, range?: string, signal?: AbortSignal): Promise<Match[]> {
      signal?.throwIfAborted();
      const window = range ?? currentWeekRange(new Date());
      // The range is part of the identity of this result. Without it in the
      // key, the first window fetched is served for every later one.
      const k = key(rc, `matches:${window}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const deadline = AbortSignal.timeout(15_000);
      const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const raw = await fetchScoreboardWindow(rc, window, deps.fetchJson, readSignal);
      const matches = mapScoreboard(raw);
      const summaries: LoadedSummary[] = [];
      // Only retained matches are enriched, four at a time under the same
      // read deadline. Individual provider summary failures remain best effort.
      for (let i = 0; i < matches.length; i += 4) {
        readSignal.throwIfAborted();
        summaries.push(...await Promise.all(matches.slice(i, i + 4).map(m =>
          loadSummary(rc, m.id, m.home.id, m.away.id, readSignal)
            .catch((): LoadedSummary => ({ data: emptySummary(), shootout: null })),
        )));
      }
      readSignal.throwIfAborted();
      matches.forEach((m, i) => {
        const { data, shootout } = summaries[i];
        m.scorers = data.scorers;
        m.cards = data.cards;
        m.stats = data.stats;
        m.winProbability = data.winProbability;
        m.shootoutDetail = data.shootoutDetail;
        m.shootout = shootout ?? m.shootout;
      });
      deps.cache.set(k, matches, 10_000);
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
    async getFixtures(rc, range: string, signal?: AbortSignal): Promise<Match[]> {
      return loadWindow(rc, range, `fixtures:${range}`, 120_000, signal);
    },

    // The window the live band and the "Now" view read. Same unenriched
    // scoreboard as getFixtures, on its own cache key and a far shorter TTL:
    // the band polls every 30s, and serving it a 120s-old entry would render
    // "67'" beside a two-minute-old scoreline.
    async getLiveWindow(rc): Promise<Match[]> {
      const range = nowWindowRange(new Date());
      return loadWindow(rc, range, `live:${range}`, 15_000);
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
    async getUpcoming(rc, limit = 12, signal?: AbortSignal): Promise<Match[]> {
      signal?.throwIfAborted();
      const range = forwardRange(new Date());
      const k = key(rc, `upcoming:${range}:${limit}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await fetchScoreboardWindow(rc, range, deps.fetchJson, signal);
      const upcoming = mapScoreboard(raw)
        .filter((m) => m.state === 'scheduled')
        .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
        .slice(0, limit);
      deps.cache.set(k, upcoming, 60_000);
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
    async getTeam(rc, teamId: string): Promise<TeamProfile | null> {
      const k = key(rc, `team:${teamId}`);
      const cached = deps.cache.get(k) as TeamProfile | undefined;
      if (cached) return cached;

      try {
        // Four requests, not three: the schedule endpoint returns played OR
        // upcoming matches depending on `fixture=true`, never both, so a
        // matches-and-results block has to ask twice.
        const [rawProfile, rawRoster, rawResults, rawFixtures] = await Promise.all([
          deps.fetchJson(teamUrl(slug(rc), teamId)),
          deps.fetchJson(teamRosterUrl(slug(rc), teamId)).catch(() => null),
          deps.fetchJson(teamScheduleUrl(slug(rc), teamId, false, rc.season.id)).catch(() => null),
          deps.fetchJson(teamScheduleUrl(slug(rc), teamId, true, rc.season.id)).catch(() => null),
        ]);

        const base = mapTeamProfile(rawProfile);
        if (!base || base.team.id !== teamId) return null;
        const results = mapScopedTeamSchedule(rawResults, rc, teamId);
        const upcoming = mapScopedTeamSchedule(rawFixtures, rc, teamId);

        const profile: TeamProfile = {
          ...base,
          squad: rawRoster ? mapTeamRoster(rawRoster) : [],
          schedule: uniqueTeamMatches([...results.matches, ...upcoming.matches]).reverse(),
          scheduleAvailability: {
            results: results.available ? 'available' : 'unavailable',
            upcoming: upcoming.available ? 'available' : 'unavailable',
          },
        };
        deps.cache.set(k, profile, 120_000);
        return profile;
      } catch {
        return null;
      }
    },

    // Roster only -- one request, for callers that need players but not the
    // profile or schedule (the player index reads every club in a
    // competition, so the 4-request getTeam would quadruple its cold cost).
    async getSquad(rc, teamId: string): Promise<SquadPlayer[]> {
      const k = key(rc, `squad:${teamId}`);
      const cached = deps.cache.get(k) as SquadPlayer[] | undefined;
      if (cached) return cached;
      try {
        const raw = await deps.fetchJson(teamRosterUrl(slug(rc), teamId));
        const squad = mapTeamRoster(raw);
        deps.cache.set(k, squad, 300_000);
        return squad;
      } catch {
        return [];
      }
    },

    // A player within one competition. Same failure split as getTeam:
    // identity is what the page is, so a failed profile is null and the route
    // 404s; the game log and career are blocks on that page and degrade to
    // empty rather than taking the page down. The two optional payloads'
    // sibling endpoints (/gamelog, /splits, /stats) are dead upstream and are
    // never called -- /overview and /bio are the only sources.
    async getPlayer(rc, athleteId: string): Promise<PlayerProfile | null> {
      const k = key(rc, `player:${athleteId}`);
      const cached = deps.cache.get(k) as PlayerProfile | undefined;
      if (cached) return cached;

      try {
        const [rawProfile, rawOverview, rawBio] = await Promise.all([
          deps.fetchJson(athleteUrl(slug(rc), athleteId)),
          deps.fetchJson(athleteOverviewUrl(slug(rc), athleteId)).catch(() => null),
          deps.fetchJson(athleteBioUrl(slug(rc), athleteId)).catch(() => null),
        ]);

        const identity = mapAthleteProfile(rawProfile);
        if (!identity) return null;

        const overview = rawOverview ? mapAthleteOverview(rawOverview) : { label: '', rows: [] };
        const profile: PlayerProfile = {
          ...identity,
          gameLogLabel: overview.label,
          gameLog: overview.rows,
          career: rawBio ? mapAthleteBio(rawBio) : [],
        };
        deps.cache.set(k, profile, 120_000);
        return profile;
      } catch {
        return null;
      }
    },

    async getStandings(rc): Promise<Group[]> {
      const k = key(rc, 'standings');
      const cached = deps.cache.get(k) as Group[] | undefined;
      if (cached) return cached;
      // Some competitions have no published table at all — ESPN's /standings
      // returns `{}` for the Leagues Cup even for finished seasons. Compute it
      // from results instead of returning nothing.
      const computed = rc.season.computedTables;
      if (computed) {
        const groups = await computeTables(rc, computed);
        deps.cache.set(k, groups, 60_000);
        return groups;
      }
      const raw = await deps.fetchJson(standingsUrl(slug(rc)));
      const groups = mapStandings(raw, rc.competition.shortName);
      // A conference-split league also races for something league-wide that no
      // provider tabulates — MLS's Supporters' Shield. Merge it here so the view
      // receives it as one more table and needs no special case.
      const overall = rc.season.overallTable;
      if (overall) {
        const merged = computeOverallTable(groups, overall);
        if (merged) groups.push(merged);
      }
      deps.cache.set(k, groups, 60_000);
      return groups;
    },

    async getBracket(rc): Promise<BracketRound[]> {
      const k = key(rc, 'bracket');
      const cached = deps.cache.get(k) as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = rc.season.bracketDatesRange
        ? await fetchScoreboardWindow(rc, rc.season.bracketDatesRange, deps.fetchJson)
        : await deps.fetchJson(scoreboardUrl(slug(rc)), {
          signal: AbortSignal.timeout(15_000), maxBytes: 4 * 1024 * 1024,
        });
      const rounds = mapBracket(raw);
      deps.cache.set(k, rounds, 8_000);
      return rounds;
    },

    getLeaders: loadLeaders,

    async getNews(rc): Promise<NewsArticle[]> {
      const k = key(rc, 'news');
      const cached = deps.cache.get(k) as NewsArticle[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(newsUrl(slug(rc)));
      const news = mapNews(raw);
      deps.cache.set(k, news, 90_000);
      return news;
    },
  };
}

export const dataStore: DataStore = createDataStore({
  fetchJson: boundedFetchJson,
  cache: new TtlCache(),
});
