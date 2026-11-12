import type { Standing } from '@/server/data/types';

/**
 * The row highlight for one group-table row.
 *
 * Before a group has kicked off, the provider ranks it alphabetically and still
 * emits rank 1..n. Marking rows 1-2 as qualifying then states that the two
 * clubs whose names sort first are through — the same false claim the league
 * tables made by painting qualification zones over an alphabetical order.
 *
 * `started` is a property of the group, not the team, so it is threaded in
 * rather than derived per row.
 *
 * Third place is only a live chance where the competition races its thirds
 * (the World Cup's best-third places); in the Nations League it is nothing.
 */
export function groupRowClass(s: Standing, started: boolean, thirdPlaceRace = true): string {
  if (!started) return '';
  if (s.advanced || s.rank <= 2) return 'row-qualify';
  if (s.rank === 3 && thirdPlaceRace) return 'row-playoff';
  return '';
}
