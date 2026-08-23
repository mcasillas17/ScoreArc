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

function tbd(id: string): BracketTeam {
  return { id, name: '', abbr: '', crestUrl: null, placeholder: true };
}

// Synthetic fixture: nothing is scheduled, nothing has a score. The `proj-`
// ids are deliberate non-events — a details fetch on one can only 404.
function fixture(
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

/**
 * Live standings -> a synthetic Liguilla bracket, or null when the table
 * cannot honestly seat 8 (missing, short, or carrying duplicate ranks).
 * Null means the caller shows the bracket-unavailable state — a fabricated
 * bracket is worse than none.
 */
export function projectLiguilla(groups: Group[]): BracketRound[] | null {
  const general = groups.find((g) => g.standings.length >= 8);
  if (!general) return null;

  const bySeed = new Map<number, Standing>();
  for (const s of general.standings) {
    if (!Number.isInteger(s.rank) || s.rank < 1 || s.rank > 8) continue;
    if (bySeed.has(s.rank)) return null;
    bySeed.set(s.rank, s);
  }
  if (bySeed.size !== 8) return null;

  const seed = (n: number) => toBracketTeam(bySeed.get(n)!);
  return [
    {
      slug: 'quarterfinals',
      matches: QF_PAIRS.map(([hi, lo], i) =>
        fixture(`proj-qf-${i + 1}`, 'quarterfinals', seed(hi), seed(lo)),
      ),
    },
    {
      slug: 'semifinals',
      matches: [
        fixture('proj-sf-1', 'semifinals', tbd('proj-tbd-1'), tbd('proj-tbd-2')),
        fixture('proj-sf-2', 'semifinals', tbd('proj-tbd-3'), tbd('proj-tbd-4')),
      ],
    },
    {
      slug: 'final',
      matches: [fixture('proj-f-1', 'final', tbd('proj-tbd-5'), tbd('proj-tbd-6'))],
    },
  ];
}
