import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate, EVALUATION_LIMITS, parseManifest } from './evaluate';
import { configuredDataStore } from '../configuredStore';
import { createDataStore } from '../store';
import { TtlCache } from '../cache';
import type { ReaderResources } from '@/lib/readerResources';

const clock = Date.parse('2026-08-10T12:00:00Z');
const sample = { competition: 'world-cup', season: '2026', kind: 'getFixtures', range: '20260801-20260802' };
const manifest = { version: 1, samples: [sample] };
const origin = 'http://127.0.0.1:4399';
function evidence(status = 'empty', availability = 'empty'): ReaderResources {
  return { version: 1, resources: {
    matches: { status, availability, source: 'espn', derivation: 'direct', scope: 'selection', observedAt: new Date(clock).toISOString(), finalizedAt: null },
    identity: { status: 'unavailable', availability: 'partial', source: 'mixed', derivation: 'mixed', scope: 'competition-season', observedAt: null, finalizedAt: null },
  } } as ReaderResources;
}
function reader(body: unknown = [], resources = evidence()) {
  return Response.json(body, { headers: {
    'X-ScoreArc-Resources': JSON.stringify(resources), 'X-ScoreArc-Freshness': (resources.resources.matches ?? resources.resources.bracket)!.status,
    'X-ScoreArc-Poll-Status': 'ok', 'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0',
    'X-ScoreArc-Observed-At': new Date(clock).toISOString(),
  } });
}
const espn = () => Response.json({ leagues: [{ slug: 'fifa.world' }], events: [] });
const options = { enabled: true, manifest, readerOrigin: origin, now: () => clock, offline: true };
afterEach(() => vi.useRealTimers());

describe('explicit reader evaluation', () => {
  it('is disabled before manifest validation, factories, fetch or health checks', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await evaluate({ manifest: 'invalid', readerOrigin: 'secret', fetch: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(result.counts.attempted).toBe(0);
  });
  it('reader failure cannot be reported as ESPN matching ESPN after fallback', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).startsWith(origin) ? new Response('secret SQL credential', { status: 500 }) : espn());
    const result = await evaluate({ ...options, fetch: fetcher });
    expect(result.counts).toMatchObject({ attempted: 1, comparable: 0, matched: 0, mismatched: 0, error: 1 });
    expect(result.samples[0].reader.failure).toBe('http');
    expect(result.samples[0].espn.failure).toBeNull();
    // The scoreboard window includes its adjacent-month boundary partition.
    expect(result.samples[0].espn.calls).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/secret|SQL|credential/);
  });
  it('compares complete empty windows and reports each source cost and clock without inventing ESPN observation', async () => {
    const result = await evaluate({ ...options, fetch: async url => String(url).startsWith(origin) ? reader() : espn() });
    expect(result.counts).toMatchObject({ attempted: 1, comparable: 1, matched: 1 });
    expect(result.samples[0].reader.calls).toBe(1);
    expect(result.samples[0].reader.bytes).toBeGreaterThan(0);
    expect(result.samples[0].espn.requests[0].observedAt).toBeNull();
    expect(result.samples[0].reader.requests[0].resources?.resources.matches?.availability).toBe('empty');
    expect(result.notSampled.methods).toContain('getPlayer');
    expect(result.excluded).toContain('getNews');
  });
  it.each([
    ['stale', 'empty', 'stale'], ['dormant', 'partial', 'partial'], ['unavailable', 'unavailable', 'unavailable'],
  ])('retains %s/%s attempts as unavailable', async (status, availability, category) => {
    const result = await evaluate({ ...options, fetch: async url => String(url).startsWith(origin) ? reader([], evidence(status, availability)) : espn() });
    expect(result.counts.unavailable).toBe(1);
    expect(result.counts.matched).toBe(0);
    expect(result.samples[0].categories).toContain(category);
  });
  it('allows dormant complete-empty with observation evidence, never dormant as a blanket pass', async () => {
    const result = await evaluate({ ...options, fetch: async url => String(url).startsWith(origin) ? reader([], evidence('dormant', 'empty')) : espn() });
    expect(result.counts.matched).toBe(1);
  });
  it('rejects malformed, news, oversize and unbounded manifest input before I/O', async () => {
    for (const value of [null, { version: 1, samples: [{ ...sample, kind: 'getNews' }] }, { version: 1, samples: Array(33).fill(sample) }, { version: 1, samples: [{ ...sample, range: '20260101-20261231' }] }, { version: 1, samples: [{ ...sample, url: 'https://secret' }] }]) {
      expect(() => parseManifest(value)).toThrow('Invalid evaluation manifest');
    }
  });
  it('keeps unsupported historical current-only scopes in attempted denominator without requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await evaluate({ ...options, manifest: { version: 1, samples: [{ competition: 'world-cup', season: '2022', kind: 'getStandings' }] }, fetch: fetcher });
    expect(result.counts).toMatchObject({ attempted: 1, unavailable: 1, matched: 0 });
    expect(result.samples[0].categories).toContain('unsupported_scope');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('records cancellation for every planned attempt and starts no cancelled reads', async () => {
    const controller = new AbortController(); controller.abort(new Error('credential secret'));
    const fetcher = vi.fn<typeof fetch>();
    const result = await evaluate({ ...options, signal: controller.signal, manifest: { version: 1, samples: [sample, sample] }, fetch: fetcher });
    expect(result.counts).toMatchObject({ attempted: 2, unavailable: 2, matched: 0 });
    expect(result.samples.every(s => s.categories.includes('cancelled'))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('bounds response streaming and reports oversized responses as budget errors', async () => {
    const result = await evaluate({ ...options, fetch: async url => String(url).startsWith(origin)
      ? new Response('[]', { headers: { 'content-length': String(EVALUATION_LIMITS.maxResponseBytes + 1) } }) : espn() });
    expect(result.samples[0].reader.failure).toBe('budget');
    expect(result.counts.error).toBe(1);
  });
  it('aborts a stalled body at the side deadline and cancels its stream', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = evaluate({ ...options, fetch: async url => String(url).startsWith(origin)
      ? new Response(new ReadableStream({ cancel })) : espn() });
    await vi.advanceTimersByTimeAsync(EVALUATION_LIMITS.sampleMs + 1);
    const result = await pending;
    expect(result.samples[0].reader.failure).toBe('timeout');
    expect(cancel).toHaveBeenCalled();
    expect(result.counts.matched).toBe(0);
  });
  it('does not alter the default store identity or primary ESPN responses', async () => {
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async () => ({ leagues: [{ slug: 'fifa.world' }], events: [] }) });
    const fallback = vi.fn(() => store);
    expect(configuredDataStore({ espn: store, fallback, env: {} })).toBe(store);
    await evaluate({ ...options, fetch: async () => new Response('', { status: 503 }) });
    expect(configuredDataStore({ espn: store, fallback, env: {} })).toBe(store);
    expect(fallback).not.toHaveBeenCalled();
  });
});

