'use client';

import { useLocale, useSetLocale } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/config';

export type Language = Locale;

// Transitional identity wrapper for legacy imports; I18nProvider owns the context.
export function LanguageProvider({ children }: { children: React.ReactNode }) { return children; }

export function useLanguage() {
  const language = useLocale();
  const setLanguage = useSetLocale();
  return {
    language,
    setLanguage,
    toggleLanguage: () => setLanguage(language === 'en' ? 'es' : 'en'),
  };
}
