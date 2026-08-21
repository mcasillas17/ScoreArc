'use client';

import { usePathname } from 'next/navigation';
import SiteNav, { accentStyle } from './SiteNav';
import LanguageText from './LanguageText';

/**
 * The shell every page sits in: the global nav plus the content column.
 *
 * The per-competition accent is derived from the path rather than passed down —
 * see `accentStyle` for why.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';

  return (
    <div className="app-shell" style={accentStyle(pathname)}>
      {/* The nav is first in the DOM on every page and carries fourteen or more
          focusable items, on pages that until this epic had no nav at all. A
          keyboard or screen-reader user needs one keystroke past it. */}
      <a className="sr-only sn-skip" href="#app-content">
        <LanguageText en="Skip to content" es="Saltar al contenido" />
      </a>
      <SiteNav />
      <div className="app-content" id="app-content" tabIndex={-1}>{children}</div>
    </div>
  );
}
