import { describe, expect, it } from 'vitest';
import { createReaderDataStore } from './apiStore';
import { createDataStore, type DataStore } from './store';
import { createSelectedDataStore, runDataOperation, type SourceContext } from './sourceSelection';
import { createReaderTransport, type ReaderResponse, type RequestBudget } from './readerTransport';
import { resolveSeason } from './competitions';
import { TtlCache } from './cache';
import { loadStandingsForm } from './standingsForm';
import type { ReaderResource, ReaderResourceName, ReaderResources } from '@/lib/readerResources';
import type { MatchSummaryData } from './types';
import derived from './contracts/derived-standings.json';
import vectors from './contracts/reader-contract.json';
import espnSummary from './__fixtures__/espn-summary.json';

const initialTime = Date.parse('2026-08-10T12:00:00Z');
const cup = resolveSeason('leagues-cup', '2026')!;
const worldCup = resolveSeason('world-cup', '2026')!;
const heldMatch = derived.phaseMatches[0];
const playerVector = vectors.player.reader;
const scopes = {
  matches: { matches: 'selection', identity: 'competition-season' },
  summary: { matches: 'match', identity: 'match', detail: 'match', participation: 'match' },
  player: { identity: 'player', seasonStats: 'player-season', career: 'player', gameLog: 'player-season', participation: 'selection' },
} as const;
type ResourceScopes = Partial<Record<ReaderResourceName, ReaderResource['scope']>>;
function evidence(names: ResourceScopes, at = initialTime): ReaderResources {
  const resources: ReaderResources['resources'] = {};
  for (const [key, scope] of Object.entries(names)) {
    const name = key as ReaderResourceName;
    const unknown = ['identity', 'detail', 'seasonStats', 'career', 'gameLog', 'participation'].includes(name);
    resources[name] = {
      status: unknown ? 'unavailable' : 'fresh', availability: unknown ? 'partial' : 'complete',
      source: name === 'identity' ? 'mixed' : 'espn',
      derivation: name === 'identity' ? 'mixed' : name === 'detail' ? 'retained' : name === 'squad' ? 'current-roster'
        : ['bracket', 'gameLog', 'participation'].includes(name) ? 'derived' : 'direct',
      scope, observedAt: unknown ? null : new Date(at).toISOString(), finalizedAt: null,
    };
  }
  return { version: 1, resources };
}
function wire(body: unknown, names: ResourceScopes, metadata = evidence(names)) {
  return Response.json(body, { headers: {
    'X-ScoreArc-Resources': JSON.stringify(metadata), 'X-ScoreArc-Freshness': 'fresh',
    'X-ScoreArc-Poll-Status': 'ok', 'X-ScoreArc-Observed-At': new Date(initialTime).toISOString(),
    'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0',
  } });
}
const fallbackSummary: MatchSummaryData = { scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
  videos: [], shootoutDetail: null, info: null, form: null, commentary: [{ minute: '', text: 'ESPN detail' }], h2h: [] };
function fallback(methods: Partial<DataStore> = {}): DataStore {
  return { ...createDataStore({ fetchJson: async () => { throw new Error('unexpected ESPN request'); }, cache: new TtlCache() }), ...methods };
}
// Synthetic retained detail: unknown participation is separate from a final score.
function retainedSummary(home: string, away: string) {
  return { ...fallbackSummary, commentary: [], lineups: { availability: 'partial',
    home: { teamId: home, formation: '', players: [{ name: 'Unknown starter', number: null, position: '', jersey: null,
      starter: null, stats: null, athleteId: null, playerId: null, playerSlug: null }] },
    away: { teamId: away, formation: '', players: [] },
  } };
}

