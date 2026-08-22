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

  // The sibling `events` map (keyed by id) carries the context that makes a
  // row readable: opponent, date, score, result and the home/away ids the
  // match popup needs. A row without its context entry keeps nulls.
  it('merges match context from the events map', () => {
    const row = o.rows.find((r) => r.eventId === '401877007')!;
    expect(row.opponent!.abbr).toBe('TOL');
    expect(row.score).toBe('2-1');
    expect(row.result).toBe('L');
    expect(row.atVs).toBe('vs');
    expect(row.homeTeamId).toBe('222');
    expect(row.awayTeamId).toBe('223');
    expect(row.date).toContain('2026-08-22');
    expect(row.teamId).toBe('222');
    expect(row.teamAbbr).toBe('QRO');
  });

  it('distinguishes a substitute appearance', () => {
    const row = o.rows.find((r) => r.eventId === '401863600')!;
    expect(row.appearance).toBe('Sub');
  });

  it('maps the athlete news through the shared article shape', () => {
    expect(o.news.length).toBeGreaterThan(0);
    expect(o.news[0].headline.length).toBeGreaterThan(0);
    expect(o.news[0].url).toContain('espn');
  });

  it('returns an empty log for a malformed payload', () => {
    expect(mapAthleteOverview({}).rows).toEqual([]);
    expect(mapAthleteOverview({}).news).toEqual([]);
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
