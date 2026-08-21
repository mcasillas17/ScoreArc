import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, intlLocale, isLocale } from './config';
import { en } from './messages/en';
import { es } from './messages/es';
import { getTranslator } from './translate';

describe('i18n contracts', () => {
  it('accepts only supported locale strings', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
    expect(isLocale('es-MX')).toBe(false);
    expect(isLocale('__proto__')).toBe(false);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(intlLocale('en')).toBe('en-US');
    expect(intlLocale('es')).toBe('es-MX');
  });

  it('keeps Spanish in exact key parity with English', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('translates fixed and parameterized messages', () => {
    expect(getTranslator('en')('common.close')).toBe('Close');
    expect(getTranslator('es')('common.close')).toBe('Cerrar');
    expect(getTranslator('en')('matches.count', 1)).toBe('1 match');
    expect(getTranslator('es')('matches.count', 2)).toBe('2 partidos');
  });
});
