import type { TopScorer } from '../types';

// Parse the matches-played count out of ESPN's leader displayValue,
// e.g. "Matches: 4, Goals: 6" -> 4.
function parseMatches(displayValue: string | undefined): number | null {
  if (!displayValue) return null;
  const m = /Matches:\s*(\d+)/i.exec(displayValue);
  return m ? Number(m[1]) : null;
}

/**
 * Tournament-wide goal-scoring leaderboard from ESPN's `statistics` feed
 * (`stats[].name === 'goalsLeaders'`). Ranked by goals as returned by ESPN
 * (already sorted). Resilient: returns [] if the shape is missing.
 */
export function mapTopScorers(raw: unknown, limit = 20): TopScorer[] {
  try {
    const stats: any[] = (raw as any)?.stats ?? [];
    const goals = stats.find((s: any) => s?.name === 'goalsLeaders');
    const leaders: any[] = goals?.leaders ?? [];
    return leaders.slice(0, limit).map((l: any, i: number): TopScorer => {
      const athlete = l?.athlete ?? {};
      const team = athlete.team ?? {};
      return {
        rank: i + 1,
        player: athlete.displayName ?? '',
        teamAbbr: team.abbreviation ?? '',
        teamName: team.displayName ?? '',
        goals: Number(l?.value ?? 0),
        matches: parseMatches(l?.displayValue),
      };
    });
  } catch {
    return [];
  }
}
