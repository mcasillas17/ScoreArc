'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LOCALE_COOKIE_NAME, type Locale } from './config';
import { getTranslator, type Translator } from './translate';
import { collectionHref, replacePathLocale, stripPathLocale } from './pathnames';
import { parseView } from '@/server/data/competitions';

type I18nValue = { locale: Locale; t: Translator; setLocale: (locale: Locale) => void };

const I18nContext = createContext<I18nValue | null>(null);

export function localeCookie(locale: Locale, secure: boolean): string {
  return `${LOCALE_COOKIE_NAME}=${locale};Path=/;Max-Age=31536000;SameSite=Lax${secure ? ';Secure' : ''}`;
}

function localeHref(href: string, locale: Locale): string {
  const url = new URL(href);
  const pathname = replacePathLocale(url.pathname, locale);
  const route = stripPathLocale(pathname);
  if (['/', '/teams', '/news', '/competitions'].includes(route)) {
    const values = url.searchParams.getAll('view');
    const view = parseView(values.length === 1 ? values[0] : undefined);
    return collectionHref(pathname, url.searchParams, view) + url.hash;
  }
  if (route.startsWith('/c/')) {
    // Matches use view=now/calendar under the same query key as the collection category.
    for (const value of url.searchParams.getAll('view')) {
      if (value === 'all' || parseView(value) !== 'all') url.searchParams.delete('view', value);
    }
  }
  return pathname + url.search + url.hash;
}

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const setLocale = useCallback(
    (nextLocale: Locale) => {
      document.cookie = localeCookie(nextLocale, window.location.protocol === 'https:');
      router.push(localeHref(window.location.href, nextLocale));
    },
    [router],
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
