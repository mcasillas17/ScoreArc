export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE_NAME = 'scorearc-language';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((locale) => locale === value);
}

export function intlLocale(locale: Locale): 'en-US' | 'es-MX' {
  return locale === 'es' ? 'es-MX' : 'en-US';
}
