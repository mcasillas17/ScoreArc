import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track } from '@vercel/analytics/server';
import { trackAPIRequestFailure } from './server';

vi.mock('@vercel/analytics/server', () => ({ track: vi.fn() }));

describe('trackAPIRequestFailure', () => {
  beforeEach(() => vi.mocked(track).mockReset());

  it('records only stable request failure dimensions', async () => {
    await trackAPIRequestFailure('matches', 502, 'world-cup', '2026');
    await trackAPIRequestFailure('matches', 502, 'world-cup', '2026');

    expect(track).toHaveBeenCalledWith('API request failed', {
      endpoint: 'matches',
      status: 502,
      competition: 'world-cup',
      season: '2026',
    }, { headers: {} });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does not let analytics errors affect callers', async () => {
    vi.mocked(track).mockRejectedValueOnce(new Error('unavailable'));

    await expect(
      trackAPIRequestFailure('news', 404, 'world-cup', '2026'),
    ).resolves.toBeUndefined();
  });

  it('tracks a new failure after the throttle window', async () => {
    vi.useFakeTimers();
    try {
      await trackAPIRequestFailure('upcoming', 502, 'world-cup', '2026');
      await vi.advanceTimersByTimeAsync(60_000);
      await trackAPIRequestFailure('upcoming', 502, 'world-cup', '2026');

      expect(track).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
