import { describe, it, expect, vi } from 'vitest';
import { createDataService, SCOREBOARD_URL } from './service';
import { TtlCache } from './cache';
import scoreboard from './__fixtures__/espn-scoreboard.json';
import standings from './__fixtures__/espn-standings.json';
import bracket from './__fixtures__/espn-bracket.json';
import summary from './__fixtures__/espn-summary.json';

function svcWith(fetchJson: (url: string) => Promise<unknown>) {
  return createDataService({ fetchJson, cache: new TtlCache(() => 0) });
}

describe('createDataService', () => {
  it('getMatches maps the scoreboard', async () => {
    const svc = svcWith(async () => scoreboard);
    const matches = await svc.getMatches();
    expect(matches.length).toBe((scoreboard as any).events.length);
  });

  it('getGroups maps the standings', async () => {
    const svc = svcWith(async () => standings);
    const groups = await svc.getGroups();
    expect(groups).toHaveLength(12);
  });

  it('caches within TTL (scoreboard fetched only once across two getMatches calls)', async () => {
    const fetchJson = vi.fn(async (_url: string) => scoreboard);
    const svc = createDataService({ fetchJson, cache: new TtlCache(() => 0) });
    await svc.getMatches();
    await svc.getMatches();
    // Second call is fully served from cache (no additional fetches).
    // The scoreboard URL itself must only be called once.
    expect(fetchJson).toHaveBeenCalledWith(SCOREBOARD_URL);
    const sbCalls = fetchJson.mock.calls.filter((c) => c[0] === SCOREBOARD_URL);
    expect(sbCalls).toHaveLength(1);
  });

  it('getBracket returns 6 rounds from fixture', async () => {
    const svc = svcWith(async () => bracket);
    const rounds = await svc.getBracket();
    expect(rounds).toHaveLength(6);
  });
});

describe('createDataService scorer enrichment', () => {
  it('getMatches attaches scorers to live/finished matches', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url === SCOREBOARD_URL) return scoreboard;
      // All summary URLs return the same fixture for test purposes
      return summary;
    });
    const svc = createDataService({ fetchJson, cache: new TtlCache() });
    const matches = await svc.getMatches();
    const enrichable = matches.filter(
      (m) => m.state === 'live' || m.state === 'finished'
    );
    expect(enrichable.length).toBeGreaterThan(0);
    // Every live/finished match has the scorers array populated
    expect(enrichable.every((m) => Array.isArray(m.scorers))).toBe(true);
    // At least one match has scorers (the summary fixture has 3 scoring events)
    expect(enrichable.some((m) => m.scorers.length > 0)).toBe(true);
  });

  it('getMatches does not throw when a summary fetch fails', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url === SCOREBOARD_URL) return scoreboard;
      throw new Error('summary unavailable');
    });
    const svc = createDataService({ fetchJson, cache: new TtlCache() });
    const matches = await svc.getMatches();
    // Should still return matches even if summary calls fail
    expect(matches.length).toBe((scoreboard as any).events.length);
    // Scorers default to empty array on failure
    expect(matches.every((m) => Array.isArray(m.scorers))).toBe(true);
  });

  it('getMatches parses penalty shootout from match note', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url === SCOREBOARD_URL) return scoreboard;
      return summary;
    });
    const svc = createDataService({ fetchJson, cache: new TtlCache() });
    const matches = await svc.getMatches();
    // The scoreboard fixture has "Paraguay advance 4-3 on penalties" (Paraguay = away, home = Germany)
    const penaltyMatch = matches.find((m) => m.note?.includes('on penalties'));
    expect(penaltyMatch).toBeDefined();
    expect(penaltyMatch!.shootout).not.toBeNull();
    // Paraguay (away) advanced with 4; Germany (home) scored 3
    expect(penaltyMatch!.shootout!.awayScore).toBe(4);
    expect(penaltyMatch!.shootout!.homeScore).toBe(3);
  });
});
