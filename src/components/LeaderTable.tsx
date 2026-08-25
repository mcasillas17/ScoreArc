import { useTranslations } from '@/i18n/I18nProvider';
import type { StatLeader } from "@/server/data/types";
import TeamBadge from "./TeamBadge";
import { teamHref } from './teamHref';
import PlayerName from './PlayerName';

// One leaderboard, any metric. Goals and assists ship in the same shape from
// the same response, so they get the same table rather than two files that
// drift apart the first time a column changes.
export default function LeaderTable({
  leaders,
  metric,
  teamStyle = 'flag',
  teamBase,
  playerBase,
}: {
  leaders: StatLeader[];
  metric: 'goals' | 'assists';
  teamStyle?: 'flag' | 'crest';
  teamBase?: string;
  /** Competition-scoped prefix for player pages; without it names stay text. */
  playerBase?: string;
}) {
  const t = useTranslations();
  const metricAbbreviation = metric === 'goals'
    ? t('standings.goalsAbbreviation')
    : t('standings.assistsAbbreviation');
  const metricTooltip = metric === 'goals'
    ? t('standings.goalsTooltip')
    : t('standings.assistsTooltip');
  if (leaders.length === 0) {
    return <p className="empty-text">{t(metric === 'goals' ? 'standings.goalsUnavailable' : 'standings.assistsUnavailable')}</p>;
  }
  return (
    <div className="std-panel">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th title={t('standings.positionTooltip')}>{t('standings.positionAbbreviation')}</th>
            <th className="team-col">{t('standings.player')}</th>
            <th className="team-col">{t('standings.team')}</th>
            <th title={t('standings.matchesPlayedTooltip')}>{t('standings.matchesPlayedAbbreviation')}</th>
            <th className="pts-col" title={metricTooltip}>
              {metricAbbreviation}
            </th>
          </tr>
        </thead>
        <tbody>
          {leaders.map((s) => (
            <tr key={`${s.rank}-${s.player}`} className={s.rank === 1 ? "row-qualify" : ""}>
              <td className="rank-cell">{s.rank}</td>
              <td className="team-cell">
                <PlayerName
                  name={s.player}
                  slug={s.playerSlug}
                  playerBase={playerBase}
                  className="team-name"
                  linkClassName="ldr-player"
                />
              </td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  {/* Linked by teamId, not teamAbbr: the badge's synthetic
                      team carries the abbreviation as its id for display, and
                      /team/AME is a 404. */}
                  <TeamBadge
                    team={{ id: s.teamAbbr, name: s.teamName, abbr: s.teamAbbr, crestUrl: s.teamCrestUrl }}
                    size={20}
                    style={teamStyle}
                    href={s.teamId ? teamHref(teamBase, { id: s.teamId }) : undefined}
                  />
                  <span className="team-name std-muted">{s.teamAbbr}</span>
                </div>
              </td>
              <td>{s.matches ?? "–"}</td>
              <td className="pts-cell">{s.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
