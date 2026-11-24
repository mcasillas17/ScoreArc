import { unstable_cache } from 'next/cache';
import { configuredDataStore } from './configuredStore';
import { healthContext, type DependencyFault } from '@/lib/telemetry/http';
import { comparisonFault } from './readerComparison';
import { ReaderFailure } from './readerTransport';
import { providerReference } from './readerIdentity';
import { trackReaderFallback } from '@/lib/telemetry/server';
import type {
  Match,
  BracketRound,
  Shootout,
  MatchSummaryData,
  StatLeader,
  NewsArticle,
  Group,
  Team,
  TeamProfile,
  SquadPlayer,
  PlayerProfile,
} from './types';
import { canonicalTeamId } from './teamIdentity';
import { supportsResource, resolveSeason, type CompetitionSeason } from './competitions';
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
import { mapScoreboard, scoreboardWinnerFlags, shootoutWinnerId } from './providers/espn-matches';
import { mapTeamProfile, mapTeamRoster, mapScopedTeamSchedule, splitLeagueTeamIds } from './providers/espn-team';
import { uniqueTeamMatches } from './teamPerformance';
import { archiveRosterProfile, mapAthleteProfile, mapAthleteOverview, mapAthleteBio } from './providers/espn-athlete';
import { configuredPhaseTables } from './leaguesCupTables';
import { computeOverallTable } from './mlsTables';
import { EspnEditionError, verifyRosterEdition, verifySummaryEdition, verifyStandingsEdition, verifyLeadersEdition, requiresEditionEvidence, providerYear } from './providers/espn-edition';
import { mapNews, mapAttributedNews } from './providers/espn-news';
import { mapStandings, StandingsStatsError } from './providers/espn-standings';
import { isBracketPlaceholder, mapBracket } from './providers/espn-bracket';
import { mapLeaders } from './providers/espn-stats';
import {
  mapSummaryScorers, mapSummaryCards, mapSummaryStats, mapWinProbability, mapSummaryLineups,
  mapSummaryVideos, mapSummaryShootout, mapSummaryShootoutTotals, summaryHeaderFinal, mapSummaryInfo, mapSummaryForm, mapSummaryCommentary, mapSummaryH2H,
} from './providers/espn-summary';
import { TtlCache } from './cache';
import { matchDerivedMembership, MAX_EDITION_TEAMS, MAX_SQUAD_PLAYERS, withEditionResources } from './editionResources';
import { currentWeekRange, editionBounds, forwardRange, nowWindowRange } from './dateRange';
import { fetchScoreboardWindow, verifyUndatedScoreboard, boundedFetchJson, type ScoreboardFetchJson } from './scoreboardWindow';

// The store is keyed on a resolved (competition, season) pair. The ESPN league
// slug lives on the competition; per-season fetch details (e.g. the bracket
// date range) live on the season.
export interface DataStore {
  getMatches(rc: CompetitionSeason, range?: string, signal?: AbortSignal): Promise<Match[]>;
  getFixtures(rc: CompetitionSeason, range: string, signal?: AbortSignal): Promise<Match[]>;
  getLiveWindow(rc: CompetitionSeason): Promise<Match[]>;
  getUpcoming(rc: CompetitionSeason, limit?: number, signal?: AbortSignal): Promise<Match[]>;
  getEditionTeams(rc: CompetitionSeason): Promise<Team[]>;
  getStandings(rc: CompetitionSeason): Promise<Group[]>;
  getBracket(rc: CompetitionSeason): Promise<BracketRound[]>;
  getMatchSummary(rc: CompetitionSeason, eventId: string, homeId: string, awayId: string): Promise<MatchSummaryData>;
  getLeaders(rc: CompetitionSeason): Promise<{ scorers: StatLeader[]; assists: StatLeader[] }>;
  getNews(rc: CompetitionSeason, attributedOnly?: boolean): Promise<NewsArticle[]>;
  getTeam(rc: CompetitionSeason, teamId: string): Promise<TeamProfile | null>;
  getSquad(rc: CompetitionSeason, teamId: string): Promise<SquadPlayer[]>;
  getPlayer(rc: CompetitionSeason, athleteId: string, rosterTeamId?: string): Promise<PlayerProfile | null>;
}

