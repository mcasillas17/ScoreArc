import { describe, expect, it } from 'vitest';
import { resolveSeason } from './competitions';
import { deriveReaderStandings, type PhaseMatch } from './derivedStandings';
import { configuredPhaseTables } from './leaguesCupTables';
import { createDataStore } from './store';
import { TtlCache } from './cache';
import { canonicalTeamId } from './teamIdentity';
import type { Group, Match, Standing, Team } from './types';
import vectors from './contracts/derived-standings.json';
import phaseRaw from './__fixtures__/leagues-cup-phase-2026.json';
import ligaMxIds from './__fixtures__/liga-mx-team-ids-2026.json';
import mlsRaw from './__fixtures__/espn-standings-mls-2026.json';

// Reader-shaped synthetic inputs: canonical ids, as the reader serves them.
const mls = resolveSeason('mls', '2026')!;
const lc = resolveSeason('leagues-cup', '2026')!;
const team = (id: string, name = id): Team => ({ id, name, abbr: id.slice(-3).toUpperCase(), crestUrl: `https://cdn.scorearc.futbol/teams/${id}` });

function row(id: string, over: Partial<Standing> = {}, name = id): Standing {
  return {
    team: team(id, name), rank: 1, played: 3, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false, ...over,
  };
}
const table = (id: string, name: string, rows: Standing[]): Group => ({ id, name, standings: rows });

describe('deriveReaderStandings — MLS', () => {
  const east = table('1', 'Eastern Conference', [
    row('usa-a', { rank: 1, points: 9, wins: 3, goalDifference: 5, goalsFor: 7 }),
    row('usa-b', { rank: 2, points: 6, wins: 2, goalDifference: 1, goalsFor: 4 }),
  ]);
  const west = table('2', 'Western Conference', [
    // Level with usa-b on points but one more win: wins outrank goal difference.
    row('usa-c', { rank: 1, points: 6, wins: 1, goalDifference: 9, goalsFor: 9 }, 'Zeta'),
    // Level with usa-b on everything: the name fallback decides (Alpha < usa-b).
    row('usa-d', { rank: 2, points: 6, wins: 2, goalDifference: 1, goalsFor: 4 }, 'Alpha'),
  ]);

  it('keeps both conference tables and appends one league-wide table', () => {
    const out = deriveReaderStandings(mls, { standings: [east, west] });
    expect(out.status).toBe('complete');
    expect(out.issues).toEqual([]);
    expect(out.groups.slice(0, 2)).toEqual([east, west]);
    const overall = out.groups[2];
    expect(overall).toEqual({
      id: 'supporters-shield',
      labelKey: 'standings.supportersShieldOverall',
      zones: [{ from: 1, to: 1, kind: 'champion', labelKey: 'zone.supportersShield' }],
      standings: expect.any(Array),
    });
    expect(overall).not.toHaveProperty('name');
    expect(overall.standings.map(s => [s.team.id, s.rank])).toEqual([
      ['usa-a', 1], ['usa-d', 2], ['usa-b', 3], ['usa-c', 4],
    ]);
    // Rows keep their canonical identity, crest and advanced flag.
    expect(overall.standings[1].team).toEqual(west.standings[1].team);
  });

  it('never mutates the input ranks', () => {
    const before = structuredClone([east, west]);
    deriveReaderStandings(mls, { standings: [east, west] });
    expect([east, west]).toEqual(before);
  });

  it('never counts an already-derived overall table as another conference', () => {
    const once = deriveReaderStandings(mls, { standings: [east, west] }).groups;
    const again = deriveReaderStandings(mls, { standings: once });
    expect(again.groups).toEqual(once);
    // A provider table that merely reuses the derived id is not merged either.
    const impostor = table('supporters-shield', 'Overall', [row('usa-z', { points: 99 })]);
    const out = deriveReaderStandings(mls, { standings: [east, west, impostor] });
    expect(out.groups.at(-1)!.standings.map(s => s.team.id)).not.toContain('usa-z');
  });

  it('counts a club repeated identically across tables once', () => {
    const repeated = table('2', 'Western Conference', [...west.standings, { ...east.standings[0], rank: 3 }]);
    const out = deriveReaderStandings(mls, { standings: [east, repeated] });
    expect(out.status).toBe('complete');
    expect(out.groups.at(-1)!.standings).toHaveLength(4);
  });

  it('reports a club whose repeated rows disagree as partial, keeping the first table row', () => {
    const conflicting = table('2', 'Western Conference', [...west.standings, { ...east.standings[0], rank: 3, points: 1 }]);
    const out = deriveReaderStandings(mls, { standings: [east, conflicting] });
    expect(out.status).toBe('partial');
    expect(out.issues).toEqual([{ kind: 'conflicting-row', teamId: 'usa-a' }]);
    const overall = out.groups.at(-1)!.standings;
    expect(overall.find(s => s.team.id === 'usa-a')!.points).toBe(9);
  });

  // A stored MLS season always has conference rows (ESPN lists every club from
  // the first day), so none means the input is missing, not an empty table.
  it('is unavailable, not an empty table, without conference rows', () => {
    expect(deriveReaderStandings(mls, { standings: [] })).toEqual({ status: 'unavailable', groups: [], issues: [] });
    const derivedOnly = deriveReaderStandings(mls, { standings: [east, west] }).groups.slice(2);
    expect(deriveReaderStandings(mls, { standings: derivedOnly }).status).toBe('unavailable');
  });

  it('passes every other competition through unchanged', () => {
    const pl = resolveSeason('premier-league')!;
    expect(deriveReaderStandings(pl, { standings: [east] })).toEqual({ status: 'complete', groups: [east], issues: [] });
  });
});

