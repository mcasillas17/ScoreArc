import { describe, it, expect } from 'vitest';
import { thirdPlacedRanking, QUALIFYING_THIRDS } from './standings';
import type { Group, Standing, Team } from '@/server/data/types';

function team(id: string): Team {
  return { id, name: id, abbr: id, crestUrl: null };
}

function standing(rank: number, over: Partial<Standing> = {}): Standing {
  return {
    team: team(`${rank}`),
    rank,
    played: 3,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    points: 0,
    advanced: false,
    ...over,
  };
}

// Build N groups, each with a 3rd-place team carrying the given (points, gd, gf).
function groupsWithThirds(thirds: { pts: number; gd: number; gf: number }[]): Group[] {
  return thirds.map((t, i) => {
    const id = String.fromCharCode(65 + i); // A, B, C...
    return {
      id,
      name: `Group ${id}`,
      standings: [
        standing(1),
        standing(2),
        standing(3, {
          team: team(`3-${id}`),
          points: t.pts,
          goalDifference: t.gd,
          goalsFor: t.gf,
        }),
        standing(4),
      ],
    };
  });
}

describe('thirdPlacedRanking', () => {
  it('ranks third-placed teams by points, then GD, then GF', () => {
    const groups = groupsWithThirds([
      { pts: 3, gd: 1, gf: 2 }, // A
      { pts: 4, gd: 0, gf: 1 }, // B — most points → 1st
      { pts: 3, gd: 3, gf: 2 }, // C — ties A on pts, better GD → above A
      { pts: 3, gd: 1, gf: 5 }, // D — ties A on pts+GD, better GF → above A
    ]);
    const ranked = thirdPlacedRanking(groups);
    expect(ranked.map((r) => r.groupId)).toEqual(['B', 'C', 'D', 'A']);
    expect(ranked[0].rank).toBe(1);
  });

  it('flags exactly the top 8 as qualifying when 12 groups exist', () => {
    const thirds = Array.from({ length: 12 }, (_, i) => ({ pts: i, gd: 0, gf: 0 }));
    const ranked = thirdPlacedRanking(groupsWithThirds(thirds));
    expect(ranked).toHaveLength(12);
    expect(ranked.filter((r) => r.qualifies)).toHaveLength(QUALIFYING_THIRDS);
    // Highest points (11) should be first and qualify; lowest (0) last and out.
    expect(ranked[0].qualifies).toBe(true);
    expect(ranked[ranked.length - 1].qualifies).toBe(false);
  });

  it('skips groups without a third-place row', () => {
    const groups: Group[] = [
      { id: 'A', name: 'Group A', standings: [standing(1), standing(2)] },
    ];
    expect(thirdPlacedRanking(groups)).toEqual([]);
  });

  // Before a ball is kicked every numeric tiebreaker ties, so compareThird
  // falls through to `groupId.localeCompare` and the ranking becomes
  // alphabetical by group. Marking the first eight as qualifying then states
  // that Groups A-H are through on no evidence whatsoever.
  it('flags nobody as qualifying before any group has kicked off', () => {
    const thirds = Array.from({ length: 12 }, () => ({ pts: 0, gd: 0, gf: 0 }));
    const groups = groupsWithThirds(thirds).map((g) => ({
      ...g,
      standings: g.standings.map((s) => ({ ...s, played: 0 })),
    }));
    const ranked = thirdPlacedRanking(groups);
    expect(ranked).toHaveLength(12);
    expect(ranked.filter((r) => r.qualifies)).toHaveLength(0);
  });

  // One group kicking off does NOT make the race real. All twelve rows can
  // still be tied at 0/0/0, so compareThird still falls through to
  // groupId.localeCompare and the 8-vs-4 split would be pure alphabet.
  it('does not flag merely because one group has played, while all rows remain tied', () => {
    const thirds = Array.from({ length: 12 }, () => ({ pts: 0, gd: 0, gf: 0 }));
    const groups = groupsWithThirds(thirds).map((g, i) => ({
      ...g,
      standings: g.standings.map((s) => ({ ...s, played: i === 0 ? 1 : 0 })),
    }));
    expect(thirdPlacedRanking(groups).filter((r) => r.qualifies)).toHaveLength(0);
  });

  // What makes the cut real is the numeric criteria separating 8th from 9th,
  // not how many matches have been played.
  it('flags once the qualification boundary is actually earned', () => {
    const thirds = Array.from({ length: 12 }, (_, i) => ({ pts: i < 8 ? 3 : 0, gd: 0, gf: 0 }));
    const ranked = thirdPlacedRanking(groupsWithThirds(thirds));
    expect(ranked.filter((r) => r.qualifies)).toHaveLength(QUALIFYING_THIRDS);
  });

  // A genuine mid-tournament tie ON the boundary is undetermined — FIFA draws
  // lots, which group data cannot express. Better to flag nobody than to flag
  // whoever's group name sorts first.
  it('does not flag when 8th and 9th are tied on every criterion', () => {
    const thirds = Array.from({ length: 12 }, (_, i) => ({ pts: i < 4 ? 6 : 3, gd: 0, gf: 0 }));
    const groups = groupsWithThirds(thirds).map((g) => ({
      ...g,
      standings: g.standings.map((s) => ({ ...s, played: 3 })),
    }));
    expect(thirdPlacedRanking(groups).filter((r) => r.qualifies)).toHaveLength(0);
  });
});
