import type { CareerStint, GameLogRow, PlayerProfile, PlayerSeasonTotal, Team } from '../types';

/** Profile without the blocks that come from the other two endpoints. */
export type AthleteIdentity = Omit<PlayerProfile, 'gameLog' | 'gameLogLabel' | 'career'>;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `/athletes/{id}` -- identity plus the pre-aggregated season summary.
 *
 * `statsSummary` keeps both the display string and the numeric value because
 * they are not always the same fact: starts-subIns arrives as "5 (0)" with
 * value 5, and rendering the value alone silently discards the substitute
 * appearances.
 */
export function mapAthleteProfile(raw: unknown): AthleteIdentity | null {
  const a: any = (raw as any)?.athlete;
  if (!a || typeof a.displayName !== 'string') return null;

  const team: Team | null = a.team
    ? {
        id: String(a.team.id ?? ''),
        name: a.team.displayName ?? '',
        abbr: a.team.abbreviation ?? '',
        crestUrl: a.team.logos?.[0]?.href ?? a.team.logo ?? null,
      }
    : null;

  const totals: PlayerSeasonTotal[] = (a.statsSummary?.statistics ?? []).map((s: any): PlayerSeasonTotal => ({
    name: String(s?.name ?? ''),
    label: s?.displayName ?? '',
    display: s?.displayValue ?? '',
    value: num(s?.value),
  }));

  return {
    id: String(a.id ?? ''),
    name: a.displayName,
    age: num(a.age),
    position: a.position?.displayName ?? '',
    jersey: a.jersey != null ? String(a.jersey) : null,
    nationality: a.citizenship ?? null,
    flagUrl: a.flag?.href ?? null,
    headshotUrl: a.headshot?.href ?? null,
    team,
    seasonLabel: a.statsSummary?.displayName ?? '',
    totals,
  };
}

/**
 * `/athletes/{id}/overview` -- the last-five game log.
 *
 * The log is column-oriented: `names` holds the column keys and each event's
 * `stats` holds positional strings aligned to them. The first column is the
 * appearance ("Started" / "Sub"), which is a word, not a number.
 *
 * Column order is the provider's to change, so the names array is read from
 * the payload rather than hardcoded -- a hardcoded order would keep parsing
 * successfully while shifting every value one column to the left.
 */
export function mapAthleteOverview(raw: unknown): { label: string; rows: GameLogRow[] } {
  const log: any = (raw as any)?.gameLog ?? {};
  const block: any = log.statistics?.[0] ?? {};
  const names: string[] = Array.isArray(block.names) ? block.names : [];
  const events: any[] = Array.isArray(block.events) ? block.events : [];
  if (names.length === 0 || events.length === 0) return { label: '', rows: [] };

  const rows: GameLogRow[] = events.map((e: any): GameLogRow => {
    const values: string[] = Array.isArray(e?.stats) ? e.stats : [];
    const stats: Record<string, number | null> = {};
    // Index 0 is the appearance word, not a stat.
    for (let i = 1; i < names.length; i++) {
      stats[names[i]] = num(values[i]);
    }
    return {
      eventId: String(e?.eventId ?? ''),
      appearance: values[0] ?? '',
      stats,
    };
  });
  return { label: log.displayName ?? '', rows };
}

/** `/athletes/{id}/bio` -- career club history, newest first as delivered. */
export function mapAthleteBio(raw: unknown): CareerStint[] {
  const history: any[] = Array.isArray((raw as any)?.teamHistory) ? (raw as any).teamHistory : [];
  return history
    .filter((t: any) => t && t.displayName)
    .map((t: any): CareerStint => ({
      teamId: String(t.id ?? ''),
      teamName: t.displayName,
      crestUrl: t.logo ?? null,
      seasons: t.seasons ?? '',
    }));
}
