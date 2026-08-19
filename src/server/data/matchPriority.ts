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
  { recentWindowMs = RECENT_WINDOW_MS, kickoffGraceMs = KICKOFF_GRACE_MS }: PriorityWindows = {},
): PrioritisedMatches {
  const t = now.getTime();
  const live: Match[] = [];
  const upcoming: Match[] = [];
  const recent: Match[] = [];

  for (const m of matches) {
    const kickoff = new Date(m.kickoff).getTime();

    // A live match is live regardless of what its kickoff says.
    if (m.state === 'live') {
      live.push(m);
      continue;
    }

    // Every comparison against NaN is false, so an unparseable kickoff would
    // fall through into whichever bucket came last rather than being skipped.
    if (Number.isNaN(kickoff)) continue;

    if (m.state === 'scheduled') {
      // Past kickoff but still scheduled means either "about to start" or
      // "postponed". The grace tells them apart: advertising a fixture from
      // last Tuesday under "Next up" is worse than showing nothing.
      if (kickoff >= t - kickoffGraceMs) upcoming.push(m);
      continue;
    }

    if (t - kickoff <= recentWindowMs) recent.push(m);
  }

  const asc = (a: Match, b: Match) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
  live.sort(asc);
  upcoming.sort(asc);
  recent.sort((a, b) => -asc(a, b));

  return { live, upcoming, recent };
}
