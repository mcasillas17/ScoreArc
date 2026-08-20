'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Language = 'en' | 'es';

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en');

  useEffect(() => {
    const saved = window.localStorage.getItem('scorearc-language');
    if (saved === 'en' || saved === 'es') {
      setLanguageState(saved);
      document.documentElement.lang = saved;
    }
  }, []);

  const setLanguage = (next: Language) => {
    setLanguageState(next);
    window.localStorage.setItem('scorearc-language', next);
    document.cookie = `scorearc-language=${next};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.lang = next;
  };

  const value = useMemo(
    () => ({ language, setLanguage, toggleLanguage: () => setLanguage(language === 'en' ? 'es' : 'en') }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
