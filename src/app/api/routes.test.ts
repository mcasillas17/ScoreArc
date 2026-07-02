import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataStore } from '@/server/data/store';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

describe('competition-scoped + legacy routes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('GET /api/[comp]/matches resolves the competition', async () => {
    const spy = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const { GET } = await import('./[comp]/matches/route');
    const res = await GET(new Request('http://x/api/leagues-cup/matches'), { params: { comp: 'leagues-cup' } });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'leagues-cup' }));
  });

  it('GET /api/[comp]/matches 404s an unknown competition', async () => {
    const { GET } = await import('./[comp]/matches/route');
    const res = await GET(new Request('http://x/api/nope/matches'), { params: { comp: 'nope' } });
    expect(res.status).toBe(404);
  });

  it('legacy GET /api/matches still returns World Cup data', async () => {
    const spy = vi.spyOn(dataStore, 'getMatches').mockResolvedValueOnce([]);
    const { GET } = await import('./matches/route');
    await GET();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'world-cup-2026' }));
  });
});
