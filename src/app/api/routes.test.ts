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
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('matches', 404);
  });

  it('GET /api/[comp]/[season]/matches 404s an unknown season', async () => {
    const { GET } = await import('./[comp]/[season]/matches/route');
    const res = await GET(new Request('http://x/api/world-cup/1999/matches'), {
      params: { comp: 'world-cup', season: '1999' },
    });
    expect(res.status).toBe(404);
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('matches', 404);
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
