import type { BracketRound, BracketMatch, BracketTeam } from '@/server/data/types';

interface Props {
  rounds: BracketRound[];
}

// Portrait ellipse — center of the SVG canvas.
const C = { x: 500, y: 625 };

// Ellipse radii (Rx, Ry) by depth. Portrait: Ry > Rx.
// depth 0 = FLAG ring (32 teams), 1 = R16, 2 = QF, 3 = SF, 4 = Final.
const RINGS: { slug: string; rx: number; ry: number; discR: number }[] = [
  { slug: 'round-of-32', rx: 388, ry: 500, discR: 30 },
  { slug: 'round-of-16', rx: 300, ry: 388, discR: 27 },
  { slug: 'quarterfinals', rx: 212, ry: 274, discR: 27 },
  { slug: 'semifinals', rx: 128, ry: 165, discR: 29 },
  { slug: 'final', rx: 62, ry: 80, discR: 33 },
];

// Outer crest sits 1.135x further out than its flag along the same radial.
const CREST_SCALE = 1.135;
const CREST_R = 30;

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

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

interface RingNode {
  depth: number; // 0 (outer, 32 teams) .. 4 (inner, final pair)
  index: number; // slot index within the ring
  match: BracketMatch;
  team: BracketTeam;
  isHome: boolean;
  x: number; // flag (or inner disc) position
  y: number;
  crestX: number; // outer crest position (depth 0 only)
  crestY: number;
  discR: number;
  isWinner: boolean; // team is the decided/effective winner of its match
}

function ellipse(rx: number, ry: number, angleDeg: number): { x: number; y: number } {
  const r = toRad(angleDeg);
  return { x: C.x + rx * Math.cos(r), y: C.y + ry * Math.sin(r) };
}

function buildRings(rounds: BracketRound[]): RingNode[][] {
  return RINGS.map((cfg, depth) => {
    const round = rounds.find((r) => r.slug === cfg.slug);
    if (!round) return [];

    const slots: { match: BracketMatch; team: BracketTeam; isHome: boolean }[] = [];
    for (const match of round.matches) {
      slots.push({ match, team: match.home, isHome: true });
      slots.push({ match, team: match.away, isHome: false });
    }

    const total = slots.length;
    return slots.map((slot, index) => {
      const angle = -90 + (index + 0.5) * (360 / total);
      const flag = ellipse(cfg.rx, cfg.ry, angle);
      const crest = ellipse(cfg.rx * CREST_SCALE, cfg.ry * CREST_SCALE, angle);
      const isWinner =
        slot.match.winnerId !== null && slot.match.winnerId === slot.team.id;
      return {
        depth,
        index,
        match: slot.match,
        team: slot.team,
        isHome: slot.isHome,
        x: flag.x,
        y: flag.y,
        crestX: crest.x,
        crestY: crest.y,
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
        viewBox="0 0 1000 1250"
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
            <stop offset="0%" stopColor="#5a4112" stopOpacity="0.9" />
            <stop offset="45%" stopColor="#33260a" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#0b0b0d" stopOpacity="0" />
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

        {/* (1) Warm radial glow + trophy at center */}
        <circle cx={C.x} cy={C.y} r={200} fill="url(#center-glow)" />
        <circle cx={C.x} cy={C.y} r={120} fill="#e8b84b" opacity={0.08} />
        <circle cx={C.x} cy={C.y} r={78} fill="#f0c64e" opacity={0.13} />
        <circle cx={C.x} cy={C.y} r={46} fill="#f6d873" opacity={0.18} />

        {/* (2) Connectors: each node (depth 0..3) -> parent (depth+1, floor(n/2)) */}
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
                stroke={gold ? '#e8b84b' : '#6b5f3f'}
                strokeWidth={gold ? 2.4 : 1.4}
                strokeLinecap="round"
                opacity={gold ? 0.95 : 0.55}
              />
            );
          });
        })}

        {/* (2b) Junction dots at every node from depth 1 inward */}
        {rings.map((ring, depth) => {
          if (depth < 1) return null;
          return ring.map((node) => (
            <circle
              key={`dot-${depth}-${node.index}`}
              cx={node.x}
              cy={node.y}
              r={3.5}
              fill={node.isWinner ? '#e8b84b' : '#4a4a52'}
            />
          ));
        })}

        {/* (3) Team discs */}
        {/* Outer ring (depth 0): twin crest + flag per team */}
        {rings[0]?.map((node) => (
          <OuterTeam key={`outer-${node.index}`} node={node} />
        ))}

        {/* Inner rings (depth 1-4): single flag when decided, else nothing */}
        {rings.slice(1).map((ring) =>
          ring.map((node) => {
            if (node.team.placeholder) return null;
            return <InnerFlag key={`inner-${node.depth}-${node.index}`} node={node} />;
          }),
        )}

        {/* (1b) Center trophy on top — real WC2026 trophy image */}
        <image
          href="/trophy.png"
          x={C.x - 35}
          y={C.y - 86}
          width={70}
          height={172}
          preserveAspectRatio="xMidYMid meet"
        />
      </svg>
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
function OuterTeam({ node }: { node: RingNode }) {
  const { team, isWinner } = node;
  const ringStroke = isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner ? 2.4 : 1;

  const flag = team.placeholder ? null : flagUrl(team.abbr);
  const crest = team.placeholder ? null : crestSrc(team.abbr);

  return (
    <g aria-label={team.name}>
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
function InnerFlag({ node }: { node: RingNode }) {
  const { team, isWinner } = node;
  const ringStroke = isWinner ? '#e8b84b' : '#2a2a32';
  const ringWidth = isWinner ? 2.4 : 1;
  const flag = flagUrl(team.abbr);

  if (!flag) {
    return (
      <FallbackDisc
        x={node.x}
        y={node.y}
        r={node.discR}
        abbr={team.abbr}
        ringStroke={ringStroke}
        ringWidth={ringWidth}
      />
    );
  }

  return (
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
}

