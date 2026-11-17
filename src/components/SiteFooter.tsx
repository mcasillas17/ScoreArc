'use client';

import { usePathname } from 'next/navigation';
import { activeCompetition } from './SiteNav';
import ViewLinks from './ViewLinks';
import { useLocale, useSetLocale, useTranslations } from '@/i18n/I18nProvider';

export default function SiteFooter() {
  const locale = useLocale();
  const edition = activeCompetition(usePathname() ?? '/');
  const setLocale = useSetLocale();
  const t = useTranslations();

  return (
    <footer className="site-footer">
      {edition && <div className="footer-matchday">
        <span>{t('home.digest.matchday')}</span>
        <ViewLinks matchday locale={locale} path="/" view={edition.competition.category} />
      </div>}
      <p>{t('footer.disclaimer')}</p>
      <div className="language-toggle" role="group" aria-label={t('footer.languageGroup')}>
        <button type="button" className={locale === 'en' ? 'language-toggle--active' : ''} onClick={() => setLocale('en')} aria-pressed={locale === 'en'}>
          EN
        </button>
        <span aria-hidden="true">/</span>
        <button type="button" className={locale === 'es' ? 'language-toggle--active' : ''} onClick={() => setLocale('es')} aria-pressed={locale === 'es'}>
          ES
        </button>
      </div>
    </footer>
  );
}
