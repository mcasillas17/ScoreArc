import type { BracketRound, BracketMatch } from '@/server/data/types';

interface Props {
  rounds: BracketRound[];
}

// Championship rounds only (excludes 3rd-place-match)
const CHAMPIONSHIP_SLUGS = [
  'round-of-32',
  'round-of-16',
  'quarterfinals',
  'semifinals',
  'final',
] as const;

// Outer-to-inner radii for each championship round
const ROUND_RADII: Record<string, number> = {
  'round-of-32': 460,
  'round-of-16': 360,
  'quarterfinals': 260,
  'semifinals': 165,
  'final': 70,
};

const CX = 500;
const CY = 500;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function matchPosition(
  index: number,
  total: number,
  radius: number,
): { x: number; y: number; angle: number } {
  const angleDeg = -90 + ((index + 0.5) / total) * 360;
  const angleRad = toRad(angleDeg);
  return {
    x: CX + radius * Math.cos(angleRad),
    y: CY + radius * Math.sin(angleRad),
    angle: angleDeg,
  };
}

interface MatchNode {
  match: BracketMatch;
  x: number;
  y: number;
  angle: number;
  radius: number;
  index: number;
}

export default function RadialBracket({ rounds }: Props) {
  // Build championship rounds in order
  const champRounds = CHAMPIONSHIP_SLUGS.map((slug) =>
    rounds.find((r) => r.slug === slug),
  ).filter((r): r is BracketRound => r !== undefined);

  // Compute node positions for each round
  const roundNodes: MatchNode[][] = champRounds.map((round) => {
    const radius = ROUND_RADII[round.slug] ?? 200;
    return round.matches.map((match, i) => ({
      match,
      index: i,
      radius,
      ...matchPosition(i, round.matches.length, radius),
    }));
  });

  // Generate clip path IDs for team crests
  let clipIdCounter = 0;
  const nextClipId = () => `crc-${++clipIdCounter}`;

  // 3rd-place match (rendered separately, small, below center)
  const thirdPlace = rounds.find((r) => r.slug === '3rd-place-match');

  return (
    <div className="radial-bracket-wrap">
      <svg
        viewBox="0 0 1000 1000"
        aria-label="Knockout Bracket"
        role="img"
        style={{ width: '100%', height: 'auto', maxWidth: 760, margin: '0 auto', display: 'block' }}
      >
        <defs>
          {/* Trophy glow gradient */}
          <radialGradient id="trophy-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#5a3a10" stopOpacity="0.9" />
            <stop offset="50%" stopColor="#3a2008" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#0d0d0d" stopOpacity="0" />
          </radialGradient>
          {/* Outer ring glow */}
          <radialGradient id="outer-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0d0d0d" stopOpacity="0" />
            <stop offset="70%" stopColor="#1a1200" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#ffd34d" stopOpacity="0.04" />
          </radialGradient>
        </defs>

        {/* Background glow layers */}
        <circle cx={CX} cy={CY} r={490} fill="url(#outer-glow)" />
        <circle cx={CX} cy={CY} r={110} fill="url(#trophy-glow)" />

        {/* Round ring indicators — subtle circles */}
        {champRounds.map((round) => {
          const r = ROUND_RADII[round.slug] ?? 200;
          return (
            <circle
              key={round.slug}
              cx={CX}
              cy={CY}
              r={r}
              fill="none"
              stroke="#1e1e1e"
              strokeWidth={1}
            />
          );
        })}

        {/* Connector lines (parent→child) */}
        {champRounds.map((round, ri) => {
          if (ri === 0) return null; // R32 has no parent round
          const nodes = roundNodes[ri];
          const parentNodes = roundNodes[ri - 1];

          return nodes.map((node) => {
            const parentIndex = Math.floor(node.index / 2);
            const parent = parentNodes[parentIndex];
            if (!parent) return null;

            const isGold = node.match.winnerId !== null;

            return (
              <line
                key={`conn-${round.slug}-${node.index}`}
                x1={node.x}
                y1={node.y}
                x2={parent.x}
                y2={parent.y}
                stroke={isGold ? '#ffd34d' : '#3a3a3a'}
                strokeWidth={isGold ? 2.5 : 1.5}
                strokeLinecap="round"
                opacity={isGold ? 0.85 : 0.6}
              />
            );
          });
        })}

        {/* Match nodes */}
        {roundNodes.map((nodes, ri) => {
          const round = champRounds[ri];
          const isFinal = round.slug === 'final';

          return nodes.map((node) => {
            const { match, x, y, angle } = node;

            // Direction perpendicular to radius for placing two team discs
            const perpRad = toRad(angle + 90);
            const discOffset = isFinal ? 22 : 16;
            const innerOffset = isFinal ? -16 : -10;

            // home disc: slightly toward center
            const homeX = x + Math.cos(toRad(angle + 180)) * innerOffset + Math.cos(perpRad) * -discOffset;
            const homeY = y + Math.sin(toRad(angle + 180)) * innerOffset + Math.sin(perpRad) * -discOffset;

            // away disc: slightly toward outer
            const awayX = x + Math.cos(toRad(angle + 180)) * innerOffset + Math.cos(perpRad) * discOffset;
            const awayY = y + Math.sin(toRad(angle + 180)) * innerOffset + Math.sin(perpRad) * discOffset;

            const discR = isFinal ? 18 : 13;

            const homeClipId = nextClipId();
            const awayClipId = nextClipId();

            const homeIsWinner = match.winnerId === match.home.id && match.winnerId !== null;
            const awayIsWinner = match.winnerId === match.away.id && match.winnerId !== null;
            const isLive = match.state === 'live';

            // Score label — only show if at least one score is known
            const hasScores = match.homeScore !== null && match.awayScore !== null;
            // Position score label between the two discs, at x,y
            const scoreLabelX = x;
            const scoreLabelY = y;

            return (
              <g key={`match-${match.id}`} aria-label={`${match.home.abbr} vs ${match.away.abbr}`}>
                {/* Home team disc */}
                <defs>
                  <clipPath id={homeClipId}>
                    <circle cx={homeX} cy={homeY} r={discR} />
                  </clipPath>
                  <clipPath id={awayClipId}>
                    <circle cx={awayX} cy={awayY} r={discR} />
                  </clipPath>
                </defs>

                {/* Home crest or placeholder */}
                {match.home.placeholder || !match.home.crestUrl ? (
                  <>
                    <circle cx={homeX} cy={homeY} r={discR} fill="#1b1b1b" stroke="#333" strokeWidth={1} />
                    <text
                      x={homeX}
                      y={homeY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#666"
                      fontSize={isFinal ? 7 : 5}
                      fontWeight="600"
                      fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    >
                      {match.home.abbr.slice(0, 4)}
                    </text>
                  </>
                ) : (
                  <>
                    <circle cx={homeX} cy={homeY} r={discR} fill="#1b1b1b" />
                    <image
                      href={match.home.crestUrl}
                      x={homeX - discR}
                      y={homeY - discR}
                      width={discR * 2}
                      height={discR * 2}
                      clipPath={`url(#${homeClipId})`}
                      preserveAspectRatio="xMidYMid meet"
                    />
                    <circle
                      cx={homeX}
                      cy={homeY}
                      r={discR}
                      fill="none"
                      stroke={homeIsWinner ? '#ffd34d' : '#444'}
                      strokeWidth={homeIsWinner ? 2.5 : 1}
                    />
                  </>
                )}

                {/* Away crest or placeholder */}
                {match.away.placeholder || !match.away.crestUrl ? (
                  <>
                    <circle cx={awayX} cy={awayY} r={discR} fill="#1b1b1b" stroke="#333" strokeWidth={1} />
                    <text
                      x={awayX}
                      y={awayY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#666"
                      fontSize={isFinal ? 7 : 5}
                      fontWeight="600"
                      fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    >
                      {match.away.abbr.slice(0, 4)}
                    </text>
                  </>
                ) : (
                  <>
                    <circle cx={awayX} cy={awayY} r={discR} fill="#1b1b1b" />
                    <image
                      href={match.away.crestUrl}
                      x={awayX - discR}
                      y={awayY - discR}
                      width={discR * 2}
                      height={discR * 2}
                      clipPath={`url(#${awayClipId})`}
                      preserveAspectRatio="xMidYMid meet"
                    />
                    <circle
                      cx={awayX}
                      cy={awayY}
                      r={discR}
                      fill="none"
                      stroke={awayIsWinner ? '#ffd34d' : '#444'}
                      strokeWidth={awayIsWinner ? 2.5 : 1}
                    />
                  </>
                )}

                {/* Score or live indicator */}
                {isLive && (
                  <circle cx={scoreLabelX} cy={scoreLabelY} r={3} fill="#ff5c5c" opacity={0.9} />
                )}
                {hasScores && !isFinal && (
                  <text
                    x={scoreLabelX}
                    y={scoreLabelY + (isFinal ? 36 : 26)}
                    textAnchor="middle"
                    fill="#ffd34d"
                    fontSize={isFinal ? 11 : 8}
                    fontWeight="700"
                    fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    opacity={0.9}
                  >
                    {match.homeScore}–{match.awayScore}
                  </text>
                )}
              </g>
            );
          });
        })}

        {/* Trophy at center */}
        <text
          x={CX}
          y={CY}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={44}
          role="img"
          aria-label="Trophy"
        >
          🏆
        </text>
      </svg>

      {/* 3rd-place mini note below */}
      {thirdPlace && thirdPlace.matches.length > 0 && (
        <div className="bracket-third-place">
          <span className="bracket-third-label">3rd Place: </span>
          <span className="bracket-third-teams">
            {thirdPlace.matches[0].home.abbr} vs {thirdPlace.matches[0].away.abbr}
          </span>
        </div>
      )}
    </div>
  );
}