// How many scorers the Golden Boot table shows.
const TOP_SCORERS_SHOWN = 10;

interface DataDeps {
  now?: () => number;
  /** Evaluation observes the actual sides, including private bulk enrichment. */
  onSummaryRequest?: (eventId: string, homeId: string, awayId: string) => void;
  /** Enabled-mode fallback must not turn a dependency outage into an entity 404. */
  propagateUnavailable?: boolean;
  loadSquad?: DataStore['getSquad'];
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

async function fetchSquad(rc: CompetitionSeason, teamId: string, fetchJson: ScoreboardFetchJson) {
  const year = rc.season.publication === 'archive' ? providerYear(rc.season) : undefined;
  const raw = await fetchJson(teamRosterUrl(rc.competition.espnSlug, teamId, year), {
    signal: AbortSignal.timeout(15_000), maxBytes: 4 * 1024 * 1024,
  });
  const count = verifyRosterEdition(raw, rc, teamId);
  if (count > MAX_SQUAD_PLAYERS) throw new EspnEditionError('partial', 'roster');
  const squad = mapTeamRoster(raw);
  if (squad.length !== count || squad.some(player => !providerReference(player.id) || !player.name.trim()) ||
      new Set(squad.map(player => player.id)).size !== count) throw new EspnEditionError('partial', 'roster');
  return squad;
}

// The control and sampled stores share their ESPN cache. Keep optional failures
// with the exact cached object, including across stores, until it is evicted.
const partialEspnValues = new WeakMap<object, DependencyFault>();

function cachedEspnValue<T extends object>(cache: TtlCache<unknown>, key: string): T | undefined {
  const value = cache.get(key) as T | undefined;
  const failure = value && partialEspnValues.get(value);
  if (failure) healthContext().onDependencyFailure?.('espn', failure);
  return value;
}

function optionalEspnDependencies(cache: TtlCache<unknown>, key: string) {
  let failure: DependencyFault | undefined;
  return {
    unavailable(error: unknown) {
      failure ??= comparisonFault(error);
      healthContext().onDependencyFailure?.('espn', failure);
      return null;
    },
    cacheValue<T extends object>(value: T, ttlMs: number) {
      if (failure) partialEspnValues.set(value, failure);
      cache.set(key, value, ttlMs);
    },
  };
}

export function createDataStore(deps: DataDeps): DataStore {
  const now = deps.now ?? Date.now;
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
    const strict = requiresEditionEvidence(rc);
    const raw = await deps.fetchJson(statisticsUrl(slug(rc), strict ? providerYear(rc.season) : undefined));
    if (strict) verifyLeadersEdition(raw, rc);
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
    const matches = mapScoreboard(raw, rc.season.playoffFormat)
      .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
    deps.cache.set(k, matches, ttlMs);
    return matches;
  }

  async function computeTables(
    rc: CompetitionSeason,
    config: NonNullable<CompetitionSeason['season']['computedTables']>,
  ): Promise<Group[]> {
    const split = resolveSeason(config.membership.split.competitionId, config.membership.split.seasonId);
    if (!split || !supportsResource(split.season, 'teams') || !supportsResource(rc.season, 'scores')) {
      throw new Error('Unavailable edition membership');
    }
    const [rawPhase, rawSplit] = await Promise.all([
      fetchScoreboardWindow(rc, config.datesRange, deps.fetchJson),
      deps.fetchJson(teamsUrl(split.competition.espnSlug)),
    ]);
    // The configured display names are carried so the view doesn't hardcode them.
    return configuredPhaseTables(mapScoreboard(rawPhase), config, splitLeagueTeamIds(rawSplit));
  }

