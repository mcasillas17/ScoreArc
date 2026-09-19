import { appendFile, mkdir, open, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isISOInstant, parseMatchFreshness } from '../src/lib/matchFreshness.ts';

const MAX_SCOPES = 32;
const MAX_STATE_BYTES = 32768;
const MAX_MATCHES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30000;
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scopeKey(scope) {
  if (!scope || typeof scope.competition !== 'string' || typeof scope.season !== 'string' ||
      !idPattern.test(scope.competition) || !idPattern.test(scope.season)) {
    throw new Error('Invalid competition/season scope');
  }
  return `${scope.competition}/${scope.season}`;
}

export function currentScopes(registry) {
  if (!Array.isArray(registry) || registry.length === 0 || registry.length > MAX_SCOPES) throw new Error('Invalid scope registry');
  const scopes = registry.map(comp => {
    if (!comp.seasons?.[comp.currentSeasonId] || comp.seasons[comp.currentSeasonId].id !== comp.currentSeasonId) {
      throw new Error('Invalid current season');
    }
    return { competition: comp.id, season: comp.currentSeasonId };
  });
  if (new Set(scopes.map(scopeKey)).size !== scopes.length) throw new Error('Duplicate scopes');
  return scopes;
}

function origin(baseURL) {
  const url = new URL(baseURL);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Expected HTTPS reader origin (HTTP allowed only for local tests)');
  }
  return url.origin;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullable = (value, valid) => value === null || valid(value);
const text = value => typeof value === 'string';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const list = (value, valid) => Array.isArray(value) && value.every(valid);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === keys.split(' ').sort().join(',');
const team = value => exact(value, 'id name abbr crestUrl') && [value.id, value.name, value.abbr].every(text) &&
  value.id.length > 0 && nullable(value.crestUrl, text);
const scorer = value => exact(value, 'teamId player minute penalty shootout') &&
  [value.teamId, value.player, value.minute].every(text) && typeof value.penalty === 'boolean' && typeof value.shootout === 'boolean';
const card = value => exact(value, 'teamId player minute type') &&
  [value.teamId, value.player, value.minute].every(text) && ['yellow', 'red'].includes(value.type);
const kick = value => exact(value, 'order player scored') && integer(value.order) && text(value.player) && typeof value.scored === 'boolean';
const sideStats = value => exact(value, 'possession shots shotsOnTarget shotAccuracy corners offsides passes passAccuracy crosses crossAccuracy longBalls tackles tackleAccuracy interceptions clearances blockedShots saves fouls yellowCards redCards') &&
  Object.values(value).every(item => nullable(item, finite));

function validMatch(value) {
  if (!exact(value, 'id kickoff state minute statusDetail statusName home away homeScore awayScore winnerId note scorers cards shootout shootoutDetail stats winProbability')) return false;
  return uuidPattern.test(value.id) && isISOInstant(value.kickoff) && ['scheduled', 'live', 'finished'].includes(value.state) &&
    nullable(value.minute, text) && text(value.statusDetail) && text(value.statusName) &&
    team(value.home) && team(value.away) && nullable(value.homeScore, integer) && nullable(value.awayScore, integer) &&
    nullable(value.winnerId, text) && nullable(value.note, text) && list(value.scorers, scorer) && list(value.cards, card) &&
    nullable(value.shootout, item => exact(item, 'homeScore awayScore') && integer(item.homeScore) && integer(item.awayScore)) &&
    nullable(value.shootoutDetail, item => exact(item, 'home away') && list(item.home, kick) && list(item.away, kick)) &&
    nullable(value.stats, item => exact(item, 'home away') && sideStats(item.home) && sideStats(item.away)) &&
    nullable(value.winProbability, item => exact(item, 'home draw away') && [item.home, item.draw, item.away].every(finite));
}

async function boundedJSON(response, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('content-type');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('response-size');
  if (!response.body) throw new Error('body');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('response-size');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new Error('json');
  }
}

