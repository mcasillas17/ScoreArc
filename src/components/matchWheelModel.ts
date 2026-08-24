import type { Match } from '@/server/data/types';

/**
 * The drum's single ordering: chronological by kickoff, oldest first. No
 * regrouping by state — finished, live and upcoming interleave exactly as
 * their kickoffs fall, so the drum reads as one timeline rather than three
 * lists glued together.
 *
 * `Array.prototype.sort` is stable (spec-guaranteed since ES2019), so matches
 * sharing a kickoff instant keep their input order rather than shuffling on
 * every poll.
 */
export function wheelOrder(matches: Match[]): Match[] {
  return [...matches].sort(
    (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
  );
}

/**
 * Where the drum opens, as an index into an already-`wheelOrder()`ed array:
 * the first live match; else the first scheduled match; else the LAST
 * finished match (the most recent real thing to show in a season gap between
 * rounds); else 0.
 */
export function initialIndex(ordered: Match[]): number {
  const live = ordered.findIndex((m) => m.state === 'live');
  if (live !== -1) return live;

  const scheduled = ordered.findIndex((m) => m.state === 'scheduled');
  if (scheduled !== -1) return scheduled;

  const lastFinished = ordered.map((m) => m.state).lastIndexOf('finished');
  if (lastFinished !== -1) return lastFinished;

  return 0;
}

/**
 * Ids whose home or away score changed between two polls — the goal-flash
 * input. Only matches present in BOTH lists are compared: a match entering or
 * leaving the feed between polls is not a score change, however different its
 * score looks the first time it's seen.
 */
export function scoreChanges(prev: Match[], next: Match[]): Set<string> {
  const prevById = new Map(prev.map((m) => [m.id, m]));
  const changed = new Set<string>();
  for (const n of next) {
    const p = prevById.get(n.id);
    if (!p) continue;
    if (p.homeScore !== n.homeScore || p.awayScore !== n.awayScore) {
      changed.add(n.id);
    }
  }
  return changed;
}
