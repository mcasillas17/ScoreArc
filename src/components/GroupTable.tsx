import type { Group } from "@/server/data/types";
import TeamBadge from "./TeamBadge";
import { groupRowClass } from "./groupRowClass";
import LanguageText from "./LanguageText";

interface GroupTableProps {
  group: Group;
  teamStyle?: 'flag' | 'crest';
}

function fmtGD(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

export default function GroupTable({ group, teamStyle }: GroupTableProps) {
  const started = group.standings.some((s) => s.played > 0);
  return (
    <div className="group-card">
      <h2 className="group-name">{group.name}</h2>
      {!started ? (
        <p className="lz-preseason"><LanguageText en="Season not started — no matches played yet." es="La temporada no ha comenzado — aún no hay partidos jugados." /></p>
      ) : null}
      <table className="standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col"><LanguageText en="Team" es="Equipo" /></th>
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
            <tr key={s.team.id} className={groupRowClass(s, started)}>
              <td className="rank-cell">{started ? s.rank : ''}</td>
              <td className="team-cell">
                <div className="team-cell-inner">
                  <TeamBadge team={s.team} size={22} style={teamStyle} />
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
