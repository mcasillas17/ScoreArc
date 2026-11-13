'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  RAIL_REACH_COLLAPSED,
  RAIL_STEP_DEG,
  WHEEL_STEP_DEG,
  dragFocus,
  isOnRim,
  glideDecay,
  snapFocus,
  wrapFocus,
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

/** A release counts as a flick only if the pointer was still moving this recently. */
const FLICK_WINDOW_MS = 100;
/** Slowest flick that glides, fastest one allowed, and where a glide stops: crests per ms. */
const GLIDE_MIN = 0.0015;
const GLIDE_MAX = 0.015;
const GLIDE_STOP = 0.0006;
/** Set once the reader has turned a dial; until then it shows them that it turns. */
const TURNED_KEY = 'sn-dial-turned';

/** Wheel delta that turns the dial by one crest. */
const WHEEL_STEP = 60;

/** One crest on the rim. */
export interface DialItem {
  key: string;
  href: string;
  /** Shown beside or under the crest, and its accessible name. */
  label: string;
  /**
   * Where the crest leads when that is not the thing it pictures ("Liga MX
   * news"). Its accessible name, and what the crest at the centre is called.
   */
  full?: string;
  /** A small mark on the crest's corner saying the same at a glance. */
  badge?: React.ReactNode;
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
  // `angle` is the pointer's bearing from the dial's centre and `turned` the
  // degrees it has swept since the press; `trail` is the last moments of that,
  // for the speed it is let go at.
  const drag = useRef<{
    x: number;
    y: number;
    focus: number;
    moved: boolean;
    angle: number;
    turned: number;
    trail: { t: number; turned: number }[];
  } | null>(null);
  const glide = useRef(0);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const n = items.length;
  const step = variant === 'rail' ? RAIL_STEP_DEG : WHEEL_STEP_DEG;
  // The pointer's bearing from the centre of the dial, in degrees. The slots
  // are zero-size boxes laid out at that centre, so the first one says where
  // it is — whatever the breakpoint or the rail's width.
  const bearing = (e: { clientX: number; clientY: number }) => {
    const el = ref.current;
    const slot = el?.firstElementChild as HTMLElement | null;
    if (!el || !slot) return 0;
    const box = el.getBoundingClientRect();
    return (
      (Math.atan2(e.clientY - box.top - slot.offsetTop, e.clientX - box.left - slot.offsetLeft) * 180) /
      Math.PI
    );
  };
  // The reader has turned the dial: it need not show them again.
  const learned = () => {
    ref.current?.removeAttribute('data-nudge');
    try {
      localStorage.setItem(TURNED_KEY, '1');
    } catch {
      // Private window: the nudge plays again next time, which is harmless.
    }
  };

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

  // Until the reader has turned a dial once, it rocks on arrival to show that
  // it turns. Set on the element, not in state: the rail is server-rendered
  // and storage is only readable here.
  useEffect(() => {
    try {
      if (!localStorage.getItem(TURNED_KEY)) ref.current?.setAttribute('data-nudge', '');
    } catch {
      // No storage, no nudge.
    }
    return () => cancelAnimationFrame(glide.current);
  }, []);

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
      learned();
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
    const settle = (at: number) => {
      setDragging(false);
      const l = latest.current;
      l.onFocusChange(snapFocus(at, l.n));
    };
    // Let go while moving, the dial carries on and slows, as a wheel would.
    const now = performance.now();
    const trail = d.trail.filter((p) => now - p.t <= FLICK_WINDOW_MS);
    const [first, last] = [trail[0], trail[trail.length - 1]];
    let v = trail.length > 1 && last.t > first.t ? -(last.turned - first.turned) / step / (last.t - first.t) : 0;
    v = Math.max(-GLIDE_MAX, Math.min(GLIDE_MAX, v));
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!released || still || Math.abs(v) < GLIDE_MIN) {
      settle(latest.current.focus);
    } else {
      let at = latest.current.focus;
      let then = now;
      const tick = (t: number) => {
        const dt = Math.max(0, t - then);
        then = t;
        v = glideDecay(v, dt);
        at = wrapFocus(at + v * dt, latest.current.n);
        if (Math.abs(v) < GLIDE_STOP) {
          settle(at);
          return;
        }
        latest.current.onFocusChange(at);
        glide.current = requestAnimationFrame(tick);
      };
      glide.current = requestAnimationFrame(tick);
    }
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
      // The accent arc marks the rest position, so it shows only while the
      // current page is resting there: turned away, it was a stray green line.
      data-has-current={items[snapFocus(focus, n)]?.current ? '' : undefined}
      title={hint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // A press stops a glide where it is.
        cancelAnimationFrame(glide.current);
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          focus,
          moved: false,
          angle: bearing(e),
          turned: 0,
          trail: [],
        };
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
        if (!d.moved) {
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= DRAG_SLOP_PX) return;
          d.moved = true;
          setDragging(true);
          learned();
          // Captured only once it is a drag: capturing on pointerdown would
          // retarget the click of a plain tap away from the link.
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        // Round the centre, not along an axis: the crest under the finger
        // stays under it wherever on the rim the finger is. Summed a move at a
        // time, the short way, so the bearing's ±180° seam is never crossed.
        const angle = bearing(e);
        d.turned += wrapOffset(angle, d.angle, 360);
        d.angle = angle;
        const now = performance.now();
        d.trail.push({ t: now, turned: d.turned });
        if (d.trail.length > 8) d.trail.shift();
        onFocusChange(dragFocus(d.focus, d.turned, step, n));
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
              aria-label={item.full}
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
              {item.badge && <span className="sn-crest-badge">{item.badge}</span>}
              <span className="sn-crest-name">
                {item.full ? (
                  <>
                    <span className="sn-crest-short">{item.label}</span>
                    <span className="sn-crest-full">{item.full}</span>
                  </>
                ) : (
                  item.label
                )}
              </span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
