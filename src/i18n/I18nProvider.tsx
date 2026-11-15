'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LOCALE_COOKIE_NAME, type Locale } from './config';
import { getTranslator, type Translator } from './translate';
import { replacePathLocale } from './pathnames';

type I18nValue = { locale: Locale; t: Translator; setLocale: (locale: Locale) => void };

const I18nContext = createContext<I18nValue | null>(null);

export function localeCookie(locale: Locale, secure: boolean): string {
  return `${LOCALE_COOKIE_NAME}=${locale};Path=/;Max-Age=31536000;SameSite=Lax${secure ? ';Secure' : ''}`;
}

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const setLocale = useCallback(
    (nextLocale: Locale) => {
      document.cookie = localeCookie(nextLocale, window.location.protocol === 'https:');
      const query = window.location.search;
      const hash = window.location.hash;
      router.push(`${replacePathLocale(pathname, nextLocale)}${query}${hash}`);
    },
    [pathname, router],
  );
  // Client components inside a competition speak about that competition, so
  // they read the same catalog its server-rendered page did.
  const competitionId = /\/c\/([^/]+)/.exec(pathname ?? '')?.[1];
  const value = useMemo(
    () => ({ locale, t: getTranslator(locale, competitionId), setLocale }),
    [locale, competitionId, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider is required');
  return value;
}

export function useLocale() {
  return useI18n().locale;
}

export function useTranslations() {
  return useI18n().t;
}

export function useSetLocale() {
  return useI18n().setLocale;
}
