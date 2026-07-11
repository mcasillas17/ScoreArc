import type { BracketMatch, BracketTeam } from '@/server/data/types';

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
      positions: nodes.map((n) => ({ depth: n.depth, x: n.x, y: n.y })),
      eliminatedAtDepth: lost ? lost.depth : null,
      deepestNode: nodes[nodes.length - 1],
    });
  });
  return journeys;
}
