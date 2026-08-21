'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale } from '@/i18n/I18nProvider';

interface Props {
  competition: string;
  season: string;
  source: string;
  className: string;
  children: ReactNode;
}

export default function TrackedCompetitionLink({
  competition,
  season,
  source,
  className,
  children,
}: Props) {
  const locale = useLocale();
  return (
    <Link
      href={`/${locale}/c/${competition}/${season}`}
      className={className}
      onClick={() => trackEvent('Competition opened', { competition, season, source })}
    >
      {children}
    </Link>
  );
}
