import { mkdir, open, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { checkScope, boundedJSON, origin, scopeKey } from './match-freshness-watchdog.mjs';
import { isISOInstant } from '../src/lib/matchFreshness.ts';

const MAX_STATE = 256 * 1024;
const MAX_PENDING = 128;
const MAX_SENDS = 10;
const MAX_ATTEMPTS = 20;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).sort().join(' ') === keys.split(' ').sort().join(' ');
const positive = v => Number.isSafeInteger(v) && v > 0;
const count = v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 5000);
const eventPattern = /^[0-9a-f-]{36}:([1-9][0-9]*)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = /^(http-\d{3}|content-type|response-size|body|json|body-contract|counts-contract|headers-contract|request|timeout)$/;
const equalRun = (a, b) => record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);

export function validateRun(run) {
  if (!exact(run, 'repository workflow ref id number attempt sha') || run.repository !== 'mcasillas17/ScoreArc' ||
      run.workflow !== '.github/workflows/match-freshness.yml' || run.ref !== 'refs/heads/main' ||
      !positive(run.id) || !positive(run.number) || run.attempt !== 1 || !/^[a-f0-9]{40}$/.test(run.sha)) throw new Error('Invalid run provenance');
}
function config(options) {
  validateRun(options.run);
  const base = origin(options.baseURL);
  if (!Array.isArray(options.scopes) || options.scopes.length < 1 || options.scopes.length > 32) throw new Error('Invalid scopes');
  const keys = options.scopes.map(scopeKey).sort();
  if (new Set(keys).size !== keys.length || !Number.isSafeInteger(options.now) || options.now < 0) throw new Error('Invalid scopes/clock');
  return { base, keys };
}
function validObservation(o, matchCount) {
  if (!exact(o, 'freshness poll stale overdue error') || !count(matchCount)) return false;
  if (o.error !== null) return typeof o.error === 'string' && errors.test(o.error) &&
    o.freshness === null && o.poll === null && o.stale === null && o.overdue === null;
  return matchCount !== null && count(o.stale) && o.stale !== null && count(o.overdue) && o.overdue !== null &&
    ['fresh','empty','dormant','stale','unavailable'].includes(o.freshness) &&
    ['ok','partial','failed','unknown'].includes(o.poll) && o.overdue <= o.stale && o.stale <= matchCount &&
    (!['fresh','empty','dormant'].includes(o.freshness) || o.stale === 0) &&
    (o.freshness !== 'empty' || (matchCount === 0 && o.poll === 'ok')) &&
    (o.freshness !== 'fresh' || (matchCount > 0 && o.poll === 'ok'));
}
const healthyObservation = o => o.error === null &&
  (o.freshness === 'dormant' || (['fresh','empty'].includes(o.freshness) && o.poll === 'ok'));
