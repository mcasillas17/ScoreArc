import type { CSSProperties } from 'react';
import type { Scorer, Card, MatchStats, WinProbability, MatchLineups, TeamLineup, ShootoutDetail, PenaltyKick } from '@/server/data/types';
import { useTranslations } from '@/i18n/I18nProvider';
import type { Translator } from '@/i18n/translate';
import { CollapsibleSection } from './Collapsible';
import { matchStatusText, type MatchStatusInput } from './MatchRow';
import PlayerName from './PlayerName';

// Win probability is a pre-match prediction (derived from pre-match odds), so it
// only makes sense before kickoff — not for live or finished/past matches.
export function isBeforeKickoff(kickoff: string): boolean {
  const t = new Date(kickoff).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

// TV-style live status: distinguish half time / extra time / penalties from the
// running clock. Returns null for non-live matches.
export function liveStatus(match: MatchStatusInput, t: Translator): { text: string; tone: 'live' | 'break' | 'pens' } | null {
  if (match.state !== 'live') return null;
  const n = match.statusName || '';
  const isHalf = /HALFTIME/.test(n);
  const isEt = /EXTRA|OVERTIME|_ET/.test(n);
  const isPens = /SHOOTOUT|PENALT/.test(n);
  if (isPens) return { text: matchStatusText(match, t), tone: 'pens' };
  if (isHalf) return { text: matchStatusText(match, t), tone: 'break' };
  if (isEt) return { text: matchStatusText(match, t), tone: 'live' };
  return { text: matchStatusText(match, t), tone: 'live' };
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
  const t = useTranslations();
  const slots = Math.max(5, shootout.home.length, shootout.away.length);
  const tally = (kicks: PenaltyKick[]) => kicks.filter((k) => k.scored).length;

  const Row = ({ abbr, kicks }: { abbr: string; kicks: PenaltyKick[] }) => (
    <div className="pk-row">
      <span className="pk-team">{abbr}</span>
      <span className="pk-dots">
        {Array.from({ length: slots }).map((_, i) => {
          const k = kicks[i];
          const cls = !k ? 'pk-empty' : k.scored ? 'pk-scored' : 'pk-missed';
          const label = k
            ? t('matchDetails.penaltyKick', k.order, k.player, k.scored ? t('matchDetails.scored') : t('matchDetails.missed'))
            : undefined;
          return (
            <span
              key={i}
              className={`pk-dot ${cls}`}
              title={label}
              role={label ? 'img' : undefined}
              aria-label={label}
            />
          );
        })}
      </span>
      <span className="pk-score">{tally(kicks)}</span>
    </div>
  );

  return (
    <div className="pk-block">
      <div className="pk-title">{t('matchDetails.penaltyShootout')}</div>
      <Row abbr={homeAbbr} kicks={shootout.home} />
      <Row abbr={awayAbbr} kicks={shootout.away} />
    </div>
  );
}

export function ScorerLine({ scorer, playerBase }: { scorer: Scorer; playerBase?: string }) {
  const t = useTranslations();
  return (
    <span className="ls-scorer-line">
      <span className="ls-scorer-ball">⚽</span>
      <PlayerName name={scorer.player} slug={scorer.playerSlug} playerBase={playerBase} className="ls-scorer-name" />
      <span className="ls-scorer-minute">
        {scorer.minute}
        {scorer.penalty && !scorer.shootout ? ` (${t('matchDetails.penalty')})` : ''}
        {scorer.ownGoal ? ` (${t('matchDetails.ownGoal')})` : ''}
      </span>
    </span>
  );
}

export function CardLine({ card }: { card: Card }) {
  const t = useTranslations();
  const cardLabel = t(
    'matchDetails.cardEvent',
    card.player,
    card.type === 'yellow' ? t('matchDetails.yellowCard') : t('matchDetails.redCard'),
    card.minute,
  );
  return (
    <span className="ls-scorer-line">
      <span className={`ls-card-chip ls-card-${card.type}`} role="img" aria-label={cardLabel} />
      <span className="ls-scorer-name">{card.player}</span>
      <span className="ls-scorer-minute">{card.minute}</span>
    </span>
  );
}

// Two-column (home | away) list of goal scorers.
export function ScorersRow({ home, away, playerBase }: { home: Scorer[]; away: Scorer[]; playerBase?: string }) {
  return (
    <div className="ls-scorers">
      <div className="ls-scorers-col ls-scorers-home">
        {home.map((s, i) => (
          <ScorerLine key={i} scorer={s} playerBase={playerBase} />
        ))}
      </div>
      <div className="ls-scorers-divider" />
      <div className="ls-scorers-col ls-scorers-away">
        {away.map((s, i) => (
          <ScorerLine key={i} scorer={s} playerBase={playerBase} />
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
  const t = useTranslations();
  return (
    <div className="ls-winprob">
      <div className="ls-winprob-title">{t('matchDetails.chanceToWin')}</div>
      <div className="ls-winprob-bar">
        <div className="ls-winprob-home" style={{ width: `${prob.home}%` }} />
        <div className="ls-winprob-draw" style={{ width: `${prob.draw}%` }} />
        <div className="ls-winprob-away" style={{ width: `${prob.away}%` }} />
      </div>
      <div className="ls-winprob-legend">
        <span>
          {homeAbbr} {prob.home}%
        </span>
        <span className="ls-winprob-draw-label">{t('match.draw')} {prob.draw}%</span>
        <span>
          {awayAbbr} {prob.away}%
        </span>
      </div>
    </div>
  );
}

function LineupColumn({
  team, abbr, side, playerBase,
}: {
  team: TeamLineup; abbr: string; side: 'home' | 'away'; playerBase?: string;
}) {
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
            <PlayerName name={p.name} slug={p.playerSlug} playerBase={playerBase} className="lu-name" />
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
  playerBase,
}: {
  lineups: MatchLineups;
  homeAbbr: string;
  awayAbbr: string;
  playerBase?: string;
}) {
  return (
    <div className="lu-block">
      <div className="lu-cols">
        <LineupColumn team={lineups.home} abbr={homeAbbr} side="home" playerBase={playerBase} />
        <div className="lu-divider" />
        <LineupColumn team={lineups.away} abbr={awayAbbr} side="away" playerBase={playerBase} />
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
  const t = useTranslations();
  const h = stats.home;
  const a = stats.away;
  const homePct = h.possession ?? 50;
  const awayPct = a.possession ?? 50;

  const groups: { title: string; tone: string; rows: StatRowData[] }[] = [
    {
      title: t('matchDetails.attacking'),
      tone: 'var(--stat-attack)',
      rows: [
        { label: t('matchDetails.shots'), home: h.shots, away: a.shots },
        { label: t('matchDetails.onTarget'), home: h.shotsOnTarget, away: a.shotsOnTarget },
        { label: t('matchDetails.shotAccuracy'), home: h.shotAccuracy, away: a.shotAccuracy, pct: true,
          homeOf: { num: h.shotsOnTarget, den: h.shots }, awayOf: { num: a.shotsOnTarget, den: a.shots } },
        { label: t('matchDetails.corners'), home: h.corners, away: a.corners },
        { label: t('matchDetails.offsides'), home: h.offsides, away: a.offsides },
      ],
    },
    {
      title: t('matchDetails.passing'),
      tone: 'var(--stat-pass)',
      rows: [
        { label: t('matchDetails.passes'), home: h.passes, away: a.passes },
        { label: t('matchDetails.passAccuracy'), home: h.passAccuracy, away: a.passAccuracy, pct: true,
          homeOf: { num: h.passesAccurate, den: h.passes }, awayOf: { num: a.passesAccurate, den: a.passes } },
        { label: t('matchDetails.crosses'), home: h.crosses, away: a.crosses },
        { label: t('matchDetails.crossAccuracy'), home: h.crossAccuracy, away: a.crossAccuracy, pct: true,
          homeOf: { num: h.crossesAccurate, den: h.crosses }, awayOf: { num: a.crossesAccurate, den: a.crosses } },
        { label: t('matchDetails.longBalls'), home: h.longBalls, away: a.longBalls },
      ],
    },
    {
      title: t('matchDetails.defending'),
      tone: 'var(--stat-defend)',
      rows: [
        { label: t('matchDetails.tackles'), home: h.tackles, away: a.tackles },
        { label: t('matchDetails.tacklePercent'), home: h.tackleAccuracy, away: a.tackleAccuracy, pct: true,
          homeOf: { num: h.tacklesEffective, den: h.tackles }, awayOf: { num: a.tacklesEffective, den: a.tackles } },
        { label: t('matchDetails.interceptions'), home: h.interceptions, away: a.interceptions },
        { label: t('matchDetails.clearances'), home: h.clearances, away: a.clearances },
        { label: t('matchDetails.blockedShots'), home: h.blockedShots, away: a.blockedShots },
        { label: t('matchDetails.saves'), home: h.saves, away: a.saves },
      ],
    },
    {
      title: t('matchDetails.discipline'),
      tone: 'var(--stat-discipline)',
      rows: [
        { label: t('matchDetails.fouls'), home: h.fouls, away: a.fouls },
        { label: t('matchDetails.yellowCards'), home: h.yellowCards, away: a.yellowCards },
        { label: t('matchDetails.redCards'), home: h.redCards, away: a.redCards },
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
      <CollapsibleSection title={t('matchDetails.matchStats')}>
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
