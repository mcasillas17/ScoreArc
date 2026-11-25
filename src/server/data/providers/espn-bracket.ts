import { buildLigaMxBracket } from '../ligaMxBracket';
import type { PlayoffFormat } from '../competitions';
import { overallOrder, playoffTable, projectLiguilla } from '../liguillaProjection';
import type { Group, Standing, BracketRound, BracketMatch, BracketTeam, KnockoutRoundSlug } from '../types';
import { mapState } from '../state';
import { flaggedWinnerId, isScoreboardCount, matchResult, parseShootout, shootoutTotals, shootoutWinnerId } from './espn-matches';
import { liguillaLegRound, noteLeg, playedLegStatus, providerLeg } from './espn-leg';

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
  // Women's World Cup: `3rd-place` (2015-23), hyphenated rounds (2003-15).
  '3rd-place': '3rd-place-match',
  'quarter-finals': 'quarterfinals',
  'semi-finals': 'semifinals',
  // Liga MX tags its two-legged final `apertura---finals` / `clausura---finals`.
  finals: 'final',
};
const isKnockoutRoundSlug = (slug: string): slug is KnockoutRoundSlug =>
  (ROUND_ORDER as readonly string[]).includes(slug);

const normSlug = (slug: string, format?: PlayoffFormat): KnockoutRoundSlug | null => {
  if (format === 'nwsl' && slug === 'playoffs---championship') return 'final';
  // Leagues with a post-season prefix the round with its phase:
  // `playoffs---quarterfinals` (NWSL), `apertura---quarterfinals` (Liga MX).
  // The round is what follows; the phase is the season's business.
  const at = slug.lastIndexOf('---');
  const round = at < 0 ? slug : slug.slice(at + 3);
  const normalized = SLUG_ALIAS[round] ?? round;
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
const roundSlug = (ev: any, format?: PlayoffFormat): KnockoutRoundSlug | null =>
  EVENT_SLUG_OVERRIDE[String(ev?.id)] ?? normSlug(ev?.season?.slug ?? '', format);

export function isBracketPlaceholder(name: string, crestUrl: string | null): boolean {
  return !crestUrl && /\b(winner|loser|tbd|to be determined)\b/i.test(name);
}

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
    placeholder: isBracketPlaceholder(name, crestUrl),
  };
}

function mapBracketMatch(ev: any, slug: KnockoutRoundSlug, format?: PlayoffFormat): BracketMatch | null {
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
  const round = liguillaLegRound(format, slug);
  const legNumber = round ? providerLeg(comp.leg, comp.notes ?? []) : null;
  const scoreline = {
    home: mapBracketTeam(home.team), away: mapBracketTeam(away.team),
    homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
    awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
    state, statusName: status.type.name ?? '', note,
  };
  const { winnerId, shootout } = matchResult(scoreline, shootoutTotals(home.shootoutScore, away.shootoutScore),
    flaggedWinnerId(home, away), round, legNumber, format);
  return {
    id: String(ev.id),
    round: slug,
    kickoff: ev.date ?? '',
    ...scoreline,
    statusDetail: status.type.shortDetail ?? '',
    minute: state === 'live' ? status.displayClock || null : null,
    winnerId,
    ...(round && { legNumber }),
    ...(round && shootout ? { shootout } : {}),
  };
}

export function mapBracket(raw: unknown, format?: PlayoffFormat, groups: Group[] = []): BracketRound[] {
  const events: any[] = (raw as any)?.events ?? [];

  // group events by round slug, preserving bracket order within each round
  const bySlug = new Map<KnockoutRoundSlug, BracketMatch[]>();
  for (const ev of events) {
    const slug = roundSlug(ev, format);
    if (!slug) continue;
    const match = mapBracketMatch(ev, slug, format);
    if (!match) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push(match);
  }

  // return rounds in fixed order, only including those present
  return buildPlayoffBracket(ROUND_ORDER.filter(slug => bySlug.has(slug)).map(slug => ({ slug, matches: bySlug.get(slug)! })), format, groups);
}

