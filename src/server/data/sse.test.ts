import { describe, it, expect } from 'vitest';
import { formatSse } from './sse';

describe('formatSse', () => {
  it('formats an event with JSON data and a blank-line terminator', () => {
    const frame = formatSse('matches', [{ id: '1' }]);
    expect(frame).toBe('event: matches\ndata: [{"id":"1"}]\n\n');
  });
});
