import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store', async (orig) => {
  const mod = (await orig()) as typeof import('./store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

import { dataStore, type DataStore } from './store';
import { resolveSeason } from './competitions';
import { competitionTeams, allTeams } from './teamIndex';


const AMERICA = { id: '227', name: 'América', abbr: 'AME', crestUrl: null };
const ATLAS = { id: '216', name: 'Atlas', abbr: 'ATL', crestUrl: null };
// Not in teams.seed.json, so it has no canonical id and therefore no page.
const UNCURATED = { id: '999999', name: 'Somebody FC', abbr: 'SFC', crestUrl: null };

describe('competitionTeams', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('links each curated knockout entrant to this edition, once', async () => {
    const nwsl = resolveSeason('nwsl', '2026')!;
    const rc = { ...nwsl, season: { ...nwsl.season, resources: nwsl.season.resources!.filter(r => r !== 'standings') } };
    const gotham = { id: '15364', name: 'Gotham FC', abbr: 'GFC', crestUrl: null };
    const source = { getEditionTeams: async () => [gotham, { ...UNCURATED, crestUrl: null }, gotham] } as unknown as DataStore;
    const rows = await competitionTeams(rc, source);
    expect(rows.map(t => t.memberships[0].pathname)).toEqual(['/c/nwsl/2026/team/usa-w-gotham-fc']);
  });

  it('lists clubs alphabetically with a locale-neutral semantic pathname', async () => {
    vi.spyOn(dataStore, 'getEditionTeams').mockResolvedValue([ATLAS, AMERICA]);
    const teams = await competitionTeams(resolveSeason('liga-mx')!);
    expect(teams.map((t) => t.name)).toEqual(['América', 'Atlas']);
    expect(teams[0].id).toBe('mex-america');
    expect(teams[0].memberships[0].pathname).toBe(
      '/c/liga-mx/2026-apertura/team/mex-america',
    );
    expect(teams[0].memberships[0].pathname).not.toContain('/api/');
    expect(teams[0].memberships[0].pathname).not.toMatch(/^\/(?:en|es)\//);
  });

  // An uncurated club has no canonical id, so there is no page to send anyone
  // to. Listing it with a dead link is worse than not listing it.
  it('drops clubs the seed has not curated', async () => {
    vi.spyOn(dataStore, 'getEditionTeams').mockResolvedValue([AMERICA, UNCURATED]);
    const teams = await competitionTeams(resolveSeason('liga-mx')!);
    expect(teams.map((t) => t.name)).toEqual(['América']);
  });

  it('propagates unavailable membership instead of certifying an empty edition', async () => {
    vi.spyOn(dataStore, 'getEditionTeams').mockRejectedValue(new Error('502'));
    await expect(competitionTeams(resolveSeason('liga-mx')!)).rejects.toThrow('502');
  });

});

describe('allTeams', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('limits simultaneous edition reads across the current registry', async () => {
    let active = 0;
    let peak = 0;
    const read = vi.spyOn(dataStore, 'getEditionTeams').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return [AMERICA];
    });
    const teams = await allTeams();
    expect(read.mock.calls.length).toBeGreaterThan(4);
    expect(teams[0].memberships).toHaveLength(read.mock.calls.length);
    expect(peak).toBeLessThanOrEqual(4);
  });

  // The design decision this whole page rests on: a club is one identity with
  // one page per competition, because its record differs in each. Two entries
  // with the same name would make the reader pick blind.
  it('merges a club appearing in two competitions into one entry', async () => {
    vi.spyOn(dataStore, 'getEditionTeams').mockResolvedValue([AMERICA]);
    const teams = await allTeams();
    const america = teams.filter((t) => t.id === 'mex-america');
    expect(america).toHaveLength(1);
    expect(america[0].memberships.length).toBeGreaterThan(1);
    const pathnames = america[0].memberships.map((m) => m.pathname);
    expect(new Set(pathnames).size).toBe(pathnames.length);
  });
});
