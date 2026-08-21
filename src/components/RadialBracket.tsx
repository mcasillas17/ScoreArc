'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';
import { type ChampionTitleKey, type TeamStyle } from '@/server/data/competitions';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import BracketZoom from './BracketZoom';
import {
  teamJourney, buildRings, ellipse, colorFor, C,
  type RingNode, type JourneyStop, type BracketMode,
} from './radialBracketModel';
import { DEFAULT_SHAPE, roundLabelKey, type BracketShape, type RingGeom } from './bracketShape';
import { trackEvent, trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import { useTranslations } from '@/i18n/I18nProvider';

export type { BracketMode };

interface Props {
  rounds: BracketRound[];
  mode?: BracketMode;
  picks?: Record<string, string>;
  onPick?: (depth: number, matchIndex: number, teamId: string) => void;
  onChampion?: (team: BracketTeam | null) => void;
  teamStyle: TeamStyle;
  apiBase: string;
  teamBase?: string;
  // Bracket shape (ring geometry + rounds + seed order). Defaults to the 2026
  // 5-ring shape so existing callers keep working unchanged.
  shape?: BracketShape;
  /** The competition's emblem, drawn at the hub when it has no trophy image. */
  emblem: string;
  /** A real trophy photograph. Only the World Cup has one — see Competition. */
  trophyImage?: string;
  championTitleKey?: ChampionTitleKey;
}


// Outer crest sits just beyond its flag along the same radial, and is SMALLER
// than the flag (as in the reference: federation logo smaller than the flag).
const CREST_R = 25;

// FIFA 3-letter code -> ISO 3166-1 alpha-2 (lowercase) for flagcdn.
const FLAG_MAP: Record<string, string> = {
  RSA: 'za', CAN: 'ca', BRA: 'br', JPN: 'jp', GER: 'de', PAR: 'py', NED: 'nl',
  MAR: 'ma', CIV: 'ci', NOR: 'no', FRA: 'fr', SWE: 'se', MEX: 'mx', ECU: 'ec',
  ENG: 'gb-eng', COD: 'cd', BEL: 'be', SEN: 'sn', USA: 'us', BIH: 'ba',
  ESP: 'es', AUT: 'at', POR: 'pt', CRO: 'hr', SUI: 'ch', ALG: 'dz', AUS: 'au',
  EGY: 'eg', ARG: 'ar', CPV: 'cv', COL: 'co', GHA: 'gh', NGA: 'ng', CMR: 'cm',
  URU: 'uy', CHI: 'cl', PER: 'pe', KOR: 'kr', IRN: 'ir', KSA: 'sa', QAT: 'qa',
  SRB: 'rs', DEN: 'dk', POL: 'pl', WAL: 'gb-wls', SCO: 'gb-sct', ITA: 'it',
  TUR: 'tr', UKR: 'ua', CZE: 'cz', RUS: 'ru', GRE: 'gr', ROU: 'ro', HUN: 'hu',
  NZL: 'nz', CRC: 'cr', PAN: 'pa', HON: 'hn', JAM: 'jm', HAI: 'ht', VEN: 've',
  BOL: 'bo', TUN: 'tn',
};

// FIFA 3-letter code -> federation crest URL (outer ring badge).
const CREST_MAP: Record<string, string> = {
  RSA: 'https://r2.thesportsdb.com/images/media/team/badge/xjz9j91553368824.png',
  CAN: 'https://r2.thesportsdb.com/images/media/team/badge/2t631f1595154867.png',
  BRA: 'https://r2.thesportsdb.com/images/media/team/badge/jl6dip1726167280.png',
  JPN: 'https://r2.thesportsdb.com/images/media/team/badge/ffsyxz1591989843.png',
  GER: 'https://r2.thesportsdb.com/images/media/team/badge/1xysi51726167152.png',
  PAR: 'https://r2.thesportsdb.com/images/media/team/badge/khgav41553419195.png',
  NED: 'https://r2.thesportsdb.com/images/media/team/badge/1p0hr41593787110.png',
  MAR: 'https://r2.thesportsdb.com/images/media/team/badge/hbmwkj1731791275.png',
  CIV: 'https://r2.thesportsdb.com/images/media/team/badge/rwxuuu1455465643.png',
  NOR: 'https://r2.thesportsdb.com/images/media/team/badge/gyfn811591973155.png',
  FRA: 'https://r2.thesportsdb.com/images/media/team/badge/p3n0z51726166851.png',
  SWE: 'https://r2.thesportsdb.com/images/media/team/badge/h5adzg1591981772.png',
  MEX: 'https://r2.thesportsdb.com/images/media/team/badge/3rmosi1748525208.png',
  ECU: 'https://r2.thesportsdb.com/images/media/team/badge/47wv2y1591989301.png',
  ENG: 'https://r2.thesportsdb.com/images/media/team/badge/vf5ttc1726166739.png',
  COD: 'https://r2.thesportsdb.com/images/media/team/badge/s85jjw1728749022.png',
  BEL: 'https://r2.thesportsdb.com/images/media/team/badge/8xlvxv1592062265.png',
  SEN: 'https://r2.thesportsdb.com/images/media/team/badge/slayb01780546342.png',
  USA: 'https://r2.thesportsdb.com/images/media/team/badge/21f0oi1597948195.png',
  BIH: 'https://r2.thesportsdb.com/images/media/team/badge/hu9lj21739378200.png',
  ESP: 'https://r2.thesportsdb.com/images/media/team/badge/ncgqyr1726166942.png',
  AUT: 'https://r2.thesportsdb.com/images/media/team/badge/874p631628721400.png',
  POR: 'https://r2.thesportsdb.com/images/media/team/badge/swqvpy1455466083.png',
  CRO: 'https://r2.thesportsdb.com/images/media/team/badge/vvtsyu1455465317.png',
  SUI: 'https://r2.thesportsdb.com/images/media/team/badge/mb7yqe1717365808.png',
  ALG: 'https://r2.thesportsdb.com/images/media/team/badge/rrwpry1455460218.png',
  AUS: 'https://r2.thesportsdb.com/images/media/team/badge/eylq8x1781926138.png',
  EGY: 'https://r2.thesportsdb.com/images/media/team/badge/uheyzo1742102234.png',
  ARG: 'https://r2.thesportsdb.com/images/media/team/badge/3zplhu1726167477.png',
  CPV: 'https://r2.thesportsdb.com/images/media/team/badge/5jn0o71593280376.png',
  COL: 'https://r2.thesportsdb.com/images/media/team/badge/4ymyku1691180081.png',
  GHA: 'https://r2.thesportsdb.com/images/media/team/badge/j589xw1751526124.png',
  // Historical WC knockout teams (1998–2022) not in the 2026 field, so past
  // editions render bare federation crests too (badges via thesportsdb).
  ITA: 'https://r2.thesportsdb.com/images/media/team/badge/fxijcp1726167035.png',
  URU: 'https://r2.thesportsdb.com/images/media/team/badge/6vjbr11726167756.png',
  CHI: 'https://r2.thesportsdb.com/images/media/team/badge/5xjsy41591988732.png',
  PER: 'https://r2.thesportsdb.com/images/media/team/badge/unszat1529144812.png',
  KOR: 'https://r2.thesportsdb.com/images/media/team/badge/a8nqfs1589564916.png',
  IRN: 'https://r2.thesportsdb.com/images/media/team/badge/uttpvw1455465617.png',
  KSA: 'https://r2.thesportsdb.com/images/media/team/badge/24xwpq1594125742.png',
  QAT: 'https://r2.thesportsdb.com/images/media/team/badge/rs3ir31642708685.png',
  SRB: 'https://r2.thesportsdb.com/images/media/team/badge/oxvynb1689195538.png',
  DEN: 'https://r2.thesportsdb.com/images/media/team/badge/e13arj1717365623.png',
  POL: 'https://r2.thesportsdb.com/images/media/team/badge/ttvrxy1455466076.png',
  WAL: 'https://r2.thesportsdb.com/images/media/team/badge/pdayn21591983222.png',
  SCO: 'https://r2.thesportsdb.com/images/media/team/badge/3691i11552945146.png',
  TUR: 'https://r2.thesportsdb.com/images/media/team/badge/70c4oo1591982459.png',
  UKR: 'https://r2.thesportsdb.com/images/media/team/badge/k36g2e1591982718.png',
  CZE: 'https://r2.thesportsdb.com/images/media/team/badge/1o0cx31654205806.png',
  RUS: 'https://r2.thesportsdb.com/images/media/team/badge/nz50i51689197440.png',
  GRE: 'https://r2.thesportsdb.com/images/media/team/badge/xtxtts1455465601.png',
  ROU: 'https://r2.thesportsdb.com/images/media/team/badge/w903wb1689198300.png',
  HUN: 'https://r2.thesportsdb.com/images/media/team/badge/ihaoit1717365719.png',
  NZL: 'https://r2.thesportsdb.com/images/media/team/badge/91xpk81742982935.png',
  CRC: 'https://r2.thesportsdb.com/images/media/team/badge/bss90a1637840151.png',
  PAN: 'https://r2.thesportsdb.com/images/media/team/badge/asp2ck1715849700.png',
  HON: 'https://r2.thesportsdb.com/images/media/team/badge/wuu4fp1718413719.png',
  JAM: 'https://r2.thesportsdb.com/images/media/team/badge/v6mk4r1594321722.png',
  HAI: 'https://r2.thesportsdb.com/images/media/team/badge/gml8wx1598135302.png',
  VEN: 'https://r2.thesportsdb.com/images/media/team/badge/x167yg1690791367.png',
  BOL: 'https://r2.thesportsdb.com/images/media/team/badge/4q6qfm1736571383.png',
  TUN: 'https://r2.thesportsdb.com/images/media/team/badge/7r89rg1526727277.png',
  NGA: 'https://r2.thesportsdb.com/images/media/team/badge/qruyxr1455466056.png',
  CMR: 'https://r2.thesportsdb.com/images/media/team/badge/txqspw1455463989.png',
};

function flagUrl(abbr: string): string | null {
  const iso = FLAG_MAP[abbr.toUpperCase()];
  return iso ? `https://flagcdn.com/w160/${iso}.png` : null;
}

function crestSrc(abbr: string): string | null {
  return CREST_MAP[abbr.toUpperCase()] ?? null;
}


// Enter/Space activates a role="button" SVG element (keyboard accessibility).
function activate(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
}



// True when the ISO kickoff falls on the viewer's local calendar day.
function isTodayLocal(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}


/** SVG arc path for text on a circle. Angles are degrees from +x, clockwise in
 *  SVG's y-down space; going from a larger to a smaller angle draws the short
 *  bottom arc left-to-right so a caption reads upright beneath the center. */
function arcTextPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const pt = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const [x1, y1] = pt(startDeg);
  const [x2, y2] = pt(endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg > startDeg ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`;
}

export default function RadialBracket({ rounds, mode = 'live', picks = {}, onPick, onChampion, teamStyle, apiBase, teamBase, shape: shapeProp, emblem, trophyImage, championTitleKey = 'champion.competition' }: Props) {
  const t = useTranslations();
  const shape = shapeProp ?? DEFAULT_SHAPE;
  const roundLabels = shape.knockoutRounds.map((slug) => t(roundLabelKey(slug))).join(', ');
  const bracketLabel = t('bracket.diagramLabel', roundLabels);
  const championTitle = t(championTitleKey);
  const geom = shape.ringGeometry;
  const rings = buildRings(rounds, shape, picks, mode);

  const journeys = teamJourney(rings);
  // Per-team journey lookup — drives the outward "still in it" tails: how deep a
  // team reached, and the ring where it was eliminated (null = champion).
  const journeyByTeam = new Map<string, (typeof journeys)[number]>();
  for (const j of journeys) journeyByTeam.set(j.teamId, j);
  // Deepest ring any team reached, and the sim end-point. simRound counts ROUNDS
  // played: a team's flag at depth d appears at simRound >= d (it hopped in) and
  // greys at simRound >= d+1 (it then lost that round) — so +1 lets the last
  // completed round's result resolve. The whole tournament plays forward on load.
  const maxDepth = journeys.reduce((m, j) => Math.max(m, j.positions.length - 1), 0);
  const simTarget = maxDepth + 1;
  const targetRef = useRef(simTarget);
  targetRef.current = simTarget;

  const [simRound, setSimRound] = useState(0);
  const initDone = useRef(false);
  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // reduced-motion: snap to the final resolved state, no round-by-round play.
    if (reduce) {
      setSimRound(targetRef.current);
      initDone.current = true;
      return;
    }
    setSimRound(0);
    let d = 0;
    const id = setInterval(() => {
      d += 1;
      setSimRound(d);
      // read the LIVE target so a mid-intro deepening extends the play (no stall)
      if (d >= targetRef.current) {
        clearInterval(id);
        initDone.current = true;
      }
    }, 2000); // 2s between ring jumps — a calmer level-by-level play-through
    return () => clearInterval(id);
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After the intro, keep up with newly-decided rounds (advance, don't replay).
  useEffect(() => {
    if (initDone.current) setSimRound((s) => Math.max(s, simTarget));
  }, [simTarget]);

  // The CHAMPION is the effective winner of the FINAL (the innermost ring).
  const championNode = rings[geom.length - 1]?.find((n) => n.isWinner) ?? null;
  const champion = championNode?.team ?? null;
  useEffect(() => {
    onChampion?.(champion ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [champion?.id]);

  // Once the final has actually resolved — past editions on load, or the live
  // 2026 final — crown the winner at the center with a halo, laurel ring and a
  // curved "CHAMPIONS" caption, all within the empty middle so the bracket
  // stays uncovered. Predict mode keeps its full-screen ChampionCelebration.
  const champNode =
    mode === 'live' && simRound >= geom.length ? championNode : null;

  // Match-detail popup state (live/finished mode only)
  const [detail, setDetail] = useState<BracketMatch | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const summaryFeedFailedFor = useRef<string | null>(null);

  // Radar-ping cues use the client clock ("is this match today?"), so they only
  // render after mount to avoid an SSR/hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function handleView(m: BracketMatch) {
    trackEvent('Match details opened', { surface: 'bracket' });
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        trackEvent('Match details unavailable', { surface: 'bracket', status: res.status });
        return;
      }
      const json = (await res.json()) as MatchSummary;
      setSummary(json);
    } catch {
      trackEvent('Match details unavailable', { surface: 'bracket' });
    } finally {
      setLoadingDetail(false);
    }
  }

  // While the popup is open on a LIVE match, quietly refresh its summary every
  // 15s so the score / stats / scorers stay current without blanking the card.
  useEffect(() => {
    if (!detail || detail.state !== 'live') return;
    summaryFeedFailedFor.current = null;
    let active = true;
    const id = setInterval(async () => {
      try {
        const res = await fetch(
          `${apiBase}/match/${detail.id}?home=${detail.home.id}&away=${detail.away.id}`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          if (active) setSummary((await res.json()) as MatchSummary);
          if (active && summaryFeedFailedFor.current === detail.id) {
            trackFeedRecovery('match-summary');
            summaryFeedFailedFor.current = null;
          }
        } else if (active && summaryFeedFailedFor.current !== detail.id) {
          trackFeedFailure('match-summary', res.status);
          summaryFeedFailedFor.current = detail.id;
        }
      } catch {
        if (active && summaryFeedFailedFor.current !== detail.id) {
          trackFeedFailure('match-summary');
          summaryFeedFailedFor.current = detail.id;
        }
      }
    }, 15_000);
    return () => {
      active = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.state]);

  const handleDiscClick = (node: RingNode) => {
    // Discs only interact in predict mode (pick). Viewing a match's details is
    // done by clicking the RESULT DOT on the connector, not a country's flag.
    if (mode === 'predict' && node.clickable && onPick) {
      onPick(node.depth, Math.floor(node.index / 2), node.team.id);
    }
  };

  return (
    <div className="radial-bracket-wrap">
      <BracketZoom>
      <svg
        viewBox="-70 -70 1140 1140"
        aria-label={bracketLabel}
        role="img"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: 820,
          margin: '0 auto',
          display: 'block',
        }}
      >
        <title>{bracketLabel}</title>
        <defs>
          <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#d59a37" stopOpacity="0.6" />
            <stop offset="30%" stopColor="#8a5e1f" stopOpacity="0.34" />
            <stop offset="62%" stopColor="#43300f" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#0b0b0d" stopOpacity="0" />
          </radialGradient>
          {/* Connector gradients — bright gold near the trophy, fading outward
              (userSpaceOnUse so the fade is anchored at the bracket center). */}
          <radialGradient
            id="conn-grad"
            cx={C.x}
            cy={C.y}
            r={470}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#f0c873" stopOpacity="0.95" />
            <stop offset="42%" stopColor="#b78a3c" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#544a36" stopOpacity="0.4" />
          </radialGradient>
          <radialGradient
            id="conn-gold"
            cx={C.x}
            cy={C.y}
            r={470}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#ffe9a8" stopOpacity="1" />
            <stop offset="55%" stopColor="#eebc54" stopOpacity="0.98" />
            <stop offset="100%" stopColor="#cf9a36" stopOpacity="0.9" />
          </radialGradient>
          <linearGradient id="trophy-grad" x1="0" y1="-55" x2="0" y2="60" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f6e27a" />
            <stop offset="55%" stopColor="#d4af37" />
            <stop offset="100%" stopColor="#9b7d2e" />
          </linearGradient>
          <filter id="trophy-blur" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          {/* Soft glow for a winner's national-colour route — a blurred, fatter
              copy of the line drawn under the crisp stroke makes the path read
              as luminous (as in the reference art). */}
          <filter id="conn-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.2" />
          </filter>
          {/* Tighter, brighter warm halo hugging the trophy itself. */}
          <radialGradient id="trophy-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe9a8" stopOpacity="0.55" />
            <stop offset="42%" stopColor="#e9b859" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#e9b859" stopOpacity="0" />
          </radialGradient>
          {/* Localized golden halo behind the winning finalist disc. */}
          <radialGradient id="champ-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe9a8" stopOpacity="0.9" />
            <stop offset="45%" stopColor="#f0c873" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#f0c873" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* (1) Smooth warm radial-gradient glow behind the trophy — a broad
            ambient wash plus a tighter bright halo hugging the trophy. */}
        <circle cx={C.x} cy={C.y} r={320} fill="url(#center-glow)" />
        <circle cx={C.x} cy={C.y} r={86} fill="url(#trophy-halo)" />

        {/* (1·) Decorative center bar: a faint hairline through the trophy with
            a small gold end-cap dot on each side (as in the reference art). */}
        <line x1={C.x - 92} y1={C.y} x2={C.x + 92} y2={C.y}
          stroke="#e9b859" strokeOpacity={0.28} strokeWidth={1} />
        <circle cx={C.x - 92} cy={C.y} r={2.4} fill="#f0c873" />
        <circle cx={C.x + 92} cy={C.y} r={2.4} fill="#f0c873" />

        {/* (1a) Champion halo — localized golden glow behind the winning
            finalist disc, drawn before the discs so it reads as a glow ring. */}
        {champNode && (
          <circle
            className="champ-halo"
            cx={champNode.x}
            cy={champNode.y}
            r={champNode.discR + 30}
            fill="url(#champ-halo)"
          />
        )}

        {/* (2) Connectors: bracket elbows — radial stub from each team, a
            tangential arc joining the pair, then a radial stub to the parent. */}
        {geom.slice(0, -1).map((cfg, depth) => {
          const rc = cfg.rx; // child ring radius
          const rp = geom[depth + 1].rx; // parent ring radius
          const rj = rp + (rc - rp) * 0.5; // arc (join) radius between them
          const children = rings[depth];
          const parents = rings[depth + 1];
          const GRAD = 'url(#conn-grad)';
          return parents.map((parent, k) => {
            const a = children[2 * k];
            const b = children[2 * k + 1];
            if (!a || !b) return null;
            const jA = ellipse(rj, rj, a.angle);
            const jB = ellipse(rj, rj, b.angle);
            const jMid = ellipse(rj, rj, parent.angle);
            const pPar = ellipse(rp, rp, parent.angle);
            const sweep = b.angle > a.angle ? 1 : 0;
            // The team that actually advances from this match (if decided).
            const win = a.isWinner ? a : b.isWinner ? b : null;
            const winColor = win ? colorFor(win.team) : null;
            const jWin = win ? (win === a ? jA : jB) : null;
            const arcSweep = win && win.angle < parent.angle ? 1 : 0;
            return (
              <g key={`conn-${depth}-${k}`}>
                {/* neutral base structure (full elbow) */}
                <path d={`M ${a.x} ${a.y} L ${jA.x} ${jA.y}`} fill="none" stroke={GRAD} strokeWidth={1.4} strokeLinecap="round" />
                <path d={`M ${b.x} ${b.y} L ${jB.x} ${jB.y}`} fill="none" stroke={GRAD} strokeWidth={1.4} strokeLinecap="round" />
                <path d={`M ${jA.x} ${jA.y} A ${rj} ${rj} 0 0 ${sweep} ${jB.x} ${jB.y}`} fill="none" stroke={GRAD} strokeWidth={1.4} />
                <path d={`M ${jMid.x} ${jMid.y} L ${pPar.x} ${pPar.y}`} fill="none" stroke={GRAD} strokeWidth={1.4} strokeLinecap="round" />
                {/* winner's route ONLY, tinted with its flag colour. It draws
                    in from child to parent as the winner's flag hops through it
                    — same path + 1.25s ease as the flag's offset-path, so the
                    flag appears to paint the line. Gated on the round playing. */}
                {win && jWin && winColor && simRound >= depth + 1 && (() => {
                  const d = `M ${win.x} ${win.y} L ${jWin.x} ${jWin.y} A ${rj} ${rj} 0 0 ${arcSweep} ${jMid.x} ${jMid.y} L ${pPar.x} ${pPar.y}`;
                  return (
                    <>
                      {/* luminous underlay */}
                      <path
                        className="bracket-conn-draw"
                        d={d}
                        fill="none"
                        stroke={winColor}
                        strokeWidth={6}
                        strokeLinecap="round"
                        opacity={0.5}
                        filter="url(#conn-glow)"
                        pathLength={1}
                      />
                      {/* crisp national-colour line */}
                      <path
                        className="bracket-conn-draw"
                        d={d}
                        fill="none"
                        stroke={winColor}
                        strokeWidth={3.8}
                        strokeLinecap="round"
                        pathLength={1}
                      />
                    </>
                  );
                })()}
              </g>
            );
          });
        })}

        {/* (2c) Finalists -> center (champion's line tinted with its flag colour) */}
        {rings[geom.length - 1]?.map((node) => {
          const inner = ellipse(30, 30, node.angle);
          // Champion's line to the trophy colours in once the final has played.
          const championLine = node.isWinner && simRound >= geom.length;
          return (
            <g key={`final-${node.index}`}>
              <path
                d={`M ${node.x} ${node.y} L ${inner.x} ${inner.y}`}
                fill="none"
                stroke="url(#conn-grad)"
                strokeWidth={1.4}
                strokeLinecap="round"
              />
              {championLine && (
                <>
                  <path
                    className="bracket-conn-draw"
                    d={`M ${node.x} ${node.y} L ${inner.x} ${inner.y}`}
                    fill="none"
                    stroke={colorFor(node.team)}
                    strokeWidth={6}
                    strokeLinecap="round"
                    opacity={0.5}
                    filter="url(#conn-glow)"
                    pathLength={1}
                  />
                  <path
                    className="bracket-conn-draw"
                    d={`M ${node.x} ${node.y} L ${inner.x} ${inner.y}`}
                    fill="none"
                    stroke={colorFor(node.team)}
                    strokeWidth={3.8}
                    strokeLinecap="round"
                    pathLength={1}
                  />
                </>
              )}
            </g>
          );
        })}

        {/* (2d) Outward "still in it" tails — a bold fading national-colour line
            that reaches OUT of the bracket to the canvas edge from each team's
            outer flag, through its crest, marking who's left at a glance (as in
            the reference art). Every team starts with a tail; each breathes with
            a gentle pulse to look alive, and retracts (scale + fade into the
            flag) the round its team is knocked out — so the tails thin as the
            animation plays and a finished edition leaves just the champion's. */}
        {(() => {
          const outerR = geom[0].rx;
          return (rings[0] ?? []).map((node) => {
            if (node.team.placeholder) return null;
            const j = journeyByTeam.get(node.team.id);
            if (!j) return null;
            // Still alive = champion (never eliminated) or not yet beaten in the
            // play-through. Kept mounted when out so it can retract, not vanish.
            const aliveNow = j.eliminatedAtDepth == null || simRound <= j.eliminatedAtDepth;

            const col = colorFor(node.team);
            const ux = (node.x - C.x) / outerR;
            const uy = (node.y - C.y) / outerR;
            // Reach out toward the (margin-expanded) canvas edge in this
            // direction so the tail is long and runs off-frame (the fade hides
            // the cut). Half-extent from centre is 570 with the -70..1070 viewBox.
            const tEdge = Math.min(570 / Math.abs(ux || 1e-6), 570 / Math.abs(uy || 1e-6));
            const r0 = outerR + node.discR + 1; // just outside the flag
            const r1 = Math.min(outerR + 210, tEdge - 6);
            const x0 = C.x + ux * r0, y0 = C.y + uy * r0;
            const x1 = C.x + ux * r1, y1 = C.y + uy * r1;
            const gid = `tail-grad-${node.index}`;
            // Scale about the flag anchor: with transform-box: fill-box the
            // origin is the bbox corner nearest the flag (depends on direction).
            const origin = `${ux >= 0 ? 0 : 100}% ${uy >= 0 ? 0 : 100}%`;
            const pulseDelay = `${((node.index * 0.29) % 2.4).toFixed(2)}s`;
            return (
              <g key={`tail-${node.index}`}>
                <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={x0} y1={y0} x2={x1} y2={y1}>
                  <stop offset="0%" stopColor={col} stopOpacity="1" />
                  <stop offset="50%" stopColor={col} stopOpacity="0.85" />
                  <stop offset="100%" stopColor={col} stopOpacity="0" />
                </linearGradient>
                <g
                  className="bracket-tail-retract"
                  style={{
                    transformOrigin: origin,
                    transform: aliveNow ? 'scale(1)' : 'scale(0)',
                    opacity: aliveNow ? 1 : 0,
                  }}
                >
                  <g
                    className="bracket-tail-pulse"
                    style={{ transformOrigin: origin, animationDelay: pulseDelay }}
                  >
                    <path
                      className="bracket-conn-draw"
                      d={`M ${x0} ${y0} L ${x1} ${y1}`}
                      fill="none"
                      stroke={`url(#${gid})`}
                      strokeWidth={13}
                      strokeLinecap="round"
                      opacity={0.32}
                      pathLength={1}
                    />
                    <path
                      className="bracket-conn-draw"
                      d={`M ${x0} ${y0} L ${x1} ${y1}`}
                      fill="none"
                      stroke={`url(#${gid})`}
                      strokeWidth={5.6}
                      strokeLinecap="round"
                      pathLength={1}
                    />
                  </g>
                </g>
              </g>
            );
          });
        })()}

        {/* (2b) Junction dots. A DECIDED slot shows the winner's flag (see the
            inner-ring discs below), so its dot is just a small colour marker. An
            UNDECIDED slot whose two feeder teams are both known is the point the
            winner's flag will travel to — that dot is clickable and opens the
            upcoming match's preview. */}
        {rings.map((ring, depth) => {
          if (depth < 1) return null;
          const childRing = rings[depth - 1];
          return ring.map((node) => {
            const cA = childRing[2 * node.index];
            const cB = childRing[2 * node.index + 1];
            const upcomingMatch =
              mode !== 'predict' &&
              node.team.placeholder &&
              cA?.match != null &&
              !cA.team.placeholder &&
              !!cB &&
              !cB.team.placeholder
                ? cA.match
                : null;

            // A live-now or kicks-off-today match gets a radar ping so it's
            // obvious the dot is tappable. Gated on `mounted` (uses client clock).
            const rawKind: 'live' | 'today' | null = !upcomingMatch
              ? null
              : upcomingMatch.state === 'live'
              ? 'live'
              : upcomingMatch.state === 'scheduled' && isTodayLocal(upcomingMatch.kickoff)
              ? 'today'
              : null;
            const kind = mounted ? rawKind : null;
            const pingColor = kind === 'live' ? '#ff5c5c' : '#e8b84b';
            const dotFill = !node.team.placeholder
              ? colorFor(node.team)
              : !upcomingMatch
              ? '#43434c'
              : kind === 'live'
              ? '#ff5c5c'
              : kind === 'today'
              ? '#e8b84b'
              : '#6a7a95';

            return (
              <g key={`dot-${depth}-${node.index}`}>
                {kind && (
                  <>
                    <circle
                      className="bracket-ping"
                      cx={node.x}
                      cy={node.y}
                      r={5}
                      fill="none"
                      stroke={pingColor}
                      strokeWidth={1.4}
                    />
                    <circle
                      className="bracket-ping bracket-ping--delay"
                      cx={node.x}
                      cy={node.y}
                      r={5}
                      fill="none"
                      stroke={pingColor}
                      strokeWidth={1.4}
                    />
                  </>
                )}
                <circle
                  className={upcomingMatch ? 'bracket-slot-dot' : undefined}
                  cx={node.x}
                  cy={node.y}
                  r={upcomingMatch ? 4.5 : 3.2}
                  fill={dotFill}
                  stroke={upcomingMatch ? '#0b0b0d' : undefined}
                  strokeWidth={upcomingMatch ? 1.2 : undefined}
                  role={upcomingMatch ? 'button' : undefined}
                  tabIndex={upcomingMatch ? 0 : undefined}
                  aria-label={
                    upcomingMatch
                      ? t(
                          'bracket.matchLabel',
                          cA!.team.abbr,
                          cB!.team.abbr,
                          kind === 'live' ? t('match.live') : kind === 'today' ? t('time.today') : '',
                        )
                      : undefined
                  }
                  onClick={upcomingMatch ? () => handleView(upcomingMatch) : undefined}
                  onKeyDown={upcomingMatch ? activate(() => handleView(upcomingMatch)) : undefined}
                />
              </g>
            );
          });
        })}

        {/* (3) Team discs */}
        {/* Outer ring (depth 0): twin crest + flag per team */}
        {rings[0]?.map((node) => {
          // The flag stays lit as the R32 winning-path marker (greys only on a
          // round-1 loss). The CREST is a team-level badge, so it greys once the
          // team is knocked out in ANY round — in lock-step with its tail
          // retracting — instead of staying bright for a team that's long out.
          const cj = journeyByTeam.get(node.team.id);
          const crestGreyed =
            !!cj && cj.eliminatedAtDepth != null && simRound > cj.eliminatedAtDepth;
          return (
            <OuterTeam
              key={`outer-${node.index}`}
              node={node}
              mode={mode}
              clickable={node.clickable}
              viewable={false}
              // R32 badges start colored; losers grey once round 1 has played.
              greyed={node.eliminated && simRound >= 1}
              crestGreyed={crestGreyed}
              onClick={() => handleDiscClick(node)}
              teamStyle={teamStyle}
            />
          );
        })}

        {/* Trail of flags: one per level each team reached (the bracket path).
            The tournament plays forward level by level — a team's flag hops one
            ring inward from its previous spot (following the connector) when its
            round is reached, then stays; it greys the round it loses. */}
        {journeys.flatMap((j) =>
          j.positions.slice(1).map((stop, i) => {
            if (simRound < stop.depth) return null; // round not yet played
            const from = j.positions[i]; // previous stop (one ring out)
            const greyed = stop.node.eliminated && simRound >= stop.depth + 1;
            return (
              <InnerHop
                key={`hop-${j.teamId}-${stop.depth}`}
                stop={stop}
                from={from}
                geom={geom}
                greyed={greyed}
                mode={mode}
                teamStyle={teamStyle}
                onView={(m) => handleView(m)}
                onPick={(node) => handleDiscClick(node)}
              />
            );
          }),
        )}

        {/* (1b) Center emblem on top. The World Cup gets the real trophy; every
            other competition gets its own emblem, because /trophy.png IS the
            FIFA trophy and putting it at the middle of a Leagues Cup bracket
            states something false. Once a finished edition's final has
            resolved, it becomes a button that opens the final match's details
            (same popup as a result dot). */}
        {(() => {
          const finalMatch = champNode?.match ?? null;
          const trophyImg = trophyImage ? (
            <image
              href={trophyImage}
              x={C.x - 26}
              y={C.y - 64}
              width={52}
              height={128}
              preserveAspectRatio="xMidYMid meet"
            />
          ) : (
            <text
              x={C.x}
              y={C.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={64}
              role="img"
              aria-label={t('bracket.competitionEmblem')}
            >
              {emblem}
            </text>
          );
          if (!finalMatch) return trophyImg;
          return (
            <g
              className="champ-trophy-btn"
              role="button"
              tabIndex={0}
              aria-label={t('bracket.viewFinal', finalMatch.home.name, finalMatch.away.name)}
              onClick={() => handleView(finalMatch)}
              onKeyDown={activate(() => handleView(finalMatch))}
            >
              {/* transparent hit target over the trophy (narrower than the gap to
                  the finalist discs, so it never steals their clicks) */}
              <rect x={C.x - 26} y={C.y - 64} width={52} height={128} fill="transparent" />
              {trophyImg}
            </g>
          );
        })()}

        {/* (1c) Champion crown: a laurel ring around the winning disc plus a
            curved "CHAMPIONS" caption arced beneath the trophy (empty space). */}
        {champNode && (
          <g className="champ-crown" role="img" aria-label={t('bracket.championLabel', champNode.team.name, championTitle)}>
            <circle
              className="champ-laurel"
              cx={champNode.x}
              cy={champNode.y}
              r={champNode.discR + 5}
              fill="none"
              stroke="#f0c873"
              strokeWidth={1.4}
            />
            <path id="champ-arc" d={arcTextPath(C.x, C.y, 100, 124, 56)} fill="none" />
            <text className="champ-caption" fill="#f0c873">
              <textPath href="#champ-arc" startOffset="50%" textAnchor="middle">
                {championTitle}
              </textPath>
            </text>
          </g>
        )}
      </svg>
      </BracketZoom>

      {detail && (
        <MatchDetailPopup
          teamBase={teamBase}
          match={detail}
          summary={summary}
          loading={loadingDetail}
          onClose={() => { setDetail(null); setSummary(null); }}
        />
      )}
    </div>
  );
}

