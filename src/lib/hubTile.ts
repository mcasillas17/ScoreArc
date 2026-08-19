import type { Match, Group } from '@/server/data/types';
import { matchPriority } from '@/server/data/matchPriority';
import type { HubStatus } from './hubStatus';

export interface TileFacts {
  liveCount: number;
  /** The live match a tile headlines with, if any. */
  liveLine: string | null;
  /** The next kickoff, phrased relative to the reader's week. */
  nextLine: string | null;
  /** Who is top of the table. Leagues only — a cup has no leader. */
  leaderLine: string | null;
}

function abbrScore(m: Match): string {
  return `${m.home.abbr} ${m.homeScore ?? 0}–${m.awayScore ?? 0} ${m.away.abbr}`;
}

function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (days <= 6) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * What a competition tile can truthfully say.
 *
 * Pure so the rules are testable without a render: the sub-line a tile shows
 * used to be a bare count ("0 matches"), which is both uninformative and, for a
 * competition whose fixtures fall outside the fetched window, misleading.
 */
export function tileFacts(matches: Match[], standings: Group[], now: Date): TileFacts {
  const { live, upcoming } = matchPriority(matches, now);
  const leader = standings[0]?.standings?.[0];

  return {
    liveCount: live.length,
    liveLine: live.length > 0 ? abbrScore(live[0]) : null,
    nextLine: upcoming.length > 0
      ? `${upcoming[0].home.abbr} v ${upcoming[0].away.abbr}, ${dayLabel(upcoming[0].kickoff, now)}`
      : null,
    // Only once someone has actually played: a table before kick-off is
    // alphabetical, and printing "Leaders: América" then would be a fiction.
    leaderLine: leader && leader.played > 0
      ? `${leader.team.name}, ${leader.points} pts`
      : null,
  };
}

/**
 * The one line under a competition's name.
 *
 * Ordered by what a visitor most wants to know: something in play, then what is
 * next, then who is winning. A pre-season competition deliberately gets only
 * its next fixture — never a standing, which is the E0 regression.
 */
export function tileSubLine(
  status: HubStatus,
  facts: TileFacts,
  champion: string | null,
  seasonLabel: string,
): string {
  if (status === 'finished') {
    return champion ? `${champion} — champions` : `${seasonLabel} · complete`;
  }
  if (facts.liveCount > 0 && facts.liveLine) {
    return facts.liveCount > 1
      ? `${facts.liveCount} live · ${facts.liveLine}`
      : facts.liveLine;
  }
  if (status === 'upcoming') {
    return facts.nextLine ? `Starts ${facts.nextLine}` : `${seasonLabel} season`;
  }
  if (facts.nextLine) return `Next: ${facts.nextLine}`;
  if (facts.leaderLine) return `Leaders: ${facts.leaderLine}`;
  return `${seasonLabel} season`;
}
