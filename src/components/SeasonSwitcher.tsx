'use client';

import { useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';

// A proper timeline: editions placed proportionally by year on a continuous axis,
// so equal gaps are equal and a missing edition (e.g. 2010) shows as a faint gap.
// The gold PLAYHEAD marks the current edition and GLIDES from the previously-
// viewed one when you switch (the page remounts, so we replay the slide from the
// last position, remembered in sessionStorage).
export default function SeasonSwitcher({
  competition,
  activeSeasonId,
}: {
  competition: Competition;
  activeSeasonId: string;
}) {
  const editions = Object.values(competition.seasons)
    .map((s) => ({ id: s.id, label: s.label, year: parseInt(s.id, 10) }))
    .filter((s) => Number.isFinite(s.year))
    .sort((a, b) => a.year - b.year);

  const min = editions.length ? editions[0].year : 0;
  const max = editions.length ? editions[editions.length - 1].year : 1;
  const span = max - min || 1;
  const pos = (year: number) => ((year - min) / span) * 100;
  const activeYear = editions.find((e) => e.id === activeSeasonId)?.year ?? max;
  const currentPos = pos(activeYear);

  const phRef = useRef<HTMLSpanElement>(null);
  const didSlide = useRef(false);

  // On each edition switch the page remounts, so we replay the slide: start the
  // playhead at the previously-viewed edition's position (remembered in
  // sessionStorage), force a reflow to lock that as the start, then transition
  // to the new position. Direct DOM avoids React's "add transition + change value
  // in one render doesn't animate" gotcha.
  useLayoutEffect(() => {
    if (didSlide.current) return; // guard React Strict-Mode double-invoke (dev)
    didSlide.current = true;
    const el = phRef.current;
    const key = `wc-tl-prev-${competition.id}`;
    let prevYear: number | null = null;
    try {
      const v = sessionStorage.getItem(key);
      prevYear = v ? parseInt(v, 10) : null;
      sessionStorage.setItem(key, String(activeYear));
    } catch {
      /* sessionStorage unavailable */
    }
    if (!el) return;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && prevYear && prevYear !== activeYear && prevYear >= min && prevYear <= max) {
      el.style.transition = 'none';
      el.style.left = `${pos(prevYear)}%`;
      void el.offsetWidth; // reflow -> commit the start position
      el.style.transition = 'left 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.left = `${currentPos}%`;
    } else {
      el.style.transition = 'none';
      el.style.left = `${currentPos}%`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeasonId]);

  if (editions.length < 2) return null;

  // Faint markers for missing editions on the tournament's cadence (e.g. 2010).
  const step = editions.slice(1).reduce((m, e, i) => Math.min(m, e.year - editions[i].year), Infinity);
  const present = new Set(editions.map((e) => e.year));
  const gaps: number[] = [];
  if (Number.isFinite(step) && step > 0) {
    for (let y = min + step; y < max; y += step) if (!present.has(y)) gaps.push(y);
  }

  return (
    <nav className="wc-timeline" aria-label={`${competition.shortName} editions`}>
      <div className="wc-tl-track">
        <div className="wc-tl-axis" aria-hidden />
        <span ref={phRef} className="wc-tl-playhead" aria-hidden style={{ left: `${currentPos}%` }} />
        {gaps.map((y) => (
          <span key={`gap-${y}`} className="wc-tl-gap" style={{ left: `${pos(y)}%` }} title={`${y} — not available`} aria-hidden>
            <span className="wc-tl-gap-dot" />
            <span className="wc-tl-gap-year">{y}</span>
          </span>
        ))}
        {editions.map((e) => {
          const isActive = e.id === activeSeasonId;
          return (
            <Link
              key={e.id}
              href={`/c/${competition.id}/${e.id}`}
              className={`wc-tl-node${isActive ? ' wc-tl-node--active' : ''}`}
              style={{ left: `${pos(e.year)}%` }}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="wc-tl-dot" />
              <span className="wc-tl-year">{e.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
