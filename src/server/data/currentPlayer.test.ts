import { expect, it, vi } from 'vitest';
import { withHealthContext } from '@/lib/telemetry/http';
import { resolveSeason } from './competitions';
import { createDataStore } from './store';
import { TtlCache } from './cache';
import { mapSummaryLineups } from './providers/espn-summary';
import { loadPlayerGameLog } from './providers/espn-player-log';
import { mapTeamRoster } from './providers/espn-team';

const rc = resolveSeason('uefa-nations-league', '2026-27')!;
const belgium = { id: '459', name: 'Belgium', abbr: 'BEL', crestUrl: null };
const france = { id: '478', name: 'France', abbr: 'FRA', crestUrl: null };
const base = 'http://sports.core.api.espn.com/v2/sports/soccer/leagues/uefa.nations';
const athleteId = '283672';
const date = '2026-11-15T19:45:00Z';
const season = { year: 2026 };
const sides = [belgium, france].map((team, i) => ({ id: team.id, homeAway: i ? 'away' : 'home', team: { ...team, displayName: team.name, abbreviation: team.abbr }, score: { displayValue: '0' } }));
const match = (id: string) => ({ id, date, league: { slug: 'uefa.nations' }, season,
  competitions: [{ id, date, competitors: sides, status: { type: { state: 'post', completed: true } } }] });

function setup(wrongLeague = false, missing?: 'bio' | 'athlete') {
  const cache = new TtlCache<unknown>();
  cache.set('uefa-nations-league:2026-27:edition-teams', [france, belgium], 60_000);
  const loadSquad = vi.fn(async (_scope, teamId: string) => teamId === '459' ? mapTeamRoster({ athletes: [{
    id: athleteId, displayName: 'Jérémy Doku', position: { abbreviation: 'F' }, jersey: '11', statistics: {
      splits: { categories: [{ stats: [{ name: 'appearances', value: 1 }, { name: 'subIns', value: 0 }, { name: 'totalGoals', value: 1 }] }] },
    },
  }] }) : []);
  const fetchJson = vi.fn(async (address: string) => {
    const url = new URL(address);
    if (missing === 'bio' && url.pathname.endsWith('/bio')) return null;
    if (missing === 'athlete' && url.pathname.endsWith('/athletes/' + athleteId)) return {};
    if (url.pathname.endsWith('/eventlog')) return {
      $ref: base.replace('uefa.nations', wrongLeague ? 'eng.1' : 'uefa.nations') + '/seasons/2026/athletes/' + athleteId + '/eventlog',
      events: { pageIndex: 1, pageCount: 1, count: 2, items: ['101', '102'].map(id =>
        ({ event: { $ref: base + '/events/' + id }, teamId: belgium.id, played: true })) },
    };
    if (url.pathname.includes('/competitors/')) return {
      $ref: url.toString(), starter: url.pathname.includes('/events/101/'),
      subbedIn: { didSub: false }, subbedOut: { didSub: false },
    };
    if (url.pathname.endsWith('/schedule')) return { team: { id: belgium.id }, requestedSeason: season, events: ['101', '102'].map(match) };
    if (url.pathname.endsWith('/summary')) {
      const game = match(url.searchParams.get('event')!);
      return { header: { ...game, league: { slug: 'uefa.nations' } }, rosters: [belgium, france].map(team => ({
        team, roster: [{ athlete: { id: team === belgium ? athleteId : '2' }, starter: true, stats: [{ name: 'totalGoals', value: 1 }] }],
      })) };
    }
    if (url.pathname.endsWith('/bio')) return { teamHistory: [{ id: '999990', displayName: 'Former club', seasons: '2024', logo: 'https://a.espncdn.com/club.png' }] };
    if (url.pathname.endsWith('/overview')) return { statistics: { splits: [
      { leagueSlug: 'eng.1', teamId: '382' }, { leagueSlug: 'uefa.nations', teamId: '459' },
    ] } };
    if (url.pathname.endsWith('/athletes/' + athleteId)) return { athlete: {
      id: athleteId, displayName: 'Jérémy Doku', jersey: '7', team: { id: '382', displayName: 'Manchester City' },
      statsSummary: { statistics: [{ name: 'totalGoals', value: 8 }] },
    } };
    throw new Error('Unexpected test endpoint');
  });
  return { store: createDataStore({ fetchJson, loadSquad, cache }), fetchJson, loadSquad };
}

it.each([undefined, '459'])('serves the competition roster and verified appearances with roster hint %s', async hint => {
  const { store, fetchJson, loadSquad } = setup();
  const profile = await store.getPlayer(rc, athleteId, hint);
  expect(profile).toMatchObject({ team: belgium, jersey: '11', seasonLabel: '2026-27 UEFA Nations League Stats',
    totals: [{ name: 'starts-subIns', display: '1 (0)' }, { name: 'totalGoals', value: 1 }],
    career: [{ teamId: null, teamName: 'Former club', crestUrl: 'https://a.espncdn.com/club.png' }],
    gameLog: [{ eventId: '101', appearance: 'Started', teamId: '459', opponent: { id: '478' }, stats: { totalGoals: 1 } }],
  });
  expect(loadSquad.mock.calls.map(([, team]) => team)).toEqual(['459']);
  expect(fetchJson.mock.calls.filter(([address]) => address.includes('/summary?')).map(([address]) => new URL(address).searchParams.get('event'))).toEqual(['101']);
  const calls = fetchJson.mock.calls.length;
  expect(await store.getPlayer(rc, athleteId, hint)).toBe(profile);
  expect(fetchJson).toHaveBeenCalledTimes(calls);
});

