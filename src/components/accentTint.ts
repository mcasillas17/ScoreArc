/**
 * The radial bracket's gold is not one color but a hand-tuned family of ~14
 * hexes (glows, gradients, winner rings, pings). A competition that wants its
 * own accent — Liga MX in Mexican green — should keep all of that tuning, so
 * instead of re-picking every slot we rotate the whole family's hue toward the
 * accent and leave each slot's saturation and lightness alone.
 */

// The family's reference member: the trophy-gradient mid gold. Hue deltas are
// measured from here.
const GOLD_BASE_HUE = 46;

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toByte = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * A tint function for one accent. No accent (or a malformed one) returns the
 * identity, so the default bracket renders its exact original golds — not a
 * round-tripped approximation of them.
 */
export function accentTint(accent?: string): (hex: string) => string {
  if (!accent) return (hex) => hex;
  const target = hexToHsl(accent);
  if (!target || target.s === 0) return (hex) => hex;
  const delta = target.h - GOLD_BASE_HUE;
  const cache = new Map<string, string>();
  return (hex) => {
    const hit = cache.get(hex);
    if (hit) return hit;
    const hsl = hexToHsl(hex);
    // Neutral slots (pure greys) have no hue to rotate; pass them through.
    const out = !hsl || hsl.s === 0 ? hex : hslToHex(hsl.h + delta, hsl.s, hsl.l);
    cache.set(hex, out);
    return out;
  };
}
