import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Group } from './types';

vi.mock('./store', async (orig) => {
  const mod = (await orig()) as typeof import('./store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

import { dataStore } from './store';
import { resolveSeason } from './competitions';
import { competitionTeams, allTeams } from './teamIndex';

function group(...teams: Array<{ id: string; name: string; abbr: string }>): Group {
  return {
    id: 'A',
    name: 'Group A',
    standings: teams.map((team, i) => ({
      team: { ...team, crestUrl: null },
      rank: i + 1, played: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
    })),
  } as Group;
}

const AMERICA = { id: '227', name: 'América', abbr: 'AME' };
const ATLAS = { id: '216', name: 'Atlas', abbr: 'ATL' };
// Not in teams.seed.json, so it has no canonical id and therefore no page.
const UNCURATED = { id: '999999', name: 'Somebody FC', abbr: 'SFC' };

describe('competitionTeams', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists clubs alphabetically with a link to their page', async () => {
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([group(ATLAS, AMERICA)]);
    const teams = await competitionTeams(resolveSeason('liga-mx')!);
    expect(teams.map((t) => t.name)).toEqual(['América', 'Atlas']);
    expect(teams[0].id).toBe('mex-america');
    expect(teams[0].memberships[0].href).toContain('/team/mex-america');
  });

  // An uncurated club has no canonical id, so there is no page to send anyone
  // to. Listing it with a dead link is worse than not listing it.
  it('drops clubs the seed has not curated', async () => {
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([group(AMERICA, UNCURATED)]);
    const teams = await competitionTeams(resolveSeason('liga-mx')!);
    expect(teams.map((t) => t.name)).toEqual(['América']);
  });

  // One competition's table being unavailable must not empty the index that
  // merges across all of them.
  it('returns [] rather than throwing when standings fail', async () => {
    vi.spyOn(dataStore, 'getStandings').mockRejectedValue(new Error('502'));
    expect(await competitionTeams(resolveSeason('liga-mx')!)).toEqual([]);
  });
});

describe('allTeams', () => {
  beforeEach(() => vi.restoreAllMocks());

  // The design decision this whole page rests on: a club is one identity with
  // one page per competition, because its record differs in each. Two entries
  // with the same name would make the reader pick blind.
  it('merges a club appearing in two competitions into one entry', async () => {
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([group(AMERICA)]);
    const teams = await allTeams();
    const america = teams.filter((t) => t.id === 'mex-america');
    expect(america).toHaveLength(1);
    expect(america[0].memberships.length).toBeGreaterThan(1);
    const hrefs = america[0].memberships.map((m) => m.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
