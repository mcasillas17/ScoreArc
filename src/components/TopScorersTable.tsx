import type { TopScorer } from "@/server/data/types";
import TeamBadge from "./TeamBadge";

export default function TopScorersTable({ scorers }: { scorers: TopScorer[] }) {
  if (scorers.length === 0) {
    return <p className="empty-text">Scorer data is unavailable right now.</p>;
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
            <th className="pts-col" title="Goals">
              G
            </th>
          </tr>
        </thead>
        <tbody>
          {scorers.map((s) => (
            <tr key={`${s.rank}-${s.player}`} className={s.rank === 1 ? "row-qualify" : ""}>
              <td className="rank-cell">{s.rank}</td>
              <td className="team-cell">
                <span className="team-name">{s.player}</span>
              </td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge
                    team={{ id: s.teamAbbr, name: s.teamName, abbr: s.teamAbbr, crestUrl: null }}
                    size={20}
                  />
                  <span className="team-name std-muted">{s.teamAbbr}</span>
                </div>
              </td>
              <td>{s.matches ?? "–"}</td>
              <td className="pts-cell">{s.goals}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
