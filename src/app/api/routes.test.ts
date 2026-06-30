import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/data/service', () => ({
  dataService: {
    getGroups: vi.fn(async () => [{ id: 'A', name: 'Group A', standings: [] }]),
    getMatches: vi.fn(async () => [{ id: '1' }]),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('api routes', () => {
  it('GET /api/groups returns groups json', async () => {
    const { GET } = await import('./groups/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].id).toBe('A');
  });

  it('GET /api/matches returns matches json', async () => {
    const { GET } = await import('./matches/route');
    const res = await GET();
    const body = await res.json();
    expect(body[0].id).toBe('1');
  });
});
