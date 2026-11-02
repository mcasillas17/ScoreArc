import { describe, expect, it } from 'vitest';
import vectors from './contracts/reader-contract.json';
import derived from './contracts/derived-standings.json';
import roster from './__fixtures__/espn-team-roster.json';
import { mapTeamRoster } from './providers/espn-team';
import { canonicalTeamId } from './teamIdentity';
import {
  decodeReaderMatches, decodeReaderBracket, decodeReaderStandings, decodeReaderSummary,
  decodeReaderLeaders, decodeReaderTeam, decodeReaderSquad, decodeReaderPlayer,
} from './readerDecode';

const summary = { ...vectors.summary.shared, ...vectors.summary.reader, commentary: [vectors.summary.commentary.first] };
const match = derived.phaseMatches[0];
const squad = mapTeamRoster(roster);
const team = {
  team: match.home, location: null, color: null, altColor: null, record: null, standing: null,
  standingSummary: null, squad, schedule: [{ ...match, scope: { competitionId: 'leagues-cup', seasonId: '2026' } }],
  scheduleAvailability: { results: 'available', upcoming: 'available' },
};
const leaders = vectors.leaders.frontend.scorers.map(row => ({
  ...row, teamId: canonicalTeamId(row.teamId), playerId: null, playerSlug: null,
}));
const bracket = [{
  slug: 'final', name: 'Final', matches: [{
    id: match.id, round: 'final', kickoff: match.kickoff,
    home: { ...match.home, placeholder: false }, away: { ...match.away, placeholder: false },
    homeScore: match.homeScore, awayScore: match.awayScore, state: match.state,
    statusDetail: match.statusDetail, statusName: match.statusName, minute: match.minute,
    winnerId: match.winnerId, note: match.note,
  }],
}];
const cases = [
  ['matches', decodeReaderMatches, derived.phaseMatches],
  ['standings', decodeReaderStandings, derived.membership.mls.groups],
  ['summary', decodeReaderSummary, summary],
  ['leaders', decodeReaderLeaders, leaders],
  ['squad', decodeReaderSquad, squad],
  ['team', decodeReaderTeam, team],
  ['player', decodeReaderPlayer, vectors.player.reader.profile],
  ['bracket', decodeReaderBracket, bracket],
] as const;

