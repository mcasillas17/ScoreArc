import type { Match, Shootout, Team } from '../types';
import type { PlayoffFormat } from '../competitions';
import { femenilLegRound, legPrefix, playedLegStatus, providerLeg } from './espn-leg';
import { mapState } from '../state';

// A provider shootout total (summary header or scoreboard competitor), read the
// way the Go parser reads it: a non-negative integer as a number or numeric
// string, with null and '' read as 0; absent is "not supplied" (undefined) and
// anything else is malformed (NaN). Safe integers only.
function shootoutTotal(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return 0;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim() || 0) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
}

/**
 * A scoreboard competitor count (score or shootoutScore) as the scoreboard
 * accepts it: absent, null, '', a digit string or a non-negative integer. The
 * summary header's wider rule (shootoutTotal) does not apply to the
 * scoreboard's competitor shape. Same as the Go scoreboardTotal.
 */
export function isScoreboardCount(raw: unknown): boolean {
  return raw == null || raw === '' || (typeof raw === 'string' && /^\d+$/.test(raw)) ||
    (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0);
}

/**
 * A pair of provider shootout totals: both supplied and valid and not both
 * zero, or null. The structured tier of the shootout precedence (T16.2):
 * summary header > scoreboard competitors > note > null.
 */
export function shootoutTotals(home: unknown, away: unknown): Shootout | null {
  const h = shootoutTotal(home);
  const a = shootoutTotal(away);
  if (h === undefined || a === undefined || Number.isNaN(h) || Number.isNaN(a) || (h === 0 && a === 0)) return null;
  return { homeScore: h, awayScore: a };
}

/**
 * The side a decisive shootout aggregate names -- homeId or awayId -- or null
 * when there is none or it is level. For a finished match it outranks the
 * provider's winner flags, which ESPN sets inconsistently on shootouts (the
 * bracket mapper's shootout-first rule). Same as the Go ShootoutWinner.
 */
export function shootoutWinnerId(shootout: Shootout | null, homeId: string, awayId: string): string | null {
  if (!shootout || shootout.homeScore === shootout.awayScore) return null;
  return shootout.homeScore > shootout.awayScore ? homeId : awayId;
}

/**
 * The aggregate from a match note, e.g. "Paraguay advance 4-3 on penalties".
 * The note names its winner first; only an exact (case-insensitive) match to a
 * side's name attributes the score -- anything else is unknown (null), never a
 * guessed orientation. Same rule as the Go ParseShootoutNote.
 */
export function parseShootout(note: string | null, homeName: string, awayName: string, twoLegged = false): Shootout | null {
  if (twoLegged) note = note?.replace(legPrefix, '').replace(/^[\s–—-]+/, '') ?? null;
  const score = note?.match(/(\d+)\s*[-–]\s*(\d+)\s+on penalties/i);
  if (!score) return null;
  const winner = Math.max(Number(score[1]), Number(score[2]));
  const loser = Math.min(Number(score[1]), Number(score[2]));
  const named = note!.match(/^\s*(.+?)\s+(?:advances?|wins?)\b/i)?.[1].trim().toLowerCase();
  if (homeName && named === homeName.trim().toLowerCase()) return { homeScore: winner, awayScore: loser };
  if (awayName && named === awayName.trim().toLowerCase()) return { homeScore: loser, awayScore: winner };
  return null;
}

// A series shootout can advance the side that lost the individual match.
export function matchResult(
  match: Pick<Match, 'home' | 'away' | 'homeScore' | 'awayScore' | 'state' | 'statusName' | 'note'>,
  structured: Shootout | null, flagged: string | null, round: ReturnType<typeof femenilLegRound>, ordinal: number | null,
) {
  const { home, away, homeScore, awayScore, state, statusName, note } = match;
  const shootout = structured ?? parseShootout(note, home.name, away.name, !!round);
  if (round) {
    let winnerId = null;
    if (state === 'finished' && playedLegStatus(statusName, round, ordinal) && homeScore != null && awayScore != null) {
      if (homeScore > awayScore) winnerId = home.id;
      if (awayScore > homeScore) winnerId = away.id;
    }
    return { winnerId, shootout };
  }
  return { winnerId: (state === 'finished' ? shootoutWinnerId(shootout, home.id, away.id) : null) ?? flagged, shootout };
}

function mapTeam(t: any): Team {
  return {
    id: String(t.id),
    name: t.displayName,
    abbr: t.abbreviation,
    crestUrl: t.logo || t.logos?.[0]?.href || null,
  };
}

/** The side ESPN flags as the winner, home first (Go flaggedWinnerID). */
export function flaggedWinnerId(home: any, away: any): string | null {
  return home?.winner ? String(home.team?.id) : away?.winner ? String(away.team?.id) : null;
}

/**
 * ESPN's own winner flag per scoreboard event. A finished match whose served
 * aggregate is level falls back to it -- never to a winner a superseded
 * aggregate derived (Go ResolveWinner). Aggregate shootouts never override a Femenil leg result.
 */
export function scoreboardWinnerFlags(raw: unknown, format?: PlayoffFormat): Map<string, string | null> {
  const flags = new Map<string, string | null>();
  for (const ev of (raw as any)?.events ?? []) {
    if (femenilLegRound(format, ev?.season?.slug)) continue;
    const competitors: any[] = ev?.competitions?.[0]?.competitors ?? [];
    flags.set(String(ev?.id), flaggedWinnerId(
      competitors.find((c) => c?.homeAway === 'home'), competitors.find((c) => c?.homeAway === 'away')));
  }
  return flags;
}

export function mapScoreboard(raw: unknown, format?: PlayoffFormat): Match[] {
  const events: any[] = (raw as any)?.events ?? [];
  return events.flatMap((ev) => {
    const comp = ev.competitions?.[0];
    const competitors: any[] = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    if (!comp || !home || !away) return [];
    const status = ev.status;
    const state = mapState(status.type.state, status.type.completed);
    const note = comp.notes?.[0]?.text ?? null;
    const scoreline = {
      home: mapTeam(home.team), away: mapTeam(away.team),
      homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
      awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
      state, statusName: status.type.name ?? '', note,
    };
    const round = femenilLegRound(format, ev.season?.slug);
    return {
      id: String(ev.id), kickoff: ev.date,
      minute: state === 'live' ? status.displayClock || null : null,
      statusDetail: status.type.shortDetail,
      ...scoreline,
      ...matchResult(scoreline, shootoutTotals(home.shootoutScore, away.shootoutScore),
        flaggedWinnerId(home, away), round, round ? providerLeg(comp.leg, comp.notes ?? []) : null),
      scorers: [],
      cards: [],
      shootoutDetail: null,
      stats: null,
      winProbability: null,
    };
  });
}
