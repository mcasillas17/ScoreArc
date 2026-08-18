import { describe, expect, it } from 'vitest';
import {
  monthLoadFailed,
  monthLoadStarted,
  monthLoadSucceeded,
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
      matches: [],
      loading: false,
      error: 'Fixtures unavailable',
    });
  });

  it('clears loading when returning to the already-loaded month', () => {
    expect(returnedToLoadedMonth(monthLoadStarted(initial))).toEqual(initial);
  });

  it('replaces rows and clears status after a successful request', () => {
    const september = [{ id: 'september' }];
    expect(monthLoadSucceeded(monthLoadStarted(initial), september)).toEqual({
      matches: september,
      loading: false,
      error: null,
    });
  });
});
