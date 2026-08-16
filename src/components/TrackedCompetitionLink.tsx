'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackEvent } from '@/lib/telemetry/client';

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
  return (
    <Link
      href={`/c/${competition}/${season}`}
      className={className}
      onClick={() => trackEvent('Competition opened', { competition, season, source })}
    >
      {children}
    </Link>
  );
}