describe('deriveReaderStandings — Leagues Cup', () => {
  const MLS = ['usa-1', 'usa-2', 'usa-3', 'usa-4', 'usa-5'];
  const LMX = ['mex-1', 'mex-2', 'mex-3', 'mex-4', 'mex-5'];
  const membership = {
    primary: [table('1', 'Eastern Conference', MLS.slice(0, 3).map(id => row(id))), table('2', 'Western Conference', MLS.slice(3).map(id => row(id)))],
    split: [table('mex', 'Liga MX', LMX.map(id => row(id)))],
  };
  const match = (home: string, away: string, homeScore: number | null, awayScore: number | null, over: Partial<PhaseMatch> = {}): PhaseMatch => ({
    kickoff: '2026-08-05T01:00:00Z', state: 'finished', home: team(home), away: team(away),
    homeScore, awayScore, shootout: null, ...over,
  });
  const phase: PhaseMatch[] = [
    match('usa-1', 'mex-1', 2, 0),                                             // regulation win
    match('mex-2', 'usa-2', 1, 1, { shootout: { homeScore: 4, awayScore: 3 } }), // shootout: 2 home / 1 away
    match('usa-3', 'mex-3', 0, 3),
    match('usa-4', 'mex-4', 1, 0),
    match('mex-5', 'usa-5', 2, 2, { shootout: { homeScore: 2, awayScore: 4 } }),
    match('usa-1', 'mex-2', 0, 0, { state: 'scheduled', homeScore: null, awayScore: null }),
    match('usa-2', 'mex-1', 1, 0, { state: 'live' }),
  ];
  const ids = (g: Group | undefined) => g?.standings.map(s => [s.team.id, s.points, s.rank, s.advanced]);

  it('ranks each league on its own results, with shootout points and the cut', () => {
    const out = deriveReaderStandings(lc, { standings: [], phaseMatches: phase, membership });
    expect(out.status).toBe('complete');
    expect(out.groups.map(g => [g.id, g.name])).toEqual([['mls', 'MLS'], ['liga-mx', 'Liga MX']]);
    expect(ids(out.groups[0])).toEqual([
      ['usa-1', 3, 1, true], ['usa-4', 3, 2, true], ['usa-5', 2, 3, true], ['usa-2', 1, 4, true], ['usa-3', 0, 5, false],
    ]);
    expect(ids(out.groups[1])).toEqual([
      ['mex-3', 3, 1, true], ['mex-2', 2, 2, true], ['mex-5', 1, 3, true], ['mex-4', 0, 4, true], ['mex-1', 0, 5, false],
    ]);
    // Regulation result columns, not shootout ones: both shootout matches are draws.
    const usa2 = out.groups[0].standings.find(s => s.team.id === 'usa-2')!;
    expect([usa2.played, usa2.wins, usa2.draws, usa2.losses, usa2.goalsFor]).toEqual([1, 0, 1, 0, 1]);
  });

  it('keeps the missing-shootout point split but reports the table as partial', () => {
    const level = match('usa-3', 'mex-1', 1, 1);
    const out = deriveReaderStandings(lc, { standings: [], phaseMatches: [...phase, level], membership });
    expect(out.status).toBe('partial');
    expect(out.issues).toEqual([{ kind: 'missing-shootout', kickoff: level.kickoff, homeId: 'usa-3', awayId: 'mex-1' }]);
    expect(out.groups[0].standings.find(s => s.team.id === 'usa-3')!.points).toBe(1);
    expect(out.groups[1].standings.find(s => s.team.id === 'mex-1')!.points).toBe(1);
    // A level shootout total is not decisive either.
    const tied = match('usa-3', 'mex-1', 1, 1, { shootout: { homeScore: 3, awayScore: 3 } });
    expect(deriveReaderStandings(lc, { standings: [], phaseMatches: [tied], membership }).issues[0].kind).toBe('missing-shootout');
  });

  it('drops a finished match without both scores and reports it', () => {
    const incomplete = match('usa-3', 'mex-1', 1, null);
    const out = deriveReaderStandings(lc, { standings: [], phaseMatches: [...phase, incomplete], membership });
    expect(out.status).toBe('partial');
    expect(out.issues).toEqual([{ kind: 'incomplete-score', kickoff: incomplete.kickoff, homeId: 'usa-3', awayId: 'mex-1' }]);
    expect(out.groups[0].standings.find(s => s.team.id === 'usa-3')!.played).toBe(1);
  });

  it('keeps a club in neither membership table, or in both, out of every table', () => {
    const both = { ...membership, split: [table('mex', 'Liga MX', [...LMX, 'usa-4'].map(id => row(id)))] };
    const unknown = match('prov-espn-1', 'mex-1', 0, 1);
    const out = deriveReaderStandings(lc, { standings: [], phaseMatches: [...phase, unknown], membership: both });
    expect(out.status).toBe('partial');
    expect(out.issues).toEqual([
      { kind: 'unclassified-team', teamId: 'prov-espn-1' },
      { kind: 'unclassified-team', teamId: 'usa-4' },
    ]);
    const listed = out.groups.flatMap(g => g.standings.map(s => s.team.id));
    expect(listed).not.toContain('prov-espn-1');
    expect(listed).not.toContain('usa-4');
    // The known opponent keeps its result.
    expect(out.groups[1].standings.find(s => s.team.id === 'mex-1')!.points).toBe(3);
    // The ESPN path's rule, unchanged: without an MLS set, every club outside
    // Liga MX is MLS. This is the documented divergence's other half.
    const espnPath = configuredPhaseTables([...phase, unknown], lc.season.computedTables!, new Set(LMX));
    expect(espnPath[0].standings.map(s => s.team.id)).toContain('prov-espn-1');
  });

  it('is unavailable, not an empty table, when a membership scope has no stored table', () => {
    for (const m of [{ ...membership, split: [] }, { ...membership, primary: [] }, undefined]) {
      expect(deriveReaderStandings(lc, { standings: [], phaseMatches: phase, membership: m }))
        .toEqual({ status: 'unavailable', groups: [], issues: [] });
    }
    expect(deriveReaderStandings(lc, { standings: [], membership }))
      .toEqual({ status: 'unavailable', groups: [], issues: [] });
  });

  it('is a complete empty result before the first phase match finishes', () => {
    const scheduled = phase.filter(m => m.state === 'scheduled');
    expect(deriveReaderStandings(lc, { standings: [], phaseMatches: scheduled, membership }))
      .toEqual({ status: 'complete', groups: [], issues: [] });
  });
});

