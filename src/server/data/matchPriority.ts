import type { Match } from './types';

export interface PrioritisedMatches {
  live: Match[];
  upcoming: Match[];
  recent: Match[];
}

export interface PriorityWindows {
  /** How far back a finished match still counts as "just finished". */
  recentWindowMs?: number;
  /** How long past kickoff a still-scheduled match counts as imminent. */
  kickoffGraceMs?: number;
}

export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const KICKOFF_GRACE_MS = 3 * 60 * 60 * 1000;

/**
 * The one rule both entry points answer: live, then what is next, then what
 * just happened.
 *
 * Deliberately timezone-agnostic — it compares instants and has no concept of
 * "today". The local-date split ("Later today" vs "This week") happens in the
 * rendering component after mount, because the server runs UTC and a reader in
 * UTC-6 disagrees with it about which day an 8pm kickoff falls on. A "today"
 * bucket here would push that hydration mismatch into every caller.
 */
export function matchPriority(
  matches: Match[],
  now: Date,
  windows: PriorityWindows = {},
): PrioritisedMatches {
  return prioritiseBy(matches, (m) => m, now, windows);
}

/**
 * The same rule over anything that carries a match — a `{ competition, match }`
 * entry, say.
 *
 * Exists so callers never have to map bucketed `Match` objects back to whatever
 * wrapped them. The first attempt did that through a Map and silently dropped
 * every entry after the first whenever two of them shared a Match object; a
 * generic bucket cannot have that bug because it never loses the wrapper.
 */
export function prioritiseBy<T>(
  items: T[],
  getMatch: (item: T) => Match,
  now: Date,
  { recentWindowMs = RECENT_WINDOW_MS, kickoffGraceMs = KICKOFF_GRACE_MS }: PriorityWindows = {},
): { live: T[]; upcoming: T[]; recent: T[] } {
  const t = now.getTime();
  const live: T[] = [];
  const upcoming: T[] = [];
  const recent: T[] = [];

  for (const item of items) {
    const m = getMatch(item);
    const kickoff = new Date(m.kickoff).getTime();

    // A live match is live regardless of what its kickoff says.
    if (m.state === 'live') {
      live.push(item);
      continue;
    }

    // Every comparison against NaN is false, so an unparseable kickoff would
    // fall through into whichever bucket came last rather than being skipped.
    if (Number.isNaN(kickoff)) continue;

    if (m.state === 'scheduled') {
      // Past kickoff but still scheduled means either "about to start" or
      // "postponed". The grace tells them apart: advertising a fixture from
      // last Tuesday under "Next up" is worse than showing nothing.
      if (kickoff >= t - kickoffGraceMs) upcoming.push(item);
      continue;
    }

    // Both bounds matter. Without `kickoff <= t`, a fixture dated in the
    // future but already marked finished — ESPN reports every `post` state as
    // finished, including abandoned ties — yields a negative age, satisfies
    // the window, and sorts to the TOP of "just finished".
    if (kickoff <= t && t - kickoff <= recentWindowMs) recent.push(item);
  }

  const asc = (a: T, b: T) =>
    new Date(getMatch(a).kickoff).getTime() - new Date(getMatch(b).kickoff).getTime();
  live.sort(asc);
  upcoming.sort(asc);
  recent.sort((a, b) => -asc(a, b));

  return { live, upcoming, recent };
}
