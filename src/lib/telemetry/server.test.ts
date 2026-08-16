import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track } from '@vercel/analytics/server';
import { trackAPIRequestFailure } from './server';

vi.mock('@vercel/analytics/server', () => ({ track: vi.fn() }));

describe('trackAPIRequestFailure', () => {
  beforeEach(() => vi.mocked(track).mockReset());

  it('records only stable request failure dimensions', async () => {
    const request = new Request('https://scorearc.futbol/api/world-cup/2026/matches');
    await trackAPIRequestFailure(request, 'matches', 502, 'world-cup', '2026');

    expect(track).toHaveBeenCalledWith('API request failed', {
      endpoint: 'matches',
      status: 502,
      competition: 'world-cup',
      season: '2026',
    }, { request });
  });

  it('does not let analytics errors affect callers', async () => {
    vi.mocked(track).mockRejectedValueOnce(new Error('unavailable'));

    await expect(
      trackAPIRequestFailure(new Request('https://scorearc.futbol/api/world-cup/2026/news'), 'news', 404, 'world-cup', '2026'),
    ).resolves.toBeUndefined();
  });
});
