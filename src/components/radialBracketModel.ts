import type { BracketMatch, BracketTeam, BracketRound } from '@/server/data/types';
import type { BracketShape } from './bracketShape';

// Moved out of RadialBracket.tsx so the pure model logic is unit-testable
// without pulling the React component tree into the test.
export interface RingNode {
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
  eliminated: boolean; // team lost its match here (decided, not the winner) -> greyed
  clickable: boolean; // predict mode: match undecided + both participants known
}

export interface JourneyStop {
  depth: number;
  x: number;
  y: number;
  node: RingNode; // the ring node at this stop (for disc render, greyscale, click)
}

export interface TeamJourney {
  teamId: string;
  positions: JourneyStop[]; // depth-ascending; positions[0] is the R32 home
  eliminatedAtDepth: number | null; // ring depth where it lost; null if alive / champion
  deepestNode: RingNode; // node at the deepest ring reached (for click + match)
}

/**
 * Derive each real team's inward journey from the built rings. A team occupies
 * a contiguous run of depths 0..k (it only advances to depth d after winning
 * depth d-1), so positions are contiguous and depth === array index.
 */
export function teamJourney(rings: RingNode[][]): TeamJourney[] {
  const byTeam = new Map<string, RingNode[]>();
  for (const ring of rings) {
    for (const n of ring) {
      if (n.team.placeholder) continue;
      const arr = byTeam.get(n.team.id) ?? [];
      arr.push(n);
      byTeam.set(n.team.id, arr);
    }
  }
  const journeys: TeamJourney[] = [];
  byTeam.forEach((nodes, teamId) => {
    nodes.sort((a, b) => a.depth - b.depth);
    const lost = nodes.find((n) => n.eliminated);
    journeys.push({
      teamId,
      positions: nodes.map((n) => ({ depth: n.depth, x: n.x, y: n.y, node: n })),
      eliminatedAtDepth: lost ? lost.depth : null,
      deepestNode: nodes[nodes.length - 1],
    });
  });
  return journeys;
}

// ============================================================================
// Bracket geometry + tree builder — moved out of RadialBracket.tsx so the model
// logic is pure and unit-testable. RadialBracket imports C/RINGS/ellipse/
// colorFor/buildRings from here for rendering.
// ============================================================================

export type BracketMode = 'live' | 'predict';

// True circle — center of the (square) SVG canvas.
export const C = { x: 500, y: 500 };

// Outer crest sits just beyond its flag along the same radial.
const CREST_SCALE = 1.155;

// Representative colour from each team's flag — used to tint a team's advancing
// connector path (as in the reference: Brazil yellow, Canada red, ...).
const TEAM_COLOR: Record<string, string> = {
  // 2026 field
  RSA: '#007a4d', CAN: '#d52b1e', BRA: '#f5d915', JPN: '#bc002d', GER: '#ffce00',
  PAR: '#d52b1e', NED: '#f36c21', MAR: '#c1272d', CIV: '#f77f00', NOR: '#ba0c2f',
  FRA: '#0055a4', SWE: '#fecc00', MEX: '#006847', ECU: '#ffdd00', ENG: '#cf081f',
  COD: '#2a7fff', BEL: '#fdda24', SEN: '#00853f', USA: '#3c3b6e', BIH: '#1f3c8c',
  ESP: '#c60b1e', AUT: '#ed2939', POR: '#da291c', CRO: '#ff2a2a', SUI: '#d52b1e',
  ALG: '#0a8b3e', AUS: '#00843d', EGY: '#ce1126', ARG: '#75aadb', CPV: '#003893',
  COL: '#fcd116', GHA: '#fcd116',
  // Historical WC teams (1998–2022) so past editions read in national colours too
  ITA: '#1a5fb4', URU: '#4a90d9', CHI: '#d52b1e', PER: '#d91023', KOR: '#c60c30',
  IRN: '#239f40', KSA: '#006c35', QAT: '#8a1538', SRB: '#c6363c', DEN: '#c60c30',
  POL: '#dc143c', WAL: '#c8102e', SCO: '#0065bf', TUR: '#e30a17', UKR: '#ffd500',
  CZE: '#11457e', RUS: '#0039a6', GRE: '#0d5eaf', ROU: '#ffce00', HUN: '#436f4d',
  NZL: '#00247d', CRC: '#c8102e', PAN: '#da121a', HON: '#0073cf', JAM: '#009b3a',
  HAI: '#00209f', VEN: '#cf142b', BOL: '#d52b1e', TUN: '#e70013', NGA: '#008751',
  CMR: '#007a5e',
};

