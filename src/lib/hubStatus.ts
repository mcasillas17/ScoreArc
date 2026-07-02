import type { Match } from '@/server/data/types';

export type HubStatus = 'live' | 'upcoming' | 'ongoing';

// A competition's headline status for the Hub tile.
export function hubStatus(matches: Match[]): HubStatus {
  if (matches.some((x) => x.state === 'live')) return 'live';
  if (matches.length > 0 && matches.every((x) => x.state === 'scheduled')) return 'upcoming';
  return 'ongoing';
}
