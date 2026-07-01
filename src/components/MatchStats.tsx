import type { Scorer, Card, MatchStats, WinProbability } from '@/server/data/types';

export function ScorerLine({ scorer }: { scorer: Scorer }) {
  return (
    <span className="ls-scorer-line">
      <span className="ls-scorer-ball">⚽</span>
      <span className="ls-scorer-name">{scorer.player}</span>
      <span className="ls-scorer-minute">
        {scorer.minute}
        {scorer.penalty && !scorer.shootout ? ' (P)' : ''}
      </span>
    </span>
  );
}

export function CardLine({ card }: { card: Card }) {
  return (
    <span className="ls-scorer-line">
      <span className={`ls-card-chip ls-card-${card.type}`} />
      <span className="ls-scorer-name">{card.player}</span>
      <span className="ls-scorer-minute">{card.minute}</span>
    </span>
  );
}

// Two-column (home | away) list of goal scorers.
export function ScorersRow({ home, away }: { home: Scorer[]; away: Scorer[] }) {
  return (
    <div className="ls-scorers">
      <div className="ls-scorers-col ls-scorers-home">
        {home.map((s, i) => (
          <ScorerLine key={i} scorer={s} />
        ))}
      </div>
      <div className="ls-scorers-divider" />
      <div className="ls-scorers-col ls-scorers-away">
        {away.map((s, i) => (
          <ScorerLine key={i} scorer={s} />
        ))}
      </div>
    </div>
  );
}

// Two-column (home | away) list of cards.
export function CardsRow({ home, away }: { home: Card[]; away: Card[] }) {
  return (
    <div className="ls-scorers ls-cards">
      <div className="ls-scorers-col ls-scorers-home">
        {home.map((c, i) => (
          <CardLine key={i} card={c} />
        ))}
      </div>
      <div className="ls-scorers-divider" />
      <div className="ls-scorers-col ls-scorers-away">
        {away.map((c, i) => (
          <CardLine key={i} card={c} />
        ))}
      </div>
    </div>
  );
}

// Odds-implied "chance to win" split bar (home / draw / away).
export function WinProbBar({
  prob,
  homeAbbr,
  awayAbbr,
}: {
  prob: WinProbability;
  homeAbbr: string;
  awayAbbr: string;
}) {
  return (
    <div className="ls-winprob">
      <div className="ls-winprob-title">Chance to win</div>
      <div className="ls-winprob-bar">
        <div className="ls-winprob-home" style={{ width: `${prob.home}%` }} />
        <div className="ls-winprob-draw" style={{ width: `${prob.draw}%` }} />
        <div className="ls-winprob-away" style={{ width: `${prob.away}%` }} />
      </div>
      <div className="ls-winprob-legend">
        <span>
          {homeAbbr} {prob.home}%
        </span>
        <span className="ls-winprob-draw-label">Draw {prob.draw}%</span>
        <span>
          {awayAbbr} {prob.away}%
        </span>
      </div>
    </div>
  );
}

export function MatchStatsBlock({ stats }: { stats: MatchStats }) {
  const homePct = stats.home.possession ?? 50;
  const awayPct = stats.away.possession ?? 50;

  type StatRow = { label: string; home: number | null; away: number | null };
  const rows: StatRow[] = [
    { label: 'Shots', home: stats.home.shots, away: stats.away.shots },
    { label: 'On Target', home: stats.home.shotsOnTarget, away: stats.away.shotsOnTarget },
    { label: 'Passes', home: stats.home.passes, away: stats.away.passes },
    { label: 'Corners', home: stats.home.corners, away: stats.away.corners },
    { label: 'Fouls', home: stats.home.fouls, away: stats.away.fouls },
  ];

  return (
    <div className="ls-stat-block">
      <div className="ls-stat-poss-bar-wrap">
        <span className="ls-stat-poss-label">{homePct.toFixed(0)}%</span>
        <div className="ls-stat-poss-bar">
          <div className="ls-stat-poss-home" style={{ width: `${homePct}%` }} />
          <div className="ls-stat-poss-away" />
        </div>
        <span className="ls-stat-poss-label">{awayPct.toFixed(0)}%</span>
      </div>
      <table className="ls-stat-table">
        <tbody>
          {rows.map((row) => {
            const hVal = row.home ?? 0;
            const aVal = row.away ?? 0;
            const homeHigher = hVal > aVal;
            const awayHigher = aVal > hVal;
            return (
              <tr key={row.label}>
                <td className={`ls-stat-val-home${homeHigher ? ' ls-stat-higher' : ''}`}>
                  {row.home ?? '–'}
                </td>
                <td className="ls-stat-label-cell">{row.label}</td>
                <td className={`ls-stat-val-away${awayHigher ? ' ls-stat-higher' : ''}`}>
                  {row.away ?? '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
