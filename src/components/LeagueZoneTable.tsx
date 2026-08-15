'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle, Zone } from '@/server/data/competitions';
import TeamBadge from './TeamBadge';
import ZoneRing from './ZoneRing';
import { toBands, ZONE_VAR } from './zoneBands';

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

// A league table banded by outcome: the arc on the left carries the shape of
// the season, the table on the right carries the detail. Same split as the
// Liguilla ladder, generalised from one boundary to many.
export default function LeagueZoneTable({
  standings, zones, teamStyle,
}: {
  standings: Standing[];
  zones: Zone[];
  teamStyle: TeamStyle;
}) {
  if (standings.length === 0) {
    return (
      <div className="empty-section">
        <p className="empty-text">Standings are unavailable right now.</p>
      </div>
    );
  }
  const bands = toBands(standings, zones);
  const marked = bands.filter((b) => b.kind !== 'mid');
  // A season that has not kicked off has a table of zeros. Saying so is more
  // honest than drawing qualification arcs around results that do not exist.
  const played = standings.reduce((n, s) => n + s.played, 0);

  return (
    <div className="ll-card">
      <div className="ll-split">
        <div className="ll-left">
          <ZoneRing standings={standings} zones={zones} teamStyle={teamStyle} />
          {played === 0 ? (
            <p className="lz-preseason">Season not started — no matches played yet.</p>
          ) : null}
          <div className="ll-legend lz-legend">
            {marked.map((b) => (
              <span key={`${b.kind}-${b.from}`}>
                <i className="ll-dot" style={{ background: `var(${ZONE_VAR[b.kind]})` }} />
                {b.label}
              </span>
            ))}
          </div>
        </div>
        <div className="ll-right">
          {bands.map((b) => (
            <div
              key={`${b.kind}-${b.from}`}
              className={`ll-band lz-band lz-band--${b.kind}`}
              style={{ ['--zone' as string]: `var(${ZONE_VAR[b.kind]})` }}
            >
              {b.label ? (
                <div className="ll-band-label lz-band-label">
                  <span>◆ {b.label}</span>
                  <span className="ll-band-n">
                    {b.from === b.to ? b.from : `${b.from}–${b.to}`}
                  </span>
                  <span className="ll-rule" />
                </div>
              ) : null}
              {b.standings.map((s) => (
                <Row key={s.team.id} s={s} teamStyle={teamStyle} marked={b.kind !== 'mid'} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ s, teamStyle, marked }: { s: Standing; teamStyle: TeamStyle; marked: boolean }) {
  return (
    <div className={`ll-row lz-row${marked ? ' lz-row--marked' : ''}`}>
      <span className="ll-rank">{s.rank}</span>
      <TeamBadge team={s.team} size={26} style={teamStyle} />
      <span className="ll-name">{s.team.name}</span>
      <span className="lz-pl">{s.played}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}
