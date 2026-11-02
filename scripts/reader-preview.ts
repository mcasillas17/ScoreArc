/**
 * LOCAL SYNTHETIC DATA ONLY. No network dependencies, credentials, or database writes.
 *   npx tsx scripts/reader-preview.ts --self-test
 *   npx tsx scripts/reader-preview.ts --port=4399
 * POST /__test/fault?route=matches (or summary/standings/identities/etc.) enables a 500.
 * POST /__test/fault?route=matches&enabled=false disables it. POST /__test/reset clears
 * faults/counters; GET /__test/state reports bounded counters and the last 100 calls.
 * This intentionally small dataset is browser test evidence, not a production snapshot.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { decodeReaderMatches, decodeReaderStandings, decodeReaderSummary, decodeReaderBracket,
  decodeReaderLeaders, decodeReaderTeam, decodeReaderSquad, decodeReaderPlayer } from '../src/server/data/readerDecode';
import { parseReaderResources, type ReaderResource, type ReaderResourceName, type ReaderResources } from '../src/lib/readerResources';
import { parseMatchFreshness } from '../src/lib/matchFreshness';
import { parseRange } from '../src/server/data/dateRange';
import { resolveSeason } from '../src/server/data/competitions';
import { mapStandings } from '../src/server/data/providers/espn-standings';
import { createReaderDataStore } from '../src/server/data/apiStore';
import { createReaderTransport, createRequestBudget } from '../src/server/data/readerTransport';
import { TtlCache } from '../src/server/data/cache';
import { loadStandingsForm } from '../src/server/data/standingsForm';
import type { Group, Match, Team } from '../src/server/data/types';
import vectors from '../src/server/data/contracts/reader-contract.json';
import derived from '../src/server/data/contracts/derived-standings.json';
import recordedPhase from '../src/server/data/__fixtures__/leagues-cup-phase-2026.json';
import recordedStandings from '../src/server/data/__fixtures__/espn-standings.json';
import teamCrosswalk from '../src/server/data/teamCrosswalk.json';

type Scope = { competitionId: string; seasonId: string };
type MatchReference = Scope & { canonicalId: string; providerId: string; homeId: string; awayId: string };
const wc: Scope = { competitionId: 'world-cup', seasonId: '2026' };
const lc: Scope = { competitionId: 'leagues-cup', seasonId: '2026' };
const scopeKey = (scope: Scope) => `${scope.competitionId}/${scope.seasonId}`;
const providerTeams: Record<string, string> = { ...teamCrosswalk, '131529': 'prov-espn-131529' };
const canonicalTeams = new Map(Object.entries(providerTeams).map(([provider, canonical]) => [canonical, provider]));
function canonicalTeam(id: string): string {
  const result = providerTeams[id];
  assert(result, `Fixture team ${id} needs an explicit crosswalk`);
  return result;
}
const standings = new Map<string, Group[]>([
  ['world-cup/2026', decodeReaderStandings(mapStandings(recordedStandings, 'World Cup').map(group => ({
    ...group, standings: group.standings.map(row => ({ ...row, team: { ...row.team, id: canonicalTeam(row.team.id) } })),
  })))],
  ['mls/2026', decodeReaderStandings(derived.membership.mls.groups)],
  ['liga-mx/2026-apertura', decodeReaderStandings(derived.membership.ligaMx.groups)],
]);
const teams = new Map<string, Team>();
for (const groups of standings.values()) for (const group of groups) for (const row of group.standings) teams.set(row.team.id, row.team);
const references: MatchReference[] = [];
function addReference(scope: Scope, canonicalId: string, providerId: string, homeId: string, awayId: string) {
  assert(!references.some(ref => ref.canonicalId === canonicalId || ref.providerId === providerId));
  references.push({ ...scope, canonicalId, providerId, homeId, awayId });
}
const phaseMatches = decodeReaderMatches(derived.phaseMatches);
// This is the exact ordinal UUID assignment used by the committed Go integration
// fixture, not an identity guessed from names, kickoff times, or scores.
assert.equal(recordedPhase.events.length, phaseMatches.length);
recordedPhase.events.forEach((event, index) => {
  const uuid = `018f0000-0000-7000-8000-${(0x1010000 + index).toString(16).padStart(12, '0')}`;
  const match = phaseMatches.find(row => row.id === uuid);
  assert(match);
  const sides = event.competitions[0].competitors;
  assert.equal(match.home.id, canonicalTeam(sides.find(side => side.homeAway === 'home')!.id));
  assert.equal(match.away.id, canonicalTeam(sides.find(side => side.homeAway === 'away')!.id));
  addReference(lc, uuid, event.id, match.home.id, match.away.id);
  teams.set(match.home.id, match.home); teams.set(match.away.id, match.away);
});
const bracketIDs: Record<string, string> = {
  '760486': '018f0000-0000-7000-8000-000000016011',
  '760503': '018f0000-0000-7000-8000-000000016012',
};
const bracket = decodeReaderBracket([vectors.bracket.frontendFirst, vectors.bracket.frontendPlaceholder].map(raw => {
  const match = { ...raw, id: bracketIDs[raw.id], kickoff: new Date(raw.kickoff).toISOString(),
    home: { ...raw.home, id: canonicalTeam(raw.home.id) }, away: { ...raw.away, id: canonicalTeam(raw.away.id) },
    winnerId: raw.winnerId === null ? null : canonicalTeam(raw.winnerId) };
  addReference(wc, match.id, raw.id, match.home.id, match.away.id);
  const home = { id: match.home.id, name: match.home.name, abbr: match.home.abbr, crestUrl: match.home.crestUrl };
  const away = { id: match.away.id, name: match.away.name, abbr: match.away.abbr, crestUrl: match.away.crestUrl };
  teams.set(home.id, home); teams.set(away.id, away);
  return { slug: raw.round, name: vectors.bracket.readerRoundNames[raw.round as keyof typeof vectors.bracket.readerRoundNames], matches: [match] };
}));
const player = decodeReaderPlayer({ ...vectors.player.reader.profile,
  gameLog: vectors.player.reader.profile.gameLog.map((row, index) => index === 0 ? { ...row, result: '', score: '2-1',
    liveMatch: { state: 'live', homeScore: 2, awayScore: 1, minute: '63', statusDetail: "63'", statusName: 'STATUS_IN_PROGRESS' },
  } : row),
});
const playerRef = vectors.player.reader.identityTranslation;
// Only 401877007 has a shared crosswalk. The four 990000xxx values are explicit
// synthetic provider references for local-only rows; they are not real events.
const logProviderIDs = ['401877007', '990000007', '990000006', '990000005', '990000004'];
const logMatches = decodeReaderMatches(player.gameLog.map((row, index) => {
  assert(row.homeTeamId && row.awayTeamId && row.date);
  addReference(wc, row.eventId, logProviderIDs[index], row.homeTeamId, row.awayTeamId);
  return { id: row.eventId, kickoff: row.date, state: 'finished', minute: null, statusDetail: 'FT', statusName: 'STATUS_FULL_TIME',
    home: teams.get(row.homeTeamId), away: teams.get(row.awayTeamId), homeScore: 2, awayScore: 1,
    ...row.liveMatch, winnerId: row.liveMatch ? null : row.homeTeamId,
    note: 'Synthetic local player game-log fixture', scorers: [], cards: [], shootout: null, shootoutDetail: null, stats: null, winProbability: null };
}));
addReference(wc, vectors.summary.readerMatchId, vectors.summary.eventId, vectors.summary.sides.home.canonicalId, vectors.summary.sides.away.canonicalId);
const storedSummary = decodeReaderSummary({ ...vectors.summary.shared, ...vectors.summary.reader, commentary: [vectors.summary.commentary.first] });
const emptySummary = decodeReaderSummary({ scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
  videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [] });
const worldCupMatches = decodeReaderMatches([...logMatches, ...bracket.flatMap(round => round.matches.map(match => ({
  id: match.id, kickoff: match.kickoff, state: match.state, minute: match.minute, statusDetail: match.statusDetail, statusName: match.statusName,
  home: teams.get(match.home.id), away: teams.get(match.away.id), homeScore: match.homeScore, awayScore: match.awayScore,
  winnerId: match.winnerId, note: match.note, scorers: [], cards: [], shootout: null, shootoutDetail: null, stats: null, winProbability: null,
}))) ]);
const matches = new Map<string, Match[]>([['leagues-cup/2026', phaseMatches], ['world-cup/2026', worldCupMatches]]);
const playerSquad = decodeReaderSquad([{ id: playerRef.providerAthleteId, name: player.name, jersey: 9, position: player.position,
  age: player.age, nationality: player.nationality, headshotUrl: player.headshotUrl, stats: null }]);
const squadFor = (scope: Scope, team: string) => scopeKey(scope) === 'world-cup/2026' && team === 'nat-arg' ? playerSquad : [];
const leaderBoards = {
  goals: decodeReaderLeaders(vectors.leaders.frontend.scorers.map(row => ({ ...row, teamId: canonicalTeam(row.teamId), playerId: null, playerSlug: null }))),
  assists: decodeReaderLeaders(vectors.leaders.frontend.assists.map(row => ({ ...row, teamId: canonicalTeam(row.teamId), playerId: null, playerSlug: null }))),
};

const routeNames = ['matches', 'standings', 'bracket', 'summary', 'leaders', 'teams', 'squad', 'players', 'identities'] as const;
type RouteName = typeof routeNames[number];
const isRoute = (value: string | null): value is RouteName => routeNames.some(route => route === value);
const derivations: Partial<Record<ReaderResourceName, ReaderResource['derivation']>> = {
  identity: 'mixed', detail: 'retained', squad: 'current-roster', bracket: 'derived', gameLog: 'derived', participation: 'derived',
};
function resource(name: ReaderResourceName, scope: ReaderResource['scope'], count?: number): ReaderResource {
  return { status: count === undefined ? 'unavailable' : count === 0 ? 'empty' : 'fresh',
    availability: count === undefined ? 'partial' : count === 0 ? 'empty' : 'complete',
    source: name === 'identity' ? 'mixed' : 'espn', derivation: derivations[name] ?? 'direct', scope,
    observedAt: count === undefined ? null : new Date().toISOString(), finalizedAt: null };
}
const evidence = (...values: [ReaderResourceName, ReaderResource['scope'], number?][]): ReaderResources => ({
  version: 1, resources: Object.fromEntries(values.map(([name, scope, count]) => [name, resource(name, scope, count)])),
});
function identityRows(scope: Scope, kind: string | null, from: string | null, ids: string[]) {
  return ids.map(id => {
    const match = kind === 'match' ? references.find(ref => scopeKey(ref) === scopeKey(scope) && ref[from === 'espn' ? 'providerId' : 'canonicalId'] === id) : undefined;
    const teamID = kind === 'team' ? from === 'espn' ? providerTeams[id] : canonicalTeams.has(id) ? id : undefined : undefined;
    const isPlayer = kind === 'player' && scopeKey(scope) === 'world-cup/2026' && id === (from === 'espn' ? playerRef.providerAthleteId : playerRef.canonicalPlayerId);
    const canonicalId = match?.canonicalId ?? teamID ?? (isPlayer ? playerRef.canonicalPlayerId : null);
    return { id, status: canonicalId === null ? 'missing' : 'resolved', canonicalId,
      providerId: match?.providerId ?? (teamID ? canonicalTeams.get(teamID)! : isPlayer ? playerRef.providerAthleteId : null),
      competitionId: match?.competitionId ?? null, seasonId: match?.seasonId ?? null, homeId: match?.homeId ?? null, awayId: match?.awayId ?? null };
  });
}

function createPreviewServer(): Server {
  const faults = new Set<RouteName>();
  const calls = Object.fromEntries(routeNames.map(name => [name, 0]));
  const recent: { route: RouteName; scope: string; status: number }[] = [];
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    let route: RouteName | undefined;
    let currentScope = '';
    const send = (status: number, body: unknown, resources?: ReaderResources) => {
      const json = JSON.stringify(body);
      assert(Buffer.byteLength(json) <= 2 * 1024 * 1024, 'Local response byte cap');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (resources) {
        res.setHeader('X-ScoreArc-Resources', JSON.stringify(resources));
        const core = resources.resources.matches ?? resources.resources.bracket;
        if (core) {
          res.setHeader('X-ScoreArc-Freshness', core.status);
          if (core.observedAt) res.setHeader('X-ScoreArc-Observed-At', core.observedAt);
          res.setHeader('X-ScoreArc-Poll-Status', 'ok');
          res.setHeader('X-ScoreArc-Stale-Matches', '0');
          res.setHeader('X-ScoreArc-Overdue-Matches', '0');
        }
      }
      if (route) {
        recent.push({ route, scope: currentScope, status });
        if (recent.length > 100) recent.shift();
      }
      res.writeHead(status).end(json);
    };
    try {
      if ((req.url?.length ?? 0) > 4096) return send(414, { error: 'request too long' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__test/state' && req.method === 'GET') return send(200, {
        dataset: 'LOCAL SYNTHETIC FIXTURES: Leagues Cup phase; MLS/Liga MX membership; partial World Cup; synthetic Ali Avila Argentina membership and game-log refs',
        matchReferences: references.length, phaseMatches: phaseMatches.length, faults: [...faults], calls, recent,
      });
      if (url.pathname.startsWith('/__test/')) {
        if (req.method !== 'POST') return send(405, { error: 'POST required' });
        if (url.pathname === '/__test/reset') {
          faults.clear(); recent.length = 0;
          for (const key of routeNames) calls[key] = 0;
          return send(200, { reset: true });
        }
        const name = url.searchParams.get('route');
        if (url.pathname !== '/__test/fault' || !isRoute(name) || ![null, 'true', 'false'].includes(url.searchParams.get('enabled'))) return send(400, { error: 'invalid fault' });
        if (url.searchParams.get('enabled') === 'false') faults.delete(name); else faults.add(name);
        return send(200, { faults: [...faults] });
      }
      if (req.method !== 'GET') return send(405, { error: 'GET required' });
      const summaryPath = /^\/v1\/matches\/([0-9a-f-]{36})$/.exec(url.pathname);
      const scopedPath = /^\/v1\/competitions\/([^/]+)\/([^/]+)\/(matches|standings|bracket|leaders|identities|teams|players)(?:\/([^/]+))?(?:\/(squad))?$/.exec(url.pathname);
      if (!summaryPath && !scopedPath) return send(404, { error: 'unknown local route' });
      route = summaryPath ? 'summary' : scopedPath![5] ? 'squad' : scopedPath![3] as RouteName;
      calls[route]++;
      if (summaryPath) {
        currentScope = 'match';
        if (faults.has(route)) return send(500, { error: 'injected local failure' });
        if (!references.some(ref => ref.canonicalId === summaryPath[1])) return send(404, { error: 'match not found' });
        return send(200, summaryPath[1] === vectors.summary.readerMatchId ? storedSummary : emptySummary,
          evidence(['matches', 'match', 1], ['identity', 'match'], ['detail', 'match'], ['participation', 'match']));
      }
      const scope = { competitionId: scopedPath![1], seasonId: scopedPath![2] };
      currentScope = scopeKey(scope);
      if (!resolveSeason(scope.competitionId, scope.seasonId)) return send(404, { error: 'unknown scope' });
      if (faults.has(route)) return send(500, { error: 'injected local failure' });
      const id = scopedPath![4];
      const scopedMatches = matches.get(currentScope) ?? [];
      const groups = standings.get(currentScope) ?? [];
      if (route === 'identities') {
        const kind = url.searchParams.get('kind'), from = url.searchParams.get('from');
        const ids = (url.searchParams.get('ids') ?? '').split(',');
        const validId = from === 'espn' ? /^[1-9][0-9]{0,31}$/ : kind === 'team'
          ? /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        if (!['match', 'team', 'player'].includes(kind ?? '') || !['canonical', 'espn'].includes(from ?? '') || ids.length > 100 || ids.some(value => value.length > 128 || !validId.test(value))) return send(400, { error: 'invalid identity query' });
        return send(200, identityRows(scope, kind, from, ids), evidence(['identity', 'selection']));
      }
      if (route === 'matches') {
        const range = url.searchParams.get('range') ?? '';
        const state = url.searchParams.get('state');
        const limit = url.searchParams.get('limit');
        const detail = url.searchParams.get('detail');
        if (!parseRange(range) || ![null, 'scheduled', 'live', 'finished'].includes(state) || ![null, 'summary'].includes(detail) || (limit !== null && (!/^[1-9][0-9]*$/.test(limit) || +limit > 100))) return send(400, { error: 'invalid match query' });
        const rows = scopedMatches.filter(match => {
          const day = match.kickoff.slice(0, 10).replaceAll('-', '');
          return day >= range.slice(0, 8) && day <= range.slice(9) && (state === null || match.state === state);
        }).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id)).slice(0, limit === null ? undefined : +limit);
        const resources = evidence(['matches', 'selection', rows.length], ['identity', 'competition-season']);
        if (detail) resources.resources.detail = resource('detail', 'competition-season');
        return send(200, rows, resources);
      }
      if (route === 'standings') return send(200, groups, evidence(['standings', 'competition-season', groups.reduce((n, group) => n + group.standings.length, 0)], ['identity', 'competition-season']));
      if (route === 'bracket') {
        const rows = currentScope === 'world-cup/2026' ? bracket : [];
        return send(200, rows, evidence(['bracket', 'competition-season', rows.flatMap(round => round.matches).length], ['identity', 'competition-season']));
      }
      if (route === 'leaders') {
        const metric = url.searchParams.get('metric') ?? 'goals';
        const limit = url.searchParams.get('limit') ?? '10';
        if ((metric !== 'goals' && metric !== 'assists') || !/^[1-9][0-9]*$/.test(limit) || +limit > 30) return send(400, { error: 'invalid leader query' });
        const rows = currentScope === 'world-cup/2026' ? leaderBoards[metric].slice(0, +limit) : [];
        return send(200, rows, evidence(['leaders', 'competition-season', rows.length], ['identity', 'competition-season']));
      }
      if (route === 'players') {
        if (currentScope !== 'world-cup/2026' || id !== player.id) return send(404, { error: 'player not found' });
        return send(200, player, evidence(['identity', 'player'], ['seasonStats', 'player-season'], ['career', 'player'], ['gameLog', 'player-season'], ['participation', 'selection']));
      }
      const team = teams.get(id);
      if (!team) return send(404, { error: 'team not found' });
      const squad = squadFor(scope, id);
      if (route === 'squad') return send(200, squad, evidence(['identity', 'team-season'], ['squad', 'team-season', squad.length], ['seasonStats', 'team-season']));
      const schedule = scopedMatches.filter(match => match.home.id === id || match.away.id === id).map(match => ({ ...match, scope }));
      const body = decodeReaderTeam({ team, location: null, color: null, altColor: null, record: null, standing: null,
        standingSummary: null, squad, schedule, scheduleAvailability: { results: 'available', upcoming: 'available' } });
      return send(200, body, evidence(['identity', 'team-season'], ['matches', 'team-season', schedule.length], ['detail', 'team-season'],
        ['standings', 'competition-season'], ['squad', 'team-season', squad.length], ['seasonStats', 'team-season']));
    } catch {
      send(500, { error: 'local fixture validation failed' });
    }
  });
  server.maxRequestsPerSocket = 100;
  return server;
}

async function selfTest() {
  const server = createPreviewServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const read = async (path: string) => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const metadata = parseReaderResources(response.headers);
    if (metadata.resources.matches || metadata.resources.bracket) parseMatchFreshness(response.headers);
    return response.json();
  };
  try {
    const phase = decodeReaderMatches(await read('/v1/competitions/leagues-cup/2026/matches?range=20260804-20260814&detail=summary'));
    assert.equal(phase.length, 54);
    assert.equal(decodeReaderMatches(await read('/v1/competitions/leagues-cup/2026/matches?range=20260804-20260804&limit=1')).length, 1);
    assert.equal(decodeReaderMatches(await read('/v1/competitions/leagues-cup/2026/matches?range=20260804-20260814&state=scheduled')).length, 0);
    for (const path of ['mls/2026', 'liga-mx/2026-apertura', 'world-cup/2026']) {
      assert(decodeReaderStandings(await read(`/v1/competitions/${path}/standings`)).length > 0);
    }
    assert(decodeReaderBracket(await read('/v1/competitions/world-cup/2026/bracket')).some(round => round.matches.some(match => match.away.placeholder)));
    for (const metric of ['goals', 'assists']) assert.equal(decodeReaderLeaders(await read(`/v1/competitions/world-cup/2026/leaders?metric=${metric}&limit=10`)).length, 10);
    assert.equal(decodeReaderTeam(await read('/v1/competitions/world-cup/2026/teams/nat-arg')).team.id, 'nat-arg');
    assert.equal(decodeReaderSquad(await read('/v1/competitions/world-cup/2026/teams/nat-arg/squad'))[0].id, '297287');
    const player = decodeReaderPlayer(await read('/v1/competitions/world-cup/2026/players/01890000-0000-7000-8000-000000000444'));
    assert.equal(player.gameLog.length, 5);
    assert.equal(player.gameLog[0].liveMatch?.state, 'live');
    assert.equal(player.career[1].teamId, null);
    decodeReaderSummary(await read(`/v1/matches/${player.gameLog[0].eventId}`));
    decodeReaderSummary(await read('/v1/matches/018f0000-0000-7000-8000-000000016001'));
    const refs = await read(`/v1/competitions/leagues-cup/2026/identities?kind=match&from=canonical&ids=${phase[0].id}`);
    assert.equal(refs[0].canonicalId, phase[0].id);
    assert.equal(refs[0].homeId, phase[0].home.id);
    const reverse = await read(`/v1/competitions/leagues-cup/2026/identities?kind=match&from=espn&ids=${refs[0].providerId}`);
    assert.equal(reverse[0].canonicalId, refs[0].canonicalId);

    // Exercise the actual adapter against this local HTTP surface as well as
    // the decoders: this catches semantically mismatched scope/side metadata.
    const signal = AbortSignal.timeout(10_000);
    const budget = createRequestBudget({ signal });
    const store = createReaderDataStore({ read: createReaderTransport(base, budget, signal), cache: new TtlCache(),
      cacheNamespace: 'local-preview-self-test', signal, news: async () => [] });
    const worldCup = resolveSeason('world-cup', '2026')!;
    const leaguesCup = resolveSeason('leagues-cup', '2026')!;
    const before = budget.calls;
    const cold = await store.getStandings(leaguesCup);
    const coldCalls = budget.calls - before;
    const warmStart = budget.calls;
    const warm = await store.getStandings(leaguesCup);
    const warmCalls = budget.calls - warmStart;
    assert.equal(cold.length, 2);
    assert.equal(cold[0].readerDerivation?.status, 'complete');
    assert.deepEqual(warm.map(group => group.standings), cold.map(group => group.standings));
    assert.equal(coldCalls, 4);
    assert.equal(warmCalls, 2);
    assert.equal((await store.getStandings(resolveSeason('mls', '2026')!)).length, 3);
    assert.equal((await store.getMatches(leaguesCup, '20260804-20260814')).length, 54);
    assert.equal((await store.getFixtures(leaguesCup, '20260804-20260814')).length, 54);
    await store.getLiveWindow(leaguesCup);
    await store.getUpcoming(leaguesCup);
    const rounds = await store.getBracket(worldCup);
    assert.equal(rounds[0].matches[0].id, '760486');
    await store.getMatchSummary(worldCup, '760486', '467', '206');
    assert.equal((await store.getLeaders(worldCup)).assists.length, 10);
    assert.equal((await store.getTeam(worldCup, '202'))?.team.id, '202');
    assert.equal((await store.getSquad(worldCup, '202'))[0].id, playerRef.providerAthleteId);
    const translatedPlayer = await store.getPlayer(worldCup, playerRef.providerAthleteId);
    assert.equal(translatedPlayer?.gameLog[0].eventId, playerRef.providerEventId);
    assert.equal(translatedPlayer?.gameLog[0].liveMatch?.homeScore, 2);
    assert.equal(translatedPlayer?.career[1].teamId, null);
    await store.getMatchSummary(worldCup, playerRef.providerEventId, '202', '478');
    const form = await loadStandingsForm(store, leaguesCup);
    assert.equal(form.scope, 'phase');
    assert.equal(form.matches.length, 54);
    assert(Object.values(form.teams).every(team => team.status === 'available'));
    const selected = form.matches[0];
    await store.getMatchSummary(leaguesCup, selected.id, selected.home.id, selected.away.id);

    assert.equal((await fetch(`${base}/__test/fault?route=matches`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/v1/competitions/leagues-cup/2026/matches?range=20260804-20260814`)).status, 500);
    assert.equal((await fetch(`${base}/__test/reset`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/v1/competitions/leagues-cup/2026/matches?range=20260804-20260814`)).status, 200);
    assert.equal((await fetch(`${base}/__test/fault?route=matches`)).status, 405);
    assert.equal((await fetch(`${base}/v1/competitions/world-cup/2026/identities?kind=match&from=espn&ids=${Array(101).fill('1').join(',')}`)).status, 400);
    console.log(`Reader preview self-test passed: all DTOs and mapped adapter methods, metadata, identity round trips, query filters, and injected failure. Leagues Cup cold/warm calls: ${coldCalls}/${warmCalls}; adapter total: ${budget.calls} calls, ${budget.bytes} bytes.`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const arg = process.argv.slice(2);
  assert(arg.length <= 1 && (arg.length === 0 || /^--port=[1-9][0-9]*$/.test(arg[0])), 'Use --self-test or --port=4399');
  const port = arg.length ? Number(arg[0].slice('--port='.length)) : 4399;
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'Invalid port');
  const server = createPreviewServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`LOCAL SYNTHETIC reader listening at http://127.0.0.1:${port}; counters at /__test/state`));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
