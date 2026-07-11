'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';
import { OFFICIAL_R32_ORDER, type TeamStyle } from '@/server/data/competitions';
import MatchDetailPopup, { type MatchSummary } from './MatchDetailPopup';
import BracketZoom from './BracketZoom';
import { teamJourney, type RingNode, type JourneyStop } from './radialBracketModel';

export type BracketMode = 'live' | 'predict';

interface Props {
  rounds: BracketRound[];
  mode?: BracketMode;
  picks?: Record<string, string>;
  onPick?: (depth: number, matchIndex: number, teamId: string) => void;
  onChampion?: (team: BracketTeam | null) => void;
  teamStyle: TeamStyle;
  apiBase: string;
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

// Enter/Space activates a role="button" SVG element (keyboard accessibility).
function activate(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
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
  eliminated: boolean; // lost its match here (decided, not the winner) -> greyed
  clickable: boolean; // predict mode: this match can be decided by the user
}

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
      d0.push({
        team: m.home,
        match: m,
        isHome: true,
        isWinner: eff?.id === m.home.id,
        eliminated: eff != null && eff.id !== m.home.id,
        clickable,
      });
      d0.push({
        team: m.away,
        match: m,
        isHome: false,
        isWinner: eff?.id === m.away.id,
        eliminated: eff != null && eff.id !== m.away.id,
        clickable,
      });
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
        eliminated: !team.placeholder && eff != null && eff.id !== team.id,
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
        eliminated: slot.eliminated,
        clickable: slot.clickable,
      };
    });
  });
}

export default function RadialBracket({ rounds, mode = 'live', picks = {}, onPick, onChampion, teamStyle, apiBase }: Props) {
  const rings = buildRings(rounds, picks, mode);

  const journeys = teamJourney(rings);
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
    }, 1400);
    return () => clearInterval(id);
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After the intro, keep up with newly-decided rounds (advance, don't replay).
  useEffect(() => {
    if (initDone.current) setSimRound((s) => Math.max(s, simTarget));
  }, [simTarget]);

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

  // Radar-ping cues use the client clock ("is this match today?"), so they only
  // render after mount to avoid an SSR/hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function handleView(m: BracketMatch) {
    setDetail(m);
    setSummary(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`${apiBase}/match/${m.id}?home=${m.home.id}&away=${m.away.id}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as MatchSummary;
      setSummary(json);
    } catch {
      // leave summary null — popup will show empty state
    } finally {
      setLoadingDetail(false);
    }
  }

  // While the popup is open on a LIVE match, quietly refresh its summary every
  // 15s so the score / stats / scorers stay current without blanking the card.
  useEffect(() => {
    if (!detail || detail.state !== 'live') return;
    let active = true;
    const id = setInterval(async () => {
      try {
        const res = await fetch(
          `${apiBase}/match/${detail.id}?home=${detail.home.id}&away=${detail.away.id}`,
          { cache: 'no-store' },
        );
        if (res.ok && active) setSummary((await res.json()) as MatchSummary);
      } catch {
        // ignore — next tick retries
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
                {/* winner's route ONLY, tinted with its flag colour. It draws
                    in from child to parent as the winner's flag hops through it
                    — same path + 1.25s ease as the flag's offset-path, so the
                    flag appears to paint the line. Gated on the round playing. */}
                {win && jWin && winColor && simRound >= depth + 1 && (
                  <path
                    className="bracket-conn-draw"
                    d={`M ${win.x} ${win.y} L ${jWin.x} ${jWin.y} A ${rj} ${rj} 0 0 ${arcSweep} ${jMid.x} ${jMid.y} L ${pPar.x} ${pPar.y}`}
                    fill="none"
                    stroke={winColor}
                    strokeWidth={2.9}
                    strokeLinecap="round"
                    pathLength={1}
                  />
                )}
              </g>
            );
          });
        })}

        {/* (2c) Finalists -> center (champion's line tinted with its flag colour) */}
        {rings[RINGS.length - 1]?.map((node) => {
          const inner = ellipse(30, 30, node.angle);
          // Champion's line to the trophy colours in once the final has played.
          const championLine = node.isWinner && simRound >= RINGS.length;
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
                <path
                  className="bracket-conn-draw"
                  d={`M ${node.x} ${node.y} L ${inner.x} ${inner.y}`}
                  fill="none"
                  stroke={colorFor(node.team)}
                  strokeWidth={2.9}
                  strokeLinecap="round"
                  pathLength={1}
                />
              )}
            </g>
          );
        })}

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
                      ? `${cA!.team.abbr} vs ${cB!.team.abbr}${
                          kind === 'live' ? ' — live' : kind === 'today' ? ' — today' : ''
                        }`
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
        {rings[0]?.map((node) => (
          <OuterTeam
            key={`outer-${node.index}`}
            node={node}
            mode={mode}
            clickable={node.clickable}
            viewable={false}
            // R32 badges start colored; losers grey once round 1 has played.
            greyed={node.eliminated && simRound >= 1}
            onClick={() => handleDiscClick(node)}
            teamStyle={teamStyle}
          />
        ))}

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
                greyed={greyed}
                mode={mode}
                teamStyle={teamStyle}
                onView={(m) => handleView(m)}
                onPick={(node) => handleDiscClick(node)}
              />
            );
          }),
        )}

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
      </BracketZoom>

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

/** Outer team: federation crest (outside) + flag roundel (inside), touching.
 *  For club style, renders a single crest disc only (no outer federation badge). */
function OuterTeam({
  node,
  mode,
  clickable,
  viewable,
  greyed,
  onClick,
  teamStyle,
}: {
  node: RingNode;
  mode: BracketMode;
  clickable: boolean;
  viewable: boolean;
  greyed: boolean;
  onClick: () => void;
  teamStyle: TeamStyle;
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
        /* National style: twin crest (outer) + flag (inner) — unchanged */
        <>
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
  greyed,
  mode,
  teamStyle,
  onView,
  onPick,
}: {
  stop: JourneyStop;
  from: JourneyStop;
  greyed: boolean;
  mode: BracketMode;
  teamStyle: TeamStyle;
  onView: (m: BracketMatch) => void;
  onPick: (node: RingNode) => void;
}) {
  const { node } = stop;
  const { team, isWinner, discR: r } = node;
  const ringStroke = isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner ? 2.4 : 1;

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
  const rc = RINGS[stop.depth - 1].rx;
  const rp = RINGS[stop.depth].rx;
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

