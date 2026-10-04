import type { Match, Shootout, Team } from '../types';
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
 * The aggregate from a match note, e.g. "Paraguay advance 4-3 on penalties".
 * The note names its winner first; only an exact (case-insensitive) match to a
 * side's name attributes the score -- anything else is unknown (null), never a
 * guessed orientation. Same rule as the Go ParseShootoutNote.
 */
export function parseShootout(note: string | null, homeName: string, awayName: string): Shootout | null {
  const score = note?.match(/(\d+)\s*[-–]\s*(\d+)\s+on penalties/i);
  if (!score) return null;
  const winner = Math.max(Number(score[1]), Number(score[2]));
  const loser = Math.min(Number(score[1]), Number(score[2]));
  const named = note!.match(/^\s*(.+?)\s+(?:advances?|wins?)\b/i)?.[1].trim().toLowerCase();
  if (homeName && named === homeName.trim().toLowerCase()) return { homeScore: winner, awayScore: loser };
  if (awayName && named === awayName.trim().toLowerCase()) return { homeScore: loser, awayScore: winner };
  return null;
}

function mapTeam(t: any): Team {
  return {
    id: String(t.id),
    name: t.displayName,
    abbr: t.abbreviation,
    crestUrl: t.logo || t.logos?.[0]?.href || null,
  };
}

export function mapScoreboard(raw: unknown): Match[] {
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
    const homeTeam = mapTeam(home.team);
    const awayTeam = mapTeam(away.team);
    const winnerId = home.winner
      ? String(home.team.id)
      : away.winner
      ? String(away.team.id)
      : null;
    return {
      id: String(ev.id),
      kickoff: ev.date,
      state,
      minute: state === 'live' ? status.displayClock || null : null,
      statusDetail: status.type.shortDetail,
      statusName: status.type.name ?? '',
      home: homeTeam,
      away: awayTeam,
      homeScore: home.score != null && home.score !== '' ? Number(home.score) : null,
      awayScore: away.score != null && away.score !== '' ? Number(away.score) : null,
      winnerId,
      note,
      scorers: [],
      cards: [],
      // Structured totals outrank the note; a held summary header outranks both
      // (store.getMatches). Regulation scores above stay separate.
      shootout: shootoutTotals(home.shootoutScore, away.shootoutScore) ?? parseShootout(note, homeTeam.name, awayTeam.name),
      shootoutDetail: null,
      stats: null,
      winProbability: null,
    };
  });
}
