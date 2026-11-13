'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  DIAL_RADIUS,
  RAIL_REACH_COLLAPSED,
  RAIL_STEP_DEG,
  WHEEL_STEP_DEG,
  dragFocus,
  isOnRim,
  snapFocus,
  stepPx,
  wrapOffset,
} from './dialModel';

/** Pointer travel, in px, past which a press is a drag and not a tap. */
const DRAG_SLOP_PX = 6;
/**
 * Run `fn` once, when the pointer `pointerId` is released or cancelled —
 * wherever that happens. A handler on the pressed element alone never hears a
 * release that lands outside it, and the press it recorded goes stale.
 */
export function onPointerRelease(pointerId: number, fn: (e: PointerEvent) => void): void {
  const done = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    window.removeEventListener('pointerup', done);
    window.removeEventListener('pointercancel', done);
    fn(e);
  };
  window.addEventListener('pointerup', done);
  window.addEventListener('pointercancel', done);
}

/** Wheel delta that turns the dial by one crest. */
const WHEEL_STEP = 60;

/** One crest on the rim. */
export interface DialItem {
  key: string;
  href: string;
  /** Shown beside or under the crest, and its accessible name. */
  label: string;
  mark: React.ReactNode;
  /** The page the reader is on. */
  current: boolean;
  /** Called when the crest is activated, before `onNavigate`. */
  onOpen?: () => void;
}

interface NavDialProps {
  items: DialItem[];
  /** Dial position; fractional mid-drag. */
  focus: number;
  onFocusChange: (focus: number) => void;
  variant: 'rail' | 'wheel';
  /** Crests visible either side of the centre. */
  reach: number;
  /** Called after a crest is activated. */
  onNavigate: () => void;
  /** Tooltip saying how the dial turns. */
  hint?: string;
}

/**
 * One rim of crests: competitions, or any other collection.
 *
 * Positioning is CSS: each slot carries its offset from the centre as `--k`,
 * measured the short way round — the dial is a ring.
 * Every item is a real link in list order whatever the dial position —
 * a crest off the visible rim is transparent, never removed — and focusing one
 * turns the dial to it.
 */
export default function NavDial({
  items,
  focus,
  onFocusChange,
  variant,
  reach,
  onNavigate,
  hint,
}: NavDialProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; focus: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const n = items.length;
  const step = variant === 'rail' ? RAIL_STEP_DEG : WHEEL_STEP_DEG;
  const along = (e: { clientX: number; clientY: number }) =>
    variant === 'rail' ? e.clientY : e.clientX;

  // The native wheel listener below is attached once; it reads the current
  // position through this.
  const latest = useRef({ focus, onFocusChange, n });
  // The position the slots were last painted at, to tell which of them a turn
  // of the dial has carried across the ring's seam.
  const shown = useRef(focus);
  useEffect(() => {
    latest.current = { focus, onFocusChange, n };
    shown.current = focus;
  });

  // React's onWheel is passive and cannot preventDefault, so the page would
  // scroll under the pointer while the dial turned.
  useEffect(() => {
    // The whole rail, not just the dial: the site links sit on top of the dial
    // and a wheel event over them never reaches it.
    const el = ref.current?.closest('nav');
    if (!el || variant !== 'rail') return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      // Not when the dial is not on screen: on a phone-width window `nav` is
      // the masthead, and the page must scroll under it. And never a pinch or
      // ctrl+wheel, which is the reader zooming.
      if (e.ctrlKey || ref.current?.offsetParent === null) return;
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

  // Idempotent, and safe to call from a handler created renders ago: it reads
  // the dial position through `latest`, not from the closure.
  const endDrag = (released: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    setDragging(false);
    const l = latest.current;
    l.onFocusChange(snapFocus(l.focus, l.n));
    if (!released) return;
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
      data-has-current={items.some((item) => item.current) ? '' : undefined}
      title={hint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { start: along(e), focus, moved: false };
        // The release is heard on the window: a press that slides off the rail
        // and lets go over the page must still end here.
        onPointerRelease(e.pointerId, (up) => endDrag(up.type === 'pointerup'));
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // Belt and braces for a release nothing reported (another window, a
        // lost capture): a pointer with no button down is not dragging.
        if (e.buttons === 0) {
          endDrag(false);
          return;
        }
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
      // Only the dial's own capture. A finger is captured by the crest it
      // lands on, and taking the capture over makes that crest report losing
      // it — which bubbles here and used to end the drag it had just begun.
      onLostPointerCapture={(e) => {
        if (e.target === e.currentTarget) endDrag(false);
      }}
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
        const at = links.indexOf(document.activeElement as HTMLAnchorElement);
        if (at < 0) return;
        e.preventDefault();
        // Round the ring, like the dial itself.
        links[(at + dir + links.length) % links.length].focus();
      }}
    >
      {items.map((item, i) => {
        const isActive = item.current;
        const k = wrapOffset(i, focus, n);
        return (
          <div
            key={item.key}
            className="sn-dial-slot"
            style={{ ['--k' as string]: k }}
            data-off={isOnRim(i, focus, reach, n) ? undefined : ''}
            data-far={variant === 'rail' && !isOnRim(i, focus, RAIL_REACH_COLLAPSED, n) ? '' : undefined}
            // How many crests out from the centre: the reach it takes to show
            // this one. A short window allows the rail less of it (CSS).
            data-ring={variant === 'rail' ? Math.max(0, Math.ceil(Math.abs(k) - 0.5)) : undefined}
            data-current={isActive ? '' : undefined}
            data-centre={snapFocus(focus, n) === i ? '' : undefined}
            // A crest that has just gone round the back of the ring: its offset
            // flipped sign, and animating that would sweep it across the rim.
            data-seam={Math.abs(k - wrapOffset(i, shown.current, n)) > n / 2 ? '' : undefined}
          >
            <Link
              href={item.href}
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
                item.onOpen?.();
                onNavigate();
              }}
            >
              <span className="sn-crest-mark">{item.mark}</span>
              <span className="sn-crest-name">{item.label}</span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
