import Link from 'next/link';
import type { Competition } from '@/server/data/competitions';

// Edition picker as a horizontal timeline — years on a line, oldest -> newest,
// the current edition a filled dot. Renders only for multi-season competitions.
export default function SeasonSwitcher({
  competition,
  activeSeasonId,
}: {
  competition: Competition;
  activeSeasonId: string;
}) {
  const ids = Object.keys(competition.seasons).sort((a, b) => a.localeCompare(b));
  if (ids.length < 2) return null;
  return (
    <nav className="season-timeline" aria-label={`${competition.shortName} editions`}>
      <ol className="season-tl-track">
        {ids.map((id) => {
          const isActive = id === activeSeasonId;
          return (
            <li key={id} className="season-tl-item">
              <Link
                href={`/c/${competition.id}/${id}`}
                className={`season-tl-node${isActive ? ' season-tl-node--active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="season-tl-dotwrap">
                  <span className="season-tl-dot" aria-hidden />
                </span>
                <span className="season-tl-year">{competition.seasons[id].label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