  // One summary read, cached with the header's shootout totals. MatchSummaryData
  // has no aggregate (neither does the reader's summary), but getMatches already
  // holds this summary and the header outranks the scoreboard's evidence. The
  // sides are part of the key: the totals, stats, lineups and other per-side
  // fields are mapped for them, and the public match route passes its query's
  // sides through unchecked. `final` records whether the header itself had
  // finished: a summary read mid-shootout must not resolve a finished match.
  type LoadedSummary = { data: MatchSummaryData; shootout: Shootout | null; final: boolean };
  async function loadSummary(
    rc: CompetitionSeason, eventId: string, homeId: string, awayId: string, signal?: AbortSignal,
  ): Promise<LoadedSummary> {
    const k = key(rc, `summary:${eventId}:${homeId}:${awayId}`);
    const cached = deps.cache.get(k) as LoadedSummary | undefined;
    if (cached) return cached;
    signal?.throwIfAborted();
    deps.onSummaryRequest?.(eventId, homeId, awayId);
    const raw = await deps.fetchJson(summaryUrl(slug(rc), eventId), signal
      ? { signal, maxBytes: 4 * 1024 * 1024 } : undefined);
    if (requiresEditionEvidence(rc)) verifySummaryEdition(raw, rc, eventId, homeId, awayId);
    const info = mapSummaryInfo(raw);
    if (info && !supportsResource(rc.season, 'officials')) info.referee = null;
    const summary: MatchSummaryData = {
      scorers: mapSummaryScorers(raw),
      cards: mapSummaryCards(raw),
      stats: mapSummaryStats(raw, homeId, awayId),
      winProbability: supportsResource(rc.season, 'odds') ? mapWinProbability(raw, homeId, awayId) : null,
      lineups: supportsResource(rc.season, 'participation') ? mapSummaryLineups(raw, homeId, awayId) : null,
      videos: mapSummaryVideos(raw),
      shootoutDetail: mapSummaryShootout(raw, homeId, awayId),
      info,
      form: mapSummaryForm(raw, homeId, awayId),
      commentary: mapSummaryCommentary(raw),
      h2h: mapSummaryH2H(raw),
    };
    const loaded = {
      data: summary,
      shootout: mapSummaryShootoutTotals(raw, eventId, homeId, awayId),
      final: summaryHeaderFinal(raw),
    };
    deps.cache.set(k, loaded, 12_000);
    return loaded;
  }

  async function getMatchSummary(
    rc: CompetitionSeason, eventId: string, homeId: string, awayId: string, signal?: AbortSignal,
  ): Promise<MatchSummaryData> {
    return (await loadSummary(rc, eventId, homeId, awayId, signal)).data;
  }

  async function loadStandings(rc: CompetitionSeason, strict = requiresEditionEvidence(rc)): Promise<Group[]> {
    const k = key(rc, strict ? 'standings:verified' : 'standings');
    const cached = deps.cache.get(k) as Group[] | Error | undefined;
    if (cached instanceof Error) throw cached;
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
    const raw = await deps.fetchJson(standingsUrl(slug(rc), strict ? providerYear(rc.season) : undefined),
      strict ? { signal: AbortSignal.timeout(15_000), maxBytes: 4 * 1024 * 1024 } : undefined);
    let groups: Group[];
    try {
      if (strict) verifyStandingsEdition(raw, rc);
      groups = mapStandings(raw, rc.competition.shortName, !!rc.season.playoffFormat);
    } catch (error) {
      // A rejected table is cached like an accepted one: the standings page
      // and the team and player indexes all read it, and a provider that
      // keeps serving it must not cost an upstream fetch per read.
      if (!(error instanceof EspnEditionError)) deps.cache.set(k, error, 60_000);
      throw error;
    }
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
  }

  async function loadSquad(rc: CompetitionSeason, teamId: string): Promise<SquadPlayer[]> {
    const k = key(rc, `squad:${teamId}`);
    const cached = deps.cache.get(k) as SquadPlayer[] | undefined;
    if (cached) return cached;
    const squad = await (deps.loadSquad ? deps.loadSquad(rc, teamId) : fetchSquad(rc, teamId, deps.fetchJson));
    deps.cache.set(k, squad, 300_000);
    return squad;
  }

