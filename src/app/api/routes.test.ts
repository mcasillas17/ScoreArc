import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataService } from '@/server/data/service';

vi.mock('@/server/data/service', () => ({
  dataService: {
    getGroups: vi.fn(),
    getMatches: vi.fn(),
    getMatchSummary: vi.fn(),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('api routes', () => {
  it('GET /api/groups returns groups json', async () => {
    vi.mocked(dataService.getGroups).mockResolvedValueOnce([{ id: 'A', name: 'Group A', standings: [] }]);
    const { GET } = await import('./groups/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].id).toBe('A');
  });

  it('GET /api/matches returns matches json', async () => {
    vi.mocked(dataService.getMatches).mockResolvedValueOnce([{ id: '1' } as any]);
    const { GET } = await import('./matches/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].id).toBe('1');
  });

  it('GET /api/groups returns 502 on upstream error', async () => {
    vi.mocked(dataService.getGroups).mockRejectedValueOnce(new Error('upstream down'));
    const { GET } = await import('./groups/route');
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('GET /api/matches returns 502 on upstream error', async () => {
    vi.mocked(dataService.getMatches).mockRejectedValueOnce(new Error('upstream down'));
    const { GET } = await import('./matches/route');
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('GET /api/match/[id] returns summary json', async () => {
    const fakeSummary = { scorers: [], cards: [], stats: null, winProbability: null };
    vi.mocked(dataService.getMatchSummary).mockResolvedValueOnce(fakeSummary);
    const { GET } = await import('./match/[id]/route');
    const req = new Request('http://localhost/api/match/evt123?home=h1&away=a1');
    const res = await GET(req, { params: { id: 'evt123' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scorers).toBeDefined();
    expect(dataService.getMatchSummary).toHaveBeenCalledWith('evt123', 'h1', 'a1');
  });

  it('GET /api/match/[id] returns 502 on upstream error', async () => {
    vi.mocked(dataService.getMatchSummary).mockRejectedValueOnce(new Error('upstream down'));
    const { GET } = await import('./match/[id]/route');
    const req = new Request('http://localhost/api/match/evt999?home=h1&away=a1');
    const res = await GET(req, { params: { id: 'evt999' } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
