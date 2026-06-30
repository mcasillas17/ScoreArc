import type { Group, Standing } from '../types';

function statMap(stats: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of stats ?? []) out[st.name] = st.value;
  return out;
}

export function mapStandings(raw: unknown): Group[] {
  const children: any[] = (raw as any)?.children ?? [];
  return children.map((grp) => {
    const entries: any[] = grp.standings?.entries ?? [];
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
