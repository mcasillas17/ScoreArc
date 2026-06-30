import { describe, it, expect } from 'vitest';
import scoreboard from './espn-scoreboard.json';
import standings from './espn-standings.json';

describe('recorded fixtures', () => {
  it('scoreboard has events for fifa.world season 2026', () => {
    expect(scoreboard.leagues[0].slug).toBe('fifa.world');
    expect(scoreboard.leagues[0].season.year).toBe(2026);
    expect(Array.isArray(scoreboard.events)).toBe(true);
  });
  it('standings has 12 groups', () => {
    expect(standings.children).toHaveLength(12);
  });
});
