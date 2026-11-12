import { describe, expect, it } from 'vitest';
import {
  clampFocus,
  dragFocus,
  fanAngle,
  isOnRim,
  nextShrunk,
  restingFocus,
  snapFocus,
  splitAround,
  stepPx,
  wrapFocus,
  wrapOffset,
} from './dialModel';

describe('dialModel', () => {
  it('measures one step along the rim as an arc length', () => {
    expect(stepPx(300, 11)).toBeCloseTo(57.6, 1);
    expect(stepPx(300, 14)).toBeCloseTo(73.3, 1);
  });

  it('keeps a position on the list', () => {
    expect(clampFocus(-2, 11)).toBe(0);
    expect(clampFocus(4.4, 11)).toBe(4.4);
    expect(clampFocus(99, 11)).toBe(10);
    expect(clampFocus(3, 0)).toBe(0);
  });

  it('rests on the open competition, else the middle of the list', () => {
    expect(restingFocus(7, 11)).toBe(7);
    expect(restingFocus(-1, 11)).toBe(5);
    expect(restingFocus(-1, 10)).toBe(4);
    expect(restingFocus(-1, 0)).toBe(0);
  });

  it('moves toward earlier competitions when dragged toward the end of the rim', () => {
    expect(dragFocus(5, 115.2, 57.6, 11)).toBeCloseTo(3);
    expect(dragFocus(5, -57.6, 57.6, 11)).toBeCloseTo(6);
  });

  it('normalises a position onto the ring', () => {
    expect(wrapFocus(4.4, 11)).toBe(4.4);
    expect(wrapFocus(11, 11)).toBe(0);
    expect(wrapFocus(-1, 11)).toBe(10);
    expect(wrapFocus(25, 11)).toBe(3);
    expect(wrapFocus(3, 0)).toBe(0);
  });

  it('measures the short way round the ring', () => {
    expect(wrapOffset(7, 5, 11)).toBe(2);
    expect(wrapOffset(3, 5, 11)).toBe(-2);
    expect(wrapOffset(0, 10, 11)).toBe(1);
    expect(wrapOffset(10, 0, 11)).toBe(-1);
    expect(wrapOffset(5, 0, 11)).toBe(5);
    expect(wrapOffset(6, 0, 11)).toBe(-5);
    for (let i = 0; i < 11; i++) {
      expect(Math.abs(wrapOffset(i, 7.3, 11))).toBeLessThanOrEqual(5.5);
    }
  });

  // The reason the dial is a ring: Liga MX is last in the list, and a dial
  // that stopped there left the lower half of its rim empty.
  it('gives the last competition neighbours on both sides', () => {
    const offsets = Array.from({ length: 11 }, (_, i) => wrapOffset(i, 10, 11));
    expect(offsets.filter((k) => k < 0)).toHaveLength(5);
    expect(offsets.filter((k) => k > 0)).toHaveLength(5);
    expect(wrapOffset(9, 10, 11)).toBe(-1);
    expect(wrapOffset(0, 10, 11)).toBe(1);
    expect(isOnRim(0, 10, 3, 11)).toBe(true);
    expect(isOnRim(2, 10, 3, 11)).toBe(true);
    expect(isOnRim(3, 10, 3, 11)).toBe(false);
  });

  it('drags past either end and round to the other', () => {
    expect(dragFocus(1, 115.2, 57.6, 11)).toBeCloseTo(10);
    expect(dragFocus(9, -172.8, 57.6, 11)).toBeCloseTo(1);
    expect(dragFocus(0, 28.8, 57.6, 11)).toBeCloseTo(10.5);
  });

  it('snaps to the nearest crest, round the seam too', () => {
    expect(snapFocus(3.4, 11)).toBe(3);
    expect(snapFocus(3.6, 11)).toBe(4);
    expect(snapFocus(10.4, 11)).toBe(10);
    expect(snapFocus(10.6, 11)).toBe(0);
    expect(snapFocus(-1, 11)).toBe(10);
    expect(snapFocus(12, 11)).toBe(1);
  });

  it('knows which crests are on the visible rim', () => {
    expect(isOnRim(5, 5, 3, 11)).toBe(true);
    expect(isOnRim(8, 5, 3, 11)).toBe(true);
    expect(isOnRim(9, 5, 3, 11)).toBe(false);
    // Mid-drag, a crest entering the rim shows before it has fully arrived.
    expect(isOnRim(9, 5.6, 3, 11)).toBe(true);
  });

  it('splits bar items around the centre, the odd one on the left', () => {
    expect(splitAround(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
    expect(splitAround(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
    expect(splitAround([])).toEqual([[], []]);
  });

  it('fans items symmetrically about the top', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => fanAngle(i, 6, 20))).toEqual([-50, -30, -10, 10, 30, 50]);
    expect([0, 1, 2].map((i) => fanAngle(i, 3, 20))).toEqual([-20, 0, 20]);
    expect(fanAngle(0, 1, 20)).toBe(0);
  });

  it('shrinks the bar on a deliberate scroll down and restores it on the way up', () => {
    expect(nextShrunk(false, 200, 230)).toBe(true);
    expect(nextShrunk(true, 400, 370)).toBe(false);
  });

  it('ignores small scroll movements', () => {
    expect(nextShrunk(false, 200, 204)).toBe(false);
    expect(nextShrunk(true, 200, 197)).toBe(true);
  });

  it('never shrinks near the top of the page', () => {
    expect(nextShrunk(true, 0, 60)).toBe(false);
    expect(nextShrunk(false, 20, 79)).toBe(false);
  });
});
