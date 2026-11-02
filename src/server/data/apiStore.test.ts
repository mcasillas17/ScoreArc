import { describe, expect, it } from 'vitest';
import { createReaderDataStore } from './apiStore';
import { resolveSeason } from './competitions';
import { TtlCache } from './cache';
import type { ReaderResponse, ReaderTransport } from './readerTransport';
import type { ReaderResource, ReaderResourceName } from '@/lib/readerResources';
import derived from './contracts/derived-standings.json';
import vectors from './contracts/reader-contract.json';
import { providerTeamId } from './teamIdentity';

const now = Date.parse('2026-08-10T12:00:00Z');
const rc = resolveSeason('leagues-cup', '2026')!;
const rawMatch = derived.phaseMatches[0];
function resource(name: ReaderResourceName, scope: ReaderResource['scope'], empty = false): ReaderResource {
  const retained = ['identity', 'detail', 'career', 'gameLog', 'participation', 'seasonStats'].includes(name);
  return { status: retained ? 'unavailable' : empty ? 'empty' : 'fresh', availability: retained ? 'partial' : empty ? 'empty' : 'complete',
    source: name === 'identity' ? 'mixed' : 'espn', derivation: name === 'identity' ? 'mixed' : name === 'detail' ? 'retained' : name === 'squad' ? 'current-roster' : ['bracket', 'gameLog', 'participation'].includes(name) ? 'derived' : 'direct', scope, observedAt: retained ? null : new Date(now).toISOString(), finalizedAt: null };
}
function result(body: unknown, names: Partial<Record<ReaderResourceName, ReaderResource['scope']>>): ReaderResponse {
  const resources: ReaderResponse['resources'] = { version: 1, resources: {} };
  for (const [name, scope] of Object.entries(names)) resources.resources[name as ReaderResourceName] = resource(name as ReaderResourceName, scope, Array.isArray(body) && body.length === 0);
  const headers = new Headers({ 'X-ScoreArc-Freshness': Array.isArray(body) && body.length === 0 ? 'empty' : 'fresh', 'X-ScoreArc-Poll-Status': 'ok', 'X-ScoreArc-Observed-At': new Date(now).toISOString(), 'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0' });
  return { body, resources, headers };
}
function harness(custom?: (path: string, query?: Record<string, string>) => ReaderResponse | undefined) {
  const calls: string[] = [];
  const read: ReaderTransport = async (path, query) => {
    calls.push(path + '?' + new URLSearchParams(query));
    const override = custom?.(path, query); if (override) return override;
    if (path.endsWith('/identities')) {
      return result(query!.ids.split(',').map(id => {
        // Labeled synthetic test crosswalk: fixed ordinal refs, never production identity inference.
        const index = query!.from === 'canonical' ? derived.phaseMatches.findIndex(match => match.id === id) : 0;
        const match = derived.phaseMatches[index] ?? rawMatch;
        return { id, status: 'resolved', canonicalId: match.id, providerId: query!.from === 'espn' ? id : String(401877007 + index), competitionId: 'leagues-cup', seasonId: '2026', homeId: match.home.id, awayId: match.away.id };
      }), { identity: 'selection' });
    }
    if (path.endsWith('/matches')) return result([rawMatch], { matches: 'selection', identity: 'competition-season', ...(query?.detail ? { detail: 'competition-season' as const } : {}) });
    throw new Error(`unexpected test route ${path}`);
  };
  const cache = new TtlCache<ReaderResponse>(() => now);
  return { store: createReaderDataStore({ read, cache, cacheNamespace: 'test', now: () => now, signal: new AbortController().signal, news: async () => [] }), calls, read, cache };
}
describe('reader DataStore', () => {
  it('normalizes collection ids from persisted refs without summary fan-out', async () => {
    const { store, calls } = harness();
    const matches = await store.getMatches(rc, '20260804-20260814');
    expect(matches[0].id).toBe('401877007');
    expect(matches[0].home.id).toBe(providerTeamId(rawMatch.home.id));
    expect(matches[0].scope).toEqual({ competitionId: 'leagues-cup', seasonId: '2026' });
    expect(matches[0].readerResources?.resources.detail).toMatchObject({ status: 'unavailable', availability: 'partial' });
    expect(calls).toHaveLength(2); expect(calls[0]).toContain('detail=summary');
    const light = harness(); const fixtures = await light.store.getFixtures(rc, '20260804-20260814');
    expect(fixtures[0].readerResources?.resources.matches?.status).toBe('fresh');
    expect(fixtures[0].readerResources?.resources.detail).toBeUndefined();
    expect(light.calls[0]).not.toContain('detail');
  });
  it('accepts a verified empty result without identity requests and rejects contradictory evidence', async () => {
    const empty = harness(path => path.endsWith('/matches') ? result([], { matches: 'selection', identity: 'competition-season' }) : undefined);
    expect(await empty.store.getFixtures(rc, '20260804-20260814')).toEqual([]); expect(empty.calls).toHaveLength(1);
    const invalid = harness(path => path.endsWith('/matches') ? result([rawMatch], { identity: 'competition-season' }) : undefined);
    await expect(invalid.store.getFixtures(rc, '20260804-20260814')).rejects.toMatchObject({ reason: 'metadata' });
  });
  it('rejects valid-looking rows outside range, swapped crosswalk sides and invalid nested bodies', async () => {
    await expect(harness().store.getFixtures(rc, '20260101-20260102')).rejects.toMatchObject({ reason: 'scope' });
    const invalid = harness(path => path.endsWith('/matches') ? result([{ ...rawMatch, homeScore: '1' }], { matches: 'selection', identity: 'competition-season' }) : undefined);
    await expect(invalid.store.getFixtures(rc, '20260804-20260814')).rejects.toMatchObject({ reason: 'body' });
  });
  it('reads both leader metrics as a single logical result and uses source-specific cached evidence', async () => {
    let time = now;
    const leaders = vectors.leaders.frontend.scorers.map(row => ({ ...row, playerId: '01890000-0000-7000-8000-000000000444', playerSlug: null, teamId: null }));
    const { read, calls, cache } = harness((path, query) => path.endsWith('/leaders') ? result(query?.metric === 'assists' ? [] : leaders, { leaders: 'competition-season', identity: 'competition-season' }) : undefined);
    const make = () => createReaderDataStore({ read, cache, cacheNamespace: 'leaders', now: () => time, signal: new AbortController().signal, news: async () => [] });
    const boards = await make().getLeaders(rc); expect(boards.scorers.length).toBeGreaterThan(0); expect(boards.assists).toEqual([]);
    expect(boards.scorers[0]).toMatchObject({ playerId: '01890000-0000-7000-8000-000000000444', playerSlug: null });
    await make().getLeaders(rc); expect(calls).toHaveLength(2);
    time += 20 * 60_000;
    await expect(make().getLeaders(rc)).rejects.toMatchObject({ reason: 'stale' });
  });
});

