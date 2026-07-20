'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { flagUrl } from '@/lib/flags';

// Full-ring standings dial: rank 1 at 12 o'clock, clockwise; a glowing gold arc
// sweeps over the teams inside the qualification cut; the leader is crowned in
// the centre hub. Geometry is self-contained (fixed 500x500 viewBox).
const C = 250;
const R = 192;      // team-chip ring radius
const CHIP = 19;    // team-chip radius
const ARC_R = R + 26;
const HUB_R = 26;

function angleRad(rank: number, n: number): number {
  return ((-90 + (rank - 1) * (360 / n)) * Math.PI) / 180;
}
function pt(rank: number, n: number, radius: number): { x: number; y: number } {
  const a = angleRad(rank, n);
  return { x: C + radius * Math.cos(a), y: C + radius * Math.sin(a) };
}

// A crest clipped into a circle, with a fallback coloured disc + abbreviation.
function CrestDisc({
  s, teamStyle, x, y, r, ring, ringWidth, dim, idSuffix,
}: {
  s: Standing; teamStyle: TeamStyle; x: number; y: number; r: number;
  ring: string; ringWidth: number; dim: boolean; idSuffix?: string;
}) {
  const src = teamStyle === 'crest'
    ? (s.team.crestUrl ?? flagUrl(s.team.abbr))
    : (flagUrl(s.team.abbr) ?? s.team.crestUrl);
  const clip = `lld-clip-${s.team.id}${idSuffix ? '-' + idSuffix : ''}`;
  return (
    <g opacity={dim ? 0.4 : 1}>
      <defs>
        <clipPath id={clip}>
          <circle cx={x} cy={y} r={r} />
        </clipPath>
      </defs>
      <circle cx={x} cy={y} r={r} fill="#f4f4f6" />
      {src ? (
        <image
          href={src}
          x={x - r}
          y={y - r}
          width={r * 2}
          height={r * 2}
          clipPath={`url(#${clip})`}
          preserveAspectRatio="xMidYMid meet"
        />
      ) : (
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
          fontSize={r * 0.6} fontWeight={800} fill="#20223a">{s.team.abbr}</text>
      )}
      <circle cx={x} cy={y} r={r} fill="none" stroke={ring} strokeWidth={ringWidth} />
    </g>
  );
}

export default function LeagueDial({
  standings, cut, teamStyle,
}: {
  standings: Standing[];
  cut: number;
  teamStyle: TeamStyle;
}) {
  const n = standings.length;
  if (n === 0) return null;
  const leader = standings[0];
  const inCut = (rank: number) => rank <= cut;

  // gold Liguilla arc over ranks 1..cut
  const a0 = pt(1, n, ARC_R);
  const a1 = pt(Math.min(cut, n), n, ARC_R);

  return (
    <svg className="lld" viewBox="0 0 500 500" role="img" aria-label="Standings dial">
      <defs>
        <radialGradient id="lld-hub" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#40340f" />
          <stop offset="70%" stopColor="#1a1408" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#0b0b0d" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={C} cy={C} r={150} fill="url(#lld-hub)" />

      {/* Liguilla arc: a soft wide underlay (no blur filter) + a crisp line. */}
      <path className="lld-arc-glow"
        d={`M ${a0.x} ${a0.y} A ${ARC_R} ${ARC_R} 0 0 1 ${a1.x} ${a1.y}`}
        fill="none" stroke="var(--gold)" strokeWidth={9} strokeLinecap="round" opacity={0.28} />
      <path className="lld-arc"
        d={`M ${a0.x} ${a0.y} A ${ARC_R} ${ARC_R} 0 0 1 ${a1.x} ${a1.y}`}
        fill="none" stroke="var(--gold-bright)" strokeWidth={2.5} strokeLinecap="round" pathLength={1} />
      <circle cx={a0.x} cy={a0.y} r={3.2} fill="var(--gold-bright)" />
      <circle cx={a1.x} cy={a1.y} r={3.2} fill="var(--gold-bright)" />

      {/* spokes + team chips */}
      {standings.map((s) => {
        const p = pt(s.rank, n, R);
        const inner = pt(s.rank, n, 150);
        const outerStub = pt(s.rank, n, R - CHIP - 3);
        const lig = inCut(s.rank);
        return (
          <g key={s.team.id}>
            <line x1={inner.x} y1={inner.y} x2={outerStub.x} y2={outerStub.y}
              stroke={lig ? '#5a4a22' : '#20202a'} strokeWidth={1} />
            <CrestDisc s={s} teamStyle={teamStyle} x={p.x} y={p.y} r={CHIP}
              ring={lig ? 'var(--gold-bright)' : '#33333d'} ringWidth={lig ? 2 : 1} dim={!lig} />
          </g>
        );
      })}

      {/* centre hub: leader */}
      <text x={C} y={C - 30} fill="var(--text-muted)" fontSize={10} letterSpacing={3} textAnchor="middle">LEADER</text>
      <CrestDisc s={leader} teamStyle={teamStyle} x={C} y={C + 2} r={HUB_R}
        ring="var(--gold-bright)" ringWidth={2.5} dim={false} idSuffix="hub" />
      <text x={C} y={C + 44} fill="var(--text)" fontSize={13} fontWeight={700} textAnchor="middle">
        {leader.team.name}
      </text>
    </svg>
  );
}
