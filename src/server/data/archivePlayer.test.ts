import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import standings from './__fixtures__/espn-standings.json';
import type { ComparisonEvent } from './readerComparison';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function sample(options: { rosterStatus?: number; standingsStatus?: number; returnedYear?: number } = {}) {
  vi.resetModules();
  vi.stubEnv('SCOREARC_DATA_SOURCE', 'compare');
  vi.stubEnv('SCOREARC_READER_COMPARE_PERCENT', '100');
  vi.stubEnv('SCOREARC_READER_ORIGIN', 'https://reader.example');
  const events: ComparisonEvent[] = [];
  vi.spyOn(console, 'info').mockImplementation(line => {
    const event = JSON.parse(line);
    if (event.event === 'scorearc_reader_comparison') events.push(event);
  });
  const group = standings.children[0];
  const teams = group.standings.entries.slice(0, 2);
  const [target, other] = teams.map(row => row.team);
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.host === 'reader.example') return new Response(null, { status: 503 });
    if (url.pathname.endsWith('/standings')) {
      if (options.standingsStatus) return new Response(null, { status: options.standingsStatus });
      return Response.json({ ...standings, season: { year: 2022 }, children: [
        { ...group, standings: { ...group.standings, season: 2022, entries: teams } },
      ] });
    }
    const teamId = url.pathname.match(/\/teams\/(\d+)\/roster$/)?.[1];
    if (!teamId) throw new Error('Unexpected unscoped profile request');
    if (teamId === other.id && options.rosterStatus) return new Response(null, { status: options.rosterStatus });
    const year = options.returnedYear ?? Number(url.searchParams.get('season') ?? 2026);
    return Response.json({ status: 'success', team: { id: teamId }, season: { year, displayName: year + ' FIFA World Cup' },
      athletes: teamId === target.id ? [{ id: '123', displayName: 'Tournament Player', jersey: '4', age: 29,
        statistics: { splits: { categories: [{ stats: [
          { name: 'appearances', value: 3 }, { name: 'subIns', value: 1 }, { name: 'totalGoals', value: 0 },
        ] }] } },
      }] : [],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const { resolveSeason } = await import('./competitions');
  const { loadPlayerBySlug } = await import('./playerIndex');
  const edition = resolveSeason('world-cup', '2022')!;
  return { events, fetcher, target, other, load: (slug: string) => loadPlayerBySlug(edition, slug) };
}

it('serves the verified archive player despite an unrelated ESPN roster outage and records the 503', async () => {
  const s = await sample({ rosterStatus: 503 });
  await expect(s.load('tournament-player')).resolves.toMatchObject({
    id: '123', name: 'Tournament Player', team: { id: s.target.id }, jersey: '4', age: null, gameLog: [],
    totals: [{ name: 'totalGoals', display: '0' }, { name: 'starts-subIns', display: '2 (1)' }],
  });
  expect(s.fetcher.mock.calls.some(([url]) => String(url).includes('/athletes/'))).toBe(false);
  const rosters = s.fetcher.mock.calls.map(([input]) => new URL(String(input))).filter(url => url.pathname.endsWith('/roster'));
  expect(rosters.map(url => url.search)).toEqual(['?season=2022', '?season=2022']);
  expect(s.events).toContainEqual(expect.objectContaining({ endpoint: 'getSquad', outcome: 'inconclusive', espnStatus: 503 }));
  expect(s.events).toContainEqual(expect.objectContaining({ endpoint: 'getPlayer', outcome: 'inconclusive', espnError: 'partial' }));
  expect(s.events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'espn', decision: 'inconclusive' }));
});

it.each([404, 503])('resolves an unknown slug according to the missing roster status %i', async status => {
  const s = await sample({ rosterStatus: status });
  const pending = s.load('other-player');
  if (status === 404) await expect(pending).resolves.toBeNull();
  else await expect(pending).rejects.toMatchObject({ status: 503 });
  expect(s.events).toContainEqual(expect.objectContaining({ type: 'operation', served: status === 404 ? 'espn' : 'error', decision: 'inconclusive' }));
});

it('preserves a required ESPN membership failure', async () => {
  const s = await sample({ standingsStatus: 502 });
  await expect(s.load('tournament-player')).rejects.toMatchObject({ status: 502 });
  expect(s.events).toContainEqual(expect.objectContaining({ endpoint: 'getEditionTeams', outcome: 'inconclusive', espnStatus: 502 }));
});

