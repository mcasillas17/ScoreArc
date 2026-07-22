import Link from 'next/link';
import type { Competition, Season } from '@/server/data/competitions';
import type { HubStatus } from '@/lib/hubStatus';

interface Tile {
  comp: Competition;
  season: Season;
  status: HubStatus;
  count: number;
  live: number;
  champion?: string | null;
}

interface Props {
  tiles: Tile[];
}

// Ordered by relevance: matches in play first, then tournaments already
// underway, then ones yet to start.
const GROUPS: { status: HubStatus; label: string; labelClass: string }[] = [
  { status: 'live',     label: 'Live now',      labelClass: 'hub-group-label--live' },
  { status: 'ongoing',  label: 'Ongoing',       labelClass: 'hub-group-label--ongoing' },
  { status: 'upcoming', label: 'Starting soon', labelClass: 'hub-group-label--upcoming' },
  { status: 'finished', label: 'Finished',      labelClass: 'hub-group-label--finished' },
];

function badge(tile: Tile): { text: string; className: string } {
  switch (tile.status) {
    case 'live':     return { text: 'LIVE',         className: 'hub-badge--live' };
    case 'upcoming': return { text: 'SOON',          className: 'hub-badge--upcoming' };
    case 'ongoing':  return { text: 'IN PROGRESS',  className: 'hub-badge--ongoing' };
    case 'finished': return { text: tile.champion ? `🏆 ${tile.champion}` : 'FINISHED', className: 'hub-badge--finished' };
  }
}

// live + ongoing are "active" states that get an animated status dot.
const isActive = (s: HubStatus) => s === 'live' || s === 'ongoing';

function subLine(tile: Tile): string {
  switch (tile.status) {
    case 'live':
      return `${tile.live} live · ${tile.count} matches`;
    case 'upcoming':
      return `${tile.comp.shortName} · ${tile.season.label} season`;
    case 'ongoing':
      return `${tile.count} matches`;
    case 'finished':
      return tile.champion ? `${tile.champion} — champions` : `${tile.season.label} · complete`;
  }
}

export default function HubTiles({ tiles }: Props) {
  return (
    <div className="hub-groups">
      {GROUPS.map(({ status, label, labelClass }) => {
        const group = tiles.filter((t) => t.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} className="hub-group">
            <div className={`hub-group-label ${labelClass}`}>
              {isActive(status) && <span className={`hub-ping hub-ping--${status}`} aria-hidden />}
              {label}
            </div>
            <div className="hub-grid">
              {group.map((tile) => {
                const b = badge(tile);
                return (
                  <Link
                    key={tile.comp.id}
                    href={`/c/${tile.comp.id}/${tile.season.id}`}
                    className="hub-tile"
                  >
                    <div className="hub-tile-top">
                      <span className="hub-emblem">{tile.comp.emblem}</span>
                      <span className={`hub-badge ${b.className}`}>
                        {isActive(tile.status) && <span className={`hub-bdot hub-bdot--${tile.status}`} aria-hidden />}
                        {b.text}
                      </span>
                    </div>
                    <div className="hub-name">{tile.comp.name}</div>
                    <div className="hub-sub">{subLine(tile)}</div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