it('preserves separate tables sharing a display-derived group id', async () => {
  const original = derived.membership.ligaMx.groups[0];
  const groups = [original, { ...original, standings: original.standings.slice(0, 2) }];
  const { store } = harness(path => path.endsWith('/standings')
    ? result(groups, { standings: 'competition-season', identity: 'competition-season' }) : undefined);
  const tables = await store.getStandings(resolveSeason('liga-mx', '2026-apertura')!);
  expect(tables).toHaveLength(2);
  expect(tables.map(group => group.id)).toEqual([original.id, original.id]);
  expect(tables.map(group => group.standings.length)).toEqual(groups.map(group => group.standings.length));
});

it('derives MLS and Leagues Cup using only configured bounded input reads', async () => {
  const { store, calls } = harness((path) => {
    if (path.endsWith('/standings')) {
      return result(path.includes('/mls/') ? derived.membership.mls.groups : derived.membership.ligaMx.groups, { standings: 'competition-season', identity: 'competition-season' });
    }
    if (path.endsWith('/matches')) return result(derived.phaseMatches, { matches: 'selection', identity: 'competition-season' });
  });
  const phase = await store.getStandings(rc);
  expect(phase).toHaveLength(2); expect(phase.every(g => g.readerDerivation?.status === 'complete')).toBe(true);
  expect(phase[0].readerDerivation?.inputs?.map(input => [input.competitionId, input.seasonId, Object.keys(input.resources.resources)])).toEqual([
    ['leagues-cup', '2026', ['matches', 'identity']], ['mls', '2026', ['standings', 'identity']],
    ['liga-mx', '2026-apertura', ['standings', 'identity']],
  ]);
  expect(calls).toHaveLength(4); expect(calls.some(url => url.includes('scope=season'))).toBe(false);
  const mls = await store.getStandings(resolveSeason('mls', '2026')!);
  expect(mls.some(g => g.labelKey !== undefined)).toBe(true);
  expect(calls).toHaveLength(4); // membership body reused with its evidence
});

