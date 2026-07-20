'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import TeamBadge from './TeamBadge';
import LeagueDial from './LeagueDial';
import { splitByCut } from './leagueLadder';

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

function Row({ s, teamStyle, lig }: { s: Standing; teamStyle: TeamStyle; lig: boolean }) {
  return (
    <div className={`ll-row${lig ? ' ll-row--in' : ''}`}>
      <span className="ll-rank">{s.rank}</span>
      <TeamBadge team={s.team} size={26} style={teamStyle} />
      <span className="ll-name">{s.team.name}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}

export default function LeagueLadder({
  standings, qualification, teamStyle,
}: {
  standings: Standing[];
  qualification: { cut: number; label: string };
  teamStyle: TeamStyle;
}) {
  if (standings.length === 0) {
    return <div className="empty-section"><p className="empty-text">Standings are unavailable right now.</p></div>;
  }
  const { inCut, out } = splitByCut(standings, qualification.cut);

  return (
    <div className="ll-card">
      <div className="ll-split">
        <div className="ll-left">
          <LeagueDial standings={standings} cut={qualification.cut} teamStyle={teamStyle} />
          <div className="ll-legend">
            <span><i className="ll-dot ll-dot--in" />{qualification.label} · top {qualification.cut}</span>
            <span><i className="ll-dot ll-dot--out" />Out</span>
          </div>
        </div>
        <div className="ll-right">
          <div className="ll-band">
            <div className="ll-band-label ll-band-label--in">
              <span>◆ {qualification.label}</span><span className="ll-band-n">Quarterfinals</span><span className="ll-rule" />
            </div>
            {inCut.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig />)}
          </div>
          <div className="ll-cutline"><span className="ll-rule" /><span>{qualification.label} cut</span><span className="ll-rule" /></div>
          <div className="ll-band ll-band--out">
            <div className="ll-band-label">
              <span>Out</span><span className="ll-band-n">{qualification.cut + 1}–{standings.length}</span><span className="ll-rule" />
            </div>
            {out.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig={false} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
