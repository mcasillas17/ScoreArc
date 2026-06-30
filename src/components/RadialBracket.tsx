import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';

interface Props {
  rounds: BracketRound[];
}

const CX = 500;
const CY = 500;

// Outer (depth 0) to inner (depth 4) ring configuration.
const RING_CONFIG = [
  { slug: 'round-of-32', radius: 455, discR: 21 },
  { slug: 'round-of-16', radius: 360, discR: 20 },
  { slug: 'quarterfinals', radius: 262, discR: 22 },
  { slug: 'semifinals', radius: 168, discR: 24 },
  { slug: 'final', radius: 86, discR: 28 },
] as const;

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

function flagUrl(abbr: string): string | null {
  const iso = FLAG_MAP[abbr.toUpperCase()];
  return iso ? `https://flagcdn.com/w160/${iso}.png` : null;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * One team slot in the radial bracket. The model is intentionally rich so a
 * future pass can attach click-to-advance interactivity without re-deriving geometry.
 */
interface RingNode {
  depth: number; // 0 (outer, 32 teams) .. 4 (inner, final pair)
  index: number; // slot index within the ring
  roundSlug: string;
  match: BracketMatch;
  team: BracketTeam;
  isHome: boolean;
  x: number;
  y: number;
  angle: number; // degrees
  radius: number;
  discR: number;
  isWinner: boolean; // team is the decided winner of its match
}

function buildRings(rounds: BracketRound[]): RingNode[][] {
  return RING_CONFIG.map((cfg, depth) => {
    const round = rounds.find((r) => r.slug === cfg.slug);
    if (!round) return [];

    // Flatten matches into [home, away, home, away, ...] team slots.
    const slots: { match: BracketMatch; team: BracketTeam; isHome: boolean }[] = [];
    for (const match of round.matches) {
      slots.push({ match, team: match.home, isHome: true });
      slots.push({ match, team: match.away, isHome: false });
    }

    const total = slots.length;
    return slots.map((slot, index) => {
      const angle = -90 + (index + 0.5) * (360 / total);
      const rad = toRad(angle);
      const isWinner =
        slot.match.winnerId !== null && slot.match.winnerId === slot.team.id;
      return {
        depth,
        index,
        roundSlug: cfg.slug,
        match: slot.match,
        team: slot.team,
        isHome: slot.isHome,
        x: CX + cfg.radius * Math.cos(rad),
        y: CY + cfg.radius * Math.sin(rad),
        angle,
        radius: cfg.radius,
        discR: cfg.discR,
        isWinner,
      };
    });
  });
}

export default function RadialBracket({ rounds }: Props) {
  const rings = buildRings(rounds);

  return (
    <div className="radial-bracket-wrap">
      <svg
        viewBox="0 0 1000 1000"
        aria-label="World Cup 2026 knockout bracket"
        role="img"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: 880,
          margin: '0 auto',
          display: 'block',
        }}
      >
        <defs>
          <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#5a4112" stopOpacity="0.85" />
            <stop offset="45%" stopColor="#33260a" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#0b0b0d" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="trophy-grad" x1="0" y1="-55" x2="0" y2="60" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f6e27a" />
            <stop offset="55%" stopColor="#d4af37" />
            <stop offset="100%" stopColor="#9b7d2e" />
          </linearGradient>
          <filter id="trophy-blur" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>

        {/* (a) Warm radial glow behind the centre */}
        <circle cx={CX} cy={CY} r={150} fill="url(#center-glow)" />
        <circle cx={CX} cy={CY} r={95} fill="#e8b84b" opacity={0.06} />
        <circle cx={CX} cy={CY} r={60} fill="#e8b84b" opacity={0.08} />

        {/* (b) Connectors: each node (depth 0..3) -> parent (depth+1, floor(n/2)) */}
        {rings.map((ring, depth) => {
          if (depth >= rings.length - 1) return null;
          const parents = rings[depth + 1];
          return ring.map((node) => {
            const parent = parents[Math.floor(node.index / 2)];
            if (!parent) return null;
            const gold = node.isWinner;
            return (
              <line
                key={`conn-${depth}-${node.index}`}
                x1={node.x}
                y1={node.y}
                x2={parent.x}
                y2={parent.y}
                stroke={gold ? '#e8b84b' : '#33333a'}
                strokeWidth={gold ? 2.5 : 1.5}
                strokeLinecap="round"
                opacity={gold ? 0.95 : 0.7}
              />
            );
          });
        })}

        {/* (c) Junction dots at every node from depth 1 inward */}
        {rings.map((ring, depth) => {
          if (depth < 1) return null;
          return ring.map((node) => (
            <circle
              key={`dot-${depth}-${node.index}`}
              cx={node.x}
              cy={node.y}
              r={3}
              fill={node.isWinner ? '#e8b84b' : '#555'}
            />
          ));
        })}

        {/* (d) Team flag discs */}
        {rings.map((ring, depth) =>
          ring.map((node) => (
            <TeamDisc key={`disc-${depth}-${node.index}`} node={node} />
          )),
        )}

        {/* Score labels + live pulse (depth 0 & 1 only) — once per match (home slot) */}
        {rings.map((ring, depth) =>
          ring.map((node) => {
            if (!node.isHome) return null;
            const away = ring[node.index + 1];
            if (!away) return null;
            const m = node.match;
            const midX = (node.x + away.x) / 2;
            const midY = (node.y + away.y) / 2;
            const dist = Math.hypot(midX - CX, midY - CY) || 1;
            const push = node.discR + 13;
            const lx = midX + ((midX - CX) / dist) * push;
            const ly = midY + ((midY - CY) / dist) * push;

            const showScore =
              depth <= 1 &&
              m.homeScore !== null &&
              m.awayScore !== null &&
              (m.state === 'finished' || m.state === 'live');

            return (
              <g key={`meta-${depth}-${node.index}`}>
                {m.state === 'live' && (
                  <circle
                    className="bracket-live-dot"
                    cx={midX}
                    cy={midY}
                    r={3.5}
                    fill="#ff5c5c"
                  />
                )}
                {showScore && (
                  <text
                    x={lx}
                    y={ly}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="#e8b84b"
                    fontSize={9}
                    fontWeight={700}
                    fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    opacity={0.92}
                  >
                    {m.homeScore}–{m.awayScore}
                  </text>
                )}
              </g>
            );
          }),
        )}

        {/* (e) Centre trophy */}
        <Trophy />
      </svg>
    </div>
  );
}