/** A circular image disc filling its clip circle. */
function ImageDisc({
  id,
  x,
  y,
  r,
  href,
  fit,
  bg,
  ringStroke,
  ringWidth,
}: {
  id: string;
  x: number;
  y: number;
  r: number;
  href: string;
  fit: 'slice' | 'meet';
  bg: string | null;
  ringStroke: string;
  ringWidth: number;
}) {
  return (
    <g>
      <defs>
        <clipPath id={id}>
          <circle cx={x} cy={y} r={r} />
        </clipPath>
      </defs>
      {bg && <circle cx={x} cy={y} r={r} fill={bg} />}
      <image
        href={href}
        x={x - r}
        y={y - r}
        width={r * 2}
        height={r * 2}
        clipPath={`url(#${id})`}
        preserveAspectRatio={`xMidYMid ${fit}`}
      />
      <circle cx={x} cy={y} r={r} fill="none" stroke={ringStroke} strokeWidth={ringWidth} />
    </g>
  );
}

/** Plain fallback disc with abbreviation text. */
function FallbackDisc({
  x,
  y,
  r,
  abbr,
  ringStroke,
  ringWidth,
}: {
  x: number;
  y: number;
  r: number;
  abbr: string;
  ringStroke: string;
  ringWidth: number;
}) {
  return (
    <g aria-label={abbr}>
      <circle cx={x} cy={y} r={r} fill="#16161c" stroke={ringStroke} strokeWidth={ringWidth} />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#777"
        fontSize={r > 24 ? 9 : 7}
        fontWeight={600}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        {abbr.slice(0, 4)}
      </text>
    </g>
  );
}

