import type { Group, Match, Standing, Team } from './types';

// Leagues Cup phase-one tables.
//
// ESPN publishes NO standings for this competition — `/standings` returns `{}`,
// and it does so even for seasons that finished a year ago. So the tables are
// not fetched, they are computed from results. That is permanent, not a
// stopgap.
//
// Two rules make this competition unlike a league:
//
//  1. A draw is never a draw. Regulation ties go straight to a penalty
//     shootout (there is no extra time anywhere in the tournament), and the
//     shootout is worth points: 2 to the winner, 1 to the loser.
//  2. Clubs are ranked only against their own league, and never play them.
//     Every phase-one match is MLS v Liga MX, so an MLS club's table position
//     is decided entirely by results against Liga MX opposition.

export interface PhasePoints {
  win: number;
  shootoutWin: number;
  shootoutLoss: number;
}

export const LEAGUES_CUP_POINTS: PhasePoints = { win: 3, shootoutWin: 2, shootoutLoss: 1 };

interface Row {
  team: Team;
  played: number;
  wins: number;
  draws: number; // regulation draws — i.e. matches that went to penalties
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

function blank(team: Team): Row {
  return {
    team,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
  };
}

// Rank by points, then goal difference, then goals scored. Both of this
// season's qualification cuts were settled on goal difference, so the
// tiebreaker is not academic.
function rank(rows: Row[]): Standing[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
        b.goalsFor - a.goalsFor ||
        a.team.name.localeCompare(b.team.name),
    )
    .map((r, i) => ({
      team: r.team,
      rank: i + 1,
      played: r.played,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
      goalsFor: r.goalsFor,
      goalsAgainst: r.goalsAgainst,
      goalDifference: r.goalsFor - r.goalsAgainst,
      points: r.points,
      advanced: false,
    }));
}

/**
 * Build the two phase-one tables from finished matches.
 *
 * `ligaMxTeamIds` decides which side of the competition a club sits on. It is
 * supplied by the caller (from ESPN's Liga MX team list) rather than inferred:
 * splitting on country would drop Vancouver Whitecaps, a Canadian club that
 * plays in MLS.
 */
export function computePhaseTables(
  matches: Match[],
  ligaMxTeamIds: ReadonlySet<string>,
  cut: number,
  points: PhasePoints = LEAGUES_CUP_POINTS,
): Group[] {
  const rows = new Map<string, Row>();
  const rowFor = (team: Team) => {
    const existing = rows.get(team.id);
    if (existing) return existing;
    const created = blank(team);
    rows.set(team.id, created);
    return created;
  };

  for (const m of matches) {
    if (m.state !== 'finished') continue;
    if (m.homeScore === null || m.awayScore === null) continue;

    const home = rowFor(m.home);
    const away = rowFor(m.away);
    home.played += 1;
    away.played += 1;
    home.goalsFor += m.homeScore;
    home.goalsAgainst += m.awayScore;
    away.goalsFor += m.awayScore;
    away.goalsAgainst += m.homeScore;

    if (m.homeScore > m.awayScore) {
      home.wins += 1;
      home.points += points.win;
      away.losses += 1;
      continue;
    }
    if (m.homeScore < m.awayScore) {
      away.wins += 1;
      away.points += points.win;
      home.losses += 1;
      continue;
    }

    // Level after regulation: the shootout decides the points split. If the
    // note that carries the shootout result is missing we still record the
    // match as drawn and award the losing-side point to both, rather than
    // silently dropping a played match from the table.
    home.draws += 1;
    away.draws += 1;
    const so = m.shootout;
    if (so && so.homeScore !== so.awayScore) {
      const homeWon = so.homeScore > so.awayScore;
      home.points += homeWon ? points.shootoutWin : points.shootoutLoss;
      away.points += homeWon ? points.shootoutLoss : points.shootoutWin;
    } else {
      home.points += points.shootoutLoss;
      away.points += points.shootoutLoss;
    }
  }

  const all = Array.from(rows.values());
  const mls = rank(all.filter((r) => !ligaMxTeamIds.has(r.team.id)));
  const ligaMx = rank(all.filter((r) => ligaMxTeamIds.has(r.team.id)));
  for (const table of [mls, ligaMx]) {
    for (const s of table) s.advanced = s.rank <= cut;
  }

  const groups: Group[] = [];
  if (mls.length) groups.push({ id: 'mls', name: 'MLS', standings: mls });
  if (ligaMx.length) groups.push({ id: 'liga-mx', name: 'Liga MX', standings: ligaMx });
  return groups;
}

export interface SeededTie {
  homeSeed: number; // seed within its own table (1-based)
  awaySeed: number;
  home: Standing;
  away: Standing;
}

/**
 * Derive the quarterfinal ties.
 *
 * The bracket is fixed and pre-seeded — there is no draw — so the ties follow
 * from the two tables alone: MLS 1 v LMX 4, MLS 2 v LMX 3, MLS 3 v LMX 2,
 * MLS 4 v LMX 1. That pairing is what guarantees two clubs from the same
 * league cannot meet before the semifinal.
 *
 * This is why we don't wait on the provider: ESPN had not published a single
 * knockout fixture at the time this shipped, but the pairings were already
 * fully determined by results.
 */
export function computeQuarterfinals(groups: Group[], cut: number): SeededTie[] {
  const mls = groups.find((g) => g.id === 'mls')?.standings ?? [];
  const ligaMx = groups.find((g) => g.id === 'liga-mx')?.standings ?? [];
  const mlsQ = mls.slice(0, cut);
  const lmxQ = ligaMx.slice(0, cut);
  if (mlsQ.length < cut || lmxQ.length < cut) return [];

  return mlsQ.map((home, i) => ({
    homeSeed: i + 1,
    awaySeed: cut - i,
    home,
    away: lmxQ[cut - 1 - i],
  }));
}
