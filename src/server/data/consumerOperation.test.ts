import { describe, expect, it } from 'vitest';
import { createDataStore, type DataStore } from './store';
import { TtlCache } from './cache';
import { resolveSeason } from './competitions';
import { createSelectedDataStore } from './sourceSelection';
import { ReaderFailure } from './readerTransport';
import { competitionPlayerIndex, loadPlayerBySlug, loadLeadersWithSlugs, loadMatchSummaryWithSlugs } from './playerIndex';
import { loadStandingsForm } from './standingsForm';
import { getBannerFeed } from './banner';
import type { Group, Match, MatchSummaryData, PlayerProfile, SquadPlayer, StatLeader } from './types';

const rc = resolveSeason('laliga', '2026-27')!;
const now = new Date('2026-10-30T12:00:00Z');
const team = (id: string) => ({ id, name: `Team ${id}`, abbr: id, crestUrl: null });
const groups = (played = 1): Group[] => [{ id: 'table', name: 'Table', standings: ['a', 'b'].map((id, i) => ({
  team: team(id), rank: i + 1, played, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0,
  goalDifference: 0, points: 0, advanced: false,
})) }];
const player = (id: string, name: string): SquadPlayer => ({ id, name, jersey: 1, position: '', age: null, nationality: null, headshotUrl: null, stats: null });
const match = (id: string, state: Match['state'] = 'finished'): Match => ({
  id, kickoff: '2026-10-20T12:00:00Z', state, minute: null, statusDetail: 'FT', statusName: 'STATUS_FULL_TIME',
  home: team('a'), away: team('b'), homeScore: 1, awayScore: 0, winnerId: null, note: null,
  scorers: [], cards: [], shootout: null, shootoutDetail: null, stats: null, winProbability: null,
});
function stub(methods: Partial<DataStore>): DataStore {
  return { ...createDataStore({ cache: new TtlCache(), fetchJson: async () => { throw new Error('unexpected read'); } }), ...methods };
}
function selected(reader: DataStore, espn: DataStore) {
  return createSelectedDataStore({ source: 'reader', reader: () => reader, espn, fallback: () => espn });
}

