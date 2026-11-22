import { describe, expect, it, vi } from 'vitest';
import { NORMALIZATION_VERSION } from './evaluation/normalize';
import { configuredDataStore } from './configuredStore';
import { resolveSeason } from './competitions';
import type { DataStore } from './store';
import { createSelectedDataStore, runDataOperation } from './sourceSelection';
import { ReaderFailure } from './readerTransport';
import type { ComparisonEvent } from './readerComparison';

const rc = resolveSeason('world-cup', '2026')!;
const teams = [{ id: '1', abbr: 'ARG', name: 'Argentina', crestUrl: null }];
function setup(draw = 0.05, readerTimeoutMs = 1_000) {
  const espn = { getEditionTeams: vi.fn(async () => structuredClone(teams)), getUpcoming: vi.fn(async () => []), getNews: vi.fn(async () => []) };
  const reader = { getEditionTeams: vi.fn(async () => structuredClone(teams)), getUpcoming: vi.fn(async () => []), getNews: vi.fn(async () => []) };
  const events: ComparisonEvent[] = [];
  const sample = vi.fn(() => draw);
  const store = createSelectedDataStore({ source: 'compare', espn: espn as unknown as DataStore, reader: () => reader as unknown as DataStore,
    sample, onComparison: event => events.push(event), readerTimeoutMs });
  return { espn, reader, store, events, sample };
}

describe('sampled reader comparison', () => {
  it('makes zero reader calls at the 10% boundary, and excludes news', async () => {
    const s = setup(0.10);
    await s.store.getEditionTeams(rc);
    await s.store.getNews(rc, true);
    expect(s.sample).toHaveBeenCalledTimes(1);
    expect(s.reader.getEditionTeams).not.toHaveBeenCalled();
    expect(s.espn.getNews).toHaveBeenCalledWith(rc, true);
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'operation', cohort: 'control', served: 'espn' }));
  });

  it('starts both sources together, draws once for a join and serves the actual reader value on agreement', async () => {
    const s = setup(0.0999);
    let release!: () => void;
    s.espn.getEditionTeams.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return structuredClone(teams); });
    const operation = runDataOperation(s.store, async source => {
      const result = await source.getEditionTeams(rc);
      await source.getUpcoming(rc);
      return result;
    });
    await vi.waitFor(() => expect(s.reader.getEditionTeams).toHaveBeenCalledTimes(1));
    release();
    expect(await operation).toBe(await s.reader.getEditionTeams.mock.results[0].value);
    expect(s.sample).toHaveBeenCalledTimes(1);
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'reader' }));
  });

  it('returns the whole ESPN join on a mismatch and reuses the original ESPN answers', async () => {
    const s = setup();
    s.reader.getUpcoming.mockResolvedValueOnce([{ id: 'extra' }] as never[]);
    const result = await runDataOperation(s.store, async source => Promise.all([source.getEditionTeams(rc), source.getUpcoming(rc)]));
    expect(result[0]).toBe(await s.espn.getEditionTeams.mock.results[0].value);
    expect(result[1]).toEqual([]);
    expect(s.espn.getEditionTeams).toHaveBeenCalledTimes(1);
    expect(s.espn.getUpcoming).toHaveBeenCalledTimes(1);
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'read', endpoint: 'getUpcoming', outcome: 'mismatch' }));
  });

  it('reports reader status and uses ESPN even when the reader error ordinarily forbids fallback', async () => {
    const s = setup();
    s.reader.getEditionTeams.mockRejectedValue(new ReaderFailure('http', false, 400));
    expect(await s.store.getEditionTeams(rc)).toEqual(teams);
    expect(s.events).toContainEqual(expect.objectContaining({ outcome: 'reader_error', readerStatus: 400 }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'espn' }));
  });

  it('preserves the ESPN error and records both status codes when both sources fail', async () => {
    const s = setup();
    const error = new ReaderFailure('http', true, 503);
    s.espn.getEditionTeams.mockRejectedValue(error);
    s.reader.getEditionTeams.mockRejectedValue(new ReaderFailure('http', true, 429));
    await expect(s.store.getEditionTeams(rc)).rejects.toBe(error);
    expect(s.events).toContainEqual(expect.objectContaining({ outcome: 'inconclusive', espnStatus: 503, readerStatus: 429 }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'error' }));
  });

  it('keeps an ESPN failure when the reader succeeded and logs no raw error message', async () => {
    const s = setup();
    const error = Object.assign(new Error('private-url-and-body'), { status: 502 });
    s.espn.getEditionTeams.mockRejectedValue(error);
    await expect(s.store.getEditionTeams(rc)).rejects.toBe(error);
    expect(s.events).toContainEqual(expect.objectContaining({ outcome: 'inconclusive', espnStatus: 502 }));
    expect(JSON.stringify(s.events)).not.toContain(error.message);
  });

  it('routes ten of a hundred evenly spaced draws to both sources', async () => {
    const s = setup();
    for (let i = 0; i < 100; i++) {
      s.sample.mockReturnValueOnce((i + 0.5) / 100);
      await s.store.getEditionTeams(rc);
    }
    expect(s.reader.getEditionTeams).toHaveBeenCalledTimes(10);
    expect(s.espn.getEditionTeams).toHaveBeenCalledTimes(100);
    expect(s.events.filter(e => e.type === 'operation' && e.cohort === 'sample')).toHaveLength(10);
  });

  it('bounds a stuck reader and respects a pre-aborted caller', async () => {
    const s = setup(0, 20);
    s.reader.getEditionTeams.mockImplementation(() => new Promise(() => {}));
    expect(await s.store.getEditionTeams(rc)).toEqual(teams);
    expect(s.events).toContainEqual(expect.objectContaining({ outcome: 'reader_error', readerError: 'timeout' }));
    const abort = AbortSignal.abort();
    await expect(runDataOperation(s.store, source => source.getUpcoming(rc), abort)).rejects.toBe(abort.reason);
    expect(s.espn.getUpcoming).not.toHaveBeenCalled();
  });
});

