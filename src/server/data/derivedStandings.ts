import type { CompetitionSeason } from './competitions';
import type { Group, Standing } from './types';
import { configuredPhaseTables, type PhaseMatch } from './leaguesCupTables';
import { computeOverallTable } from './mlsTables';

export type { PhaseMatch };

// T10.10, roadmap option B: the reader serves inputs and the existing
// TypeScript rules derive the tables, so the football rules live once. Each
// input is a reader response body for this season (and, for computed tables,
// for the configured membership seasons), unmodified.
export interface ReaderStandingsInputs {
  /** `/v1/competitions/{comp}/{season}/standings`. */
  standings: Group[];
  /** `/matches?range=<computedTables.datesRange>`: the phase window, UTC. */
  phaseMatches?: PhaseMatch[];
  /** `/standings` of `computedTables.membership.primary` and `.split`. */
  membership?: { primary: Group[]; split: Group[] };
}

type Sides = { kickoff: string; homeId: string; awayId: string };
export type DerivedIssue =
  /** Level after regulation with no decisive shootout: one point each, as the ESPN path does. */
  | ({ kind: 'missing-shootout' } & Sides)
  /** Finished without both scores: not counted. */
  | ({ kind: 'incomplete-score' } & Sides)
  /** In neither membership table, or in both: in no table. */
  | { kind: 'unclassified-team'; teamId: string }
  /** Listed in two provider tables with different records: the first is merged. */
  | { kind: 'conflicting-row'; teamId: string };

/**
 * `complete`: derived from every input with no caveat. `partial`: derived, but
 * `issues` names what the tables could not account for. `unavailable`: a
 * required input is missing, so there is no table -- never an empty one.
 */
export interface DerivedStandings {
  status: 'complete' | 'partial' | 'unavailable';
  groups: Group[];
  issues: DerivedIssue[];
}

const record = (s: Standing) =>
  [s.played, s.wins, s.draws, s.losses, s.goalsFor, s.goalsAgainst, s.goalDifference, s.points].join();

function result(groups: Group[], issues: DerivedIssue[]): DerivedStandings {
  return { status: issues.length ? 'partial' : 'complete', groups, issues };
}

export function deriveReaderStandings(rc: CompetitionSeason, inputs: ReaderStandingsInputs): DerivedStandings {
  const computed = rc.season.computedTables;
  if (computed) {
    const { phaseMatches, membership } = inputs;
    if (!phaseMatches || !membership?.primary.length || !membership?.split.length) {
      return { status: 'unavailable', groups: [], issues: [] };
    }
    const ids = (groups: Group[]) => new Set(groups.flatMap((g) => g.standings.map((s) => s.team.id)));
    const mls = ids(membership.primary);
    const ligaMx = ids(membership.split);
    const issues: DerivedIssue[] = [];
    const unclassified = new Set<string>();
    for (const m of phaseMatches) {
      if (m.state !== 'finished') continue;
      const sides = { kickoff: m.kickoff, homeId: m.home.id, awayId: m.away.id };
      if (m.homeScore === null || m.awayScore === null) {
        issues.push({ kind: 'incomplete-score', ...sides });
        continue;
      }
      if (m.homeScore === m.awayScore && (!m.shootout || m.shootout.homeScore === m.shootout.awayScore)) {
        issues.push({ kind: 'missing-shootout', ...sides });
      }
      for (const id of [m.home.id, m.away.id]) {
        if (mls.has(id) === ligaMx.has(id)) unclassified.add(id);
      }
    }
    for (const teamId of [...unclassified].sort()) issues.push({ kind: 'unclassified-team', teamId });
    return result(configuredPhaseTables(phaseMatches, computed, ligaMx, mls), issues);
  }

  const overall = rc.season.overallTable;
  if (!overall) return result(inputs.standings, []);
  // Only provider tables are merged: a table already derived (by label key, or
  // by the derived id) would count every club twice.
  const provider = inputs.standings.filter((g) => g.labelKey === undefined && g.id !== overall.id);
  const first = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const s of provider.flatMap((g) => g.standings)) {
    const seen = first.get(s.team.id);
    if (seen === undefined) first.set(s.team.id, record(s));
    else if (seen !== record(s)) conflicts.add(s.team.id);
  }
  // A stored season always lists its clubs, so no rows is a missing input.
  const merged = computeOverallTable(provider, overall);
  if (!merged) return { status: 'unavailable', groups: [], issues: [] };
  return result(
    [...provider, merged],
    [...conflicts].sort().map((teamId) => ({ kind: 'conflicting-row', teamId })),
  );
}
