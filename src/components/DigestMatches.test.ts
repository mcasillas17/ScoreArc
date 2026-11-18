import { describe, expect, it } from 'vitest';
import type { LiveEntry } from '@/server/data/liveFeed';
import { isLead } from './DigestMatches';

const entry = (state: string) => ({ match: { state } }) as unknown as LiveEntry;

describe('isLead', () => {
  it('leads with the first match only when the second is not live', () => {
    const entries = [entry('live'), entry('scheduled')];
    expect(entries.map((e) => isLead(entries, e))).toEqual([true, false]);
  });

  it('leads with two live matches, and no more than two', () => {
    const entries = [entry('live'), entry('live'), entry('live')];
    expect(entries.map((e) => isLead(entries, e))).toEqual([true, true, false]);
  });
});
