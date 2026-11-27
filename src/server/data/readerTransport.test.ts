import { describe, expect, it } from 'vitest';
import { createReaderTransport, ReaderFailure, createRequestBudget, readerOrigin } from './readerTransport';

const metadata = { version: 1, resources: { identity: { status: 'unavailable', availability: 'partial', source: 'mixed', derivation: 'mixed', scope: 'selection', observedAt: null, finalizedAt: null } } };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'X-ScoreArc-Resources': JSON.stringify(metadata) } });

describe('reader transport', () => {
  it('accepts only configured secure origins and local development loopback', () => {
    expect(readerOrigin('https://reader.example', true)).toBe('https://reader.example');
    expect(readerOrigin('http://localhost:4399', false)).toBe('http://localhost:4399');
    for (const value of ['http://reader.example', 'http://localhost:4399', 'https://localhost:4399', 'https://localhost.:4399', 'https://127.0.0.1:4399', 'https://[::1]:4399', 'https://u:p@reader.example', 'https://reader.example/path', 'https://reader.example?token=x', 'file:///tmp/x']) {
      expect(() => readerOrigin(value, true)).toThrow();
    }
  });
  it('parses resource metadata and sends no redirects or frontend caching directives', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetcher: typeof fetch = async (url, init) => { calls.push([String(url), init]); return response([]); };
    const budget = createRequestBudget({ fetch: fetcher, signal: new AbortController().signal });
    const client = createReaderTransport('https://reader.example', budget, budget.signal);
    expect((await client('/v1/competitions/mls/2026/standings')).body).toEqual([]);
    expect(calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });
  it('requests retained timestamps only for reader squad, team and player responses', async () => {
    const sent: (string | null)[] = [];
    const signal = new AbortController().signal;
    const budget = createRequestBudget({ signal, fetch: async (_url, init) => {
      sent.push(new Headers(init?.headers).get('X-ScoreArc-Roster-Stats'));
      return response([]);
    } });
    const read = createReaderTransport('https://reader.example', budget, signal);
    const prefix = '/v1/competitions/mls/2026';
    for (const path of ['teams/example', 'teams/example/squad', 'players/example', 'teams', 'matches']) {
      await read(prefix + '/' + path);
    }
    await budget.json('https://example.test/teams/example', signal, 'espn');
    expect(sent).toEqual(['retained-v1', 'retained-v1', 'retained-v1', null, null, null]);
  });
  it('sends X-ScoreArc-Client-Key only for reader requests and never for ESPN fallback', async () => {
    const keys: (string | null)[] = [];
    const signal = new AbortController().signal;
    const budget = createRequestBudget({
      signal,
      readerApiKey: 'trusted-reader-key-32-chars-minimum',
      fetch: async (_url, init) => {
        keys.push(new Headers(init?.headers).get('X-ScoreArc-Client-Key'));
        return response([]);
      },
    });
    const read = createReaderTransport('https://reader.example', budget, signal);
    await read('/v1/competitions/mls/2026/standings');
    await budget.json('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', signal, 'espn');
    expect(keys).toEqual(['trusted-reader-key-32-chars-minimum', null]);
  });
  it('bounds a slow response body and distinguishes an aborted caller', async () => {
    const controller = new AbortController();
    const budget = createRequestBudget({ fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'X-ScoreArc-Resources': JSON.stringify(metadata) } }), signal: controller.signal });
    const read = createReaderTransport('https://reader.example', budget, controller.signal)('/v1/test');
    controller.abort(new Error('caller left'));
    await expect(read).rejects.toThrow('caller left');
  });
  it('enforces the smaller endpoint or operation body limit on headers and streaming responses', async () => {
    for (const headers of [new Headers({ 'content-length': '24' }), new Headers()]) {
      const budget = createRequestBudget({ signal: new AbortController().signal, maxResponseBytes: 20,
        fetch: async () => new Response(JSON.stringify('1234567890'), { headers }) });
      await expect(budget.json('https://site.api.espn.com', undefined, 'espn', 8)).rejects.toMatchObject({ reason: 'budget' });
    }
    const budget = createRequestBudget({ signal: new AbortController().signal, maxResponseBytes: 8,
      fetch: async () => Response.json('1234567890') });
    await expect(budget.json('https://site.api.espn.com', undefined, 'espn', 20)).rejects.toMatchObject({ reason: 'budget' });
  });
  it('rejects oversized streaming bodies and missing metadata', async () => {
    const signal = new AbortController().signal;
    const budget = createRequestBudget({ fetch: async () => response('x'.repeat(100)), signal, maxResponseBytes: 32 });
    await expect(createReaderTransport('https://reader.example', budget, signal)('/v1/test')).rejects.toMatchObject({ reason: 'budget' });
    const noMeta = createRequestBudget({ fetch: async () => Response.json([]), signal });
    await expect(createReaderTransport('https://reader.example', noMeta, signal)('/v1/test')).rejects.toMatchObject({ reason: 'metadata' });
  });
  it('bounds concurrency and total calls without retrying 429 or 400', async () => {
    let active = 0, peak = 0;
    const signal = new AbortController().signal;
    const budget = createRequestBudget({ fetch: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return response([]); }, signal, maxCalls: 8 });
    const read = createReaderTransport('https://reader.example', budget, signal);
    await Promise.all(Array.from({ length: 8 }, () => read('/v1/test')));
    expect(peak).toBeLessThanOrEqual(4);
    await expect(read('/v1/test')).rejects.toMatchObject({ reason: 'budget' });
    for (const status of [400, 429, 500]) {
      const failed = createRequestBudget({ fetch: async () => new Response('', { status }), signal });
      await expect(createReaderTransport('https://reader.example', failed, signal)('/v1/test')).rejects.toMatchObject({ fallback: status !== 400 });
      expect(failed.calls).toBe(1);
    }
    expect(new ReaderFailure('scope', false).fallback).toBe(false);
  });
});

it('stops queued and later requests after the shared byte budget is exhausted', async () => {
  const signal = new AbortController().signal;
  const budget = createRequestBudget({ fetch: async () => Response.json('x'.repeat(30)), signal, maxBytes: 64 });
  await Promise.allSettled(Array.from({ length: 12 }, () => budget.json('https://reader.example/v1/test')));
  expect(budget.calls).toBeLessThanOrEqual(4);
  const calls = budget.calls;
  await expect(budget.json('https://reader.example/v1/test')).rejects.toMatchObject({ reason: 'budget' });
  expect(budget.calls).toBe(calls);
});
