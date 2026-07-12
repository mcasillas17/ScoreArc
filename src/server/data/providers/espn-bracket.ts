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

// ESPN renamed some rounds across editions: older World Cups (1998-2010) tag the
// Round of 16 as `second-round`, and 2002 uses `third-place`. Normalize so every
// edition buckets into the same canonical slugs the bracket builder expects.
const SLUG_ALIAS: Record<string, string> = {
  'second-round': 'round-of-16',
  'third-place': '3rd-place-match',
};
const normSlug = (slug: string): string => SLUG_ALIAS[slug] ?? slug;

// ESPN mis-tags a few specific historical knockout matches. These are finished,
// immutable records, so correct them precisely by ESPN event id.
const EVENT_SLUG_OVERRIDE: Record<string, string> = {
  // 2010 WC quarterfinal Paraguay 0–1 Spain is tagged `group-stage` by ESPN,
  // which would drop it and leave only 3 QFs. It's the fourth quarterfinal.
  '264118': 'quarterfinals',
};

// Canonical round slug for an event: a per-event correction wins over the
// season-slug alias mapping.
const roundSlug = (ev: any): string =>
  EVENT_SLUG_OVERRIDE[String(ev?.id)] ?? normSlug(ev?.season?.slug ?? '');

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
  // A decisive penalty shootout IS the result, so its score decides the winner
  // ahead of the `winner` flag — ESPN sets that flag inconsistently on shootout
  // matches: sometimes it's missing (1998), sometimes it's plain wrong (2010's
  // R16 marks Japan, not Paraguay, despite Paraguay winning the shootout 5–3).
  const hs = Number(home.shootoutScore);
  const as = Number(away.shootoutScore);
  const shootoutWinnerId =
    Number.isFinite(hs) && Number.isFinite(as) && hs !== as
      ? String((hs > as ? home : away).team.id)
      : null;
  const winnerId = shootoutWinnerId
    ? shootoutWinnerId
    : home.winner
    ? String(home.team.id)
    : away.winner
    ? String(away.team.id)
    : null;

  return {
    id: String(ev.id),
    round: roundSlug(ev),
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
    const slug: string = roundSlug(ev);
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
