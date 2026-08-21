'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackEvent } from '@/lib/telemetry/client';

/**
 * An internal link that reports being followed.
 *
 * Exists because the pages are server components and `onClick` needs a client
 * one. Every other way into the app from the digest — a match card, a scorer
 * board, a story row, a nav item — is tracked, so the one untracked link would
 * read on the dashboard as a route nobody uses.
 *
 * `TrackedCompetitionLink` is the same idea with the competition route and its
 * event baked in; this is the general case.
 */
export default function TrackedLink({
  href,
  className,
  event,
  properties,
  children,
}: {
  href: string;
  className?: string;
  event: string;
  properties?: Record<string, string | number | boolean | null | undefined>;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={className} onClick={() => trackEvent(event, properties)}>
      {children}
    </Link>
  );
}
