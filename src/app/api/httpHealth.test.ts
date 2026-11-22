import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/og', () => ({ ImageResponse: class extends Response {
  constructor() { super(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }); }
} }));

const endpoints: Record<string, string> = {
  bracket: 'bracket', 'match/[id]': 'match-summary', matches: 'matches', news: 'news',
  'player/[playerSlug]': 'player', standings: 'standings', 'standings/form': 'standings-form',
  'team/[teamId]': 'team', 'top-assists': 'top-assists', 'top-scorers': 'top-scorers', og: 'og',
};
const base = new URL('./', import.meta.url);
const routes = readdirSync(fileURLToPath(base), { recursive: true, encoding: 'utf8' }).filter(file => /\/route\.tsx?$/.test(file));
const params = Promise.resolve({ comp: 'private-invalid-competition', season: 'private-season', id: 'private-id', teamId: 'private-team', playerSlug: 'private-slug' });
const healthEvents = () => vi.mocked(console.info).mock.calls.map(([msg]) => JSON.parse(msg as string)).filter(log => log.event === 'scorearc_http');

beforeEach(() => {
  vi.stubEnv('SCOREARC_DATA_SOURCE', 'compare');
  vi.stubEnv('SCOREARC_READER_ORIGIN', 'https://reader.example');
  vi.stubEnv('SCOREARC_READER_COMPARE_PERCENT', '10');
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('API request health', () => {
  it('emits one bounded inbound event from every route module, including the edge renderer', async () => {
    expect(routes.length).toBe(Object.keys(endpoints).length);
    for (const route of routes) {
      const endpoint = endpoints[route.replace('[comp]/[season]/', '').replace(/\/route\.tsx?$/, '')];
      expect(endpoint, route).toBeDefined();
      const routeModule = await import(new URL(route, base).href);
      expect(Object.keys(routeModule).filter(key => /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(key)), route).toEqual(['GET']);
      const { GET } = routeModule;
      const request = new NextRequest('https://private-host.example/api/private-path?compId=private-input');
      const response = await GET(request, { params });
      await response.arrayBuffer();
      const inbound = healthEvents().filter(e => e.direction === 'inbound' && e.endpoint === endpoint);
      expect(inbound, route).toHaveLength(1);
      expect(inbound[0]).toMatchObject({ service: 'frontend', dependency: 'self', method: 'GET', status: endpoint === 'og' ? 200 : 404,
        outcome: endpoint === 'og' ? 'success' : 'http_error', timestamp: expect.any(String), requestId: expect.any(String), durationMs: expect.any(Number) });
      if (endpoint === 'og') expect(inbound[0].bytes).toBe(3);
      else expect(inbound[0].appError).toBe('NOT_FOUND');
      expect(JSON.stringify(inbound[0])).not.toContain('private-');
    }
  });

  it('preserves 400, 502, and cancellation with their original response codes', async () => {
    const { GET } = await import('./[comp]/[season]/matches/route');
    const { dataStore } = await import('@/server/data/store');
    const scope = { params: Promise.resolve({ comp: 'world-cup', season: '2026' }) };
    const fail = vi.spyOn(dataStore, 'getFixtures').mockRejectedValue(new Error('private-provider-error'));
    expect((await GET(new Request('https://example.test/?range=oops'), scope)).status).toBe(400);
    expect((await GET(new Request('https://example.test/?range=20260610-20260610'), scope)).status).toBe(502);
    expect((await GET(new Request('https://example.test/?range=20260610-20260610', { signal: AbortSignal.abort() }), scope)).status).toBe(502);
    expect(fail).toHaveBeenCalledTimes(2);
    expect(healthEvents().filter(e => e.direction === 'inbound').map(e => [e.status, e.appError, e.outcome])).toEqual([
      [400, 'INVALID_REQUEST', 'http_error'], [502, 'UPSTREAM_UNAVAILABLE', 'http_error'], [502, 'UPSTREAM_UNAVAILABLE', 'cancelled'],
    ]);
    expect(JSON.stringify(healthEvents())).not.toContain('private-provider-error');
  });

  it.each([['compare', '0'], ['espn', '10']])('keeps logging off for mode %s and percentage %s', async (mode, percent) => {
    vi.stubEnv('SCOREARC_DATA_SOURCE', mode);
    vi.stubEnv('SCOREARC_READER_COMPARE_PERCENT', percent);
    const fetchAsset = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchAsset);
    const { GET } = await import('./og/route');
    await (await GET(new NextRequest('https://example.test/api/og?compId=world-cup'))).arrayBuffer();
    expect(fetchAsset).toHaveBeenCalled();
    expect(healthEvents()).toEqual([]);
  });

  it('records successful JSON and automatic HEAD with fresh request IDs', async () => {
    const { GET } = await import('./[comp]/[season]/news/route');
    const { dataStore } = await import('@/server/data/store');
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
    const scope = { params: Promise.resolve({ comp: 'world-cup', season: '2026' }) };
    for (const method of ['GET', 'HEAD']) {
      const request = new Request('https://example.test/api/private-address', { method, headers: { 'x-request-id': 'private-id' } });
      const response = await GET(request, scope);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
    const events = healthEvents().filter(e => e.direction === 'inbound');
    expect(events.map(e => [e.endpoint, e.method, e.outcome, e.status])).toEqual([['news', 'GET', 'success', 200], ['news', 'HEAD', 'success', 200]]);
    expect(new Set(events.map(e => e.requestId)).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain('private-');
  });
});

it('records escaped handler errors without inventing an HTTP status or logging the exception', async () => {
  const { observeApiRoute } = await import('@/lib/telemetry/inbound');
  const failure = new Error('private-error');
  const GET = observeApiRoute('matches', async () => { throw failure; });
  await expect(GET(new Request('https://example.test/api/secret'))).rejects.toBe(failure);
  expect(healthEvents()).toEqual([expect.objectContaining({ endpoint: 'matches', status: null, outcome: 'exception' })]);
  expect(JSON.stringify(healthEvents())).not.toMatch(/private-error|\/secret/);
});

it('counts a late OG stream error and a cancelled stream once with partial bytes', async () => {
  const { observeApiRoute } = await import('@/lib/telemetry/inbound');
  const failure = new Error('private-satori-error');
  const GET = observeApiRoute('og', async () => {
    let first = true;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) { first = false; controller.enqueue(new Uint8Array([4, 5])); }
        else controller.error(failure);
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } });
  });
  const response = await GET(new Request('https://example.test/api/og'));
  expect(response.headers.get('content-type')).toBe('image/png');
  await expect(response.arrayBuffer()).rejects.toBe(failure);
  const cancelled = await GET(new Request('https://example.test/api/og'));
  await cancelled.body!.cancel();
  expect(healthEvents().map(e => [e.status, e.outcome, e.bytes])).toEqual([[200, 'body', 2], [200, 'cancelled', 0]]);
});

