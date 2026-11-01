import { describe, expect, it } from 'vitest';
import { createDataStore } from './store';
import { TtlCache } from './cache';
import { resolveSeason } from './competitions';
import { ReaderFailure } from './readerTransport';
const rc = resolveSeason('world-cup', '2026')!;
describe('reader fallback ESPN error semantics', () => {
  it('propagates both-source unavailability while default ESPN keeps its established null/empty behavior', async () => {
    const deps = { cache: new TtlCache<unknown>(), fetchJson: async () => { throw new Error('unavailable'); } };
    const normal = createDataStore(deps);
    expect(await normal.getPlayer(rc, '297287')).toBeNull();
    expect(await normal.getTeam(rc, '203')).toBeNull();
    expect(await normal.getSquad(rc, '203')).toEqual([]);
    const fallback = createDataStore({ ...deps, propagateUnavailable: true });
    await expect(fallback.getPlayer(rc, '297287')).rejects.toThrow('unavailable');
    await expect(fallback.getTeam(rc, '203')).rejects.toThrow('unavailable');
    await expect(fallback.getSquad(rc, '203')).rejects.toThrow('unavailable');
  });
  it('preserves confirmed profile 404s but propagates server failures in enabled fallback', async () => {
    for (const status of [404, 503]) {
      const store = createDataStore({ cache: new TtlCache(), propagateUnavailable: true,
        fetchJson: async () => { throw new ReaderFailure('http', status >= 500, status); } });
      for (const read of [() => store.getPlayer(rc, '297287'), () => store.getTeam(rc, '203')]) {
        if (status === 404) expect(await read()).toBeNull();
        else await expect(read()).rejects.toMatchObject({ status: 503 });
      }
    }
  });
});
