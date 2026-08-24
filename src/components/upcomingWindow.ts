import type { Match } from '@/server/data/types';
import type { MatchDetailInput } from './MatchDetailPopup';

// True when the kickoff falls within the Monday→Sunday calendar week that
// contains `now` (local time) — Monday 00:00 through Sunday 23:59:59.999.
export function toMatchDetailInput(m: Match): MatchDetailInput {
  return {
    kickoff: m.kickoff,
    home: m.home,
    away: m.away,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    state: m.state,
    statusDetail: m.statusDetail,
    statusName: m.statusName,
    minute: m.minute,
    note: m.note,
  };
}