it('rejects current squads even when ESPN returns them for the requested archive year', async () => {
  const s = await sample({ returnedYear: 2026 });
  await expect(s.load('tournament-player')).rejects.toMatchObject({ issue: 'scope_mismatch' });
  expect(s.events).toContainEqual(expect.objectContaining({ endpoint: 'getSquad', outcome: 'inconclusive', espnError: 'scope_mismatch' }));
});

async function archived2002(reader?: string) {
  vi.resetModules();
  vi.stubEnv('SCOREARC_DATA_SOURCE', reader ? 'reader' : 'compare');
  vi.stubEnv('SCOREARC_READER_COMPARE_PERCENT', '100');
  vi.stubEnv('SCOREARC_READER_ORIGIN', reader ?? 'https://reader.example');
  const capture = JSON.parse(readFileSync(new URL('../../../backend/shared/source/testdata/world-cup-2002.json', import.meta.url), 'utf8')) as {
    standings: unknown; rosters: Record<string, unknown>;
  };
  const rosters = capture.rosters;
  const events: ComparisonEvent[] = [];
  vi.spyOn(console, 'info').mockImplementation(line => {
    const event = JSON.parse(line);
    if (event.event === 'scorearc_reader_comparison') events.push(event);
  });
  const localFetch = fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (reader && url.origin === reader) return localFetch(input, init);
    if (url.host === 'reader.example') return new Response(null, { status: 503 });
    expect(url.search).toBe('?season=2002');
    if (url.pathname.endsWith('/standings')) return Response.json(capture.standings);
    const team = url.pathname.match(/\/teams\/(\d+)\/roster$/)?.[1];
    if (!team) throw new Error('Unexpected archive dependency ' + url.pathname);
    return rosters[team] ? Response.json(rosters[team]) : new Response(null, { status: 404 });
  });
  const { resolveSeason } = await import('./competitions');
  const { loadPlayerBySlug, competitionPlayerIndex } = await import('./playerIndex');
  const { createDataStore } = await import('./store');
  const { TtlCache } = await import('./cache');
  const { boundedFetchJson } = await import('./scoreboardWindow');
  const espn = createDataStore({ cache: new TtlCache(), fetchJson: boundedFetchJson });
  const edition = resolveSeason('world-cup', '2002')!;
  return {
    events, load: (slug: string) => loadPlayerBySlug(edition, slug),
    fromEspn: (slug: string) => loadPlayerBySlug(edition, slug, espn),
    croatia: () => espn.getSquad(edition, '477'),
    directory: () => competitionPlayerIndex(edition),
  };
}

it('keeps a missing 2002 roster inconclusive for an unknown player, while a verified teammate still resolves', async () => {
  const { load, events, croatia } = await archived2002();
  expect((await croatia()).find(row => row.id === '19278')).toMatchObject({ age: null, position: '-' });
  await expect(load('davor-vugrinec')).resolves.toMatchObject({
    id: '19278', name: 'Davor Vugrinec', jersey: '7', age: null, team: { id: '477' },
  });
  expect(events.filter(e => e.type === 'read' && e.endpoint === 'getSquad' && e.espnStatus === 404)).toHaveLength(2);
  expect(events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'espn', decision: 'inconclusive' }));
  await expect(load('unseen-player')).rejects.toMatchObject({ status: 404 });
  expect(events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'error', decision: 'inconclusive' }));
});

// The Go test starts its real reader on the disposable archive database and runs this case.
const origin = process.env.SCOREARC_TEST_ARCHIVE_READER;
it.skipIf(!origin)('resolves the 2002 player slug through the imported Go reader', async () => {
  const { load, fromEspn, directory } = await archived2002(origin);
  const index = await directory();
  expect(index.directory).toMatchObject({ totalTeams: 32, teamsWithRoster: 30 });
  expect(index.directory.players).toHaveLength(688);
  const player = await load('davor-vugrinec');
  expect(player).toMatchObject({
    id: '19278', name: 'Davor Vugrinec', team: { id: '477', abbr: 'CRO' }, jersey: '7',
    age: null, career: [], seasonLabel: "2002 Men's World Cup",
    totals: [{ name: 'totalGoals', display: '0' }, { name: 'goalAssists', display: '0' }, { name: 'starts-subIns', display: '1 (1)' }],
    readerResources: { resources: { squad: { source: 'espn', derivation: 'edition-roster', availability: 'complete' } } },
  });
  const { compareSemantic } = await import('./evaluation/normalize');
  expect(compareSemantic('getPlayer', player, await fromEspn('davor-vugrinec'))).toMatchObject({
    unequal: false, truncated: false, differences: [],
  });
  await expect(load('unseen-player')).rejects.toMatchObject({ status: 404 });
}, 25_000);
