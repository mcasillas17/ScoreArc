import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadStandingsForm, sharedStandingsForm, type StandingsForm } from './standingsForm';
import { resolveSeason, type CompetitionSeason } from './competitions';
import { createDataStore } from './store';
import { TtlCache } from './cache';
import type { Group, Match, Standing, Team } from './types';

const team = (id: string, name = `Team ${id}`): Team => ({ id, name, abbr: id.toUpperCase(), crestUrl: null });
const row = (id: string, played: number): Standing => ({ team: team(id), rank: 1, played, wins: 0, draws: 0,
  losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false });
const table = (id: string, ...rows: Standing[]): Group => ({ id, name: id, standings: rows });
function game(id: string, kickoff: string, home: string, away: string, homeScore: number | null = 1, awayScore: number | null = 0, extra: Partial<Match> = {}): Match {
  return { id, kickoff, state: 'finished', minute: null, statusDetail: 'FT', statusName: 'STATUS_FULL_TIME',
    home: team(home), away: team(away), homeScore, awayScore, winnerId: null, note: null, scorers: [], cards: [],
    shootout: null, shootoutDetail: null, stats: null, winProbability: null, ...extra };
}
/** A store that only serves matches inside the requested inclusive UTC range. */
function store(groups: Group[], matches: Match[]) {
  const getFixtures = vi.fn(async (_rc: CompetitionSeason, range: string, _signal?: AbortSignal) => {
    const from = Date.UTC(+range.slice(0, 4), +range.slice(4, 6) - 1, +range.slice(6, 8));
    const to = Date.UTC(+range.slice(9, 13), +range.slice(13, 15) - 1, +range.slice(15, 17)) + 86_400_000;
    return matches.filter((m) => Date.parse(m.kickoff) >= from && Date.parse(m.kickoff) < to);
  });
  const getStandings = vi.fn(async () => groups);
  return { getStandings, getFixtures };
}
const results = (form: StandingsForm, id: string) => {
  const entry = form.teams[id];
  return entry?.status === 'available' ? entry.results.map((r) => `${r.matchId}:${r.result}`) : entry?.status;
};
const laliga = resolveSeason('laliga', '2026-27')!;
const ligaMx = resolveSeason('liga-mx', '2026-apertura')!;
const mls = resolveSeason('mls', '2026')!;
const wc = resolveSeason('world-cup', '2026')!;
const leaguesCup = resolveSeason('leagues-cup', '2026')!;
const october = new Date('2026-10-30T12:00:00Z');

