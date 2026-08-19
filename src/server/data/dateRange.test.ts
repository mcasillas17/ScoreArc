import { describe, it, expect } from 'vitest';
import {
  monthRange,
  nowWindowRange,
  parseRange,
  seasonInitialMonth,
  seasonMonthBounds,
  shiftMonth,
} from './dateRange';

describe('monthRange', () => {
  it('covers the whole calendar month', () => {
    expect(monthRange(new Date(2026, 7, 15))).toBe('20260801-20260831');
  });

  it('handles a 30-day month', () => {
    expect(monthRange(new Date(2026, 8, 1))).toBe('20260901-20260930');
  });

  it('handles February in a leap year', () => {
    expect(monthRange(new Date(2028, 1, 10))).toBe('20280201-20280229');
  });

  it('handles February in a non-leap year', () => {
    expect(monthRange(new Date(2026, 1, 10))).toBe('20260201-20260228');
  });
});

describe('shiftMonth', () => {
  it('steps forward across a year boundary', () => {
    const d = shiftMonth(new Date(2026, 11, 15), 1);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
  });

  it('steps backward across a year boundary', () => {
    const d = shiftMonth(new Date(2026, 0, 15), -1);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(11);
  });

  // Naive setMonth on the 31st rolls into the following month: Jan 31 + 1
  // month becomes March 3. Clamping to the 1st is what prevents February
  // being unreachable from January.
  it('does not skip a month when the source day does not exist in the target', () => {
    const d = shiftMonth(new Date(2026, 0, 31), 1);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(1);
  });
});

describe('seasonMonthBounds', () => {
  it('bounds a cross-year league season from July through June', () => {
    expect(seasonMonthBounds('2026-27')).toEqual({
      minMonth: '2026-07-01',
      maxMonth: '2027-06-01',
    });
  });

  it('bounds Liga MX split seasons to their half of the year', () => {
    expect(seasonMonthBounds('2026-apertura')).toEqual({
      minMonth: '2026-07-01',
      maxMonth: '2026-12-01',
    });
    expect(seasonMonthBounds('2027-clausura')).toEqual({
      minMonth: '2027-01-01',
      maxMonth: '2027-06-01',
    });
  });

  describe('seasonInitialMonth', () => {
    const now = new Date(2026, 7, 18);

    it('keeps the current month when it is inside the season', () => {
      expect(seasonInitialMonth(now, '2026-27')).toEqual(new Date(2026, 7, 1));
    });

    it('uses the last active month for a completed tournament', () => {
      expect(seasonInitialMonth(now, '1998', '19980627-19980712')).toEqual(
        new Date(1998, 6, 1),
      );
      expect(seasonInitialMonth(now, '2026', '20260628-20260719')).toEqual(
        new Date(2026, 6, 1),
      );
    });

    it('keeps the current month when it overlaps the active range', () => {
      expect(
        seasonInitialMonth(new Date(2026, 6, 4), '2026', '20260628-20260719'),
      ).toEqual(new Date(2026, 6, 1));
    });

    it('clamps to the nearest season bound without an active range', () => {
      expect(seasonInitialMonth(now, '2027-clausura')).toEqual(new Date(2027, 0, 1));
      expect(seasonInitialMonth(now, '2025-26')).toEqual(new Date(2026, 5, 1));
    });
  });

  it('bounds a calendar-year competition to that year', () => {
    expect(seasonMonthBounds('2026')).toEqual({
      minMonth: '2026-01-01',
      maxMonth: '2026-12-01',
    });
  });

  it('rejects an unsupported season id', () => {
    expect(() => seasonMonthBounds('summer-2026')).toThrow('Unsupported season id');
  });
});

describe('parseRange', () => {
  it('accepts a well-formed range', () => {
    expect(parseRange('20260801-20260831')).toBe('20260801-20260831');
  });

  it('rejects null and empty', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('')).toBeNull();
  });

  it('rejects a malformed shape', () => {
    expect(parseRange('2026-08-01')).toBeNull();
    expect(parseRange('20260801')).toBeNull();
    expect(parseRange('20260801-')).toBeNull();
    expect(parseRange('abcdefgh-20260831')).toBeNull();
  });

  // This value reaches a URL we build against a third-party API.
  it('rejects an injection attempt that happens to contain digits', () => {
    expect(parseRange('20260801-20260831&limit=999')).toBeNull();
    expect(parseRange('20260801-20260831/../../secret')).toBeNull();
  });

  it('rejects an impossible date', () => {
    expect(parseRange('20260231-20260301')).toBeNull();
    expect(parseRange('20261301-20261331')).toBeNull();
  });

  it('rejects a reversed range', () => {
    expect(parseRange('20260831-20260801')).toBeNull();
  });

  it('accepts a single-day range', () => {
    expect(parseRange('20260801-20260801')).toBe('20260801-20260801');
  });

  // An unbounded span is a cheap way to make ScoreArc fetch something enormous.
  it('rejects a span beyond the cap', () => {
    expect(parseRange('20260101-20261231')).toBeNull();
    expect(parseRange('19000101-20991231')).toBeNull();
  });

  it('honours a custom cap', () => {
    expect(parseRange('20260801-20260810', 5)).toBeNull();
    expect(parseRange('20260801-20260803', 5)).toBe('20260801-20260803');
  });
});

describe('nowWindowRange', () => {
  it('spans the default 7 days back and 14 forward', () => {
    expect(nowWindowRange(new Date(2026, 7, 18))).toBe('20260811-20260901');
  });

  it('honours custom spans', () => {
    expect(nowWindowRange(new Date(2026, 7, 18), 1, 1)).toBe('20260817-20260819');
  });

  // Month and year rollover is exactly what a hand-rolled string would get
  // wrong, and the value is interpolated straight into an upstream URL.
  it('rolls across a month boundary', () => {
    expect(nowWindowRange(new Date(2026, 8, 2), 7, 0)).toBe('20260826-20260902');
  });

  it('rolls across a year boundary', () => {
    expect(nowWindowRange(new Date(2027, 0, 3), 7, 0)).toBe('20261227-20270103');
  });

  it('produces a range parseRange accepts', () => {
    const range = nowWindowRange(new Date(2026, 7, 18));
    expect(parseRange(range)).toBe(range);
  });
});
