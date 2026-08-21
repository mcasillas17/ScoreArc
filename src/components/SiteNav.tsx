'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { listCompetitions, resolveSeason } from '@/server/data/competitions';
import type { CompetitionSeason } from '@/server/data/competitions';
import { trackEvent } from '@/lib/telemetry/client';
import CompetitionMark from './CompetitionMark';
import { useLanguage } from './LanguageProvider';

const ICON = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const homeIcon = <svg {...ICON}><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" /></svg>;
const teamsIcon = <svg {...ICON}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.2" /><path d="M15.5 20a5 5 0 0 1 5.5-4.6" /></svg>;
const playersIcon = <svg {...ICON}><circle cx="12" cy="7" r="3.4" /><path d="M5 21a7 7 0 0 1 14 0" /></svg>;
const simulateIcon = <svg {...ICON}><path d="M4 18V6M10 18v-7M16 18v-4M20 18V9" /></svg>;
const bracketIcon = <svg {...ICON}><path d="M6 4v4a3 3 0 0 0 3 3h2" /><path d="M6 20v-4a3 3 0 0 1 3-3h2" /><circle cx="18" cy="12" r="2" /><path d="M11 12h5" /><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="20" r="1.5" /></svg>;
const tableIcon = <svg {...ICON}><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="14" y2="18" /></svg>;
const matchesIcon = <svg {...ICON}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>;
const newsIcon = <svg {...ICON}><path d="M4 5h16v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (path: string) => boolean;
}

/** The competition whose workspace this path is inside, if any. */
export function activeCompetition(pathname: string): CompetitionSeason | undefined {
  const m = /^\/c\/([^/]+)(?:\/([^/]+))?/.exec(pathname);
  if (!m) return undefined;
  return resolveSeason(m[1], m[2]);
}

/**
 * The sections a competition publishes, in nav order.
 *
 * A cross-league cup's root shows its phase tables until the draw is complete
 * and the bracket after, so "Bracket" is wrong for most of the competition —
 * "Knockout" is true in both states. A league has no root item at all: its
 * base URL redirects to /standings.
 */
export function competitionSections(rc: CompetitionSeason, spanish: boolean): NavItem[] {
  const base = `/c/${rc.competition.id}/${rc.season.id}`;
  const hasBracket = rc.season.format.hasBracket;
  const phasedCup = !!rc.season.computedTables;
  const standings: NavItem = {
    href: `${base}/standings`,
    label: spanish ? 'Clasificación' : 'Standings',
    icon: tableIcon,
    match: (p) => p.startsWith(`${base}/standings`),
  };
  const rest: NavItem[] = [
    standings,
    { href: `${base}/matches`, label: spanish ? 'Partidos' : 'Matches', icon: matchesIcon, match: (p) => p.startsWith(`${base}/matches`) },
    { href: `${base}/teams`, label: spanish ? 'Equipos' : 'Teams', icon: teamsIcon, match: (p) => p.startsWith(`${base}/teams`) },
    { href: `${base}/news`, label: spanish ? 'Noticias' : 'News', icon: newsIcon, match: (p) => p.startsWith(`${base}/news`) },
  ];
  if (!hasBracket) return rest;
  return [
    {
      href: base,
      label: phasedCup ? (spanish ? 'Eliminatorias' : 'Knockout') : (spanish ? 'Cuadro' : 'Bracket'),
      icon: bracketIcon,
      match: (p) => p === base,
    },
    ...rest,
  ];
}

