import type { PlayoffFormat } from './competitions';
import type { BracketMatch, BracketRound, BracketTeam, Group, Standing } from './types';

/**
 * The Apertura 2026 Liguilla, projected from the live general table: the
 * owners' assembly permanently eliminated the Play-In starting this
 * tournament (verified 2026-08-22), so the top 8 go straight to quarters.
 *
 * Pair order is [1v8, 4v5, 2v7, 3v6] — adjacency in the ring is what feeds
 * the two semifinals, and this order keeps 1's half opposite 2's.
 */
const QF_PAIRS: [number, number][] = [[1, 8], [4, 5], [2, 7], [3, 6]];

function toBracketTeam(s: Standing): BracketTeam {
  return {
    id: s.team.id,
    name: s.team.name,
    abbr: s.team.abbr,
    crestUrl: s.team.crestUrl,
    placeholder: false,
  };
}

export function placeholderTeam(id: string): BracketTeam {
  return { id, name: '', abbr: '', crestUrl: null, placeholder: true };
}

// Synthetic fixture: nothing is scheduled, nothing has a score. The `proj-`
// ids are deliberate non-events — a details fetch on one can only 404.
export function projectedMatch(
  id: string,
  round: BracketMatch['round'],
  home: BracketTeam,
  away: BracketTeam,
): BracketMatch {
  return {
    id, round, kickoff: '', home, away,
    homeScore: null, awayScore: null,
    state: 'scheduled', statusDetail: '', statusName: 'STATUS_SCHEDULED',
    minute: null, winnerId: null, note: null,
  };
}

/** Require distinct clubs and explicit positions in the edition's full tables. */
export function playoffTable(groups: Group[], format: PlayoffFormat): Standing[] {
  const size = { nwsl: 16, 'femenil-apertura': 9, 'liga-mx-apertura': 18 }[format];
  if (groups.length !== (format === 'femenil-apertura' ? 2 : 1)) return [];
  const rows = groups.flatMap(g => g.standings);
  if (new Set(rows.map(s => s.team.id)).size !== rows.length ||
      new Set(groups.map(g => g.id)).size !== groups.length) return [];
  for (const { standings } of groups) {
    if (standings.length !== size || standings.every(s => !s.played) ||
        new Set(standings.map(s => s.rank)).size !== size ||
        standings.some(s => !Number.isInteger(s.rank) || s.rank < 1 || s.rank > size)) return [];
  }
  return rows;
}

// Article 30's next criteria are away goals, fair play and a draw. Equal keys
// represent an unresolved order until the league publishes the semifinal ties.
export function overallOrder(a: Standing, b: Standing): number {
  return b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor;
}

/** Project the quarterfinals from the edition's table; inward slots stay open. */
export function projectLiguilla(groups: Group[], format?: PlayoffFormat): BracketRound[] | null {
  if (format && !playoffTable(groups, format).length) return null;
  const general = groups.find(g => g.standings.length >= 8);
  if (!general) return null;
  const seed = (g: Group, rank: number) => {
    const rows = g.standings.filter(s => s.rank === rank);
    if (rows.length !== 1) return null;
    const team = toBracketTeam(rows[0]);
    return format === 'liga-mx-apertura' ? { ...team, overallSeed: rank } : team;
  };
  const [a, b] = groups;
  const pairs = format === 'femenil-apertura'
    ? [[seed(a, 1), seed(b, 4)], [seed(b, 1), seed(a, 4)], [seed(a, 2), seed(b, 3)], [seed(b, 2), seed(a, 3)]]
    : QF_PAIRS.map(([hi, lo]) => [seed(general, hi), seed(general, lo)]);
  const matches: BracketMatch[] = [];
  for (const [home, away] of pairs) {
    if (!home || !away) return null;
    matches.push(projectedMatch('proj-qf-' + (matches.length + 1), 'quarterfinals', home, away));
  }
  return [
    { slug: 'quarterfinals', matches },
    {
      slug: 'semifinals',
      matches: [
        projectedMatch('proj-sf-1', 'semifinals', placeholderTeam('proj-tbd-1'), placeholderTeam('proj-tbd-2')),
        projectedMatch('proj-sf-2', 'semifinals', placeholderTeam('proj-tbd-3'), placeholderTeam('proj-tbd-4')),
      ],
    },
    {
      slug: 'final',
      matches: [projectedMatch('proj-f-1', 'final', placeholderTeam('proj-tbd-5'), placeholderTeam('proj-tbd-6'))],
    },
  ];
}