// Parity: the reader's actual responses (derived-standings.json, pinned by the
// Go database suite) through the adapter, against today's ESPN-backed store over
// the same recorded payloads. The one normalizer is the production team
// crosswalk on team ids; every other field is compared exactly.
describe('deriveReaderStandings — parity with the ESPN store', () => {
  const inputs = {
    phaseMatches: vectors.phaseMatches as unknown as Match[],
    membership: {
      primary: vectors.membership.mls.groups as unknown as Group[],
      split: vectors.membership.ligaMx.groups as unknown as Group[],
    },
  };
  const espn = createDataStore({
    cache: new TtlCache(),
    fetchJson: async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/teams')) return { sports: [{ leagues: [{ teams: ligaMxIds.map(id => ({ team: { id } })) }] }] };
      if (u.pathname.endsWith('/standings')) return mlsRaw;
      return { leagues: phaseRaw.leagues, events: u.searchParams.get('dates') === '202608' ? phaseRaw.events : [] };
    },
  });
  const canonical = (groups: Group[]) => groups.map(g => ({
    ...g, standings: g.standings.map(s => ({ ...s, team: { ...s.team, id: canonicalTeamId(s.team.id)! } })),
  }));

  // The vector was read from exactly the routes the season config names.
  it('was read from the configured phase window and membership seasons', () => {
    const t = lc.season.computedTables!;
    const standingsRoute = (s: { competitionId: string; seasonId: string }) =>
      `/v1/competitions/${s.competitionId}/${s.seasonId}/standings`;
    expect(vectors.phaseRoute).toBe(`/v1/competitions/${lc.competition.id}/${lc.season.id}/matches?range=${t.datesRange}`);
    expect(vectors.membership.mls.route).toBe(standingsRoute(t.membership.primary));
    expect(vectors.membership.ligaMx.route).toBe(standingsRoute(t.membership.split));
  });

  it('reproduces the Leagues Cup phase tables from the reader inputs', async () => {
    const out = deriveReaderStandings(lc, { standings: [], ...inputs });
    expect(out.status).toBe('complete');
    expect(out.groups).toEqual(canonical(await espn.getStandings(lc)));
    expect(out.groups.map(g => g.standings.filter(s => s.advanced).map(s => s.team.id))).toEqual([
      ['usa-chicago-fire-fc', 'usa-austin-fc', 'usa-columbus-crew', 'usa-real-salt-lake'],
      ['mex-leon', 'mex-america', 'mex-toluca', 'mex-monterrey'],
    ]);
  });

  it("reproduces the MLS conference and Supporters' Shield tables from the reader standings", async () => {
    const out = deriveReaderStandings(mls, { standings: inputs.membership.primary });
    expect(out.status).toBe('complete');
    expect(out.groups).toEqual(canonical(await espn.getStandings(mls)));
  });
});