describe('standings form results', () => {
  it('derives home and away results, newest first, and keeps the actual sample below five', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 3), row('b', 3))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b', 2, 0),
      game('2', '2026-10-08T12:00:00Z', 'b', 'a', 2, 0),
      game('3', '2026-10-15T12:00:00Z', 'a', 'b', 1, 1),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toEqual(['3:D', '2:L', '1:W']);
    expect(results(form, 'b')).toEqual(['3:D', '2:W', '1:L']);
    expect(form.scope).toBe('season');
  });
  it('counts extra time and keeps a penalty tie a draw whatever winnerId and the shootout say', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 2), row('b', 2))], [
      game('aet', '2026-10-01T12:00:00Z', 'a', 'b', 3, 2, { statusName: 'STATUS_FINAL_AET' }),
      game('pen', '2026-10-08T12:00:00Z', 'a', 'b', 1, 1, { statusName: 'STATUS_FINAL_PEN', winnerId: 'a', shootout: { homeScore: 5, awayScore: 4 } }),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toEqual(['pen:D', 'aet:W']);
  });
  it('excludes live, scheduled, unplayed finals and malformed scores', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))], [
      game('ok', '2026-10-01T12:00:00Z', 'a', 'b'),
      game('live', '2026-10-20T12:00:00Z', 'a', 'b', 1, 0, { state: 'live', statusName: 'STATUS_FIRST_HALF' }),
      game('sched', '2026-10-21T12:00:00Z', 'a', 'b', null, null, { state: 'scheduled', statusName: 'STATUS_SCHEDULED' }),
      game('cancel', '2026-10-22T12:00:00Z', 'a', 'b', 0, 0, { statusName: 'STATUS_CANCELED' }),
      game('abandon', '2026-10-23T12:00:00Z', 'a', 'b', 1, 0, { statusName: 'STATUS_ABANDONED' }),
      game('forfeit', '2026-10-24T12:00:00Z', 'a', 'b', 3, 0, { statusName: 'STATUS_FORFEIT' }),
      game('null', '2026-10-25T12:00:00Z', 'a', 'b', null, 0),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toEqual(['ok:W']);
  });
  it('drops conflicting duplicates rather than choosing one', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 2), row('b', 2))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b', 1, 0),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 1, 0),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 0, 1),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toBe('unavailable');
  });
  it('follows team id, not display name, through a rename or a namesake', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 2), row('b', 2), row('c', 0))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b', 1, 0, { home: team('a', 'Old Name') }),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 1, 0, { home: team('a', 'New Name') }),
      game('3', '2026-10-15T12:00:00Z', 'b', 'x', 1, 0, { away: team('x', 'Team a') }),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toEqual(['2:W', '1:W']);
  });
  it('picks the newest five deterministically, breaking same-kickoff ties by id', async () => {
    const games = Array.from({ length: 7 }, (_, i) => game(`m${i}`, `2026-10-${String(i + 10)}T12:00:00Z`, 'a', 'b'));
    games.push(game('m9b', '2026-10-16T12:00:00Z', 'b', 'a'), game('m9a', '2026-10-16T12:00:00Z', 'a', 'b'));
    const form = await loadStandingsForm(store([table('t', row('a', 9), row('b', 9))], games.reverse()), laliga, undefined, october);
    const ids = (results(form, 'a') as string[]).map((r) => r.split(':')[0]);
    expect(ids).toEqual(['m6', 'm9a', 'm9b', 'm5', 'm4']);
  });
  it('sends each match once however many teams share it, unenriched and scoped', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))],
      [game('1', '2026-10-01T12:00:00Z', 'a', 'b')]), laliga, undefined, october);
    expect(form.matches.map((m) => m.id)).toEqual(['1']);
    expect(form.matches[0].scope).toEqual({ competitionId: 'laliga', seasonId: '2026-27' });
  });
  it('does not mutate cached store arrays', async () => {
    const shared = [game('1', '2026-10-01T12:00:00Z', 'a', 'b')];
    await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))], shared), laliga, undefined, october);
    expect(shared[0].scope).toBeUndefined();
  });
});

