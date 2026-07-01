import type { Scorer, Card, MatchStats, TeamStats } from '../types';

function parseStat(stats: any[], name: string): number | null {
  const s = stats.find((x: any) => x.name === name);
  if (s == null) return null;
  const n = parseFloat(s.displayValue);
  return isNaN(n) ? null : n;
}

function buildTeamStats(statistics: any[]): TeamStats {
  return {
    possession: parseStat(statistics, 'possessionPct'),
    shots: parseStat(statistics, 'totalShots'),
    shotsOnTarget: parseStat(statistics, 'shotsOnTarget'),
    passes: parseStat(statistics, 'totalPasses'),
    corners: parseStat(statistics, 'wonCorners'),
    fouls: parseStat(statistics, 'foulsCommitted'),
  };
}

export function mapSummaryStats(
  raw: unknown,
  homeId: string,
  awayId: string
): MatchStats | null {
  try {
    const teams: any[] = (raw as any)?.boxscore?.teams;
    if (!Array.isArray(teams) || teams.length < 2) return null;
    const homeEntry = teams.find((t: any) => String(t.team?.id) === homeId);
    const awayEntry = teams.find((t: any) => String(t.team?.id) === awayId);
    if (!homeEntry || !awayEntry) return null;
    return {
      home: buildTeamStats(homeEntry.statistics ?? []),
      away: buildTeamStats(awayEntry.statistics ?? []),
    };
  } catch {
    return null;
  }
}

export function mapSummaryScorers(raw: unknown): Scorer[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => e.scoringPlay === true && e.team?.id != null)
    .map(
      (e: any): Scorer => ({
        teamId: String(e.team.id),
        player: e.participants?.[0]?.athlete?.displayName ?? '',
        minute: e.clock?.displayValue ?? '',
        penalty: !!e.penaltyKick,
        shootout: !!e.shootout,
      })
    );
}

// Yellow / red cards from the summary keyEvents (same shape as goals).
// "Yellow Red Card" (second yellow -> sending off) counts as a red.
export function mapSummaryCards(raw: unknown): Card[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => /card/i.test(e.type?.text ?? '') && e.team?.id != null)
    .map((e: any): Card => ({
      teamId: String(e.team.id),
      player: e.participants?.[0]?.athlete?.displayName ?? '',
      minute: e.clock?.displayValue ?? '',
      type: /red/i.test(e.type?.text ?? '') ? 'red' : 'yellow',
    }));
}
