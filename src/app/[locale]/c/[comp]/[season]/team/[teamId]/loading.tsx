'use client';

import { useTranslations } from '@/i18n/I18nProvider';

export default function TeamLoading() {
  const t = useTranslations();
  return <main className="main tm" aria-busy="true"><p className="tp-notice" role="status">{t('performance.loading')}</p></main>;
}