describe('standings form coverage', () => {
  it('reads nothing before kick-off and returns no form for a genuinely empty table', async () => {
    const s = store([table('t', row('a', 0), row('b', 0))], []);
    const form = await loadStandingsForm(s, laliga, undefined, october);
    expect(form.teams).toEqual({});
    expect(s.getFixtures).not.toHaveBeenCalled();
  });
  it('fails a blank table instead of reporting an empty season', async () => {
    await expect(loadStandingsForm(store([], []), laliga, undefined, october)).rejects.toThrow('blank');
  });
  it('accepts a computed table with no finished match yet as empty', async () => {
    const s = store([], []);
    await expect(loadStandingsForm(s, leaguesCup, undefined, october)).resolves.toEqual({ scope: 'phase', teams: {}, matches: [] });
    expect(s.getFixtures).not.toHaveBeenCalled();
  });
  it('marks a played team with no held matches unavailable, distinct from empty', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 3), row('b', 0))], []), laliga, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
    expect(form.teams.b).toBeUndefined();
  });
  it('marks a table count the fully read season cannot explain unavailable instead of labelling a short sample', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 6), row('b', 1))],
      [game('1', '2026-10-01T12:00:00Z', 'a', 'b')]), laliga, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
    expect(results(form, 'b')).toEqual(['1:L']);
  });
  it('never shows a short sample as complete: one match short of five reads on and is unavailable', async () => {
    const games = Array.from({ length: 4 }, (_, i) => game(`m${i}`, `2026-10-${String(i + 10)}T12:00:00Z`, 'a', 'b'));
    const s = store([table('t', row('a', 5), row('b', 4))], games);
    const form = await loadStandingsForm(s, laliga, undefined, october);
    expect(s.getFixtures.mock.calls.length).toBeGreaterThan(1);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  it('accepts an exceptional final as the reason a table count exceeds the eligible sample', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 2), row('b', 2))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 3, 0, { statusName: 'STATUS_AWARDED' }),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toEqual(['1:W']);
  });
  it('stops after one window once every team holds its five in a league with no later phase', async () => {
    const games = Array.from({ length: 5 }, (_, i) => game(`m${i}`, `2026-10-${String(i + 10)}T12:00:00Z`, 'a', 'b'));
    const s = store([table('t', row('a', 20), row('b', 20))], games);
    await loadStandingsForm(s, laliga, undefined, october);
    expect(s.getFixtures).toHaveBeenCalledTimes(1);
    expect(s.getFixtures.mock.calls[0][1]).toBe('20260731-20261030');
  });
  it('widens contiguously, never past the season, within the window cap', async () => {
    const s = store([table('t', row('a', 6), row('b', 6))], [game('1', '2026-07-05T12:00:00Z', 'a', 'b')]);
    await loadStandingsForm(s, laliga, undefined, october);
    expect(s.getFixtures.mock.calls.map((c) => c[1])).toEqual(['20260731-20261030', '20260701-20260730']);
    const year = store([table('t', row('a', 9))], []);
    await loadStandingsForm(year, mls, undefined, new Date('2026-12-31T12:00:00Z'));
    expect(year.getFixtures).toHaveBeenCalledTimes(4);
    expect(year.getFixtures.mock.calls.at(-1)?.[1].slice(0, 8)).toBe('20260101');
  });
  it('propagates a failed window so a partial read can never become a last-five', async () => {
    const s = store([table('t', row('a', 1))], []);
    s.getFixtures.mockRejectedValueOnce(new Error('upstream'));
    await expect(loadStandingsForm(s, laliga, undefined, october)).rejects.toThrow('upstream');
  });
  it('stops reading when cancelled', async () => {
    const controller = new AbortController();
    const s = store([table('t', row('a', 9))], []);
    s.getFixtures.mockImplementationOnce(async () => { controller.abort(); return []; });
    await expect(loadStandingsForm(s, laliga, controller.signal, october)).rejects.toThrow();
    expect(s.getFixtures).toHaveBeenCalledTimes(1);
  });
  it('passes the caller signal to every read', async () => {
    const controller = new AbortController();
    const s = store([table('t', row('a', 1))], []);
    await loadStandingsForm(s, laliga, controller.signal, october);
    expect(s.getFixtures.mock.calls[0][2]).toBe(controller.signal);
  });
  it('offers no form for a season whose standings section does not exist', async () => {
    const s = store([table('t', row('a', 3))], []);
    const form = await loadStandingsForm(s, resolveSeason('world-cup', '2022')!, undefined, october);
    expect(form).toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getStandings).not.toHaveBeenCalled();
  });
});

