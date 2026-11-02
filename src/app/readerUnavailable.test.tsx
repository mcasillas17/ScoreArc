import { describe, expect, it, vi } from 'vitest';
import type { DataStore } from '@/server/data/store';
import { createSelectedDataStore } from '@/server/data/sourceSelection';
import { createReaderTransport, ReaderFailure, type ReaderResponse, type RequestBudget } from '@/server/data/readerTransport';
import { createReaderDataStore } from '@/server/data/apiStore';
import { TtlCache } from '@/server/data/cache';
import type { ReaderResource, ReaderResourceName, ReaderResources } from '@/lib/readerResources';
import derived from '@/server/data/contracts/derived-standings.json';
import vectors from '@/server/data/contracts/reader-contract.json';
import { listCompetitions, ongoingCompetitions, resolveSeason } from '@/server/data/competitions';
import type { Group, Match } from '@/server/data/types';
import { getBannerFeed } from '@/server/data/banner';
import Home from './[locale]/page';
import Workspace from './[locale]/c/[comp]/[season]/page';
import StandingsPage from './[locale]/c/[comp]/[season]/standings/page';
import CompetitionTeamsPage from './[locale]/c/[comp]/[season]/teams/page';
import TeamsPage from './[locale]/teams/page';

const selected = vi.hoisted(() => ({ store: undefined as DataStore | undefined }));
vi.mock('@/server/data/store', () => ({ get dataStore() { return selected.store; } }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: () => { throw new Error('NEXT_REDIRECT'); },
}));

function emptyStore(): DataStore {
  return {
    getMatches: async () => [], getFixtures: async () => [], getLiveWindow: async () => [], getUpcoming: async () => [],
    getStandings: async () => [], getBracket: async () => [], getLeaders: async () => ({ scorers: [], assists: [] }),
    getNews: async () => [], getTeam: async () => null, getSquad: async () => [], getPlayer: async () => null,
    getMatchSummary: async () => { throw new Error('unused summary'); },
  };
}
type CollectionMethod = 'getMatches' | 'getUpcoming' | 'getLiveWindow' | 'getStandings' | 'getLeaders' | 'getBracket';
function scenario(method?: CollectionMethod, readerMode = true) {
  const calls: string[] = [];
  const reader = emptyStore();
  const espn = emptyStore();
  const exhausted = new Error('both sources unavailable');
  if (method) {
    reader[method] = async () => { calls.push('reader'); throw new ReaderFailure('network'); };
    espn[method] = async () => { calls.push('espn'); throw exhausted; };
  }
  const onFallback = vi.fn();
  selected.store = createSelectedDataStore({ source: readerMode ? 'reader' : 'espn', espn, reader: () => reader,
    fallback: () => espn, onFallback });
  return { store: selected.store, calls, exhausted, onFallback };
}
const season = (comp: string, id = '2026') => ({ params: { locale: 'en', comp, season: id } });
const match = (id: string): Match => ({
  id, kickoff: new Date(Date.now() + 3600_000).toISOString(), state: 'scheduled', minute: null,
  statusDetail: '', statusName: '', home: { id: '227', name: 'Home', abbr: 'HOM', crestUrl: null },
  away: { id: '216', name: 'Away', abbr: 'AWY', crestUrl: null }, homeScore: null, awayScore: null,
  winnerId: null, note: null, scorers: [], cards: [], shootout: null, shootoutDetail: null,
  stats: null, winProbability: null,
});
const group = (name: string): Group => ({ id: name, name, standings: [{
  team: { id: '227', name, abbr: 'AME', crestUrl: null }, rank: 1, played: 0, wins: 0, draws: 0,
  losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
}] });
const pages: { name: string; method: CollectionMethod; read: () => Promise<unknown> }[] = [
  { name: 'standings', method: 'getStandings', read: () => StandingsPage(season('world-cup')) },
  { name: 'standings leaders', method: 'getLeaders', read: () => StandingsPage(season('world-cup')) },
  { name: 'cup bracket', method: 'getBracket', read: () => Workspace(season('world-cup')) },
  { name: 'projected bracket', method: 'getStandings', read: () => Workspace(season('liga-mx', '2026-apertura')) },
  { name: 'derived phase tables', method: 'getStandings', read: () => Workspace(season('leagues-cup')) },
  { name: 'home matches', method: 'getLiveWindow', read: () => Home({ params: { locale: 'en' } }) },
  { name: 'home leaders', method: 'getLeaders', read: () => Home({ params: { locale: 'en' } }) },
  { name: 'competition directory', method: 'getStandings', read: () => CompetitionTeamsPage(season('world-cup')) },
  { name: 'all-team directory', method: 'getStandings', read: () => TeamsPage({ params: { locale: 'en' } }) },
];

