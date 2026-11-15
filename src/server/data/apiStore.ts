import type { DataStore } from './store';
import { resolveSeason, type CompetitionSeason } from './competitions';
import type { BracketRound, Group, Match, MatchSummaryData, Team } from './types';
import { TtlCache } from './cache';
import { currentWeekRange, forwardRange, nowWindowRange, parseRange, seasonMonthBounds } from './dateRange';
import { utcDate } from './scoreboardWindow';
import { canonicalTeamId } from './teamIdentity';
import { deriveReaderStandings } from './derivedStandings';
import { parseMatchFreshness } from '@/lib/matchFreshness';
import type { ReaderResource, ReaderResourceName } from '@/lib/readerResources';
import { ReaderFailure, type ReaderResponse, type ReaderTransport } from './readerTransport';
import { collectionEvidence, requireResources, resourceUsable } from './readerPolicy';
import { createReaderIdentity, providerReference, readerScopePath, type ReaderIdentity } from './readerIdentity';
import {
  decodeReaderMatches, decodeReaderStandings, decodeReaderBracket, decodeReaderSummary,
  decodeReaderLeaders, decodeReaderTeam, decodeReaderSquad, decodeReaderPlayer,
} from './readerDecode';
import { mergeLegs } from './providers/espn-bracket';

export interface ReaderDataDependencies {
  read: ReaderTransport;
  cache: TtlCache<ReaderResponse>;
  cacheNamespace: string;
  now?: () => number;
  signal: AbortSignal;
  news: DataStore['getNews'];
}
type Scopes = Partial<Record<ReaderResourceName, ReaderResource['scope']>>;
const groupScopes = { standings: 'competition-season', identity: 'competition-season' } as const;
const matchScopes = { matches: 'selection', identity: 'competition-season' } as const;
const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw new ReaderFailure('body'); };
const remap = (ids: Map<string, string>, id: string) => {
  const mapped = ids.get(id); if (!mapped) throw new ReaderFailure('identity'); return mapped;
};
const nullableId = (ids: Map<string, string>, id: string | null) => id === null ? null : remap(ids, id);
const mappedTeam = (ids: Map<string, string>, team: Team): Team => ({ ...team, id: remap(ids, team.id) });

