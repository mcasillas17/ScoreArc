import { describe, it, expect } from 'vitest';
import { untilKickoff, whatsOnHeadline } from './digest';

const H = 3600_000;

describe('untilKickoff', () => {
  it('reads in minutes under an hour', () => {
    expect(untilKickoff(25 * 60_000)?.en).toBe('in 25 minutes');
  });

  it('rounds to whole hours once past one', () => {
    expect(untilKickoff(4 * H + 12 * 60_000)?.en).toBe('in about 4 hours');
  });

  it('switches to days past a day out', () => {
    expect(untilKickoff(50 * H)?.en).toBe('in about 2 days');
  });

  // A kickoff already in the past is not a countdown. Returning null lets the
  // caller fall back to a sentence that does not quote a negative duration.
  it('refuses a kickoff that has passed', () => {
    expect(untilKickoff(-H)).toBeNull();
    expect(untilKickoff(0)).toBeNull();
  });
});

describe('whatsOnHeadline', () => {
  it('counts live matches', () => {
    expect(whatsOnHeadline('live', 3, null).en).toBe('3 matches live right now.');
    expect(whatsOnHeadline('live', 1, null).en).toBe('1 match live right now.');
  });

  it('says how far off the next kickoff is', () => {
    expect(whatsOnHeadline('upcoming', 4, 4 * H).en).toContain('next kickoff in about 4 hours');
  });

  // The dead-day case the spec calls out: an empty block reads as a broken
  // site, so the heading has to say these are results rather than fixtures.
  it('names recent results as results', () => {
    expect(whatsOnHeadline('recent', 4, null).en).toContain('latest results');
    expect(whatsOnHeadline('recent', 4, null).es).toContain('últimos resultados');
  });

  it('is bilingual in every mode', () => {
    for (const m of ['live', 'upcoming', 'recent'] as const) {
      const line = whatsOnHeadline(m, 2, 2 * H);
      expect(line.en.length).toBeGreaterThan(0);
      expect(line.es.length).toBeGreaterThan(0);
      expect(line.es).not.toBe(line.en);
    }
  });
});