it('joins asset probes to the OG request and retains only bounded labels and outcomes', async () => {
  const { GET } = await import('./og/route');
  vi.stubGlobal('fetch', async (target: string) => {
    if (target.includes('private-crest')) return new Response(null, { status: 404 });
    if (target.includes('brand/')) return new Response('bad brand content', { headers: { 'content-type': 'text/html' } });
    return new Response(null, { status: 200 });
  });
  const url = 'https://private-origin.test/api/og?compId=world-cup&champ=MEX&crest=https://a.espncdn.com/private-crest';
  await (await GET(new NextRequest(url))).arrayBuffer();
  const events = healthEvents();
  expect(events.filter(e => e.direction === 'inbound')).toHaveLength(1);
  expect(events.filter(e => e.direction === 'outbound')).toHaveLength(4);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ endpoint: 'og-crest', dependency: 'espn_cdn', method: 'HEAD', status: 404, outcome: 'http_error' }),
    expect.objectContaining({ endpoint: 'og-logo', dependency: 'espn_cdn', method: 'HEAD', status: 200, outcome: 'success' }),
    expect.objectContaining({ endpoint: 'og-flag', method: 'HEAD', status: 200, outcome: 'success' }),
    expect.objectContaining({ endpoint: 'og-mark', dependency: 'site_asset', method: 'GET', status: 200, outcome: 'body' }),
  ]));
  expect(events.every(e => e.requestId && e.requestId === events[0].requestId)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private-');
});

it('reports allowed image redirects per host and refuses redirects from the local brand asset', async () => {
  const { GET } = await import('./og/route');
  vi.stubGlobal('fetch', async (target: string) => {
    if (target.includes('private-crest')) return new Response(null, { status: 302, headers: { location: 'https://cdn.scorearc.futbol/crest.png' } });
    if (target.includes('brand/')) return new Response(null, { status: 307, headers: { location: 'https://unknown.test/image.png' } });
    return new Response(null);
  });
  const url = 'https://example.test/api/og?compId=world-cup&crest=https://a.espncdn.com/private-crest';
  await (await GET(new NextRequest(url))).arrayBuffer();
  expect(healthEvents().filter(e => e.endpoint === 'og-crest').map(e => [e.dependency,e.status,e.outcome])).toEqual([
    ['espn_cdn',302,'success'], ['scorearc_cdn',200,'success'],
  ]);
  expect(healthEvents().filter(e => e.endpoint === 'og-mark').map(e => [e.status,e.outcome])).toEqual([[307,'redirect']]);
});
