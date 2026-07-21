import type { Match, BracketMatch, BracketTeam, Team } from '@/server/data/types';

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

// Adapt a league Match to the BracketMatch shape MatchDetailPopup consumes.
// BracketMatch === Match's shared fields + `round` and `placeholder` teams.
export function matchToBracketMatch(m: Match): BracketMatch {
  const toBracketTeam = (t: Team): BracketTeam => ({
    id: t.id, name: t.name, abbr: t.abbr, crestUrl: t.crestUrl, placeholder: false,
  });
  return {
    id: m.id,
    round: '',
    kickoff: m.kickoff,
    home: toBracketTeam(m.home),
    away: toBracketTeam(m.away),
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    state: m.state,
    statusDetail: m.statusDetail,
    statusName: m.statusName,
    minute: m.minute,
    winnerId: m.winnerId,
    note: m.note,
  };
}
