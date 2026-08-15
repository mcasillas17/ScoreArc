'use client';

import type { Standing } from '@/server/data/types';
import type { TeamStyle, Zone } from '@/server/data/competitions';
import { toBands, ZONE_VAR } from './zoneBands';

// The league analog of the arc bracket: the whole table laid around a ring,
// with each outcome drawn as an arc over the clubs it claims. Rank 1 sits at
// twelve o'clock and the table runs clockwise, so the top of the season is the
// top of the circle and relegation closes the loop beneath it.
//
// This is the multi-zone sibling of LeagueDial, which draws exactly one gold
// arc for a single qualification cut.

const SIZE = 500;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_CREST = 196; // crest centres
const R_ARC = 232; // outcome arcs, outside the crests

function pointAt(angleDeg: number, radius: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180; // 0deg = 12 o'clock, clockwise
  return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) };
}

function arcPath(startDeg: number, endDeg: number, radius: number): string {
  const s = pointAt(startDeg, radius);
  const e = pointAt(endDeg, radius);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

export default function ZoneRing({
  standings, zones, teamStyle,
}: {
  standings: Standing[];
  zones: Zone[];
  teamStyle: TeamStyle;
}) {
  const n = standings.length;
  if (n === 0) return null;
  const step = 360 / n;
  const bands = toBands(standings, zones).filter((b) => b.kind !== 'mid');

  return (
    <svg className="lld lzr" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="League table ring">
      <circle cx={CX} cy={CY} r={R_CREST} fill="none" stroke="var(--hairline)" strokeWidth={1} />

      {bands.map((b) => {
        // A rank occupies the slice centred on its own angle, so the arc spans
        // from the leading edge of the first club to the trailing edge of the
        // last — not centre-to-centre, which would visibly under-cover.
        const start = (b.from - 1) * step - step / 2;
        const end = (b.to - 1) * step + step / 2;
        return (
          <g key={`${b.kind}-${b.from}`}>
            <path
              d={arcPath(start, end, R_ARC)}
              fill="none"
              stroke={`var(${ZONE_VAR[b.kind]})`}
              strokeWidth={9}
              strokeLinecap="round"
              opacity={0.26}
            />
            <path
              d={arcPath(start, end, R_ARC)}
              fill="none"
              stroke={`var(${ZONE_VAR[b.kind]})`}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          </g>
        );
      })}

      {standings.map((s, i) => {
        const p = pointAt(i * step, R_CREST);
        const zone = bands.find((b) => s.rank >= b.from && s.rank <= b.to);
        const stroke = zone ? `var(${ZONE_VAR[zone.kind]})` : 'var(--hairline)';
        const src = teamStyle === 'crest' ? s.team.crestUrl : s.team.crestUrl;
        const clip = `lzr-clip-${s.team.id}`;
        return (
          <g key={s.team.id}>
            <circle cx={p.x} cy={p.y} r={15} fill="#f4f4f6" stroke={stroke} strokeWidth={zone ? 2 : 1} />
            {src ? (
              <>
                <defs>
                  <clipPath id={clip}>
                    <circle cx={p.x} cy={p.y} r={15} />
                  </clipPath>
                </defs>
                <image
                  href={src}
                  x={p.x - 15}
                  y={p.y - 15}
                  width={30}
                  height={30}
                  clipPath={`url(#${clip})`}
                  preserveAspectRatio="xMidYMid slice"
                />
              </>
            ) : (
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#111">
                {s.team.abbr}
              </text>
            )}
          </g>
        );
      })}

      <circle cx={CX} cy={CY} r={62} fill="var(--surface-2)" stroke="var(--hairline)" />
      <text x={CX} y={CY - 6} textAnchor="middle" fontSize={13} fill="var(--text-muted)">
        {n} clubs
      </text>
      <text x={CX} y={CY + 16} textAnchor="middle" fontSize={13} fill="var(--text-muted)">
        {standings[0]?.played ?? 0} played
      </text>
    </svg>
  );
}
