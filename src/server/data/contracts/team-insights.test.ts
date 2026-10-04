import { describe, expect, expectTypeOf, it } from 'vitest';
import { mapScopedTeamSchedule, mapTeamProfile, mapTeamSchedule } from '../providers/espn-team';
import { canonicalTeamId, providerTeamId } from '../teamIdentity';
import { resolveSeason } from '../competitions';
import type { Match, SquadPlayer, Team, TeamProfile } from '../types';
import recordedProfile from '../__fixtures__/espn-team-profile.json';
import recordedSchedule from '../__fixtures__/espn-team-schedule.json';
import vectors from './team-insights.json';


// Independent expected shapes: do not alias these properties to production
// types. tsc checks expectTypeOf; the runtime mapper assertions are separate.
// Match and Team are pinned exhaustively in reader-contract.test.ts.
type ContractTeam = { id: string; name: string; abbr: string; crestUrl: string | null };
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

describe('bounded team insights contract (not reader parity)', () => {
  it('compile-checks supported field types and nullability against independent shapes', () => {
    expectTypeOf<Pick<Team, keyof ContractTeam>>().toEqualTypeOf<ContractTeam>();
    expectTypeOf<Pick<TeamProfile, keyof ContractProfile>>().toEqualTypeOf<ContractProfile>();
    // Exhaustive: a TeamProfile key outside the pinned shape, squad and schedule fails tsc.
    expectTypeOf<Exclude<keyof TeamProfile, keyof ContractProfile | 'squad' | 'schedule'>>().toEqualTypeOf<never>();
    expectTypeOf<TeamProfile['squad']>().toEqualTypeOf<SquadPlayer[]>();
    expectTypeOf<TeamProfile['schedule']>().toEqualTypeOf<Match[]>();
    // Preserve the mapper's nullable result independently of TeamProfile's fields.
    expectTypeOf<Extract<ReturnType<typeof mapTeamProfile>, null | undefined>>().toEqualTypeOf<null>();
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
