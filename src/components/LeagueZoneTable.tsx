'use client';

import LanguageText from './LanguageText';
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
        <p className="empty-text"><LanguageText en="Standings are unavailable right now." es="La clasificación no está disponible en este momento." /></p>
      </div>
    );
  }
  const bands = toBands(standings, zones);
  const marked = bands.filter((b) => b.kind !== 'mid');
  // toBands already strips the zones before kick-off, which takes the bands,
  // the band labels and the legend with it. What remains to suppress is the
  // rank number — ESPN's pre-season order is alphabetical, so numbering it
  // makes an accident look like a standing.
  const started = standings.some((s) => s.played > 0);

  return (
    <div className="ll-card">
      <div className="ll-split">
        <div className="ll-left">
          {!started ? (
            <p className="lz-preseason"><LanguageText en="Season not started — no matches played yet." es="La temporada no ha comenzado — aún no hay partidos jugados." /></p>
          ) : null}
          <ZoneRing standings={standings} zones={zones} teamStyle={teamStyle} />
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
                <Row key={s.team.id} s={s} teamStyle={teamStyle} marked={b.kind !== 'mid'} started={started} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ s, teamStyle, marked, started }: { s: Standing; teamStyle: TeamStyle; marked: boolean; started: boolean }) {
  return (
    <div className={`ll-row lz-row${marked ? ' lz-row--marked' : ''}${started ? '' : ' lz-row--preseason'}`}>
      {started ? <span className="ll-rank">{s.rank}</span> : null}
      <TeamBadge team={s.team} size={26} style={teamStyle} />
      <span className="ll-name">{s.team.name}</span>
      <span className="lz-pl">{s.played}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}
