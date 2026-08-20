'use client';

import type { Competition, Season } from '@/server/data/competitions';
import type { HubStatus } from '@/lib/hubStatus';
import TrackedCompetitionLink from './TrackedCompetitionLink';
import LocalTime from './LocalTime';
import CompetitionMark from './CompetitionMark';
import type { TileSubLine } from '@/lib/hubTile';
import { useLanguage } from './LanguageProvider';

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
const GROUPS: { status: HubStatus; label: string; labelEs: string; labelClass: string }[] = [
  // Not "Live now" — the band above already owns that heading, and it lists
  // matches while this lists the competitions they belong to.
  { status: 'live',     label: 'Playing now',   labelEs: 'Jugando ahora', labelClass: 'hub-group-label--live' },
  { status: 'ongoing',  label: 'Ongoing',       labelEs: 'En curso', labelClass: 'hub-group-label--ongoing' },
  { status: 'upcoming', label: 'Starting soon', labelEs: 'Próximamente', labelClass: 'hub-group-label--upcoming' },
  { status: 'finished', label: 'Finished',      labelEs: 'Finalizado', labelClass: 'hub-group-label--finished' },
];

function badge(tile: Tile, spanish: boolean): { text: string; className: string } {
  switch (tile.status) {
    case 'live':     return { text: spanish ? 'EN VIVO' : 'LIVE', className: 'hub-badge--live' };
    case 'upcoming': return { text: spanish ? 'PRONTO' : 'SOON', className: 'hub-badge--upcoming' };
    case 'ongoing':  return { text: spanish ? 'EN CURSO' : 'IN PROGRESS', className: 'hub-badge--ongoing' };
    case 'finished': return { text: tile.champion ? `🏆 ${tile.champion}` : (spanish ? 'FINALIZADO' : 'FINISHED'), className: 'hub-badge--finished' };
  }
}

// live + ongoing are "active" states that get an animated status dot.
const isActive = (s: HubStatus) => s === 'live' || s === 'ongoing';

function translateSubLine(text: string, spanish: boolean): string {
  if (!spanish) return text;
  return text
    .replace(/\bchampions\b/gi, 'campeones')
    .replace(/\bcomplete\b/gi, 'completo')
    .replace(/ live ·/g, ' en vivo ·')
    .replace(/Starts /g, 'Comienza ')
    .replace(/ season/g, ' temporada')
    .replace(/Next: /g, 'Próximo: ')
    .replace(/Leaders: /g, 'Líderes: ');
}

export default function HubTiles({ tiles }: Props) {
  const { language } = useLanguage();
  const spanish = language === 'es';

  return (
    <div className="hub-groups">
      {GROUPS.map(({ status, label, labelEs, labelClass }) => {
        const group = tiles.filter((t) => t.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} className="hub-group">
            <div className={`hub-group-label ${labelClass}`}>
              {isActive(status) && <span className={`hub-ping hub-ping--${status}`} aria-hidden />}
              {spanish ? labelEs : label}
            </div>
            <div className="hub-grid">
              {group.map((tile) => {
                const b = badge(tile, spanish);
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
                      {translateSubLine(tile.subLine.text, spanish)}
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
