import type { DataStore } from '../store';
import type { CompetitionSeason } from '../competitions';
import type { Match } from '../types';
import { loadStandingsForm } from '../standingsForm';
import { ReaderFailure } from '../readerTransport';
import { canonicalTeamId } from '../teamIdentity';

export const METHODS = ['getMatches', 'getFixtures', 'getLiveWindow', 'getUpcoming', 'getStandings', 'getBracket', 'getMatchSummary', 'getLeaders', 'getTeam', 'getSquad', 'getPlayer'] as const;
export const SCENARIOS = ['listPopup', 'playerPopup', 'teamSchedule', 'leaderLinks', 'formPopup'] as const;
export type SampleKind = typeof METHODS[number] | typeof SCENARIOS[number];
export interface Sample {
  competition: string; season: string; kind: SampleKind;
  range?: string; limit?: number; eventId?: string; homeId?: string; awayId?: string; teamId?: string; playerId?: string;
}
export interface ScenarioResult { value: unknown; issues: ('target_missing' | 'broken_link' | 'partial' | 'unsupported_scope')[] }

async function boundedIndex(rc: CompetitionSeason, store: DataStore) {
  const groups = await store.getStandings(rc);
  if (new Set(groups.flatMap(group => group.standings.map(row => row.team.id))).size > 64) throw new ReaderFailure('budget');
  const { competitionPlayerIndex } = await import('../playerIndex');
  return competitionPlayerIndex(rc, { ...store, getStandings: async () => groups });
}

export async function runScenario(store: DataStore, sample: Sample, rc: CompetitionSeason, signal: AbortSignal, now: number, source: 'reader' | 'espn'): Promise<ScenarioResult> {
  const scope = { competitionId: rc.competition.id, seasonId: rc.season.id };
  // Only absent scope is supplied from the validated query; a contradictory scope survives.
  const scoped = (matches: Match[]) => matches.map(match => ({ ...match, scope: match.scope ?? scope }));
  const result = (value: unknown): ScenarioResult => ({ value, issues: [] });
  const popup = async (matches: Match[], field: 'list' | 'team' | 'form', parent: unknown): Promise<ScenarioResult> => {
    const target = matches.find(match => match.id === sample.eventId);
    if (!target) return { value: { [field]: parent, target: null, summary: null }, issues: ['target_missing'] };
    const summary = await store.getMatchSummary(rc, target.id, target.home.id, target.away.id);
    return result({ [field]: parent, target, summary });
  };
  switch (sample.kind) {
    case 'getMatches': return result(scoped(await store.getMatches(rc, sample.range!, signal)));
    case 'getFixtures': return result(scoped(await store.getFixtures(rc, sample.range!, signal)));
    case 'getLiveWindow': return result(scoped(await store.getLiveWindow(rc)));
    case 'getUpcoming': return result(scoped(await store.getUpcoming(rc, sample.limit ?? 12, signal)));
    case 'getStandings': return result(await store.getStandings(rc));
    case 'getBracket': return result(await store.getBracket(rc));
    case 'getMatchSummary': return result(await store.getMatchSummary(rc, sample.eventId!, sample.homeId!, sample.awayId!));
    case 'getLeaders': return result(await store.getLeaders(rc));
    case 'getSquad': return result(await store.getSquad(rc, sample.teamId!));
    case 'getPlayer': return result(await store.getPlayer(rc, sample.playerId!));
    case 'getTeam': {
      const team = await store.getTeam(rc, sample.teamId!);
      return result(team && { ...team, schedule: scoped(team.schedule) });
    }
    case 'listPopup': {
      const list = scoped(await store.getFixtures(rc, sample.range!, signal));
      return popup(list, 'list', list);
    }
    case 'teamSchedule': {
      const team = await store.getTeam(rc, sample.teamId!);
      if (!team) return { value: { team: null, target: null, summary: null }, issues: ['target_missing'] };
      const schedule = scoped(team.schedule);
      const joined = await popup(schedule, 'team', { ...team, schedule });
      if (!canonicalTeamId(team.team.id) || team.team.id !== sample.teamId) joined.issues.push('broken_link');
      return joined;
    }
    case 'playerPopup': {
      const { gameLogDetailInput } = await import('@/components/PlayerGameLog');
      const player = await store.getPlayer(rc, sample.playerId!);
      const row = player?.gameLog.find(row => row.eventId === sample.eventId);
      if (!player || !row) return { value: { player, target: null, summary: null }, issues: ['target_missing'] };
      const target = gameLogDetailInput(row, player.team, source === 'reader');
      if (!target) return { value: { player, target: null, summary: null }, issues: ['broken_link'] };
      const summary = await store.getMatchSummary(rc, row.eventId, target.home.id, target.away.id);
      const index = await boundedIndex(rc, store);
      const slug = index.byProvider.get(sample.playerId!);
      const link = slug ? index.bySlug.get(slug) : undefined;
      return { value: { player, target: { id: row.eventId, ...target }, summary, link: slug ?? null },
        issues: link?.providerId === sample.playerId ? [] : ['broken_link'] };
    }
    case 'leaderLinks': {
      const boards = await store.getLeaders(rc);
      // Await the strict index directly: optional enrichment helpers swallow failures.
      const index = await boundedIndex(rc, store);
      const issues: ScenarioResult['issues'] = [];
      const links = [...boards.scorers, ...boards.assists].map(row => {
        const slug = row.athleteId ? index.byProvider.get(row.athleteId) : undefined;
        if (row.athleteId && (!slug || index.bySlug.get(slug)?.providerId !== row.athleteId)) issues.push('broken_link');
        return { athleteId: row.athleteId, playerSlug: slug ?? null };
      });
      return { value: { boards, links }, issues: [...new Set(issues)] };
    }
    case 'formPopup': {
      const form = await loadStandingsForm(store, rc, signal, new Date(now));
      const joined = await popup(form.matches, 'form', form);
      const team = form.teams[sample.teamId!];
      if (!form.scope) joined.issues.push('unsupported_scope');
      if (Object.values(form.teams).some(value => value.status === 'unavailable')) joined.issues.push('partial');
      if (!team || team.status !== 'available' || !team.results.some(row => row.matchId === sample.eventId)) joined.issues.push('broken_link');
      const match = form.matches.find(row => row.id === sample.eventId);
      if (match && match.home.id !== sample.teamId && match.away.id !== sample.teamId) joined.issues.push('broken_link');
      return joined;
    }
  }
}
