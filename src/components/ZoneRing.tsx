'use client';

import { useId } from 'react';
import type { Standing } from '@/server/data/types';
import type { TeamStyle, Zone } from '@/server/data/competitions';
import { toBands, ZONE_VAR, DASHED_KINDS } from './zoneBands';
import { flagUrl } from '@/lib/flags';
import { useLanguage } from './LanguageProvider';

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

// Clubs in the same table can have played different numbers of matches — MLS
// runs 17-19 mid-season — so quoting the leader's count alone misreports the
// league. Show the range when it is not uniform.
function playedLabel(standings: Standing[]): string {
  const counts = standings.map((s) => s.played);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return lo === hi ? `${hi} played` : `${lo}\u2013${hi} played`;
}

export default function ZoneRing({
  standings, zones, teamStyle,
}: {
  standings: Standing[];
  zones: Zone[];
  teamStyle: TeamStyle;
}) {
  const { language } = useLanguage();
  const spanish = language === 'es';
  // SVG ids are document-global. A club can appear in more than one ring on the
  // same page — MLS draws every club twice, once in its conference and once in
  // the league-wide Supporters' Shield ring — so a clip path keyed on team id
  // alone collides, and the second ring's crests get clipped to the first
  // ring's geometry and vanish. Namespace them per ring instance.
  // useId's value contains colons; strip them so the id is a plain token in
  // `url(#...)`.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const n = standings.length;
  if (n === 0) return null;
  const step = 360 / n;
  const bands = toBands(standings, zones).filter((b) => b.kind !== 'mid');

  return (
    <svg className="lld lzr" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={spanish ? 'Anillo de clasificación' : 'League table ring'}>
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
              className={DASHED_KINDS.has(b.kind) ? 'lzr-dashed' : undefined}
            />
          </g>
        );
      })}

      {standings.map((s, i) => {
        const p = pointAt(i * step, R_CREST);
        const zone = bands.find((b) => s.rank >= b.from && s.rank <= b.to);
        const stroke = zone ? `var(${ZONE_VAR[zone.kind]})` : 'var(--hairline)';
        // Both branches used to read crestUrl, so a flag competition silently
        // fell back to a crest it does not have. Flags win for national sides.
        const src = teamStyle === 'flag' ? (flagUrl(s.team.abbr) ?? s.team.crestUrl) : s.team.crestUrl;
        const clip = `lzr-clip-${uid}-${s.team.id}`;
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
        {playedLabel(standings)}
      </text>
    </svg>
  );
}
