'use client'; // not-found receives no params; the locale comes from context

import Link from 'next/link';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';

export default function NotFound() {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <main className="main">
      <div className="empty-section">
        <h1 className="bracket-title">{t('status.notFoundTitle')}</h1>
        <p className="empty-text">{t('status.notFoundBody')}</p>
        <p><Link href={`/${locale}`}>{t('status.backHome')}</Link></p>
      </div>
    </main>
  );
}
