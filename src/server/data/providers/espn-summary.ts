import type { Scorer, Card, MatchStats, TeamStats, WinProbability } from '../types';

function parseStat(stats: any[], name: string): number | null {
  const s = stats.find((x: any) => x.name === name);
  if (s == null) return null;
  const n = parseFloat(s.displayValue);
  return isNaN(n) ? null : n;
}

// American moneyline -> implied probability (0..1).
function moneylineToProb(ml: number | null | undefined): number | null {
  if (ml == null || isNaN(ml)) return null;
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

function teamIdFromRef(o: any): string | null {
  const ref: string = o?.team?.$ref ?? '';
  const m = /\/teams\/(\d+)/.exec(ref);
  return m ? m[1] : null;
}

/**
 * Market-implied win/draw/win probability from the first betting provider's
 * moneylines, with the bookmaker margin removed (normalised to 100). Mapped to
 * OUR home/away by team id. Returns null if no usable 3-way moneyline is present.
 */
export function mapWinProbability(
  raw: unknown,
  homeId: string,
  awayId: string
): WinProbability | null {
  try {
    const oddsList: any[] = (raw as any)?.odds ?? [];
    for (const o of oddsList) {
      const pHome = moneylineToProb(o?.homeTeamOdds?.moneyLine);
      const pAway = moneylineToProb(o?.awayTeamOdds?.moneyLine);
      const pDraw = moneylineToProb(o?.drawOdds?.moneyLine);
      if (pHome == null || pAway == null || pDraw == null) continue;

      // Assign the provider's home/away legs to OUR home/away by team id.
      const homeLegId = teamIdFromRef(o.homeTeamOdds);
      let ourHome = pHome;
      let ourAway = pAway;
      if (homeLegId && homeLegId === awayId) {
        ourHome = pAway;
        ourAway = pHome;
      }

      const total = ourHome + ourAway + pDraw;
      if (total <= 0) continue;
      return {
        home: Math.round((ourHome / total) * 1000) / 10,
        draw: Math.round((pDraw / total) * 1000) / 10,
        away: Math.round((ourAway / total) * 1000) / 10,
      };
    }
    return null;
  } catch {
    return null;
  }
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
