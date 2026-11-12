/**
 * Gesture and layout maths for the dial navigation.
 *
 * Pure: no DOM, no React. The dial itself is positioned in CSS — each crest
 * carries its offset from the centre as `--k` and the stylesheet places it with
 * `rotate() translateX() rotate()` — so the only geometry that needs code is
 * turning a drag, a wheel tick or a scroll into a dial position.
 *
 * A dial position ("focus") is an index into the competition list. It is
 * fractional while a drag is in flight and an integer at rest.
 */

/** Radius of the competition rim, in px. Must match `--dial-r` in globals.css. */
export const DIAL_RADIUS = 300;
/** Degrees between neighbouring crests on the desktop rail. */
export const RAIL_STEP_DEG = 11;
/** Degrees between neighbouring crests on the phone wheel. */
export const WHEEL_STEP_DEG = 14;
/** Degrees between neighbouring sections on the phone wheel's inner rim. */
export const SECTION_STEP_DEG = 20;
/** Crests visible either side of the centre: collapsed rail, expanded rail, wheel. */
export const RAIL_REACH_COLLAPSED = 3;
export const RAIL_REACH_EXPANDED = 5;
export const WHEEL_REACH = 3;

/** Arc length between two neighbours: the drag distance that moves the dial by one. */
export function stepPx(radius: number, stepDeg: number): number {
  return (radius * stepDeg * Math.PI) / 180;
}

/** Keep a dial position on the list. */
export function clampFocus(focus: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, focus));
}

/** Where the dial rests: on the open competition, else the middle of the list. */
export function restingFocus(activeIndex: number, count: number): number {
  if (activeIndex >= 0) return clampFocus(activeIndex, count);
  return Math.max(0, Math.floor((count - 1) / 2));
}

/**
 * The dial position after dragging `deltaPx` along the rim from `startFocus`.
 *
 * Dragging toward the end of the rim (down on the rail, right on the wheel)
 * pulls earlier competitions to the centre, so the position decreases.
 */
export function dragFocus(
  startFocus: number,
  deltaPx: number,
  pxPerStep: number,
  count: number,
): number {
  return clampFocus(startFocus - deltaPx / pxPerStep, count);
}

/** The resting position nearest to wherever a drag let go. */
export function snapFocus(focus: number, count: number): number {
  return clampFocus(Math.round(focus), count);
}

/** Whether a crest is on the visible part of the rim. */
export function isOnRim(index: number, focus: number, reach: number): boolean {
  return Math.abs(index - focus) <= reach + 0.5;
}

/**
 * Split the phone bar's items around its centre button. An odd one out goes on
 * the left, so three items read as two, the button, one.
 */
export function splitAround<T>(items: readonly T[]): [T[], T[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

/** The angle of item `index` of `count`, fanned symmetrically about the top. */
export function fanAngle(index: number, count: number, stepDeg: number): number {
  return (index - (count - 1) / 2) * stepDeg;
}

/** Scroll distance, in px, that counts as a deliberate change of direction. */
export const SCROLL_INTENT_PX = 8;
/** Above this scroll position the bar never shrinks. */
const SHRINK_AFTER_PX = 80;

/**
 * Whether the phone bar should be shrunk after scrolling from `lastY` to `y`.
 *
 * Small movements keep the previous state, so a resting thumb does not make the
 * bar flicker.
 */
export function nextShrunk(prev: boolean, lastY: number, y: number): boolean {
  if (y < SHRINK_AFTER_PX) return false;
  const delta = y - lastY;
  if (delta > SCROLL_INTENT_PX) return true;
  if (delta < -SCROLL_INTENT_PX) return false;
  return prev;
}
