import type { Match } from '@/server/data/types';
import type { MatchDetailInput } from './MatchDetailPopup';

// True when the kickoff falls within the Monday→Sunday calendar week that
// contains `now` (local time) — Monday 00:00 through Sunday 23:59:59.999.
export function isThisWeek(kickoffIso: string, now: Date): boolean {
  const ko = new Date(kickoffIso);
  if (isNaN(ko.getTime())) return false;
  const mondayOffset = (now.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat → days since Monday
  const mon = new Date(now);
  mon.setDate(now.getDate() - mondayOffset);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  sun.setHours(23, 59, 59, 999);
  return ko.getTime() >= mon.getTime() && ko.getTime() <= sun.getTime();
}

// Keep ordinary fixture data at the popup's exact display boundary rather than
// fabricating knockout-only round or placeholder fields.
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