describe('shared standings form read', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('coalesces concurrent readers into one read and survives one reader leaving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(october);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = store([table('t', row('a', 1), row('b', 1))], [game('1', '2026-10-01T12:00:00Z', 'a', 'b')]);
    s.getStandings.mockImplementation(async () => { await gate; return [table('t', row('a', 0))]; });
    const leaver = new AbortController();
    const first = sharedStandingsForm(s, laliga, leaver.signal);
    const second = sharedStandingsForm(s, laliga, new AbortController().signal);
    leaver.abort();
    await expect(first).rejects.toBeDefined();
    release();
    await expect(second).resolves.toMatchObject({ scope: 'season' });
    expect(s.getStandings).toHaveBeenCalledTimes(1);
  });
  it('cancels the read when its last reader leaves, and the next reader starts fresh', async () => {
    const s = store([table('t', row('a', 1))], []);
    let readSignal: AbortSignal | undefined;
    s.getFixtures.mockImplementationOnce(async (_rc, _range, signal) => { readSignal = signal; return new Promise(() => {}); });
    const reader = new AbortController();
    const pending = sharedStandingsForm(s, leaguesCup, reader.signal);
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    reader.abort();
    await expect(pending).rejects.toBeDefined();
    expect(readSignal!.aborted).toBe(true);
    await expect(sharedStandingsForm(s, leaguesCup, new AbortController().signal)).resolves.toMatchObject({ scope: 'phase' });
  });
  it('starts nothing for a reader that has already left', async () => {
    const s = store([table('t', row('a', 1))], []);
    await expect(sharedStandingsForm(s, laliga, AbortSignal.abort())).rejects.toBeDefined();
    expect(s.getStandings).not.toHaveBeenCalled();
  });
  it('bounds a stalled table read with the caller signal', async () => {
    const s = store([], []);
    s.getStandings.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = loadStandingsForm(s, laliga, controller.signal, october);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe('standings form upstream budget', () => {
  // A real phase table needs a finished match, or the form has nothing to read for.
  const phaseEvent = { id: '1', date: '2026-08-05T01:00:00Z', season: { year: 2026, slug: 'league-phase' },
    status: { type: { state: 'post', completed: true, shortDetail: 'FT', name: 'STATUS_FULL_TIME' } },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '1', team: { id: 'a', displayName: 'A', abbreviation: 'A' } },
      { homeAway: 'away', score: '0', team: { id: 'b', displayName: 'B', abbreviation: 'B' } },
    ] }] };
  const counted = (rc: CompetitionSeason) => {
    const fetchJson = vi.fn(async (url: string) => (url.includes('/standings')
      ? { children: (rc.competition.id === 'world-cup' ? ['a', 'b'] : ['a']).map((id, i) => ({ id: String(i + 1), name: `t${i}`, standings: { entries: [{
        team: { id, displayName: id, abbreviation: id },
        stats: ['gamesPlayed', 'wins', 'ties', 'losses', 'pointsFor', 'pointsAgainst', 'pointDifferential', 'points'].map((name) => ({ name, value: 9 })) }] } })) }
      : { leagues: [{ slug: rc.competition.espnSlug }], events: url.includes('/scoreboard') && rc.season.computedTables ? [phaseEvent] : [] }));
    return { fetchJson, store: createDataStore({ fetchJson, cache: new TtlCache() }) };
  };
  it.each([
    ['mls', '2026', '2026-12-31T12:00:00Z', 19],
    ['liga-mx', '2026-apertura', '2026-12-31T12:00:00Z', 10],
    ['laliga', '2026-27', '2027-06-30T12:00:00Z', 17],
    ['world-cup', '2026', '2026-10-30T12:00:00Z', 8],
    ['leagues-cup', '2026', '2026-10-30T12:00:00Z', 2],
  ])('caps a cold read of %s %s and a warm read costs nothing', async (comp, season, now, cap) => {
    const rc = resolveSeason(comp, season)!;
    const { fetchJson, store: real } = counted(rc);
    await loadStandingsForm(real, rc, undefined, new Date(now));
    const cold = fetchJson.mock.calls.filter(([url]) => url.includes('/scoreboard')).length;
    expect(cold).toBe(cap);
    expect(fetchJson.mock.calls.some(([url]) => url.includes('/summary'))).toBe(false);
    const total = fetchJson.mock.calls.length;
    await loadStandingsForm(real, rc, undefined, new Date(now));
    expect(fetchJson.mock.calls.length).toBe(total);
  });
});