function validEvent(e, state, keys) {
  return exact(e, 'id incidentId scope status occurredAt runUrl count observation attempts nextAttemptAt') &&
    typeof e.id === 'string' && eventPattern.test(e.id) && e.id.startsWith(state.epoch + ':') &&
    Number(e.id.split(':')[1]) <= state.sequence && eventPattern.test(e.incidentId) &&
    e.incidentId.startsWith(state.epoch + ':') && Number(e.incidentId.split(':')[1]) <= Number(e.id.split(':')[1]) &&
    keys.includes(e.scope) && ['OPEN','RESOLVED'].includes(e.status) &&
    (e.status !== 'OPEN' || e.incidentId === e.id) && isISOInstant(e.occurredAt) &&
    Date.parse(e.occurredAt) <= Date.parse(state.updatedAt) &&
    /^https:\/\/github\.com\/mcasillas17\/ScoreArc\/actions\/runs\/[1-9][0-9]*$/.test(e.runUrl) &&
    count(e.count) && validObservation(e.observation, e.count) && (e.status === 'RESOLVED') === healthyObservation(e.observation) && Number.isInteger(e.attempts) &&
    e.attempts >= 0 && e.attempts <= MAX_ATTEMPTS && isISOInstant(e.nextAttemptAt) &&
    Date.parse(e.nextAttemptAt) <= Date.parse(state.updatedAt) + 21600000;
}
export function validateState(state, options) {
  const { base, keys } = config(options);
  if (!exact(state, 'version origin epoch run sequence updatedAt phase incidents pending delivered reserved dataIncident monitorFailure') ||
      state.version !== 2 || state.origin !== base || !uuidPattern.test(state.epoch) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !isISOInstant(state.updatedAt) ||
      Date.parse(state.updatedAt) > options.now || !['pending','final'].includes(state.phase) ||
      !record(state.incidents) || Object.keys(state.incidents).sort().join() !== keys.join() ||
      !Object.values(state.incidents).every(id => id === null || (typeof id === 'string' && eventPattern.test(id) && id.startsWith(state.epoch + ':') && Number(id.split(':')[1]) <= state.sequence)) ||
      !Array.isArray(state.pending) || state.pending.length > MAX_PENDING ||
      !state.pending.every(e => validEvent(e, state, keys)) ||
      state.pending.some((e, i) => i > 0 && Number(e.id.split(':')[1]) <= Number(state.pending[i-1].id.split(':')[1])) ||
      !Array.isArray(state.delivered) || state.delivered.length > 32 ||
      !state.delivered.every(e => exact(e, 'id acknowledgedAt') && typeof e.id === 'string' && eventPattern.test(e.id) && e.id.startsWith(state.epoch + ':') && Number(e.id.split(':')[1]) <= state.sequence && isISOInstant(e.acknowledgedAt) && Date.parse(e.acknowledgedAt) <= options.now) ||
      !Array.isArray(state.reserved) || state.reserved.length > MAX_SENDS ||
      !state.reserved.every((id, i) => id === state.pending[i]?.id && state.pending[i].attempts > 0) ||
      new Set([...state.pending.map(e => e.id), ...state.delivered.map(e => e.id)]).size !== state.pending.length + state.delivered.length ||
      typeof state.dataIncident !== 'boolean' || state.dataIncident !== Object.values(state.incidents).some(Boolean) ||
      ![null,'queue-full','delivery-exhausted','delivery-pending','delivery-failed'].includes(state.monitorFailure) ||
      Buffer.byteLength(JSON.stringify(state)) > MAX_STATE) throw new Error('Invalid state contract; refusing reset');
  // FIFO removes only the acknowledged prefix. Retain its last 32 receipts;
  // the remaining pending suffix must be contiguous through the high-water mark.
  const acknowledged = state.sequence - state.pending.length;
  if (acknowledged < 0 || state.delivered.length !== Math.min(32, acknowledged) ||
      state.delivered.some((event, index) => event.id !== `${state.epoch}:${acknowledged - state.delivered.length + index + 1}`) ||
      state.pending.some((event, index) => event.id !== `${state.epoch}:${acknowledged + index + 1}`)) throw new Error('Invalid state sequence continuity');
  validateRun(state.run);
  const last = new Map();
  for (const event of state.pending) {
    const previous = last.get(event.scope);
    if ((event.status === 'RESOLVED' && Number(event.incidentId.split(':')[1]) >= Number(event.id.split(':')[1])) ||
        (previous && (previous.status === event.status ||
          (event.status === 'RESOLVED' && event.incidentId !== previous.incidentId)))) throw new Error('Invalid state event order');
    last.set(event.scope, event);
  }
  for (const [key, event] of last) {
    if (state.incidents[key] !== (event.status === 'OPEN' ? event.incidentId : null)) throw new Error('Invalid state incident continuity');
  }
  if ((state.phase === 'final' && state.reserved.length) || state.delivered.some((event, index) => index > 0 &&
      Number(event.id.split(':')[1]) <= Number(state.delivered[index-1].id.split(':')[1]))) throw new Error('Invalid state acknowledgment order');
  return state;
}
async function load(path) {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STATE) throw new Error('size');
      const buffer = Buffer.alloc(MAX_STATE + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_STATE) throw new Error('size');
      return JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } finally { await file.close(); }
  } catch (cause) { throw new Error('State unavailable or corrupt; refusing reset', { cause }); }
}
async function save(path, state) {
  const bytes = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(bytes) > MAX_STATE) throw new Error('State size exceeded');
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
async function locked(path, operation) {
  if (typeof path !== 'string' || !path) throw new Error('Invalid state path');
  const lock = `${path}.lock`;
  try { await mkdir(lock); } catch { throw new Error('State lock unavailable'); }
  try {
    await writeFile(`${lock}/owner`, String(process.pid), { flag: 'wx' });
    return await operation();
  } finally { await rm(`${lock}/owner`, { force: true }); await rmdir(lock); }
}
const outcome = s => ({ exitCode: s.monitorFailure || s.pending.length ? 2 : s.dataIncident ? 1 : 0, pending: s.pending.length, monitorFailure: s.monitorFailure });

