import { describe, it, expect } from 'vitest';
import { dayHeading, groupByDay } from './matchDays';
import type { Match, MatchState } from '@/server/data/types';

// Local dates throughout: these labels are what a reader sees, and the whole
// point of computing them in the browser is that they follow the reader's
// clock rather than the server's UTC one.
const NOW = new Date(2026, 7, 18, 12, 0); // Tuesday 18 August 2026, local

function at(y: number, m: number, d: number, h = 18): Match {
  const kickoff = new Date(y, m, d, h).toISOString();
  return {
    id: `${y}-${m}-${d}-${h}`, kickoff, state: 'scheduled' as MatchState,
    minute: null, statusDetail: '', statusName: '',
    home: { id: 'h', name: 'Home', abbr: 'HOM', crestUrl: null },
    away: { id: 'a', name: 'Away', abbr: 'AWY', crestUrl: null },
    homeScore: null, awayScore: null, winnerId: null, note: null,
    scorers: [], cards: [], shootout: null, shootoutDetail: null,
    stats: null, winProbability: null,
  } as Match;
}

describe('dayHeading', () => {
  it('names the days around today in words', () => {
    expect(dayHeading(at(2026, 7, 18).kickoff, NOW, 'en')).toBe('Today');
    expect(dayHeading(at(2026, 7, 19).kickoff, NOW, 'en')).toBe('Tomorrow');
    expect(dayHeading(at(2026, 7, 17).kickoff, NOW, 'en')).toBe('Yesterday');
  });

  it('uses the weekday inside the coming week', () => {
    expect(dayHeading(at(2026, 7, 21).kickoff, NOW, 'en')).toBe('Friday');
  });

  // Past a week, a bare weekday is ambiguous: "Friday" could be either of two.
  it('adds a date once a weekday would be ambiguous', () => {
    expect(dayHeading(at(2026, 7, 28).kickoff, NOW, 'en')).toMatch(/Friday.*Aug 28/);
  });

  // A kickoff late in the evening is still that evening, not the next day.
  // Comparing instants rather than local dates is what would break this.
  it('keeps a late kickoff on its own local day', () => {
    expect(dayHeading(at(2026, 7, 18, 22).kickoff, NOW, 'en')).toBe('Today');
  });

  it('returns null for an invalid provider kickoff', () => {
    expect(dayHeading('not-a-date', NOW, 'en')).toBeNull();
  });
});

describe('groupByDay', () => {
  it('groups matches by local day, preserving order', () => {
    const groups = groupByDay(
      [at(2026, 7, 21, 18), at(2026, 7, 21, 20), at(2026, 7, 22, 16)],
      NOW,
      'en',
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Friday');
    expect(groups[0].matches).toHaveLength(2);
    expect(groups[1].matches).toHaveLength(1);
  });

  it('keeps the order it was given rather than re-sorting', () => {
    const groups = groupByDay([at(2026, 7, 22), at(2026, 7, 21)], NOW, 'en');
    expect(groups.map((g) => g.label)).toEqual(['Saturday', 'Friday']);
  });

  it('returns nothing for no matches', () => {
    expect(groupByDay([], NOW, 'en')).toEqual([]);
  });

  it('gives each day a distinct key', () => {
    const groups = groupByDay([at(2026, 7, 21), at(2026, 7, 22)], NOW, 'en');
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('keeps an invalid provider kickoff visible under a translated unavailable label', () => {
    const invalid = { ...at(2026, 7, 21), kickoff: 'not-a-date' };
    expect(groupByDay([invalid], NOW, 'es')).toEqual([
      expect.objectContaining({ label: 'No disponible', matches: [invalid] }),
    ]);
  });
});

// The app's language, not the browser's: a reader who picks Spanish on an
// English laptop was getting "Saturday, Oct 17" under an otherwise Spanish
// page, because an empty locale list reads the machine locale.
describe('dayHeading in Spanish', () => {
  it('speaks the relative days', () => {
    expect(dayHeading(at(2026, 7, 18).kickoff, NOW, 'es')).toBe('Hoy');
    expect(dayHeading(at(2026, 7, 19).kickoff, NOW, 'es')).toBe('Mañana');
    expect(dayHeading(at(2026, 7, 17).kickoff, NOW, 'es')).toBe('Ayer');
  });

  it('formats weekdays and dates with a Spanish locale', () => {
    expect(dayHeading(at(2026, 7, 21).kickoff, NOW, 'es')).toBe('viernes');
    expect(dayHeading(at(2026, 7, 28).kickoff, NOW, 'es')).toMatch(/viernes/);
  });
});
