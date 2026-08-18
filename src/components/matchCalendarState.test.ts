import { describe, expect, it } from 'vitest';
import {
  monthLoadFailed,
  monthLoadStarted,
  monthLoadSucceeded,
  monthNavigationAction,
  returnedToLoadedMonth,
} from './matchCalendarState';

const initial = {
  matches: [{ id: 'august' }],
  loading: false,
  error: null,
};

describe('match calendar request state', () => {
  it('keeps old rows only while a new month is loading', () => {
    expect(monthLoadStarted(initial)).toEqual({
      matches: initial.matches,
      loading: true,
      error: null,
    });
  });

  it('clears stale rows when the requested month fails', () => {
    expect(monthLoadFailed(monthLoadStarted(initial), 'Fixtures unavailable')).toEqual({
      state: {
        matches: [],
        loading: false,
        error: 'Fixtures unavailable',
      },
      loadedRange: null,
    });
  });

  it('clears loading when returning to the already-loaded month', () => {
    expect(returnedToLoadedMonth(monthLoadStarted(initial))).toEqual(initial);
  });

  it('preserves an initial error instead of immediately retrying the same range', () => {
    const failedInitial = { matches: [], loading: false, error: 'Fixtures unavailable' };
    expect(monthNavigationAction('august', 'august')).toBe('restore');
    expect(returnedToLoadedMonth(failedInitial)).toEqual(failedInitial);
  });

  it('fetches only when the requested range differs from the loaded range', () => {
    expect(monthNavigationAction('september', 'august')).toBe('fetch');
    expect(monthNavigationAction('august', null)).toBe('fetch');
  });

  it('replaces rows and clears status after a successful request', () => {
    const september = [{ id: 'september' }];
    expect(monthLoadSucceeded(monthLoadStarted(initial), september, 'september')).toEqual({
      state: {
        matches: september,
        loading: false,
        error: null,
      },
      loadedRange: 'september',
    });
  });
});
