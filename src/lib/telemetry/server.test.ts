import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track } from '@vercel/analytics/server';
import { trackAPIRequestFailure } from './server';

vi.mock('@vercel/analytics/server', () => ({ track: vi.fn() }));

describe('trackAPIRequestFailure', () => {
  beforeEach(() => vi.mocked(track).mockReset());

  it('records only stable request failure dimensions', async () => {
    trackAPIRequestFailure('matches', 502, 'world-cup', '2026');
    trackAPIRequestFailure('matches', 502, 'world-cup', '2026');

    expect(track).toHaveBeenCalledWith('API request failed', {
      endpoint: 'matches',
      status: 502,
      competition: 'world-cup',
      season: '2026',
    }, { headers: {} });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('tracks a new failure after the throttle window', () => {
    vi.useFakeTimers();
    try {
      // A distinct endpoint from the throttling test above: the throttle map
      // is module state and outlives a single test.
      trackAPIRequestFailure('bracket', 502, 'world-cup', '2026');
      vi.advanceTimersByTime(60_000);
      trackAPIRequestFailure('bracket', 502, 'world-cup', '2026');

      expect(track).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
