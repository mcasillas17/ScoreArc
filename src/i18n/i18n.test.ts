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

  it('translates semantic standings, group, zone, and round concepts', () => {
    expect(getTranslator('en')('group.name', 'A')).toBe('Group A');
    expect(getTranslator('es')('group.name', 'A')).toBe('Grupo A');
    expect(getTranslator('en')('zone.champion')).toBe('Champion');
    expect(getTranslator('es')('zone.champion')).toBe('Campeón');
    expect(getTranslator('en')('standings.top', 8)).toBe('top 8');
    expect(getTranslator('es')('standings.top', 8)).toBe('8 primeros');
    expect(getTranslator('en')('standings.thirdPlaceAdvanceNote', 8)).toBe(
      'Top 8 third-placed teams advance to the Round of 32.',
    );
    expect(getTranslator('es')('standings.thirdPlaceAdvanceNote', 8)).toBe(
      'Los 8 mejores terceros avanzan a la ronda de 32.',
    );
  });

  it('inflects played counts and ranges in both locales', () => {
    expect(getTranslator('en')('standings.played', 1)).toBe('1 played');
    expect(getTranslator('en')('standings.played', 2)).toBe('2 played');
    expect(getTranslator('en')('standings.playedRange', '1–2')).toBe('1–2 played');
    expect(getTranslator('es')('standings.played', 1)).toBe('1 jugado');
    expect(getTranslator('es')('standings.played', 2)).toBe('2 jugados');
    expect(getTranslator('es')('standings.playedRange', '1–2')).toBe('1–2 jugados');
  });
});
