import { describe, it, expect } from 'vitest';
import { monthRange, parseRange, seasonMonthBounds, shiftMonth } from './dateRange';

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
