import { describe, expect, it } from 'vitest';
import { gameLogDetailInput } from './PlayerGameLog';
import type { GameLogRow } from '@/server/data/types';

const home = { id: '202', name: 'Argentina', abbr: 'ARG', crestUrl: null };
const row: GameLogRow = { eventId: '123', appearance: 'Started', stats: {}, date: '2026-11-01T12:00:00Z',
  atVs: '@', opponent: home, score: '2-1', result: 'W', homeTeamId: '202', awayTeamId: '478', teamId: '478', teamAbbr: 'FRA' };

describe('player game-log popup facts', () => {
  it('uses explicit live facts without manufacturing full time or losing the known score', () => {
    const liveMatch = { state: 'live' as const, homeScore: 2, awayScore: 1, minute: '63', statusDetail: "63'", statusName: 'STATUS_IN_PROGRESS' };
    expect(gameLogDetailInput({ ...row, result: '', liveMatch }, null)).toMatchObject({
      state: 'live', homeScore: 2, awayScore: 1, minute: '63', statusDetail: "63'", statusName: 'STATUS_IN_PROGRESS',
      home: { id: '202' }, away: { id: '478' },
    });
    expect(gameLogDetailInput({ ...row, result: '', liveMatch: { ...liveMatch, homeScore: null, awayScore: null, minute: null } }, null))
      .toMatchObject({ state: 'live', homeScore: null, awayScore: null, minute: null });
  });

  it('retains ESPN result-perspective score interpretation', () => {
    expect(gameLogDetailInput(row, null)).toMatchObject({ state: 'finished', statusName: 'STATUS_FULL_TIME', homeScore: 1, awayScore: 2 });
    expect(gameLogDetailInput({ ...row, result: 'L' }, null)).toMatchObject({ homeScore: 2, awayScore: 1 });
    expect(gameLogDetailInput({ ...row, opponent: null }, null)).toBeNull();
  });

  it('keeps an unknown reader row unlinked without changing the ESPN legacy default', () => {
    expect(gameLogDetailInput({ ...row, result: '' }, null, true)).toBeNull();
    expect(gameLogDetailInput({ ...row, result: '' }, null)).toMatchObject({ state: 'finished', homeScore: null, awayScore: null });
  });
});
