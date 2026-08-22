import { describe, it, expect } from 'vitest';
import { mapAthleteProfile, mapAthleteOverview, mapAthleteBio } from './espn-athlete';
import athleteRaw from '../__fixtures__/espn-athlete.json';
import overviewRaw from '../__fixtures__/espn-athlete-overview.json';
import bioRaw from '../__fixtures__/espn-athlete-bio.json';

describe('mapAthleteProfile', () => {
  const p = mapAthleteProfile(athleteRaw)!;

  it('maps identity', () => {
    expect(p.name).toBe('Ali Avila');
    expect(p.age).toBe(22);
    expect(p.position).toBe('Forward');
    expect(p.nationality).toBe('Mexico');
    expect(p.jersey).toBe('9');
    expect(p.team!.name).toBe('Querétaro');
  });

  // Headshots are frequently absent. Null is the correct mapping, and the
  // layout has to survive it -- not a placeholder URL that 404s.
  it('maps a missing headshot to null', () => {
    expect(p.headshotUrl).toBeNull();
  });

  it('maps the season totals with their labels', () => {
    expect(p.seasonLabel).toBe('2026-27 Liga MX Stats');
    const goals = p.totals.find((t) => t.name === 'totalGoals')!;
    expect(goals.value).toBe(3);
    const shots = p.totals.find((t) => t.name === 'totalShots')!;
    expect(shots.value).toBe(12);
  });

  // "5 (0)" is starts and substitute appearances. Coercing it to 5 silently
  // discards the second number.
  it('keeps the display string for a compound stat', () => {
    const starts = p.totals.find((t) => t.name === 'starts-subIns')!;
    expect(starts.display).toBe('5 (0)');
  });

  it('returns null for a malformed payload', () => {
    expect(mapAthleteProfile({})).toBeNull();
    expect(mapAthleteProfile(null)).toBeNull();
  });
});

describe('mapAthleteOverview', () => {
  const o = mapAthleteOverview(overviewRaw);

  it('maps the game log label and rows', () => {
    expect(o.label).toBe('Last 5 Matches');
    expect(o.rows).toHaveLength(5);
  });

  // The stats array is positional against a names array. Zipping by index is
  // the whole mapping; getting it wrong silently shifts every column.
  it('zips positional stats against their column names', () => {
    const row = o.rows.find((r) => r.eventId === '401863615')!;
    expect(row.appearance).toBe('Started');
    expect(row.stats.totalGoals).toBe(1);
    expect(row.stats.totalShots).toBe(1);
    expect(row.stats.foulsCommitted).toBe(4);
    expect(row.stats.offsides).toBe(2);
  });

  it('distinguishes a substitute appearance', () => {
    const row = o.rows.find((r) => r.eventId === '401863600')!;
    expect(row.appearance).toBe('Sub');
  });

  it('returns an empty log for a malformed payload', () => {
    expect(mapAthleteOverview({}).rows).toEqual([]);
    expect(mapAthleteOverview(null).rows).toEqual([]);
  });
});

describe('mapAthleteBio', () => {
  it('maps the career club history', () => {
    const career = mapAthleteBio(bioRaw);
    expect(career).toHaveLength(4);
    expect(career[0].teamName).toBe('Querétaro');
    expect(career[0].seasons).toBe('2025-CURRENT');
    expect(career[0].teamId).toBe('222');
    expect(career[0].crestUrl).toContain('222.png');
  });

  it('returns [] for a malformed payload', () => {
    expect(mapAthleteBio({})).toEqual([]);
    expect(mapAthleteBio(null)).toEqual([]);
  });
});
