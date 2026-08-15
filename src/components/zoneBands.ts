import type { Standing } from '@/server/data/types';
import type { Zone, ZoneKind } from '@/server/data/competitions';

// A league table is not a flat list — it is a set of outcomes stacked on top of
// each other. The top of the Premier League is the Champions League; the bottom
// is the Championship. Liga MX's Liguilla cut is the degenerate case of this
// with exactly one boundary, which is why the older `qualification` prop only
// modelled one.
//
// A band is a contiguous run of the table sharing an outcome, plus the
// unmarked middle ground between zones ("mid-table"), which has no prize and
// no punishment and should read as neither.

export interface Band {
  kind: ZoneKind | 'mid';
  label: string;
  from: number;
  to: number;
  standings: Standing[];
}

// Zones are authored per season as rank ranges. They are clamped and sorted
// here rather than trusted, because a config that says "relegation 18-20" for a
// league ESPN reports with 18 rows would otherwise silently render an empty
// band — or worse, drop teams off the bottom of the table.
export function toBands(standings: Standing[], zones: Zone[]): Band[] {
  const n = standings.length;
  if (n === 0) return [];

  const clamped = zones
    .map((z) => ({
      ...z,
      from: Math.max(1, Math.min(z.from, n)),
      to: Math.max(1, Math.min(z.to, n)),
    }))
    .filter((z) => z.to >= z.from)
    .sort((a, b) => a.from - b.from);

  // Overlapping zones are a config error, not a rendering problem. Later zones
  // yield to earlier ones so a team appears exactly once.
  const owned: (Zone | undefined)[] = new Array(n + 1);
  for (const z of clamped) {
    for (let r = z.from; r <= z.to; r++) if (!owned[r]) owned[r] = z;
  }

  const bands: Band[] = [];
  let cursor = 1;
  while (cursor <= n) {
    const zone = owned[cursor];
    let end = cursor;
    while (end + 1 <= n && owned[end + 1] === zone) end++;
    bands.push({
      kind: zone ? zone.kind : 'mid',
      label: zone ? zone.label : '',
      from: cursor,
      to: end,
      standings: standings.filter((s) => s.rank >= cursor && s.rank <= end),
    });
    cursor = end + 1;
  }
  return bands;
}

// Every zone kind gets one accent so the same outcome reads identically across
// competitions — a Champions League place looks the same in Serie A as in
// LaLiga. Values are CSS custom properties defined in globals.css so a theme
// change never means editing a component.
export const ZONE_VAR: Record<ZoneKind | 'mid', string> = {
  champion: '--zone-champion',
  ucl: '--zone-ucl',
  uel: '--zone-uel',
  uecl: '--zone-uecl',
  playoff: '--zone-playoff',
  promotion: '--zone-promotion',
  'relegation-playoff': '--zone-releg-playoff',
  relegation: '--zone-relegation',
  mid: '--zone-mid',
};