type Override = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;
function scenario(mode: 'list' | 'player', override?: Override) {
  let time = initialTime;
  const calls: URL[] = [];
  const cache = new TtlCache<ReaderResponse>(() => time);
  const rc = mode === 'list' ? cup : worldCup;
  // Explicit synthetic persisted references; first player row is the shared Go crosswalk vector.
  const references = mode === 'list'
    ? [{ canonicalId: heldMatch.id, providerId: '701000001', homeId: heldMatch.home.id, awayId: heldMatch.away.id }]
    : playerVector.profile.gameLog.map((row, i) => ({ canonicalId: row.eventId,
      providerId: i === 0 ? playerVector.identityTranslation.providerEventId : `70100000${i + 2}`,
      homeId: row.homeTeamId, awayId: row.awayTeamId }));
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    const custom = await override?.(url, init); if (custom) return custom;
    if (url.origin !== 'https://reader.test') throw new Error('Unexpected upstream origin');
    if (url.pathname.endsWith('/identities')) {
      const kind = url.searchParams.get('kind');
      const from = url.searchParams.get('from');
      const ids = url.searchParams.get('ids')!.split(',');
      const rows = ids.map(id => {
        const found = kind === 'player'
          ? { canonicalId: playerVector.identityTranslation.canonicalPlayerId, providerId: playerVector.identityTranslation.providerAthleteId }
          : references.find(row => (from === 'canonical' ? row.canonicalId : row.providerId) === id);
        if (!found) throw new Error('Unexpected synthetic identity');
        return { id, status: 'resolved', canonicalId: found.canonicalId, providerId: found.providerId,
          competitionId: kind === 'match' ? rc.competition.id : null, seasonId: kind === 'match' ? rc.season.id : null,
          homeId: 'homeId' in found ? found.homeId : null, awayId: 'awayId' in found ? found.awayId : null };
      });
      return wire(rows, { identity: 'selection' });
    }
    if (url.pathname.endsWith('/matches')) return wire([heldMatch], scopes.matches);
    if (url.pathname.includes('/players/')) return wire(playerVector.profile, scopes.player);
    const match = references.find(row => url.pathname === `/v1/matches/${row.canonicalId}`);
    if (match) return wire(retainedSummary(match.homeId, match.awayId), scopes.summary);
    throw new Error('Unexpected reader route');
  };
  const make = (espn = fallback(), source: 'reader' | 'espn' = 'reader', fallbackFactory?: (context: SourceContext) => DataStore) => createSelectedDataStore({ source, espn, fetch: fetcher,
    reader: ({ signal, budget }) => createReaderDataStore({ signal, cache, cacheNamespace: 'https://reader.test',
      read: createReaderTransport('https://reader.test', budget, signal), now: () => time, news: espn.getNews }),
    fallback: fallbackFactory ?? (() => espn),
  });
  return { calls, cache, make, rc, advance: (ms: number) => { time += ms; } };
}