describe('standings form table scope', () => {
  it('excludes Liguilla from the Liga MX table by the table played count, even mid-window', async () => {
    const regular = Array.from({ length: 6 }, (_, i) => game(`r${i}`, `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`, 'a', 'b', 1, 0));
    const liguilla = [game('q1', '2026-10-20T12:00:00Z', 'a', 'c', 0, 3), game('q2', '2026-10-24T12:00:00Z', 'c', 'a', 3, 0)];
    const form = await loadStandingsForm(store([table('t', row('a', 6), row('b', 6))], [...regular, ...liguilla]), ligaMx, undefined, october);
    expect(form.scope).toBe('regular-season');
    expect(results(form, 'a')).toEqual(['r5:W', 'r4:W', 'r3:W', 'r2:W', 'r1:W']);
  });
  it('omits form when an exceptional final makes the later-phase boundary ambiguous', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 2), row('b', 2))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 3, 0, { statusName: 'STATUS_AWARDED' }),
      game('3', '2026-10-20T12:00:00Z', 'a', 'b'),
    ]), ligaMx, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  // STATUS_POSTPONED is the recorded gre.1 case: AEK at Atromitos, 2026-10-17.
  it.each(['STATUS_POSTPONED', 'STATUS_SUSPENDED', 'STATUS_CANCELED'])('does not let a post-state %s blur the boundary', async (statusName) => {
    const form = await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'),
      game('2', '2026-10-17T16:30:00Z', 'a', 'b', 0, 0, { statusName }),
    ]), ligaMx, undefined, october);
    expect(results(form, 'a')).toEqual(['1:W']);
  });
  it('omits form when a conflict could let a playoff match pass as a regular-season one', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 2), row('b', 2))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 1, 0), game('2', '2026-10-08T12:00:00Z', 'a', 'b', 0, 1),
      game('po', '2026-10-20T12:00:00Z', 'a', 'b'),
    ]), ligaMx, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  it('keeps a table with a later phase on its count when its real draw is published', async () => {
    const drawn: CompetitionSeason = { ...ligaMx, season: { ...ligaMx.season, bracketDatesRange: '20261101-20261215',
      format: { ...ligaMx.season.format, hasBracket: true } } };
    const form = await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'), game('qf', '2026-10-20T12:00:00Z', 'a', 'b', 0, 2),
    ]), drawn, undefined, october);
    expect(form.scope).toBe('regular-season');
    expect(results(form, 'a')).toEqual(['1:W']);
  });
  it('keeps a single-table league on season scope and window when it gains a bracket', async () => {
    const drawn: CompetitionSeason = { ...laliga, season: { ...laliga.season, bracketDatesRange: '20261001-20261015',
      format: { ...laliga.season.format, hasBracket: true } } };
    const s = store([table('t', row('a', 1), row('b', 1))], [game('1', '2026-10-20T12:00:00Z', 'a', 'b')]);
    const form = await loadStandingsForm(s, drawn, undefined, october);
    expect(form.scope).toBe('season');
    expect(s.getFixtures.mock.calls[0][1]).toBe('20260731-20261030');
    expect(results(form, 'a')).toEqual(['1:W']);
  });
  it('offers no form for a multi-group bracket season with no bracket dates to bound it', async () => {
    const undated: CompetitionSeason = { ...wc, season: { ...wc.season, bracketDatesRange: undefined } };
    const s = store([table('A', row('a', 1)), table('B', row('b', 1))], []);
    await expect(loadStandingsForm(s, undated, undefined, october)).resolves.toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getFixtures).not.toHaveBeenCalled();
  });
  it('omits form when a table counts more matches than the season has rounds', async () => {
    const held = Array.from({ length: 36 }, (_, i) => game(`m${i}`, new Date(Date.UTC(2026, 0, 5 + i * 7, 12)).toISOString(), 'a', 'b'));
    const form = await loadStandingsForm(store([table('t', row('a', 35))], held), mls, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  it('offers no form for a league once its season has ended, when the table may be the next one', async () => {
    const s = store([table('t', row('a', 1))], [game('1', '2026-10-01T12:00:00Z', 'a', 'b')]);
    await expect(loadStandingsForm(s, ligaMx, undefined, new Date('2027-01-15T12:00:00Z')))
      .resolves.toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getStandings).not.toHaveBeenCalled();
  });
  it('offers no form for a single-table league with a bracket once its season has ended', async () => {
    const drawn: CompetitionSeason = { ...ligaMx, season: { ...ligaMx.season, bracketDatesRange: '20261101-20261215',
      format: { ...ligaMx.season.format, hasBracket: true } } };
    const s = store([table('t', row('a', 1))], []);
    await expect(loadStandingsForm(s, drawn, undefined, new Date('2027-01-15T12:00:00Z')))
      .resolves.toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getFixtures).not.toHaveBeenCalled();
  });
  it('offers no form for a retained league edition that is not the current one', async () => {
    const older: CompetitionSeason = { ...laliga, competition: { ...laliga.competition, currentSeasonId: '2027-28' } };
    const s = store([table('t', row('a', 1))], [game('1', '2026-10-01T12:00:00Z', 'a', 'b')]);
    await expect(loadStandingsForm(s, older, undefined, october)).resolves.toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getStandings).not.toHaveBeenCalled();
  });
  it('offers no form for a retained computed-table edition that is not the current one', async () => {
    const older: CompetitionSeason = { ...leaguesCup, competition: { ...leaguesCup.competition, currentSeasonId: '2027' } };
    const s = store([table('mls', row('a', 1)), table('liga-mx', row('b', 1))], []);
    await expect(loadStandingsForm(s, older, undefined, october)).resolves.toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getStandings).not.toHaveBeenCalled();
  });
  it('offers no form for a retained tournament edition that is not the current one', async () => {
    const older: CompetitionSeason = { ...wc, competition: { ...wc.competition, currentSeasonId: '2030' } };
    const s = store([table('A', row('a', 1)), table('B', row('b', 1))], []);
    await expect(loadStandingsForm(s, older, undefined, october)).resolves.toEqual({ scope: null, teams: {}, matches: [] });
    expect(s.getStandings).not.toHaveBeenCalled();
  });
  it('reads the whole season for a league with a later phase', async () => {
    const games = Array.from({ length: 5 }, (_, i) => game(`m${i}`, `2026-10-${String(i + 10)}T12:00:00Z`, 'a', 'b'));
    const s = store([table('t', row('a', 5), row('b', 5))], games);
    await loadStandingsForm(s, ligaMx, undefined, october);
    expect(s.getFixtures.mock.calls.map((c) => c[1])).toEqual(['20260731-20261030', '20260701-20260730']);
  });
  it('gives a team one form across MLS conference and Supporters\' Shield memberships from one read', async () => {
    const s = store([table('east', row('a', 2)), table('west', row('b', 2)), table('supporters-shield', row('a', 2), row('b', 2))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'), game('2', '2026-10-08T12:00:00Z', 'b', 'a'),
    ]);
    const form = await loadStandingsForm(s, mls, undefined, october);
    expect(results(form, 'a')).toEqual(['2:L', '1:W']);
    expect(results(form, 'b')).toEqual(['2:W', '1:L']);
    expect(s.getStandings).toHaveBeenCalledTimes(1);
  });
  it('omits a team whose repeated memberships disagree on its played count', async () => {
    const held = [game('1', '2026-10-01T12:00:00Z', 'a', 'b'), game('2', '2026-10-08T12:00:00Z', 'a', 'b')];
    const form = await loadStandingsForm(store([table('east', row('a', 2)), table('shield', row('a', 3))], held), mls, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  it('omits a team listed as unplayed in one table and played in another, in either order', async () => {
    const held = [game('1', '2026-10-01T12:00:00Z', 'a', 'b'), game('2', '2026-10-08T12:00:00Z', 'a', 'b')];
    for (const tables of [[table('east', row('a', 0)), table('shield', row('a', 2))], [table('east', row('a', 2)), table('shield', row('a', 0))]]) {
      const form = await loadStandingsForm(store(tables, held), mls, undefined, october);
      expect(form.teams.a).toEqual({ status: 'unavailable' });
    }
  });
  it('keeps World Cup form inside each team\'s own group and before the knockout', async () => {
    const s = store([table('A', row('a', 3), row('b', 3)), table('B', row('c', 1), row('d', 1))], [
      game('g1', '2026-06-12T12:00:00Z', 'a', 'b', 1, 0),
      game('g2', '2026-06-18T12:00:00Z', 'b', 'a', 1, 0),
      game('g3', '2026-06-20T12:00:00Z', 'c', 'd', 1, 0),
      // Late group kickoff on the first bracket date, UTC.
      game('late', '2026-06-28T01:30:00Z', 'a', 'b', 2, 2),
      // Knockouts: another group's opponent, then a same-group rematch.
      game('r32', '2026-06-29T12:00:00Z', 'a', 'c', 0, 5),
      game('final', '2026-07-19T12:00:00Z', 'a', 'b', 0, 5),
    ]);
    const form = await loadStandingsForm(s, wc, undefined, october);
    expect(form.scope).toBe('group-stage');
    expect(results(form, 'a')).toEqual(['late:D', 'g2:L', 'g1:W']);
    expect(results(form, 'c')).toEqual(['g3:W']);
    expect(s.getFixtures.mock.calls[0][1].slice(9)).toBe('20260628');
  });
  it('reads the Leagues Cup phase window once and counts cross-table opponents', async () => {
    const s = store([table('mls', row('a', 1)), table('liga-mx', row('b', 1))], [
      game('p1', '2026-08-14T01:00:00Z', 'a', 'b', 1, 1, { statusName: 'STATUS_FINAL_PEN', winnerId: 'a' }),
      game('qf', '2026-08-26T01:00:00Z', 'a', 'b', 4, 0),
    ]);
    const form = await loadStandingsForm(s, leaguesCup, undefined, october);
    expect(form.scope).toBe('phase');
    expect(s.getFixtures.mock.calls.map((c) => c[1])).toEqual(['20260804-20260814']);
    expect(results(form, 'a')).toEqual(['p1:D']);
  });
  it('does not read a season whose phase has not started', async () => {
    const s = store([table('t', row('a', 1))], []);
    const form = await loadStandingsForm(s, leaguesCup, undefined, new Date('2026-07-01T00:00:00Z'));
    expect(s.getFixtures).not.toHaveBeenCalled();
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  it('excludes a same-team match the store scoped to another season inside the window', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'),
      game('2', '2026-10-08T12:00:00Z', 'a', 'b', 0, 3, { scope: { competitionId: 'liga-mx', seasonId: '2026-clausura' } }),
      game('3', '2026-10-09T12:00:00Z', 'a', 'b', 0, 3, { scope: { competitionId: 'leagues-cup', seasonId: '2026' } }),
    ]), ligaMx, undefined, october);
    expect(results(form, 'a')).toEqual(['1:W']);
  });
  it('ignores a match a store returns outside the requested window', async () => {
    const s = store([table('t', row('a', 1), row('b', 1))], []);
    s.getFixtures.mockResolvedValue([game('old', '2026-05-01T12:00:00Z', 'a', 'b')]);
    const form = await loadStandingsForm(s, ligaMx, undefined, october);
    expect(form.teams.a).toEqual({ status: 'unavailable' });
  });
  it('keeps a surplus match where no later phase is configured (documented: Serie A spareggio)', async () => {
    const form = await loadStandingsForm(store([table('t', row('a', 1), row('b', 1))], [
      game('1', '2026-10-01T12:00:00Z', 'a', 'b'), game('tie', '2026-10-20T12:00:00Z', 'a', 'b'),
    ]), laliga, undefined, october);
    expect(results(form, 'a')).toEqual(['tie:W', '1:W']);
  });
});
