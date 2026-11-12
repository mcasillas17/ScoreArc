'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { ArcMark, activeCompetition, competitionSections, localePrefix } from './SiteNav';

/**
 * The open competition's sections, as a tab row across the top of the content
 * column. Desktop only (CSS): on a phone the bottom bar carries the same
 * sections. Renders nothing off a competition.
 */
export default function SectionTabs() {
  const pathname = usePathname() ?? '/';
  const locale = useLocale();
  const t = useTranslations();
  const active = activeCompetition(pathname);
  if (!active) return null;

  return (
    <nav className="sn-sections" aria-label={t('nav.sections')}>
      {competitionSections(active, locale, localePrefix(pathname)).map((s) => {
        const on = s.match(pathname);
        return (
          <Link
            key={s.href}
            href={s.href}
            className="sn-section"
            aria-current={on ? 'page' : undefined}
            onClick={() => {
              trackEvent('Section opened', { section: s.label, surface: 'sitenav' });
            }}
          >
            {s.label}
            {on && <ArcMark />}
          </Link>
        );
      })}
    </nav>
  );
}
