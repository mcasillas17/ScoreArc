'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle, Zone } from '@/server/data/competitions';
import TeamBadge from './TeamBadge';
import { teamHref } from './teamHref';
import ZoneRing from './ZoneRing';
import { toBands, ZONE_VAR } from './zoneBands';
import { useTranslations } from '@/i18n/I18nProvider';

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

// A league table banded by outcome: the arc on the left carries the shape of
// the season, the table on the right carries the detail. Same split as the
// Liguilla ladder, generalised from one boundary to many.
export default function LeagueZoneTable({
  standings, zones, teamStyle, teamBase, rounds,
}: {
  standings: Standing[];
  zones: Zone[];
  teamStyle: TeamStyle;
  teamBase?: string;
  // Season length in rounds — threaded to `toBands` so a `champion`-kind zone
  // only draws once the title is mathematically clinched.
  rounds?: number;
}) {
  const t = useTranslations();
  if (standings.length === 0) {
    return (
      <div className="empty-section">
        <p className="empty-text">{t('standings.unavailable')}</p>
      </div>
    );
  }
  const bands = toBands(standings, zones, { rounds });
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
            <p className="lz-preseason">{t('standings.preseason')}</p>
          ) : null}
          <ZoneRing standings={standings} zones={zones} teamStyle={teamStyle} rounds={rounds} />
          <div className="ll-legend lz-legend">
            {marked.map((b) => (
              <span key={`${b.kind}-${b.from}`}>
                <i className="ll-dot" style={{ background: `var(${ZONE_VAR[b.kind]})` }} />
                {b.labelKey ? t(b.labelKey) : null}
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
              {b.labelKey ? (
                <div className="ll-band-label lz-band-label">
                  <span>◆ {t(b.labelKey)}</span>
                  <span className="ll-band-n">
                    {b.from === b.to ? b.from : `${b.from}–${b.to}`}
                  </span>
                  <span className="ll-rule" />
                </div>
              ) : null}
              {b.standings.map((s) => (
                <Row key={s.team.id} s={s} teamStyle={teamStyle} marked={b.kind !== 'mid'} started={started} teamBase={teamBase} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ s, teamStyle, marked, started, teamBase }: { s: Standing; teamStyle: TeamStyle; marked: boolean; started: boolean; teamBase?: string }) {
  return (
    <div className={`ll-row lz-row${marked ? ' lz-row--marked' : ''}${started ? '' : ' lz-row--preseason'}`}>
      {started ? <span className="ll-rank">{s.rank}</span> : null}
      <TeamBadge team={s.team} size={26} style={teamStyle} href={teamHref(teamBase, s.team)} />
      <span className="ll-name">{s.team.name}</span>
      <span className="lz-pl">{s.played}</span>
      <span className="ll-gd">{fmtGD(s.goalDifference)}</span>
      <span className="ll-pts">{s.points}</span>
    </div>
  );
}
