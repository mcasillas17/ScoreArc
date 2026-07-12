import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';

// A proper timeline: editions placed proportionally by year on a continuous axis,
// so equal 4-year gaps are equal and a missing edition (e.g. 2010) shows as a
// real gap with a faint, non-clickable marker. Current edition = the playhead.
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
  if (editions.length < 2) return null;

  const min = editions[0].year;
  const max = editions[editions.length - 1].year;
  const span = max - min || 1;
  const pos = (year: number) => ((year - min) / span) * 100;

  // Gap markers: grid points on the tournament's cadence (min diff between
  // editions, e.g. 4 years) that have no edition — shown faint so the missing
  // year reads as a real gap, not just wide spacing.
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
        {gaps.map((y) => (
          <span
            key={`gap-${y}`}
            className="wc-tl-gap"
            style={{ left: `${pos(y)}%` }}
            title={`${y} — not available`}
            aria-hidden
          >
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
