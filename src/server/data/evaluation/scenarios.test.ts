import { describe, expect, it, vi } from 'vitest';
import { runScenario } from './scenarios';
import { resolveSeason } from '../competitions';
import { createDataStore, type DataStore } from '../store';
import { TtlCache } from '../cache';
import { nowWindowRange, forwardRange } from '../dateRange';
import { createOfflineEvaluation } from '../../../../scripts/reader-evaluation-fixtures';
import { evaluate } from './evaluate';
import phase from '../__fixtures__/leagues-cup-phase-2026.json';

const rc = resolveSeason('world-cup', '2026')!;
const signal = new AbortController().signal;
const now = Date.parse('2026-08-15T12:00:00Z');

describe('bounded addressed navigation', () => {
  it('uses injected clock for both implicit ESPN method windows without changing defaults', async () => {
    const windows: string[] = [];
    const store = createDataStore({ cache: new TtlCache(), now: () => now, fetchJson: async url => {
      windows.push(new URL(url).searchParams.get('dates')!);
      return { leagues: [{ slug: 'fifa.world' }], events: [] };
    } });
    await store.getLiveWindow(rc); await store.getUpcoming(rc, 3);
    expect(windows).toContain(nowWindowRange(new Date(now)).slice(0, 6));
    expect(windows).toContain(forwardRange(new Date(now)).slice(0, 6));
    expect(windows.every(range => range.startsWith('2026'))).toBe(true);
  });
  it('does not replace an absent addressed event with a different event', async () => {
    const getMatchSummary = vi.fn();
    const store = { getFixtures: async () => [], getMatchSummary } as unknown as DataStore;
    const result = await runScenario(store, { competition: 'world-cup', season: '2026', kind: 'listPopup', range: '20260801-20260802', eventId: '123' }, rc, signal, now, 'reader');
    expect(result.issues).toEqual(['target_missing']); expect(getMatchSummary).not.toHaveBeenCalled();
  });
  it('bounds squad-index fan-out before creating any roster promise', async () => {
    const getSquad = vi.fn();
    const store = { getLeaders: async () => ({ scorers: [], assists: [] }),
      getStandings: async () => [{ standings: Array.from({ length: 65 }, (_, i) => ({ team: { id: String(i) } })) }], getSquad } as unknown as DataStore;
    await expect(runScenario(store, { competition: 'world-cup', season: '2026', kind: 'leaderLinks' }, rc, signal, now, 'reader')).rejects.toMatchObject({ reason: 'budget' });
    expect(getSquad).not.toHaveBeenCalled();
  });
});

describe('adapter-to-adapter regression evidence', () => {
  it('keeps genuine score and missing-match differences after identity normalization', async () => {
    const fixture = await createOfflineEvaluation();
    try {
      const fetcher: typeof fetch = async (input, init) => {
        const response = await fixture.fetch(input, init);
        if (String(input).startsWith(fixture.readerOrigin) && String(input).includes('/matches?')) {
          const body = await response.json();
          if (Array.isArray(body) && body.length > 1) { body[0].homeScore += 1; body.pop(); }
          return Response.json(body, { headers: response.headers });
        }
        return response;
      };
      const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher, manifest: { version: 1, samples: [fixture.manifest.samples[0]] } });
      expect(result.counts.matched).toBe(0);
      expect(result.samples[0].categories).toContain('score');
      expect(result.samples[0].categories).toContain('coverage');
    } finally { await fixture.close(); }
  });
  it('records swallowed ESPN summary failures instead of a successful empty detail comparison', async () => {
    const fixture = await createOfflineEvaluation();
    try {
      const fetcher: typeof fetch = async (input, init) => String(input).includes('espn.com') && String(input).includes('/summary?')
        ? new Response('private raw dependency failure', { status: 503 }) : fixture.fetch(input, init);
      const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher, manifest: { version: 1, samples: [fixture.manifest.samples[1]] } });
      expect(result.samples[0].espn.failure).toBeNull();
      expect(result.samples[0].categories).toContain('http');
      expect(result.counts.error).toBe(1); expect(result.counts.matched).toBe(0);
      expect(JSON.stringify(result)).not.toContain('private raw');
    } finally { await fixture.close(); }
  });
  it('retains live score-race differences and timing skew without blessing a match', async () => {
    const fixture = await createOfflineEvaluation();
    try {
      const fetcher: typeof fetch = async (input, init) => {
        const response = await fixture.fetch(input, init);
        if (String(input).startsWith(fixture.readerOrigin) && String(input).includes('/matches?')) {
          const body = await response.json();
          if (Array.isArray(body) && body.length) { body[0].state = 'live'; body[0].winnerId = null; body[0].homeScore += 1; }
          const headers = new Headers(response.headers);
          const evidence = JSON.parse(headers.get('X-ScoreArc-Resources')!);
          evidence.resources.matches.observedAt = new Date(fixture.now() - 10_000).toISOString();
          headers.set('X-ScoreArc-Resources', JSON.stringify(evidence));
          return Response.json(body, { headers });
        }
        return response;
      };
      const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher, manifest: { version: 1, samples: [fixture.manifest.samples[0]] } });
      expect(result.samples[0].categories).toEqual(expect.arrayContaining(['live_race', 'timing_skew', 'score']));
      expect(result.counts.unavailable).toBe(1); expect(result.counts.matched).toBe(0);
    } finally { await fixture.close(); }
  });
});

