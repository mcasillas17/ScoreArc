import type { Match, Team } from '../types';
import { mapState } from '../state';

function mapTeam(t: any): Team {
  return {
    id: String(t.id),
    name: t.displayName,
    abbr: t.abbreviation,
    crestUrl: t.logo ?? t.logos?.[0]?.href ?? null,
  };
}

export function mapScoreboard(raw: unknown): Match[] {
  const events: any[] = (raw as any)?.events ?? [];
  return events.map((ev) => {
    const comp = ev.competitions[0];
    const competitors: any[] = comp.competitors;
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    const status = ev.status;
    const state = mapState(status.type.state, status.type.completed);
    const note = comp.notes?.[0]?.text ?? null;
    const winnerId = home.winner
      ? String(home.team.id)
      : away.winner
      ? String(away.team.id)
      : null;
    return {
      id: String(ev.id),
      kickoff: ev.date,
      state,
      minute: state === 'live' ? status.displayClock : null,
      statusDetail: status.type.shortDetail,
      home: mapTeam(home.team),
      away: mapTeam(away.team),
      homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
      awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
      winnerId,
      note,
    };
  });
}
