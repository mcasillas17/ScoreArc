'use client';

import { useLanguage } from './LanguageProvider';

export default function LanguageText({ en, es }: { en: string; es: string }) {
  const { language } = useLanguage();
  return language === 'es' ? es : en;
}
