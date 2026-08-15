import { describe, it, expect } from 'vitest';
import { forwardRange, currentWeekRange } from './store';

// Thursday 2026-08-14 — the day five of nine competitions held 132 scheduled
// fixtures between them and showed an empty banner, because every one of those
// fixtures fell outside the current Monday→Sunday week.
const NOW = new Date('2026-08-14T12:00:00');

describe('forwardRange', () => {
  it('starts today, not at the start of the week', () => {
    expect(forwardRange(NOW)).toMatch(/^20260814-/);
  });

  it('reaches far enough to catch a season starting next week', () => {
    // Premier League's first fixture is 2026-08-21; Bundesliga's is 08-28.
    // currentWeekRange ends on Sunday the 16th and misses both.
    expect(currentWeekRange(NOW)).toBe('20260810-20260816');
    expect(forwardRange(NOW)).toBe('20260814-20260911');
  });

  it('honours a custom horizon', () => {
    expect(forwardRange(NOW, 7)).toBe('20260814-20260821');
  });

  it('rolls over month boundaries', () => {
    expect(forwardRange(new Date('2026-08-25T12:00:00'), 10)).toBe('20260825-20260904');
  });

  it('rolls over year boundaries', () => {
    expect(forwardRange(new Date('2026-12-28T12:00:00'), 7)).toBe('20261228-20270104');
  });
});
