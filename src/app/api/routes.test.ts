import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataStore } from '@/server/data/store';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));

describe('competition/season-scoped routes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('GET /api/[comp]/[season]/matches resolves the competition + season', async () => {
    const spy = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/[season]/matches/route');
    const res = await GET(new Request('http://x/api/leagues-cup/2026/matches'), {
      params: { comp: 'leagues-cup', season: '2026' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        competition: expect.objectContaining({ id: 'leagues-cup' }),
        season: expect.objectContaining({ id: '2026' }),
      }),
    );
  });

  it('GET /api/[comp]/[season]/matches 404s an unknown competition', async () => {
    const { GET } = await import('./[comp]/[season]/matches/route');
    const res = await GET(new Request('http://x/api/nope/2026/matches'), {
      params: { comp: 'nope', season: '2026' },
    });
    expect(res.status).toBe(404);
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('GET /api/[comp]/[season]/matches 404s an unknown season', async () => {
    const { GET } = await import('./[comp]/[season]/matches/route');
    const res = await GET(new Request('http://x/api/world-cup/1999/matches'), {
      params: { comp: 'world-cup', season: '1999' },
    });
    expect(res.status).toBe(404);
    expect(trackAPIRequestFailure).not.toHaveBeenCalled();
  });

  it('GET /api/[comp]/[season]/matches tracks an upstream failure', async () => {
    vi.spyOn(dataStore, 'getMatches').mockRejectedValueOnce(new Error('upstream unavailable'));
    const { GET } = await import('./[comp]/[season]/matches/route');
    const res = await GET(new Request('http://x/api/world-cup/2026/matches'), {
      params: { comp: 'world-cup', season: '2026' },
    });

    expect(res.status).toBe(502);
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('matches', 502, 'world-cup', '2026');
  });
});

describe('GET /api/[comp]/[season]/fixtures', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('400s on a malformed range without calling the provider', async () => {
    const provider = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/[season]/fixtures/route');
    const res = await GET(new Request('http://x/?range=2026-08-01'), {
      params: { comp: 'liga-mx', season: '2026-apertura' },
    });
    expect(res.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('400s on a reversed range without calling the provider', async () => {
    const provider = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/[season]/fixtures/route');
    const res = await GET(new Request('http://x/?range=20260831-20260801'), {
      params: { comp: 'liga-mx', season: '2026-apertura' },
    });
    expect(res.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('400s on a range beyond the span cap without calling the provider', async () => {
    const provider = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/[season]/fixtures/route');
    const res = await GET(new Request('http://x/?range=20260101-20261231'), {
      params: { comp: 'liga-mx', season: '2026-apertura' },
    });
    expect(res.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('404s on an unknown competition without calling the provider', async () => {
    const provider = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/[season]/fixtures/route');
    const res = await GET(new Request('http://x/?range=20260801-20260831'), {
      params: { comp: 'nope', season: '2026-27' },
    });
    expect(res.status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });

  it('passes a validated range to the fixtures store', async () => {
    const provider = vi.spyOn(dataStore, 'getFixtures').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/[season]/fixtures/route');
    const res = await GET(new Request('http://x/?range=20260801-20260831'), {
      params: { comp: 'liga-mx', season: '2026-apertura' },
    });
    expect(res.status).toBe(200);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        competition: expect.objectContaining({ id: 'liga-mx' }),
        season: expect.objectContaining({ id: '2026-apertura' }),
      }),
      '20260801-20260831',
    );
  });

  it('tracks an upstream failure', async () => {
    vi.spyOn(dataStore, 'getFixtures').mockRejectedValueOnce(new Error('upstream unavailable'));
    const { GET } = await import('./[comp]/[season]/fixtures/route');
    const res = await GET(new Request('http://x/?range=20260801-20260831'), {
      params: { comp: 'world-cup', season: '2026' },
    });
    expect(res.status).toBe(502);
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('fixtures', 502, 'world-cup', '2026');
  });
});
