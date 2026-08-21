'use client';

import LanguageText from './LanguageText';
import type { Standing } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import TeamBadge from './TeamBadge';
import { teamHref } from './teamHref';
import LeagueDial from './LeagueDial';
import { splitByCut } from './splitByCut';

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

function Row({ s, teamStyle, lig, teamBase }: { s: Standing; teamStyle: TeamStyle; lig: boolean; teamBase?: string }) {
  return (
    <div className={`ll-row${lig ? ' ll-row--in' : ''}`}>
      <span className="ll-rank">{s.rank}</span>
      <TeamBadge team={s.team} size={26} style={teamStyle} href={teamHref(teamBase, s.team)} />
      <span className="ll-name">{s.team.name}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}

export default function LeagueLadder({
  standings, qualification, teamStyle, teamBase,
}: {
  standings: Standing[];
  qualification: { cut: number; label: string };
  teamStyle: TeamStyle;
  teamBase?: string;
}) {
  if (standings.length === 0) {
    return <div className="empty-section"><p className="empty-text"><LanguageText en="Standings are unavailable right now." es="La clasificación no está disponible en este momento." /></p></div>;
  }
  const { inCut, out, started } = splitByCut(standings, qualification.cut);

  return (
    <div className="ll-card">
      <div className="ll-split">
        <div className="ll-left">
          <LeagueDial standings={standings} cut={qualification.cut} teamStyle={teamStyle} />
          {!started ? (
            <p className="lz-preseason"><LanguageText en="Season not started — no matches played yet." es="La temporada no ha comenzado — aún no hay partidos jugados." /></p>
          ) : (
            <div className="ll-legend">
              <span><i className="ll-dot ll-dot--in" />{qualification.label} · top {qualification.cut}</span>
              <span><i className="ll-dot ll-dot--out" /><LanguageText en="Out" es="Fuera" /></span>
            </div>
          )}
        </div>
        <div className="ll-right">
          {/* Before kick-off there is no cut to draw. Rendering the bands anyway
              leaves a labelled "Quarterfinals" header over zero rows and an
              "Out" header numbered from the config (e.g. 9-18) sitting above
              the whole table — a count that is simply wrong. One flat list. */}
          {!started ? (
            // Plain `ll-band`, deliberately NOT `ll-band--out`: that class
            // carries `.ll-band--out .ll-row { opacity: 0.5 }`, which would dim
            // every club as if eliminated — the same false claim as marking
            // them all qualified, just inverted.
            <div className="ll-band">
              {standings.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig={false} teamBase={teamBase} />)}
            </div>
          ) : (<>
            <div className="ll-band">
              <div className="ll-band-label ll-band-label--in">
                <span>◆ {qualification.label}</span><span className="ll-band-n"><LanguageText en="Quarterfinals" es="Cuartos de final" /></span><span className="ll-rule" />
              </div>
              {inCut.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig teamBase={teamBase} />)}
            </div>
            <div className="ll-cutline"><span className="ll-rule" /><span><LanguageText en={`${qualification.label} cut`} es={`Corte de ${qualification.label}`} /></span><span className="ll-rule" /></div>
            <div className="ll-band ll-band--out">
              <div className="ll-band-label">
                <span><LanguageText en="Out" es="Fuera" /></span><span className="ll-band-n">{qualification.cut + 1}–{standings.length}</span><span className="ll-rule" />
              </div>
              {out.map((s) => <Row key={s.team.id} s={s} teamStyle={teamStyle} lig={false} teamBase={teamBase} />)}
            </div>
          </>)}
        </div>
      </div>
    </div>
  );
}