function TeamDisc({ node }: { node: RingNode }) {
  const { x, y, discR, team, isWinner } = node;
  const clipId = `clip-${node.depth}-${node.index}`;
  const url = team.placeholder ? null : flagUrl(team.abbr);

  const ringStroke = isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner ? 2.5 : 1;

  if (!url) {
    return (
      <g aria-label={team.abbr}>
        <circle cx={x} cy={y} r={discR} fill="#16161c" stroke={ringStroke} strokeWidth={ringWidth} />
        <text
          x={x}
          y={y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#666"
          fontSize={discR > 22 ? 9 : 7}
          fontWeight={600}
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        >
          {team.abbr.slice(0, 4)}
        </text>
      </g>
    );
  }

  return (
    <g aria-label={team.name}>
      <defs>
        <clipPath id={clipId}>
          <circle cx={x} cy={y} r={discR} />
        </clipPath>
      </defs>
      <circle cx={x} cy={y} r={discR} fill="#16161c" />
      <image
        href={url}
        x={x - discR}
        y={y - discR}
        width={discR * 2}
        height={discR * 2}
        clipPath={`url(#${clipId})`}
        preserveAspectRatio="xMidYMid slice"
      />
      <circle cx={x} cy={y} r={discR} fill="none" stroke={ringStroke} strokeWidth={ringWidth} />
    </g>
  );
}

function Trophy() {
  // Centred silhouette (local origin) translated to canvas centre. ~115px tall.
  const body =
    'M -10 45 C -26 30 -18 5 -6 -8 C -10 -20 -3 -28 0 -30 C 3 -28 10 -20 6 -8 C 18 5 26 30 10 45 Z';
  return (
    <g transform={`translate(${CX}, ${CY})`} aria-label="World Cup trophy">
      {/* soft glow copy behind */}
      <g filter="url(#trophy-blur)" opacity={0.6}>
        <path d={body} fill="#e8b84b" />
        <circle cx={0} cy={-40} r={12} fill="#e8b84b" />
      </g>
      {/* stepped base */}
      <rect x={-26} y={52} width={52} height={9} rx={2.5} fill="url(#trophy-grad)" />
      <rect x={-21} y={44} width={42} height={8} rx={2} fill="url(#trophy-grad)" />
      {/* flared body */}
      <path d={body} fill="url(#trophy-grad)" />
      {/* globe on top */}
      <circle cx={0} cy={-40} r={12} fill="url(#trophy-grad)" />
      <ellipse cx={0} cy={-40} rx={12} ry={5} fill="none" stroke="#9b7d2e" strokeWidth={0.8} opacity={0.6} />
      <line x1={0} y1={-52} x2={0} y2={-28} stroke="#9b7d2e" strokeWidth={0.8} opacity={0.5} />
      {/* subtle highlight on body */}
      <path
        d="M -4 40 C -16 24 -10 4 -2 -6"
        fill="none"
        stroke="#fbe7a6"
        strokeWidth={1.4}
        strokeLinecap="round"
        opacity={0.45}
      />
    </g>
  );
}