it('rejects a club event index returned for a national-team request and preserves partial evidence on cache hits', async () => {
  const { store, fetchJson } = setup(true);
  const onDependencyFailure = vi.fn();
  const read = () => withHealthContext({ onDependencyFailure }, () => store.getPlayer(rc, athleteId, '459'));
  expect(await read()).toMatchObject({ team: belgium, gameLog: [] });
  expect(await read()).toMatchObject({ team: belgium, gameLog: [] });
  expect(onDependencyFailure).toHaveBeenCalledTimes(2);
  expect(onDependencyFailure).toHaveBeenCalledWith('espn', expect.objectContaining({ code: 'scope_mismatch' }));
  expect(fetchJson.mock.calls.some(([address]) => address.includes('/summary?'))).toBe(false);
});

it.each(['bio', 'athlete'] as const)('retains roster evidence and reports a malformed 200 %s as partial', async missing => {
  const { store } = setup(false, missing);
  const onDependencyFailure = vi.fn();
  const get = () => withHealthContext({ onDependencyFailure }, () => store.getPlayer(rc, athleteId, '459'));
  expect(await get()).toMatchObject({ name: 'Jérémy Doku', team: belgium });
  await get();
  expect(onDependencyFailure).toHaveBeenCalledTimes(2);
  expect(onDependencyFailure).toHaveBeenCalledWith('espn', expect.objectContaining({ code: 'partial' }));
});

it.each([false, true])('checks the provider year for both Apertura stages and explicit opposite-phase evidence (unknown=%s)', async unknown => {
  const scope = resolveSeason('liga-mx-femenil', '2026-apertura')!;
  const core = base.replace('uefa.nations', 'mex.w.1');
  const ids = ['101', '102', '103'];
  const phase = ['Torneo Apertura', 'Apertura - Quarterfinals', unknown ? 'Unlabeled round' : 'Torneo Clausura'];
  const fetchJson = vi.fn(async (url: string) => {
    if (url.includes('/eventlog')) return { $ref: core + '/seasons/2026/athletes/' + athleteId + '/eventlog',
      events: { pageIndex: 1, pageCount: 1, count: ids.length, items: ids.map(id => ({ event: { $ref: core + '/events/' + id }, teamId: belgium.id, played: true })) } };
    if (url.includes('/schedule')) {
      expect(new URL(url).searchParams.has('seasontype')).toBe(false);
      return { team: { id: belgium.id }, requestedSeason: season, events: ids.map((id, i) => ({
        ...match(id), league: { slug: 'mex.w.1' }, seasonType: { name: phase[i] },
        date: ['2026-10-11T20:00Z', '2026-11-11T20:00Z', '2027-02-11T20:00Z'][i],
      })) };
    }
    return { $ref: url, starter: true, subbedIn: { didSub: false }, subbedOut: { didSub: false } };
  });
  const summary = vi.fn(async () => ({ lineups: mapSummaryLineups({ rosters: [belgium, france].map(team => ({
    team, roster: [{ athlete: { id: athleteId }, starter: true, stats: [{ name: 'totalGoals', value: 0 }] }],
  })) }, belgium.id, france.id) }));
  const result = loadPlayerGameLog(scope, athleteId, fetchJson, null, summary);
  if (unknown) {
    await expect(result).rejects.toMatchObject({ issue: 'partial' });
    expect(summary).not.toHaveBeenCalled();
  } else {
    expect((await result).map(row => row.eventId)).toEqual(['102', '101']);
    expect(summary).toHaveBeenCalledTimes(2);
  }
});

it.each(['100', '105'])('checks only the latest five and fails closed when transfer match %s could change them', async duplicate => {
  const ids = ['100', '101', '102', '103', '104', '105'];
  const entries = [...ids.map(id => [id, belgium.id]), [duplicate, france.id]];
  const fetchJson = vi.fn(async (url: string) => {
    if (url.includes('/eventlog')) return {
      $ref: base + '/seasons/2026/athletes/' + athleteId + '/eventlog',
      events: { pageIndex: 1, pageCount: 1, count: entries.length, items: entries.map(([id, teamId]) =>
        ({ event: { $ref: base + '/events/' + id }, teamId, played: true })) },
    };
    if (url.includes('/schedule')) return { team: { id: belgium.id }, requestedSeason: season, events: ids.map(match) };
    throw new Error('Regular starters should not require separate lineup-entry requests');
  });
  const summary = vi.fn(async () => ({ lineups: mapSummaryLineups({ rosters: [belgium, france].map(team => ({
    team, roster: [{ athlete: { id: athleteId }, starter: true, stats: [{ name: 'totalGoals', value: 0 }] }],
  })) }, belgium.id, france.id) }));
  const result = loadPlayerGameLog(rc, athleteId, fetchJson, { teamId: belgium.id, appearances: 5 }, summary);
  if (duplicate === '105') {
    await expect(result).rejects.toMatchObject({ issue: 'partial' });
    expect(summary).not.toHaveBeenCalled();
  } else {
    expect((await result).map(row => row.eventId)).toEqual(['105', '104', '103', '102', '101']);
    expect(summary).toHaveBeenCalledTimes(5);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  }
});
