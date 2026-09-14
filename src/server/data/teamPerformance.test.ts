import { describe, expect, it } from 'vitest';
import { teamPerformance } from './teamPerformance';
import { mapTeamSchedule } from './providers/espn-team';
import raw from './__fixtures__/espn-team-schedule.json';
import type { Match } from './types';

const scope = { competitionId: 'liga-mx', seasonId: '2026-apertura' };
const base = mapTeamSchedule(raw)[0];
function match(n: number, extra: Partial<Match> = {}): Match {
  return { ...base, id: String(n), kickoff: `2026-08-${String(n + 1).padStart(2, '0')}T12:00:00Z`,
    scope, home: { ...base.home, id: '227' }, away: { ...base.away, id: '213' },
    homeScore: 2, awayScore: 0, state: 'finished', statusName: 'STATUS_FULL_TIME', ...extra };
}
const derive = (matches: Match[]) => teamPerformance(matches, '227', scope);

describe('team performance evidence', () => {
  it('uses home and away perspectives, draws and zero conceded as known facts', () => {
    const result = derive([match(1), match(2, { homeScore: 1, awayScore: 1 }),
      match(3, { home: { ...base.home, id: '213' }, away: { ...base.away, id: '227' } })]);
    expect(result.recent).toMatchObject({ sample: 3, wins: 1, draws: 1, losses: 1,
      goalsFor: 3, goalsAgainst: 3, cleanSheets: 1, goalsForPerMatch: 1, goalsAgainstPerMatch: 1 });
    expect(result.recent.matches.map((m) => m.result)).toEqual(['L', 'D', 'W']);
  });
  it('counts extra time, excludes shootout goals and treats penalty ties as draws', () => {
    const result = derive([match(1, { statusName: 'STATUS_FINAL_AET', homeScore: 3, awayScore: 2 }),
      match(2, { statusName: 'STATUS_FINAL_PEN', homeScore: 0, awayScore: 0,
        shootout: { homeScore: 5, awayScore: 4 }, winnerId: '227' })]);
    expect(result.recent).toMatchObject({ wins: 1, draws: 1, goalsFor: 3, goalsAgainst: 2, cleanSheets: 1 });
  });
  it.each(['STATUS_CANCELED', 'STATUS_ABANDONED', 'STATUS_POSTPONED', 'STATUS_SUSPENDED',
    'STATUS_FORFEIT', 'STATUS_AWARDED', 'STATUS_UNKNOWN', ''])('excludes exceptional or unknown final %s', (statusName) => {
    expect(derive([match(1, { statusName })]).recent.sample).toBe(0);
  });
  it.each([null, NaN, Infinity, -1, 1.5])('requires valid known integer scores: %s', (homeScore) => {
    expect(derive([match(1, { homeScore })]).recent.sample).toBe(0);
  });
  it('rejects wrong participants, scope, dates and in-progress matches', () => {
    const inputs = [match(1, { home: { ...base.home, id: '111' } }),
      match(2, { away: { ...base.away, id: '227' } }),
      match(3, { scope: { ...scope, seasonId: '2025-apertura' } }),
      match(4, { scope: { ...scope, competitionId: 'leagues-cup' } }),
      match(5, { scope: undefined }), match(6, { kickoff: 'not a date' }),
      match(7, { state: 'live' }), match(8, { id: '' })];
    expect(derive(inputs).recent.sample).toBe(0);
  });
  it('deduplicates and orders before choosing two exact windows without mutating input', () => {
    const inputs = Array.from({ length: 12 }, (_, i) => match(i + 1, { homeScore: i < 7 ? 1 : 3 }));
    inputs.reverse(); inputs.push({ ...inputs[0] });
    const original = inputs.map((m) => m.id);
    const result = derive(inputs);
    expect(result.recent.matches.map((m) => m.match.id)).toEqual(['12', '11', '10', '9', '8']);
    expect(result.previous?.matches.map((m) => m.match.id)).toEqual(['7', '6', '5', '4', '3']);
    expect(result.recent.sample).toBe(5);
    expect(result.previous?.sample).toBe(5);
    expect(result.change).toEqual({ wins: 0, draws: 0, losses: 0, goalsFor: 10,
      goalsAgainst: 0, cleanSheets: 0, goalsForPerMatch: 2, goalsAgainstPerMatch: 0 });
    expect(inputs.map((m) => m.id)).toEqual(original);
  });
  it('keeps both windows ordered when invalid dates are mixed with ten valid matches', () => {
    const ids = ['3', '1', '4', '5', '6', '7', '8', '9', '10', '11'];
    const inputs = ids.map((id, i) => match(i + 1, {
      id, kickoff: `2026-${String(i + 1).padStart(2, '0')}-01T12:00:00Z`,
    }));
    inputs.splice(2, 0, match(2, { kickoff: 'invalid' }));
    for (const rows of [inputs, [...inputs].reverse()]) {
      const result = derive(rows);
      expect(result.eligibleCount).toBe(10);
      expect(result.recent.matches.map((m) => m.match.id)).toEqual(['11', '10', '9', '8', '7']);
      expect(result.previous?.matches.map((m) => m.match.id)).toEqual(['6', '5', '4', '1', '3']);
    }
  });
  it.each(['0', '2026-02-30T12:00:00Z', '2026-08-31T24:00:00Z'])('rejects parseable but invalid kickoff %s before choosing windows', (kickoff) => {
    const rows = Array.from({ length: 10 }, (_, i) => match(i + 1));
    const result = derive([...rows, match(20, { kickoff })]);
    expect(result.eligibleCount).toBe(10);
    expect(result.recent.matches.map((m) => m.match.id)).toEqual(['10', '9', '8', '7', '6']);
    expect(result.previous?.matches.map((m) => m.match.id)).toEqual(['5', '4', '3', '2', '1']);
  });
  it('uses id for equal kickoffs and excludes conflicting duplicate facts in any order', () => {
    const inputs = [match(1), match(2, { kickoff: match(1).kickoff }), match(3), match(3, { homeScore: 0 })];
    expect(derive(inputs).recent.matches.map((m) => m.match.id)).toEqual(['1', '2']);
    expect(derive([...inputs].reverse())).toEqual(derive(inputs));
  });
  it.each([0, 1, 4, 5, 9])('shows actual sample and no comparison for %i eligible matches', (n) => {
    const result = derive(Array.from({ length: n }, (_, i) => match(i + 1)));
    expect(result.recent.sample).toBe(Math.min(n, 5));
    expect(result.previous).toBeNull(); expect(result.change).toBeNull();
    if (n === 0) expect(result.recent.goalsAgainstPerMatch).toBeNull();
  });
});
