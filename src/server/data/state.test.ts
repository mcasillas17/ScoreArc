import { describe, it, expect } from 'vitest';
import { mapState } from './state';

describe('mapState', () => {
  it('maps pre -> scheduled', () => expect(mapState('pre', false)).toBe('scheduled'));
  it('maps in -> live', () => expect(mapState('in', false)).toBe('live'));
  it('maps post -> finished', () => expect(mapState('post', true)).toBe('finished'));
  it('treats completed as finished even if state lags', () => expect(mapState('in', true)).toBe('finished'));
  it('maps post -> finished (post branch isolated)', () => expect(mapState('post', false)).toBe('finished'));
});
