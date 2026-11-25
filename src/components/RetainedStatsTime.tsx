'use client';

import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDate } from '@/i18n/format';

export default function RetainedStatsTime({ observedAt, className }: { observedAt: string; className?: string }) {
  const locale = useLocale();
  const t = useTranslations();
  const date = formatDate(observedAt, locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  });
  return date && <time className={className} dateTime={observedAt}>{t('squad.statsLastVerified', date)}</time>;
}
