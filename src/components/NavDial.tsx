'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Competition, CompetitionSeason } from '@/server/data/competitions';
import { trackEvent } from '@/lib/telemetry/client';
import CompetitionMark from './CompetitionMark';
import { competitionHref, competitionSeasonId } from './SiteNav';
import {
  DIAL_RADIUS,
  RAIL_REACH_COLLAPSED,
  RAIL_STEP_DEG,
  WHEEL_STEP_DEG,
  dragFocus,
  isOnRim,
  snapFocus,
  stepPx,
} from './dialModel';

/** Pointer travel, in px, past which a press is a drag and not a tap. */
const DRAG_SLOP_PX = 6;
/** Wheel delta that turns the dial by one crest. */
const WHEEL_STEP = 60;

interface NavDialProps {
  competitions: Competition[];
  active: CompetitionSeason | undefined;
  /** Dial position; fractional mid-drag. */
  focus: number;
  onFocusChange: (focus: number) => void;
  variant: 'rail' | 'wheel';
  /** Crests visible either side of the centre. */
  reach: number;
  prefix: string;
  /** Called after a competition link is activated. */
  onNavigate: () => void;
  /** Tooltip saying how the dial turns. */
  hint?: string;
}

/**
 * One rim of competition crests.
 *
 * Positioning is CSS: each slot carries its offset from the centre as `--k`.
 * Every competition is a real link in list order whatever the dial position —
 * a crest off the visible rim is transparent, never removed — and focusing one
 * turns the dial to it.
 */
export default function NavDial({
  competitions,
  active,
  focus,
  onFocusChange,
  variant,
  reach,
  prefix,
  onNavigate,
  hint,
}: NavDialProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; focus: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const n = competitions.length;
  const step = variant === 'rail' ? RAIL_STEP_DEG : WHEEL_STEP_DEG;
  const along = (e: { clientX: number; clientY: number }) =>
    variant === 'rail' ? e.clientY : e.clientX;

  // The native wheel listener below is attached once; it reads the current
  // position through this.
  const latest = useRef({ focus, onFocusChange, n });
  useEffect(() => {
    latest.current = { focus, onFocusChange, n };
  });

  // React's onWheel is passive and cannot preventDefault, so the page would
  // scroll under the pointer while the dial turned.
  useEffect(() => {
    const el = ref.current;
    if (!el || variant !== 'rail') return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      acc += e.deltaY;
      const steps = Math.trunc(acc / WHEEL_STEP);
      if (!steps) return;
      acc -= steps * WHEEL_STEP;
      const l = latest.current;
      l.onFocusChange(snapFocus(l.focus + steps, l.n));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [variant]);

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    setDragging(false);
    onFocusChange(snapFocus(focus, n));
    // A drag never navigates. The click, if one follows, is dispatched in this
    // same turn, so the flag cannot outlive it and eat a later real click.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
  };

  return (
    <div
      ref={ref}
      className={`sn-dial sn-dial--${variant}${dragging ? ' sn-dial--dragging' : ''}`}
      data-has-current={active ? '' : undefined}
      title={hint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { start: along(e), focus, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const delta = along(e) - d.start;
        if (!d.moved) {
          if (Math.abs(delta) <= DRAG_SLOP_PX) return;
          d.moved = true;
          setDragging(true);
          // Captured only once it is a drag: capturing on pointerdown would
          // retarget the click of a plain tap away from the link.
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        onFocusChange(dragFocus(d.focus, delta, stepPx(DIAL_RADIUS, step), n));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      // A mouse drag that starts on a link would otherwise start the browser's
      // own link drag and the pointer events would stop.
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const dir =
          e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1
          : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
          : 0;
        if (!dir) return;
        const links = Array.from(ref.current?.querySelectorAll<HTMLAnchorElement>('a.sn-crest') ?? []);
        const next = links[links.indexOf(document.activeElement as HTMLAnchorElement) + dir];
        if (!next) return;
        e.preventDefault();
        next.focus();
      }}
    >
      {competitions.map((c, i) => {
        const isActive = active?.competition.id === c.id;
        const seasonId = competitionSeasonId(c, active);
        return (
          <div
            key={c.id}
            className="sn-dial-slot"
            style={{ ['--k' as string]: i - focus }}
            data-off={isOnRim(i, focus, reach) ? undefined : ''}
            data-far={variant === 'rail' && !isOnRim(i, focus, RAIL_REACH_COLLAPSED) ? '' : undefined}
            data-current={isActive ? '' : undefined}
            data-centre={Math.round(focus) === i ? '' : undefined}
          >
            <Link
              href={competitionHref(c, active, prefix)}
              className="sn-crest"
              aria-current={isActive ? 'true' : undefined}
              draggable={false}
              // Tabbing turns the dial to the crest. Not while a pointer is
              // down: turning it under a press would move the crest out from
              // under the click that is about to land on it.
              onFocus={() => {
                if (!drag.current) onFocusChange(i);
              }}
              onClick={() => {
                trackEvent('Competition opened', { competition: c.id, season: seasonId, source: 'sitenav' });
                onNavigate();
              }}
            >
              <span className="sn-crest-mark">
                <CompetitionMark
                  logo={c.logo}
                  logoInvert={c.logoInvert}
                  emblem={c.emblem}
                  name={c.name}
                  size={isActive ? 30 : 22}
                />
              </span>
              <span className="sn-crest-name">{c.shortName}</span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
