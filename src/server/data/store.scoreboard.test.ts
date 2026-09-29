import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataStore } from './store';
import { resolveSeason } from './competitions';
import { TtlCache } from './cache';
import raw from './__fixtures__/espn-scoreboard.json';
import bracket from './__fixtures__/espn-bracket-2022.json';
import phase from './__fixtures__/leagues-cup-phase-2026.json';
import split from './__fixtures__/liga-mx-team-ids-2026.json';
import recorded from './__fixtures__/scoreboard-window-recorded.json';

const mx = resolveSeason('liga-mx')!;
function event(id: string, date: string) {
  return { ...structuredClone(raw.events[0]), id, date,
    season: { year: 2026, slug: 'torneo-apertura', type: 14277 } };
}
function provider(events: ReturnType<typeof event>[]) {
  const urls: string[] = [];
  return { urls, fetchJson: vi.fn(async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/summary')) return {};
    const month = u.searchParams.get('dates');
    if (!/^\d{6}$/.test(month ?? '')) throw new Error('Failed to get events endpoint.');
    return { leagues: [{ slug: 'mex.1' }], events: events.filter(e => e.date.replaceAll('-', '').startsWith(month!)) };
  }) };
}
afterEach(() => vi.useRealTimers());

describe('shared scoreboard windows', () => {
  it('preserves chronological enriched feeds when provider IDs are not chronological', async () => {
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url =>
      url.includes('/summary') ? {} : url.includes('dates=202606') ? raw : { ...raw, events: [] } });
    const matches = await store.getMatches(resolveSeason('world-cup', '2026')!, '20260629-20260630');
    expect(matches.map(m => m.id)).toEqual(['760487', '760489', '760488']);
    expect(matches.map(m => m.kickoff)).toEqual(raw.events.map(e => e.date));
  });

  it('restores exact calendar rows and enriches only the deduplicated requested window', async () => {
    const inside = event('inside', '2026-09-15T03:00Z');
    const p = provider([inside, structuredClone(inside), event('outside', '2026-09-20T03:00Z')]);
    const store = createDataStore({ ...p, cache: new TtlCache() });
    const matches = await store.getMatches(mx, '20260915-20260915');
    expect(matches.map(m => m.id)).toEqual(['inside']);
    expect(p.urls.filter(u => u.includes('/summary'))).toEqual([
      'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/summary?event=inside',
    ]);
    expect((await store.getFixtures(mx, '20260901-20260930')).map(m => m.id)).toEqual(['inside', 'outside']);
    expect(p.urls.filter(u => u.includes('/summary'))).toHaveLength(1);
  });

  it('retains separate live/calendar TTLs and does not cache a failed partition', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00Z'));
    const p = provider([event('live', '2026-09-15T03:00Z')]);
    const cache = new TtlCache(); const store = createDataStore({ ...p, cache });
    await store.getLiveWindow(mx);
    await store.getFixtures(mx, '20260901-20260930');
    const n = p.urls.length;
    await vi.advanceTimersByTimeAsync(16_000);
    await store.getLiveWindow(mx);
    expect(p.urls.length).toBe(n + 1);
    await store.getFixtures(mx, '20260901-20260930');
    expect(p.urls.length).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(105_000);
    p.fetchJson.mockRejectedValueOnce(new Error('partition failed'));
    await expect(store.getFixtures(mx, '20260901-20260930')).rejects.toThrow();
    expect(cache.get('liga-mx:2026-apertura:fixtures:20260901-20260930')).toBeUndefined();
    expect(await store.getFixtures(mx, '20260901-20260930')).toHaveLength(1);
  });

  it('repairs upcoming reads without summaries and caches each limit separately', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00Z'));
    const scheduled = [event('first', '2026-09-16T03:00Z'), event('second', '2026-09-18T03:00Z')];
    for (const e of scheduled) e.status.type = { ...e.status.type, state: 'pre', completed: false };
    const p = provider(scheduled); const store = createDataStore({ ...p, cache: new TtlCache() });
    expect((await store.getUpcoming(mx, 1)).map(m => m.id)).toEqual(['first']);
    expect((await store.getUpcoming(mx, 2)).map(m => m.id)).toEqual(['first', 'second']);
    const n = p.urls.length;
    await store.getUpcoming(mx, 1);
    expect(p.urls).toHaveLength(n);
    expect(p.urls.every(u => !u.includes('/summary'))).toBe(true);
  });

  it('preserves historical bracket rounds and provider IDs', async () => {
    const wc = resolveSeason('world-cup', '2022')!;
    const urls: string[] = [];
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => {
      urls.push(url);
      if (!url.includes('dates=202212&limit=1000')) throw new Error('broken selector');
      return bracket;
    } });
    const rounds = await store.getBracket(wc);
    expect(rounds.find(r => r.slug === 'final')!.matches[0].id).toBe('633850');
    expect(rounds.reduce((n, r) => n + r.matches.length, 0)).toBe(16);
    expect(urls).toHaveLength(1);
  });

  it('preserves historical bracket leaf order when provider IDs run backwards', async () => {
    const wc = resolveSeason('world-cup', '2010')!;
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url =>
      url.includes('dates=201006') ? recorded.samples['world-2010'] : { leagues: [{ slug: 'fifa.world' }], events: [] } });
    const rounds = await store.getBracket(wc);
    expect(rounds.find(r => r.slug === 'round-of-16')!.matches.map(m => m.id))
      .toEqual(['264109', '264108', '264111', '264110']);
  });

  it('repairs computed Leagues Cup tables through the same raw-event loader', async () => {
    const lc = resolveSeason('leagues-cup')!;
    const urls: string[] = [];
    const store = createDataStore({ cache: new TtlCache(), fetchJson: async url => {
      urls.push(url);
      if (url.endsWith('/teams')) return { sports: [{ leagues: [{ teams: split.map(id => ({ team: { id } })) }] }] };
      if (!url.includes('dates=202608&limit=1000')) throw new Error('broken selector');
      return phase;
    } });
    const tables = await store.getStandings(lc);
    expect(tables.map(g => g.id).sort()).toEqual(['liga-mx', 'mls']);
    expect(tables.flatMap(g => g.standings)).toHaveLength(36);
    expect(tables.flatMap(g => g.standings).every(row => row.played === 3)).toBe(true);
    expect(tables.find(g => g.id === 'liga-mx')!.standings.slice(0, 4).map(row => row.team.name).sort()).toEqual(['América', 'León', 'Monterrey', 'Toluca'].sort());
    expect(urls).toHaveLength(2);
  });
});

it('bounds summary enrichment concurrency after filtering', async () => {
  const p = provider(Array.from({ length: 9 }, (_, i) => event(String(i), '2026-09-15T03:00Z')));
  const base = p.fetchJson.getMockImplementation()!;
  let active = 0, peak = 0;
  p.fetchJson.mockImplementation(async url => {
    if (!url.includes('/summary')) return base(url);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return {};
  });
  const store = createDataStore({ ...p, cache: new TtlCache() });
  expect(await store.getMatches(mx, '20260915-20260915')).toHaveLength(9);
  expect(peak).toBeLessThanOrEqual(4);
});
