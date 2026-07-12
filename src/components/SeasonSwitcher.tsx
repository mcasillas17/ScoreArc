'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';

// Edition/season picker — a compact dropdown next to the competition name.
// Renders only when a competition has more than one season; newest first.
export default function SeasonSwitcher({
  competition,
  activeSeasonId,
}: {
  competition: Competition;
  activeSeasonId: string;
}) {
  const ids = Object.keys(competition.seasons).sort((a, b) => b.localeCompare(a));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (ids.length < 2) return null;
  const active = competition.seasons[activeSeasonId];

  return (
    <div className="season-picker" ref={ref}>
      <button
        type="button"
        className="season-picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Edition: ${active?.label ?? activeSeasonId}. Change`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{active?.label ?? activeSeasonId}</span>
        <svg className={`season-caret${open ? ' season-caret--open' : ''}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="season-menu" role="listbox" aria-label={`${competition.shortName} editions`}>
          {ids.map((id) => {
            const isActive = id === activeSeasonId;
            return (
              <li key={id} role="option" aria-selected={isActive}>
                <Link
                  href={`/c/${competition.id}/${id}`}
                  className={`season-item${isActive ? ' season-item--active' : ''}`}
                  onClick={() => setOpen(false)}
                >
                  {competition.seasons[id].label}
                  {isActive && <span className="season-item-check" aria-hidden>✓</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
