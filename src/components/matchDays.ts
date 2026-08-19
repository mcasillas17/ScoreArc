import type { Match } from '@/server/data/types';

export interface DayGroup {
  key: string;
  label: string;
  matches: Match[];
}

export function dayHeading(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round(
    (new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function groupByDay(matches: Match[], now: Date): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const m of matches) {
    const key = new Date(m.kickoff).toDateString();
    const existing = groups.get(key);
    if (existing) existing.matches.push(m);
    else groups.set(key, { key, label: dayHeading(m.kickoff, now), matches: [m] });
  }
  // Array.from rather than spread: the repo targets a TS lib without
  // downlevelIteration, so spreading a Map iterator does not compile.
  return Array.from(groups.values());
}

