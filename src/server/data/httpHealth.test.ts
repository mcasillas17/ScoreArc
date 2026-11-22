import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withHealthContext, type FrontendHttpFields } from '@/lib/telemetry/http';
import { buildOutboundEndpoint } from './httpHealth';
import { createRequestBudget } from './readerTransport';
import { boundedFetchJson } from './scoreboardWindow';
import * as espn from './endpoints';
import { createDataStore } from './store';
import { createSelectedDataStore } from './sourceSelection';
import { resolveSeason } from './competitions';
import { TtlCache } from './cache';
import type { ComparisonEvent } from './readerComparison';

const id = 'private-test-id';
const rc = 'test.league';
const base = 'https://reader.example';
const scoped = base + '/v1/competitions/' + rc + '/2026';
const collector = () => {
  const events: FrontendHttpFields[] = [];
  const run = <T>(read: () => Promise<T>) => withHealthContext({ requestId: 'request', operationId: 'operation', onHttp: e => events.push(e) }, read);
  return { events, run };
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('outbound HTTP health', () => {
  it('maps every frontend ESPN builder and every reader route to bounded, separate endpoint families', () => {
    const builders: Record<keyof typeof espn, [string, string]> = {
      scoreboardUrl: [espn.scoreboardUrl(rc, '20261117'), 'scoreboard'], standingsUrl: [espn.standingsUrl(rc, 2026), 'standings'],
      summaryUrl: [espn.summaryUrl(rc, id), 'summary'], statisticsUrl: [espn.statisticsUrl(rc), 'statistics'],
      newsUrl: [espn.newsUrl(rc), 'news'], teamsUrl: [espn.teamsUrl(rc), 'teams'], teamUrl: [espn.teamUrl(rc, id), 'team'],
      teamRosterUrl: [espn.teamRosterUrl(rc, id), 'roster'], teamScheduleUrl: [espn.teamScheduleUrl(rc, id), 'schedule-results'],
      athleteUrl: [espn.athleteUrl(rc, id), 'athlete'], athleteOverviewUrl: [espn.athleteOverviewUrl(rc, id), 'overview'],
      athleteBioUrl: [espn.athleteBioUrl(rc, id), 'bio'],
    };
    for (const [url, route] of Object.values(builders)) expect(buildOutboundEndpoint('espn', url), url).toBe(route);
    expect(buildOutboundEndpoint('espn', espn.teamScheduleUrl(rc, id, true))).toBe('schedule-upcoming');
    const contract = readFileSync(new URL('../../../backend/reader/openapi.yaml', import.meta.url), 'utf8');
    const templates = [...contract.matchAll(/^  (\/[^:\s]+):$/gm)].map(match => match[1]);
    expect(templates).toContain('/v1/matches/{id}/box-score');
    for (const template of templates) {
      const url = base + template.replace(/\{\w+\}/g, id) + '?secret=x';
      expect(buildOutboundEndpoint('reader', url), url).toBe(template);
    }
    expect(buildOutboundEndpoint('reader', base + '/v1/private-test-id/standings')).toBe('other');
  });

  it('counts real calls through body completion, retains 200 decode failures and omits budget refusals', async () => {
    const { run, events } = collector();
    const budget = createRequestBudget({ dependency: 'reader', signal: new AbortController().signal, maxCalls: 2,
      fetch: vi.fn().mockResolvedValueOnce(new Response('[]',{ headers: {'x-request-id':'0123456789abcdef'} })).mockResolvedValueOnce(new Response('{')) });
    await run(async () => {
      await budget.json(scoped + '/teams');
      await expect(budget.json(scoped + '/matches')).rejects.toMatchObject({reason:'body'});
      await expect(budget.json(scoped + '/matches')).rejects.toMatchObject({reason:'budget'});
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({dependency:'reader', requestId:'request', operationId:'operation', status:200, bytes:2, outcome:'success', readerRequestId:'0123456789abcdef'});
    expect(events[1]).toMatchObject({status:200, bytes:1, outcome:'body'});
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts ESPN control/news and HTTP, network and in-flight timeout outcomes once, without URLs or guessed byte counts', async () => {
    const { run, events } = collector();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ articles: [] }))
      .mockResolvedValueOnce(new Response(null,{status:429})).mockRejectedValueOnce(new Error('secret-provider-body'))
      .mockImplementationOnce(() => new Promise(() => {})));
    await run(async () => {
      await boundedFetchJson(espn.newsUrl(rc));
      await expect(boundedFetchJson(espn.athleteBioUrl(rc,id))).rejects.toMatchObject({status:429});
      await expect(boundedFetchJson(espn.teamUrl(rc,id))).rejects.toThrow('secret-provider-body');
      await expect(boundedFetchJson(espn.summaryUrl(rc,id),{signal:AbortSignal.timeout(10),maxBytes:1024})).rejects.toMatchObject({name:'TimeoutError'});
      await expect(boundedFetchJson(espn.summaryUrl(rc,id),{signal:AbortSignal.abort(),maxBytes:1024})).rejects.toMatchObject({name:'AbortError'});
    });
    expect(events.map(e => [e.endpoint,e.status,e.outcome,e.bytes])).toEqual([
      ['news',200,'success',undefined],['bio',429,'http_error',undefined],['team',null,'network',undefined],['summary',null,'timeout',undefined],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private-test-id|secret-provider-body|test\.league/);
  });

  it('keeps native cross-origin redirects in monitoring-only mode and records one completed fetch', async () => {
    vi.stubEnv('SCOREARC_HTTP_TELEMETRY', '1');
    vi.stubEnv('SCOREARC_DATA_SOURCE', 'espn');
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const target = createServer((_req, res) => { res.end('{"ok":true}'); });
    const origin = createServer((_req, res) => {
      const binding = target.address();
      if (!binding || typeof binding === 'string') throw new Error('no target binding');
      res.writeHead(302, { location: 'http://127.0.0.1:' + binding.port + '/final' }).end();
    });
    target.listen(0, '127.0.0.1'); origin.listen(0, '127.0.0.1');
    try {
      await Promise.all([once(target, 'listening'), once(origin, 'listening')]);
      const binding = origin.address();
      if (!binding || typeof binding === 'string') throw new Error('no origin binding');
      const url = 'http://127.0.0.1:' + binding.port + '/apis/site/v2/sports/soccer/league/news';
      await expect(boundedFetchJson(url)).resolves.toEqual({ ok: true });
      expect(logs).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ dependency: 'espn', endpoint: 'news', status: 200, outcome: 'success' });
      vi.stubEnv('SCOREARC_HTTP_TELEMETRY', undefined);
      await expect(boundedFetchJson(url)).resolves.toEqual({ ok: true });
      expect(logs).toHaveBeenCalledTimes(1);
    } finally {
      origin.closeAllConnections(); target.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    }
  });

  it('counts real redirect hops for ordinary ESPN reads and rejects sampled redirects without following', async () => {
    const hits: string[] = [];
    const path = '/apis/site/v2/sports/soccer/league';
    const server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url?.endsWith('/news')) res.writeHead(302, { location: 'scoreboard' });
      else if (req.url?.endsWith('/teams')) res.writeHead(307, { location: 'http://user:pass@127.0.0.1/' });
      else res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an HTTP port');
      const origin = 'http://127.0.0.1:' + address.port;
      const { run, events } = collector();
      await run(async () => {
        await expect(boundedFetchJson(origin + path + '/news')).resolves.toEqual([]);
        await expect(boundedFetchJson(origin + path + '/teams')).rejects.toThrow(TypeError);
        for (const dependency of ['espn', 'reader'] as const) {
          const budget = createRequestBudget({ dependency, signal: new AbortController().signal });
          await expect(budget.json(origin + path + '/news')).rejects.toMatchObject({ reason: 'network' });
        }
      });
      expect(hits).toEqual(['news','scoreboard','teams','news','news'].map(name => path + '/' + name));
      expect(events.map(e => [e.dependency,e.endpoint,e.status,e.outcome])).toEqual([
        ['espn','news',302,'success'], ['espn','scoreboard',200,'success'], ['espn','teams',307,'redirect'],
        ['espn','news',302,'redirect'], ['reader','other',302,'redirect'],
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('counts the terminal failure on a 20-hop redirect loop without dispatching another request', async () => {
    const { run, events } = collector();
    vi.stubGlobal('fetch', async () => new Response(null, { status: 301, headers: { location: 'news' } }));
    await expect(run(() => boundedFetchJson(espn.newsUrl(rc)))).rejects.toThrow(TypeError);
    expect(events.map(event => [event.endpoint, event.status, event.outcome])).toEqual([
      ...Array.from({ length: 20 }, () => ['news', 301, 'success']), ['news', 301, 'redirect'],
    ]);
  });

  it('isolates simultaneous operations and remains silent outside the experiment', async () => {
    const a = collector(), b = collector();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    await Promise.all([a.run(() => boundedFetchJson(espn.statisticsUrl(rc))), b.run(() => boundedFetchJson(espn.newsUrl(rc)))]);
    await boundedFetchJson(espn.newsUrl(rc));
    expect(a.events.map(e => e.endpoint)).toEqual(['statistics']);
    expect(b.events.map(e => e.endpoint)).toEqual(['news']);
  });
});


it('links control and news wire events to reads once when both telemetry settings apply', async () => {
  vi.stubEnv('SCOREARC_HTTP_TELEMETRY', '1');
  const defaultEmitter = vi.spyOn(console, 'info').mockImplementation(() => {});
  const events: ComparisonEvent[] = [], hits: FrontendHttpFields[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ articles: [], stats: [] })));
  const upstream = createDataStore({ fetchJson: boundedFetchJson, cache: new TtlCache<unknown>() });
  const store = createSelectedDataStore({ source: 'compare', sample: () => 1, espn: upstream,
    reader: () => { throw new Error('unexpected reader'); }, onComparison: event => events.push(event), onHttp: event => hits.push(event) });
  const season = resolveSeason('premier-league', '2026-27')!;
  await withHealthContext({ requestId: 'test-request' }, async () => {
    await store.getNews(season);
    await store.getNews(season);
    await store.getLeaders(season);
    await store.getLeaders(season);
  });
  expect(hits.map(event => [event.cohort, event.endpoint])).toEqual([['news', 'news'], ['control', 'statistics']]);
  expect(events.filter(event => event.type === 'read')).toHaveLength(4);
  expect(defaultEmitter).not.toHaveBeenCalled();
  for (const hit of hits) {
    expect(events.find(e => e.type === 'read' && e.readId === hit.readId)).toMatchObject({
      requestId: 'test-request', operationId: hit.operationId, endpoint: hit.logicalEndpoint, cohort: hit.cohort,
    });
  }
});
