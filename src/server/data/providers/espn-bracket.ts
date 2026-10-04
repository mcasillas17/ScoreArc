import type { BracketRound, BracketMatch, BracketTeam, KnockoutRoundSlug } from '../types';
import { mapState } from '../state';
import { flaggedWinnerId, isScoreboardCount, parseShootout, shootoutTotals, shootoutWinnerId } from './espn-matches';

const ROUND_ORDER = [
  'round-of-32',
  'round-of-16',
  'quarterfinals',
  'semifinals',
  'final',
  '3rd-place-match',
] as const satisfies readonly KnockoutRoundSlug[];

// ESPN renamed some rounds across editions: older World Cups (1998-2010) tag the
// Round of 16 as `second-round`, and 2002 uses `third-place`. Normalize so every
// edition buckets into the same canonical slugs the bracket builder expects.
const SLUG_ALIAS: Record<string, KnockoutRoundSlug> = {
  'second-round': 'round-of-16',
  'third-place': '3rd-place-match',
};
const isKnockoutRoundSlug = (slug: string): slug is KnockoutRoundSlug =>
  (ROUND_ORDER as readonly string[]).includes(slug);

const normSlug = (slug: string): KnockoutRoundSlug | null => {
  const normalized = SLUG_ALIAS[slug] ?? slug;
  return isKnockoutRoundSlug(normalized) ? normalized : null;
};

// ESPN mis-tags a few specific historical knockout matches. These are finished,
// immutable records, so correct them precisely by ESPN event id.
const EVENT_SLUG_OVERRIDE: Record<string, KnockoutRoundSlug> = {
  // 2010 WC quarterfinal Paraguay 0–1 Spain is tagged `group-stage` by ESPN,
  // which would drop it and leave only 3 QFs. It's the fourth quarterfinal.
  '264118': 'quarterfinals',
};

// Canonical round slug for an event: a per-event correction wins over the
// season-slug alias mapping.
const roundSlug = (ev: any): KnockoutRoundSlug | null =>
  EVENT_SLUG_OVERRIDE[String(ev?.id)] ?? normSlug(ev?.season?.slug ?? '');

function mapBracketTeam(t: any): BracketTeam {
  // `||`, not `??`: ESPN sends an empty logo string for a placeholder slot, and
  // "no crest" is null in the contract (the Go mapper agrees).
  const crestUrl: string | null = t.logo || t.logos?.[0]?.href || null;
  const name = t.displayName ?? t.name ?? t.abbreviation;
  return {
    id: String(t.id),
    name,
    abbr: t.abbreviation,
    crestUrl,
    placeholder: !crestUrl && /\b(winner|loser|tbd|to be determined)\b/i.test(name),
  };
}

function mapBracketMatch(ev: any, slug: KnockoutRoundSlug): BracketMatch | null {
  const comp = ev.competitions?.[0];
  const competitors: any[] = comp?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === 'home');
  const away = competitors.find((c: any) => c.homeAway === 'away');
  if (!comp || !home || !away) return null;

  const status = ev.status;
  if (!status?.type) return null;

  // A malformed structured total rejects the bracket by the scoreboard window's
  // rule, also on a season without bracket dates, which reads one scoreboard.
  for (const competitor of [home, away]) {
    if (!isScoreboardCount(competitor.shootoutScore)) throw new Error('Malformed scoreboard score');
  }
  const state = mapState(status.type.state, status.type.completed);
  const note = comp.notes?.[0]?.text ?? null;
  const homeTeam = mapBracketTeam(home.team);
  const awayTeam = mapBracketTeam(away.team);
  // A decisive penalty shootout IS the result, so its score decides the winner
  // ahead of the `winner` flag — ESPN sets that flag inconsistently on shootout
  // matches: sometimes it's missing (1998), sometimes it's plain wrong (2010's
  // R16 marks Japan, not Paraguay, despite Paraguay winning the shootout 5–3).
  // The scoreboard's tiers decide it (structured totals, then the anchored
  // note), and only once the match is over: a live shootout's totals are partial.
  const shootout = shootoutTotals(home.shootoutScore, away.shootoutScore) ?? parseShootout(note, homeTeam.name, awayTeam.name);
  const winnerId = (state === 'finished' ? shootoutWinnerId(shootout, homeTeam.id, awayTeam.id) : null) ?? flaggedWinnerId(home, away);

  return {
    id: String(ev.id),
    round: slug,
    kickoff: ev.date ?? '',
    home: homeTeam,
    away: awayTeam,
    homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
    awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
    state,
    statusDetail: status.type.shortDetail ?? '',
    statusName: status.type.name ?? '',
    minute: state === 'live' ? status.displayClock || null : null,
    winnerId,
    note,
  };
}

export function mapBracket(raw: unknown): BracketRound[] {
  const events: any[] = (raw as any)?.events ?? [];

  // group events by round slug, preserving bracket order within each round
  const bySlug = new Map<KnockoutRoundSlug, BracketMatch[]>();
  for (const ev of events) {
    const slug = roundSlug(ev);
    if (!slug) continue;
    const match = mapBracketMatch(ev, slug);
    if (!match) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push(match);
  }

  // return rounds in fixed order, only including those present
  return ROUND_ORDER.filter((slug) => bySlug.has(slug)).map((slug) => ({
    slug,
    matches: bySlug.get(slug)!,
  }));
}
