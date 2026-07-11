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