export async function checkScope({ baseURL, competition, season, timeoutMs = 10000, maxBytes = MAX_BYTES }) {
  const key = scopeKey({ competition, season });
  const base = origin(baseURL);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('Invalid request bounds');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let count = null;
  let freshness = null;
  try {
    const response = await fetch(`${base}/v1/competitions/${competition}/${season}/matches`, {
      signal: controller.signal, redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
    });
    if (response.status !== 200) throw new Error(`http-${response.status}`);
    freshness = parseMatchFreshness(response.headers);
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
    const ok = freshness.status === 'dormant' ||
      (['fresh', 'empty'].includes(freshness.status) && !['partial', 'failed'].includes(freshness.pollStatus));
    return { ok, count, context: `${key} matches=${count} freshness=${freshness.status} poll=${freshness.pollStatus} stale=${freshness.staleMatches} overdue=${freshness.overdueMatches}` };
  } catch (error) {
    // Only constant contract/error categories; never echo URLs or raw fetch errors.
    const message = error instanceof Error ? error.message : '';
    const reason = controller.signal.aborted ? 'timeout' :
      /^(http-\d{3}|content-type|response-size|body|json|body-contract|counts-contract)$/.test(message) ? message :
        freshness === null && /^(Invalid|Contradictory|Empty requires)/.test(message) ? 'headers-contract' : 'request';
    return { ok: false, count, context: `${key} matches=${count ?? 'unknown'} stale=${freshness?.staleMatches ?? 'unknown'} overdue=${freshness?.overdueMatches ?? 'unknown'} error=${reason}` };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readState(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('Invalid state size');
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STATE_BYTES) throw new Error('Invalid state size');
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await file.close();
  }
}

// Single-flight on a local durable filesystem. A stale lock fails closed; an
// operator must verify no run is active before removing it.
export async function runWatchdog({ baseURL, scopes, stateFile, initialize = false, timeoutMs = 10000, onStateWritten = () => {} }) {
  const base = origin(baseURL);
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > MAX_SCOPES) throw new Error('Invalid scopes');
  const keys = scopes.map(scopeKey).sort();
  if (new Set(keys).size !== keys.length || typeof stateFile !== 'string' || !stateFile) throw new Error('Invalid state/scopes');
  const lock = `${stateFile}.lock`;
  try { await mkdir(lock); } catch { throw new Error('State lock unavailable'); }
  const temp = `${stateFile}.tmp-${randomUUID()}`;
  try {
    let state;
    try {
      state = await readState(stateFile);
    } catch (error) {
      if (error.code !== 'ENOENT' || !initialize) throw new Error('State unavailable or corrupt; refusing reset');
      state = { version: 1, origin: base, incidents: Object.fromEntries(keys.map(key => [key, false])) };
    }
    if (!exact(state, 'version origin incidents') || state.version !== 1 || state.origin !== base ||
        !record(state.incidents) || Object.keys(state.incidents).sort().join(',') !== keys.join(',') ||
        !Object.values(state.incidents).every(value => typeof value === 'boolean')) {
      throw new Error('Invalid state contract or changed scopes/origin; refusing reset');
    }
    const messages = [];
    let exitCode = 0;
    for (const scope of scopes) {
      const result = await checkScope({ baseURL: base, ...scope, timeoutMs });
      const key = scopeKey(scope);
      const incident = !result.ok;
      if (incident !== state.incidents[key]) messages.push(`${incident ? 'OPEN' : 'RESOLVED'} ${result.context}`);
      state.incidents[key] = incident;
      if (incident) exitCode = 1;
    }
    // Bound is independent of time/run count: exactly one boolean per scope.
    await writeFile(temp, JSON.stringify(state)+'\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, stateFile);
    // Signal the durable write before cleanup, which may itself fail.
    onStateWritten();
    return { exitCode, messages };
  } finally {
    await rm(temp, { force: true });
    await rmdir(lock);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string', default: 'https://scorearc-reader.fly.dev' },
    'state-file': { type: 'string' },
    'init-state': { type: 'boolean', default: false },
  } });
  if (!values['state-file']) throw new Error('--state-file is required');
  const registry = JSON.parse(await readFile(new URL('../backend/config/competitions.json', import.meta.url), 'utf8'));
  let stateWritten = false;
  try {
    const result = await runWatchdog({
      baseURL: values['base-url'], stateFile: values['state-file'],
      initialize: values['init-state'], scopes: currentScopes(registry),
      onStateWritten: () => { stateWritten = true; },
    });
    for (const message of result.messages) console.log(message);
    process.exitCode = result.exitCode;
  } finally {
    // A failed check can still produce valid incident state. Do not publish a
    // merely restored, corrupt, or absent file as if it were a newly saved one.
    if (stateWritten && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, 'state_written=true\n');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Watchdog failed: configuration, durable state, or persistence unavailable. No silent reset.');
    process.exitCode = 2;
  });
}