describe('enabled reader unavailability reaches website consumers', () => {
  it.each([
    { name: 'standings page', fail: 'getStandings' as const, read: () => StandingsPage(season('world-cup')) },
    { name: 'cup page', fail: 'getBracket' as const, read: () => Workspace(season('world-cup')) },
  ])('repeats the banner with the rest of the $name after a later read fails', async ({ fail, read }) => {
    const reader = emptyStore(); const espn = emptyStore();
    reader.getMatches = vi.fn(async () => [match('reader-only')]);
    espn.getMatches = vi.fn(async () => [match('espn-only')]);
    reader[fail] = async () => { throw new ReaderFailure('network'); };
    selected.store = createSelectedDataStore({ source: 'reader', espn, reader: () => reader });
    const rendered = JSON.stringify(await read());
    expect(rendered).toContain('espn-only');
    expect(rendered).not.toContain('reader-only');
    expect(espn.getMatches).toHaveBeenCalledOnce();
  });
  it('repeats the complete homepage collection after one competition leader read fails', async () => {
    const reader = emptyStore(); const espn = emptyStore();
    reader.getLiveWindow = async () => [match('reader-only')];
    espn.getLiveWindow = vi.fn(async () => [match('espn-only')]);
    reader.getLeaders = async rc => {
      if (rc.competition.id === ongoingCompetitions()[0].id) throw new ReaderFailure('network');
      return { scorers: [], assists: [] };
    };
    selected.store = createSelectedDataStore({ source: 'reader', espn, reader: () => reader });
    const rendered = JSON.stringify(await Home({ params: { locale: 'en' } }));
    expect(rendered).toContain('espn-only');
    expect(rendered).not.toContain('reader-only');
    expect(espn.getLiveWindow).toHaveBeenCalledTimes(ongoingCompetitions().length);
  });
  it('repeats every membership in the merged team directory after one table fails', async () => {
    const reader = emptyStore(); const espn = emptyStore();
    reader.getStandings = async rc => {
      if (rc.competition.id === listCompetitions()[1].id) throw new ReaderFailure('network');
      return [group('Reader only')];
    };
    espn.getStandings = vi.fn(async () => [group('ESPN only')]);
    selected.store = createSelectedDataStore({ source: 'reader', espn, reader: () => reader });
    const rendered = JSON.stringify(await TeamsPage({ params: { locale: 'en' } }));
    expect(rendered).toContain('ESPN only');
    expect(rendered).not.toContain('Reader only');
    expect(espn.getStandings).toHaveBeenCalledTimes(listCompetitions().length);
  });
  it.each(pages)('$name does not render empty data after both sources fail', async ({ method, read }) => {
    const test = scenario(method);
    await expect(read()).rejects.toBe(test.exhausted);
    expect(test.calls).toContain('reader');
    expect(test.calls).toContain('espn');
  });
  it.each(pages)('$name keeps the existing ESPN-only degradation', async ({ method, read }) => {
    const test = scenario(method, false);
    await expect(read()).resolves.toBeDefined();
    expect(test.calls).not.toContain('reader');
  });
  it.each(['getMatches', 'getUpcoming'] as const)('banner propagates exhausted %s instead of an empty band', async method => {
    const test = scenario(method);
    await expect(getBannerFeed(resolveSeason('world-cup', '2026')!, test.store)).rejects.toBe(test.exhausted);
    expect(test.calls).toEqual(['reader', 'espn']);
    const plain = scenario(method, false);
    expect(await getBannerFeed(resolveSeason('world-cup', '2026')!, plain.store)).toEqual({ matches: [], weekOnly: false });
  });
  it('keeps verified empty reader collections successful without fallback', async () => {
    const test = scenario();
    for (const page of pages) await expect(page.read()).resolves.toBeDefined();
    expect(await getBannerFeed(resolveSeason('world-cup', '2026')!, test.store)).toEqual({ matches: [], weekOnly: false });
    expect(test.onFallback).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'homepage', read: () => Home({ params: { locale: 'en' } }), cold: ongoingCompetitions().length * 4, warm: ongoingCompetitions().length * 2 },
    { name: 'merged team directory', read: () => TeamsPage({ params: { locale: 'en' } }), cold: listCompetitions().length + 3, warm: 2 },
  ])('keeps cold and warm $name reads inside the shared transport budget', async ({ read, cold, warm }) => {
    // Synthetic current-scope responses reuse shared contract vectors. This
    // measures full adapter/transport work, including LC membership inputs,
    // rather than treating a DataStore method as one upstream call.
    const now = Date.parse('2026-11-01T09:00:00Z');
    const cache = new TtlCache<ReaderResponse>(() => now);
    const budgets: RequestBudget[] = [];
    let active = 0, peak = 0;
    const wire = (body: unknown[], names: Partial<Record<ReaderResourceName, ReaderResource['scope']>>) => {
      const resources: ReaderResources = { version: 1, resources: {} };
      for (const [key, scope] of Object.entries(names)) {
        const name = key as ReaderResourceName;
        const identity = name === 'identity';
        resources.resources[name] = {
          status: identity ? 'unavailable' : body.length ? 'fresh' : 'empty',
          availability: identity ? 'partial' : body.length ? 'complete' : 'empty',
          source: identity ? 'mixed' : 'espn', derivation: identity ? 'mixed' : 'direct', scope,
          observedAt: identity ? null : new Date(now).toISOString(), finalizedAt: null,
        };
      }
      return Response.json(body, { headers: { 'X-ScoreArc-Resources': JSON.stringify(resources),
        'X-ScoreArc-Freshness': body.length ? 'fresh' : 'empty', 'X-ScoreArc-Poll-Status': 'ok',
        'X-ScoreArc-Observed-At': new Date(now).toISOString(), 'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0' } });
    };
    const fetcher: typeof fetch = async input => {
      active++; peak = Math.max(peak, active);
      // Keep requests overlapping so the shared concurrency gate is exercised.
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      const url = new URL(String(input));
      const [, , , comp, seasonId, endpoint] = url.pathname.split('/');
      if (endpoint === 'standings') return wire(comp === 'mls' ? derived.membership.mls.groups : derived.membership.ligaMx.groups,
        { standings: 'competition-season', identity: 'competition-season' });
      if (endpoint === 'leaders') return wire(vectors.leaders.frontend.scorers.map(row => ({ ...row,
        playerId: '01890000-0000-7000-8000-000000000444', playerSlug: null, teamId: derived.phaseMatches[0].home.id })),
      { leaders: 'competition-season', identity: 'competition-season' });
      if (endpoint === 'matches') return wire(url.searchParams.get('range') === '20260804-20260814' ? derived.phaseMatches : [{
        ...derived.phaseMatches[0], kickoff: new Date(now).toISOString(),
      }], { matches: 'selection', identity: 'competition-season' });
      if (endpoint === 'identities') return wire(url.searchParams.get('ids')!.split(',').map(id => {
        const index = derived.phaseMatches.findIndex(row => row.id === id);
        const row = derived.phaseMatches[index];
        return { id, status: 'resolved', canonicalId: id, providerId: String(701000001 + index),
          competitionId: comp, seasonId, homeId: row.home.id, awayId: row.away.id };
      }), { identity: 'selection' });
      throw new Error('Unexpected cost-test route');
    };
    const espn = emptyStore();
    const onFallback = vi.fn();
    selected.store = createSelectedDataStore({ source: 'reader', espn, fetch: fetcher, onFallback,
      reader: ({ signal, budget }) => {
        budgets.push(budget);
        return createReaderDataStore({ signal, cache, cacheNamespace: 'cost-test', now: () => now,
          read: createReaderTransport('https://reader.test', budget, signal), news: espn.getNews });
      } });
    await expect(read()).resolves.toBeDefined();
    await expect(read()).resolves.toBeDefined();
    expect(onFallback).not.toHaveBeenCalled();
    expect(budgets.map(budget => budget.calls)).toEqual([cold, warm]);
    expect(budgets.every(budget => budget.bytes < 1024 * 1024)).toBe(true);
    expect(peak).toBe(4);
  });
});
