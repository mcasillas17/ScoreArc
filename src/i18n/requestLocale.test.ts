import { describe, expect, it } from 'vitest';
import { preferredLocale } from './requestLocale';

describe('preferredLocale', () => {
  it('gives a valid explicit cookie precedence', () => {
    expect(preferredLocale('en', 'es-MX,es;q=0.9')).toBe('en');
  });

  it('uses weighted supported browser languages', () => {
    expect(preferredLocale(undefined, 'fr;q=0.9, es-MX;q=0.8, en;q=0.7')).toBe('es');
    expect(preferredLocale(undefined, 'en-GB;q=0.5, es;q=0.9')).toBe('es');
  });

  it('ignores malformed, unsupported, zero-quality, and prototype-like values', () => {
    expect(preferredLocale('__proto__', 'fr,es;q=0')).toBe('en');
    expect(preferredLocale(undefined, 'en;q=wat,es;q=0.4')).toBe('es');
    expect(preferredLocale(undefined, 'es;q=1.1,en;q=0.5')).toBe('en');
    expect(preferredLocale(undefined, 'es;q=0x1,en;q=0.5')).toBe('en');
  });

  it('rejects explicit quality parameters without a value', () => {
    expect(preferredLocale(undefined, 'es;q=,en;q=0.5')).toBe('en');
  });

  it('rejects invalid HTTP quality-value precision and grammar', () => {
    expect(preferredLocale(undefined, 'es;q=0.1234,en;q=0.1')).toBe('en');
    expect(preferredLocale(undefined, 'es;q=00.9,en;q=0.5')).toBe('en');
    expect(preferredLocale(undefined, 'es;q=1.0000,en;q=0.5')).toBe('en');
  });

  it('falls back to English for absent or unusable untrusted input', () => {
    expect(preferredLocale(undefined, null)).toBe('en');
    expect(preferredLocale('', '')).toBe('en');
    expect(preferredLocale('es-MX', 'fr;q=0, __proto__;q=1')).toBe('en');
  });
});