export function colorFor(team: BracketTeam): string {
  return TEAM_COLOR[(team.abbr ?? '').toUpperCase()] ?? '#e8b84b';
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function ellipse(rx: number, ry: number, angleDeg: number): { x: number; y: number } {
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
 *   of the two known participants, ELSE null.
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
  eliminated: boolean; // lost its match here (decided, not the winner) -> greyed
  clickable: boolean; // predict mode: this match can be decided by the user
}

/**
 * Leaf-round order from a hardcoded seed list: maps each fixed matchup (by team
 * abbreviations, in bracket order) to its index in the ESPN data. Used for the
 * live/current edition whose tree isn't determined yet. Falls back to plain
 * event order if the pairings don't match. Works for any leaf size (8 or 16).
 */
export function leafOrderFromSeeds(
  leaf: BracketRound | undefined,
  seeds: [string, string][],
): number[] {
  const fallback = leaf ? leaf.matches.map((_, i) => i) : [];
  if (!leaf || leaf.matches.length !== seeds.length) return fallback;

  const findPair = (a: string, b: string): number =>
    leaf.matches.findIndex((m) => {
      const x = (m.home.abbr ?? '').toUpperCase();
      const y = (m.away.abbr ?? '').toUpperCase();
      return (x === a && y === b) || (x === b && y === a);
    });

  const order: number[] = [];
  seeds.forEach(([a, b]) => {
    const idx = findPair(a.toUpperCase(), b.toUpperCase());
    if (idx >= 0) order.push(idx);
  });
  if (order.length !== seeds.length || new Set(order).size !== seeds.length) return fallback;
  return order;
}

/**
 * Build the bracket as a real tree so every position is correct:
 * depth 0 = the round-of-32 participants (in bracket order); each inner depth's
 * slot = the actual WINNER of the match directly below it, looked up by team
 * identity in that round. Undecided slots become placeholders (no flag).
 */
export function buildRings(
  rounds: BracketRound[],
  shape: BracketShape,
  picks: Record<string, string> = {},
  mode: BracketMode = 'live',
): RingNode[][] {
  const geom = shape.ringGeometry;
  const leaf = rounds.find((r) => r.slug === shape.knockoutRounds[0]);
  // Live/current edition provides a seed order; finished editions derive it.
  const leafOrder = shape.bracketOrder
    ? leafOrderFromSeeds(leaf, shape.bracketOrder)
    : deriveLeafOrder(rounds, shape.knockoutRounds);
  const ringSlots: Slot[][] = [];

  const d0: Slot[] = [];
  if (leaf) {
    leafOrder.forEach((origIdx, pos) => {
      const m = leaf.matches[origIdx];
      if (!m) return;
      const eff = effectiveWinner(m, 0, pos, picks, mode, m.home, m.away);
      const clickable = mode === 'predict' && isDecidable(m, m.home, m.away);
      d0.push({
        team: m.home, match: m, isHome: true,
        isWinner: eff?.id === m.home.id,
        eliminated: eff != null && eff.id !== m.home.id, clickable,
      });
      d0.push({
        team: m.away, match: m, isHome: false,
        isWinner: eff?.id === m.away.id,
        eliminated: eff != null && eff.id !== m.away.id, clickable,
      });
    });
  }
  ringSlots.push(d0);

  for (let depth = 1; depth < geom.length; depth++) {
    const round = rounds.find((r) => r.slug === shape.knockoutRounds[depth]);
    const prev = ringSlots[depth - 1];
    const nSlots = Math.floor(prev.length / 2);

    const advancing: (BracketTeam | null)[] = [];
    for (let k = 0; k < nSlots; k++) {
      const a = prev[2 * k];
      const b = prev[2 * k + 1];
      advancing.push(a.isWinner ? a.team : b.isWinner ? b.team : null);
    }

    const slots: Slot[] = [];
    for (let k = 0; k < nSlots; k++) {
      const pair = Math.floor(k / 2);
      const tA = advancing[2 * pair] ?? null;
      const tB = advancing[2 * pair + 1] ?? null;
      const matchR = tA && tB ? findMatch(round, tA.id, tB.id) : null;
      const team = advancing[k] ?? makePlaceholder(depth, k);
      const eff = effectiveWinner(matchR, depth, pair, picks, mode, tA, tB);
      slots.push({
        team, match: matchR, isHome: k % 2 === 0,
        isWinner: eff != null && eff.id === team.id,
        eliminated: !team.placeholder && eff != null && eff.id !== team.id,
        clickable: mode === 'predict' && isDecidable(matchR, tA, tB),
      });
    }
    ringSlots.push(slots);
  }

  return ringSlots.map((slots, depth) => {
    const cfg = geom[depth];
    const total = slots.length || 1;
    return slots.map((slot, index) => {
      const angle = -90 + (index + 0.5) * (360 / total);
      const flag = ellipse(cfg.rx, cfg.ry, angle);
      const crest = ellipse(cfg.rx * CREST_SCALE, cfg.ry * CREST_SCALE, angle);
      return {
        depth, index, angle, match: slot.match, team: slot.team, isHome: slot.isHome,
        x: flag.x, y: flag.y, crestX: crest.x, crestY: crest.y, discR: cfg.discR,
        isWinner: slot.isWinner, eliminated: slot.eliminated, clickable: slot.clickable,
      };
    });
  });
}

/**
 * Reconstruct the leaf-round match order for a FINISHED bracket by unfolding the
 * tree from the final outward: a match at depth d has home/away teams that each
 * WON a match one round below; recurse and emit leaf indices left-to-right.
 * `knockoutRounds` is outer->inner (leaf first, final last). Falls back to plain
 * event order (0,1,2,...) if the bracket isn't fully/consistently decided.
 */
export function deriveLeafOrder(rounds: BracketRound[], knockoutRounds: string[]): number[] {
  const N = knockoutRounds.length;
  const leaf = rounds.find((r) => r.slug === knockoutRounds[0]);
  const fallback = leaf ? leaf.matches.map((_, i) => i) : [];
  const finalRound = rounds.find((r) => r.slug === knockoutRounds[N - 1]);
  if (!leaf || N < 1 || !finalRound || finalRound.matches.length !== 1) return fallback;

  const key = (m: BracketMatch) => [m.home.id, m.away.id].sort().join('|');
  const leafIndex = new Map<string, number>();
  leaf.matches.forEach((m, i) => leafIndex.set(key(m), i));

  const winnerOf = (m: BracketMatch): string | null =>
    m.winnerId === m.home.id ? m.home.id : m.winnerId === m.away.id ? m.away.id : null;

  const childWinnerMatch = (depth: number, teamId: string): BracketMatch | null => {
    const r = rounds.find((x) => x.slug === knockoutRounds[depth]);
    return r ? r.matches.find((mm) => winnerOf(mm) === teamId) ?? null : null;
  };

  const order: number[] = [];
  let ok = true;
  const unfold = (match: BracketMatch, depth: number): void => {
    if (!ok) return;
    if (depth === 0) {
      const idx = leafIndex.get(key(match));
      if (idx === undefined) { ok = false; return; }
      order.push(idx);
      return;
    }
    [match.home, match.away].forEach((team) => {
      const child = childWinnerMatch(depth - 1, team.id);
      if (!child) { ok = false; return; }
      unfold(child, depth - 1);
    });
  };
  unfold(finalRound.matches[0], N - 1);

  if (!ok || order.length !== leaf.matches.length || new Set(order).size !== leaf.matches.length) {
    return fallback;
  }
  return order;
}
