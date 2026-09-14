import type { Match } from './types';
import { isMatchKickoff } from './matchKickoff';

export type MatchScope = NonNullable<Match['scope']>;
export type TeamResult = 'W' | 'D' | 'L';
export interface PerformanceMatch { match: Match; result: TeamResult; goalsFor: number; goalsAgainst: number }
export interface PerformancePeriod {
  matches: PerformanceMatch[];
  sample: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  cleanSheets: number;
  goalsForPerMatch: number | null;
  goalsAgainstPerMatch: number | null;
}

// Conservative allowlist: post/finished also includes unplayed cancellations,
// forfeits and abandoned games. A new status needs evidence before inclusion.
const PLAYED = new Set(['STATUS_FULL_TIME', 'STATUS_FINAL_AET', 'STATUS_FINAL_PEN']);
const knownScore = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0;

export function performanceMatch(match: Match, teamId: string, scope: MatchScope): PerformanceMatch | null {
  if (!match.id || !isMatchKickoff(match.kickoff) || match.state !== 'finished'
    || !PLAYED.has(match.statusName) || !knownScore(match.homeScore) || !knownScore(match.awayScore)
    || match.scope?.competitionId !== scope.competitionId || match.scope?.seasonId !== scope.seasonId
    || match.home.id === match.away.id || (match.home.id !== teamId && match.away.id !== teamId)) return null;
  const home = match.home.id === teamId;
  const goalsFor = home ? match.homeScore : match.awayScore;
  const goalsAgainst = home ? match.awayScore : match.homeScore;
  // Scores are match goals including extra time; shootout totals and winnerId
  // deliberately do not enter this calculation. A penalty tie stays a draw.
  return { match, goalsFor, goalsAgainst, result: goalsFor === goalsAgainst ? 'D' : goalsFor > goalsAgainst ? 'W' : 'L' };
}

/** Canonical order, no input mutation. Conflicting duplicates cannot be evidence.
 * Only counting facts define conflicts; optional summary enrichment does not.
 */
export function uniqueTeamMatches(matches: Match[]): Match[] {
  const byId = new Map<string, { match: Match; facts: string }>();
  const conflicts = new Set<string>();
  for (const match of matches) {
    const facts = JSON.stringify([match.kickoff, match.home.id, match.away.id, match.state,
      match.statusName, match.homeScore, match.awayScore, match.scope?.competitionId, match.scope?.seasonId]);
    const existing = byId.get(match.id);
    if (existing && existing.facts !== facts) conflicts.add(match.id);
    else if (!existing) byId.set(match.id, { match, facts });
  }
  return [...byId.values()].filter(({ match }) => !conflicts.has(match.id) && isMatchKickoff(match.kickoff)).map(({ match }) => match)
    .sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function period(matches: PerformanceMatch[]): PerformancePeriod {
  const sample = matches.length;
  const goalsFor = matches.reduce((n, m) => n + m.goalsFor, 0);
  const goalsAgainst = matches.reduce((n, m) => n + m.goalsAgainst, 0);
  return { matches, sample, goalsFor, goalsAgainst,
    wins: matches.filter((m) => m.result === 'W').length,
    draws: matches.filter((m) => m.result === 'D').length,
    losses: matches.filter((m) => m.result === 'L').length,
    cleanSheets: matches.filter((m) => m.goalsAgainst === 0).length,
    goalsForPerMatch: sample ? goalsFor / sample : null,
    goalsAgainstPerMatch: sample ? goalsAgainst / sample : null };
}

export function teamPerformance(matches: Match[], teamId: string, scope: MatchScope) {
  const eligible = uniqueTeamMatches(matches).flatMap((match) => {
    const result = performanceMatch(match, teamId, scope);
    return result ? [result] : [];
  });
  const recent = period(eligible.slice(0, 5));
  const previous = eligible.length >= 10 ? period(eligible.slice(5, 10)) : null;
  return { recent, previous, eligibleCount: eligible.length, change: previous ? {
    wins: recent.wins - previous.wins,
    draws: recent.draws - previous.draws,
    losses: recent.losses - previous.losses,
    goalsFor: recent.goalsFor - previous.goalsFor,
    goalsAgainst: recent.goalsAgainst - previous.goalsAgainst,
    cleanSheets: recent.cleanSheets - previous.cleanSheets,
    goalsForPerMatch: (recent.goalsFor - previous.goalsFor) / 5,
    goalsAgainstPerMatch: (recent.goalsAgainst - previous.goalsAgainst) / 5,
  } : null };
}
