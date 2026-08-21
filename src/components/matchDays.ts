import type { Match } from '@/server/data/types';
import type { Locale } from '@/i18n/config';
import { formatDate } from '@/i18n/format';
import { getTranslator } from '@/i18n/translate';

export interface DayGroup {
  key: string;
  label: string;
  matches: Match[];
}

/**
 * A kickoff's day, phrased the way someone would say it out loud.
 *
 * The single relative-day formatter for the whole app: the band, the home
 * tiles and the Now view all read from here, because three copies of this
 * drifted apart within a day of being written.
 *
 * Caller must pass the reader's clock — see LocalTime for why this must never
 * run on the server.
 */
export function relativeDay(iso: string, now: Date, locale: Locale): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || Number.isNaN(now.getTime())) return null;
  const days = Math.round(
    (
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    ) / 86_400_000,
  );
  const t = getTranslator(locale);
  if (days === 0) return t('time.today');
  if (days === 1) return t('time.tomorrow');
  if (days === -1) return t('time.yesterday');
  if (days > 1 && days < 7) return formatDate(d, locale, { weekday: 'long' });
  return formatDate(d, locale, { weekday: 'long', month: 'short', day: 'numeric' });
}

export const dayHeading = relativeDay;

export function groupByDay(matches: Match[], now: Date, locale: Locale): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  const t = getTranslator(locale);
  for (const m of matches) {
    const date = new Date(m.kickoff);
    const hasValidKickoff = !Number.isNaN(date.getTime());
    const key = hasValidKickoff ? date.toDateString() : `invalid:${m.id}`;
    const existing = groups.get(key);
    if (existing) existing.matches.push(m);
    else groups.set(key, {
      key,
      label: relativeDay(m.kickoff, now, locale) ?? t('common.unavailable'),
      matches: [m],
    });
  }
  // Array.from rather than spread: the repo targets a TS lib without
  // downlevelIteration, so spreading a Map iterator does not compile.
  return Array.from(groups.values());
}