export default function SiteNav() {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? '/';
  const { language } = useLanguage();
  const spanish = language === 'es';

  const active = activeCompetition(pathname);
  const competitions = listCompetitions();

  // On a phone the nav is one scrolling row, and the section you are actually
  // on sits past the site links -- ten competitions to the right of the fold on
  // a competition page. Bring it into view rather than leaving the reader to
  // discover it. Horizontal only: `scrollIntoView` would drag the page down too.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || panel.scrollWidth <= panel.clientWidth) return;
    const current = panel.querySelector<HTMLElement>('.sn-item--active');
    if (current) panel.scrollLeft = Math.max(0, current.offsetLeft - 12);
  }, [pathname]);

  const siteItems: NavItem[] = [
    { href: '/', label: spanish ? 'Inicio' : 'Home', icon: homeIcon, match: (p) => p === '/' },
    { href: '/teams', label: spanish ? 'Equipos' : 'Teams', icon: teamsIcon, match: (p) => p === '/teams' },
  ];
  // Named, not linked. The nav is where the site says what it is, and a link
  // to a 404 is worse than an honest label.
  const soonItems = [
    { label: spanish ? 'Jugadores' : 'Players', icon: playersIcon },
    { label: spanish ? 'Simular' : 'Simulate', icon: simulateIcon },
  ];

  const close = () => setOpen(false);

  return (
    <nav className={`sn${collapsed ? ' sn--collapsed' : ''}${open ? ' sn--open' : ''}`} aria-label={spanish ? 'Principal' : 'Main'}>
      <div className="sn-top">
        <Link href="/" className="sn-brand" aria-label={spanish ? 'Inicio de ScoreArc' : 'ScoreArc home'} onClick={close}>
          {/* The delivered artwork, used as an image: the lockup's kerning and
              its underline arc are the designer's. The wordmark cannot survive
              a 64px rail, so the collapsed rail shows the mark alone. */}
          {collapsed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="sn-mark" src="/brand/scorearc-mark-dark.svg" alt="ScoreArc" width={30} height={30} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="sn-lockup" src="/brand/scorearc-lockup-3a-dark.svg" alt="ScoreArc" width={300} height={104} />
          )}
        </Link>
        <button
          type="button"
          className="sn-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? (spanish ? 'Expandir' : 'Expand') : (spanish ? 'Contraer' : 'Collapse')}
          onClick={() => {
            trackEvent('Nav toggled', { collapsed: !collapsed });
            setCollapsed(!collapsed);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {collapsed ? <polyline points="9 6 15 12 9 18" /> : <polyline points="15 6 9 12 15 18" />}
          </svg>
        </button>
        <button
          type="button"
          className="sn-burger"
          aria-expanded={open}
          aria-controls="sn-panel"
          aria-label={open ? (spanish ? 'Cerrar menú' : 'Close menu') : (spanish ? 'Abrir menú' : 'Open menu')}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      <div className="sn-panel" id="sn-panel" ref={panelRef}>
        <div className="sn-group">
          {siteItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sn-item${item.match(pathname) ? ' sn-item--active' : ''}`}
              title={collapsed ? item.label : undefined}
              onClick={() => {
                trackEvent('Section opened', { section: item.label, surface: 'sitenav' });
                close();
              }}
            >
              <span className="sn-icon">{item.icon}</span>
              <span className="sn-label">{item.label}</span>
            </Link>
          ))}
          {soonItems.map((item) => (
            <span key={item.label} className="sn-item sn-item--soon" title={collapsed ? item.label : undefined} aria-disabled="true">
              <span className="sn-icon">{item.icon}</span>
              <span className="sn-label">{item.label}</span>
              <span className="sn-soon">{spanish ? 'pronto' : 'soon'}</span>
            </span>
          ))}
        </div>

        <div className="sn-group">
          <span className="sn-heading">{spanish ? 'Competiciones' : 'Competitions'}</span>
          {competitions.map((c) => {
            const isActive = active?.competition.id === c.id;
            const seasonId = isActive ? active.season.id : c.currentSeasonId;
            return (
              <div key={c.id} className="sn-comp">
                <Link
                  href={`/c/${c.id}/${seasonId}`}
                  className={`sn-item${isActive ? ' sn-item--current' : ''}`}
                  title={collapsed ? c.shortName : undefined}
                  onClick={() => {
                    trackEvent('Competition opened', { competition: c.id, season: seasonId, source: 'sitenav' });
                    close();
                  }}
                >
                  <span className="sn-icon sn-icon--comp">
                    <CompetitionMark logo={c.logo} logoInvert={c.logoInvert} emblem={c.emblem} name={c.name} size={16} />
                  </span>
                  <span className="sn-label">{c.shortName}</span>
                </Link>
                {isActive && (
                  <div className="sn-sub">
                    {competitionSections(active, spanish).map((s) => (
                      <Link
                        key={s.href}
                        href={s.href}
                        className={`sn-item sn-item--sub${s.match(pathname) ? ' sn-item--active' : ''}`}
                        title={collapsed ? s.label : undefined}
                        onClick={() => {
                          trackEvent('Section opened', { section: s.label, surface: 'sitenav' });
                          close();
                        }}
                      >
                        <span className="sn-icon">{s.icon}</span>
                        <span className="sn-label">{s.label}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <a className="sn-credit" href="https://github.com/mcasillas17" target="_blank" rel="noreferrer" title={collapsed ? 'Built by elOpenMike' : undefined}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" /></svg>
          <span className="sn-credit-text">{spanish ? 'Creado por' : 'Built by'} <strong>elOpenMike</strong></span>
        </a>
      </div>
    </nav>
  );
}
