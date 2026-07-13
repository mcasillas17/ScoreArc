import type { Season } from '@/server/data/competitions';
import { OFFICIAL_R32_ORDER } from '@/server/data/competitions';

export interface RingGeom {
  slug: string;
  rx: number;
  ry: number;
  discR: number;
}

export interface BracketShape {
  ringGeometry: RingGeom[]; // depth 0 (outer flag ring) .. N-1 (final)
  knockoutRounds: string[]; // slugs, outer->inner; parallel to ringGeometry
  bracketOrder?: [string, string][]; // present -> use as seeds; absent -> derive
}

// Tuned radii/disc sizes per ring COUNT (hand-tuned reads better than computed
// spacing; only 4 and 5 occur). rx===ry (true circles). Outer is always 400.
const RADII: Record<number, { rx: number; discR: number }[]> = {
  5: [
    { rx: 400, discR: 26 }, { rx: 312, discR: 22 }, { rx: 224, discR: 23 },
    { rx: 138, discR: 25 }, { rx: 66, discR: 29 },
  ],
  4: [
    { rx: 400, discR: 28 }, { rx: 288, discR: 26 }, { rx: 176, discR: 27 },
    { rx: 74, discR: 30 },
  ],
};

export function bracketShapeFor(season: Season): BracketShape {
  const knockoutRounds = season.knockoutRounds ?? [
    'round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final',
  ];
  const preset = RADII[knockoutRounds.length] ?? RADII[5];
  const ringGeometry: RingGeom[] = knockoutRounds.map((slug, i) => ({
    slug,
    rx: preset[i].rx,
    ry: preset[i].rx,
    discR: preset[i].discR,
  }));
  return { ringGeometry, knockoutRounds, bracketOrder: season.bracketOrder };
}

// The 2026 5-ring shape — used as the default when no `shape` prop is passed,
// so callers not yet updated keep compiling and rendering 2026 unchanged.
export const DEFAULT_SHAPE: BracketShape = bracketShapeFor({
  id: '', label: '', sections: [],
  format: { hasBracket: true, hasGroups: false, hasThirdPlaceRace: false },
  knockoutRounds: ['round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final'],
  bracketOrder: OFFICIAL_R32_ORDER,
});