describe('reader identity navigation across requests', () => {
  it('joins T7.3 badges to normalized standings and opens their popup on a separate instance', async () => {
    // The derived-standings vector is an actual reader body; these explicit test
    // refs model its resolver-assigned IDs without guessing from match content.
    const refs = new Map(derived.phaseMatches.map((match, index) => [match.id, String(900000000 + index)]));
    const responses: Override = url => {
      if (url.pathname.endsWith('/matches')) return wire(derived.phaseMatches, scopes.matches);
      if (url.pathname.endsWith('/standings')) return wire(
        url.pathname.includes('/mls/') ? derived.membership.mls.groups : derived.membership.ligaMx.groups,
        { standings: 'competition-season', identity: 'competition-season' },
      );
      if (url.pathname.endsWith('/identities') && url.searchParams.get('kind') === 'match') {
        const from = url.searchParams.get('from');
        return wire(url.searchParams.get('ids')!.split(',').map(id => {
          const match = derived.phaseMatches.find(row => (from === 'canonical' ? row.id : refs.get(row.id)) === id)!;
          return { id, status: 'resolved', canonicalId: match.id, providerId: refs.get(match.id),
            competitionId: 'leagues-cup', seasonId: '2026', homeId: match.home.id, awayId: match.away.id };
        }), { identity: 'selection' });
      }
      const match = derived.phaseMatches.find(row => url.pathname === `/v1/matches/${row.id}`);
      return match ? wire(retainedSummary(match.home.id, match.away.id), scopes.summary) : undefined;
    };
    const tableRequest = scenario('list', responses);
    const tables = await tableRequest.make().getStandings(cup);
    const formRequest = scenario('list', responses);
    const form = await loadStandingsForm(formRequest.make(), cup, undefined, new Date('2026-08-15T12:00:00Z'));
    const team = tables.flatMap(group => group.standings)[0].team;
    const entry = form.teams[team.id];
    expect(entry.status).toBe('available');
    if (entry.status !== 'available') throw new Error('Expected a held badge');
    const match = form.matches.find(row => row.id === entry.results[0].matchId)!;
    expect([match.home.id, match.away.id]).toContain(team.id);
    const detailRequest = scenario('list', responses);
    const detail = await detailRequest.make().getMatchSummary(cup, match.id, match.home.id, match.away.id);
    expect(detail.lineups).toMatchObject({ home: { teamId: match.home.id }, away: { teamId: match.away.id } });
    expect(tableRequest.calls).toHaveLength(4);
    expect(formRequest.calls).toHaveLength(6);
    expect(detailRequest.calls).toHaveLength(2);
  });

  it('opens a list row on a cold instance without a shared identity map', async () => {
    const first = scenario('list');
    const [match] = await first.make().getFixtures(cup, '20260804-20260814');
    expect(match).toMatchObject({ id: '701000001', home: { id: '183' }, away: { id: '216' } });
    const second = scenario('list');
    const detail = await second.make().getMatchSummary(cup, match.id, match.home.id, match.away.id);
    expect(detail.lineups).toMatchObject({ availability: 'partial', home: { teamId: '183', players: [{ starter: null }] }, away: { teamId: '216' } });
    expect(second.calls.map(url => url.pathname)).toEqual([
      '/v1/competitions/leagues-cup/2026/identities', `/v1/matches/${heldMatch.id}`,
    ]);
    expect(second.calls[0].searchParams.get('ids')).toBe('701000001');
  });

  it('keeps a previously returned list row usable after reader failure and rollback', async () => {
    const [match] = await scenario('list').make().getFixtures(cup, '20260804-20260814');
    const received: string[][] = [];
    const espn = fallback({ getMatchSummary: async (_rc, id, home, away) => { received.push([id, home, away]); return fallbackSummary; } });
    const broken = scenario('list', url => url.pathname.startsWith('/v1/matches/') ? new Response(null, { status: 503 }) : undefined);
    expect(await broken.make(espn).getMatchSummary(cup, match.id, match.home.id, match.away.id)).toEqual(fallbackSummary);
    const rollback = scenario('list');
    expect(await rollback.make(espn, 'espn').getMatchSummary(cup, match.id, match.home.id, match.away.id)).toEqual(fallbackSummary);
    expect(received).toEqual([['701000001', '183', '216'], ['701000001', '183', '216']]);
    expect(rollback.calls).toHaveLength(0);
  });

  it('opens a player game-log row on a separate instance and after rollback', async () => {
    const player = await scenario('player').make().getPlayer(worldCup, playerVector.identityTranslation.providerAthleteId);
    expect(player).toMatchObject({ id: '297287', team: { id: '202' }, career: [{ teamId: '202' }, { teamId: null }] });
    const game = player!.gameLog[0];
    expect(game).toMatchObject({ eventId: '401877007', homeTeamId: '202', awayTeamId: '478', teamId: '478', opponent: { id: '202' } });
    const cold = scenario('player');
    const detail = await cold.make().getMatchSummary(worldCup, game.eventId, game.homeTeamId!, game.awayTeamId!);
    expect(detail.lineups).toMatchObject({ home: { teamId: '202' }, away: { teamId: '478' } });
    const received: string[][] = [];
    const espn = fallback({ getMatchSummary: async (_rc, ...ids) => { received.push(ids); return fallbackSummary; } });
    const rollback = scenario('player');
    await rollback.make(espn, 'espn').getMatchSummary(worldCup, game.eventId, game.homeTeamId!, game.awayTeamId!);
    expect(received).toEqual([['401877007', '202', '478']]);
    expect(rollback.calls).toHaveLength(0);
  });

  it('measures cold and warm fallback transport cost without caching fallback as reader data', async () => {
    const test = scenario('list', url => url.origin === 'https://site.api.espn.com' ? Response.json(espnSummary)
      : url.pathname.startsWith('/v1/matches/') ? new Response(null, { status: 503 }) : undefined);
    const espnCache = new TtlCache<unknown>();
    const budgets: RequestBudget[] = [];
    const store = test.make(fallback(), 'reader', ({ signal, budget }) => {
      budgets.push(budget);
      return createDataStore({ cache: espnCache, propagateUnavailable: true,
        fetchJson: async url => (await budget.json(url, signal)).body });
    });
    await store.getMatchSummary(cup, '701000001', '183', '216');
    expect(test.calls).toHaveLength(3); // identity + failed reader summary + ESPN summary
    expect(budgets[0].calls).toBe(3);
    expect(budgets[0].bytes).toBeGreaterThan(JSON.stringify(espnSummary).length);
    await store.getMatchSummary(cup, '701000001', '183', '216');
    expect(test.calls).toHaveLength(5); // reader revalidates; only ESPN owns its cached result
    expect(budgets[1].calls).toBe(2);
    expect(budgets[1].bytes).toBeLessThan(budgets[0].bytes);
    expect(test.calls.filter(url => url.origin === 'https://site.api.espn.com')).toHaveLength(1);
  });

  it('rejects caller side reversal without an ESPN fallback or detail request', async () => {
    let fallbacks = 0;
    const test = scenario('list');
    await expect(test.make(fallback({ getMatchSummary: async () => { fallbacks++; return fallbackSummary; } }))
      .getMatchSummary(cup, '701000001', '216', '183')).rejects.toMatchObject({ reason: 'scope', fallback: false });
    expect(fallbacks).toBe(0); expect(test.calls).toHaveLength(1);
  });

  it('rejects a canonical UUID before addressing either provider-number path', async () => {
    let fallbacks = 0;
    const test = scenario('list');
    await expect(test.make(fallback({ getMatchSummary: async () => { fallbacks++; return fallbackSummary; } }))
      .getMatchSummary(cup, heldMatch.id, '183', '216')).rejects.toMatchObject({ reason: 'identity', fallback: false });
    expect(fallbacks).toBe(0); expect(test.calls).toHaveLength(0);
  });

  it('rejects schema-valid crosswalk rows for another competition', async () => {
    const test = scenario('list', url => url.pathname.endsWith('/identities') ? wire([{
      id: '701000001', status: 'resolved', canonicalId: heldMatch.id, providerId: '701000001',
      competitionId: 'world-cup', seasonId: '2026', homeId: heldMatch.home.id, awayId: heldMatch.away.id,
    }], { identity: 'selection' }) : undefined);
    await expect(test.make().getMatchSummary(cup, '701000001', '183', '216')).rejects.toMatchObject({ reason: 'scope', fallback: false });
    expect(test.calls).toHaveLength(1);
  });
});