/** Outer team: federation crest (outside) + flag roundel (inside), touching.
 *  For club style, renders a single crest disc only (no outer federation badge). */
function OuterTeam({
  node,
  mode,
  clickable,
  viewable,
  greyed,
  crestGreyed,
  onClick,
  teamStyle,
}: {
  node: RingNode;
  mode: BracketMode;
  clickable: boolean;
  viewable: boolean;
  greyed: boolean;
  crestGreyed: boolean;
  onClick: () => void;
  teamStyle: TeamStyle;
}) {
  const { team, isWinner } = node;
  // Clean disc: a thin gold ring marks a winner, a quiet dark hairline otherwise.
  // The national colour lives in the connector PATHS, not the discs (keeping the
  // discs clean is what reads as premium — matches the reference art).
  const ringStroke = isWinner && !greyed ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner && !greyed ? 2.4 : 1;

  const flag = team.placeholder ? null : flagUrl(team.abbr);
  const crest = team.placeholder ? null : crestSrc(team.abbr);
  const interactive = (mode === 'predict' && clickable) || viewable;

  return (
    <g
      aria-label={team.name}
      className={`${interactive ? 'bracket-disc bracket-disc--clickable' : 'bracket-disc'}${
        greyed ? ' bracket-disc--eliminated' : ''
      }`}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? activate(onClick) : undefined}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
    >
      {teamStyle === 'crest' ? (
        /* Club style: single crest disc — meet fit on a light background */
        (() => {
          const clubCrest = team.placeholder ? null : (team.crestUrl ?? crestSrc(team.abbr));
          return clubCrest ? (
            <ImageDisc
              id={`flag-${node.index}`}
              x={node.x}
              y={node.y}
              r={node.discR}
              href={clubCrest}
              fit="meet"
              bg="#f4f4f6"
              ringStroke={ringStroke}
              ringWidth={ringWidth}
            />
          ) : (
            <FallbackDisc
              x={node.x}
              y={node.y}
              r={node.discR}
              abbr={team.abbr}
              ringStroke={ringStroke}
              ringWidth={ringWidth}
            />
          );
        })()
      ) : (
        /* National style: bare federation crest (outer) + flag roundel (inner).
           The crest floats as a plain logo — no disc, no ring — like the
           reference art; only the flag is a circle. The crest greys once the
           team is knocked out (via crestGreyed); the parent already greys it on
           a round-1 loss, so only apply the extra dimming when the flag hasn't
           already greyed, to avoid double-darkening. */
        <>
          <g className={crestGreyed && !greyed ? 'bracket-disc--eliminated' : undefined}>
            {crest ? (
              <image
                href={crest}
                x={node.crestX - CREST_R}
                y={node.crestY - CREST_R}
                width={CREST_R * 2}
                height={CREST_R * 2}
                preserveAspectRatio="xMidYMid meet"
              />
            ) : (
              <text
                x={node.crestX}
                y={node.crestY}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#8a8a92"
                fontSize={9}
                fontWeight={600}
                fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
              >
                {team.abbr}
              </text>
            )}
          </g>

          {/* Flag (inner) — slice so it fills the circle */}
          {flag ? (
            <ImageDisc
              id={`flag-${node.index}`}
              x={node.x}
              y={node.y}
              r={node.discR}
              href={flag}
              fit="slice"
              bg={null}
              ringStroke={ringStroke}
              ringWidth={ringWidth}
            />
          ) : (
            <FallbackDisc
              x={node.x}
              y={node.y}
              r={node.discR}
              abbr={team.abbr}
              ringStroke={ringStroke}
              ringWidth={ringWidth}
            />
          )}
        </>
      )}
    </g>
  );
}

