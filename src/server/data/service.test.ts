import { describe, it, expect, vi } from 'vitest';
import { createDataService, SCOREBOARD_URL } from './service';
import { TtlCache } from './cache';
import scoreboard from './__fixtures__/espn-scoreboard.json';
import standings from './__fixtures__/espn-standings.json';
import bracket from './__fixtures__/espn-bracket.json';

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

  it('caches within TTL (one fetch for two calls)', async () => {
    const fetchJson = vi.fn(async () => scoreboard);
    const svc = createDataService({ fetchJson, cache: new TtlCache(() => 0) });
    await svc.getMatches();
    await svc.getMatches();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith(SCOREBOARD_URL);
  });

  it('getBracket returns 6 rounds from fixture', async () => {
    const svc = svcWith(async () => bracket);
    const rounds = await svc.getBracket();
    expect(rounds).toHaveLength(6);
  });
});
