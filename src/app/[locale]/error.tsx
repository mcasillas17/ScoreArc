'use client'; // Error boundaries must be Client Components

import { useTranslations } from '@/i18n/I18nProvider';

// Pages throw on purpose when every data source fails (see readerUnavailable
// tests). Without this file that reached readers as Next's own unstyled,
// English-only error screen. It sits inside the locale layout, so the nav
// stays and the copy is translated.
export default function RouteError({ retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations();
  return (
    <main className="main">
      <div className="empty-section" role="alert">
        <h1 className="bracket-title">{t('status.errorTitle')}</h1>
        <p className="empty-text">{t('status.errorBody')}</p>
        {/* The follow button's pill is the site's one text-button style. */}
        <p><button type="button" className="follow-team-button" onClick={() => retry()}>{t('status.retry')}</button></p>
      </div>
    </main>
  );
}
