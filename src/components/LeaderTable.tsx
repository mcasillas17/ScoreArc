import LanguageText from './LanguageText';
import type { StatLeader } from "@/server/data/types";
import TeamBadge from "./TeamBadge";
import { teamHref } from './teamHref';

// One leaderboard, any metric. Goals and assists ship in the same shape from
// the same response, so they get the same table rather than two files that
// drift apart the first time a column changes.
export default function LeaderTable({
  leaders,
  metric,
  teamStyle = 'flag',
  teamBase,
}: {
  leaders: StatLeader[];
  metric: { abbr: string; title: string; titleEs?: string };
  teamStyle?: 'flag' | 'crest';
  teamBase?: string;
}) {
  if (leaders.length === 0) {
    return <p className="empty-text"><LanguageText en={`${metric.title} data is unavailable right now.`} es={`Los datos de ${metric.titleEs ?? metric.title} no están disponibles en este momento.`} /></p>;
  }
  return (
    <div className="std-panel">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col"><LanguageText en="Player" es="Jugador" /></th>
            <th className="team-col"><LanguageText en="Team" es="Equipo" /></th>
            <th title="Matches played">MP</th>
            <th className="pts-col" title={metric.title}>
              {metric.abbr}
            </th>
          </tr>
        </thead>
        <tbody>
          {leaders.map((s) => (
            <tr key={`${s.rank}-${s.player}`} className={s.rank === 1 ? "row-qualify" : ""}>
              <td className="rank-cell">{s.rank}</td>
              <td className="team-cell">
                <span className="team-name">{s.player}</span>
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
