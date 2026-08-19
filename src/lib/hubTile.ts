import type { Match, Group } from '@/server/data/types';
import { matchPriority } from '@/server/data/matchPriority';
import type { HubStatus } from './hubStatus';

export interface TileFacts {
  liveCount: number;
  /** The live match a tile headlines with, if any. */
  liveLine: string | null;
  /** The next fixture, teams only. Its DAY AND TIME are deliberately absent:
   *  this runs on the server, where every toLocale* call resolves against
   *  UTC, and a formatted string baked into HTML is never corrected on the
   *  client. The tile pairs this with <LocalTime> for the when. */
  nextLine: string | null;
  nextKickoff: string | null;
  /** Who is top of the table. Leagues only — a cup has no leader. */
  leaderLine: string | null;
}

function abbrScore(m: Match): string {
  return `${m.home.abbr} ${m.homeScore ?? 0}–${m.awayScore ?? 0} ${m.away.abbr}`;
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
      ? `${upcoming[0].home.abbr} v ${upcoming[0].away.abbr}`
      : null,
    nextKickoff: upcoming.length > 0 ? upcoming[0].kickoff : null,
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
 * Returns the text and, separately, the kickoff it refers to — never a
 * formatted date. The tile renders the `when` through <LocalTime>, because
 * this function runs on the server and the server's clock is not the reader's.
 *
 * Ordered by what a visitor most wants to know: something in play, then what is
 * next, then who is winning. A pre-season competition deliberately gets only
 * its next fixture — never a standing, which is the E0 regression.
 */
export interface TileSubLine {
  text: string;
  /** ISO kickoff to append as a local day, or null when the text stands alone. */
  when: string | null;
}

export function tileSubLine(
  status: HubStatus,
  facts: TileFacts,
  champion: string | null,
  seasonLabel: string,
): TileSubLine {
  if (status === 'finished') {
    return { text: champion ? `${champion} — champions` : `${seasonLabel} · complete`, when: null };
  }
  if (facts.liveCount > 0 && facts.liveLine) {
    return {
      text: facts.liveCount > 1 ? `${facts.liveCount} live · ${facts.liveLine}` : facts.liveLine,
      when: null,
    };
  }
  if (status === 'upcoming') {
    return facts.nextLine
      ? { text: `Starts ${facts.nextLine}`, when: facts.nextKickoff }
      : { text: `${seasonLabel} season`, when: null };
  }
  if (facts.nextLine) return { text: `Next: ${facts.nextLine}`, when: facts.nextKickoff };
  if (facts.leaderLine) return { text: `Leaders: ${facts.leaderLine}`, when: null };
  return { text: `${seasonLabel} season`, when: null };
}
