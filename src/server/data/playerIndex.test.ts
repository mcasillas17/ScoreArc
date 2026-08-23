import { describe, it, expect } from 'vitest';
import { competitionPlayerIndex, withPlayerSlugs } from './playerIndex';
import { resolveSeason } from './competitions';
import type { DataStore } from './store';
import type { Group, SquadPlayer, Team } from './types';

const rc = resolveSeason('liga-mx')!;

function team(id: string, abbr: string): Team {
  return { id, name: abbr, abbr, crestUrl: null };
}

function player(id: string, name: string, jersey: number | null = null): SquadPlayer {
  return { id, name, jersey, position: 'F', age: null, nationality: null, headshotUrl: null, stats: null };
}

function fakeStore(groups: Group[], squads: Record<string, SquadPlayer[]>): DataStore {
  return {
    getStandings: async () => groups,
    getSquad: async (_rc: unknown, teamId: string) => squads[teamId] ?? [],
  } as unknown as DataStore;
}

const groups: Group[] = [
  {
    id: 'g', name: 'g',
    standings: [
      { team: team('222', 'QRO'), rank: 1 } as Group['standings'][number],
      { team: team('227', 'AME'), rank: 2 } as Group['standings'][number],
    ],
  } as Group,
];

describe('competitionPlayerIndex', () => {
  it('indexes every rostered player by slug and by provider id', async () => {
    const store = fakeStore(groups, {
      '222': [player('297287', 'Alí Ávila')],
      '227': [player('167905', 'Raúl Jiménez')],
    });
    const index = await competitionPlayerIndex(rc, store);
    expect(index.bySlug.get('ali-avila')!.providerId).toBe('297287');
    expect(index.byProvider.get('167905')).toBe('raul-jimenez');
  });

  it('applies the cross-team collision rule', async () => {
    const store = fakeStore(groups, {
      '222': [player('1', 'Rodrigo López')],
      '227': [player('2', 'Rodrigo Lopez')],
    });
    const index = await competitionPlayerIndex(rc, store);
    expect(index.bySlug.has('rodrigo-lopez')).toBe(false);
    expect(index.bySlug.get('rodrigo-lopez-qro')!.providerId).toBe('1');
    expect(index.bySlug.get('rodrigo-lopez-ame')!.providerId).toBe('2');
  });

  // MLS standings carry each club in two groups (conference + overall), so a
  // naive flatten indexes every roster twice and every player "collides with
  // himself" -- Messi came out as lionel-messi-mia-10. Duplicate teams and
  // duplicate athletes must both collapse before collision detection.
  it('does not self-collide a player whose team appears in two groups', async () => {
    const twoGroups: Group[] = [
      { id: 'east', name: 'east', standings: [{ team: team('222', 'QRO'), rank: 1 } as Group['standings'][number]] } as Group,
      { id: 'overall', name: 'overall', standings: [{ team: team('222', 'QRO'), rank: 1 } as Group['standings'][number]] } as Group,
    ];
    const store = fakeStore(twoGroups, { '222': [player('297287', 'Ali Avila', 9)] });
    const index = await competitionPlayerIndex(rc, store);
    expect(index.bySlug.get('ali-avila')!.providerId).toBe('297287');
    expect(index.bySlug.has('ali-avila-qro-9')).toBe(false);
  });

  it('survives a club with no roster', async () => {
    const store = fakeStore(groups, { '222': [player('297287', 'Ali Avila')] });
    const index = await competitionPlayerIndex(rc, store);
    expect(index.bySlug.size).toBe(1);
  });

  // An index built from zero teams is not knowledge that a player does not
  // exist -- the failure propagates so the route can answer 502, not 404.
  it('propagates a standings failure', async () => {
    const store = {
      getStandings: async () => { throw new Error('502'); },
    } as unknown as DataStore;
    await expect(competitionPlayerIndex(rc, store)).rejects.toThrow();
  });
});

describe('withPlayerSlugs', () => {
  const store = fakeStore(groups, {
    '222': [player('297287', 'Alí Ávila')],
    '227': [],
  });

  it('resolves slugs for known athletes and null for strangers', async () => {
    const leaders: { athleteId: string | null; player: string; playerSlug?: string | null }[] = [
      { athleteId: '297287', player: 'Alí Ávila' },
      { athleteId: '999999', player: 'Unknown Loanee' },
      { athleteId: null, player: 'No Id' },
    ];
    const out = await withPlayerSlugs(rc, leaders, store);
    expect(out[0].playerSlug).toBe('ali-avila');
    expect(out[1].playerSlug).toBeNull();
    expect(out[2].playerSlug).toBeNull();
  });

  it('returns the input unchanged when the index cannot build', async () => {
    const broken = { getStandings: async () => { throw new Error('502'); } } as unknown as DataStore;
    const leaders: { athleteId: string | null; playerSlug?: string | null }[] = [{ athleteId: '297287' }];
    const out = await withPlayerSlugs(rc, leaders, broken);
    expect(out).toEqual(leaders);
  });
});
