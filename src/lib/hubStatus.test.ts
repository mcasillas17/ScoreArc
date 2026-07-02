import { describe, it, expect } from 'vitest';
import { hubStatus } from './hubStatus';
import type { Match } from '@/server/data/types';

const m = (state: Match['state']): Match =>
  ({ state } as Match);

describe('hubStatus', () => {
  it('is live when any match is live', () => {
    expect(hubStatus([m('scheduled'), m('live'), m('finished')])).toBe('live');
  });
  it('is upcoming when every match is scheduled and not started', () => {
    expect(hubStatus([m('scheduled'), m('scheduled')])).toBe('upcoming');
  });
  it('is ongoing when scheduled fixtures but the tournament has started', () => {
    // e.g. World Cup mid-knockout: next fixtures scheduled, but bracket is decided
    expect(hubStatus([m('scheduled'), m('scheduled')], true)).toBe('ongoing');
  });
  it('still reports live over started', () => {
    expect(hubStatus([m('live'), m('scheduled')], true)).toBe('live');
  });
  it('is ongoing otherwise (some finished, none live)', () => {
    expect(hubStatus([m('finished'), m('scheduled')])).toBe('ongoing');
    expect(hubStatus([])).toBe('ongoing');
  });
});
