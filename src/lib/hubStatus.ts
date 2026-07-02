import type { Match } from '@/server/data/types';

export type HubStatus = 'live' | 'upcoming' | 'ongoing';

// A competition's headline status for the Hub tile.
// `started` = the tournament is already underway (some match finished, or the
// knockout bracket has a decided match) even if every fixture currently on the
// scoreboard is scheduled — so a mid-tournament competition never reads as
// "upcoming" just because its next matches haven't kicked off yet.
export function hubStatus(matches: Match[], started = false): HubStatus {
  if (matches.some((x) => x.state === 'live')) return 'live';
  if (started) return 'ongoing';
  if (matches.length > 0 && matches.every((x) => x.state === 'scheduled')) return 'upcoming';
  return 'ongoing';
}
