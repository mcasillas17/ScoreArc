import type { CareerStint, PlayerSeasonStats, PlayerSeasonTotal } from './types';
import { canonicalTeamId } from './teamIdentity';

const outfield = [['totalGoals', 'Total Goals'], ['goalAssists', 'Assists'], ['totalShots', 'Shots']] as const;
const goalkeeping = [['saves', 'Saves'], ['goalsConceded', 'Goals Conceded'], ['shotsFaced', 'Shots Faced']] as const;

/** The profile header shows role-specific figures and starts (substitute appearances). */
export function profileTotals(stats: Partial<PlayerSeasonStats> | null, position: string): PlayerSeasonTotal[] {
  if (!stats) return [];
  const totals: PlayerSeasonTotal[] = [];
  if (stats.appearances != null && stats.subIns != null && stats.appearances >= stats.subIns) {
    const starts = stats.appearances - stats.subIns;
    totals.push({ name: 'starts-subIns', label: 'Starts-Substitute Appearances', display: `${starts} (${stats.subIns})`, value: starts });
  }
  for (const [name, label] of /^(G|GK|Goalkeeper)$/i.test(position) ? goalkeeping : outfield) {
    const value = stats[name];
    if (value != null) totals.push({ name, label, display: String(value), value });
  }
  return totals;
}

/** A career can include clubs outside the public team directory. Their badges are display-only. */
export function websiteCareer(row: CareerStint): CareerStint {
  return { ...row, teamId: canonicalTeamId(row.teamId) ? row.teamId : null };
}
