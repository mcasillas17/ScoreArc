// Checkpoint transitions are shared by Actions and the scheduled Worker. Their
// different provenance boundaries are enforced before checks or delivery.
import { checkScope, MAX_SCOPES, origin, record, scopeKey } from './match-freshness-reader.mjs';
import { assessAlert, newSignal, validSignal } from './match-freshness-policy.mjs';
import { isISOInstant } from '../src/lib/matchFreshness.ts';

export const MAX_STATE = 256 * 1024;
const MAX_PENDING = 128;
// Must stay >= the monitored edition count: a run that cannot send one transition per
// scope holds alerts back and skips its heartbeat. 10 was exactly the old
// registry; the Nations League made 11. 16 x SEND_TIMEOUT_MS is 4 minutes.
export const MAX_SENDS = 16;
const MAX_ATTEMPTS = 20;
export const positive = v => Number.isSafeInteger(v) && v > 0;
const count = v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 5000);
const eventPattern = /^[0-9a-f-]{36}:([1-9][0-9]*)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = /^(http-\d{3}|content-type|response-size|body|json|body-contract|counts-contract|headers-contract|request|timeout)$/;
export const equalRun = (a, b) => record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
const hasKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const exact = (value, keys) => hasKeys(value, keys.split(' '));
const githubRunURL = /^https:\/\/github\.com\/mcasillas17\/ScoreArc\/actions\/runs\/[1-9][0-9]*$/;

export function validateRun(run) {
  if (!exact(run, 'repository workflow ref id number attempt sha') || run.repository !== 'mcasillas17/ScoreArc' ||
      run.workflow !== '.github/workflows/match-freshness.yml' || run.ref !== 'refs/heads/main' ||
      !positive(run.id) || !positive(run.number) || run.attempt !== 1 || typeof run.sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.sha)) throw new Error('Invalid run provenance');
}

export const WORKER_RUN_URL = 'https://dash.cloudflare.com/4fcb63110aa75522b2636c923eeff468/workers/services/view/scorearc-alert-receiver/production/observability/logs';
function validateWorkerRun(run, now) {
  if (!exact(run, 'worker tick') || run.worker !== 'scorearc-alert-receiver' ||
      !positive(run.tick) || run.tick % 300_000 !== 0 || run.tick > now) throw new Error('Invalid Worker run provenance');
}

function config(options) {
  const base = origin(options.baseURL);
  if (!Array.isArray(options.scopes) || options.scopes.length < 1 || options.scopes.length > MAX_SCOPES) throw new Error('Invalid scopes');
  const keys = options.scopes.map(scopeKey).sort();
  if (new Set(keys).size !== keys.length || !Number.isSafeInteger(options.now) || options.now < 0) throw new Error('Invalid scopes/clock');
  return { base, keys };
}