it('does not silently accept unscoped current-only provider responses, including in offline evidence', async () => {
  const boardEvidence: ReaderResources = { version: 1, resources: {
    leaders: { status: 'empty', availability: 'empty', source: 'espn', derivation: 'direct', scope: 'competition-season', observedAt: new Date(clock).toISOString(), finalizedAt: null },
    identity: { ...evidence().resources.identity!, scope: 'competition-season' },
  } };
  const result = await evaluate({ ...options, manifest: { version: 1, samples: [{ competition: 'world-cup', season: '2026', kind: 'getLeaders' }] }, fetch: async url => String(url).startsWith(origin)
    ? Response.json([], { headers: { 'X-ScoreArc-Resources': JSON.stringify(boardEvidence) } }) : Response.json({ stats: [] }) });
  expect(result.samples[0].categories).toContain('scope_unverified');
  expect(result.counts.matched).toBe(0);
  expect(result.counts.unavailable).toBe(1);
});

it('records run-time exhaustion for unstarted samples instead of dropping denominator', async () => {
  vi.useFakeTimers();
  const pending = evaluate({ ...options, manifest: { version: 1, samples: Array(32).fill(sample) }, fetch: async () => new Response(new ReadableStream({ start() {} })) });
  await vi.advanceTimersByTimeAsync(EVALUATION_LIMITS.runtimeMs + 1);
  const result = await pending;
  expect(result.counts.attempted).toBe(32);
  expect(result.samples.at(-1)?.categories).toContain('timeout');
  expect(result.samples.at(-1)?.reader.calls).toBe(0);
  expect(result.counts.matched).toBe(0);
});

it('stops aggregate body consumption and keeps all budget failures visible', async () => {
  const padded = `[]${' '.repeat(2 * 1024 * 1024)}`;
  const headers = reader().headers;
  const result = await evaluate({ ...options, manifest: { version: 1, samples: Array(20).fill(sample) }, fetch: async url => String(url).startsWith(origin)
    ? new Response(padded, { headers }) : espn() });
  expect(result.counts.attempted).toBe(20);
  expect(result.counts.error).toBeGreaterThan(0);
  expect(result.samples.at(-1)?.categories).toContain('budget');
  expect(result.costs.reader.calls).toBeLessThanOrEqual(17);
});

it('checks resource freshness at response time, not a frozen earlier request time', async () => {
  let time = clock;
  const result = await evaluate({ ...options, now: () => time, fetch: async url => {
    if (!String(url).startsWith(origin)) return espn();
    time += 1000;
    const resources = evidence(); resources.resources.matches!.observedAt = new Date(time).toISOString();
    return reader([], resources);
  } });
  expect(result.counts.matched).toBe(1);
  expect(result.samples[0].reader.failure).toBeNull();
});

