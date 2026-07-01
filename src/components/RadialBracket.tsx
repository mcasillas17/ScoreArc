'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';

export type BracketMode = 'live' | 'predict';

interface Props {
  rounds: BracketRound[];
  mode?: BracketMode;
  picks?: Record<string, string>;
  onPick?: (depth: number, matchIndex: number, teamId: string) => void;
  onChampion?: (team: BracketTeam | null) => void;
}

// True circle — center of the (square) SVG canvas.
const C = { x: 500, y: 500 };

// Concentric CIRCLE radii (rx === ry) by depth.
// depth 0 = FLAG ring (32 teams), 1 = R16, 2 = QF, 3 = SF, 4 = Final.
const RINGS: { slug: string; rx: number; ry: number; discR: number }[] = [
  { slug: 'round-of-32', rx: 400, ry: 400, discR: 30 },
  { slug: 'round-of-16', rx: 312, ry: 312, discR: 26 },
  { slug: 'quarterfinals', rx: 224, ry: 224, discR: 27 },
  { slug: 'semifinals', rx: 138, ry: 138, discR: 29 },
  { slug: 'final', rx: 66, ry: 66, discR: 33 },
];

// Outer crest sits just beyond its flag along the same radial, and is SMALLER
// than the flag (as in the reference: federation logo smaller than the flag).
const CREST_SCALE = 1.155;
const CREST_R = 19;

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
};

function flagUrl(abbr: string): string | null {
  const iso = FLAG_MAP[abbr.toUpperCase()];
  return iso ? `https://flagcdn.com/w160/${iso}.png` : null;
}

function crestSrc(abbr: string): string | null {
  return CREST_MAP[abbr.toUpperCase()] ?? null;
}

// Representative colour from each team's flag — used to tint a team's advancing
// connector path (as in the reference: Brazil yellow, Canada red, ...).
const TEAM_COLOR: Record<string, string> = {
  RSA: '#007a4d', CAN: '#d52b1e', BRA: '#f5d915', JPN: '#bc002d', GER: '#ffce00',
  PAR: '#d52b1e', NED: '#f36c21', MAR: '#c1272d', CIV: '#f77f00', NOR: '#ba0c2f',
  FRA: '#0055a4', SWE: '#fecc00', MEX: '#006847', ECU: '#ffdd00', ENG: '#cf081f',
  COD: '#2a7fff', BEL: '#fdda24', SEN: '#00853f', USA: '#3c3b6e', BIH: '#1f3c8c',
  ESP: '#c60b1e', AUT: '#ed2939', POR: '#da291c', CRO: '#ff2a2a', SUI: '#d52b1e',
  ALG: '#0a8b3e', AUS: '#00843d', EGY: '#ce1126', ARG: '#75aadb', CPV: '#003893',
  COL: '#fcd116', GHA: '#fcd116',
};

