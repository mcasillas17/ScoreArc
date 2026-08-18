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

  // Unlike a league table, this ranking IS the tiebreak — ScoreArc computes it
  // across independent groups, and `compareThird`'s last resort is
  // `groupId.localeCompare`, which is alphabetical order, not a result. So the
  // cut is only real when the numeric criteria actually separate the last
  // qualifying row from the first one out. If they tie, the boundary was
  // decided by the group's name and flagging it invents a qualification.
  //
  // This subsumes the pre-season case (every row tied at zero) without relying
  // on `played`, which is the wrong signal here: one group kicking off tells
  // you nothing about the other eleven, all of whom remain tied.
  // Fewer candidates than slots means there is no boundary to earn — everyone
  // present goes through, which is true by definition rather than by result.
  // It still requires a played match: with nothing played the rows are a
  // provider-ordered list, and "all of them qualify" would be asserting a
  // tournament outcome before kick-off.
  const noBoundaryToEarn =
    rows.length <= QUALIFYING_THIRDS && rows.some((row) => row.played > 0);

  const boundaryIsEarned =
    noBoundaryToEarn ||
    (rows.length > QUALIFYING_THIRDS &&
      !tiedOnMerit(rows[QUALIFYING_THIRDS - 1], rows[QUALIFYING_THIRDS]));

  return rows.map((row, i) => ({
    ...row,
    rank: i + 1,
    qualifies: boundaryIsEarned && i < QUALIFYING_THIRDS,
  }));
}

// Two third-placed teams the FIFA criteria cannot separate. Anything beyond
// this — fair play, drawing of lots — is not derivable from group data.
function tiedOnMerit(a: ThirdPlaceRow, b: ThirdPlaceRow): boolean {
  return (
    a.points === b.points &&
    a.goalDifference === b.goalDifference &&
    a.goalsFor === b.goalsFor
  );
}
