import type { Group, Standing } from "@/server/data/types";
import TeamBadge from "./TeamBadge";

interface GroupTableProps {
  group: Group;
}

function rowClass(s: Standing): string {
  if (s.advanced || s.rank <= 2) return "row-qualify";
  if (s.rank === 3) return "row-playoff";
  return "";
}

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

export default function GroupTable({ group }: GroupTableProps) {
  return (
    <div className="group-card">
      <h2 className="group-name">{group.name}</h2>
      <table className="standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col">Team</th>
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
          {group.standings.map((s) => (
            <tr key={s.team.id} className={rowClass(s)}>
              <td className="rank-cell">{s.rank}</td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge team={s.team} size={22} />
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
