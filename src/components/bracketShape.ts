import type { Season } from '@/server/data/competitions';
import { OFFICIAL_R32_ORDER } from '@/server/data/competitions';
import type { KnockoutRoundSlug } from '@/server/data/types';

export interface RingGeom {
  slug: KnockoutRoundSlug;
  rx: number;
  ry: number;
  discR: number;
}

export interface BracketShape {
  ringGeometry: RingGeom[]; // depth 0 (outer flag ring) .. N-1 (final)
  knockoutRounds: KnockoutRoundSlug[]; // slugs, outer->inner; parallel to ringGeometry
  bracketOrder?: [string, string][]; // present -> use as seeds; absent -> derive
}

export type RoundLabelKey =
  | 'round.roundOf32'
  | 'round.roundOf16'
  | 'round.quarterfinals'
  | 'round.semifinals'
  | 'round.thirdPlace'
  | 'round.final';

const ROUND_LABEL_KEYS: Record<KnockoutRoundSlug, RoundLabelKey> = {
  'round-of-32': 'round.roundOf32',
  'round-of-16': 'round.roundOf16',
  quarterfinals: 'round.quarterfinals',
  semifinals: 'round.semifinals',
  '3rd-place-match': 'round.thirdPlace',
  final: 'round.final',
};

export function roundLabelKey(slug: KnockoutRoundSlug): RoundLabelKey {
  return ROUND_LABEL_KEYS[slug];
}

// Tuned radii/disc sizes per ring COUNT (hand-tuned reads better than computed
// spacing). rx===ry (true circles). Outer is always 400.
const RADII: Record<number, { rx: number; discR: number }[]> = {
  // The Leagues Cup knockout: quarterfinals, semifinals, final. Discs grow as
  // the rings thin out, because three rings leave room a five-ring draw does
  // not.
  3: [
    { rx: 400, discR: 34 }, { rx: 250, discR: 32 }, { rx: 96, discR: 36 },
  ],
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

/**
 * Is the knockout real enough to lead a page with?
 *
 * A cross-league cup's phase tables ARE the competition until its knockout
 * starts, so the season root shows them first. The handover used to be "the
 * provider has published at least one knockout fixture", which fired on the
 * Leagues Cup's *second* quarterfinal of four and replaced a full set of
 * standings with a three-round bracket holding half a round.
 *
 * A knockout is ready when its first round is fully drawn — the leaf ring has
 * every tie it will ever have, `2^(rounds-1)` of them — or when a later round
 * has fixtures, which means the draw has moved on regardless of how the
 * provider labelled the first.
 */
export function knockoutIsReady(bracket: { slug: KnockoutRoundSlug; matches: unknown[] }[], shape: BracketShape): boolean {
  const [leafSlug, ...laterSlugs] = shape.knockoutRounds;
  const expectedLeaf = 2 ** (shape.knockoutRounds.length - 1);
  const leaf = bracket.find((r) => r.slug === leafSlug);
  if ((leaf?.matches.length ?? 0) >= expectedLeaf) return true;
  return laterSlugs.some((slug) => (bracket.find((r) => r.slug === slug)?.matches.length ?? 0) > 0);
}
