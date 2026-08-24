import { describe, it, expect } from 'vitest';
import { accentTint } from './accentTint';

// Round-trip helper mirroring the module's own parsing, for hue assertions.
function hueOf(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  if (max === r) return (((g - b) / d + (g < b ? 6 : 0)) * 60) % 360;
  if (max === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
}

describe('accentTint', () => {
  it('is the exact identity without an accent — originals, not round-trips', () => {
    const tint = accentTint();
    expect(tint('#d4af37')).toBe('#d4af37');
    expect(tint('#ffe9a8')).toBe('#ffe9a8');
  });

  it('rotates the reference gold onto the accent hue', () => {
    const tint = accentTint('#0b9e52'); // Mexican green, hue ~147
    const out = tint('#d4af37');
    expect(Math.abs(hueOf(out) - hueOf('#0b9e52'))).toBeLessThan(2);
  });

  it('moves every family member by the same delta, preserving spread', () => {
    const tint = accentTint('#0b9e52');
    const dBase = hueOf(tint('#d4af37')) - hueOf('#d4af37');
    const dBright = hueOf(tint('#f0c873')) - hueOf('#f0c873');
    expect(Math.abs(dBase - dBright)).toBeLessThan(2);
  });

  it('preserves PERCEIVED brightness, not HSL lightness', () => {
    // Gold reads bright; naive hue rotation to green dims it. The tinted
    // colour must match the source's WCAG relative luminance closely.
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const lin = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin((n >> 16) & 0xff) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff);
    };
    const tint = accentTint('#0b9e52');
    for (const gold of ['#d4af37', '#f0c873', '#ffe9a8', '#b78a3c', '#544a36', '#e8b84b']) {
      const out = tint(gold);
      expect(Math.abs(lum(out) - lum(gold))).toBeLessThan(0.02);
    }
  });

  it('passes greys through untouched and survives malformed accents', () => {
    expect(accentTint('#0b9e52')('#2a2a32')).not.toBe('#2a2a32'); // dark blue-grey HAS hue
    expect(accentTint('#0b9e52')('#444444')).toBe('#444444'); // true grey does not
    expect(accentTint('not-a-color')('#d4af37')).toBe('#d4af37');
    expect(accentTint('#888888')('#d4af37')).toBe('#d4af37'); // zero-sat accent → identity
  });
});
