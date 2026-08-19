'use client';

import { useEffect, useState } from 'react';
import { relativeDay } from './matchDays';

export type LocalTimeMode = 'time' | 'day' | 'dayTime';

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
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  if (!now) return <span className="lt-pending" aria-hidden>—</span>;

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mode === 'time') return <>{time}</>;

  const day = relativeDay(iso, now);
  return <>{mode === 'day' ? day : `${day} ${time}`}</>;
}