it('keeps call/concurrency/report bounds across parallel index reads and exhausted samples', async () => {
  const fixture = await createOfflineEvaluation();
  let activeReader = 0, activeESPN = 0, peakReader = 0, peakESPN = 0;
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const reader = String(input).startsWith(fixture.readerOrigin);
      if (reader) peakReader = Math.max(peakReader, ++activeReader); else peakESPN = Math.max(peakESPN, ++activeESPN);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await fixture.fetch(input, init); }
      finally { if (reader) activeReader--; else activeESPN--; }
    };
    const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher,
      manifest: { version: 1, samples: Array(32).fill({ competition: 'world-cup', season: '2026', kind: 'leaderLinks' }) } });
    expect(result.counts.attempted).toBe(32);
    expect(result.costs.reader.calls).toBeLessThanOrEqual(128); expect(result.costs.espn.calls).toBeLessThanOrEqual(128);
    expect(peakReader).toBeLessThanOrEqual(4); expect(peakESPN).toBeLessThanOrEqual(4);
    expect(result.samples.some(sample => sample.categories.includes('budget'))).toBe(true);
    expect(result.samples.reduce((sum, sample) => sum + sample.reader.requests.length, 0)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
    expect(result.counts.matched + result.counts.mismatched + result.counts.unavailable + result.counts.error).toBe(32);
  } finally { await fixture.close(); }
});

it('flags a provider summary for the wrong event instead of comparing its plausible fields', async () => {
  const fixture = await createOfflineEvaluation();
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).includes('espn.com') && String(input).includes('/summary?')) {
        const body = await response.json(); body.header.id = '999999';
        return Response.json(body);
      }
      return response;
    };
    const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher,
      manifest: { version: 1, samples: [fixture.manifest.samples.find(sample => sample.kind === 'getMatchSummary')] } });
    expect(result.samples[0].categories).toEqual(expect.arrayContaining(['scope_mismatch', 'entity']));
    expect(result.counts.matched).toBe(0);
  } finally { await fixture.close(); }
});

it('does not mistake identity subrequests for mismatched implicit windows', async () => {
  const fixture = await createOfflineEvaluation();
  try {
    const result = await evaluate({ ...fixture, enabled: true, offline: true,
      manifest: { version: 1, samples: [fixture.manifest.samples.find(sample => sample.kind === 'getLiveWindow')] } });
    expect(result.samples[0].reader.failure).toBeNull();
    expect(result.counts.matched).toBe(1);
  } finally { await fixture.close(); }
});

it('rejects summary side contradictions on joined navigation as well as direct summaries', async () => {
  const fixture = await createOfflineEvaluation();
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).includes('espn.com') && String(input).includes('/summary?')) {
        return Response.json({ header: { id: new URL(String(input)).searchParams.get('event'), league: { slug: 'concacaf.leagues.cup' }, season: { year: 2026 },
          competitions: [{ competitors: [{ id: '999', homeAway: 'home' }, { id: '888', homeAway: 'away' }] }] } });
      }
      return response;
    };
    const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher,
      manifest: { version: 1, samples: [fixture.manifest.samples.find(sample => sample.kind === 'listPopup')] } });
    expect(result.samples[0].categories).toEqual(expect.arrayContaining(['scope_mismatch', 'side']));
    expect(result.counts.matched).toBe(0);
  } finally { await fixture.close(); }
});

