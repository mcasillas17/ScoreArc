import type { Standing } from '@/server/data/types';
import type { Zone, ZoneKind, ZoneLabelKey } from '@/server/data/competitions';

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
  labelKey: ZoneLabelKey | null;
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

  // A season that has not kicked off has no standings — it has an alphabetical
  // club list that the provider happens to number 1..n. Painting qualification
  // and relegation over that order states, in ScoreArc's own voice, that the
  // club whose name sorts first is champion. Verified live: the 2026-27
  // Premier League returns Bournemouth 1st and Tottenham 20th at P0.
  //
  // The rule lives here rather than in the components because both
  // LeagueZoneTable and ZoneRing consume bands, and fixing only one of them is
  // how this shipped. One unmarked band costs the ring its arcs and the table
  // its legend automatically.
  if (standings.every((s) => s.played === 0)) {
    return [{ kind: 'mid', labelKey: null, from: 1, to: n, standings }];
  }

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
      labelKey: zone?.labelKey ?? null,
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
  wildcard: '--zone-wildcard',
  promotion: '--zone-promotion',
  'relegation-playoff': '--zone-releg-playoff',
  relegation: '--zone-relegation',
  mid: '--zone-mid',
};

// Outcomes that are a tie to be played rather than a placing already earned.
// Drawn dashed so they read as unsettled — which also removes the need to give
// a relegation playoff a colour of its own, the thing that collided with the
// Europa League accent.
export const DASHED_KINDS: ReadonlySet<string> = new Set(['relegation-playoff', 'wildcard']);
