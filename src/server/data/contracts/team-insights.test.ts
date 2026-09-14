import { describe, expect, expectTypeOf, it } from 'vitest';
import { mapScopedTeamSchedule, mapTeamProfile, mapTeamSchedule } from '../providers/espn-team';
import { canonicalTeamId, providerTeamId } from '../teamIdentity';
import { resolveSeason } from '../competitions';
import type { DataStore } from '../store';
import type { Match, Team, TeamProfile } from '../types';
import recordedProfile from '../__fixtures__/espn-team-profile.json';
import recordedSchedule from '../__fixtures__/espn-team-schedule.json';
import vectors from './team-insights.json';


// Independent expected shapes: do not alias these properties to production
// types. tsc checks expectTypeOf; the runtime mapper assertions are separate.
type ContractTeam = { id: string; name: string; abbr: string; crestUrl: string | null };
type ContractMatch = {
  id: string;
  kickoff: string;
  state: 'scheduled' | 'live' | 'finished';
  minute: string | null;
  statusDetail: string;
  statusName: string;
  home: ContractTeam;
  away: ContractTeam;
  homeScore: number | null;
  awayScore: number | null;
  winnerId: string | null;
  note: string | null;
  scope?: { competitionId: string; seasonId: string };
};
type ContractProfile = {
  team: ContractTeam;
  location: string | null;
  color: string | null;
  altColor: string | null;
  record: { summary: string; gamesPlayed: number | null; points: number | null; goalDifference: number | null } | null;
  standing: { rank: number; competition: string } | null;
  standingSummary: string | null;
  scheduleAvailability?: { results: 'available' | 'unavailable'; upcoming: 'available' | 'unavailable' };
};

// Exhaustiveness is compile checked: a new DataStore method requires inventory.
const readerCoverage = {
  getMatches: 'missing range/state/detail/limit',
  getFixtures: 'missing range and lightweight detail semantics',
  getLiveWindow: 'missing time window and live derivation',
  getUpcoming: 'missing future/state/limit derivation',
  getStandings: 'missing computed Leagues Cup and MLS views',
  getBracket: 'route exists; full DTO/identity parity unproven',
  getMatchSummary: 'canonical match id; nested scorer/stats/lineup DTO gaps',
  getLeaders: 'missing assists and StatLeader value contract',
  getTopScorers: 'goals key differs from value; missing player identity',
  getTopAssists: 'no route',
  getNews: 'competition-only route; full parity unproven',
  getTeam: 'missing standing, scope and availability; canonical identity',
  getSquad: 'only embedded in team; partial stat population',
  getPlayer: 'no route',
} satisfies Record<keyof DataStore, string>;

describe('bounded team insights contract (not reader parity)', () => {
  it('compile-checks supported field types and nullability against independent shapes', () => {
    expectTypeOf<Pick<Team, keyof ContractTeam>>().toEqualTypeOf<ContractTeam>();
    expectTypeOf<Pick<Match, keyof ContractMatch>>().toEqualTypeOf<ContractMatch>();
    expectTypeOf<Pick<TeamProfile, keyof ContractProfile>>().toEqualTypeOf<ContractProfile>();
    expectTypeOf<TeamProfile['schedule']>().toBeArray();
    expectTypeOf<Pick<TeamProfile['schedule'][number], keyof ContractMatch>>().toEqualTypeOf<ContractMatch>();
    // Preserve the mapper's nullable result independently of TeamProfile's fields.
    expectTypeOf<Extract<ReturnType<typeof mapTeamProfile>, null | undefined>>().toEqualTypeOf<null>();
  });

  it('pins all 14 methods without representing a gap as supported', () => {
    expect(Object.keys(readerCoverage)).toHaveLength(14);
    expect(readerCoverage.getPlayer).toBe('no route');
    expect(readerCoverage.getTopAssists).toBe('no route');
  });

  it('uses the actual schedule mapper and exact shared fields, nulls and ascending order', () => {
    expect(mapTeamSchedule(vectors.scheduleInput)).toEqual(vectors.espnMatches);
    const recorded = mapTeamSchedule(recordedSchedule).find(m => m.id === vectors.espnMatches[0].id);
    expect(recorded).toEqual(vectors.espnMatches[0]);
    expect(mapTeamSchedule({ events: [] })).toEqual([]);
    expect(mapTeamSchedule(null)).toEqual([]); // Legacy mapper cannot signal unavailable.
  });

  it('checks the real profile mapper and the explicit provider/canonical crosswalk', () => {
    const profile = mapTeamProfile(recordedProfile);
    expect(profile?.team).toEqual(vectors.espnMatches[0].home);
    expect(profile?.standing).toEqual({ rank: 1, competition: 'Mexican Liga BBVA MX' });
    expect(profile?.record).toEqual({ summary: '3-1-0', gamesPlayed: 4, points: 10, goalDifference: 7 });
    expect(canonicalTeamId(vectors.identity.providerId)).toBe(vectors.identity.canonicalId);
    expect(providerTeamId(vectors.identity.canonicalId)).toBe(vectors.identity.providerId);
    expect(canonicalTeamId('unseeded-contract-team')).toBeNull();
    expect(mapTeamProfile(null)).toBeNull();
  });

  it('attaches verified scope to the recorded vector and distinguishes unavailable', () => {
    const rc = resolveSeason(vectors.scope.competitionId, vectors.scope.seasonId)!;
    const scoped = mapScopedTeamSchedule(recordedSchedule, rc, vectors.identity.providerId);
    expect(scoped.available).toBe(true);
    expect(scoped.matches.find(m => m.id === vectors.espnMatches[0].id)).toEqual({
      ...vectors.espnMatches[0], scope: vectors.scope,
    });
    expect(mapScopedTeamSchedule(null, rc, vectors.identity.providerId)).toEqual({ matches: [], available: false });
    expect(mapScopedTeamSchedule({ ...recordedSchedule, events: [] }, rc, vectors.identity.providerId))
      .toEqual({ matches: [], available: true });
    const wrongSeason = { ...rc, season: { ...rc.season, id: '2026-clausura' } };
    expect(mapScopedTeamSchedule(recordedSchedule, wrongSeason, vectors.identity.providerId))
      .toEqual({ matches: [], available: false });
  });

  it('asserts identity and scope gaps without dropping incompatible fields', () => {
    for (const [i, reader] of vectors.readerMatches.entries()) {
      const espn = vectors.espnMatches[i];
      expect(reader.id).not.toBe(espn.id); // Test UUID is not a production event crosswalk.
      expect(reader.home.id).toBe(canonicalTeamId(espn.home.id));
      expect(reader.away.id).toBe(canonicalTeamId(espn.away.id));
      expect(reader.winnerId).toBe(espn.winnerId === null ? null : canonicalTeamId(espn.winnerId));
      expect(Date.parse(reader.kickoff)).toBe(Date.parse(espn.kickoff));
      expect(reader.homeScore).toBe(espn.homeScore);
      expect(reader.awayScore).toBe(espn.awayScore);
      expect(reader.state).toBe(espn.state);
      expect(reader.statusName).toBe(espn.statusName);
      expect(reader).not.toHaveProperty('scope');
    }
    expect(vectors.readerTeam).not.toHaveProperty('standing');
    expect(vectors.readerTeam).not.toHaveProperty('scheduleAvailability');
  });
});
