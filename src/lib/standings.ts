import type { Group, Team } from '@/server/data/types';

export interface ThirdPlaceRow {
  team: Team;
  groupId: string; // "A".."L"
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalDifference: number;
  points: number;
  rank: number; // 1..N among third-placed teams
  qualifies: boolean; // top `QUALIFYING_THIRDS` advance
}

// WC2026: the 8 best third-placed teams (of 12 groups) advance to the R32.
export const QUALIFYING_THIRDS = 8;

// FIFA tiebreakers for ranking third-placed teams: points, then goal
// difference, then goals scored. (Further tiebreakers — fair play, drawing of
// lots — are not derivable from the group data and are omitted.)
function compareThird(a: ThirdPlaceRow, b: ThirdPlaceRow): number {
  return (
    b.points - a.points ||
    b.goalDifference - a.goalDifference ||
    b.goalsFor - a.goalsFor ||
    a.groupId.localeCompare(b.groupId)
  );
}

/**
 * Rank every group's third-placed team against each other and flag the top
 * `QUALIFYING_THIRDS` as qualifying. Groups without a 3rd-place row are skipped.
 */
export function thirdPlacedRanking(groups: Group[]): ThirdPlaceRow[] {
  const rows: ThirdPlaceRow[] = [];
  for (const group of groups) {
    const third = group.standings.find((s) => s.rank === 3);
    if (!third) continue;
    rows.push({
      team: third.team,
      groupId: group.id,
      played: third.played,
      wins: third.wins,
      draws: third.draws,
      losses: third.losses,
      goalsFor: third.goalsFor,
      goalDifference: third.goalDifference,
      points: third.points,
      rank: 0,
      qualifies: false,
    });
  }
  rows.sort(compareThird);
  return rows.map((row, i) => ({
    ...row,
    rank: i + 1,
    qualifies: i < QUALIFYING_THIRDS,
  }));
}
