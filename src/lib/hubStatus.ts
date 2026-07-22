import type { Match } from '@/server/data/types';

export type HubStatus = 'live' | 'upcoming' | 'ongoing' | 'finished';

// A competition's headline status for the Hub tile.
// `started` = the tournament is already underway (some match finished, or the
// knockout bracket has a decided match) even if every fixture currently on the
// scoreboard is scheduled — so a mid-tournament competition never reads as
// "upcoming" just because its next matches haven't kicked off yet.
// `finished` = the tournament is complete (its final is decided / champion
// crowned) — so a done tournament reads "finished", not "in progress".
export function hubStatus(matches: Match[], started = false, finished = false): HubStatus {
  if (matches.some((x) => x.state === 'live')) return 'live';
  if (finished) return 'finished';
  if (started) return 'ongoing';
  if (matches.length > 0 && matches.every((x) => x.state === 'scheduled')) return 'upcoming';
  return 'ongoing';
}
