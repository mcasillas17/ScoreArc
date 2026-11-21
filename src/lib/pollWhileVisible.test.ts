// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollWhileVisible } from './pollWhileVisible';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('pollWhileVisible', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
  });

  it('ticks on the interval while the tab is visible', () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it('is silent while hidden and catches up once on return', () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000);
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops for good on cleanup', () => {
    const tick = vi.fn();
    pollWhileVisible(tick, 1000)();
    vi.advanceTimersByTime(5000);
    setHidden(false);
    expect(tick).not.toHaveBeenCalled();
  });
});
