import type { Standing } from '@/server/data/types';

// Split a league table into the teams inside the qualification cut and the rest.
// Order is preserved (the caller passes rows already ranked by the provider).
// `cut` is clamped to [1, n-1] so the dial/table always show both tiers.
export function splitByCut(
  standings: Standing[],
  cut: number,
): { inCut: Standing[]; out: Standing[]; started: boolean } {
  const n = standings.length;
  const c = Math.max(1, Math.min(cut, Math.max(1, n - 1)));

  // Before a ball is kicked the provider ranks the table alphabetically and
  // still emits rank 1..n, so a cut applied to it claims the alphabetically
  // first `cut` clubs are through. The rule lives here rather than in the two
  // components that consume this — LeagueLadder and LeagueDial both split on
  // the cut, and fixing only one of them is how this class of bug spreads.
  const started = standings.some((s) => s.played > 0);
  if (!started) return { inCut: [], out: standings, started };

  return {
    inCut: standings.filter((s) => s.rank <= c),
    out: standings.filter((s) => s.rank > c),
    started,
  };
}
