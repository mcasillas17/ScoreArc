import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';

// Edition picker — shown only when a competition has more than one season.
// Newest first; the active season is highlighted.
export default function SeasonSwitcher({
  competition,
  activeSeasonId,
}: {
  competition: Competition;
  activeSeasonId: string;
}) {
  const ids = Object.keys(competition.seasons).sort((a, b) => b.localeCompare(a));
  if (ids.length < 2) return null;
  return (
    <nav className="season-switcher" aria-label={`${competition.shortName} editions`}>
      {ids.map((id) => (
        <Link
          key={id}
          href={`/c/${competition.id}/${id}`}
          className={`season-chip${id === activeSeasonId ? ' season-chip--active' : ''}`}
          aria-current={id === activeSeasonId ? 'page' : undefined}
        >
          {competition.seasons[id].label}
        </Link>
      ))}
    </nav>
  );
}
