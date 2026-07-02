import { describe, it, expect } from 'vitest';
import { hubStatus } from './hubStatus';
import type { Match } from '@/server/data/types';

const m = (state: Match['state']): Match =>
  ({ state } as Match);

describe('hubStatus', () => {
  it('is live when any match is live', () => {
    expect(hubStatus([m('scheduled'), m('live'), m('finished')])).toBe('live');
  });
  it('is upcoming when every match is scheduled', () => {
    expect(hubStatus([m('scheduled'), m('scheduled')])).toBe('upcoming');
  });
  it('is ongoing otherwise (some finished, none live)', () => {
    expect(hubStatus([m('finished'), m('scheduled')])).toBe('ongoing');
    expect(hubStatus([])).toBe('ongoing');
  });
});
