import type { Competition, Season } from '@/server/data/competitions';
import type { HubStatus } from '@/lib/hubStatus';
import TrackedCompetitionLink from './TrackedCompetitionLink';
import LocalTime from './LocalTime';
import CompetitionMark from './CompetitionMark';
import type { TileSubLine } from '@/lib/hubTile';

interface Tile {
  comp: Competition;
  season: Season;
  status: HubStatus;
  live: number;
  champion?: string | null;
  // What the tile says under the competition name. Computed on the server by
  // `tileSubLine` so the rule is one testable function rather than a switch
  // spread across a component — but the `when` is formatted on the client,
  // because the server's clock is not the reader's.
  subLine: TileSubLine;
}

interface Props {
  tiles: Tile[];
}

// Ordered by relevance: matches in play first, then tournaments already
// underway, then ones yet to start.
const GROUPS: { status: HubStatus; label: string; labelClass: string }[] = [
  // Not "Live now" — the band above already owns that heading, and it lists
  // matches while this lists the competitions they belong to.
  { status: 'live',     label: 'Playing now',   labelClass: 'hub-group-label--live' },
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
                  <TrackedCompetitionLink
                    key={tile.comp.id}
                    competition={tile.comp.id}
                    season={tile.season.id}
                    source="hub"
                    className="hub-tile"
                  >
                    {/* The logo leads, at a size it can actually be read at.
                        Everything else stacks to the right of it. */}
                    <span className="hub-mark">
                      <CompetitionMark
                        logo={tile.comp.logo}
                        logoInvert={tile.comp.logoInvert}
                        emblem={tile.comp.emblem}
                        name={tile.comp.name}
                        size={64}
                      />
                    </span>
                    <div className="hub-body">
                    <div className="hub-tile-top">
                      <span className={`hub-badge ${b.className}`}>
                        {isActive(tile.status) && <span className={`hub-bdot hub-bdot--${tile.status}`} aria-hidden />}
                        {b.text}
                      </span>
                    </div>
                    <div className="hub-name">{tile.comp.name}</div>
                    <div className="hub-sub">
                      {tile.subLine.text}
                      {tile.subLine.when && (
                        <>, <LocalTime iso={tile.subLine.when} mode="day" /></>
                      )}
                    </div>
                    </div>
                  </TrackedCompetitionLink>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
