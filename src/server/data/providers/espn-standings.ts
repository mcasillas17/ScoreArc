import type { Group, Standing } from '../types';

function statMap(stats: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of stats ?? []) out[st.name] = st.value;
  return out;
}

// ESPN does not promise its entries arrive in table order. For most leagues they
// do — the nth entry is the nth-placed club — but for MLS (`usa.1`) each
// conference comes back in ESPN's own team order, so trusting the array index
// would print Chicago Fire first in an Eastern Conference that Nashville leads.
//
// Every entry carries its true position in a `rank` stat. Use it when the group
// supplies a complete 1..n permutation, and fall back to array order when it
// doesn't — a partial or duplicated `rank` is worse than the index, and dropping
// or duplicating clubs is never acceptable.
function inTableOrder(entries: any[]): any[] {
  const n = entries.length;
  const ranks = entries.map((e) => statMap(e.stats).rank);
  const seen = new Set<number>();
  for (const r of ranks) {
    if (!Number.isInteger(r) || r < 1 || r > n || seen.has(r)) return entries;
    seen.add(r);
  }
  if (seen.size !== n) return entries;
  return entries.map((e, i) => ({ entry: e, rank: ranks[i] }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.entry);
}

// The eight stats every row must carry, as the ingester requires them
// (backend/shared/espn/standings.go). Only goal difference may be negative.
const REQUIRED_STATS = ['gamesPlayed', 'wins', 'ties', 'losses', 'pointsFor', 'pointsAgainst', 'pointDifferential', 'points'] as const;

/**
 * ESPN standings children -> Group[].
 *
 * The acceptance rule is the ingester's (T16.2): a table with no teams, or a
 * row without team identity or a required stat, throws rather than rendering a
 * missing measurement as a zero; the reader keeps its previous standings for
 * the same payload. No tables at all is a legitimate empty answer.
 *
 * `unnamedTable` labels a provider table that has no name -- a single-table
 * competition -- with the competition's short name, as the reader does.
 */
export function mapStandings(raw: unknown, unnamedTable: string): Group[] {
  const children: any[] = (raw as any)?.children ?? [];
  return children.map((grp) => {
    const name: string = grp.name || unnamedTable;
    const entries: any[] = grp.standings?.entries ?? [];
    if (entries.length === 0) throw new Error(`standings table "${name}" has no teams`);
    const standings: Standing[] = inTableOrder(entries).map((entry, i) => {
      const team = entry.team ?? {};
      if (team.id == null || !team.displayName || !team.abbreviation) {
        throw new Error(`standings row ${i} in "${name}" lacks team identity`);
      }
      const s = statMap(entry.stats);
      for (const stat of REQUIRED_STATS) {
        const value = s[stat];
        if (!Number.isInteger(value) || (stat !== 'pointDifferential' && value < 0)) {
          throw new Error(`standings row ${i} in "${name}" has invalid ${stat}`);
        }
      }
      return {
        team: {
          id: String(team.id),
          name: team.displayName,
          abbr: team.abbreviation,
          crestUrl: team.logos?.[0]?.href || null,
        },
        rank: i + 1,
        played: s.gamesPlayed,
        wins: s.wins,
        draws: s.ties,
        losses: s.losses,
        goalsFor: s.pointsFor,
        goalsAgainst: s.pointsAgainst,
        goalDifference: s.pointDifferential,
        points: s.points,
        advanced: (s.advanced ?? 0) === 1,
      };
    });
    return { id: name.replace('Group ', ''), name, standings };
  });
}
