import { useTranslations } from '@/i18n/I18nProvider';
import type { Group } from "@/server/data/types";
import { thirdPlacedRanking, QUALIFYING_THIRDS } from "@/lib/standings";
import TeamBadge from "./TeamBadge";
import { teamHref } from './teamHref';

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

export default function ThirdPlaceTable({
  groups,
  teamStyle,
  teamBase,
}: {
  groups: Group[];
  teamStyle?: 'flag' | 'crest';
  teamBase?: string;
}) {
  const t = useTranslations();
  const rows = thirdPlacedRanking(groups);
  // thirdPlacedRanking only sets `qualifies` when the numeric criteria actually
  // separate 8th from 9th. If nothing qualifies, the order came from
  // groupId.localeCompare — alphabetical, not earned — so showing a rank or a
  // row class here would dress that up as a standing.
  const ranked = rows.some((r) => r.qualifies);
  if (rows.length === 0) {
    return <p className="empty-text">{t('standings.thirdPlaceUnavailable')}</p>;
  }
  return (
    <div className="std-panel">
      {!ranked ? (
        <p className="lz-preseason">{t('standings.thirdPlaceUnranked')}</p>
      ) : null}
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th title={t('standings.positionTooltip')}>{t('standings.positionAbbreviation')}</th>
            <th className="team-col">{t('standings.team')}</th>
            <th title={t('standings.groupTooltip')}>{t('standings.groupAbbreviation')}</th>
            <th title={t('standings.playedTooltip')}>{t('standings.playedAbbreviation')}</th>
            <th title={t('standings.winsTooltip')}>{t('standings.winsAbbreviation')}</th>
            <th title={t('standings.drawsTooltip')}>{t('standings.drawsAbbreviation')}</th>
            <th title={t('standings.lossesTooltip')}>{t('standings.lossesAbbreviation')}</th>
            <th title={t('standings.goalDifferenceTooltip')}>{t('standings.goalDifferenceAbbreviation')}</th>
            <th className="pts-col" title={t('standings.pointsTooltip')}>
              {t('standings.pointsAbbreviation')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.team.id} className={!ranked ? "" : r.qualifies ? "row-qualify" : "row-out"}>
              <td className="rank-cell">{ranked ? r.rank : ''}</td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge team={r.team} size={22} style={teamStyle} href={teamHref(teamBase, r.team)} />
                  <span className="team-name">{r.team.name}</span>
                </div>
              </td>
              <td className="std-muted">{r.groupId}</td>
              <td>{r.played}</td>
              <td>{r.wins}</td>
              <td>{r.draws}</td>
              <td>{r.losses}</td>
              <td>{fmtGD(r.goalDifference)}</td>
              <td className="pts-cell">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="std-note">
        <span className="std-swatch" /> {t('standings.thirdPlaceAdvanceNote', QUALIFYING_THIRDS)}
      </p>
    </div>
  );
}