describe('source-bound frontend operations', () => {
  it('repeats both leader boards when their player index requires fallback', async () => {
    const leader = (name: string): StatLeader => ({ rank: 1, player: name, athleteId: '1', teamId: 'a',
      teamAbbr: 'a', teamName: 'Team a', teamCrestUrl: null, value: 2, matches: null });
    const source = selected(stub({
      getLeaders: async () => ({ scorers: [leader('Reader')], assists: [leader('Reader Assist')] }),
      getStandings: async () => { throw new ReaderFailure('stale'); },
    }), stub({
      getLeaders: async () => ({ scorers: [leader('ESPN')], assists: [leader('ESPN Assist')] }),
      getStandings: async () => groups(),
      getSquad: async (_rc, id) => id === 'a' ? [player('1', 'Linked Player')] : [],
    }));
    const boards = await loadLeadersWithSlugs(rc, source);
    expect(boards.scorers).toMatchObject([{ player: 'ESPN', playerSlug: 'linked-player' }]);
    expect(boards.assists).toMatchObject([{ player: 'ESPN Assist', playerSlug: 'linked-player' }]);
  });

  it('repeats a match summary after required reader slug-index evidence fails', async () => {
    const summary = (name: string): MatchSummaryData => ({
      scorers: [{ player: name, teamId: 'a', minute: '1', penalty: false, shootout: false, ownGoal: null, athleteId: '1' }],
      cards: [], stats: null, winProbability: null, lineups: null, videos: [], shootoutDetail: null,
      info: null, form: null, commentary: [], h2h: [],
    });
    const source = selected(stub({
      getMatchSummary: async () => summary('Reader'),
      getStandings: async () => { throw new ReaderFailure('stale'); },
    }), stub({
      getMatchSummary: async () => summary('ESPN'),
      getStandings: async () => groups(),
      getSquad: async (_rc, id) => id === 'a' ? [player('1', 'Linked Player')] : [],
    }));
    const result = await loadMatchSummaryWithSlugs(rc, 'event', 'a', 'b', source);
    expect(result.scorers).toMatchObject([{ player: 'ESPN', playerSlug: 'linked-player' }]);
  });

  it('cancels a pending reader slug join and repeats the summary within the operation deadline', async () => {
    const empty: MatchSummaryData = { scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
      videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [] };
    let cancelled = false;
    let fallbackReads = 0;
    const espn = stub({ getMatchSummary: async () => { fallbackReads++; return { ...empty, commentary: [{ minute: '', text: 'ESPN' }] }; },
      getStandings: async () => [] });
    const source = createSelectedDataStore({ source: 'reader', espn, readerTimeoutMs: 850, totalTimeoutMs: 2000,
      reader: ({ signal }) => stub({ getMatchSummary: async () => empty,
        getStandings: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          cancelled = true; reject(signal.reason);
        }, { once: true })),
      }),
    });
    const result = await loadMatchSummaryWithSlugs(rc, 'event', 'a', 'b', source);
    expect(result.commentary).toEqual([{ minute: '', text: 'ESPN' }]);
    expect(cancelled).toBe(true);
    expect(fallbackReads).toBe(1);
  });

  it('resolves a bookmarked player slug again before fallback profile lookup', async () => {
    const profile: PlayerProfile = { id: '2', name: 'Same Player', age: null, position: '', jersey: null,
      nationality: null, flagUrl: null, headshotUrl: null, team: null, seasonLabel: '', totals: [],
      gameLogLabel: '', gameLog: [], career: [] };
    const source = selected(stub({
      getStandings: async () => groups(),
      getSquad: async (_rc, id) => id === 'a' ? [player('1', 'Same Player')] : [],
      getPlayer: async () => { throw new ReaderFailure('network'); },
    }), stub({
      getStandings: async () => groups(),
      getSquad: async (_rc, id) => id === 'a' ? [player('2', 'Same Player')] : [],
      getPlayer: async (_rc, id) => id === '2' ? profile : null,
    }));
    expect(await loadPlayerBySlug(rc, 'same-player', source)).toEqual(profile);
  });

  it('rebuilds the whole player index after one parallel reader squad fails', async () => {
    let readerTables = 0;
    let espnTables = 0;
    const source = selected(stub({
      getStandings: async () => { readerTables += 1; return groups(); },
      getSquad: async (_rc, id) => { if (id === 'b') throw new ReaderFailure('stale'); return [player('1', 'Reader Player')]; },
    }), stub({
      getStandings: async () => { espnTables += 1; return groups(); },
      getSquad: async (_rc, id) => id === 'a' ? [player('2', 'ESPN Player')] : [],
    }));
    const index = await competitionPlayerIndex(rc, source);
    expect([...index.bySlug.keys()]).toEqual(['espn-player']);
    expect(readerTables).toBe(1);
    expect(espnTables).toBe(1);
  });

  it('restarts standings and every form window after a later reader window fails', async () => {
    let readerWindows = 0;
    let espnTables = 0;
    const source = selected(stub({
      getStandings: async () => groups(6),
      getFixtures: async () => { readerWindows += 1; if (readerWindows === 2) throw new ReaderFailure('network'); return [match('reader')]; },
    }), stub({
      getStandings: async () => { espnTables += 1; return groups(1); },
      getFixtures: async () => [match('espn')],
    }));
    const form = await loadStandingsForm(source, rc, undefined, now);
    expect(form.matches.map((item) => item.id)).toEqual(['espn']);
    expect(form.teams.a).toEqual({ status: 'available', results: [{ matchId: 'espn', result: 'W' }] });
    expect(espnTables).toBe(1);
  });

  it('reruns banner selection when its reader current-week read fails', async () => {
    let readerUpcoming = 0;
    const source = selected(stub({
      getMatches: async () => { throw new ReaderFailure('network'); },
      getUpcoming: async () => { readerUpcoming += 1; return [match('reader', 'scheduled')]; },
    }), stub({ getMatches: async () => [match('espn', 'scheduled')] }));
    expect(await getBannerFeed(rc, source)).toMatchObject({ weekOnly: true, matches: [{ id: 'espn' }] });
    expect(readerUpcoming).toBe(0);
  });

  it('preserves ESPN banner degradation when the current week fails', async () => {
    const espn = stub({ getMatches: async () => { throw new Error('offline'); }, getUpcoming: async () => [match('next', 'scheduled')] });
    expect(await getBannerFeed(rc, espn)).toMatchObject({ weekOnly: false, matches: [{ id: 'next' }] });
  });
});
