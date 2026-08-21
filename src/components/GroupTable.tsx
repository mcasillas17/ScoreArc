import type { Group } from "@/server/data/types";
import TeamBadge from "./TeamBadge";
import { teamHref } from './teamHref';
import { groupRowClass } from "./groupRowClass";
import { useTranslations } from '@/i18n/I18nProvider';
import { translatedGroupName } from './translatedGroupName';

interface GroupTableProps {
  group: Group;
  teamStyle?: 'flag' | 'crest';
  teamBase?: string;
}

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

export default function GroupTable({ group, teamStyle, teamBase }: GroupTableProps) {
  const t = useTranslations();
  const started = group.standings.some((s) => s.played > 0);
  return (
    <div className="group-card">
      <h2 className="group-name">{translatedGroupName(group, t)}</h2>
      {!started ? (
        <p className="lz-preseason">{t('standings.preseason')}</p>
      ) : null}
      <table className="standings-table">
        <thead>
          <tr>
            <th title={t('standings.positionTooltip')}>{t('standings.positionAbbreviation')}</th>
            <th className="team-col">{t('standings.team')}</th>
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
          {group.standings.map((s) => (
            <tr key={s.team.id} className={groupRowClass(s, started)}>
              <td className="rank-cell">{started ? s.rank : ''}</td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge team={s.team} size={22} style={teamStyle} href={teamHref(teamBase, s.team)} />
                  <span className="team-name">{s.team.name}</span>
                </div>
              </td>
              <td>{s.played}</td>
              <td>{s.wins}</td>
              <td>{s.draws}</td>
              <td>{s.losses}</td>
              <td>{fmtGD(s.goalDifference)}</td>
              <td className="pts-cell">{s.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
