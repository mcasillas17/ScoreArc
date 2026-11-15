/** Recorded/synthetic exercise, not a live parity dataset. No external network. */
import assert from 'node:assert/strict';
import { createPreviewServer } from './reader-preview';
import { parseReaderResources } from '../src/lib/readerResources';
import { decodeReaderStandings } from '../src/server/data/readerDecode';
import phase from '../src/server/data/__fixtures__/leagues-cup-phase-2026.json';
import standings from '../src/server/data/__fixtures__/espn-standings.json';
import mlsStandings from '../src/server/data/__fixtures__/espn-standings-mls-2026.json';
import bracket from '../src/server/data/__fixtures__/espn-bracket.json';
import statistics from '../src/server/data/__fixtures__/espn-statistics.json';
import summary from '../src/server/data/__fixtures__/espn-summary.json';
import athlete from '../src/server/data/__fixtures__/espn-athlete.json';
import overview from '../src/server/data/__fixtures__/espn-athlete-overview.json';
import bio from '../src/server/data/__fixtures__/espn-athlete-bio.json';
import teamIds from '../src/server/data/__fixtures__/liga-mx-team-ids-2026.json';

const WORLD = { competition: 'world-cup', season: '2026' };
const CUP = { competition: 'leagues-cup', season: '2026' };
const phaseMatchId = '401863555';
export const OFFLINE_MANIFEST = {
  version: 1,
  samples: [
    { ...CUP, kind: 'getFixtures', range: '20260804-20260814' },
    { ...CUP, kind: 'getMatches', range: '20260804-20260804' },
    { ...CUP, kind: 'getLiveWindow' },
    { ...CUP, kind: 'getUpcoming', limit: 3 },
    { ...CUP, kind: 'getStandings' },
    { competition: 'mls', season: '2026', kind: 'getStandings' },
    { ...WORLD, kind: 'getBracket' },
    { ...WORLD, kind: 'getMatchSummary', eventId: '760490', homeId: '4789', awayId: '464' },
    { ...WORLD, kind: 'getLeaders' },
    { ...WORLD, kind: 'getTeam', teamId: '202' },
    { ...WORLD, kind: 'getSquad', teamId: '202' },
    { ...WORLD, kind: 'getPlayer', playerId: '297287' },
    { ...CUP, kind: 'listPopup', range: '20260804-20260804', eventId: phaseMatchId },
    { ...CUP, kind: 'formPopup', eventId: phaseMatchId, teamId: '183' },
    { ...WORLD, kind: 'playerPopup', playerId: '297287', eventId: '401877007' },
    { ...WORLD, kind: 'teamSchedule', teamId: '202', eventId: '401877007' },
    { ...WORLD, kind: 'leaderLinks' },
  ],
};

// The toy World Cup index is intentionally two teams, not full competition coverage.
const indexTeams = new Set(['202', '478']);
const indexStandings = { ...standings, children: standings.children.map(group => ({ ...group,
  standings: { ...group.standings, entries: group.standings.entries.filter(row => indexTeams.has(row.team.id)) },
})).filter(group => group.standings.entries.length > 0) };
const syntheticScope = { season: { year: 2026 }, league: { slug: 'fifa.world' } };
const fixedTime = Date.parse('2026-08-15T12:00:00Z');
// Only this explicitly synthetic roster uses the preview's Ali Avila/Argentina membership.
const roster = { ...syntheticScope, athletes: [{ id: '297287', displayName: 'Ali Avila', jersey: '9',
  position: { abbreviation: 'F' }, age: 23, citizenship: 'Mexico', headshot: null }] };
