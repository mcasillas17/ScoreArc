import type { BracketRound, BracketMatch, BracketTeam } from '../types';
import { mapState } from '../state';

const ROUND_ORDER = [
  'round-of-32',
  'round-of-16',
  'quarterfinals',
  'semifinals',
  'final',
  '3rd-place-match',
] as const;

const ROUND_NAMES: Record<string, string> = {
  'round-of-32': 'Round of 32',
  'round-of-16': 'Round of 16',
  'quarterfinals': 'Quarterfinals',
  'semifinals': 'Semifinals',
  'final': 'Final',
  '3rd-place-match': 'Third Place',
};

function mapBracketTeam(t: any): BracketTeam {
  const crestUrl: string | null = t.logo ?? t.logos?.[0]?.href ?? null;
  return {
    id: String(t.id),
    name: t.displayName ?? t.name ?? t.abbreviation,
    abbr: t.abbreviation,
    crestUrl,
    placeholder: !(crestUrl && crestUrl.includes('/countries/')),
  };
}

function mapBracketMatch(ev: any): BracketMatch | null {
  const comp = ev.competitions?.[0];
  const competitors: any[] = comp?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === 'home');
  const away = competitors.find((c: any) => c.homeAway === 'away');
  if (!comp || !home || !away) return null;

  const status = ev.status;
  if (!status?.type) return null;

  const state = mapState(status.type.state, status.type.completed);
  const note = comp.notes?.[0]?.text ?? null;
  const winnerId = home.winner
    ? String(home.team.id)
    : away.winner
    ? String(away.team.id)
    : null;

  return {
    id: String(ev.id),
    round: ev.season?.slug ?? '',
    kickoff: ev.date ?? '',
    home: mapBracketTeam(home.team),
    away: mapBracketTeam(away.team),
    homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
    awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
    state,
    statusDetail: status.type.shortDetail ?? '',
    statusName: status.type.name ?? '',
    minute: state === 'live' ? (status.displayClock ?? null) : null,
    winnerId,
    note,
  };
}

export function mapBracket(raw: unknown): BracketRound[] {
  const events: any[] = (raw as any)?.events ?? [];

  // group events by round slug, preserving bracket order within each round
  const bySlug = new Map<string, BracketMatch[]>();
  for (const ev of events) {
    const slug: string = ev.season?.slug ?? '';
    if (!slug) continue;
    const match = mapBracketMatch(ev);
    if (!match) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push(match);
  }

  // return rounds in fixed order, only including those present
  return ROUND_ORDER.filter((slug) => bySlug.has(slug)).map((slug) => ({
    slug,
    name: ROUND_NAMES[slug] ?? slug,
    matches: bySlug.get(slug)!,
  }));
}
