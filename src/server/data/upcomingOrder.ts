import { canonicalTeamId } from './teamIdentity';
import type { Match } from './types';

function teamKey(id: string): string {
  return canonicalTeamId(id) ?? (id.startsWith('prov-') ? id : `prov-espn-${id}`);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// The reader applies this order in SQL before LIMIT. Its canonical home/away
// pair identifies a match within an edition on a given kickoff date.
export function compareUpcomingMatches(left: Match, right: Match): number {
  return Date.parse(left.kickoff) - Date.parse(right.kickoff) ||
    compareIds(teamKey(left.home.id), teamKey(right.home.id)) ||
    compareIds(teamKey(left.away.id), teamKey(right.away.id));
}
