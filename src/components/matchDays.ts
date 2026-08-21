import type { Match } from '@/server/data/types';
import type { Language } from './LanguageProvider';

// Spoken-language day names. "Today" is not a date format, so Intl cannot
// supply it -- these are the only two sets, and adding a language means adding
// a row here rather than threading a dictionary through every caller.
const RELATIVE: Record<Language, { today: string; tomorrow: string; yesterday: string }> = {
  en: { today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday' },
  es: { today: 'Hoy', tomorrow: 'Mañana', yesterday: 'Ayer' },
};

// The locale the *app* is set to, not the one the browser happens to prefer.
// toLocaleDateString([]) reads the machine, so a reader who chose Spanish on an
// English laptop still got "Saturday, Oct 17" under an otherwise Spanish page.
const LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-MX' };

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
export function relativeDay(iso: string, now: Date, language: Language = 'en'): string {
  const d = new Date(iso);
  const days = Math.round(
    (new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000,
  );
  const words = RELATIVE[language] ?? RELATIVE.en;
  const locale = LOCALE[language] ?? LOCALE.en;
  if (days === 0) return words.today;
  if (days === 1) return words.tomorrow;
  if (days === -1) return words.yesterday;
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  return d.toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' });
}

export const dayHeading = relativeDay;

export function groupByDay(matches: Match[], now: Date, language: Language = 'en'): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const m of matches) {
    const key = new Date(m.kickoff).toDateString();
    const existing = groups.get(key);
    if (existing) existing.matches.push(m);
    else groups.set(key, { key, label: relativeDay(m.kickoff, now, language), matches: [m] });
  }
  // Array.from rather than spread: the repo targets a TS lib without
  // downlevelIteration, so spreading a Map iterator does not compile.
  return Array.from(groups.values());
}