describe('reader DTO decoding', () => {
  it.each(cases)('preserves every wire field and explicit null in %s', (_name, decode, raw) => {
    expect(decode(raw)).toEqual(raw);
  });

  it.each(cases)('rejects a missing required field in %s', (_name, decode, raw) => {
    const invalid = structuredClone(raw);
    const value = (Array.isArray(invalid) ? invalid[0] : invalid) as Record<string, unknown>;
    delete value[Object.keys(value)[0]];
    expect(() => decode(invalid)).toThrow('Invalid reader body');
  });

  it.each(cases)('rejects null or an unexpected envelope in %s', (_name, decode, raw) => {
    expect(() => decode(null)).toThrow('Invalid reader body');
    expect(() => decode({ data: raw })).toThrow('Invalid reader body');
  });

  it('keeps unknown starter, player reference, and career identity null', () => {
    const raw = structuredClone(summary);
    raw.lineups.home.players[0].starter = null as unknown as boolean;
    const parsed = decodeReaderSummary(raw);
    expect(parsed.lineups?.home.players[0].starter).toBeNull();
    expect(parsed.lineups?.home.players[0].playerId).toBeNull();
    const player = decodeReaderPlayer(vectors.player.reader.profile);
    expect(player.career.find(stint => stint.teamId === null)).toMatchObject({ crestUrl: null });
  });

  it('preserves live game-log score and clock context and rejects contradictions', () => {
    const liveMatch = { state: 'live', homeScore: 2, awayScore: 1, minute: '63', statusDetail: "63'", statusName: 'STATUS_IN_PROGRESS' };
    const raw = { ...vectors.player.reader.profile, gameLog: [{ ...vectors.player.reader.profile.gameLog[0], result: '', score: '2-1', liveMatch }] };
    expect(decodeReaderPlayer(raw).gameLog[0]).toMatchObject({ result: '', liveMatch });
    for (const bad of [{ ...liveMatch, state: 'finished' }, { ...liveMatch, homeScore: -1 }, { ...liveMatch, minute: 63 }]) {
      expect(() => decodeReaderPlayer({ ...raw, gameLog: [{ ...raw.gameLog[0], liveMatch: bad }] })).toThrow('Invalid reader body');
    }
    expect(() => decodeReaderPlayer({ ...raw, gameLog: [{ ...raw.gameLog[0], result: 'W' }] })).toThrow('Invalid reader body');
    expect(() => decodeReaderPlayer({ ...raw, gameLog: [{ ...raw.gameLog[0], score: '1-2' }] })).toThrow('Invalid reader body');
    expect(decodeReaderPlayer({ ...raw, gameLog: [{ ...raw.gameLog[0], score: '', liveMatch: { ...liveMatch, homeScore: null, awayScore: null, minute: null } }] }).gameLog[0].liveMatch)
      .toMatchObject({ homeScore: null, awayScore: null, minute: null });
  });

  it('preserves the shared bracket placeholder with the Go integration crosswalk', () => {
    // Same named normalizers as TestReaderContractIntegration's bracket projection.
    const held = vectors.bracket.frontendPlaceholder;
    const raw = [{ slug: held.round, name: vectors.bracket.readerRoundNames['round-of-16'], matches: [{
      ...held, id: '018f0000-0000-7000-8000-000000016012', kickoff: new Date(held.kickoff).toISOString(),
      home: { ...held.home, id: 'nat-par' }, away: { ...held.away, id: 'prov-espn-131529' },
    }] }];
    const parsed = decodeReaderBracket(raw);
    expect(parsed).toEqual(raw);
    expect(parsed[0].matches[0].away).toMatchObject({ id: 'prov-espn-131529', placeholder: true, crestUrl: null });
  });

  it('validates nested fields rather than casting an apparent top-level shape', () => {
    const raw = structuredClone(summary);
    raw.lineups.home.players[0].stats.appearances = '1' as unknown as number;
    expect(() => decodeReaderSummary(raw)).toThrow('Invalid reader body');
    const missing = structuredClone(summary);
    delete (missing.stats.home as Partial<typeof missing.stats.home>).passesAccurate;
    expect(() => decodeReaderSummary(missing)).toThrow('Invalid reader body');
    expect(() => decodeReaderMatches([{ ...match, kickoff: '2026-02-31T00:00:00Z' }])).toThrow('Invalid reader body');
    expect(() => decodeReaderMatches([{ ...match, homeScore: -1 }])).toThrow('Invalid reader body');
    expect(() => decodeReaderLeaders([{ ...leaders[0], value: NaN }])).toThrow('Invalid reader body');
    expect(() => decodeReaderSummary({ ...summary, winProbability: { home: 101, draw: 0, away: 0 } })).toThrow('Invalid reader body');
  });

  it('rejects provider numbers where canonical match/player UUIDs are required', () => {
    expect(() => decodeReaderMatches([{ ...match, id: '401877007' }])).toThrow('Invalid reader body');
    expect(() => decodeReaderPlayer({ ...vectors.player.reader.profile, id: '297287' })).toThrow('Invalid reader body');
    expect(() => decodeReaderSquad([{ ...squad[0], id: vectors.player.reader.profile.id }])).toThrow('Invalid reader body');
  });

  it('bounds held player logs and roster arrays without truncating them', () => {
    const player = vectors.player.reader.profile;
    expect(() => decodeReaderPlayer({ ...player, gameLog: Array(6).fill(player.gameLog[0]) })).toThrow('Invalid reader body');
    expect(() => decodeReaderPlayer({ ...player, career: Array(51).fill(player.career[0]) })).toThrow('Invalid reader body');
    const raw = structuredClone(summary);
    raw.lineups.home.players = Array(65).fill(raw.lineups.home.players[0]);
    expect(() => decodeReaderSummary(raw)).toThrow('Invalid reader body');
  });

  it('accepts verified empty collections, but rejects unknown fields and invented slugs', () => {
    for (const decode of [decodeReaderMatches, decodeReaderStandings, decodeReaderBracket, decodeReaderLeaders, decodeReaderSquad]) {
      expect(decode([])).toEqual([]);
    }
    expect(() => decodeReaderPlayer({ ...vectors.player.reader.profile, playerSlug: 'invented' })).toThrow('Invalid reader body');
    expect(() => decodeReaderMatches([{ ...match, sourceId: 'not-a-contract-field' }])).toThrow('Invalid reader body');
  });
});