  async function getEditionTeams(rc: CompetitionSeason): Promise<Team[]> {
    const k = key(rc, 'edition-teams');
    const cached = deps.cache.get(k) as Team[] | undefined;
    if (cached) return cached;
    let teams: Team[];
    const fromMatches = matchDerivedMembership(rc);
    if (fromMatches) {
      if (!supportsResource(rc.season, 'scores')) throw new Error('Unavailable edition membership');
      const { start, end } = editionBounds(rc.season);
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
      const range = `${day(start)}-${day(end - 1)}`;
      const raw = await fetchScoreboardWindow(rc, range, deps.fetchJson, undefined, 'edition');
      teams = mapScoreboard(raw).flatMap(match => [match.home, match.away])
        .filter(team => !isBracketPlaceholder(team.name, team.crestUrl));
      if (raw.events.length && !teams.length) throw new EspnEditionError('scope_unverified', 'entrants');
    } else {
      try {
        teams = (await loadStandings(rc, true)).flatMap(group => group.standings.map(row => row.team));
      } catch (error) {
        if (!(error instanceof StandingsStatsError)) throw error;
        teams = error.teams;
      }
    }
    const distinct = [...new Map(teams.map(team => [team.id, team])).values()];
    if (distinct.length > MAX_EDITION_TEAMS) throw new Error('Edition membership exceeds team limit');
    const members = fromMatches ? distinct.filter(team => canonicalTeamId(team.id)) : distinct;
    if (distinct.length && !members.length) throw new EspnEditionError('scope_unverified', 'entrants');
    deps.cache.set(k, members, 60_000);
    return members;
  }

