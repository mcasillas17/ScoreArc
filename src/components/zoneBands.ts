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

// Zones are places on the table — "finishing here earns the Champions League"
// is true from matchday one. `champion` is the one kind that is not a place
// but a VERDICT: it asserts a result, not a stake. Painting it before the
// title is mathematically settled tells readers something that has not
// happened yet — exactly the shape of bug the P0 rule above already fixes for
// an unplayed season. This closes the same gap for a season that HAS kicked
// off but is nowhere near decided: a `champion` zone only survives resolution
// once the leader's points lead cannot be caught, given the rounds left to
// play. Until then rank 1 is just the top of whatever band sits below it.
function resolveZones(standings: Standing[], zones: Zone[], rounds: number | undefined): Zone[] {
  const championIndex = zones.findIndex((z) => z.kind === 'champion');
  if (championIndex === -1) return zones;
  const champion = zones[championIndex];

  // No `rounds` configured -> never clinched. The conservative direction: a
  // missing config value must not mint a champion.
  const sorted = [...standings].sort((a, b) => a.rank - b.rank);
  const leader = sorted[0];
  const chasers = sorted.slice(1);
  let clinched = false;
  if (rounds !== undefined && leader !== undefined && chasers.length > 0) {
    // The ceiling is the best any OTHER team can still reach — every chaser,
    // not just rank 2: the provider ranks by points, so a side on fewer
    // points with games in hand sits below second and would otherwise never
    // be consulted (mid-season MLS routinely has 3-5 games-in-hand spreads).
    // Remaining games clamp at zero so a stale `rounds` after a format
    // change can only delay the crown, never mint one on a points tie.
    const ceiling = Math.max(
      ...chasers.map((s) => s.points + 3 * Math.max(0, rounds - s.played)),
    );
    // Every game played — EXACTLY every game: the table is final and the
    // provider's rank 1 already carries the tiebreakers, so a title won on
    // goal difference keeps its band on the one day it matters most. Strict
    // equality, not >=: played beyond `rounds` can only mean the config is
    // stale, and a stale season length must not turn a points tie into a
    // title. While games remain, strict >: points parity is not a title.
    const seasonOver =
      leader.played === rounds && chasers.every((s) => s.played === rounds);
    clinched = seasonOver || leader.points > ceiling;
  }
  if (clinched) return zones;

  const rest = zones.filter((_, i) => i !== championIndex);
  // If a zone starts exactly where the champion zone ended, it was already
  // adjacent (e.g. Premier League Champions League 2-4 sitting right below
  // champion 1-1) — extend it up to cover the champion range too, so 1-4
  // reads as one Champions League band instead of a gap at the top. If
  // nothing abuts it, dropping the champion zone entirely lets the normal
  // mid-table fill handle rank 1 like any other unmarked rank.
  const abutting = rest.find((z) => z.from === champion.to + 1);
  if (abutting) {
    return rest.map((z) => (z === abutting ? { ...z, from: champion.from } : z));
  }
  return rest;
}

// Zones are authored per season as rank ranges. They are clamped and sorted
// here rather than trusted, because a config that says "relegation 18-20" for a
// league ESPN reports with 18 rows would otherwise silently render an empty
// band — or worse, drop teams off the bottom of the table.
export function toBands(standings: Standing[], zones: Zone[], opts?: { rounds?: number }): Band[] {
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

  const resolved = resolveZones(standings, zones, opts?.rounds);

  const clamped = resolved
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
