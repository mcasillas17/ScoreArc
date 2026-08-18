'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Competition } from '@/server/data/competitions';
import { listCompetitions } from '@/server/data/competitions';
import { trackEvent } from '@/lib/telemetry/client';

const ICON = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export default function Sidebar({ comp, seasonId }: { comp: Competition; seasonId: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const pathname = usePathname();
  const base = `/c/${comp.id}/${seasonId}`;
  const hasBracket = comp.seasons[seasonId]?.format.hasBracket ?? true;

  const bracketIcon = <svg {...ICON}><path d="M6 4v4a3 3 0 0 0 3 3h2" /><path d="M6 20v-4a3 3 0 0 1 3-3h2" /><circle cx="18" cy="12" r="2" /><path d="M11 12h5" /><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="20" r="1.5" /></svg>;
  const tableIcon = <svg {...ICON}><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="14" y2="18" /></svg>;
  const newsIcon = <svg {...ICON}><path d="M4 5h16v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;

  const atBase = (p: string) => p === base;
  const newsItem = { href: `${base}/news`, label: 'News', match: (p: string) => p.startsWith(`${base}/news`), icon: newsIcon };

  // Knockout competitions lead with a bracket + a separate standings page;
  // leagues lead with the table (which is the base page), so no bracket item.
  const items = hasBracket
    ? [
        { href: base, label: 'Bracket', match: atBase, icon: bracketIcon },
        { href: `${base}/standings`, label: 'Standings', match: (p: string) => p.startsWith(`${base}/standings`), icon: tableIcon },
        newsItem,
      ]
    : [
        { href: base, label: 'Table', match: atBase, icon: tableIcon },
        newsItem,
      ];

  return (
    <>
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-brand">
        <Link href="/" className="sidebar-brand-link" aria-label="ScoreArc home">
          <span className="sidebar-ball" aria-hidden>⚽</span>
          <span className="sidebar-wordmark">ScoreArc</span>
        </Link>
        <button type="button" className="sidebar-toggle" onClick={() => {
          trackEvent('Sidebar toggled', { collapsed: !collapsed });
          setCollapsed(!collapsed);
        }} aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {collapsed ? <polyline points="9 6 15 12 9 18" /> : <polyline points="15 6 9 12 15 18" />}
          </svg>
        </button>
      </div>

      <div className="sidebar-switcher">
        <button type="button" className="cs-current" onClick={() => setSwitcherOpen((v) => !v)} aria-expanded={switcherOpen} aria-label="Switch competition">
          <span className="cs-label">Competition</span>
          <span className="cs-name"><span className="cs-emblem">{comp.emblem}</span>{comp.shortName}</span>
          <span className="cs-season">{comp.seasons[seasonId]?.label ?? seasonId} season</span>
        </button>
        {switcherOpen && (
          <div className="cs-menu">
            {listCompetitions().map((c) => (
              <Link key={c.id} href={`/c/${c.id}/${c.currentSeasonId}`} className={`cs-opt${c.id === comp.id ? ' cs-opt--active' : ''}`} onClick={() => {
                trackEvent('Competition opened', {
                  competition: c.id,
                  season: c.currentSeasonId,
                  source: 'switcher',
                });
                setSwitcherOpen(false);
              }}>
                <span className="cs-emblem">{c.emblem}</span>{c.shortName}
              </Link>
            ))}
          </div>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Sections">
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={`nav-item${item.match(pathname) ? ' nav-item--active' : ''}`} title={collapsed ? item.label : undefined} onClick={() => trackEvent('Section opened', { section: item.label, surface: 'sidebar' })}>
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </Link>
        ))}
      </nav>

      <Link href="/" className="sidebar-allcomps">⌂ All competitions</Link>

      <a className="sidebar-credit" href="https://github.com/mcasillas17" target="_blank" rel="noreferrer" title={collapsed ? 'Built by elOpenMike' : undefined}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" /></svg>
        <span className="credit-text">Built by <strong>elOpenMike</strong></span>
      </a>
    </aside>

      {/* Fixed bottom tab bar — mobile only (CSS hides it on desktop). */}
      <nav className="mobile-tabbar" aria-label="Sections">
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={`mtab${item.match(pathname) ? ' mtab--active' : ''}`} onClick={() => trackEvent('Section opened', { section: item.label, surface: 'mobile-tabs' })}>
            <span className="mtab-icon">{item.icon}</span>
            <span className="mtab-label">{item.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
