import { describe, it, expect } from 'vitest';
import { playerSlug, buildSlugMap } from './playerIdentity';

// The algorithm is a published contract (docs/backend/PLAYER_IDENTITY.md):
// the backend mints the same slugs as canonical player ids, so any change
// here that alters an existing slug breaks URLs at the API cutover.
describe('playerSlug', () => {
  it('folds accents and lowercases', () => {
    expect(playerSlug('Alí Ávila')).toBe('ali-avila');
    expect(playerSlug('João Félix')).toBe('joao-felix');
    expect(playerSlug('Raúl Jiménez')).toBe('raul-jimenez');
  });

  it('collapses non-alphanumerics to single hyphens and trims', () => {
    expect(playerSlug("N'Golo Kanté")).toBe('n-golo-kante');
    expect(playerSlug('  O.G. van der Sar  ')).toBe('o-g-van-der-sar');
  });

  // These letters do NOT decompose under NFD, so a fold that only strips
  // combining marks silently deletes them: "Ødegaard" became "degaard".
  it('folds the non-decomposing letters', () => {
    expect(playerSlug('Martin Ødegaard')).toBe('martin-odegaard');
    expect(playerSlug('Łukasz Fabiański')).toBe('lukasz-fabianski');
    expect(playerSlug('Đorđe Petrović')).toBe('dorde-petrovic');
    expect(playerSlug('Toni Rüdiger ß')).toBe('toni-rudiger-ss');
    expect(playerSlug('Æon Œuvre')).toBe('aeon-oeuvre');
  });

  it('keeps digits', () => {
    expect(playerSlug('Ronaldo 9')).toBe('ronaldo-9');
  });
});

describe('buildSlugMap', () => {
  it('maps unique names to plain slugs', () => {
    const map = buildSlugMap([
      { name: 'Ali Avila', providerId: '297287', teamAbbr: 'QRO' },
      { name: 'Raúl Jiménez', providerId: '167905', teamAbbr: 'AME' },
    ]);
    expect(map.get('ali-avila')!.providerId).toBe('297287');
    expect(map.get('raul-jimenez')!.providerId).toBe('167905');
  });

  // The contract's collision rule: BOTH sides get the team suffix, never just
  // the newcomer -- otherwise which player owns the bare slug depends on
  // iteration order.
  it('suffixes both colliding players with their team abbr', () => {
    const map = buildSlugMap([
      { name: 'Rodrigo López', providerId: '1', teamAbbr: 'QRO' },
      { name: 'Rodrigo Lopez', providerId: '2', teamAbbr: 'ATL' },
    ]);
    expect(map.has('rodrigo-lopez')).toBe(false);
    expect(map.get('rodrigo-lopez-qro')!.providerId).toBe('1');
    expect(map.get('rodrigo-lopez-atl')!.providerId).toBe('2');
  });

  it('disambiguates same name and same team by jersey', () => {
    const map = buildSlugMap([
      { name: 'Juan Pérez', providerId: '1', teamAbbr: 'QRO', jersey: '4' },
      { name: 'Juan Perez', providerId: '2', teamAbbr: 'QRO', jersey: '21' },
    ]);
    expect(map.get('juan-perez-qro-4')!.providerId).toBe('1');
    expect(map.get('juan-perez-qro-21')!.providerId).toBe('2');
  });

  it('drops entries with no usable name', () => {
    const map = buildSlugMap([{ name: '', providerId: '9', teamAbbr: 'X' }]);
    expect(map.size).toBe(0);
  });
});
