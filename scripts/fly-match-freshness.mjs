// The Fly machine owns the timer and performs every reader and policy check.
// The receiver owns the lease, checkpoint, event receipts, email and heartbeat.
import { pathToFileURL } from 'node:url';
import registry from '../backend/config/competitions.json' with { type: 'json' };
import { boundedJSON, checkScope, currentScopes, exact } from './match-freshness-reader.mjs';
import { assessAlert, newSignal } from './match-freshness-policy.mjs';
import { finishCheckpoint, MAX_STATE, prepareCheckpoint } from './match-freshness-checkpoint.mjs';
import { FLY_APP, TICK_MS } from './match-freshness-fly.mjs';

const editions = currentScopes(registry);
const baseURL = 'https://scorearc-reader.fly.dev';
const receiverOrigin = 'https://scorearc-alert-receiver.miguel-4fc.workers.dev';
const operations = ['claim', 'pending', 'event', 'final', 'heartbeat', 'release'];

class ReceiverError extends Error {}

// The dedicated token is sent only to this fixed origin. Reject all redirects.
export function receiverRPC(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('Invalid Fly monitor token');
  return async (operation, body) => {
    if (!operations.includes(operation)) throw new Error('Invalid receiver operation');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let status = 0;
    try {
      const response = await fetchImpl(receiverOrigin + '/fly/' + operation, {
        method: 'POST', redirect: 'error', signal: controller.signal, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      status = response.status;
      if (response.redirected) throw new Error();
      if (status === 204 && operation !== 'event') return null;
      if (operation === 'claim' && status === 200) {
        const claim = await boundedJSON(response, MAX_STATE + 1024);
        if (exact(claim, 'checkpoint leaseUntil') && Number.isSafeInteger(claim.leaseUntil) && claim.leaseUntil > body.tick) return claim;
      }
      if (operation === 'event' && status === 200) {
        const ack = await boundedJSON(response, 1024);
        if (exact(ack, 'eventId') && ack.eventId === body.event.eventId) return ack;
      }
      throw new Error();
    } catch {
      // Transport errors and response bodies may quote request configuration.
      throw new ReceiverError('receiver-' + operation + '-' + (controller.signal.aborted ? 'timeout' : status || 'request'));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

function usageSince(started, cpu, clock) {
  const { user, system } = process.cpuUsage(cpu);
  return { durationMs: clock() - started, cpuMs: Math.round((user + system) / 1000),
    peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) };
}

// A one-pass preflight starts each edition with a fresh signal. It never
// claims ownership or opens a connection to the receiver.
export async function observeOnce({ check = checkScope, clock = Date.now } = {}) {
  const started = clock();
  const cpu = process.cpuUsage();
  let open = 0, errors = 0;
  for (const scope of editions) {
    const result = await check({ baseURL, ...scope, clock });
    const { alert } = assessAlert(newSignal(), result, false, started);
    if (alert) open++;
    if (result.observation.error) errors++;
  }
  return { status: 'observe', scopes: editions.length, open, errors, ...usageSince(started, cpu, clock) };
}

export async function runFlyTick(tick, { rpc, clock = Date.now, ...options }) {
  const started = clock();
  const cpu = process.cpuUsage();
  if (!Number.isSafeInteger(tick) || tick <= 0 || tick % TICK_MS || tick > started) throw new Error('Invalid Fly tick');
  let claimed;
  try {
    claimed = await rpc('claim', { tick });
  } catch (error) {
    // The receiver requires the same UTC slot. On an early boundary reject,
    // allow the two clocks to converge before trying that single claim again.
    const delay = tick + 2_000 - clock();
    if (!(error instanceof ReceiverError) || error.message !== 'receiver-claim-409' || delay <= 0) throw error;
    await wait(delay, options.signal);
    options.signal?.throwIfAborted();
    claimed = await rpc('claim', { tick });
  }
  if (!claimed) return { status: 'skipped', tick };
  const lease = { tick, leaseUntil: claimed.leaseUntil };
  let scopes = 0, errors = 0;
  try {
    if (!Number.isSafeInteger(lease.leaseUntil) || lease.leaseUntil <= clock()) throw new Error('Expired Fly lease');
    let pending;
    try {
      pending = await prepareCheckpoint(claimed.checkpoint, { run: { fly: FLY_APP, tick }, now: started, clock,
        baseURL, scopes: options.scopes ?? editions, deliveryEnabled: true,
        check: async request => {
          options.signal?.throwIfAborted();
          return (options.check ?? checkScope)(request);
        },
        onObservation: (_scope, result) => { scopes++; if (result.observation.error) errors++; },
      });
    } catch (error) {
      // The imported GitHub checkpoint can already cover the startup slot.
      if (error?.code === 'E_STALE_TICK') return { status: 'skipped', tick };
      throw error;
    }
    options.signal?.throwIfAborted();
    await rpc('pending', { ...lease, checkpoint: pending });
    const final = await finishCheckpoint(pending, { now: clock(), clock, send: async event => {
      options.signal?.throwIfAborted();
      await rpc('event', { ...lease, event });
    } });
    await rpc('final', { ...lease, checkpoint: final });
    if (!final.monitorFailure && !final.pending.length && !options.signal?.aborted) await rpc('heartbeat', lease);
    return { status: 'observed', tick, scopes, errors, open: Object.values(final.incidents).filter(Boolean).length,
      pending: final.pending.length, monitorFailure: final.monitorFailure, ...usageSince(started, cpu, clock) };
  } finally {
    await rpc('release', lease);
  }
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// After restart or a slow run, observe the current UTC slot once. Historical
// slots cannot be reconstructed from the live reader. D1 fences other machines.
export async function runSchedule({ runTick, signal, clock = Date.now, log = console.log }) {
  let lastTick = 0;
  while (!signal.aborted) {
    const now = clock();
    const tick = Math.floor(now / TICK_MS) * TICK_MS;
    if (tick > lastTick) {
      lastTick = tick;
      try {
        log(await runTick(tick));
      } catch (error) {
        if (!signal.aborted) log({ status: 'failed', tick, reason: error instanceof ReceiverError ? error.message : 'tick-failed' });
      }
    }
    const delay = lastTick + TICK_MS - clock();
    if (delay > 0) await wait(delay, signal);
  }
}

async function main() {
  const mode = process.argv[2] ?? 'run';
  if (process.argv.length > 3 || !['run', 'observe'].includes(mode)) throw new Error('Invalid monitor command');
  if (mode === 'observe') {
    const result = await observeOnce();
    console.log(JSON.stringify(result));
    if (result.errors) process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (!process.env.FLY_MONITOR_TOKEN) {
      console.log('Fly match monitor idle (token absent)');
      while (!controller.signal.aborted) await wait(24 * 60 * 60_000, controller.signal);
      return;
    }
    const rpc = receiverRPC(process.env.FLY_MONITOR_TOKEN);
    await runSchedule({ runTick: tick => runFlyTick(tick, { rpc, signal: controller.signal }), signal: controller.signal,
      log: result => console.log(JSON.stringify(result)) });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Fly match monitor failed'); process.exitCode = 2; });
}
