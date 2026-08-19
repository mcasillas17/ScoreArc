import type { StatLeader } from '../types';

// Parse the matches-played count out of ESPN's leader displayValue,
// e.g. "Matches: 4, Goals: 6" -> 4. Every category uses the same grammar
// ("Matches: 3, Assists: 3"), so this is metric-agnostic.
function parseMatches(displayValue: string | undefined): number | null {
  if (!displayValue) return null;
  const m = /Matches:\s*(\d+)/i.exec(displayValue);
  return m ? Number(m[1]) : null;
}

/**
 * One leaderboard from ESPN's `statistics` feed, already sorted by the provider.
 *
 * `category` is an entry in `stats[].name` — `goalsLeaders`, `assistsLeaders`.
 * Both arrive in the SAME response, which is why this takes a category instead
 * of hardcoding goals: the previous version fetched fifty assist rows on every
 * standings render and threw them away.
 *
 * Resilient: returns [] if the category or the shape is missing.
 */
export function mapLeaders(raw: unknown, category: string, limit = 20): StatLeader[] {
  try {
    const stats: any[] = (raw as any)?.stats ?? [];
    const board = stats.find((s: any) => s?.name === category);
    const leaders: any[] = board?.leaders ?? [];
    return leaders.slice(0, limit).map((l: any, i: number): StatLeader => {
      const athlete = l?.athlete ?? {};
      const team = athlete.team ?? {};
      return {
        rank: i + 1,
        player: athlete.displayName ?? '',
        teamAbbr: team.abbreviation ?? '',
        teamName: team.displayName ?? '',
        teamCrestUrl: team.logo ?? team.logos?.[0]?.href ?? null,
        value: Number(l?.value ?? 0),
        matches: parseMatches(l?.displayValue),
      };
    });
  } catch {
    return [];
  }
}
