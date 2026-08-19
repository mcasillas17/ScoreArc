import type { StatLeader } from "@/server/data/types";
import TeamBadge from "./TeamBadge";

// One leaderboard, any metric. Goals and assists ship in the same shape from
// the same response, so they get the same table rather than two files that
// drift apart the first time a column changes.
export default function LeaderTable({
  leaders,
  metric,
  teamStyle = 'flag',
}: {
  leaders: StatLeader[];
  metric: { abbr: string; title: string };
  teamStyle?: 'flag' | 'crest';
}) {
  if (leaders.length === 0) {
    return <p className="empty-text">{metric.title} data is unavailable right now.</p>;
  }
  return (
    <div className="std-panel">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col">Player</th>
            <th className="team-col">Team</th>
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
                  <TeamBadge
                    team={{ id: s.teamAbbr, name: s.teamName, abbr: s.teamAbbr, crestUrl: s.teamCrestUrl }}
                    size={20}
                    style={teamStyle}
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
