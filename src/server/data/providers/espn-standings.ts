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

export function mapStandings(raw: unknown): Group[] {
  const children: any[] = (raw as any)?.children ?? [];
  return children.map((grp) => {
    const entries: any[] = inTableOrder(grp.standings?.entries ?? []);
    const standings: Standing[] = entries.map((entry, i) => {
      const s = statMap(entry.stats);
      return {
        team: {
          id: String(entry.team.id),
          name: entry.team.displayName,
          abbr: entry.team.abbreviation,
          crestUrl: entry.team.logos?.[0]?.href ?? null,
        },
        rank: i + 1,
        played: s.gamesPlayed ?? 0,
        wins: s.wins ?? 0,
        draws: s.ties ?? 0,
        losses: s.losses ?? 0,
        goalsFor: s.pointsFor ?? 0,
        goalsAgainst: s.pointsAgainst ?? 0,
        goalDifference: s.pointDifferential ?? 0,
        points: s.points ?? 0,
        advanced: (s.advanced ?? 0) === 1,
      };
    });
    return { id: grp.name.replace('Group ', ''), name: grp.name, standings };
  });
}
