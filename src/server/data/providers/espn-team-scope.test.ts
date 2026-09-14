import { describe, expect, it } from 'vitest';
import { mapScopedTeamSchedule, mapTeamSchedule } from './espn-team';
import { resolveSeason } from '../competitions';
import { teamScheduleUrl } from '../endpoints';
import raw from '../__fixtures__/espn-team-schedule.json';

const rc = resolveSeason('liga-mx')!;
describe('scoped team schedule', () => {
  it('selects the split season explicitly without new requests', () => {
    expect(teamScheduleUrl('mex.1', '227', false, '2026-apertura')).toContain('season=2026&seasontype=1');
    expect(teamScheduleUrl('eng.1', '359', true, '2026-27')).toContain('fixture=true&season=2026');
  });
  it('validates recorded scope and attaches it to matches', () => {
    const result = mapScopedTeamSchedule(raw, rc, '227');
    expect(result.available).toBe(true);
    expect(result.matches).toHaveLength(raw.events.length);
    expect(result.matches[0].scope).toEqual({ competitionId: rc.competition.id, seasonId: rc.season.id });
  });
  it('separates a real empty payload from unavailable, corrupt or wrong scope data', () => {
    expect(mapScopedTeamSchedule({ ...raw, events: [] }, rc, '227')).toEqual({ available: true, matches: [] });
    for (const input of [null, {}, { ...raw, events: {} }, { ...raw, requestedSeason: { year: 2025 } }]) {
      expect(mapScopedTeamSchedule(input, rc, '227')).toEqual({ available: false, matches: [] });
    }
    expect(mapScopedTeamSchedule(raw, rc, '359').available).toBe(false);
  });
  it('does not silently count a different season, competition, split or team', () => {
    for (const change of ['season', 'league', 'split', 'team']) {
      const input = structuredClone(raw);
      if (change === 'season') input.events[0].season.year = 2025;
      if (change === 'league') input.events[0].league.slug = 'eng.1';
      if (change === 'split') input.events[0].seasonType.name = 'Torneo Clausura';
      if (change === 'team') for (const c of input.events[0].competitions[0].competitors) c.team.id = '111';
      const result = mapScopedTeamSchedule(input, rc, '227');
      expect(result.available).toBe(false);
      expect(result.matches.some((m) => m.id === input.events[0].id)).toBe(false);
    }
  });
  it('keeps absent, boolean, fractional or negative scores unknown instead of zero', () => {
    for (const score of ['', ' ', false, -1, 1.5, {}]) {
      const input = structuredClone(raw) as unknown as { events: { competitions: { competitors: { score: unknown }[] }[] }[] };
      input.events[0].competitions[0].competitors[0].score = score;
      expect(mapTeamSchedule(input)[0]).toBeDefined();
      expect(mapTeamSchedule(input).find((m) => m.id === raw.events[0].id)?.homeScore).toBeNull();
    }
  });
  it.each(['0', '2026-02-30T12:00:00Z', '2026-08-31T24:00:00Z'])('does not attach verified scope to invalid kickoff %s', (date) => {
    const input = structuredClone(raw);
    input.events[0].date = date;
    const result = mapScopedTeamSchedule(input, rc, '227');
    expect(result.available).toBe(false);
    expect(result.matches.some((m) => m.id === input.events[0].id)).toBe(false);
  });
});