  const store: DataStore = {
    getMatchSummary,
    getEditionTeams,

    async getMatches(rc, range?: string, signal?: AbortSignal): Promise<Match[]> {
      signal?.throwIfAborted();
      const window = range ?? currentWeekRange(new Date(now()));
      // The range is part of the identity of this result. Without it in the
      // key, the first window fetched is served for every later one.
      if (!supportsResource(rc.season, 'summary')) {
        return loadWindow(rc, window, `fixtures:${window}`, 120_000, signal);
      }
      const k = key(rc, `matches:${window}`);
      const cached = cachedEspnValue<Match[]>(deps.cache, k);
      if (cached) return cached;
      const optional = optionalEspnDependencies(deps.cache, k);
      const deadline = AbortSignal.timeout(15_000);
      const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const raw = await fetchScoreboardWindow(rc, window, deps.fetchJson, readSignal);
      const matches = mapScoreboard(raw, rc.season.playoffFormat);
      const shootoutEligible = scoreboardWinnerFlags(raw, rc.season.playoffFormat);
      const summaries: LoadedSummary[] = [];
      // Only retained matches are enriched, four at a time under the same
      // read deadline. Individual provider summary failures remain best effort.
      for (let i = 0; i < matches.length; i += 4) {
        readSignal.throwIfAborted();
        summaries.push(...await Promise.all(matches.slice(i, i + 4).map(m =>
          loadSummary(rc, m.id, m.home.id, m.away.id, readSignal)
            .catch((error): LoadedSummary => {
              optional.unavailable(error);
              return { data: emptySummary(), shootout: null, final: false };
            }),
        )));
      }
      readSignal.throwIfAborted();
      matches.forEach((m, i) => {
        const { data, shootout, final } = summaries[i];
        m.scorers = data.scorers;
        m.cards = data.cards;
        m.stats = data.stats;
        m.winProbability = data.winProbability;
        m.shootoutDetail = data.shootoutDetail;
        // The header outranks the scoreboard -- for a finished match only once
        // the header is final too (Go's requireFinal). A series shootout
        // settles advancement while leaving the individual leg result intact.
        if (shootout && (m.state !== 'finished' || final)) {
          m.shootout = shootout;
          if (m.state === 'finished' && shootoutEligible.has(m.id)) {
            m.winnerId = shootoutWinnerId(shootout, m.home.id, m.away.id) ?? shootoutEligible.get(m.id) ?? null;
          }
        }
      });
      optional.cacheValue(matches, 10_000);
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
      const range = nowWindowRange(new Date(now()));
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
      const range = forwardRange(new Date(now()));
      const k = key(rc, `upcoming:${range}:${limit}`);
      const cached = deps.cache.get(k) as Match[] | undefined;
      if (cached) return cached;
      const raw = await fetchScoreboardWindow(rc, range, deps.fetchJson, signal);
      const upcoming = mapScoreboard(raw, rc.season.playoffFormat)
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
      if (matchDerivedMembership(rc) && !(await getEditionTeams(rc)).some(team => team.id === teamId)) return null;
      const k = key(rc, `team:${teamId}`);
      const cached = cachedEspnValue<TeamProfile>(deps.cache, k);
      if (cached) return cached;
      const optional = optionalEspnDependencies(deps.cache, k);

      try {
        // Four requests, not three: the schedule endpoint returns played OR
        // upcoming matches depending on `fixture=true`, never both, so a
        // matches-and-results block has to ask twice.
        const [rawProfile, squad, rawResults, rawFixtures] = await Promise.all([
          deps.fetchJson(teamUrl(slug(rc), teamId)),
          supportsResource(rc.season, 'squad') ? loadSquad(rc, teamId).catch(optional.unavailable) : [],
          supportsResource(rc.season, 'scores') ? deps.fetchJson(teamScheduleUrl(slug(rc), teamId, false, rc.season)).catch(optional.unavailable) : null,
          supportsResource(rc.season, 'scores') ? deps.fetchJson(teamScheduleUrl(slug(rc), teamId, true, rc.season)).catch(optional.unavailable) : null,
        ]);

        const base = mapTeamProfile(rawProfile);
        if (!base || base.team.id !== teamId) return null;
        const results = mapScopedTeamSchedule(rawResults, rc, teamId);
        const upcoming = mapScopedTeamSchedule(rawFixtures, rc, teamId);

        // The undated team profile cannot establish a strict edition's table position or record.
        const strict = requiresEditionEvidence(rc);
        const profile: TeamProfile = {
          ...base,
          ...((strict || !supportsResource(rc.season, 'standings')) && { record: null, standingSummary: null, standing: null }),
          squad: squad ?? [],
          schedule: uniqueTeamMatches([...results.matches, ...upcoming.matches]).reverse(),
          scheduleAvailability: {
            results: results.available ? 'available' : 'unavailable',
            upcoming: upcoming.available ? 'available' : 'unavailable',
          },
        };
        if (squad !== null && (!strict || !supportsResource(rc.season, 'scores') || (results.available && upcoming.available))) {
          optional.cacheValue(profile, 120_000);
        }
        return profile;
      } catch (error) {
        if (deps.propagateUnavailable && !(error instanceof ReaderFailure && error.status === 404)) throw error;
        return optional.unavailable(error);
      }
    },

    // Roster only -- one request, for callers that need players but not the
    // profile or schedule (the player index reads every club in a
    // competition, so the 4-request getTeam would quadruple its cold cost).
    async getSquad(rc, teamId: string): Promise<SquadPlayer[]> {
      if (matchDerivedMembership(rc) && !(await getEditionTeams(rc)).some(team => team.id === teamId)) return [];
      try {
        return await loadSquad(rc, teamId);
      } catch (error) {
        if (deps.propagateUnavailable) throw error;
        healthContext().onDependencyFailure?.('espn', comparisonFault(error));
        return [];
      }
    },

    // A player within one competition. Same failure split as getTeam:
    // identity is what the page is, so a failed profile is null and the route
    // 404s; the game log and career are blocks on that page and degrade to
    // empty rather than taking the page down. The two optional payloads'
    // sibling endpoints (/gamelog, /splits, /stats) are dead upstream and are
    // never called -- /overview and /bio are the only sources.
    async getPlayer(rc, athleteId: string, rosterTeamId?: string): Promise<PlayerProfile | null> {
      if (rc.season.publication === 'archive') {
        if (!supportsResource(rc.season, 'teams') || !supportsResource(rc.season, 'squad')) return null;
        const teams = await getEditionTeams(rc);
        for (const team of teams) {
          if (rosterTeamId !== undefined && team.id !== rosterTeamId) continue;
          const player = (await loadSquad(rc, team.id)).find(row => row.id === athleteId);
          if (player) return archiveRosterProfile(rc, team, player);
        }
        return null;
      }
      const k = key(rc, `player:${athleteId}`);
      const cached = cachedEspnValue<PlayerProfile>(deps.cache, k);
      if (cached) return cached;
      const optional = optionalEspnDependencies(deps.cache, k);

      try {
        const [rawProfile, rawOverview, rawBio] = await Promise.all([
          deps.fetchJson(athleteUrl(slug(rc), athleteId)),
          supportsResource(rc.season, 'participation') ? deps.fetchJson(athleteOverviewUrl(slug(rc), athleteId)).catch(optional.unavailable) : null,
          supportsResource(rc.season, 'career') ? deps.fetchJson(athleteBioUrl(slug(rc), athleteId)).catch(optional.unavailable) : null,
        ]);

        const identity = mapAthleteProfile(rawProfile);
        if (!identity) return null;

        const overview = rawOverview ? mapAthleteOverview(rawOverview) : { label: '', rows: [] };
        const profile: PlayerProfile = {
          ...identity,
          totals: supportsResource(rc.season, 'squad') ? identity.totals : [],
          gameLogLabel: overview.label,
          gameLog: overview.rows,
          career: rawBio ? mapAthleteBio(rawBio) : [],
        };
        optional.cacheValue(profile, 120_000);
        return profile;
      } catch (error) {
        if (deps.propagateUnavailable && !(error instanceof ReaderFailure && error.status === 404)) throw error;
        return optional.unavailable(error);
      }
    },

    getStandings: loadStandings,

    async getBracket(rc): Promise<BracketRound[]> {
      const k = key(rc, 'bracket');
      const cached = deps.cache.get(k) as BracketRound[] | undefined;
      if (cached) return cached;
      const raw = rc.season.bracketDatesRange
        ? await fetchScoreboardWindow(rc, rc.season.bracketDatesRange, deps.fetchJson, undefined, 184)
        : await deps.fetchJson(scoreboardUrl(slug(rc)), {
          signal: AbortSignal.timeout(15_000), maxBytes: 4 * 1024 * 1024,
        });
      if (!rc.season.bracketDatesRange && requiresEditionEvidence(rc)) verifyUndatedScoreboard(raw, rc);
      let groups: Group[] = [];
      if (rc.season.playoffFormat && supportsResource(rc.season, 'standings')) {
        try {
          groups = await store.getStandings(rc);
        } catch (error) {
          // Published matches stand on their own. A projection requires the table.
          const published = mapBracket(raw, rc.season.playoffFormat);
          if (published.length) {
            healthContext().onDependencyFailure?.('espn', comparisonFault(error));
            return published;
          }
          throw error;
        }
      }
      const rounds = mapBracket(raw, rc.season.playoffFormat, groups);
      deps.cache.set(k, rounds, 8_000);
      return rounds;
    },

    getLeaders: loadLeaders,

    async getNews(rc, attributedOnly = false): Promise<NewsArticle[]> {
      const k = key(rc, attributedOnly ? 'news:attributed' : 'news');
      const cached = deps.cache.get(k) as NewsArticle[] | undefined;
      if (cached) return cached;
      const raw = await deps.fetchJson(newsUrl(slug(rc)));
      const news = requiresEditionEvidence(rc) || attributedOnly
        ? mapAttributedNews(raw, rc.competition.espnLeagueId, rc.competition.espnSlug) : mapNews(raw);
      deps.cache.set(k, news, 90_000);
      return news;
    },
  };
  return withEditionResources(store);
}

const espnCache = new TtlCache<unknown>();
// A cold player lookup reads every roster. Cache the small mapped squads across
// function instances. Catch provider failures outside the cache so a retry can recover.
const loadEspnSquad = unstable_cache(
  (rc: CompetitionSeason, teamId: string) => fetchSquad(rc, teamId, boundedFetchJson),
  ['espn-squad-v3'],
  { revalidate: 300 },
);
export const espnDataStore = createDataStore({ fetchJson: boundedFetchJson, cache: espnCache, loadSquad: loadEspnSquad });
export const dataStore: DataStore = configuredDataStore({
  espn: espnDataStore,
  env: process.env,
  onFallback: reason => trackReaderFallback(reason),
  onComparison: event => console.info(JSON.stringify({ event: 'scorearc_reader_comparison', ...event })),
  fallback: ({ signal, budget }) => createDataStore({
    propagateUnavailable: true,
    cache: espnCache,
    fetchJson: async (url, options) => (await budget.json(url, options
      ? AbortSignal.any([signal, options.signal]) : signal, 'espn')).body,
  }),
});
