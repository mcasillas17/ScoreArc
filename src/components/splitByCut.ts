import type { Standing } from '@/server/data/types';

// Split a league table into the teams inside the qualification cut and the rest.
// Order is preserved (the caller passes rows already ranked by the provider).
// `cut` is clamped to [1, n-1] so the dial/table always show both tiers.
export function splitByCut(
  standings: Standing[],
  cut: number,
): { inCut: Standing[]; out: Standing[] } {
  const n = standings.length;
  const c = Math.max(1, Math.min(cut, Math.max(1, n - 1)));
  return {
    inCut: standings.filter((s) => s.rank <= c),
    out: standings.filter((s) => s.rank > c),
  };
}
