import type { Group } from "@/server/data/types";
import { thirdPlacedRanking, QUALIFYING_THIRDS } from "@/lib/standings";
import TeamBadge from "./TeamBadge";

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

export default function ThirdPlaceTable({ groups }: { groups: Group[] }) {
  const rows = thirdPlacedRanking(groups);
  if (rows.length === 0) {
    return <p className="empty-text">Third-place data is unavailable right now.</p>;
  }
  return (
    <div className="std-panel">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col">Team</th>
            <th title="Group">Grp</th>
            <th title="Played">P</th>
            <th title="Wins">W</th>
            <th title="Draws">D</th>
            <th title="Losses">L</th>
            <th title="Goal Difference">GD</th>
            <th className="pts-col" title="Points">
              Pts
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.team.id} className={r.qualifies ? "row-qualify" : "row-out"}>
              <td className="rank-cell">{r.rank}</td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge team={r.team} size={22} />
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
        <span className="std-swatch" /> Top {QUALIFYING_THIRDS} third-placed teams advance to
        the Round of 32.
      </p>
    </div>
  );
}
