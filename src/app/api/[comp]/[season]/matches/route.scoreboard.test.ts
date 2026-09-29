import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataStore, dataStore } from '@/server/data/store';
import { TtlCache } from '@/server/data/cache';
import sb from '@/server/data/__fixtures__/espn-scoreboard.json';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { GET } from './route';

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const params = Promise.resolve({ comp: 'world-cup', season: '2026' });
const request = (range: string) => new Request(`http://localhost/api/world-cup/2026/matches?range=${range}`);

function realStore(failJune = false) {
  const fetchJson = vi.fn(async (url: string) => {
    const month = new URL(url).searchParams.get('dates');
    if (!/^\d{6}$/.test(month ?? '')) throw new Error('Failed to get events endpoint.');
    if (failJune && month === '202606') throw new Error('sensitive provider failure');
    return { ...sb, events: month === '202606' ? sb.events : [] };
  });
  const store = createDataStore({ fetchJson, cache: new TtlCache() });
  vi.spyOn(dataStore, 'getFixtures').mockImplementation(store.getFixtures);
  return fetchJson;
}

describe('matches route with real scoreboard retrieval', () => {
  it('returns exact UTC rows and a genuine empty window', async () => {
    const fetchJson = realStore();
    const response = await GET(request('20260629-20260629'), { params });
    expect(response.status).toBe(200);
    expect((await response.json()).map((m: { id: string }) => m.id)).toEqual(['760487', '760489']);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    const empty = await GET(request('20260620-20260620'), { params });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('reports a failed partition as sanitized 502 and retries the complete window on a later request', async () => {
    const fetchJson = realStore(true);
    for (let i = 0; i < 2; i++) {
      const response = await GET(request('20260601-20260630'), { params });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    }
    expect(fetchJson).toHaveBeenCalledTimes(4);
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('matches', 502, 'world-cup', '2026');
  });

  it('passes caller cancellation through before any provider request', async () => {
    const fetchJson = realStore(); const controller = new AbortController(); controller.abort();
    const req = new Request(request('20260629-20260629'), { signal: controller.signal });
    expect((await GET(req, { params })).status).toBe(502);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
