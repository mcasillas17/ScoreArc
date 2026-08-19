import { describe, it, expect } from 'vitest';
import { bracketShapeFor, knockoutIsReady } from './bracketShape';
import type { Season } from '@/server/data/competitions';
import { COMPETITIONS, listCompetitions } from '@/server/data/competitions';

const season = (over: Partial<Season>): Season => ({
  id: 'x', label: 'x', sections: ['bracket'],
  format: { hasBracket: true, hasGroups: false, hasThirdPlaceRace: false },
  ...over,
});

describe('bracketShapeFor', () => {
  it('5 rings + 16-pair order for a round-of-32 season', () => {
    const s = bracketShapeFor(season({
      knockoutRounds: ['round-of-32','round-of-16','quarterfinals','semifinals','final'],
      bracketOrder: Array(16).fill(['A','B']) as [string,string][],
    }));
    expect(s.ringGeometry).toHaveLength(5);
    expect(s.ringGeometry[0].slug).toBe('round-of-32');
    expect(s.ringGeometry[0].rx).toBe(400);
    expect(s.bracketOrder).toHaveLength(16);
  });

  it('4 rings + no seed order for a round-of-16 season', () => {
    const s = bracketShapeFor(season({
      knockoutRounds: ['round-of-16','quarterfinals','semifinals','final'],
    }));
    expect(s.ringGeometry).toHaveLength(4);
    expect(s.ringGeometry.map((g) => g.slug)).toEqual([
      'round-of-16','quarterfinals','semifinals','final',
    ]);
    expect(s.ringGeometry[0].rx).toBe(400); // outer ring is always the flag ring
    expect(s.bracketOrder).toBeUndefined();
  });
});

// The Leagues Cup rendered a trophy over an empty bracket for weeks because its
// season declared no `knockoutRounds`, so it silently inherited the World Cup's
// five — whose leaf ring is `round-of-32`, a round it never plays. `buildRings`
// lays out from the leaf, so every ring came out empty.
describe('every bracket competition declares a shape it can actually fill', () => {
  const bracketSeasons = listCompetitions().flatMap((comp) =>
    Object.values(comp.seasons)
      .filter((season) => season.format.hasBracket)
      .map((season) => ({ comp, season })),
  );

  it('finds bracket competitions to check', () => {
    expect(bracketSeasons.length).toBeGreaterThan(0);
  });

  it.each(bracketSeasons.map(({ comp, season }) => [`${comp.id} ${season.id}`, comp, season] as const))(
    '%s declares its own knockout rounds',
    (_label, _comp, season) => {
      // The default is the World Cup's. Inheriting it is what caused the bug,
      // so every bracket season must say which rounds it plays.
      expect(season.knockoutRounds).toBeDefined();
      expect(season.knockoutRounds!.length).toBeGreaterThan(0);
    },
  );

  it.each(bracketSeasons.map(({ comp, season }) => [`${comp.id} ${season.id}`, comp, season] as const))(
    '%s gets ring geometry matching its round count',
    (_label, _comp, season) => {
      const shape = bracketShapeFor(season);
      // A missing preset falls back to the 5-ring geometry, which silently
      // mismatches the rounds and misplaces every disc.
      expect(shape.ringGeometry).toHaveLength(season.knockoutRounds!.length);
      expect(shape.ringGeometry.map((r) => r.slug)).toEqual(season.knockoutRounds);
    },
  );

  it('gives the Leagues Cup a knockout that starts where its data does', () => {
    const season = COMPETITIONS['leagues-cup'].seasons['2026'];
    expect(season.knockoutRounds?.[0]).toBe('quarterfinals');
  });
});

// The Leagues Cup root replaced a full set of phase tables with a
// three-round bracket holding two of four quarterfinals, because the handover
// test was "has the provider published anything at all".
describe('knockoutIsReady', () => {
  const shape = bracketShapeFor(season({
    knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
  }));
  const round = (slug: string, n: number) => ({ slug, matches: Array.from({ length: n }) });

  it('is not ready with nothing published', () => {
    expect(knockoutIsReady([], shape)).toBe(false);
  });

  it('is not ready with a partly drawn first round', () => {
    expect(knockoutIsReady([round('quarterfinals', 2)], shape)).toBe(false);
    expect(knockoutIsReady([round('quarterfinals', 3)], shape)).toBe(false);
  });

  it('is ready once the first round is fully drawn', () => {
    expect(knockoutIsReady([round('quarterfinals', 4)], shape)).toBe(true);
  });

  // The provider can relabel or skip a round. A later round with fixtures means
  // the draw has moved on whatever the first one says.
  it('is ready when a later round has fixtures', () => {
    expect(knockoutIsReady([round('quarterfinals', 1), round('semifinals', 2)], shape)).toBe(true);
    expect(knockoutIsReady([round('final', 1)], shape)).toBe(true);
  });

  it('ignores rounds the competition does not play', () => {
    expect(knockoutIsReady([round('round-of-32', 16)], shape)).toBe(false);
  });

  // 5 rounds -> 16 leaf ties, so a handful of published R32 fixtures is not
  // yet a World Cup knockout either.
  it('scales the expected first round to the shape', () => {
    const wc = bracketShapeFor(season({
      knockoutRounds: ['round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final'],
    }));
    expect(knockoutIsReady([round('round-of-32', 8)], wc)).toBe(false);
    expect(knockoutIsReady([round('round-of-32', 16)], wc)).toBe(true);
  });
});
