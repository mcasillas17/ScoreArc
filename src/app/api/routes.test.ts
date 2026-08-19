import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dataStore, currentWeekRange } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));

const route = () => import('./[comp]/[season]/matches/route');
const wc = { comp: 'world-cup', season: '2026' };
const mx = { comp: 'liga-mx', season: '2026-apertura' };
const get = async (query: string, params = mx) =>
  (await route()).GET(new Request(`http://x/api/matches${query}`), { params });

describe('competition/season resolution', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves the competition + season', async () => {
    const spy = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const res = await get('', { comp: 'leagues-cup', season: '2026' });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        competition: expect.objectContaining({ id: 'leagues-cup' }),
        season: expect.objectContaining({ id: '2026' }),
      }),
      expect.any(String),
    );
  });

  it('404s an unknown competition', async () => {
    const res = await get('', { comp: 'nope', season: '2026' });
    expect(res.status).toBe(404);
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('404s an unknown season', async () => {
    const res = await get('', { comp: 'world-cup', season: '1999' });
    expect(res.status).toBe(404);
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('tracks an upstream failure', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValueOnce(new Error('upstream unavailable'));
    const res = await get('', wc);
    expect(res.status).toBe(502);
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('matches', 502, 'world-cup', '2026');
  });
});

// This endpoint replaced three that differed only by hidden defaults. Each
// case below pins one of those defaults to an explicit parameter, so a future
// refactor cannot quietly re-merge them.
describe('GET /api/[comp]/[season]/matches — window selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('defaults to the current week, unenriched', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const enriched = vi.spyOn(dataStore, 'getMatches');
    const res = await get('');
    expect(res.status).toBe(200);
    expect(fixtures).toHaveBeenCalledWith(expect.anything(), currentWeekRange(new Date()));
    expect(enriched).not.toHaveBeenCalled();
  });

  // detail=summary is the old /matches route: one upstream request per match.
  it('uses the enriching store method only for detail=summary', async () => {
    const enriched = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const fixtures = vi.spyOn(dataStore, 'getFixtures');
    const res = await get('?detail=summary');
    expect(res.status).toBe(200);
    expect(enriched).toHaveBeenCalledWith(expect.anything(), currentWeekRange(new Date()));
    expect(fixtures).not.toHaveBeenCalled();
  });

  it('passes a validated range through', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const res = await get('?range=20260801-20260831');
    expect(res.status).toBe(200);
    expect(fixtures).toHaveBeenCalledWith(
      expect.objectContaining({ competition: expect.objectContaining({ id: 'liga-mx' }) }),
      '20260801-20260831',
    );
  });

  // state=scheduled with no range is the old /upcoming route: the forward
  // feed, deliberately NOT the current week, which is empty most days.
  it('uses the forward feed for state=scheduled without a range', async () => {
    const upcoming = vi.spyOn(dataStore, 'getUpcoming').mockResolvedValueOnce([]);
    const fixtures = vi.spyOn(dataStore, 'getFixtures');
    const res = await get('?state=scheduled&limit=12');
    expect(res.status).toBe(200);
    expect(upcoming).toHaveBeenCalledWith(expect.anything(), 12);
    expect(fixtures).not.toHaveBeenCalled();
  });

  it('filters within the window when state=scheduled is combined with a range', async () => {
    const rows = [
      { id: '1', state: 'scheduled' },
      { id: '2', state: 'post' },
      { id: '3', state: 'scheduled' },
    ] as never[];
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce(rows);
    const upcoming = vi.spyOn(dataStore, 'getUpcoming');
    const res = await get('?range=20260801-20260831&state=scheduled');
    expect(await res.json()).toEqual([{ id: '1', state: 'scheduled' }, { id: '3', state: 'scheduled' }]);
    expect(upcoming).not.toHaveBeenCalled();
  });

  it('applies limit to a windowed read', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }] as never[]);
    const res = await get('?range=20260801-20260831&limit=2');
    expect(await res.json()).toHaveLength(2);
  });
});

// The range is interpolated into a URL called against a third-party API, so a
// bad parameter must stop before the provider is touched.
describe('GET /api/[comp]/[season]/matches — rejected input', () => {
  beforeEach(() => vi.restoreAllMocks());

  const bad = [
    ['a malformed range', '?range=2026-08-01'],
    ['a reversed range', '?range=20260831-20260801'],
    ['a range beyond the span cap', '?range=20260101-20261231'],
    ['an unknown state', '?state=finished'],
    ['an unknown detail level', '?detail=everything'],
    ['an enriched window beyond the summary cap', '?range=20260801-20260901&detail=summary'],
    ['a non-numeric limit', '?limit=abc'],
    ['a limit out of range', '?limit=0'],
  ] as const;

  for (const [name, query] of bad) {
    it(`400s on ${name} without calling the provider`, async () => {
      const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
      const enriched = vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
      const upcoming = vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(fixtures).not.toHaveBeenCalled();
      expect(enriched).not.toHaveBeenCalled();
      expect(upcoming).not.toHaveBeenCalled();
    });
  }

  it('404s an unknown competition before validating anything', async () => {
    const fixtures = vi.spyOn(dataStore, 'getFixtures').mockResolvedValue([]);
    const res = await get('?range=20260801-20260831', { comp: 'nope', season: '2026-27' });
    expect(res.status).toBe(404);
    expect(fixtures).not.toHaveBeenCalled();
  });
});
