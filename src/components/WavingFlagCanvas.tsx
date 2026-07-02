'use client';

import { useEffect, useRef } from 'react';

// A real (pseudo-)3D waving flag: the flag texture is drawn in thin vertical
// slices, each shifted by a travelling sine wave, with per-slice light/shadow so
// the cloth appears to billow in 3D. Renders on a <canvas> at 60fps — works with
// a cross-origin flag image directly (we only draw it, never read pixels back).
export default function WavingFlagCanvas({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 380;
    const H = 252;
    canvas.width = W;
    canvas.height = H;

    const img = new Image();
    let ready = false;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const COLS = 220; // thin slices → smoother, more fluid cloth
    const colW = W / COLS;
    const amp = H * 0.05; // vertical wave height
    let t = reduce ? 0.6 : 0;
    let raf = 0;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      if (ready && img.width > 0) {
        const iw = img.width;
        const sw = iw / COLS;
        for (let i = 0; i < COLS; i++) {
          const phase = (i / COLS) * Math.PI * 3.2; // ~1.6 waves across
          // Two combined waves for a more organic billow.
          const wave = Math.sin(phase - t) + 0.4 * Math.sin(phase * 0.5 - t * 0.7);
          const dy = wave * amp;
          const sx = i * sw;
          const dx = i * colW;
          // +1px overlap to avoid seams between slices
          ctx.drawImage(img, sx, 0, sw, img.height, dx, dy, colW + 1, H);

          // Light on the faces turning toward us, shadow on those turning away.
          const light = Math.cos(phase - t);
          if (light > 0) ctx.fillStyle = `rgba(255,255,255,${0.2 * light})`;
          else ctx.fillStyle = `rgba(0,0,0,${0.34 * -light})`;
          ctx.fillRect(dx, dy, colW + 1, H);
        }
      }
      if (!reduce) {
        t += 0.06;
        raf = requestAnimationFrame(draw);
      }
    };

    img.onload = () => {
      ready = true;
      if (reduce) draw(); // single static frame for reduced-motion
    };
    img.src = src;
    raf = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(raf);
  }, [src]);

  return <canvas ref={ref} className="champ-wave-flag" role="img" aria-label="Champion flag" />;
}
