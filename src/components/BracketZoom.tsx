'use client';

import { useRef, useState } from 'react';

const MIN = 1;
const MAX = 4;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface View {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Pinch-to-zoom + drag-to-pan wrapper for the bracket (mostly for phones, where
 * the radial layout is otherwise tiny). Zoom buttons also work with a mouse.
 * At rest (scale 1) the page still scrolls vertically over it (touch-action:
 * pan-y); once zoomed, we own all touches so panning is smooth.
 */
export default function BracketZoom({ children }: { children: React.ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [smooth, setSmooth] = useState(false);
  // Mirror latest view so gesture/button handlers never read a stale closure.
  const viewRef = useRef(view);
  viewRef.current = view;
  const g = useRef<{
    mode?: 'pinch' | 'pan';
    startDist?: number;
    start?: View;
    mx?: number;
    my?: number;
    x?: number;
    y?: number;
  }>({});

  const clampT = (nx: number, ny: number, s: number): [number, number] => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return [nx, ny];
    return [clamp(nx, r.width * (1 - s), 0), clamp(ny, r.height * (1 - s), 0)];
  };

  // Zoom `prev` toward a container-local point, keeping that point fixed.
  const zoomAt = (prev: View, target: number, px: number, py: number): View => {
    const s = clamp(target, MIN, MAX);
    const cx = (px - prev.tx) / prev.scale;
    const cy = (py - prev.ty) / prev.scale;
    const [tx, ty] = clampT(px - cx * s, py - cy * s, s);
    return { scale: s, tx, ty };
  };

  const zoomBtn = (factor: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    setSmooth(true);
    setView((prev) => zoomAt(prev, prev.scale * factor, r.width / 2, r.height / 2));
  };
  const reset = () => {
    setSmooth(true);
    setView({ scale: 1, tx: 0, ty: 0 });
  };

  type Pt = { clientX: number; clientY: number };
  const d2 = (a: Pt, b: Pt) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

  const onTouchStart = (e: React.TouchEvent) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    setSmooth(false);
    const v = viewRef.current;
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      g.current = {
        mode: 'pinch',
        startDist: d2(a, b),
        start: v,
        mx: (a.clientX + b.clientX) / 2 - r.left,
        my: (a.clientY + b.clientY) / 2 - r.top,
      };
    } else if (e.touches.length === 1 && v.scale > 1) {
      g.current = { mode: 'pan', start: v, x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      g.current = {};
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const gc = g.current;
    const s0 = gc.start;
    if (gc.mode === 'pinch' && s0 && e.touches.length === 2) {
      const s = clamp(s0.scale * (d2(e.touches[0], e.touches[1]) / (gc.startDist || 1)), MIN, MAX);
      const cx = ((gc.mx ?? 0) - s0.tx) / s0.scale;
      const cy = ((gc.my ?? 0) - s0.ty) / s0.scale;
      const [tx, ty] = clampT((gc.mx ?? 0) - cx * s, (gc.my ?? 0) - cy * s, s);
      setView({ scale: s, tx, ty });
    } else if (gc.mode === 'pan' && s0 && e.touches.length === 1) {
      const dx = e.touches[0].clientX - (gc.x ?? 0);
      const dy = e.touches[0].clientY - (gc.y ?? 0);
      const [tx, ty] = clampT(s0.tx + dx, s0.ty + dy, s0.scale);
      setView((prev) => ({ ...prev, tx, ty }));
    }
  };

  const onTouchEnd = () => {
    g.current = {};
  };

  const zoomed = view.scale > 1.01;

  return (
    <div className="bz-outer">
      <div
        ref={boxRef}
        className="bz-viewport"
        style={{ touchAction: zoomed ? 'none' : 'pan-y' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="bz-content"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            transition: smooth ? 'transform 0.2s ease' : 'none',
          }}
        >
          {children}
        </div>
      </div>

      <div className="bz-controls" aria-label="Bracket zoom">
        <button type="button" onClick={() => zoomBtn(1 / 1.4)} aria-label="Zoom out" disabled={!zoomed}>
          −
        </button>
        <button type="button" onClick={reset} aria-label="Reset zoom" disabled={!zoomed}>
          ⤢
        </button>
        <button type="button" onClick={() => zoomBtn(1.4)} aria-label="Zoom in" disabled={view.scale >= MAX}>
          +
        </button>
      </div>
    </div>
  );
}
