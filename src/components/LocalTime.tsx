'use client';

import { useEffect, useState } from 'react';
import { relativeDay } from './matchDays';
import { useLanguage, type Language } from './LanguageProvider';

// Kickoff times follow the app's language too: es-MX renders a 24-hour clock,
// so "8:00 PM" becomes "20:00" rather than an English time on a Spanish page.
const LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-MX' };

export type LocalTimeMode = 'time' | 'day' | 'dayTime';

/**
 * The reader's clock, null until mount.
 *
 * Exported because aria-labels need the same value: a label is a string
 * attribute, so it cannot contain a <LocalTime> element, and a component that
 * renders the day visually while its own aria-label omits it has fixed the
 * problem only for people who can see it.
 */
export function useLocalNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  return now;
}

/** The same formatting as the component, for callers that need a string. */
export function localTimeText(
  iso: string,
  mode: LocalTimeMode,
  now: Date,
  language: Language = 'en',
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(LOCALE[language] ?? LOCALE.en, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (mode === 'time') return time;
  const day = relativeDay(iso, now, language);
  return mode === 'day' ? day : `${day} ${time}`;
}

/**
 * A kickoff rendered on the **reader's** clock.
 *
 * Every `toLocale*` call resolves against the machine it runs on, and Vercel
 * runs UTC. A kickoff at 19:00 in Mexico City is 01:00 the next day in UTC, so
 * formatting on the server puts the wrong day *and* the wrong hour in front of
 * every reader outside UTC — and, unlike a bucketing decision, a string baked
 * into server-rendered HTML is never corrected afterwards.
 *
 * So nothing is formatted until mount. Before then this renders an em dash of
 * the same size, which is stable in both passes and therefore cannot produce a
 * hydration mismatch.
 *
 * This is not hypothetical: the first cut of the home tiles formatted on the
 * server and read "Next: AME v CAZ, Thursday" for a match kicking off that
 * evening. It is invisible in local development, where the dev server and the
 * browser share a timezone — only production shows it.
 */
export default function LocalTime({ iso, mode = 'time' }: { iso: string; mode?: LocalTimeMode }) {
  const now = useLocalNow();
  const { language } = useLanguage();
  if (!now) return <span className="lt-pending" aria-hidden>—</span>;
  const text = localTimeText(iso, mode, now, language);
  return text ? <>{text}</> : null;
}
