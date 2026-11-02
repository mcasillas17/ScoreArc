import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataStore, type DataStore } from '@/server/data/store';
import { createSelectedDataStore } from '@/server/data/sourceSelection';
import { createReaderDataStore } from '@/server/data/apiStore';
import { createReaderTransport } from '@/server/data/readerTransport';
import { TtlCache } from '@/server/data/cache';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import { GET as standingsGET } from './[comp]/[season]/standings/route';
import { GET as bracketGET } from './[comp]/[season]/bracket/route';
import { GET as teamGET } from './[comp]/[season]/team/[teamId]/route';

const selected = vi.hoisted(() => ({ store: undefined as DataStore | undefined }));
vi.mock('@/server/data/store', async original => ({
  ...await original<typeof import('@/server/data/store')>(),
  get dataStore() { return selected.store; },
}));
vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); });

const params = { comp: 'world-cup', season: '2026' };
const routes = [
  { name: 'standings', get: (request: Request) => standingsGET(request, { params: Promise.resolve(params) }) },
  { name: 'bracket', get: (request: Request) => bracketGET(request, { params: Promise.resolve(params) }) },
  { name: 'team', get: (request: Request) => teamGET(request, { params: Promise.resolve({ ...params, teamId: 'nat-arg' }) }) },
];

function readerScenario(pending: boolean) {
  const upstreams: string[] = [];
  let readerSignal: AbortSignal | undefined;
  let signalDispatched!: () => void;
  const dispatched = new Promise<void>(resolve => { signalDispatched = resolve; });
  const espn = createDataStore({ cache: new TtlCache(), fetchJson: async () => {
    upstreams.push('espn'); throw new Error('ESPN unavailable');
  } });
  selected.store = createSelectedDataStore({ source: 'reader', espn, readerTimeoutMs: 50, totalTimeoutMs: 250,
    fetch: async (url, init) => {
      expect(new URL(String(url)).origin).toBe('https://reader.test');
      upstreams.push('reader');
      readerSignal = init?.signal ?? undefined;
      signalDispatched();
      if (!pending) return new Response(null, { status: 503 });
      return new Promise<Response>((_resolve, reject) => readerSignal?.addEventListener('abort', () => reject(readerSignal?.reason), { once: true }));
    },
    reader: ({ signal, budget }) => createReaderDataStore({ signal, cache: new TtlCache(), cacheNamespace: 'route-cancellation',
      read: createReaderTransport('https://reader.test', budget, signal), news: espn.getNews,
    }),
  });
  return { upstreams, dispatched, readerSignal: () => readerSignal };
}

describe.each(routes)('$name reader request cancellation', route => {
  it('does not dispatch either source for an already-cancelled request', async () => {
    const scenario = readerScenario(false);
    const caller = new AbortController();
    caller.abort(new Error('caller left'));
    const response = await route.get(new Request('http://localhost/api/test', { signal: caller.signal }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(scenario.upstreams).toEqual([]);
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('aborts an outstanding reader read without starting ESPN fallback', async () => {
    const scenario = readerScenario(true);
    const caller = new AbortController();
    const response = route.get(new Request('http://localhost/api/test', { signal: caller.signal }));
    await scenario.dispatched;
    caller.abort(new Error('caller left'));
    expect((await response).status).toBe(502);
    expect(scenario.readerSignal()?.aborted).toBe(true);
    expect(scenario.readerSignal()?.reason).toBe(caller.signal.reason);
    expect(scenario.upstreams).toEqual(['reader']);
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });
});
