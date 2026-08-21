import { describe, it, expect } from 'vitest';
import { teamJourney, type RingNode } from './radialBracketModel';

function node(depth: number, teamId: string, opts: Partial<RingNode> = {}): RingNode {
  return {
    depth, index: 0, angle: 0, match: null,
    team: { id: teamId, name: teamId, abbr: teamId, crestUrl: null, placeholder: teamId === 'PH' },
    isHome: true, x: depth * 10, y: depth * 100,
    crestX: 0, crestY: 0, discR: 30,
    isWinner: false, eliminated: false, clickable: false, ...opts,
  };
}

describe('teamJourney', () => {
  it('champion: full positions, no elimination, deepest at final', () => {
    const rings: RingNode[][] = [
      [node(0, 'CHA', { isWinner: true })],
      [node(1, 'CHA', { isWinner: true })],
      [node(2, 'CHA', { isWinner: true })],
      [node(3, 'CHA', { isWinner: true })],
      [node(4, 'CHA', { isWinner: true })],
    ];
    const j = teamJourney(rings).find((t) => t.teamId === 'CHA')!;
    expect(j.positions.map((p) => p.depth)).toEqual([0, 1, 2, 3, 4]);
    // each stop carries its own ring node (for disc render + greyscale + click)
    expect(j.positions.map((p) => p.node.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(j.positions.every((p) => p.node.team.id === 'CHA')).toBe(true);
    expect(j.eliminatedAtDepth).toBeNull();
    expect(j.deepestNode.depth).toBe(4);
  });

  it('R32 loser: single position, eliminated at depth 0', () => {
    const rings: RingNode[][] = [[node(0, 'OUT', { eliminated: true })], [], [], [], []];
    const j = teamJourney(rings).find((t) => t.teamId === 'OUT')!;
    expect(j.positions).toHaveLength(1);
    expect(j.eliminatedAtDepth).toBe(0);
  });

  it('R16 loser: two positions, eliminated at depth 1', () => {
    const rings: RingNode[][] = [
      [node(0, 'MID', { isWinner: true })],
      [node(1, 'MID', { eliminated: true })],
      [], [], [],
    ];
    const j = teamJourney(rings).find((t) => t.teamId === 'MID')!;
    expect(j.positions.map((p) => p.depth)).toEqual([0, 1]);
    expect(j.eliminatedAtDepth).toBe(1);
  });

  it('still-alive team: no elimination, deepest = current frontier', () => {
    const rings: RingNode[][] = [
      [node(0, 'ALV', { isWinner: true })],
      [node(1, 'ALV', { isWinner: true })],
      [node(2, 'ALV', { isWinner: false, eliminated: false })],
      [], [],
    ];
    const j = teamJourney(rings).find((t) => t.teamId === 'ALV')!;
    expect(j.eliminatedAtDepth).toBeNull();
    expect(j.deepestNode.depth).toBe(2);
  });

  it('skips placeholder nodes', () => {
    const rings: RingNode[][] = [[node(0, 'PH')]];
    expect(teamJourney(rings)).toHaveLength(0);
  });
});

import { deriveLeafOrder } from './radialBracketModel';
import type { BracketRound, BracketMatch, KnockoutRoundSlug } from '@/server/data/types';

function dm(round: KnockoutRoundSlug, id: string, home: string, away: string, winner: string): BracketMatch {
  const team = (a: string) => ({ id: a, name: a, abbr: a, crestUrl: null, placeholder: false });
  return {
    id, round, kickoff: '', home: team(home), away: team(away),
    homeScore: null, awayScore: null, state: 'finished', statusDetail: 'FT',
    statusName: '', minute: null, winnerId: winner || null, note: null,
  };
}

describe('deriveLeafOrder', () => {
  it('orders leaf matches so adjacent pairs feed the parent, from results', () => {
    const rounds: BracketRound[] = [
      { slug: 'round-of-16', matches: [dm('round-of-16', 'l0', 'A', 'B', 'A'), dm('round-of-16', 'l1', 'C', 'D', 'C')] },
      { slug: 'final', matches: [dm('final', 'f', 'A', 'C', 'A')] },
    ];
    expect(deriveLeafOrder(rounds, ['round-of-16', 'final'])).toEqual([0, 1]);
  });

  it('reverses when the final home team came from the second leaf match', () => {
    const rounds: BracketRound[] = [
      { slug: 'round-of-16', matches: [dm('round-of-16', 'l0', 'A', 'B', 'A'), dm('round-of-16', 'l1', 'C', 'D', 'C')] },
      { slug: 'final', matches: [dm('final', 'f', 'C', 'A', 'C')] },
    ];
    expect(deriveLeafOrder(rounds, ['round-of-16', 'final'])).toEqual([1, 0]);
  });

  it('falls back to event order when a winner is missing', () => {
    const bad = dm('final', 'f', 'A', 'C', ''); bad.winnerId = null;
    const rounds: BracketRound[] = [
      { slug: 'round-of-16', matches: [dm('round-of-16', 'l0', 'A', 'B', 'A'), dm('round-of-16', 'l1', 'C', 'D', 'C')] },
      { slug: 'final', matches: [bad] },
    ];
    expect(deriveLeafOrder(rounds, ['round-of-16', 'final'])).toEqual([0, 1]);
  });
});

import { buildRings } from './radialBracketModel';
import { bracketShapeFor } from './bracketShape';
import { mapBracket } from '@/server/data/providers/espn-bracket';
import raw2022 from '@/server/data/__fixtures__/espn-bracket-2022.json';

describe('buildRings — 2022 (4 rings, derived order)', () => {
  const rounds = mapBracket(raw2022);
  const shape = bracketShapeFor({
    id: '2022', label: '2022', sections: ['bracket'],
    format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: true },
    knockoutRounds: ['round-of-16', 'quarterfinals', 'semifinals', 'final'],
  });

  it('builds 4 rings: 16 leaves -> 8 -> 4 -> 2', () => {
    const rings = buildRings(rounds, shape);
    expect(rings).toHaveLength(4);
    expect(rings[0]).toHaveLength(16);
    expect(rings[3]).toHaveLength(2);
  });

  it('crowns Argentina (2022 champion) in the final ring', () => {
    const rings = buildRings(rounds, shape);
    const champ = rings[3].find((n) => n.isWinner)?.team.abbr;
    expect(champ).toBe('ARG');
  });

  it('reconstructs the QF pairings from results (NED-ARG, ENG-FRA)', () => {
    const rings = buildRings(rounds, shape);
    // rings[1] = the 8 QF participants; two adjacent nodes (2k, 2k+1) = one QF.
    const qf = (abbr: string) => Math.floor(rings[1].findIndex((n) => n.team.abbr === abbr) / 2);
    expect(qf('NED')).toBe(qf('ARG')); // 2022 QF: Netherlands v Argentina
    expect(qf('ENG')).toBe(qf('FRA')); // 2022 QF: England v France
  });
});