/** Both stores present the same bracket from individual matches and the edition's regular-season tables. */
export function buildPlayoffBracket(rounds: BracketRound[], format?: PlayoffFormat, groups: Group[] = []): BracketRound[] {
  if (format === 'liga-mx-apertura') return buildLigaMxBracket(rounds, groups);
  if (!format) return rounds.map(r => ({ ...r, matches: mergeLegs(r.matches) }));
  const rows = playoffTable(groups, format);
  const finalTable = (format === 'nwsl' || rows.every(s => s.played === 14)) ? rows : [];
  const byTeam = new Map(finalTable.map(s => [s.team.id, s]));
  const seededTeam = (team: BracketTeam): BracketTeam => {
    const row = byTeam.get(team.id);
    return row ? { ...team, overallSeed: format === 'nwsl' ? row.rank : 1 + finalTable.filter(s => overallOrder(s, row) < 0).length } : team;
  };
  return (rounds.length ? rounds : projectLiguilla(groups, format) ?? []).map(round => {
    const matches = format === 'femenil-apertura' && rounds.length ? mergeLegs(round.matches, byTeam) : round.matches;
    return { ...round, matches: matches.map(m => ({ ...m, home: seededTeam(m.home), away: seededTeam(m.away) })) };
  });
}

function femenilTiebreak(second: BracketMatch, table: Map<string, Standing>): string | null {
  const { home, away } = second;
  if (second.round === 'final') {
    const pens = second.shootout ?? parseShootout(second.note, home.name, away.name, true);
    return shootoutWinnerId(pens, home.id, away.id);
  }
  const a = table.get(home.id), b = table.get(away.id);
  if (!a || !b) return null;
  const order = second.round === 'quarterfinals' ? a.rank - b.rank : overallOrder(a, b);
  return order < 0 ? home.id : order > 0 ? away.id : null;
}

// Reader rows retain the provider's ordinal in the note. If both sources
// name a leg they must agree, even when both matches ended with real scores.
function playedLeg(match: BracketMatch, ordinal: number): boolean {
  const number = match.legNumber === undefined ? noteLeg(match.note) : match.legNumber;
  return match.state === 'finished' && number === ordinal && playedLegStatus(match.statusName, match.round, ordinal);
}

// A two-legged tie (Nations League quarterfinals, a Liguilla) arrives as two
// events between the same pair. The bracket draws one tie per pair, so fold
// the legs into one match carrying the aggregate. Single-match rounds pass
// through untouched.
export function mergeLegs(matches: BracketMatch[], femenilTable?: Map<string, Standing>): BracketMatch[] {
  const ties = new Map<string, BracketMatch[]>();
  for (const m of matches) {
    const k = [m.home.id, m.away.id].sort().join('|');
    ties.set(k, [...(ties.get(k) ?? []), m]);
  }
  return [...ties.values()].map((legs) => {
    if (legs.length !== 2) return femenilTable ? { ...legs[0], detailMatch: legs[0], winnerId: null } : legs[0];
    const [first, second] = [...legs].sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    const scoreFor = (m: BracketMatch, teamId: string) =>
      m.home.id === teamId ? m.homeScore : m.awayScore;
    const total = (teamId: string) => {
      const a = scoreFor(first, teamId);
      const b = scoreFor(second, teamId);
      return a == null || (b == null && second.state === 'finished') ? null : a + (b ?? 0);
    };
    const homeScore = total(first.home.id);
    const awayScore = total(first.away.id);
    // Decided only once the second leg is over: the higher aggregate, else the
    // second leg's own winner (a shootout, already resolved by mapBracketMatch).
    let winnerId: string | null = null;
    const complete = femenilTable
      ? playedLeg(first, 1) && playedLeg(second, 2) && first.id !== second.id && Date.parse(first.kickoff) < Date.parse(second.kickoff) &&
        first.home.id === second.away.id && first.away.id === second.home.id
      : first.state === 'finished' && second.state === 'finished';
    if (complete && homeScore != null && awayScore != null) {
      winnerId = homeScore > awayScore ? first.home.id
        : awayScore > homeScore ? first.away.id
        : femenilTable ? femenilTiebreak(second, femenilTable) : second.winnerId;
    }
    const current = first.state === 'finished' ? second : first;
    return {
      ...first,
      id: second.id,
      ...(femenilTable && { detailMatch: current }),
      homeScore,
      awayScore,
      state: current.state,
      statusDetail: current.statusDetail,
      statusName: current.statusName,
      minute: current.minute,
      winnerId,
      note: second.note ?? first.note,
    };
  });
}
