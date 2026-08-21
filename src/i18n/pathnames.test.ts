import { describe, expect, it } from 'vitest';
import { replacePathLocale } from './pathnames';

describe('replacePathLocale', () => {
  it('replaces locale-like prefixes and prefixes unlocalized paths', () => {
    expect(replacePathLocale('/es/matches', 'en')).toBe('/en/matches');
    expect(replacePathLocale('/es-MX/matches', 'es')).toBe('/es/matches');
    expect(replacePathLocale('/matches', 'es')).toBe('/es/matches');
    expect(replacePathLocale('/', 'en')).toBe('/en');
  });
});
