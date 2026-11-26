import { isISOInstant, parseMatchFreshness } from '../src/lib/matchFreshness.ts';
import { parsePollEvidence } from './match-freshness-policy.mjs';

export const MAX_SCOPES = 32;
const MAX_MATCHES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30000;
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scopeKey(scope) {
  if (!scope || typeof scope.competition !== 'string' || typeof scope.season !== 'string' ||
      !idPattern.test(scope.competition) || !idPattern.test(scope.season)) {
    throw new Error('Invalid competition/season scope');
  }
  return `${scope.competition}/${scope.season}`;
}

export function currentScopes(registry) {
  if (!Array.isArray(registry) || !registry.length) throw new Error('Invalid scope registry');
  const scopes = [];
  for (const comp of registry) {
    if (!idPattern.test(comp.id) || typeof comp.id !== 'string' || !comp.seasons ||
        (comp.currentSeasonId && comp.seasons[comp.currentSeasonId]?.id !== comp.currentSeasonId)) throw new Error('Invalid current season');
    for (const [id, season] of Object.entries(comp.seasons)) {
      if (!season.monitored) continue;
      if (id !== season.id || season.publication !== 'live' || !season.resources?.includes('scores')) throw new Error('Invalid monitored edition');
      scopes.push({ competition: comp.id, season: id });
    }
  }
  if (!scopes.length || scopes.length > MAX_SCOPES) throw new Error('Invalid monitored scope count');
  if (new Set(scopes.map(scopeKey)).size !== scopes.length) throw new Error('Duplicate scopes');
  return scopes;
}

export function origin(baseURL) {
  const url = new URL(baseURL);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Expected HTTPS reader origin (HTTP allowed only for local tests)');
  }
  return url.origin;
}

// Exact key sets of the reader's OpenAPI schemas (backend/reader/openapi.yaml); a test
// pins each to the schema. Scorer is separate: it also accepts T16.2 legacy shapes.
export const CONTRACT_KEYS = {
  Team: 'id name abbr crestUrl',
  Card: 'teamId player minute type',
  TeamStats: 'possession shots shotsOnTarget shotAccuracy corners offsides passes passesAccurate passAccuracy crosses crossesAccurate crossAccuracy longBalls tackles tacklesEffective tackleAccuracy interceptions clearances blockedShots saves fouls yellowCards redCards',
  PenaltyKick: 'order player scored',
  Shootout: 'homeScore awayScore',
  ShootoutDetail: 'home away',
  MatchStats: 'home away',
  WinProbability: 'home draw away',
  Match: 'id kickoff state minute statusDetail statusName home away homeScore awayScore winnerId note scorers cards shootout shootoutDetail stats winProbability',
};
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullable = (value, valid) => value === null || valid(value);
const text = value => typeof value === 'string';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const list = (value, valid) => Array.isArray(value) && value.every(valid);
export const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === keys.split(' ').sort().join(',');
const team = value => exact(value, CONTRACT_KEYS.Team) && [value.id, value.name, value.abbr].every(text) &&
  value.id.length > 0 && nullable(value.crestUrl, text);
const scorer = value => record(value) &&
  ['teamId', 'player', 'minute', 'penalty', 'shootout'].every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => ['teamId', 'player', 'minute', 'penalty', 'shootout', 'ownGoal', 'athleteId', 'playerSlug'].includes(key)) &&
  // T16.2: null ownGoal is unknown (legacy row), null teamId names neither side;
  // both are passed through as-is. Older scorers may omit ownGoal/athleteId/playerSlug.
  (!Object.hasOwn(value, 'ownGoal') || nullable(value.ownGoal, flag => typeof flag === 'boolean')) &&
  ['athleteId', 'playerSlug'].every(key => !Object.hasOwn(value, key) || nullable(value[key], text)) &&
  nullable(value.teamId, text) && [value.player, value.minute].every(text) &&
  typeof value.penalty === 'boolean' && typeof value.shootout === 'boolean';
const card = value => exact(value, CONTRACT_KEYS.Card) &&
  nullable(value.teamId, text) && [value.player, value.minute].every(text) && ['yellow', 'red'].includes(value.type);
const kick = value => exact(value, CONTRACT_KEYS.PenaltyKick) && integer(value.order) && text(value.player) && typeof value.scored === 'boolean';
const sideStats = value => exact(value, CONTRACT_KEYS.TeamStats) &&
  Object.values(value).every(item => nullable(item, finite));

