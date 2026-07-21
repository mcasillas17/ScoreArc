import type { Match, BracketMatch, BracketTeam, Team } from '@/server/data/types';

// True when the kickoff is still upcoming (>= now) and falls on or before the
// end of the current week — the upcoming Sunday at 23:59:59.999 local. If today
// is Sunday, the window ends tonight.
export function isThisWeek(kickoffIso: string, now: Date): boolean {
  const ko = new Date(kickoffIso);
  if (isNaN(ko.getTime())) return false;
  if (ko.getTime() < now.getTime()) return false;
  const daysUntilSunday = (7 - now.getDay()) % 7; // getDay(): 0=Sun..6=Sat
  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + daysUntilSunday);
  endOfWeek.setHours(23, 59, 59, 999);
  return ko.getTime() <= endOfWeek.getTime();
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
