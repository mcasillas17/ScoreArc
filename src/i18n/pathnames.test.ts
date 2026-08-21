import { describe, expect, it } from 'vitest';
import { pathLocale, replacePathLocale, stripPathLocale } from './pathnames';

describe('localized pathnames', () => {
  it('reads, adds, and replaces supported locale segments', () => {
    expect(pathLocale('/es/c/world-cup/2026')).toBe('es');
    expect(pathLocale('/c/world-cup/2026')).toBeNull();
    expect(replacePathLocale('/c/world-cup/2026', 'es')).toBe('/es/c/world-cup/2026');
    expect(replacePathLocale('/en/c/world-cup/2026', 'es')).toBe('/es/c/world-cup/2026');
    expect(stripPathLocale('/es')).toBe('/');
  });

  it('replaces an unsupported locale-looking first segment', () => {
    expect(replacePathLocale('/fr/c/world-cup/2026', 'en')).toBe('/en/c/world-cup/2026');
  });

  it('does not read or strip unsupported locale-like segments', () => {
    expect(pathLocale('/es-MX/c/world-cup/2026')).toBeNull();
    expect(stripPathLocale('/es-MX/c/world-cup/2026')).toBe('/es-MX/c/world-cup/2026');
  });

  it('only treats an anchored first segment as a locale prefix', () => {
    expect(pathLocale('//es/matches')).toBeNull();
    expect(stripPathLocale('//es/matches')).toBe('//es/matches');
    expect(replacePathLocale('//es/matches', 'en')).toBe('/en//es/matches');
  });
});