export function validateGitHubConfig(options) {
  validateRun(options.run);
  return config(options);
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
function validEvent(e, state, keys, worker) {
  return exact(e, 'id incidentId scope status occurredAt runUrl count observation attempts nextAttemptAt') &&
    typeof e.id === 'string' && eventPattern.test(e.id) && e.id.startsWith(state.epoch + ':') &&
    Number(e.id.split(':')[1]) <= state.sequence && typeof e.incidentId === 'string' && eventPattern.test(e.incidentId) &&
    e.incidentId.startsWith(state.epoch + ':') && Number(e.incidentId.split(':')[1]) <= Number(e.id.split(':')[1]) &&
    keys.includes(e.scope) && ['OPEN','RESOLVED'].includes(e.status) &&
    (e.status !== 'OPEN' || e.incidentId === e.id) && isISOInstant(e.occurredAt) &&
    Date.parse(e.occurredAt) <= Date.parse(state.updatedAt) &&
    typeof e.runUrl === 'string' && (githubRunURL.test(e.runUrl) || (worker && e.runUrl === WORKER_RUN_URL)) &&
    count(e.count) && validObservation(e.observation, e.count) && (e.status === 'RESOLVED') === healthyObservation(e.observation) && Number.isInteger(e.attempts) &&
    e.attempts >= 0 && e.attempts <= MAX_ATTEMPTS && isISOInstant(e.nextAttemptAt) &&
    Date.parse(e.nextAttemptAt) <= Date.parse(state.updatedAt) + 21600000;
}
function validateContract(state, options, worker) {
  const { base, keys } = config(options);
  const legacy = state?.version === 2;
  if (!exact(state, 'version origin epoch run sequence updatedAt phase incidents pending delivered reserved dataIncident monitorFailure' + (legacy ? '' : ' signals')) ||
      (!legacy && state.version !== 3) || state.origin !== base || typeof state.epoch !== 'string' || !uuidPattern.test(state.epoch) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !isISOInstant(state.updatedAt) ||
      Date.parse(state.updatedAt) > options.now || !['pending','final'].includes(state.phase) ||
      !hasKeys(state.incidents, keys) ||
      (!legacy && (!hasKeys(state.signals, keys) ||
        !Object.values(state.signals).every(s => validSignal(s, Date.parse(state.updatedAt))))) ||
      !Object.values(state.incidents).every(id => id === null || (typeof id === 'string' && eventPattern.test(id) && id.startsWith(state.epoch + ':') && Number(id.split(':')[1]) <= state.sequence)) ||
      !Array.isArray(state.pending) || state.pending.length > MAX_PENDING ||
      !state.pending.every(e => validEvent(e, state, keys, worker)) ||
      state.pending.some((e, i) => i > 0 && Number(e.id.split(':')[1]) <= Number(state.pending[i-1].id.split(':')[1])) ||
      !Array.isArray(state.delivered) || state.delivered.length > 32 ||
      !state.delivered.every(e => exact(e, 'id acknowledgedAt') && typeof e.id === 'string' && eventPattern.test(e.id) && e.id.startsWith(state.epoch + ':') && Number(e.id.split(':')[1]) <= state.sequence && isISOInstant(e.acknowledgedAt) && Date.parse(e.acknowledgedAt) <= options.now) ||
      !Array.isArray(state.reserved) || state.reserved.length > MAX_SENDS ||
      !state.reserved.every((id, i) => id === state.pending[i]?.id && state.pending[i].attempts > 0) ||
      new Set([...state.pending.map(e => e.id), ...state.delivered.map(e => e.id)]).size !== state.pending.length + state.delivered.length ||
      typeof state.dataIncident !== 'boolean' || state.dataIncident !== Object.values(state.incidents).some(Boolean) ||
      ![null,'queue-full','delivery-exhausted','delivery-pending','delivery-failed'].includes(state.monitorFailure) ||
      new TextEncoder().encode(JSON.stringify(state)).length > MAX_STATE) throw new Error('Invalid state contract; refusing reset');
  // FIFO removes only the acknowledged prefix. Retain its last 32 receipts;
  // the remaining pending suffix must be contiguous through the high-water mark.
  const acknowledged = state.sequence - state.pending.length;
  if (acknowledged < 0 || state.delivered.length !== Math.min(32, acknowledged) ||
      state.delivered.some((event, index) => event.id !== `${state.epoch}:${acknowledged - state.delivered.length + index + 1}`) ||
      state.pending.some((event, index) => event.id !== `${state.epoch}:${acknowledged + index + 1}`)) throw new Error('Invalid state sequence continuity');
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

// Actions artifacts must always carry Actions provenance, including on queued
// historical events. A Worker checkpoint can still contain imported GitHub events.
export function validateState(state, options) {
  validateRun(options.run);
  validateRun(state?.run);
  return validateContract(state, options, false);
}

export function validateCheckpoint(state, options) {
  const worker = state?.run?.worker !== undefined;
  if (state?.version !== 3 || (!worker && state.phase !== 'final')) throw new Error('Expected a native checkpoint or final GitHub v3 state');
  if (worker) validateWorkerRun(state.run, Date.parse(state.updatedAt));
  else validateRun(state.run);
  return validateContract(state, options, worker);
}

// A rollback can re-envelope a settled Worker checkpoint without changing any
// historical data. In particular, the last observation and receipts keep their dates.
export function rewrapCloudflareCheckpoint(previous, options) {
  validateGitHubConfig(options);
  validateCheckpoint(previous, options);
  if (!previous.run.worker || previous.phase !== 'final' || previous.pending.length ||
      previous.reserved.length || previous.monitorFailure !== null) throw new Error('Cloudflare rollback requires a settled native checkpoint');
  return validateState({ ...previous, run: options.run, phase: 'pending' }, options);
}

function recordedScopes(state) {
  if (!record(state?.incidents) || !Object.keys(state.incidents).length) throw new Error('Invalid state incident map');
  return Object.keys(state.incidents).map(key => {
    const [competition, season] = key.split('/');
    return { competition, season };
  });
}
// A competition added to the registry since the last run joins as healthy:
// it has no history to lose. A removed one (a season replaced by the next) is
// dropped only when quiet or explicitly retired after verified dormancy, and
// never with undelivered events. Active deferred failures are not quiet.
function adoptScopes(state, keys) {
  if (!record(state?.incidents) || !Array.isArray(state.pending)) return state;
  for (const key of keys) if (!(key in state.incidents)) {
    state.incidents[key] = null;
    if (state.version === 3 && record(state.signals)) state.signals[key] = newSignal();
  }
  for (const key of Object.keys(state.incidents)) {
    const signal = state.signals?.[key];
    const quiet = state.incidents[key] === null && !signal?.prior && !Object.keys(signal?.waiting ?? {}).length;
    if (!keys.includes(key) && (quiet || signal?.dormant) && !state.pending.some(e => e?.scope === key)) {
      delete state.incidents[key];
      if (record(state.signals)) delete state.signals[key];
      state.dataIncident = Object.values(state.incidents).some(Boolean);
    }
  }
  return state;
}

function restore(previous, options, keys, validate) {
  // Validate even a retiring scope before pruning it. Keep the durable input
  // snapshot intact if a scope check or the subsequent commit fails.
  validate(previous, { ...options, scopes: recordedScopes(previous) });
  return validate(adoptScopes(structuredClone(previous), keys), options);
}

export async function prepareGitHubCheckpoint(previous, options) {
  const { base, keys } = validateGitHubConfig(options);
  const { run, now } = options;
  let state;
  if (previous === null && options.initialize === true) {
    state = { version: 3, signals: Object.fromEntries(keys.map(k => [k, newSignal()])), origin: base, epoch: crypto.randomUUID(), run, sequence: 0, updatedAt: new Date(now).toISOString(), phase: 'pending',
      incidents: Object.fromEntries(keys.map(k => [k, null])), pending: [], delivered: [], reserved: [], dataIncident: false, monitorFailure: null };
  } else {
    state = restore(previous, options, keys, validateState);
    if (!equalRun(state.run, options.restoredRun)) throw new Error('State provenance mismatch');
    if (run.number <= state.run.number || run.id <= state.run.id) throw new Error('State ordering violation');
    if (state.version === 2) {
      state.version = 3;
      state.signals = Object.fromEntries(keys.map(k => [k, newSignal()]));
      for (const [key, id] of Object.entries(state.incidents)) {
        if (!id) continue;
        // A v2 receipt keeps the ID but no diagnostic. In doubt, require
        // positive full-poll evidence instead of closing on rolling success.
        const opening = state.pending.find(e => e.id === id);
        if (!opening || ['partial','failed'].includes(opening.observation.poll)) {
          state.signals[key].waiting.full = opening?.occurredAt ?? state.updatedAt;
        }
      }
    }
  }
  return prepare(state, options, base, keys, `https://github.com/${run.repository}/actions/runs/${run.id}`, validateState);
}

export async function prepareCheckpoint(previous, options) {
  const { base, keys } = config(options);
  validateWorkerRun(options.run, options.now);
  const state = restore(previous, options, keys, validateCheckpoint);
  const lastTick = state.run.tick ?? Date.parse(state.updatedAt);
  if (options.run.tick <= lastTick) throw Object.assign(new Error('State ordering violation'), { code: 'E_STALE_TICK' });
  return prepare(state, options, base, keys, WORKER_RUN_URL, validateCheckpoint);
}

async function prepare(state, options, base, keys, runUrl, validate) {
  const { run, now, deliveryEnabled = false, check = checkScope } = options;
  state.run = run; state.updatedAt = new Date(now).toISOString(); state.phase = 'pending'; state.reserved = []; state.monitorFailure = null;
  // Reserve capacity for one transition per scope before observing anything.
  if (state.pending.length > MAX_PENDING - keys.length) state.monitorFailure = 'queue-full';
  else {
    for (const scope of options.scopes) {
      const result = await check({ baseURL: base, ...scope, clock: options.clock ?? (() => now) });
      if (typeof result.ok !== 'boolean' || !count(result.count) || !validObservation(result.observation, result.count) || result.ok !== healthyObservation(result.observation)) throw new Error('Invalid checker result');
      const key = scopeKey(scope); const incident = state.incidents[key];
      const { alert, cause, observation } = assessAlert(state.signals[key], result, Boolean(incident), now);
      options.onObservation?.(scope, result, cause);
      if (alert !== Boolean(incident)) {
        if (state.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('State sequence exhausted');
        const id = `${state.epoch}:${++state.sequence}`;
        const incidentId = alert ? id : incident;
        state.pending.push({ id, incidentId, scope: key, status: alert ? 'OPEN' : 'RESOLVED', occurredAt: state.updatedAt,
          runUrl, count: result.count, observation,
          attempts: 0, nextAttemptAt: state.updatedAt });
        state.incidents[key] = alert ? incidentId : null;
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
  const finished = Math.max(now, options.clock?.() ?? now);
  state.updatedAt = new Date(finished).toISOString();
  return validate(state, { ...options, now: finished });
}
function notification(event) {
  const [competition, season] = event.scope.split('/');
  return { eventId: event.id, incidentId: event.incidentId, competition, season, status: event.status,
    occurredAt: event.occurredAt, runUrl: event.runUrl, count: event.count, ...event.observation };
}

// Persist the pending reservation before calling this transition. If the final
// write is lost, the next tick retries the exact event after its stored backoff.
export async function finishCheckpoint(pending, { now, clock = () => now, send }) {
  const options = { now: Math.max(now, clock()), baseURL: pending?.origin, scopes: recordedScopes(pending) };
  validateCheckpoint(pending, options);
  if (pending.phase !== 'pending') throw new Error('Expected a pending checkpoint');
  const final = await deliverReserved(pending, { now: options.now, send });
  const finished = Math.max(options.now, clock());
  final.updatedAt = new Date(finished).toISOString();
  return validateCheckpoint(final, { ...options, now: finished });
}

export async function finishGitHubCheckpoint(pending, options) {
  validateState(pending, options);
  if (!equalRun(pending.run, options.run) || pending.phase !== 'pending') throw new Error('State delivery provenance/phase mismatch');
  return validateState(await deliverReserved(pending, options), options);
}

async function deliverReserved(pending, { now, send }) {
  const state = structuredClone(pending);
  for (const id of state.reserved) {
    const event = state.pending[0];
    if (event?.id !== id) throw new Error('State delivery ordering violation');
    try { await send(notification(event)); }
    catch {
      // A missing or ambiguous acknowledgment retains the whole remaining suffix.
      state.monitorFailure = 'delivery-failed';
      break;
    }
    state.pending.shift();
    state.delivered.push({ id, acknowledgedAt: new Date(now).toISOString() });
    state.delivered = state.delivered.slice(-32);
  }
  state.reserved = [];
  state.phase = 'final';
  if (!state.pending.length && state.monitorFailure !== 'queue-full') state.monitorFailure = null;
  return state;
}
