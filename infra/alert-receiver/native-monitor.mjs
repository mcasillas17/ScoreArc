import registry from '../../backend/config/competitions.json' with { type: 'json' };
import { checkScope, currentScopes } from '../../scripts/match-freshness-reader.mjs';
import { prepareCheckpoint, finishCheckpoint } from '../../scripts/match-freshness-checkpoint.mjs';

const scopes = currentScopes(registry);
const baseURL = 'https://scorearc-reader.fly.dev';
const interval = 5 * 60_000;
// scheduled() has a 15-minute wall-time limit. A successor must not start while
// a predecessor can still be inside an email send, even if the process vanishes.
const leaseDuration = 20 * 60_000;
const owner = "id = 1 AND mode = 'cloudflare' AND last_tick = ? AND lease_until = ?";
const liveOwner = `${owner} AND lease_until > ?`;

export async function getMonitorMode(db) {
  // GitHub owns only the empty row. Draining may also park an idle native
  // checkpoint for rollback. Only a native tick can have an outstanding lease.
  const row = await db.prepare(`SELECT mode FROM monitor_runtime WHERE id = 1 AND (
    (mode IN ('github','draining') AND checkpoint IS NULL AND last_tick IS NULL AND lease_until = 0)
    OR (mode IN ('cloudflare','draining') AND checkpoint IS NOT NULL AND lease_until = 0)
    OR (mode = 'cloudflare' AND checkpoint IS NOT NULL AND lease_until > last_tick)
  )`).bind().first();
  if (!row) throw new Error('Invalid monitor mode');
  return row.mode;
}

export async function runNativeTick({ db, scheduledTime, send, heartbeat, ...options }) {
  const clock = options.clock ?? Date.now;
  const now = clock();
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0 || scheduledTime > now ||
      !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid monitor clock');
  const tick = Math.floor(scheduledTime / interval) * interval;
  const leaseUntil = now + leaseDuration;
  const claimed = await db.prepare(`UPDATE monitor_runtime SET last_tick = ?, lease_until = ?
    WHERE id = 1 AND mode = 'cloudflare' AND (last_tick IS NULL OR last_tick < ?) AND lease_until <= ?
    RETURNING checkpoint`).bind(tick, leaseUntil, tick, now).first();
  if (!claimed) return { status: 'skipped', tick };

  const assertOwner = async () => {
    const row = await db.prepare(`SELECT id FROM monitor_runtime WHERE ${liveOwner}`).bind(tick, leaseUntil, clock()).first();
    if (!row) throw new Error('Monitor lease lost');
  };
  const save = async checkpoint => {
    const row = await db.prepare(`UPDATE monitor_runtime SET checkpoint = ? WHERE ${liveOwner} RETURNING id`)
      .bind(JSON.stringify(checkpoint), tick, leaseUntil, clock()).first();
    if (!row) throw new Error('Monitor lease lost');
  };
  try {
    if (typeof claimed.checkpoint !== 'string') throw new Error('Missing imported checkpoint');
    const previous = JSON.parse(claimed.checkpoint);
    const run = { worker: 'scorearc-alert-receiver', tick };
    let pending;
    try {
      pending = await prepareCheckpoint(previous, { run, now, clock, scopes: options.scopes ?? scopes,
        baseURL, check: options.check ?? checkScope, deliveryEnabled: true });
    } catch (error) {
      // The last drained GitHub run may already have observed this slot.
      if (error?.code === 'E_STALE_TICK') return { status: 'skipped', tick };
      throw error;
    }
    await save(pending);
    const final = await finishCheckpoint(pending, { now: clock(), clock, send: async event => {
      await assertOwner();
      await send(event);
    } });
    await save(final);
    if (!final.monitorFailure && final.pending.length === 0) {
      await assertOwner();
      await heartbeat(run);
    }
    return { status: 'observed', tick, dataIncident: final.dataIncident, monitorFailure: final.monitorFailure, pending: final.pending.length };
  } finally {
    await db.prepare(`UPDATE monitor_runtime SET lease_until = 0 WHERE ${owner} RETURNING id`).bind(tick, leaseUntil).first();
  }
}