it('ages optional squad statistics through the existing policy before deciding parity', async () => {
  const rosterEvidence: ReaderResources = { version: 1, resources: {
    squad: { status: 'empty', availability: 'empty', source: 'espn', derivation: 'current-roster', scope: 'team-season', observedAt: new Date(clock).toISOString(), finalizedAt: null },
    seasonStats: { status: 'fresh', availability: 'complete', source: 'espn', derivation: 'direct', scope: 'team-season', observedAt: new Date(clock - 26 * 3_600_000).toISOString(), finalizedAt: null },
    identity: { ...evidence().resources.identity!, scope: 'team-season' },
  } };
  const result = await evaluate({ ...options, manifest: { version: 1, samples: [{ competition: 'world-cup', season: '2026', kind: 'getSquad', teamId: '202' }] }, fetch: async url => String(url).startsWith(origin)
    ? Response.json([], { headers: { 'X-ScoreArc-Resources': JSON.stringify(rosterEvidence) } }) : Response.json({ athletes: [], season: { year: 2026 } }) });
  expect(result.samples[0].categories).toContain('stale');
  expect(result.samples[0].reader.requests[0].resources?.resources.seasonStats?.status).toBe('stale');
  expect(result.counts).toMatchObject({ attempted: 1, comparable: 0, matched: 0, unavailable: 1 });
});

it.each([['2025', 'scope_mismatch'], [null, 'scope_unverified']])('does not accept undated bracket scoreboard season %s', async (year, category) => {
  const resources: ReaderResources = { version: 1, resources: {
    bracket: { ...evidence().resources.matches!, scope: 'competition-season', derivation: 'derived' },
    identity: { ...evidence().resources.identity! },
  } };
  const result = await evaluate({ ...options, manifest: { version: 1, samples: [{ competition: 'leagues-cup', season: '2026', kind: 'getBracket' }] }, fetch: async url => String(url).startsWith(origin)
    ? reader([], resources) : Response.json({ leagues: [{ slug: 'concacaf.leagues.cup' }], ...(year ? { season: { year: Number(year) } } : {}), events: [] }) });
  expect(result.samples[0].categories).toContain(category);
  expect(result.counts).toMatchObject({ attempted: 1, matched: 0, unavailable: 1 });
});

it.each(['getBracket', 'getSquad', 'getLeaders'])('requires explicit provider collections for %s empty parity', async kind => {
  const resource = (derivation: string, scope: string) => ({ ...evidence().resources.matches!, derivation, scope });
  const resources = { version: 1, resources: { identity: { ...evidence().resources.identity, scope: kind === 'getSquad' ? 'team-season' : 'competition-season' },
    ...(kind === 'getBracket' ? { bracket: resource('derived', 'competition-season') }
      : kind === 'getSquad' ? { squad: resource('current-roster', 'team-season'), seasonStats: resource('direct', 'team-season') }
        : { leaders: resource('direct', 'competition-season') }) } };
  const field = kind === 'getBracket' ? 'events' : kind === 'getSquad' ? 'athletes' : 'stats';
  const empty = kind === 'getLeaders' ? [{ name: 'goalsLeaders', leaders: [] }, { name: 'assistsLeaders', leaders: [] }] : [];
  const malformedStats = [{ id: '123', displayName: 'Player', statistics: { splits: { categories: {} } } }];
  for (const collection of [undefined, null, {}, [{}], ...(kind === 'getSquad' ? [malformedStats] : []), empty]) {
    const result = await evaluate({ ...options, manifest: { version: 1, samples: [{ competition: 'leagues-cup', season: '2026', kind, ...(kind === 'getSquad' ? { teamId: '218' } : {}) }] },
      fetch: async url => String(url).startsWith(origin)
        ? kind === 'getBracket' ? reader([], resources as ReaderResources) : Response.json([], { headers: { 'X-ScoreArc-Resources': JSON.stringify(resources) } })
        : Response.json({ season: { year: 2026 }, leagues: [{ slug: 'concacaf.leagues.cup' }], [field]: collection }) });
    if (collection === empty) expect(result.counts.matched).toBe(1);
    else {
      expect(result.counts.matched).toBe(0);
      expect(result.samples[0].categories).toContain(kind === 'getLeaders' && Array.isArray(collection) ? 'partial' : 'body');
    }
  }
});

it('rejects incomplete undated bracket pagination instead of matching an empty reader bracket', async () => {
  const resources: ReaderResources = { version: 1, resources: {
    bracket: { ...evidence().resources.matches!, scope: 'competition-season', derivation: 'derived' }, identity: evidence().resources.identity,
  } };
  const result = await evaluate({ ...options, manifest: { version: 1, samples: [{ competition: 'leagues-cup', season: '2026', kind: 'getBracket' }] }, fetch: async url => String(url).startsWith(origin)
    ? reader([], resources) : Response.json({ leagues: [{ slug: 'concacaf.leagues.cup' }], season: { year: 2026 }, events: [], count: 1, total: 1, pageCount: 2 }) });
  expect(result.counts).toMatchObject({ attempted: 1, matched: 0, error: 1 });
  expect(result.samples[0].categories).toContain('body');
});

it('keeps malformed dated scoreboard events as dependency errors through the existing window validator', async () => {
  const result = await evaluate({ ...options, fetch: async url => String(url).startsWith(origin) ? reader()
    : Response.json({ leagues: [{ slug: 'fifa.world' }], events: [{}] }) });
  expect(result.counts).toMatchObject({ attempted: 1, matched: 0, error: 1 });
  expect(result.samples[0].categories).toContain('dependency');
});
