import { describe, it, expect, vi } from 'vitest';
import { competitionPlayerIndex, withPlayerSlugs, withSummaryPlayerSlugs } from './playerIndex';
import { resolveSeason } from './competitions';
import { createSelectedDataStore } from './sourceSelection';
import { ReaderFailure } from './readerTransport';
import { StandingsStatsError } from './providers/espn-standings';
import type { DataStore } from './store';
import type { Group, MatchSummaryData, SquadPlayer, Team } from './types';

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

  // A missing measurement withholds the table, not the competition's clubs:
  // player pages and links keep working.
  it('builds from the clubs of a table rejected only for a missing stat', async () => {
    const store = {
      getStandings: async () => { throw new StandingsStatsError('invalid points', [team('222', 'QRO')]); },
      getSquad: async () => [player('297287', 'Alí Ávila')],
    } as unknown as DataStore;
    expect((await competitionPlayerIndex(rc, store)).byProvider.get('297287')).toBe('ali-avila');
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

function emptySummary(): MatchSummaryData {
  return {
    scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
    videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [],
  };
}

describe('withSummaryPlayerSlugs', () => {
  const store = fakeStore(groups, {
    '222': [player('297287', 'Alí Ávila')],
    '227': [],
  });

  it('preserves participation evidence while adding player links', async () => {
    const summary = {
      ...emptySummary(),
      lineups: {
        availability: 'partial' as const,
        home: { teamId: '222', formation: '', players: [] },
        away: { teamId: '227', formation: '', players: [] },
      },
    };
    const out = await withSummaryPlayerSlugs(rc, summary, store);
    expect(out.lineups).toMatchObject({ availability: 'partial', home: { teamId: '222' }, away: { teamId: '227' } });
  });

  it('resolves slugs for scorers and lineup players, null for strangers', async () => {
    const summary: MatchSummaryData = {
      ...emptySummary(),
      scorers: [
        { teamId: '222', player: 'Alí Ávila', minute: "10'", penalty: false, shootout: false, ownGoal: false, athleteId: '297287' },
        { teamId: '227', player: 'Unknown Loanee', minute: "20'", penalty: false, shootout: false, ownGoal: false, athleteId: '999999' },
      ],
      lineups: {
        home: {
          formation: '4-3-3',
          players: [{ name: 'Alí Ávila', number: 9, position: 'F', jersey: null, starter: true, stats: null, athleteId: '297287' }],
        },
        away: {
          formation: '4-3-3',
          players: [{ name: 'No Id', number: null, position: 'M', jersey: null, starter: true, stats: null, athleteId: null }],
        },
      },
    };
    const out = await withSummaryPlayerSlugs(rc, summary, store);
    expect(out.scorers[0].playerSlug).toBe('ali-avila');
    expect(out.scorers[1].playerSlug).toBeNull();
    expect(out.lineups!.home.players[0].playerSlug).toBe('ali-avila');
    expect(out.lineups!.away.players[0].playerSlug).toBeNull();
  });

  it('passes null lineups through unchanged', async () => {
    const summary: MatchSummaryData = { ...emptySummary(), lineups: null };
    const out = await withSummaryPlayerSlugs(rc, summary, store);
    expect(out.lineups).toBeNull();
  });

  it('returns the input unchanged when the index cannot build', async () => {
    const broken = { getStandings: async () => { throw new Error('502'); } } as unknown as DataStore;
    const summary: MatchSummaryData = {
      ...emptySummary(),
      scorers: [{ teamId: '222', player: 'Alí Ávila', minute: "10'", penalty: false, shootout: false, ownGoal: false, athleteId: '297287' }],
    };
    const out = await withSummaryPlayerSlugs(rc, summary, broken);
    expect(out).toEqual(summary);
  });
});


describe('player directory', () => {
  it('uses one roster per distinct team, keeps first roster context, and never loads profiles', async () => {
    const store = fakeStore([...groups, ...groups], {
      '222': [player('1', 'Alí Ávila'), player('2', 'Rodrigo López', 9)],
      '227': [player('1', 'Alí Ávila'), player('3', 'Rodrigo Lopez', 10)],
    });
    store.getSquad = vi.fn(store.getSquad);
    store.getPlayer = vi.fn();
    const index = await competitionPlayerIndex(rc, store);
    expect(index.directory).toEqual({ totalTeams: 2, teamsWithRoster: 2, players: [
      { name: 'Alí Ávila', slug: 'ali-avila', teamName: 'QRO', teamAbbr: 'QRO', teamId: '222', crestUrl: null },
      { name: 'Rodrigo López', slug: 'rodrigo-lopez-qro', teamName: 'QRO', teamAbbr: 'QRO', teamId: '222', crestUrl: null },
      { name: 'Rodrigo Lopez', slug: 'rodrigo-lopez-ame', teamName: 'AME', teamAbbr: 'AME', teamId: '227', crestUrl: null },
    ] });
    expect(store.getSquad).toHaveBeenCalledTimes(2);
    expect(store.getPlayer).not.toHaveBeenCalled();
    for (const row of index.directory.players) expect(index.bySlug.get(row.slug!)?.name).toBe(row.name);
  });

  it('reports partial roster coverage separately from an empty membership list', async () => {
    expect((await competitionPlayerIndex(rc, fakeStore(groups, { '222': [player('1', 'Alí')] }))).directory)
      .toMatchObject({ totalTeams: 2, teamsWithRoster: 1 });
    expect((await competitionPlayerIndex(rc, fakeStore(groups, {}))).directory)
      .toEqual({ totalTeams: 2, teamsWithRoster: 0, players: [] });
    expect((await competitionPlayerIndex(rc, fakeStore([], {}))).directory)
      .toEqual({ totalTeams: 0, teamsWithRoster: 0, players: [] });
  });

  it('keeps unresolved existing slug collisions visible without inventing a URL', async () => {
    const index = await competitionPlayerIndex(rc, fakeStore(groups, {
      '222': [player('1', 'Same Name'), player('2', 'Same Name')],
    }));
    expect(index.directory.players.map(row => row.slug)).toEqual([null, 'same-name-qro']);
    expect(index.byProvider.get('1')).toBeUndefined();
  });

  it('discards reader names, teams and collision links together when one roster fails', async () => {
    const reader = fakeStore(groups, { '222': [player('r', 'Reader Name')] });
    reader.getSquad = async (_rc, id) => {
      if (id === '227') throw new ReaderFailure('stale');
      return [player('r', 'Reader Name')];
    };
    const fallback = fakeStore([{ ...groups[0], standings: [groups[0].standings[1]] }], {
      '227': [player('e', 'ESPN Name')],
    });
    const onFallback = vi.fn();
    const selected = createSelectedDataStore({ source: 'reader', espn: fallback, reader: () => reader, onFallback });
    const index = await competitionPlayerIndex(rc, selected);
    expect(index.directory).toEqual({ totalTeams: 1, teamsWithRoster: 1, players: [
      { name: 'ESPN Name', slug: 'espn-name', teamName: 'AME', teamAbbr: 'AME', teamId: '227', crestUrl: null },
    ] });
    expect([...index.bySlug.keys()]).toEqual(['espn-name']);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it.each(['standings', 'squad'])('propagates exhausted %s failures instead of returning an empty directory', async failure => {
    const reader = fakeStore(groups, {});
    reader.getSquad = async () => { throw new ReaderFailure('network'); };
    const fallback = fakeStore(groups, {});
    if (failure === 'standings') fallback.getStandings = async () => { throw new Error('fallback unavailable'); };
    else fallback.getSquad = async () => { throw new Error('fallback unavailable'); };
    const selected = createSelectedDataStore({ source: 'reader', espn: fallback, reader: () => reader });
    await expect(competitionPlayerIndex(rc, selected)).rejects.toThrow('fallback unavailable');
  });

  it('forwards caller cancellation without starting a fallback', async () => {
    const controller = new AbortController();
    const onFallback = vi.fn();
    const source = createSelectedDataStore({ source: 'reader', espn: fakeStore([], {}), onFallback,
      reader: ({ signal }) => ({ ...fakeStore(groups, {}), getSquad: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort();
      }) }),
    });
    await expect(competitionPlayerIndex(rc, source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onFallback).not.toHaveBeenCalled();
  });
});