/**
 * One inner-ring flag on a team's path. When its round plays it travels in from
 * the previous ring ALONG the connector elbow (radial stub -> tangential arc ->
 * radial stub — the same path the connector line draws) and comes to rest on its
 * node. Greys once its team has lost the round (`greyed`).
 */
function InnerHop({
  stop,
  from,
  geom,
  greyed,
  mode,
  teamStyle,
  onView,
  onPick,
}: {
  stop: JourneyStop;
  from: JourneyStop;
  geom: RingGeom[];
  greyed: boolean;
  mode: BracketMode;
  teamStyle: TeamStyle;
  onView: (m: BracketMatch) => void;
  onPick: (node: RingNode) => void;
}) {
  const { node } = stop;
  const { team, isWinner, discR: r } = node;
  // Clean disc — thin gold ring for a winner, dark hairline otherwise. Colour
  // lives in the paths, not the discs.
  const ringStroke = isWinner && !greyed ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner && !greyed ? 2.4 : 1;

  // Clicking a flag views the match it WON to reach this ring — the pairing
  // "beneath" it in the tree (i.e. the previous ring's match this team played),
  // not the match at its current ring. E.g. Mexico's R16 flag opens Mex v Ecu
  // (the R32 win), not Mex v Eng (its R16 tie).
  const wonMatch = from.node.match;
  const viewable = mode !== 'predict' && wonMatch != null;
  const clickable = mode === 'predict' && node.clickable;
  const interactive = viewable || clickable;

  // Motion path = the connector's winner route between the two rings: radial
  // stub in to the join radius, tangential arc to the node's angle, radial stub
  // in to the node. Identical geometry to the drawn connector (see section 2).
  const rc = geom[stop.depth - 1].rx;
  const rp = geom[stop.depth].rx;
  const rj = rp + (rc - rp) * 0.5;
  const j0 = ellipse(rj, rj, from.node.angle);
  const j1 = ellipse(rj, rj, node.angle);
  const sweep = node.angle > from.node.angle ? 1 : 0;
  const motionPath = `M ${from.x} ${from.y} L ${j0.x} ${j0.y} A ${rj} ${rj} 0 0 ${sweep} ${j1.x} ${j1.y} L ${stop.x} ${stop.y}`;

  let disc: React.ReactNode;
  if (teamStyle === 'crest') {
    const img = team.crestUrl ?? crestSrc(team.abbr);
    disc = img ? (
      <ImageDisc id={`hop-${team.id}-${node.depth}`} x={0} y={0} r={r} href={img} fit="meet" bg="#f4f4f6" ringStroke={ringStroke} ringWidth={ringWidth} />
    ) : (
      <FallbackDisc x={0} y={0} r={r} abbr={team.abbr} ringStroke={ringStroke} ringWidth={ringWidth} />
    );
  } else {
    const flag = flagUrl(team.abbr);
    disc = flag ? (
      <ImageDisc id={`hop-${team.id}-${node.depth}`} x={0} y={0} r={r} href={flag} fit="slice" bg={null} ringStroke={ringStroke} ringWidth={ringWidth} />
    ) : (
      <FallbackDisc x={0} y={0} r={r} abbr={team.abbr} ringStroke={ringStroke} ringWidth={ringWidth} />
    );
  }

  // offset-path drives the disc along the elbow; offset-distance animates 0->100%.
  const motionStyle = {
    offsetPath: `path('${motionPath}')`,
    offsetRotate: '0deg',
  } as CSSProperties;
  const cls = `bracket-disc bracket-hop${interactive ? ' bracket-disc--clickable' : ''}${greyed ? ' bracket-disc--eliminated' : ''}`;

  const handleClick = () => {
    if (clickable) onPick(node);
    else if (viewable && wonMatch) onView(wonMatch);
  };

  return (
    <g
      className={cls}
      style={motionStyle}
      aria-label={team.name}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? activate(handleClick) : undefined}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
    >
      {disc}
    </g>
  );
}