export function createReaderDataStore(deps: ReaderDataDependencies): DataStore {
  const now = deps.now ?? Date.now;
  const identities = createReaderIdentity(deps.read, now);
  async function request<T>(path: string, query: Record<string, string> | undefined, decode: (raw: unknown) => T,
    scopes: Scopes, required: ReaderResourceName[], ttl = 0) {
    deps.signal.throwIfAborted();
    const key = `${deps.cacheNamespace}:provider-v1:${path}?${new URLSearchParams(query)}`;
    // Core match clocks aggregate older observations. Revalidate these responses
    // on every operation instead of guessing a remaining freshness lifetime.
    const cached = ttl > 0 ? deps.cache.get(key) : undefined;
    const response = cached ?? await deps.read(path, query);
    deps.signal.throwIfAborted();
    const evidence = requireResources(response.resources, scopes, required, now());
    if (required.includes('matches') || required.includes('bracket')) {
      try {
        const core = parseMatchFreshness(response.headers);
        if (!['fresh', 'empty', 'dormant'].includes(core.status)) throw new ReaderFailure('stale');
      } catch (error) {
        if (error instanceof ReaderFailure) throw error;
        throw new ReaderFailure('metadata');
      }
    }
    let body: T;
    try { body = decode(response.body); } catch { throw new ReaderFailure('body'); }
    return { body, evidence, save: () => { if (!cached && ttl > 0) deps.cache.set(key, response, ttl); } };
  }
  function verifyWindow(rc: CompetitionSeason, matches: Match[], range: string, scheduled = false, limit?: number) {
    if (!parseRange(range)) throw new ReaderFailure('scope', false);
    const bounds = seasonMonthBounds(rc.season.id);
    const start = Math.max(utcDate(range.slice(0, 8)), Date.parse(`${bounds.minMonth}T00:00:00Z`));
    const last = new Date(`${bounds.maxMonth}T00:00:00Z`);
    const end = Math.min(utcDate(range.slice(9)) + 86_400_000, Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));
    unique(matches.map(m => m.id));
    if (limit !== undefined && matches.length > limit) throw new ReaderFailure('body');
    for (const match of matches) {
      if (Date.parse(match.kickoff) < start || Date.parse(match.kickoff) >= end || (scheduled && match.state !== 'scheduled')) throw new ReaderFailure('scope', false);
    }
  }
  function verifySides(match: { home: { id: string }; away: { id: string }; winnerId: string | null; state: string }, identity: ReaderIdentity) {
    if (identity.homeId !== match.home.id || identity.awayId !== match.away.id || match.home.id === match.away.id ||
        (match.winnerId !== null && (![match.home.id, match.away.id].includes(match.winnerId) || match.state !== 'finished'))) throw new ReaderFailure('scope', false);
  }
  function events<T extends { teamId: string | null }>(rows: T[], home: string, away: string, ids: Map<string, string>): T[] {
    if (rows.some(row => row.teamId !== null && row.teamId !== home && row.teamId !== away)) throw new ReaderFailure('scope', false);
    return rows.map(row => ({ ...row, teamId: nullableId(ids, row.teamId) }));
  }
  async function normalizeMatches(rc: CompetitionSeason, rows: Match[]): Promise<Match[]> {
    const [refs, teams] = await Promise.all([
      identities.lookup(rc, 'match', 'canonical', rows.map(row => row.id)),
      identities.teams(rc, rows.flatMap(row => [row.home.id, row.away.id])),
    ]);
    return rows.map(row => {
      const identity = refs.get(row.id)!; verifySides(row, identity);
      if (row.scope && (row.scope.competitionId !== rc.competition.id || row.scope.seasonId !== rc.season.id)) throw new ReaderFailure('scope', false);
      return { ...row, id: identity.providerId, scope: { competitionId: rc.competition.id, seasonId: rc.season.id },
        home: mappedTeam(teams, row.home), away: mappedTeam(teams, row.away), winnerId: nullableId(teams, row.winnerId),
        scorers: events(row.scorers, row.home.id, row.away.id, teams), cards: events(row.cards, row.home.id, row.away.id, teams) };
    });
  }
  async function window(rc: CompetitionSeason, range: string, summary = false, scheduled = false, limit?: number) {
    if (!parseRange(range) || (summary && utcDate(range.slice(9)) - utcDate(range.slice(0, 8)) >= 14 * 86_400_000) ||
        (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))) throw new ReaderFailure('scope', false);
    const query: Record<string, string> = { range };
    if (summary) query.detail = 'summary';
    if (scheduled) query.state = 'scheduled';
    if (limit !== undefined) query.limit = String(limit);
    const { body, evidence } = await request(`${readerScopePath(rc)}/matches`, query, decodeReaderMatches,
      { ...matchScopes, ...(summary ? { detail: 'competition-season' as const } : {}) }, ['matches']);
    collectionEvidence(evidence, 'matches', body.length);
    verifyWindow(rc, body, range, scheduled, limit);
    return (await normalizeMatches(rc, body)).map(match => ({ ...match, readerResources: evidence }));
  }
  async function canonicalTeam(rc: CompetitionSeason, id: string): Promise<string> {
    const curated = canonicalTeamId(id);
    if (curated) return curated;
    if (!providerReference(id)) throw new ReaderFailure('identity', false);
    return (await identities.lookup(rc, 'team', 'espn', [id], 'addressed')).get(id)!.canonicalId;
  }
  async function standingsInput(rc: CompetitionSeason) {
    const { body, evidence, save } = await request(`${readerScopePath(rc)}/standings`, undefined, decodeReaderStandings, groupScopes, ['standings'], 15_000);
    collectionEvidence(evidence, 'standings', body.reduce((n, g) => n + g.standings.length, 0));
    for (const group of body) { unique(group.standings.map(s => s.team.id)); if (!group.standings.length) throw new ReaderFailure('body'); }
    save();
    return { body, evidence };
  }
  const store: DataStore = {
    getMatches: (rc, range, signal) => { signal?.throwIfAborted(); return window(rc, range ?? currentWeekRange(new Date(now())), true); },
    getFixtures: (rc, range, signal) => { signal?.throwIfAborted(); return window(rc, range); },
    getLiveWindow: rc => window(rc, nowWindowRange(new Date(now()))),
    getUpcoming: (rc, limit = 12, signal) => { signal?.throwIfAborted(); return window(rc, forwardRange(new Date(now())), false, true, limit); },
    async getStandings(rc): Promise<Group[]> {
      const computed = rc.season.computedTables;
      let derived;
      let evidence;
      let inputs: NonNullable<Group['readerDerivation']>['inputs'];
      if (computed) {
        const primary = resolveSeason(computed.membership.primary.competitionId, computed.membership.primary.seasonId);
        const split = resolveSeason(computed.membership.split.competitionId, computed.membership.split.seasonId);
        if (!primary || !split) throw new ReaderFailure('scope', false);
        const [phase, first, second] = await Promise.all([
          request(`${readerScopePath(rc)}/matches`, { range: computed.datesRange }, decodeReaderMatches, matchScopes, ['matches']),
          standingsInput(primary), standingsInput(split),
        ]);
        verifyWindow(rc, phase.body, computed.datesRange);
        collectionEvidence(phase.evidence, 'matches', phase.body.length);
        const phaseRefs = await identities.lookup(rc, 'match', 'canonical', phase.body.map(match => match.id));
        for (const match of phase.body) verifySides(match, phaseRefs.get(match.id)!);
        derived = deriveReaderStandings(rc, { standings: [], phaseMatches: phase.body, membership: { primary: first.body, split: second.body } });
        evidence = phase.evidence;
        inputs = [
          { competitionId: rc.competition.id, seasonId: rc.season.id, resources: phase.evidence },
          { competitionId: primary.competition.id, seasonId: primary.season.id, resources: first.evidence },
          { competitionId: split.competition.id, seasonId: split.season.id, resources: second.evidence },
        ];
      } else {
        const input = await standingsInput(rc);
        evidence = input.evidence;
        derived = deriveReaderStandings(rc, { standings: input.body });
        inputs = [{ competitionId: rc.competition.id, seasonId: rc.season.id, resources: input.evidence }];
      }
      if (derived.status === 'unavailable' || (derived.status === 'partial' && !derived.groups.length)) throw new ReaderFailure('unavailable');
      const teams = await identities.teams(rc, derived.groups.flatMap(group => group.standings.map(row => row.team.id)));
      return derived.groups.map(group => ({ ...group, readerResources: evidence,
        readerDerivation: { status: derived.status as 'complete' | 'partial', issues: derived.issues, inputs },
        standings: group.standings.map(row => ({ ...row, team: mappedTeam(teams, row.team) })) }));
    },
    async getBracket(rc): Promise<BracketRound[]> {
      const { body, evidence } = await request(`${readerScopePath(rc)}/bracket`, undefined, decodeReaderBracket,
        { bracket: 'competition-season', identity: 'competition-season' }, ['bracket']);
      const matches = body.flatMap(round => round.matches);
      collectionEvidence(evidence, 'bracket', matches.length); unique(matches.map(m => m.id)); unique(body.map(round => round.slug));
      const [refs, teams] = await Promise.all([identities.lookup(rc, 'match', 'canonical', matches.map(m => m.id)), identities.teams(rc, matches.flatMap(m => [m.home.id, m.away.id]))]);
      // Two-legged ties fold into one, exactly as on the ESPN path.
      return body.map(round => ({ ...round, matches: mergeLegs(round.matches.map(match => {
        if (match.round !== round.slug) throw new ReaderFailure('scope', false);
        const ref = refs.get(match.id)!; verifySides(match, ref);
        return { ...match, id: ref.providerId, home: { ...match.home, id: remap(teams, match.home.id) }, away: { ...match.away, id: remap(teams, match.away.id) }, winnerId: nullableId(teams, match.winnerId) };
      })) }));
    },
    async getMatchSummary(rc, eventId, homeId, awayId): Promise<MatchSummaryData> {
      const identity = (await identities.lookup(rc, 'match', 'espn', [eventId], 'addressed')).get(eventId)!;
      const teams = await identities.teams(rc, [identity.homeId, identity.awayId]);
      if (homeId !== teams.get(identity.homeId!) || awayId !== teams.get(identity.awayId!)) throw new ReaderFailure('scope', false);
      let loaded;
      try {
        loaded = await request(`/v1/matches/${encodeURIComponent(identity.canonicalId)}`, undefined, decodeReaderSummary,
          { matches: 'match', identity: 'match', detail: 'match', participation: 'match' }, ['matches']);
      } catch (error) {
        // A known match can lack retained detail: its summary 404 is not an entity 404.
        if (error instanceof ReaderFailure && error.status === 404) throw new ReaderFailure('unavailable');
        throw error;
      }
      const { body, evidence } = loaded;
      collectionEvidence(evidence, 'matches', 1);
      const lineups = body.lineups;
      if (lineups && ((lineups.home.teamId !== null && lineups.home.teamId !== identity.homeId) || (lineups.away.teamId !== null && lineups.away.teamId !== identity.awayId))) throw new ReaderFailure('scope', false);
      return { ...body, readerResources: evidence,
        scorers: events(body.scorers, identity.homeId!, identity.awayId!, teams), cards: events(body.cards, identity.homeId!, identity.awayId!, teams),
        lineups: lineups && { ...lineups, home: { ...lineups.home, teamId: nullableId(teams, lineups.home.teamId) }, away: { ...lineups.away, teamId: nullableId(teams, lineups.away.teamId) } } };
    },
    async getLeaders(rc) {
      const boards = await Promise.all(['goals', 'assists'].map(async metric => {
        const { body, evidence, save } = await request(`${readerScopePath(rc)}/leaders`, { metric, limit: '10' }, decodeReaderLeaders,
          { leaders: 'competition-season', identity: 'competition-season' }, ['leaders'], 15_000);
        collectionEvidence(evidence, 'leaders', body.length);
        if (body.length > 10) throw new ReaderFailure('body'); unique(body.map(row => String(row.rank)));
        return { body, save };
      }));
      const teams = await identities.teams(rc, boards.flatMap(board => board.body).map(row => row.teamId));
      const [scorers, assists] = boards.map(board => board.body.map(row => ({ ...row, teamId: nullableId(teams, row.teamId) })));
      boards.forEach(board => board.save());
      return { scorers, assists };
    },
    getNews: deps.news,
    async getTeam(rc, teamId) {
      const canonical = await canonicalTeam(rc, teamId);
      let loaded;
      try { loaded = await request(`${readerScopePath(rc)}/teams/${encodeURIComponent(canonical)}`, undefined, decodeReaderTeam,
        { identity: 'team-season', matches: 'team-season', detail: 'team-season', standings: 'competition-season', squad: 'team-season', seasonStats: 'team-season' }, []); }
      catch (error) { if (error instanceof ReaderFailure && error.status === 404) return null; throw error; }
      const { body, evidence } = loaded;
      if (body.team.id !== canonical || body.schedule.some(m => !m.scope || m.scope.competitionId !== rc.competition.id || m.scope.seasonId !== rc.season.id || (m.home.id !== canonical && m.away.id !== canonical))) throw new ReaderFailure('scope', false);
      const teams = await identities.teams(rc, [canonical]);
      const scheduleAvailable = resourceUsable(evidence.resources.matches);
      const squadAvailable = resourceUsable(evidence.resources.squad);
      if (scheduleAvailable) collectionEvidence(evidence, 'matches', body.schedule.length);
      if (squadAvailable) collectionEvidence(evidence, 'squad', body.squad.length);
      const standingsAvailable = resourceUsable(evidence.resources.standings);
      return { ...body, readerResources: evidence, team: mappedTeam(teams, body.team),
        squad: squadAvailable ? body.squad : [], schedule: scheduleAvailable ? await normalizeMatches(rc, body.schedule) : [],
        scheduleAvailability: scheduleAvailable ? body.scheduleAvailability : { results: 'unavailable', upcoming: 'unavailable' },
        record: standingsAvailable ? body.record : null, standing: standingsAvailable ? body.standing : null, standingSummary: standingsAvailable ? body.standingSummary : null };
    },
    async getSquad(rc, teamId) {
      const canonical = await canonicalTeam(rc, teamId);
      const { body, evidence, save } = await request(`${readerScopePath(rc)}/teams/${encodeURIComponent(canonical)}/squad`, undefined, decodeReaderSquad,
        { identity: 'team-season', squad: 'team-season', seasonStats: 'team-season' }, ['squad'], 15_000);
      collectionEvidence(evidence, 'squad', body.length); unique(body.map(row => row.id));
      save();
      return body;
    },
    async getPlayer(rc, athleteId) {
      const identity = (await identities.lookup(rc, 'player', 'espn', [athleteId], 'addressed')).get(athleteId)!;
      let loaded;
      try { loaded = await request(`${readerScopePath(rc)}/players/${encodeURIComponent(identity.canonicalId)}`, undefined, decodeReaderPlayer,
        { identity: 'player', seasonStats: 'player-season', career: 'player', gameLog: 'player-season', participation: 'selection' }, [], 15_000); }
      catch (error) { if (error instanceof ReaderFailure && error.status === 404) return null; throw error; }
      const { body, evidence } = loaded;
      if (body.id !== identity.canonicalId) throw new ReaderFailure('identity', false);
      unique(body.gameLog.map(row => row.eventId));
      const [refs, teams, careerTeams] = await Promise.all([
        identities.lookup(rc, 'match', 'canonical', body.gameLog.map(row => row.eventId)),
        identities.teams(rc, [body.team?.id ?? null, ...body.gameLog.flatMap(row => [row.homeTeamId, row.awayTeamId, row.teamId, row.opponent?.id ?? null])]),
        identities.teams(rc, body.career.map(row => row.teamId), 'optional-team'),
      ]);
      const profile = { ...body, id: athleteId, readerResources: evidence, team: body.team && mappedTeam(teams, body.team),
        career: body.career.map(row => ({ ...row, teamId: row.teamId === null ? null : careerTeams.get(row.teamId) ?? null })),
        gameLog: body.gameLog.map(row => {
          const match = refs.get(row.eventId)!;
          if ((row.homeTeamId !== null && row.homeTeamId !== match.homeId) || (row.awayTeamId !== null && row.awayTeamId !== match.awayId) ||
              (row.teamId !== null && row.teamId !== match.homeId && row.teamId !== match.awayId) ||
              (row.opponent && (row.opponent.id !== match.homeId && row.opponent.id !== match.awayId || row.opponent.id === row.teamId))) throw new ReaderFailure('scope', false);
          return { ...row, eventId: match.providerId, homeTeamId: nullableId(teams, row.homeTeamId), awayTeamId: nullableId(teams, row.awayTeamId), teamId: nullableId(teams, row.teamId), opponent: row.opponent && mappedTeam(teams, row.opponent) };
        }) };
      loaded.save();
      return profile;
    },
  };
  return store;
}