it('rejects contradictory bulk summary sides even when empty mapped detail agrees', async () => {
  const fixture = await createOfflineEvaluation();
  try {
    for (const wrong of [null, 'id', 'team']) {
      const fetcher: typeof fetch = async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (url.hostname.endsWith('espn.com') && url.pathname.endsWith('/summary')) {
          const event = phase.events.find(event => event.id === url.searchParams.get('event'))!;
          return Response.json({ header: { id: event.id, league: { slug: 'concacaf.leagues.cup' }, season: { year: 2026 },
            competitions: [{ status: event.status, competitors: event.competitions[0].competitors.map(side => ({
              ...side, id: wrong === 'id' ? side.homeAway === 'home' ? '999' : '888' : side.team.id,
              team: wrong === 'team' ? { ...side.team, id: '999' } : side.team,
            })) }] } });
        }
        if (url.origin === fixture.readerOrigin && url.pathname.endsWith('/matches')) {
          const headers = new Headers(response.headers);
          const resources = JSON.parse(headers.get('X-ScoreArc-Resources')!);
          for (const [name, resource] of Object.entries(resources.resources)) if (name !== 'identity') Object.assign(resource as object, { status: 'fresh', availability: 'complete', observedAt: new Date(now).toISOString() });
          headers.set('X-ScoreArc-Resources', JSON.stringify(resources));
          return new Response(response.body, { headers });
        }
        return response;
      };
      const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher,
        manifest: { version: 1, samples: [fixture.manifest.samples.find(sample => sample.kind === 'getMatches')] } });
      expect(result.counts.matched).toBe(wrong ? 0 : 1);
      if (wrong) expect(result.samples[0].categories).toEqual(expect.arrayContaining(['scope_mismatch', 'side']));
    }
  } finally { await fixture.close(); }
});

it.each(['live', 'unknown'])('keeps direct summary lifecycle %s inconclusive even when all detail values agree', async lifecycle => {
  const fixture = await createOfflineEvaluation();
  const empty = { scorers: [], cards: [], stats: null, winProbability: null, lineups: null, videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [] };
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fixture.fetch(input, init);
      const url = new URL(String(input));
      if (url.hostname.endsWith('espn.com') && url.pathname.endsWith('/summary')) return Response.json({ header: {
        id: '760490', league: { slug: 'fifa.world' }, season: { year: 2026 }, competitions: [{
          ...(lifecycle === 'live' ? { status: { type: { state: 'in', completed: false } } } : {}),
          competitors: [{ id: '4789', homeAway: 'home' }, { id: '464', homeAway: 'away' }],
        }],
      } });
      if (url.origin === fixture.readerOrigin && url.pathname.startsWith('/v1/matches/')) {
        const headers = new Headers(response.headers);
        const resources = JSON.parse(headers.get('X-ScoreArc-Resources')!);
        for (const [name, resource] of Object.entries(resources.resources)) if (name !== 'identity') Object.assign(resource as object, { status: 'fresh', availability: 'complete', observedAt: new Date(now - 10_000).toISOString() });
        headers.set('X-ScoreArc-Resources', JSON.stringify(resources));
        return Response.json(empty, { headers });
      }
      return response;
    };
    const result = await evaluate({ ...fixture, enabled: true, offline: true, fetch: fetcher,
      manifest: { version: 1, samples: [fixture.manifest.samples.find(sample => sample.kind === 'getMatchSummary')] } });
    expect(result.samples[0].differences).toEqual([]);
    expect(result.counts).toMatchObject({ attempted: 1, matched: 0, unavailable: 1 });
    expect(result.samples[0].categories).toEqual(expect.arrayContaining(lifecycle === 'live' ? ['observation_unknown', 'timing_skew'] : ['lifecycle_unknown']));
  } finally { await fixture.close(); }
});
