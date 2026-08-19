import type { CSSProperties } from 'react';
import type { Scorer, Card, MatchStats, WinProbability, MatchLineups, TeamLineup, ShootoutDetail, PenaltyKick } from '@/server/data/types';
import { CollapsibleSection } from './Collapsible';

// Win probability is a pre-match prediction (derived from pre-match odds), so it
// only makes sense before kickoff — not for live or finished/past matches.
export function isBeforeKickoff(kickoff: string): boolean {
  const t = new Date(kickoff).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

// TV-style live status: distinguish half time / extra time / penalties from the
// running clock. Returns null for non-live matches.
export function liveStatus(match: {
  state: string;
  statusName: string;
  minute: string | null;
}): { text: string; tone: 'live' | 'break' | 'pens' } | null {
  if (match.state !== 'live') return null;
  const n = match.statusName || '';
  const clk = match.minute || '';
  const isHalf = /HALFTIME/.test(n);
  const isEt = /EXTRA|OVERTIME|_ET/.test(n);
  const isPens = /SHOOTOUT|PENALT/.test(n);
  if (isPens) return { text: 'Penalties', tone: 'pens' };
  if (isHalf) return { text: isEt ? 'ET · Half Time' : 'Half Time', tone: 'break' };
  if (isEt) return { text: clk ? `ET ${clk}` : 'Extra Time', tone: 'live' };
  return { text: clk || 'LIVE', tone: 'live' };
}

// TV-style penalty shootout: a row of dots per team — green scored, red missed,
// empty = not yet taken (padded to at least 5, more in sudden death).
export function PenaltyShootout({
  shootout,
  homeAbbr,
  awayAbbr,
}: {
  shootout: ShootoutDetail;
  homeAbbr: string;
  awayAbbr: string;
}) {
  const slots = Math.max(5, shootout.home.length, shootout.away.length);
  const tally = (kicks: PenaltyKick[]) => kicks.filter((k) => k.scored).length;

  const Row = ({ abbr, kicks }: { abbr: string; kicks: PenaltyKick[] }) => (
    <div className="pk-row">
      <span className="pk-team">{abbr}</span>
      <span className="pk-dots">
        {Array.from({ length: slots }).map((_, i) => {
          const k = kicks[i];
          const cls = !k ? 'pk-empty' : k.scored ? 'pk-scored' : 'pk-missed';
          return (
            <span
              key={i}
              className={`pk-dot ${cls}`}
              title={k ? `${k.order}. ${k.player} — ${k.scored ? 'scored' : 'missed'}` : undefined}
            />
          );
        })}
      </span>
      <span className="pk-score">{tally(kicks)}</span>
    </div>
  );

  return (
    <div className="pk-block">
      <div className="pk-title">Penalty Shootout</div>
      <Row abbr={homeAbbr} kicks={shootout.home} />
      <Row abbr={awayAbbr} kicks={shootout.away} />
    </div>
  );
}

export function ScorerLine({ scorer }: { scorer: Scorer }) {
  return (
    <span className="ls-scorer-line">
      <span className="ls-scorer-ball">⚽</span>
      <span className="ls-scorer-name">{scorer.player}</span>
      <span className="ls-scorer-minute">
        {scorer.minute}
        {scorer.penalty && !scorer.shootout ? ' (P)' : ''}
        {scorer.ownGoal ? ' (OG)' : ''}
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

function LineupColumn({ team, abbr, side }: { team: TeamLineup; abbr: string; side: 'home' | 'away' }) {
  return (
    <div className={`lu-col lu-col-${side}`}>
      <div className="lu-head">
        <span className="lu-abbr">{abbr}</span>
        {team.formation && <span className="lu-formation">{team.formation}</span>}
      </div>
      <ul className="lu-list">
        {/* The roster now carries substitutes too (they feed the box score).
            The formation view is the starting eleven. */}
        {team.players.filter((p) => p.starter).map((p, i) => (
          <li key={i} className="lu-player">
            {p.jersey ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="lu-jersey"
                src={p.jersey}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="lu-num">{p.number ?? '–'}</span>
            )}
            <span className="lu-name">{p.name}</span>
            <span className="lu-pos">{p.position}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LineupView({
  lineups,
  homeAbbr,
  awayAbbr,
}: {
  lineups: MatchLineups;
  homeAbbr: string;
  awayAbbr: string;
}) {
  return (
    <div className="lu-block">
      <div className="lu-cols">
        <LineupColumn team={lineups.home} abbr={homeAbbr} side="home" />
        <div className="lu-divider" />
        <LineupColumn team={lineups.away} abbr={awayAbbr} side="away" />
      </div>
    </div>
  );
}

type StatFraction = { num: number | null; den: number | null };
type StatRowData = {
  label: string;
  home: number | null;
  away: number | null;
  pct?: boolean;
  // The counts a derived percentage came from. Printed beside it so the
  // number is checkable rather than merely asserted.
  homeOf?: StatFraction;
  awayOf?: StatFraction;
};

function Fraction({ of }: { of?: StatFraction }) {
  if (!of || of.num == null || of.den == null) return null;
  return <span className="ls-stat-frac">{of.num}/{of.den}</span>;
}

function StatRow({ row }: { row: StatRowData }) {
  const { home, away } = row;
  if (home == null && away == null) return null;
  const hv = home ?? 0;
  const av = away ?? 0;
  const total = hv + av;
  const homeShare = total > 0 ? (hv / total) * 100 : 50;
  const fmt = (v: number | null) => (v == null ? '–' : row.pct ? `${v}%` : `${v}`);
  return (
    <div className="ls-stat-row">
      <span className={`ls-stat-val-home${hv > av ? ' ls-stat-higher' : ''}`}>
        {fmt(home)}
        <Fraction of={row.homeOf} />
      </span>
      <div className="ls-stat-mid">
        <span className="ls-stat-name">{row.label}</span>
        <div className="ls-stat-bar">
          <div className="ls-stat-bar-home" style={{ width: `${homeShare}%` }} />
          <div className="ls-stat-bar-away" />
        </div>
      </div>
      <span className={`ls-stat-val-away${av > hv ? ' ls-stat-higher' : ''}`}>
        {fmt(away)}
        <Fraction of={row.awayOf} />
      </span>
    </div>
  );
}

function hasData(rows: StatRowData[]) {
  return rows.some((r) => r.home != null || r.away != null);
}

function StatRows({ rows }: { rows: StatRowData[] }) {
  return <>{rows.map((r) => <StatRow key={r.label} row={r} />)}</>;
}

function StatGroup({ title, rows, tone }: { title: string; rows: StatRowData[]; tone: string }) {
  if (!hasData(rows)) return null;
  // Each category tints its bars via a scoped CSS var the bar fill reads.
  return (
    <div className="ls-stat-group" style={{ ['--bar-color']: tone } as CSSProperties}>
      <div className="ls-stat-group-title">{title}</div>
      <div className="ls-stat-group-rows">
        <StatRows rows={rows} />
      </div>
    </div>
  );
}

export function MatchStatsBlock({ stats }: { stats: MatchStats }) {
  const h = stats.home;
  const a = stats.away;
  const homePct = h.possession ?? 50;
  const awayPct = a.possession ?? 50;

  const groups: { title: string; tone: string; rows: StatRowData[] }[] = [
    {
      title: 'Attacking',
      tone: 'var(--stat-attack)',
      rows: [
        { label: 'Shots', home: h.shots, away: a.shots },
        { label: 'On Target', home: h.shotsOnTarget, away: a.shotsOnTarget },
        { label: 'Shot Accuracy', home: h.shotAccuracy, away: a.shotAccuracy, pct: true,
          homeOf: { num: h.shotsOnTarget, den: h.shots }, awayOf: { num: a.shotsOnTarget, den: a.shots } },
        { label: 'Corners', home: h.corners, away: a.corners },
        { label: 'Offsides', home: h.offsides, away: a.offsides },
      ],
    },
    {
      title: 'Passing',
      tone: 'var(--stat-pass)',
      rows: [
        { label: 'Passes', home: h.passes, away: a.passes },
        { label: 'Pass Accuracy', home: h.passAccuracy, away: a.passAccuracy, pct: true,
          homeOf: { num: h.passesAccurate, den: h.passes }, awayOf: { num: a.passesAccurate, den: a.passes } },
        { label: 'Crosses', home: h.crosses, away: a.crosses },
        { label: 'Cross Accuracy', home: h.crossAccuracy, away: a.crossAccuracy, pct: true,
          homeOf: { num: h.crossesAccurate, den: h.crosses }, awayOf: { num: a.crossesAccurate, den: a.crosses } },
        { label: 'Long Balls', home: h.longBalls, away: a.longBalls },
      ],
    },
    {
      title: 'Defending',
      tone: 'var(--stat-defend)',
      rows: [
        { label: 'Tackles', home: h.tackles, away: a.tackles },
        { label: 'Tackle %', home: h.tackleAccuracy, away: a.tackleAccuracy, pct: true,
          homeOf: { num: h.tacklesEffective, den: h.tackles }, awayOf: { num: a.tacklesEffective, den: a.tackles } },
        { label: 'Interceptions', home: h.interceptions, away: a.interceptions },
        { label: 'Clearances', home: h.clearances, away: a.clearances },
        { label: 'Blocked Shots', home: h.blockedShots, away: a.blockedShots },
        { label: 'Saves', home: h.saves, away: a.saves },
      ],
    },
    {
      title: 'Discipline',
      tone: 'var(--stat-discipline)',
      rows: [
        { label: 'Fouls', home: h.fouls, away: a.fouls },
        { label: 'Yellow Cards', home: h.yellowCards, away: a.yellowCards },
        { label: 'Red Cards', home: h.redCards, away: a.redCards },
      ],
    },
  ];

  const hasGroups = groups.some((g) => hasData(g.rows));
  const hasPossession = h.possession != null || a.possession != null;
  // Everything is collapsed by default — the only thing shown pre-expand is the
  // win-probability bar (a sibling component, live/upcoming matches only).
  if (!hasGroups && !hasPossession) return null;

  return (
    <div className="ls-stat-block">
      <CollapsibleSection title="Match stats">
        {hasPossession && (
          <div className="ls-stat-poss-bar-wrap">
            <span className="ls-stat-poss-label">{homePct.toFixed(0)}%</span>
            <div className="ls-stat-poss-bar">
              <div className="ls-stat-poss-home" style={{ width: `${homePct}%` }} />
              <div className="ls-stat-poss-away" />
            </div>
            <span className="ls-stat-poss-label">{awayPct.toFixed(0)}%</span>
          </div>
        )}
        {groups.map((g) => <StatGroup key={g.title} title={g.title} tone={g.tone} rows={g.rows} />)}
      </CollapsibleSection>
    </div>
  );
}
