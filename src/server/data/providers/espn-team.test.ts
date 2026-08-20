import { describe, it, expect } from 'vitest';
import { mapTeamProfile, mapTeamRoster, mapTeamSchedule } from './espn-team';
import profileRaw from '../__fixtures__/espn-team-profile.json';
import rosterRaw from '../__fixtures__/espn-team-roster.json';
import scheduleRaw from '../__fixtures__/espn-team-schedule.json';

describe('mapTeamProfile', () => {
  const p = mapTeamProfile(profileRaw)!;

  it('maps identity and club colours', () => {
    expect(p.team.name).toBe('América');
    expect(p.team.abbr).toBe('AME');
    expect(p.color).toBeTruthy();
    expect(p.altColor).toBeTruthy();
  });

  // Asserted as shape, not as a scoreline: the record moves every matchday.
  // It was '2-1-0' / 3 played / 7 points when this plan was written and
  // '3-1-0' / 4 / 10 when the fixture was recorded.
  it('maps the season record', () => {
    expect(p.record!.summary).toMatch(/^\d+-\d+-\d+$/);
    expect(p.record!.gamesPlayed).toBeGreaterThan(0);
    expect(p.record!.points).toBeGreaterThanOrEqual(0);
    expect(p.record!.goalDifference).not.toBeUndefined();
  });

  it('carries the standing summary', () => {
    expect(p.standingSummary).toBeTruthy();
  });

  it('returns null for a malformed payload', () => {
    expect(mapTeamProfile({})).toBeNull();
    expect(mapTeamProfile(null)).toBeNull();
  });
});

describe('mapTeamRoster', () => {
  const squad = mapTeamRoster(rosterRaw);

  it('maps the whole squad', () => {
    expect(squad).toHaveLength(35);
    expect(squad.every((p) => p.id && p.name)).toBe(true);
  });

  // The headline capability: season stats arrive inline, so a squad stat table
  // costs one request rather than 35.
  it('reads season stats inline from the roster payload', () => {
    const borja = squad.find((p) => p.name === 'Cristian Borja')!;
    expect(borja.stats!.appearances).toBe(3);
    expect(borja.stats!.totalGoals).toBe(1);
    expect(borja.stats!.totalShots).toBe(2);
    expect(borja.stats!.foulsSuffered).toBe(6);
  });

  // Stats are spread across general/offensive/goalKeeping categories and the
  // set differs by position, so lookup is by name across a flattened list.
  it('finds a stat regardless of which category it sits in', () => {
    const borja = squad.find((p) => p.name === 'Cristian Borja')!;
    expect(borja.stats!.yellowCards).toBe(0);   // general
    expect(borja.stats!.offsides).toBe(1);      // offensive
    expect(borja.stats!.goalsConceded).toBe(1); // goalKeeping
  });

  // Seven of the 35 carry no statistics key at all. They stay in the squad
  // with stats null, which the table renders as "has not appeared" -- not as
  // a line of zeroes, which would assert they played and did nothing.
  it('keeps players with no statistics block, with stats null', () => {
    const statless = squad.filter((p) => p.stats === null);
    expect(statless.length).toBeGreaterThan(0);
    expect(statless.every((p) => p.id && p.name)).toBe(true);
    expect(squad.filter((p) => p.stats !== null).length).toBe(squad.length - statless.length);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapTeamRoster({})).toEqual([]);
    expect(mapTeamRoster(null)).toEqual([]);
  });
});

describe('mapTeamSchedule', () => {
  const s = mapTeamSchedule(scheduleRaw);

  it('maps events to matches in kickoff order', () => {
    expect(s.length).toBeGreaterThan(0);
    for (let i = 1; i < s.length; i++) {
      expect(new Date(s[i - 1].kickoff).getTime())
        .toBeLessThanOrEqual(new Date(s[i].kickoff).getTime());
    }
  });

  it('reads status from the competition, not the event', () => {
    // This payload has no ev.status at all -- it lives on competitions[0].
    expect(s.every((m) => m.state !== undefined)).toBe(true);
    expect(s.some((m) => m.statusDetail !== '')).toBe(true);
  });

  // competitor.score here is a $ref stub pointing at the core API, not a
  // number. Number($ref) is NaN, and NaN rendered as a score is worse than an
  // honest dash.
  it('never yields NaN for a score', () => {
    for (const m of s) {
      expect(Number.isNaN(m.homeScore as number)).toBe(false);
      expect(Number.isNaN(m.awayScore as number)).toBe(false);
    }
  });

  // score is an object carrying a $ref AND a displayValue. Reading only the
  // $ref loses the scoreline of every match already played, which is most of
  // what a fixtures-and-results block is for.
  it('reads the scoreline of a finished fixture', () => {
    const played = s.filter((m) => m.state === 'finished');
    expect(played.length).toBeGreaterThan(0);
    expect(played.every((m) => m.homeScore !== null && m.awayScore !== null)).toBe(true);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapTeamSchedule({})).toEqual([]);
    expect(mapTeamSchedule(null)).toEqual([]);
  });
});
