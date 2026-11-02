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
  it('bounds a slow response body and distinguishes an aborted caller', async () => {
    const controller = new AbortController();
    const budget = createRequestBudget({ fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'X-ScoreArc-Resources': JSON.stringify(metadata) } }), signal: controller.signal });
    const read = createReaderTransport('https://reader.example', budget, controller.signal)('/v1/test');
    controller.abort(new Error('caller left'));
    await expect(read).rejects.toThrow('caller left');
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