function validMatch(value) {
  if (!exact(value, CONTRACT_KEYS.Match)) return false;
  return uuidPattern.test(value.id) && isISOInstant(value.kickoff) && ['scheduled', 'live', 'finished'].includes(value.state) &&
    nullable(value.minute, text) && text(value.statusDetail) && text(value.statusName) &&
    team(value.home) && team(value.away) && nullable(value.homeScore, integer) && nullable(value.awayScore, integer) &&
    nullable(value.winnerId, text) && nullable(value.note, text) && list(value.scorers, scorer) && list(value.cards, card) &&
    nullable(value.shootout, item => exact(item, CONTRACT_KEYS.Shootout) && integer(item.homeScore) && integer(item.awayScore)) &&
    nullable(value.shootoutDetail, item => exact(item, CONTRACT_KEYS.ShootoutDetail) && list(item.home, kick) && list(item.away, kick)) &&
    nullable(value.stats, item => exact(item, CONTRACT_KEYS.MatchStats) && sideStats(item.home) && sideStats(item.away)) &&
    nullable(value.winProbability, item => exact(item, CONTRACT_KEYS.WinProbability) && [item.home, item.draw, item.away].every(finite));
}

export async function boundedJSON(response, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('content-type');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('response-size');
  if (!response.body) throw new Error('body');
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('response-size');
    text += decoder.decode(chunk, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new Error('json');
  }
}

export async function checkScope({ baseURL, competition, season, timeoutMs = 10000, maxBytes = MAX_BYTES, clock = Date.now }) {
  const key = scopeKey({ competition, season });
  const base = origin(baseURL);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('Invalid request bounds');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let count = null;
  let freshness = null;
  try {
    // scope=season&detail=summary: every stored row, with its stored detail
    // and season-wide freshness. The reader's parameterless default is one
    // lightweight week, which would hide overdue matches outside it and skip
    // the detail checks below. Readers predating T10.1 ignore both parameters
    // and already return the whole season with detail.
    const response = await fetch(`${base}/v1/competitions/${competition}/${season}/matches?scope=season&detail=summary`, {
      signal: controller.signal, redirect: 'manual', cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
    });
    // Both runtimes return redirects without following them. Keep the Node watchdog's error category.
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('Location')) throw new Error('request');
    if (response.status !== 200) throw new Error(`http-${response.status}`);
    const fullPoll = response.headers.get('X-ScoreArc-Full-Poll-Status');
    if (fullPoll !== null && !['ok', 'partial', 'failed'].includes(fullPoll)) throw new Error('Invalid full poll status');
    freshness = parseMatchFreshness(response.headers);
    const pollEvidence = parsePollEvidence(response.headers.get('X-ScoreArc-Poll-Evidence'), clock());
    const body = await boundedJSON(response, maxBytes);
    if (!Array.isArray(body) || body.length > MAX_MATCHES || !body.every(validMatch) ||
        new Set(body.map(match => match.id)).size !== body.length) throw new Error('body-contract');
    count = body.length;
    const unresolved = body.some(match => match.state !== 'finished');
    // /matches is a collection: finalized rows do not waive discovery polling.
    if (freshness.staleMatches > count || (freshness.status === 'empty' && count !== 0) ||
        (freshness.status === 'fresh' && (count === 0 || freshness.pollStatus !== 'ok' || freshness.observedAt === null)) ||
        (freshness.status === 'dormant' && unresolved)) throw new Error('counts-contract');
    // Dormancy is established by the reader's season bounds and unresolved-work
    // check. Retained off-season poll failures are visible, not active incidents.
    const rollingHealthy = ['fresh', 'empty'].includes(freshness.status) && freshness.pollStatus === 'ok';
    const fullPollFailed = fullPoll === 'failed' || fullPoll === 'partial';
    const ok = freshness.status === 'dormant' || (rollingHealthy && !fullPollFailed);
    const observation = { freshness: freshness.status, poll: freshness.pollStatus, stale: freshness.staleMatches, overdue: freshness.overdueMatches, error: null };
    if (rollingHealthy && fullPollFailed) {
      observation.freshness = 'stale';
      observation.poll = fullPoll;
    }
    const urgent = body.some(match => match.state === 'live') || freshness.overdueMatches > 0 || count === 0;
    const evidence = Object.entries(pollEvidence).map(([kind, p]) => ` ${kind}=${p.outcome}@${p.at} missing=${p.missing}`).join('');
    return { ok, urgent, pollEvidence, fullStatus: fullPoll, count, observation, context: `${key} matches=${count} freshness=${freshness.status} poll=${freshness.pollStatus} full-poll=${fullPoll ?? 'unknown'} stale=${freshness.staleMatches} overdue=${freshness.overdueMatches}${evidence}` };
  } catch (error) {
    // Only constant contract/error categories; never echo URLs or raw fetch errors.
    const message = error instanceof Error ? error.message : '';
    const reason = controller.signal.aborted ? 'timeout' :
      /^(http-\d{3}|content-type|response-size|body|json|body-contract|counts-contract|headers-contract)$/.test(message) ? message :
        freshness === null && /^(Invalid|Contradictory|Empty requires)/.test(message) ? 'headers-contract' : 'request';
    return { ok: false, count, observation: { freshness: null, poll: null, stale: null, overdue: null, error: reason }, context: `${key} matches=${count ?? 'unknown'} stale=${freshness?.staleMatches ?? 'unknown'} overdue=${freshness?.overdueMatches ?? 'unknown'} error=${reason}` };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