export function colorFor(team: BracketTeam): string {
  return TEAM_COLOR[(team.abbr ?? '').toUpperCase()] ?? '#e8b84b';
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

interface RingNode {
  depth: number; // 0 (outer, 32 teams) .. 4 (inner, final pair)
  index: number; // slot index within the ring
  angle: number; // degrees on the circle
  match: BracketMatch | null;
  team: BracketTeam;
  isHome: boolean;
  x: number; // flag (or inner disc) position
  y: number;
  crestX: number; // outer crest position (depth 0 only)
  crestY: number;
  discR: number;
  isWinner: boolean; // team is the decided/effective winner of its match
  clickable: boolean; // predict mode: match undecided + both participants known
}

function ellipse(rx: number, ry: number, angleDeg: number): { x: number; y: number } {
  const r = toRad(angleDeg);
  return { x: C.x + rx * Math.cos(r), y: C.y + ry * Math.sin(r) };
}

function makePlaceholder(depth: number, slot: number): BracketTeam {
  return { id: `ph-${depth}-${slot}`, name: '', abbr: '', crestUrl: null, placeholder: true };
}

// The winning team of a match, or null if the match isn't decided yet (by ESPN).
function winnerTeam(match: BracketMatch | null): BracketTeam | null {
  if (!match || !match.winnerId) return null;
  if (match.home.id === match.winnerId) return match.home;
  if (match.away.id === match.winnerId) return match.away;
  return null;
}

/**
 * Effective winner of a match between teamA / teamB at (depth, matchIndex):
 *   real ESPN winner if decided, ELSE (predict mode) the user's pick if it is one
 *   of the two known participants, ELSE null. This is what advances inward, so a
 *   user's pick propagates exactly like a real result.
 */
function effectiveWinner(
  match: BracketMatch | null,
  depth: number,
  matchIndex: number,
  picks: Record<string, string>,
  mode: BracketMode,
  teamA: BracketTeam | null,
  teamB: BracketTeam | null,
): BracketTeam | null {
  const real = winnerTeam(match);
  if (real) return real;
  if (mode !== 'predict') return null;
  if (!teamA || !teamB || teamA.placeholder || teamB.placeholder) return null;
  const pickedId = picks[`${depth}:${matchIndex}`];
  if (!pickedId) return null;
  if (pickedId === teamA.id) return teamA;
  if (pickedId === teamB.id) return teamB;
  return null;
}

// A match is user-decidable (clickable in predict mode) when both participants
// are known and the ESPN match has NOT been really decided (real results lock).
function isDecidable(
  match: BracketMatch | null,
  teamA: BracketTeam | null,
  teamB: BracketTeam | null,
): boolean {
  if (!teamA || !teamB || teamA.placeholder || teamB.placeholder) return false;
  if (match && match.winnerId) return false;
  return true;
}

// Find the match in `round` played between two given team ids (either orientation).
function findMatch(round: BracketRound | undefined, idA: string, idB: string): BracketMatch | null {
  if (!round) return null;
  return (
    round.matches.find(
      (m) =>
        (m.home.id === idA && m.away.id === idB) ||
        (m.home.id === idB && m.away.id === idA),
    ) ?? null
  );
}

interface Slot {
  team: BracketTeam;
  match: BracketMatch | null; // the match this team plays at this depth
  isHome: boolean;
  isWinner: boolean; // won its match here (real or pick) -> advances inward
  clickable: boolean; // predict mode: this match can be decided by the user
}

// The FIXED official WC2026 knockout structure: each R32 match identified by its
// two team abbreviations, listed in bracket LEAF order so adjacent pairs feed the
// same R16, adjacent R16s feed the same QF, and so on. Verified against ESPN's
// decided R16 matchups (e.g. R16: Paraguay vs France, Brazil vs Norway) and the
// official feeder labels. Identity-based, so it's robust to ESPN re-ordering its
// events and to the official numbering not matching event order.
const OFFICIAL_R32_ORDER: [string, string][] = [
  ['RSA', 'CAN'], ['NED', 'MAR'], ['GER', 'PAR'], ['FRA', 'SWE'],
  ['ESP', 'AUT'], ['POR', 'CRO'], ['BEL', 'SEN'], ['USA', 'BIH'],
  ['BRA', 'JPN'], ['CIV', 'NOR'], ['MEX', 'ECU'], ['ENG', 'COD'],
  ['AUS', 'EGY'], ['ARG', 'CPV'], ['SUI', 'ALG'], ['COL', 'GHA'],
];

/**
 * Outer-ring order of the 32 R32 matches in official bracket order. Maps each
 * fixed matchup (by team abbreviations) to its index in the ESPN data; falls
 * back to plain event order if the teams don't match (e.g. data changed).
 */
function officialLeafOrder(r32: BracketRound | undefined): number[] {
  const fallback = r32 ? r32.matches.map((_, i) => i) : [];
  if (!r32 || r32.matches.length !== 16) return fallback;

  const findPair = (a: string, b: string): number =>
    r32.matches.findIndex((m) => {
      const x = (m.home.abbr ?? '').toUpperCase();
      const y = (m.away.abbr ?? '').toUpperCase();
      return (x === a && y === b) || (x === b && y === a);
    });

  const order: number[] = [];
  for (const [a, b] of OFFICIAL_R32_ORDER) {
    const idx = findPair(a, b);
    if (idx < 0) return fallback;
    order.push(idx);
  }
  if (order.length !== 16 || new Set(order).size !== 16) return fallback;
  return order;
}

/**
 * Build the bracket as a real tree so every position is correct:
 * depth 0 = the 32 round-of-32 participants (in bracket order); each inner depth's
 * slot = the actual WINNER of the match directly below it, looked up by team
 * identity in that round. Undecided slots become placeholders (no flag) — so a
 * team never appears in a round that hasn't happened yet.
 */
function buildRings(
  rounds: BracketRound[],
  picks: Record<string, string> = {},
  mode: BracketMode = 'live',
): RingNode[][] {
  const r32 = rounds.find((r) => r.slug === 'round-of-32');
  const ringSlots: Slot[][] = [];

  // Position the 32 leaves in official bracket order (identity-based) so every
  // R16/QF/SF pairing is correct — not adjacent event order.
  const leafOrder = officialLeafOrder(r32);

  const d0: Slot[] = [];
  if (r32) {
    leafOrder.forEach((origIdx, pos) => {
      const m = r32.matches[origIdx];
      if (!m) return;
      const eff = effectiveWinner(m, 0, pos, picks, mode, m.home, m.away);
      const clickable = mode === 'predict' && isDecidable(m, m.home, m.away);
      d0.push({ team: m.home, match: m, isHome: true, isWinner: eff?.id === m.home.id, clickable });
      d0.push({ team: m.away, match: m, isHome: false, isWinner: eff?.id === m.away.id, clickable });
    });
  }
  ringSlots.push(d0);

  for (let depth = 1; depth < RINGS.length; depth++) {
    const round = rounds.find((r) => r.slug === RINGS[depth].slug);
    const prev = ringSlots[depth - 1];
    const nSlots = Math.floor(prev.length / 2);

    // Team advancing into slot k = EFFECTIVE winner (real or pick) of the match
    // prev[2k]/prev[2k+1] played below — encoded on the prev slots' isWinner flag.
    const advancing: (BracketTeam | null)[] = [];
    for (let k = 0; k < nSlots; k++) {
      const a = prev[2 * k];
      const b = prev[2 * k + 1];
      advancing.push(a.isWinner ? a.team : b.isWinner ? b.team : null);
    }

    const slots: Slot[] = [];
    for (let k = 0; k < nSlots; k++) {
      const pair = Math.floor(k / 2); // match index at this depth
      const tA = advancing[2 * pair] ?? null;
      const tB = advancing[2 * pair + 1] ?? null;
      const matchR = tA && tB ? findMatch(round, tA.id, tB.id) : null;
      const team = advancing[k] ?? makePlaceholder(depth, k);
      const eff = effectiveWinner(matchR, depth, pair, picks, mode, tA, tB);
      slots.push({
        team,
        match: matchR,
        isHome: k % 2 === 0,
        isWinner: eff != null && eff.id === team.id,
        clickable: mode === 'predict' && isDecidable(matchR, tA, tB),
      });
    }
    ringSlots.push(slots);
  }

  return ringSlots.map((slots, depth) => {
    const cfg = RINGS[depth];
    const total = slots.length || 1;
    return slots.map((slot, index) => {
      const angle = -90 + (index + 0.5) * (360 / total);
      const flag = ellipse(cfg.rx, cfg.ry, angle);
      const crest = ellipse(cfg.rx * CREST_SCALE, cfg.ry * CREST_SCALE, angle);
      return {
        depth,
        index,
        angle,
        match: slot.match,
        team: slot.team,
        isHome: slot.isHome,
        x: flag.x,
        y: flag.y,
        crestX: crest.x,
        crestY: crest.y,
        discR: cfg.discR,
        isWinner: slot.isWinner,
        clickable: slot.clickable,
      };
    });
  });
}

export default function RadialBracket({ rounds, mode = 'live', picks = {}, onPick, onChampion }: Props) {
  const rings = buildRings(rounds, picks, mode);

  // The CHAMPION is the effective winner of the FINAL (depth 4).
  const champion = rings[4]?.find((n) => n.isWinner)?.team ?? null;
  useEffect(() => {
    onChampion?.(champion ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [champion?.id]);

  // Match-detail popup state (live/finished mode only)
  const [detail, setDetail] = useState<BracketMatch | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  async function handleView(m: BracketMatch) {
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/match/${m.id}?home=${m.home.id}&away=${m.away.id}`);
      const json = (await res.json()) as MatchSummary;
      setSummary(json);
    } catch {
      // leave summary null — popup will show empty state
    } finally {
      setLoadingDetail(false);
    }
  }

  function isViewable(node: RingNode): boolean {
    return (
      mode !== 'predict' &&
      !node.team.placeholder &&
      node.match !== null &&
      (node.match.state === 'finished' || node.match.state === 'live')
    );
  }

  const handleDiscClick = (node: RingNode) => {
    if (mode === 'predict' && node.clickable) {
      if (!onPick) return;
      onPick(node.depth, Math.floor(node.index / 2), node.team.id);
    } else if (isViewable(node) && node.match) {
      handleView(node.match);
    }
  };

  return (
    <div className="radial-bracket-wrap">
      <svg
        viewBox="0 0 1000 1000"
        aria-label="World Cup 2026 knockout bracket"
        role="img"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: 820,
          margin: '0 auto',
          display: 'block',
        }}
      >
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
        </defs>

        {/* (1) Smooth warm radial-gradient glow behind the trophy */}
        <circle cx={C.x} cy={C.y} r={300} fill="url(#center-glow)" />

        {/* (2) Connectors: bracket elbows — radial stub from each team, a
            tangential arc joining the pair, then a radial stub to the parent. */}
        {RINGS.slice(0, -1).map((cfg, depth) => {
          const rc = cfg.rx; // child ring radius
          const rp = RINGS[depth + 1].rx; // parent ring radius
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
                {/* winner's route ONLY, tinted with its flag colour */}
                {win && jWin && winColor && (
                  <g>
                    <path d={`M ${win.x} ${win.y} L ${jWin.x} ${jWin.y}`} fill="none" stroke={winColor} strokeWidth={2.9} strokeLinecap="round" />
                    <path d={`M ${jWin.x} ${jWin.y} A ${rj} ${rj} 0 0 ${arcSweep} ${jMid.x} ${jMid.y}`} fill="none" stroke={winColor} strokeWidth={2.9} />
                    <path d={`M ${jMid.x} ${jMid.y} L ${pPar.x} ${pPar.y}`} fill="none" stroke={winColor} strokeWidth={2.9} strokeLinecap="round" />
                  </g>
                )}
              </g>
            );
          });
        })}

        {/* (2c) Finalists -> center (champion's line tinted with its flag colour) */}
        {rings[RINGS.length - 1]?.map((node) => {
          const inner = ellipse(30, 30, node.angle);
          return (
            <path
              key={`final-${node.index}`}
              d={`M ${node.x} ${node.y} L ${inner.x} ${inner.y}`}
              fill="none"
              stroke={node.isWinner ? colorFor(node.team) : 'url(#conn-grad)'}
              strokeWidth={node.isWinner ? 2.9 : 1.4}
              strokeLinecap="round"
            />
          );
        })}

        {/* (2b) Junction dots — tinted with the occupying team's flag colour */}
        {rings.map((ring, depth) => {
          if (depth < 1) return null;
          return ring.map((node) => (
            <circle
              key={`dot-${depth}-${node.index}`}
              cx={node.x}
              cy={node.y}
              r={3.2}
              fill={node.team.placeholder ? '#43434c' : colorFor(node.team)}
            />
          ));
        })}

        {/* (3) Team discs */}
        {/* Outer ring (depth 0): twin crest + flag per team */}
        {rings[0]?.map((node) => (
          <OuterTeam
            key={`outer-${node.index}`}
            node={node}
            mode={mode}
            clickable={node.clickable}
            viewable={isViewable(node)}
            onClick={() => handleDiscClick(node)}
          />
        ))}

        {/* Inner rings (depth 1-4): single flag when decided, else nothing. Each
            advancing flag travels in ALONG THE CONNECTOR ELBOW (child -> arc join
            at the winner's angle -> arc join at the parent's angle -> slot). */}
        {rings.slice(1).map((ring, ri) => {
          const childRing = rings[ri]; // depth (ri+1) - 1 = ri
          const rc = RINGS[ri].rx; // child ring radius
          const rp = RINGS[ri + 1].rx; // this (parent) ring radius
          const rj = rp + (rc - rp) * 0.5; // arc-join radius (same as connector)
          return ring.map((node) => {
            if (node.team.placeholder) return null;
            const cA = childRing[2 * node.index];
            const cB = childRing[2 * node.index + 1];
            const src = cA?.isWinner ? cA : cB?.isWinner ? cB : null;
            let path: TravelPath = { x0: 0, y0: 0, x1: 0, y1: 0, x2: 0, y2: 0 };
            if (src) {
              const jWin = ellipse(rj, rj, src.angle);
              const jMid = ellipse(rj, rj, node.angle);
              path = {
                x0: src.x - node.x, y0: src.y - node.y, // child (winner)
                x1: jWin.x - node.x, y1: jWin.y - node.y, // radial-in at winner angle
                x2: jMid.x - node.x, y2: jMid.y - node.y, // along arc to parent angle
              };
            }
            return (
              <InnerFlag
                key={`inner-${node.depth}-${node.index}-${node.team.id}`}
                node={node}
                mode={mode}
                clickable={node.clickable}
                viewable={isViewable(node)}
                onClick={() => handleDiscClick(node)}
                path={path}
              />
            );
          });
        })}

        {/* (1b) Center trophy on top — real WC2026 trophy image */}
        <image
          href="/trophy.png"
          x={C.x - 26}
          y={C.y - 64}
          width={52}
          height={128}
          preserveAspectRatio="xMidYMid meet"
        />
      </svg>

      {detail && (
        <MatchDetailPopup
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

/** Outer team: federation crest (outside) + flag roundel (inside), touching. */
function OuterTeam({
  node,
  mode,
  clickable,
  viewable,
  onClick,
}: {
  node: RingNode;
  mode: BracketMode;
  clickable: boolean;
  viewable: boolean;
  onClick: () => void;
}) {
  const { team, isWinner } = node;
  const ringStroke = isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner ? 2.4 : 1;

  const flag = team.placeholder ? null : flagUrl(team.abbr);
  const crest = team.placeholder ? null : crestSrc(team.abbr);
  const interactive = (mode === 'predict' && clickable) || viewable;

  return (
    <g
      aria-label={team.name}
      className={interactive ? 'bracket-disc bracket-disc--clickable' : 'bracket-disc'}
      onClick={interactive ? onClick : undefined}
      role={interactive ? 'button' : undefined}
    >
      {/* Crest (outer) — meet so the badge isn't cropped, on a light disc */}
      {crest ? (
        <ImageDisc
          id={`crest-${node.index}`}
          x={node.crestX}
          y={node.crestY}
          r={CREST_R}
          href={crest}
          fit="meet"
          bg="#f4f4f6"
          ringStroke={ringStroke}
          ringWidth={ringWidth}
        />
      ) : (
        <FallbackDisc
          x={node.crestX}
          y={node.crestY}
          r={CREST_R}
          abbr={team.abbr}
          ringStroke={ringStroke}
          ringWidth={ringWidth}
        />
      )}

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
    </g>
  );
}

/** Inner advanced team: single flag disc (slice-fill). */
interface TravelPath {
  x0: number; y0: number; // child (winner) position
  x1: number; y1: number; // arc join at winner's angle
  x2: number; y2: number; // arc join at parent's angle
}

function InnerFlag({
  node,
  mode,
  clickable,
  viewable,
  onClick,
  path,
}: {
  node: RingNode;
  mode: BracketMode;
  clickable: boolean;
  viewable: boolean;
  onClick: () => void;
  path: TravelPath;
}) {
  const { team, isWinner } = node;
  const ringStroke = isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner ? 2.4 : 1;
  const flag = flagUrl(team.abbr);
  const interactive = (mode === 'predict' && clickable) || viewable;

  const cls = `bracket-disc bracket-inner-disc${interactive ? ' bracket-disc--clickable' : ''}`;

  const disc = !flag ? (
    <FallbackDisc
      x={node.x}
      y={node.y}
      r={node.discR}
      abbr={team.abbr}
      ringStroke={ringStroke}
      ringWidth={ringWidth}
    />
  ) : (
    <ImageDisc
      id={`inner-${node.depth}-${node.index}`}
      x={node.x}
      y={node.y}
      r={node.discR}
      href={flag}
      fit="slice"
      bg={null}
      ringStroke={ringStroke}
      ringWidth={ringWidth}
    />
  );

  const style = {
    '--x0': `${path.x0}px`, '--y0': `${path.y0}px`,
    '--x1': `${path.x1}px`, '--y1': `${path.y1}px`,
    '--x2': `${path.x2}px`, '--y2': `${path.y2}px`,
  } as CSSProperties;

  return (
    <g
      className={`${cls} bracket-advance`}
      style={style}
      onClick={interactive ? onClick : undefined}
      role={interactive ? 'button' : undefined}
    >
      {disc}
    </g>
  );
}

