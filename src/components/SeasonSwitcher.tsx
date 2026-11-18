'use client';

import { useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';

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
  const locale = useLocale();
  const t = useTranslations();
  const editions = Object.values(competition.seasons)
    .map((s) => ({ id: s.id, label: s.label, year: parseInt(s.id, 10), startsAt: s.startsAt ?? '' }))
    .filter((s) => Number.isFinite(s.year))
    .sort((a, b) => a.year - b.year || a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  const phased = new Set(editions.map(e => e.year)).size < editions.length;
  // Same-year phases need distinct positions; yearly editions retain their proportional timeline.
  const positions = editions.map((edition, index) => ({ ...edition, point: phased ? index : edition.year }));

  const min = positions[0]?.point ?? 0;
  const max = positions.at(-1)?.point ?? 1;
  const span = max - min || 1;
  // Newest edition on the LEFT: the max year maps to 0%, the min to 100%.
  const pos = (point: number) => ((max - point) / span) * 100;
  const activePoint = positions.find((e) => e.id === activeSeasonId)?.point ?? max;
  const currentPos = pos(activePoint);

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
    const key = `wc-tl-prev-${competition.id}-${phased ? 'phases' : 'years'}`;
    let previousPoint: number | null = null;
    try {
      const v = sessionStorage.getItem(key);
      previousPoint = v ? parseInt(v, 10) : null;
      sessionStorage.setItem(key, String(activePoint));
    } catch {
      /* sessionStorage unavailable */
    }
    if (!el) return;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && previousPoint !== null && previousPoint !== activePoint && previousPoint >= min && previousPoint <= max) {
      el.style.transition = 'none';
      el.style.left = `${pos(previousPoint)}%`;
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
  if (!phased && Number.isFinite(step) && step > 0) {
    for (let y = min + step; y < max; y += step) if (!present.has(y)) gaps.push(y);
  }

  return (
    <nav className="wc-timeline" aria-label={t('seasonSwitcher.editions', competition.shortName)}>
      <div className="wc-tl-track">
        <div className="wc-tl-axis" aria-hidden />
        <span ref={phRef} className="wc-tl-playhead" aria-hidden style={{ left: `${currentPos}%` }} />
        {gaps.map((y) => (
          <span key={`gap-${y}`} className="wc-tl-gap" style={{ left: `${pos(y)}%` }} title={t('seasonSwitcher.notAvailable', y)} aria-hidden>
            <span className="wc-tl-gap-dot" />
            <span className="wc-tl-gap-year">{y}</span>
          </span>
        ))}
        {positions.map((e) => {
          const isActive = e.id === activeSeasonId;
          return (
            <Link
              key={e.id}
              href={`/${locale}/c/${competition.id}/${e.id}`}
              className={`wc-tl-node${isActive ? ' wc-tl-node--active' : ''}`}
              style={{ left: `${pos(e.point)}%` }}
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
