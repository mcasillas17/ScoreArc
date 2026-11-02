import { describe, expect, it } from 'vitest';
import { createSelectedDataStore, isSelectedDataStore, isReaderOperationStore, runDataOperation } from './sourceSelection';
import { ReaderFailure } from './readerTransport';
import type { DataStore } from './store';
import { resolveSeason } from './competitions';
const rc = resolveSeason('mls', '2026')!;
const stub = (value: string): DataStore => ({
  getMatches: async () => [], getFixtures: async () => [], getLiveWindow: async () => [], getUpcoming: async () => [],
  getStandings: async () => [{ id: value, name: value, standings: [] }], getBracket: async () => [],
  getMatchSummary: async () => { throw new Error('unused'); }, getLeaders: async () => ({ scorers: [], assists: [] }),
  getNews: async () => [], getTeam: async () => null, getSquad: async () => [], getPlayer: async () => null,
});
describe('source selection', () => {
  it('identifies both controlled attempts without marking the shared ESPN store or its optional joins', async () => {
    const espn = stub('espn');
    const reader = stub('reader');
    reader.getStandings = async () => { throw new ReaderFailure('network'); };
    const store = createSelectedDataStore({ source: 'reader', espn, reader: () => reader });
    expect(isSelectedDataStore(store)).toBe(true);
    const attempts: boolean[] = [];
    await runDataOperation(store, async source => {
      expect(isSelectedDataStore(source)).toBe(true);
      attempts.push(isReaderOperationStore(source));
      return source.getStandings(rc);
    });
    expect(attempts).toEqual([true, false]);
    expect(isSelectedDataStore(espn)).toBe(false);
    expect(isReaderOperationStore(espn)).toBe(false);
  });
  it('returns the ESPN instance unchanged when flags are absent or off, making zero reader calls', async () => {
    const espn = stub('espn'); let calls = 0;
    const store = createSelectedDataStore({ espn, reader: () => { calls++; return stub('reader'); } });
    expect(store).toBe(espn);
    await store.getStandings(rc);
    expect(calls).toBe(0);
  });
  it('discards all parallel reader subreads and reruns the entire operation once', async () => {
    const espn = stub('espn'); const reader = stub('reader');
    reader.getSquad = async () => { throw new ReaderFailure('stale'); };
    let fallbacks = 0;
    const store = createSelectedDataStore({ source: 'reader', espn, reader: () => reader, onFallback: () => { fallbacks++; } });
    const result = await runDataOperation(store, async source => {
      const [tables, squads] = await Promise.all([source.getStandings(rc), source.getSquad(rc, 'x')]);
      return { tables, squads };
    });
    expect(result.tables[0].id).toBe('espn');
    expect(fallbacks).toBe(1);
  });
  it('does not fallback for caller cancellation, 400, or side mismatch', async () => {
    for (const reason of ['http', 'scope'] as const) {
      const reader = stub('reader'); reader.getStandings = async () => { throw new ReaderFailure(reason, false); };
      let fallback = 0;
      const store = createSelectedDataStore({ source: 'reader', espn: stub('espn'), reader: () => reader, onFallback: () => { fallback++; } });
      await expect(store.getStandings(rc)).rejects.toMatchObject({ reason }); expect(fallback).toBe(0);
    }
    const controller = new AbortController(); controller.abort();
    const store = createSelectedDataStore({ source: 'reader', espn: stub('espn'), reader: () => { throw new Error('must not start'); } });
    await expect(runDataOperation(store, source => source.getStandings(rc), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('falls back on an internal deadline, propagates both-source failures, and accepts empty data', async () => {
    const reader = stub('reader'); reader.getStandings = () => new Promise(() => {});
    const store = createSelectedDataStore({ source: 'reader', espn: stub('espn'), reader: () => reader, readerTimeoutMs: 5, totalTimeoutMs: 100 });
    expect((await store.getStandings(rc))[0].id).toBe('espn');
    const broken = stub('espn'); broken.getStandings = async () => { throw new Error('unavailable'); };
    const failed = createSelectedDataStore({ source: 'reader', espn: broken, reader: () => reader, readerTimeoutMs: 5, totalTimeoutMs: 100 });
    await expect(failed.getStandings(rc)).rejects.toThrow('unavailable');
    let attempts = 0;
    const empty = createSelectedDataStore({ source: 'reader', espn: broken, reader: () => stub('reader'), onFallback: () => { attempts++; } });
    expect(await empty.getFixtures(rc, '20260801-20260802')).toEqual([]); expect(attempts).toBe(0);
  });
});

it('keeps reader configuration inert while disabled, including malformed unused origins', async () => {
  const { configuredDataStore } = await import('./configuredStore');
  const espn = stub('espn');
  let calls = 0;
  for (const env of [{}, { SCOREARC_DATA_SOURCE: 'espn', SCOREARC_READER_ORIGIN: 'http://unsafe' }]) {
    const store = configuredDataStore({ espn, fallback: () => espn, env, fetch: async () => { calls++; throw new Error('must not request'); } });
    expect(store).toBe(espn); await store.getStandings(rc); await store.getNews(rc);
  }
  expect(calls).toBe(0);
});