const argentina = { id: '202', displayName: 'Argentina', abbreviation: 'ARG',
  logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/202.png' };
const france = { id: '478', displayName: 'France', abbreviation: 'FRA',
  logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/478.png' };
// A synthetic transport input, not output copied from either adapter.
const scheduleEvent = {
  id: '401877007', date: '2026-07-09T00:00:00Z', league: { slug: 'fifa.world' }, season: { year: 2026 },
  competitions: [{ date: '2026-07-09T00:00:00Z', status: { type: { state: 'in', name: 'STATUS_IN_PROGRESS', shortDetail: "63'" }, displayClock: "63'" },
    competitors: [{ homeAway: 'home', team: argentina, score: { value: 2 } }, { homeAway: 'away', team: france, score: { value: 1 } }], notes: [] }],
};

function providerResponse(url: URL): unknown {
  const path = /^\/apis\/(?:site\/v2|v2|common\/v3)\/sports\/soccer\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!path) throw new Error('Unsupported offline request');
  const [, slug, route] = path;
  if (route === 'scoreboard' && ['concacaf.leagues.cup', 'fifa.world'].includes(slug)) {
    const raw = slug === 'concacaf.leagues.cup' ? phase : bracket;
    const dates = url.searchParams.get('dates');
    return { ...raw, events: raw.events.filter(event => {
      if (!dates) return true;
      const day = event.date.slice(0, 10).replaceAll('-', '');
      if (/^\d{6}$/.test(dates)) return day.startsWith(dates);
      if (/^\d{8}$/.test(dates)) return day === dates;
      return day >= dates.slice(0, 8) && day <= dates.slice(9);
    }) };
  }
  if (route === 'standings') {
    if (slug === 'usa.1') return mlsStandings;
    if (slug === 'fifa.world') return indexStandings;
  }
  if (route === 'statistics' && slug === 'fifa.world') return statistics;
  if (route === 'teams' && slug === 'mex.1') return { sports: [{ leagues: [{ teams: teamIds.map(id => ({ team: { id } })) }] }] };
  if (route === 'summary') {
    if (url.searchParams.get('event') === '760490' && slug === 'fifa.world') return summary;
    if (slug === 'concacaf.leagues.cup' && phase.events.some(event => event.id === url.searchParams.get('event')) ||
        slug === 'fifa.world' && url.searchParams.get('event') === '401877007') return {};
  }
  if (slug === 'fifa.world') {
    if (route === 'athletes/297287') return athlete;
    if (route === 'athletes/297287/overview') return overview;
    if (route === 'athletes/297287/bio') return bio;
    if (route === 'teams/202') return { ...syntheticScope, team: argentina };
    if (/^teams\/[1-9][0-9]*\/roster$/.test(route)) return route === 'teams/202/roster' ? roster : { ...syntheticScope, athletes: [] };
    if (route === 'teams/202/schedule') return { team: argentina, requestedSeason: { year: 2026 },
      events: url.searchParams.get('fixture') === 'true' ? [] : [scheduleEvent] };
  }
  throw new Error('Unsupported offline request');
}

export async function createOfflineEvaluation() {
  const server = createPreviewServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address === 'object');
  const readerOrigin = `http://127.0.0.1:${address.port}`;
  const localFetch = globalThis.fetch;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    init?.signal?.throwIfAborted();
    if (input instanceof Request) input.signal.throwIfAborted();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.username || url.password || url.hash || method !== 'GET') throw new Error('Unsupported offline request');
    if (url.origin === readerOrigin && url.pathname.startsWith('/v1/')) {
      const response = await localFetch(url, init);
      const headers = new Headers(response.headers);
      if (headers.has('X-ScoreArc-Resources')) {
        const evidence = parseReaderResources(headers);
        for (const resource of Object.values(evidence.resources)) {
          if (resource.observedAt !== null) resource.observedAt = new Date(fixedTime).toISOString();
          if (resource.finalizedAt !== null) resource.finalizedAt = new Date(fixedTime).toISOString();
        }
        headers.set('X-ScoreArc-Resources', JSON.stringify(evidence));
        if (headers.has('X-ScoreArc-Observed-At')) headers.set('X-ScoreArc-Observed-At', new Date(fixedTime).toISOString());
      }
      if (response.ok && url.pathname === '/v1/competitions/world-cup/2026/standings') {
        const groups = decodeReaderStandings(await response.json()).map(group => ({ ...group,
          standings: group.standings.filter(row => ['nat-arg', 'nat-fra'].includes(row.team.id)),
        })).filter(group => group.standings.length > 0);
        headers.delete('content-length');
        return Response.json(groups, { status: response.status, headers });
      }
      return new Response(response.body, { status: response.status, headers });
    }
    if (!['https://site.api.espn.com', 'https://site.web.api.espn.com'].includes(url.origin)) throw new Error('Unsupported offline request');
    return Response.json(providerResponse(url));
  };
  return { manifest: OFFLINE_MANIFEST, readerOrigin, fetch: fetcher, now: () => fixedTime,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }) };
}
