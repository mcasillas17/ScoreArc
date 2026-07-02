import Link from 'next/link';
import type { Competition, Season } from '@/server/data/competitions';
import type { HubStatus } from '@/lib/hubStatus';

interface Tile {
  comp: Competition;
  season: Season;
  status: HubStatus;
  count: number;
  live: number;
}

interface Props {
  tiles: Tile[];
}

const GROUPS: { status: HubStatus; label: string; labelClass: string }[] = [
  { status: 'live',     label: 'Live now',      labelClass: 'hub-group-label--live' },
  { status: 'upcoming', label: 'Starting soon', labelClass: 'hub-group-label--upcoming' },
  { status: 'ongoing',  label: 'Ongoing',       labelClass: 'hub-group-label--ongoing' },
];

function badge(status: HubStatus): { text: string; className: string } {
  switch (status) {
    case 'live':     return { text: '● LIVE',       className: 'hub-badge--live' };
    case 'upcoming': return { text: 'SOON',          className: 'hub-badge--upcoming' };
    case 'ongoing':  return { text: 'IN PROGRESS',  className: 'hub-badge--ongoing' };
  }
}

function subLine(tile: Tile): string {
  switch (tile.status) {
    case 'live':
      return `${tile.live} live · ${tile.count} matches`;
    case 'upcoming':
      return `${tile.comp.shortName} · ${tile.season.label} season`;
    case 'ongoing':
      return `${tile.count} matches`;
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
              {status === 'live' && <span className="hub-live-dot" />}
              {label}
            </div>
            <div className="hub-grid">
              {group.map((tile) => {
                const b = badge(tile.status);
                return (
                  <Link
                    key={tile.comp.id}
                    href={`/c/${tile.comp.id}/${tile.season.id}`}
                    className="hub-tile"
                  >
                    <div className="hub-tile-top">
                      <span className="hub-emblem">{tile.comp.emblem}</span>
                      <span className={`hub-badge ${b.className}`}>{b.text}</span>
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