it('keeps explicit unavailable derived inputs out of success-shaped empty tables', async () => {
  const { store } = harness(path => path.endsWith('/standings') ? result([], { standings: 'competition-season', identity: 'competition-season' }) : path.endsWith('/matches') ? result([], { matches: 'selection', identity: 'competition-season' }) : undefined);
  await expect(store.getStandings(rc)).rejects.toMatchObject({ reason: 'unavailable' });
});

it('maps live, upcoming, bracket, team and squad without enriching lightweight reads', async () => {
  const squad = [{ id: '297287', name: 'Ali Avila', jersey: null, position: '', age: null, nationality: null, headshotUrl: null, stats: null }];
  const bracket = [{ slug: 'final', name: 'Final', matches: [{ id: rawMatch.id, round: 'final', kickoff: rawMatch.kickoff, home: { ...rawMatch.home, placeholder: false }, away: { ...rawMatch.away, placeholder: false }, homeScore: rawMatch.homeScore, awayScore: rawMatch.awayScore, state: rawMatch.state, statusDetail: rawMatch.statusDetail, statusName: rawMatch.statusName, minute: rawMatch.minute, winnerId: rawMatch.winnerId, note: rawMatch.note }] }];
  const team = { team: rawMatch.home, location: null, color: null, altColor: null, record: null, standing: null, standingSummary: null, squad, schedule: [{ ...rawMatch, scope: { competitionId: 'leagues-cup', seasonId: '2026' } }], scheduleAvailability: { results: 'available', upcoming: 'available' } };
  const { store, calls } = harness((path, query) => {
    if (path.endsWith('/bracket')) return result(bracket, { bracket: 'competition-season', identity: 'competition-season' });
    if (path.endsWith('/squad')) return result(squad, { squad: 'team-season', identity: 'team-season', seasonStats: 'team-season' });
    if (path.includes('/teams/')) return result(team, { matches: 'team-season', identity: 'team-season', detail: 'team-season', standings: 'competition-season', squad: 'team-season', seasonStats: 'team-season' });
    if (path.endsWith('/matches') && query?.state === 'scheduled') return result([{ ...rawMatch, kickoff: new Date(now + 60_000).toISOString(), state: 'scheduled', winnerId: null }], { matches: 'selection', identity: 'competition-season' });
  });
  expect((await store.getLiveWindow(rc))[0].id).toBe('401877007');
  expect((await store.getUpcoming(rc, 3))[0].state).toBe('scheduled');
  expect((await store.getBracket(rc))[0].matches[0].id).toBe('401877007');
  expect((await store.getTeam(rc, providerTeamId(rawMatch.home.id)!))?.schedule[0].id).toBe('401877007');
  expect(await store.getSquad(rc, providerTeamId(rawMatch.home.id)!)).toEqual(squad);
  const count = calls.length;
  expect(await store.getNews(rc)).toEqual([]); expect(calls.length).toBe(count);
  expect(calls.filter(url => url.includes('/matches?')).every(url => !url.includes('detail'))).toBe(true);
});

it('degrades explicitly unavailable team children without losing validated identity', async () => {
  const team = { team: rawMatch.home, location: 'Home', color: null, altColor: null, record: null, standing: null, standingSummary: null, squad: [], schedule: [], scheduleAvailability: { results: 'unavailable', upcoming: 'unavailable' } };
  const { store } = harness(path => {
    if (!path.includes('/teams/')) return;
    const response = result(team, { matches: 'team-season', identity: 'team-season', detail: 'team-season', standings: 'competition-season', squad: 'team-season', seasonStats: 'team-season' });
    response.resources.resources.matches = resource('matches', 'team-season');
    response.resources.resources.matches.status = 'unavailable'; response.resources.resources.matches.availability = 'unavailable';
    response.resources.resources.squad = { ...resource('squad', 'team-season'), status: 'unavailable', availability: 'unavailable' };
    return response;
  });
  const profile = await store.getTeam(rc, providerTeamId(rawMatch.home.id)!);
  expect(profile?.location).toBe('Home'); expect(profile?.scheduleAvailability?.results).toBe('unavailable');
  expect(profile?.readerResources?.resources.squad?.availability).toBe('unavailable');
});