export async function prepareMonitor(options) {
  if (options.enabled !== true) return { disabled: true };
  const { base, keys } = config(options);
  const { stateFile, run, now, initialize = false, restoredRun, deliveryEnabled = false, check = checkScope } = options;
  return locked(stateFile, async () => {
    let state;
    if (initialize) {
      // Never overwrite existing history even when an operator repeats init.
      try { await open(stateFile, 'r').then(async f => { await f.close(); throw new Error('State already exists'); }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      state = { version: 2, origin: base, epoch: randomUUID(), run, sequence: 0, updatedAt: new Date(now).toISOString(), phase: 'pending',
        incidents: Object.fromEntries(keys.map(k => [k, null])), pending: [], delivered: [], reserved: [], dataIncident: false, monitorFailure: null };
    } else {
      state = validateState(await load(stateFile), options);
      if (!equalRun(state.run, restoredRun)) throw new Error('State provenance mismatch');
      if (run.number <= state.run.number || run.id <= state.run.id) throw new Error('State ordering violation');
    }
    state.run = run; state.updatedAt = new Date(now).toISOString(); state.phase = 'pending'; state.reserved = []; state.monitorFailure = null;
    // Reserve capacity for one transition per scope before observing anything.
    if (state.pending.length > MAX_PENDING - keys.length) state.monitorFailure = 'queue-full';
    else {
      for (const scope of options.scopes) {
        const result = await check({ baseURL: base, ...scope });
        if (typeof result.ok !== 'boolean' || !count(result.count) || !validObservation(result.observation, result.count) || result.ok !== healthyObservation(result.observation)) throw new Error('Invalid checker result');
        const key = scopeKey(scope); const incident = state.incidents[key];
        if (!result.ok !== Boolean(incident)) {
          if (state.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('State sequence exhausted');
          const id = `${state.epoch}:${++state.sequence}`;
          const incidentId = result.ok ? incident : id;
          state.pending.push({ id, incidentId, scope: key, status: result.ok ? 'RESOLVED' : 'OPEN', occurredAt: state.updatedAt,
            runUrl: `https://github.com/${run.repository}/actions/runs/${run.id}`, count: result.count, observation: result.observation,
            attempts: 0, nextAttemptAt: state.updatedAt });
          state.incidents[key] = result.ok ? null : incidentId;
        }
      }
    }
    state.dataIncident = Object.values(state.incidents).some(Boolean);
    if (state.pending.length && !state.monitorFailure) state.monitorFailure = 'delivery-pending';
    if (deliveryEnabled) {
      for (const event of state.pending.slice(0, MAX_SENDS)) {
        if (event.attempts >= MAX_ATTEMPTS) { state.monitorFailure = 'delivery-exhausted'; break; }
        if (Date.parse(event.nextAttemptAt) > now) break;
        event.attempts++;
        event.nextAttemptAt = new Date(now + Math.min(21600000, 300000 * 2 ** (event.attempts - 1))).toISOString();
        state.reserved.push(event.id);
      }
    }
    validateState(state, options); await save(stateFile, state);
    return outcome(state);
  });
}
function notification(event) {
  const [competition, season] = event.scope.split('/');
  return { eventId: event.id, incidentId: event.incidentId, competition, season, status: event.status,
    occurredAt: event.occurredAt, runUrl: event.runUrl, count: event.count, ...event.observation };
}
export async function deliverMonitor(options) {
  if (options.enabled !== true || options.deliveryEnabled !== true) return { disabled: true };
  config(options);
  if (!positive(options.pendingArtifactId)) throw new Error('Pending checkpoint upload required');
  const url = new URL(options.webhookURL);
  const local = url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) throw new Error('Invalid webhook configuration');
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid notifier timeout');
  return locked(options.stateFile, async () => {
    const state = validateState(await load(options.stateFile), options);
    if (!equalRun(state.run, options.run) || state.phase !== 'pending') throw new Error('State delivery provenance/phase mismatch');
    for (const id of state.reserved) {
      const event = state.pending[0];
      if (event?.id !== id) throw new Error('State delivery ordering violation');
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (options.fetchImpl ?? fetch)(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event.id }, body: JSON.stringify(notification(event)) });
        if (response.status !== 200) throw new Error('not-acknowledged');
        const ack = await boundedJSON(response, 1024);
        if (!exact(ack, 'eventId') || ack.eventId !== event.id) throw new Error('not-acknowledged');
        state.pending.shift();
        state.delivered.push({ id: event.id, acknowledgedAt: new Date(options.now).toISOString() });
        state.delivered = state.delivered.slice(-32);
      } catch {
        // Timeout, 429, non-200 and ambiguous acknowledgments retain the event;
        // never expose response bodies, transport errors or secret webhook URLs.
        state.monitorFailure = 'delivery-failed'; break;
      } finally { clearTimeout(timer); controller.abort(); }
    }
    state.reserved = []; state.phase = 'final';
    if (!state.pending.length && state.monitorFailure !== 'queue-full') state.monitorFailure = null;
    validateState(state, options); await save(options.stateFile, state);
    return outcome(state);
  });
}

