'use client';

import { useState } from 'react';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  soon?: boolean;
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const NAV: NavItem[] = [
  {
    href: '#bracket',
    label: 'Bracket',
    active: true,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M6 4v4a3 3 0 0 0 3 3h2" />
        <path d="M6 20v-4a3 3 0 0 1 3-3h2" />
        <circle cx="18" cy="12" r="2" />
        <path d="M11 12h5" />
        <circle cx="5" cy="4" r="1.5" />
        <circle cx="5" cy="20" r="1.5" />
      </svg>
    ),
  },
  {
    href: '#standings',
    label: 'Standings',
    icon: (
      <svg {...ICON_PROPS}>
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="14" y2="18" />
      </svg>
    ),
  },
  {
    href: '#live',
    label: 'Live Scores',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 12h3l2 5 4-12 2 7h7" />
      </svg>
    ),
  },
  {
    href: '#predict',
    label: 'Predict',
    soon: true,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 16.5 7.1 18.2 8 12.7 4 8.8 9.5 8z" />
      </svg>
    ),
  },
];

function GithubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span className="sidebar-ball" aria-hidden="true">⚽</span>
        <span className="sidebar-wordmark">ScoreArc</span>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {collapsed ? (
              <polyline points="9 6 15 12 9 18" />
            ) : (
              <polyline points="15 6 9 12 15 18" />
            )}
          </svg>
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        {NAV.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={`nav-item${item.active ? ' nav-item--active' : ''}`}
            title={collapsed ? item.label : undefined}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.soon && <span className="nav-soon">soon</span>}
          </a>
        ))}
      </nav>

      <a
        className="sidebar-credit"
        href="https://github.com/mcasillas17"
        target="_blank"
        rel="noreferrer"
        title={collapsed ? 'Built by elOpenMike' : undefined}
      >
        <GithubIcon />
        <span className="credit-text">
          Built by <strong>elOpenMike</strong>
        </span>
      </a>
    </aside>
  );
}