describe('reader identity absence and retained optional data', () => {
  it.each(['missing', 'ambiguous'])('keeps a career club unlinked when its optional mapping is %s', async status => {
    const body = { ...playerVector.profile, career: playerVector.profile.career.map((row, index) => index === 1 ? { ...row, teamId: 'unlinked-fc' } : row) };
    const test = scenario('player', url => {
      if (url.pathname.includes('/players/')) return wire(body, scopes.player);
      if (url.searchParams.get('kind') === 'team') return wire([{
        id: 'unlinked-fc', status, canonicalId: null, providerId: null, competitionId: null, seasonId: null, homeId: null, awayId: null,
      }], { identity: 'selection' });
    });
    const profile = await test.make().getPlayer(worldCup, '297287');
    expect(profile?.id).toBe('297287');
    expect(profile?.career[1]).toEqual({ ...body.career[1], teamId: null });
    expect(profile?.gameLog[0].eventId).toBe(playerVector.identityTranslation.providerEventId);
  });

  it('preserves source-qualified canonical player references without making them popup addresses', async () => {
    const body = retainedSummary(heldMatch.home.id, heldMatch.away.id);
    const withPlayer = { ...body, lineups: { ...body.lineups, home: { ...body.lineups.home,
      players: body.lineups.home.players.map(row => ({ ...row, playerId: playerVector.identityTranslation.canonicalPlayerId })) } } };
    const test = scenario('list', url => url.pathname.startsWith('/v1/matches/') ? wire(withPlayer, scopes.summary) : undefined);
    const summary = await test.make().getMatchSummary(cup, '701000001', '183', '216');
    expect(summary.lineups?.home.players[0]).toMatchObject({ playerId: playerVector.identityTranslation.canonicalPlayerId, playerSlug: null, athleteId: null });
    expect(test.calls.at(-1)?.pathname).toBe(`/v1/matches/${heldMatch.id}`);
  });

  it('falls back the entire collection when only one returned match lacks a mapping', async () => {
    const test = scenario('list', url => {
      if (url.pathname.endsWith('/matches')) return wire(derived.phaseMatches.slice(0, 2), scopes.matches);
      if (!url.pathname.endsWith('/identities')) return undefined;
      return wire(url.searchParams.get('ids')!.split(',').map((id, index) => index === 0
        ? { id, status: 'resolved', canonicalId: id, providerId: '701000001', competitionId: 'leagues-cup', seasonId: '2026', homeId: heldMatch.home.id, awayId: heldMatch.away.id }
        : { id, status: 'missing', canonicalId: null, providerId: null, competitionId: null, seasonId: null, homeId: null, awayId: null }),
      { identity: 'selection' });
    });
    let fallbacks = 0;
    const rows = await test.make(fallback({ getFixtures: async () => {
      fallbacks++;
      return [{ ...heldMatch, state: 'finished', id: '777', home: { ...heldMatch.home, id: '183' }, away: { ...heldMatch.away, id: '216' }, winnerId: '183' }];
    } })).getFixtures(cup, '20260804-20260814');
    expect(rows.map(row => row.id)).toEqual(['777']);
    expect(fallbacks).toBe(1);
  });

  it.each(['missing', 'ambiguous'])('does not resurrect an addressed player with %s identity', async status => {
    let fallbackCalls = 0;
    const test = scenario('player', url => url.pathname.endsWith('/identities') ? wire([{
      id: '297287', status, canonicalId: null, providerId: null, competitionId: null, seasonId: null, homeId: null, awayId: null,
    }], { identity: 'selection' }) : undefined);
    await expect(test.make(fallback({ getPlayer: async () => { fallbackCalls++; return null; } })).getPlayer(worldCup, '297287'))
      .rejects.toMatchObject({ reason: 'identity', fallback: false });
    expect(fallbackCalls).toBe(0); expect(test.calls).toHaveLength(1);
  });

  it('preserves an established profile 404 while a known match detail 404 may fall back', async () => {
    let profileFallbacks = 0;
    const missingProfile = scenario('player', url => url.pathname.includes('/players/') ? new Response(null, { status: 404 }) : undefined);
    expect(await missingProfile.make(fallback({ getPlayer: async () => { profileFallbacks++; return null; } })).getPlayer(worldCup, '297287')).toBeNull();
    expect(profileFallbacks).toBe(0);
    let summaryFallbacks = 0;
    const missingDetail = scenario('list', url => url.pathname.startsWith('/v1/matches/') ? new Response(null, { status: 404 }) : undefined);
    expect(await missingDetail.make(fallback({ getMatchSummary: async () => { summaryFallbacks++; return fallbackSummary; } }))
      .getMatchSummary(cup, '701000001', '183', '216')).toEqual(fallbackSummary);
    expect(summaryFallbacks).toBe(1);
  });

  it('keeps legacy unknown optional observations and nullable career links on warm cache reuse', async () => {
    const test = scenario('player');
    const first = await test.make().getPlayer(worldCup, '297287');
    const coldCalls = test.calls.length;
    test.advance(1000);
    const second = await test.make().getPlayer(worldCup, '297287');
    expect(second).toEqual(first);
    expect(second!.readerResources?.resources.career).toMatchObject({ status: 'unavailable', observedAt: null });
    expect(second!.career[1].teamId).toBeNull();
    expect(coldCalls).toBe(3); expect(test.calls.length - coldCalls).toBe(2);
    expect(test.calls.filter(url => url.pathname.includes('/players/'))).toHaveLength(1);
  });

  it('keeps unlinked game-log context null rather than fabricating popup sides', async () => {
    const body = { ...playerVector.profile, gameLog: [{ ...playerVector.profile.gameLog[0],
      homeTeamId: null, awayTeamId: null, teamId: null, opponent: null }] };
    const test = scenario('player', url => url.pathname.includes('/players/') ? wire(body, scopes.player) : undefined);
    const player = await test.make().getPlayer(worldCup, '297287');
    expect(player!.gameLog[0]).toMatchObject({ eventId: '401877007', homeTeamId: null, awayTeamId: null, teamId: null, opponent: null });
  });

  it('rejects a schema-valid player game log whose opponent is its own team', async () => {
    const body = { ...playerVector.profile, gameLog: [{ ...playerVector.profile.gameLog[0], teamId: 'nat-arg' }] };
    const test = scenario('player', url => url.pathname.includes('/players/') ? wire(body, scopes.player) : undefined);
    await expect(test.make().getPlayer(worldCup, '297287')).rejects.toMatchObject({ reason: 'scope', fallback: false });
  });

  it('ages optional evidence while retaining useful cached player identity', async () => {
    const test = scenario('player', url => {
      if (!url.pathname.includes('/players/')) return undefined;
      const metadata = evidence(scopes.player);
      metadata.resources.career = { ...metadata.resources.career!, status: 'fresh', availability: 'complete',
        observedAt: new Date(initialTime - 32 * 86_400_000 + 1000).toISOString() };
      return wire(playerVector.profile, scopes.player, metadata);
    });
    const first = await test.make().getPlayer(worldCup, '297287');
    expect(first!.readerResources?.resources.career?.status).toBe('fresh');
    test.advance(2000);
    const second = await test.make().getPlayer(worldCup, '297287');
    expect(second!.readerResources?.resources.career?.status).toBe('stale');
    expect(second!.career).toEqual(first!.career);
    expect(test.calls.filter(url => url.pathname.includes('/players/'))).toHaveLength(1);
  });

  it('does not keep a semantically mismatched profile in its source cache', async () => {
    let profiles = 0;
    const test = scenario('player', url => {
      if (!url.pathname.includes('/players/')) return undefined;
      profiles++;
      return wire(profiles === 1 ? { ...playerVector.profile, id: '01890000-0000-7000-8000-000000000999' } : playerVector.profile, scopes.player);
    });
    await expect(test.make().getPlayer(worldCup, '297287')).rejects.toMatchObject({ reason: 'identity', fallback: false });
    expect(await test.make().getPlayer(worldCup, '297287')).toMatchObject({ id: '297287' });
    expect(profiles).toBe(2);
  });
});

