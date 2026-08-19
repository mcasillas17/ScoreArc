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
    expect(dayHeading(at(2026, 7, 18).kickoff, NOW)).toBe('Today');
    expect(dayHeading(at(2026, 7, 19).kickoff, NOW)).toBe('Tomorrow');
    expect(dayHeading(at(2026, 7, 17).kickoff, NOW)).toBe('Yesterday');
  });

  it('uses the weekday inside the coming week', () => {
    expect(dayHeading(at(2026, 7, 21).kickoff, NOW)).toBe('Friday');
  });

  // Past a week, a bare weekday is ambiguous: "Friday" could be either of two.
  it('adds a date once a weekday would be ambiguous', () => {
    expect(dayHeading(at(2026, 7, 28).kickoff, NOW)).toMatch(/Friday.*Aug 28/);
  });

  // A kickoff late in the evening is still that evening, not the next day.
  // Comparing instants rather than local dates is what would break this.
  it('keeps a late kickoff on its own local day', () => {
    expect(dayHeading(at(2026, 7, 18, 22).kickoff, NOW)).toBe('Today');
  });
});

describe('groupByDay', () => {
  it('groups matches by local day, preserving order', () => {
    const groups = groupByDay(
      [at(2026, 7, 21, 18), at(2026, 7, 21, 20), at(2026, 7, 22, 16)],
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Friday');
    expect(groups[0].matches).toHaveLength(2);
    expect(groups[1].matches).toHaveLength(1);
  });

  it('keeps the order it was given rather than re-sorting', () => {
    const groups = groupByDay([at(2026, 7, 22), at(2026, 7, 21)], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Saturday', 'Friday']);
  });

  it('returns nothing for no matches', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });

  it('gives each day a distinct key', () => {
    const groups = groupByDay([at(2026, 7, 21), at(2026, 7, 22)], NOW);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });
});
