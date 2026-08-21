'use client';

import { usePathname } from 'next/navigation';
import SiteNav, { activeCompetition } from './SiteNav';

/**
 * The shell every page sits in: the global nav plus the content column.
 *
 * The per-competition accent is derived from the path rather than passed down,
 * because the nav is mounted once at the root and the competition layout is
 * mounted below it — the two would otherwise disagree about which competition
 * is open on the very route that has one.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const accent = activeCompetition(pathname)?.competition.accent;
  const style = accent
    ? ({
        ['--accent' as string]: accent.base,
        ['--accent-bright' as string]: accent.bright,
        ['--accent-soft' as string]: accent.soft,
      } as React.CSSProperties)
    : undefined;

  return (
    <div className="app-shell" style={style}>
      <SiteNav />
      <div className="app-content">{children}</div>
    </div>
  );
}
