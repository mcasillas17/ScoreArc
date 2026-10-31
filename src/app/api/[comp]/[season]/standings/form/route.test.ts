import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { GET } from './route';

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));
vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

const get = (comp: string, season: string, signal?: AbortSignal) =>
  GET(new Request('http://x/api/form', { signal }), { params: Promise.resolve({ comp, season }) });

it('records no upstream failure when the reader leaves mid-read', async () => {
  vi.spyOn(dataStore, 'getStandings').mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = get('mls', '2026', controller.signal);
  controller.abort();
  await pending;
  expect(trackAPIRequestFailure).not.toHaveBeenCalled();
});

it('still records an upstream failure that outlives the reader', async () => {
  const controller = new AbortController();
  vi.spyOn(dataStore, 'getStandings').mockImplementationOnce(async () => { controller.abort(); throw new Error('upstream'); });
  await (await import('@/app/api/errorResponse')).seasonRoute('standings', async (rc) => dataStore.getStandings(rc))(
    new Request('http://x/api/standings', { signal: controller.signal }),
    { params: Promise.resolve({ comp: 'mls', season: '2026' }) },
  );
  expect(trackAPIRequestFailure).toHaveBeenCalledWith('standings', 502, 'mls', '2026');
});

it('reads through the DataStore without summaries and forwards request cancellation', async () => {
  vi.spyOn(dataStore, 'getStandings').mockResolvedValueOnce([{ id: 't', name: 't', standings: [
    { team: { id: 'a', name: 'A', abbr: 'A', crestUrl: null }, rank: 1, played: 1, wins: 1, draws: 0, losses: 0,
      goalsFor: 1, goalsAgainst: 0, goalDifference: 1, points: 3, advanced: false }] }]);
  let readSignal: AbortSignal | undefined;
  vi.spyOn(dataStore, 'getFixtures').mockImplementation((_rc, _range, signal) => new Promise((_, reject) => {
    readSignal = signal;
    signal?.addEventListener('abort', () => reject(signal.reason));
  }));
  const summary = vi.spyOn(dataStore, 'getMatchSummary');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const controller = new AbortController();
  const pending = get('laliga', '2026-27', controller.signal);
  await vi.waitFor(() => expect(readSignal).toBeDefined());
  expect(readSignal!.aborted).toBe(false);
  controller.abort();
  expect(readSignal!.aborted).toBe(true);
  await pending;
  expect(summary).not.toHaveBeenCalled();
});

it('answers a read with the no-store envelope', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  vi.spyOn(dataStore, 'getStandings').mockResolvedValueOnce([{ id: 't', name: 't', standings: [] }]);
  const response = await get('laliga', '2026-27');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({ scope: 'season', teams: {}, matches: [] });
});