it('records swallowed upstream errors by route and HTTP status without leaking an address or accepting the reader', async () => {
  const base = setup(1).espn as unknown as DataStore;
  const events: ComparisonEvent[] = [];
  const store = createSelectedDataStore({
    source: 'compare', sample: () => 0, espn: base, onComparison: event => events.push(event),
    fetch: async () => new Response(null, { status: 503 }),
    reader: ({ budget }) => ({ ...base, getEditionTeams: async () => {
      await budget.json('https://reader.example/v1/competitions/private-id/2026/identities?ids=private-id').catch(() => {});
      return structuredClone(teams);
    } }),
  });
  await store.getEditionTeams(rc);
  expect(events).toContainEqual(expect.objectContaining({ type: 'upstream_error', source: 'reader', endpoint: 'identities', code: 'http', status: 503 }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'read', endpoint: 'getEditionTeams', outcome: 'inconclusive' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'operation', served: 'espn', decision: 'inconclusive' }));
  expect(new Set(events.map(e => e.sampleId)).size).toBe(1);
  expect(events.every(e => e.policy === NORMALIZATION_VERSION)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private-id');
});


it('validates the configured percentage only in compare mode and zero constructs no reader', () => {
  const espn = setup().espn as unknown as DataStore;
  const configure = (source: string, percent: string) => configuredDataStore({ espn, fallback: () => espn,
    env: { SCOREARC_DATA_SOURCE: source, SCOREARC_READER_COMPARE_PERCENT: percent } });
  expect(configure('compare', '0')).toBe(espn);
  expect(configure('espn', 'invalid')).toBe(espn);
  for (const invalid of ['-1', '101', '10%', '', '0.5']) expect(() => configure('compare', invalid)).toThrow('SCOREARC_READER_COMPARE_PERCENT');
});
