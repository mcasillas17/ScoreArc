import type { MatchInfo, MatchForm, FormResult, CommentaryItem, H2HMeeting, MatchLineups, TeamLineup, LineupPlayer } from '@/server/data/types';
import { CollapsibleSection } from './Collapsible';

function fmtYear(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

export function MatchInfoRow({ info }: { info: MatchInfo }) {
  const place = [info.venue, info.city].filter(Boolean).join(' · ');
  return (
    <div className="mi-row">
      {place && <span className="mi-item">📍 {place}</span>}
      {info.referee && (
        <span className="mi-item mi-ref">
          <svg
            className="mi-ref-icon"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="9" cy="14" r="5.2" />
            <path d="M13.8 11.5 21 9.8v3.4l-7.2-1.5" />
            <path d="M9 8.8V6.2h2.4" />
          </svg>
          {info.referee}
        </span>
      )}
      {info.attendance != null && (
        <span className="mi-item">👥 {info.attendance.toLocaleString()}</span>
      )}
    </div>
  );
}

function FormPills({ form }: { form: FormResult[] }) {
  return (
    <span className="fm-pills">
      {form.map((f, i) => (
        <span
          key={i}
          className={`fm-pill fm-${f.result}`}
          title={`${f.result} vs ${f.opponent} ${f.score}`}
        >
          {f.result}
        </span>
      ))}
    </span>
  );
}

export function FormRow({
  form,
  homeAbbr,
  awayAbbr,
}: {
  form: MatchForm;
  homeAbbr: string;
  awayAbbr: string;
}) {
  if (!form.home.length && !form.away.length) return null;
  return (
    <div className="fm-block">
      <div className="fm-title">Recent form</div>
      <div className="fm-team">
        <span className="fm-abbr">{homeAbbr}</span>
        <FormPills form={form.home} />
      </div>
      <div className="fm-team">
        <span className="fm-abbr">{awayAbbr}</span>
        <FormPills form={form.away} />
      </div>
    </div>
  );
}

export function H2HRow({ meetings }: { meetings: H2HMeeting[] }) {
  if (!meetings.length) return null;
  return (
    <div className="fm-block">
      <div className="fm-title">Head to head</div>
      <ul className="h2h-list">
        {meetings.map((m, i) => (
          <li key={i} className="h2h-item">
            <span>{m.label}</span>
            <span className="h2h-date">{fmtYear(m.date)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommentaryFeed({ items }: { items: CommentaryItem[] }) {
  if (!items.length) return null;
  // Latest first — most useful during a live match.
  const feed = [...items].reverse();
  return (
    <CollapsibleSection title={`Commentary · ${items.length}`} tone="#a78bfa">
      <ul className="cm-list">
        {feed.map((c, i) => (
          <li key={i} className="cm-item">
            {c.minute && <span className="cm-min">{c.minute}</span>}
            <span className="cm-text">{c.text}</span>
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}

// A stat ESPN did not send for this player renders as a dash, never a zero:
// an outfielder has no `saves` entry, and printing 0 there would claim they
// faced shots and stopped none.
function StatCell({ value }: { value: number | null }) {
  if (value == null) return <td className="ls-box-na">–</td>;
  return <td>{value}</td>;
}

function CardChips({ player }: { player: LineupPlayer }) {
  const yellow = player.stats?.yellowCards ?? 0;
  const red = player.stats?.redCards ?? 0;
  if (!yellow && !red) return <td />;
  return (
    <td>
      {yellow > 0 && <span className="ls-card-chip ls-card-yellow" title="Yellow card" />}
      {red > 0 && <span className="ls-card-chip ls-card-red" title="Red card" />}
    </td>
  );
}

// Starters first, then the bench, each by shirt number. Unnumbered players go
// last rather than sorting as zero and jumping the goalkeeper.
function boxOrder(a: LineupPlayer, b: LineupPlayer): number {
  if (a.starter !== b.starter) return a.starter ? -1 : 1;
  return (a.number ?? 999) - (b.number ?? 999);
}

function BoxScoreTable({ team, abbr }: { team: TeamLineup; abbr: string }) {
  const players = team.players.filter((p) => p.stats != null).sort(boxOrder);
  if (players.length === 0) return null;
  // Only goalkeepers carry `saves`. Rendering the column for a team whose
  // payload has none would be a column of dashes.
  const showSaves = players.some((p) => p.stats!.saves != null);
  return (
    <div className="ls-box">
      <div className="ls-box-team">{abbr}</div>
      {/* Twelve columns do not fit a phone. Scroll the table, not the popup. */}
      <div className="ls-box-scroll">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col">Player</th>
            <th>Pos</th>
            <th title="Goals">G</th>
            <th title="Assists">A</th>
            <th title="Shots">SH</th>
            <th title="Shots on target">SOT</th>
            <th title="Offsides">OFF</th>
            <th title="Fouls committed">FC</th>
            <th title="Fouls suffered">FA</th>
            {showSaves && <th title="Saves">SV</th>}
            <th title="Cards" />
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => (
            <tr key={`${p.name}-${i}`}>
              <td className="rank-cell">{p.number ?? '–'}</td>
              <td className="team-cell">
                <span className="team-name">{p.name}</span>
                {!p.starter && <span className="ls-box-sub">sub</span>}
              </td>
              <td className="std-muted">{p.position}</td>
              <StatCell value={p.stats!.totalGoals} />
              <StatCell value={p.stats!.goalAssists} />
              <StatCell value={p.stats!.totalShots} />
              <StatCell value={p.stats!.shotsOnTarget} />
              <StatCell value={p.stats!.offsides} />
              <StatCell value={p.stats!.foulsCommitted} />
              <StatCell value={p.stats!.foulsSuffered} />
              {showSaves && <StatCell value={p.stats!.saves} />}
              <CardChips player={p} />
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/**
 * Per-player match statistics for both squads.
 *
 * `goalsConceded` and `shotsFaced` are deliberately not columns: ESPN repeats
 * the team's conceded count on every outfielder, so a per-player column would
 * read as eleven players each conceding the same goal.
 */
export function BoxScoreBlock({
  lineups,
  homeAbbr,
  awayAbbr,
}: {
  lineups: MatchLineups;
  homeAbbr: string;
  awayAbbr: string;
}) {
  // Checked on the data, not on the elements: a component returning null is
  // still a truthy JSX value, so testing the elements would always pass and
  // render an empty collapsible for matches with no player stats.
  const hasStats = [lineups.home, lineups.away].some((t) => t.players.some((p) => p.stats != null));
  if (!hasStats) return null;
  return (
    <CollapsibleSection title="Box score" tone="#38bdf8">
      <BoxScoreTable team={lineups.home} abbr={homeAbbr} />
      <BoxScoreTable team={lineups.away} abbr={awayAbbr} />
    </CollapsibleSection>
  );
}