// The CLI phases mirror the artifact boundaries in match-freshness.yml. A phase
// writes outputs only after a new validated state has been atomically saved.
export async function runPhase({ phase, env = process.env, workDir = 'watchdog-state', now = Date.now(), baseURL = 'https://scorearc-reader.fly.dev', github, check = checkScope }) {
  if (env.MATCH_FRESHNESS_ENABLED !== 'true') {
    console.log('Match monitor disabled; no checks or delivery.'); return { exitCode: 0 };
  }
  const { appendFile, readFile } = await import('node:fs/promises');
  const { currentScopes } = await import('./match-freshness-watchdog.mjs');
  const { githubJSON, selectState } = await import('./match-freshness-state.mjs');
  const run = { repository: env.GITHUB_REPOSITORY, workflow: '.github/workflows/match-freshness.yml', ref: env.GITHUB_REF,
    id: Number(env.GITHUB_RUN_ID), number: Number(env.GITHUB_RUN_NUMBER), attempt: Number(env.GITHUB_RUN_ATTEMPT), sha: env.GITHUB_SHA };
  validateRun(run);
  const output = async values => {
    if (!env.GITHUB_OUTPUT) throw new Error('Missing workflow output');
    await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(''));
  };
  const { join } = await import('node:path');
  const stateFile = join(workDir, 'state.json');
  const selectionFile = join(workDir, 'selection.json');
  if (phase === 'select') {
    const initialize = env.INITIALIZE_STATE === 'true';
    if (!['true','false'].includes(env.INITIALIZE_STATE)) throw new Error('Explicit initialization choice required');
    const selection = await selectState({ github: github ?? githubJSON(env.GITHUB_TOKEN), run, initialize, now });
    await mkdir(workDir, { recursive: true });
    await writeFile(selectionFile, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
    await output({ initialize: selection === null, artifact_id: selection?.artifactId ?? '', run_id: selection?.run.id ?? '' });
    return { exitCode: 0 };
  }
  const registry = JSON.parse(await readFile(new URL('../backend/config/competitions.json', import.meta.url), 'utf8'));
  const options = { enabled: true, deliveryEnabled: env.MATCH_FRESHNESS_DELIVERY_ENABLED === 'true',
    baseURL, check, scopes: currentScopes(registry), stateFile, run, now };
  if (phase === 'prepare') {
    const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
    await prepareMonitor({ ...options, initialize: selection === null, restoredRun: selection?.run });
    await output({ state_written: true });
  } else if (phase === 'deliver') {
    const result = await deliverMonitor({ ...options, webhookURL: env.MATCH_FRESHNESS_WEBHOOK_URL,
      pendingArtifactId: Number(env.PENDING_ARTIFACT_ID) });
    if (!result.disabled) await output({ state_written: true });
  } else if (phase === 'result') {
    const state = validateState(await load(stateFile), options);
    if (!equalRun(state.run, run)) throw new Error('State result provenance mismatch');
    const result = outcome(state);
    console.log(`Match monitor: data_incident=${state.dataIncident} pending=${result.pending} monitor=${result.monitorFailure ?? 'ok'}`);
    return result;
  } else throw new Error('Invalid monitor phase');
  return { exitCode: 0 };
}
const { resolve } = await import('node:path');
const { fileURLToPath } = await import('node:url');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase({ phase: process.argv[2] }).then(result => { process.exitCode = result.exitCode; }).catch(() => {
    console.error('Match monitor failed: configuration, state, API, persistence or delivery boundary. Incident history was not reset.');
    process.exitCode = 2;
  });
}
