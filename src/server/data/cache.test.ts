import { describe, it, expect } from 'vitest';
import { TtlCache } from './cache';

describe('TtlCache', () => {
  it('returns a value before it expires', () => {
    let t = 0;
    const c = new TtlCache<number>(() => t);
    c.set('k', 42, 100);
    t = 50;
    expect(c.get('k')).toBe(42);
  });

  it('returns undefined after expiry', () => {
    let t = 0;
    const c = new TtlCache<number>(() => t);
    c.set('k', 42, 100);
    t = 150;
    expect(c.get('k')).toBeUndefined();
  });

  it('returns undefined for an unknown key', () => {
    const c = new TtlCache<number>(() => 0);
    expect(c.get('missing')).toBeUndefined();
  });

  it('returns a value when now() equals expires (boundary)', () => {
    let t = 0;
    const c = new TtlCache<number>(() => t);
    c.set('k', 42, 100);
    t = 100; // expires = 0 + 100 = 100; now() === expires → NOT expired (impl uses >)
    expect(c.get('k')).toBe(42);
  });

  it('evicts the least recently used entry at its capacity', () => {
    const c = new TtlCache<number>(() => 0, 2);
    c.set('oldest', 1, 100);
    c.set('recent', 2, 100);
    expect(c.get('oldest')).toBe(1);

    c.set('new', 3, 100);

    expect(c.get('recent')).toBeUndefined();
    expect(c.get('oldest')).toBe(1);
    expect(c.get('new')).toBe(3);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new TtlCache<number>(() => 0, 0)).toThrow('positive integer');
  });
});