describe('reader navigation cancellation and failure budgets', () => {
  it('does not start fallback when a caller cancels an in-flight reader request', async () => {
    let started!: () => void;
    const onStart = new Promise<void>(resolve => { started = resolve; });
    let requestSignal: AbortSignal | undefined;
    let fallbackCalls = 0;
    const test = scenario('list', async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      started();
      return new Promise<Response>(() => {});
    });
    const controller = new AbortController();
    const reason = new Error('caller left');
    const pending = test.make(fallback({ getFixtures: async () => { fallbackCalls++; return []; } }))
      .getFixtures(cup, '20260804-20260814', controller.signal);
    await onStart; controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true); expect(fallbackCalls).toBe(0);
  });

  it('propagates both-source failure instead of returning an empty summary', async () => {
    let fallbacks = 0;
    const test = scenario('list', url => url.pathname.startsWith('/v1/matches/') ? new Response(null, { status: 503 }) : undefined);
    const unavailable = new Error('ESPN unavailable');
    await expect(test.make(fallback({ getMatchSummary: async () => { fallbacks++; throw unavailable; } }))
      .getMatchSummary(cup, '701000001', '183', '216')).rejects.toBe(unavailable);
    expect(fallbacks).toBe(1); expect(test.calls).toHaveLength(2);
  });

  it('cancels a player operation before any profile or fallback work can start', async () => {
    const test = scenario('player');
    let fallbacks = 0;
    const store = test.make(fallback({ getPlayer: async () => { fallbacks++; return null; } }));
    await expect(runDataOperation(store, source => source.getPlayer(worldCup, '297287'), AbortSignal.abort()))
      .rejects.toBeDefined();
    expect(test.calls).toHaveLength(0); expect(fallbacks).toBe(0);
  });
});
