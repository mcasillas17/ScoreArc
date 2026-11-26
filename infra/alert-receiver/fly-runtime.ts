// D1 owns the lease, email receipts and checkpoint. Only the authenticated Fly
// producer observes matches or applies incident policy.
import { FLY_APP, FLY_RUN_URL, TICK_MS } from '../../scripts/match-freshness-fly.mjs';
import { eventPayload, isEvent } from './event-payload';
import type { Env } from './worker';

type DB = Env['DB'];
type Fields = Record<string, unknown>;
interface Lease { tick: number; leaseUntil: number }
type StoredEvent = { id: string; incidentId: string; scope: string; status: string; occurredAt: string;
  runUrl: string; count: number | null; observation: Fields; attempts: number; nextAttemptAt: string };
type Receipt = { id: string; acknowledgedAt: string };
interface Checkpoint {
  version: number; run: { fly: string; tick: number }; epoch: string; origin: string; sequence: number;
  updatedAt: string; phase: string; incidents: Fields; signals: Fields; dataIncident: boolean;
  pending: StoredEvent[]; delivered: Receipt[]; reserved: string[]; monitorFailure: string | null;
}

export const MAX_CHECKPOINT = 256 * 1024;
const leaseMs = 20 * 60_000;
const sendReserveMs = 30_000;
const reader = 'https://scorearc-reader.fly.dev';
const object = (v: unknown): v is Fields => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const empty = (status: number) => new Response(null, { status });
const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
export const githubOwner = "mode IN ('github','draining') AND checkpoint IS NULL AND last_tick IS NULL AND lease_until=0";
const owner = "monitor_runtime.id=1 AND mode='fly' AND last_tick=? AND lease_until=? AND lease_until>?";
const currentCheckpoint = "json_extract(checkpoint,'$.run.fly')=? AND json_extract(checkpoint,'$.run.tick')=last_tick";
const settled = "json_extract(checkpoint,'$.phase')='final' AND json_type(checkpoint,'$.monitorFailure')='null' AND json_array_length(checkpoint,'$.pending')=0 AND json_array_length(checkpoint,'$.reserved')=0";

export async function getMonitorMode(db: DB) {
  const row = await db.prepare(`SELECT mode FROM monitor_runtime WHERE id=1 AND (
    (${githubOwner}) OR (mode IN ('fly','draining') AND checkpoint IS NOT NULL AND lease_until=0)
    OR (mode='fly' AND checkpoint IS NOT NULL AND lease_until>last_tick))`).bind().first<{ mode: string }>();
  if (!row) throw new Error('Invalid monitor mode');
  return row.mode;
}

export async function exportCheckpoint(db: DB) {
  const row = await db.prepare(`SELECT checkpoint FROM monitor_runtime
    WHERE id=1 AND mode='draining' AND lease_until=0 AND ${currentCheckpoint} AND ${settled}`)
    .bind(FLY_APP).first<{ checkpoint: string }>();
  return row ? new Response(row.checkpoint, { headers: jsonHeaders }) : empty(409);
}

export function validTick(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value % TICK_MS === 0;
}

export async function claim(db: DB, tick: number) {
  const now = Date.now();
  if (tick !== Math.floor(now / TICK_MS) * TICK_MS) return empty(409);
  const leaseUntil = now + leaseMs;
  const row = await db.prepare(`UPDATE monitor_runtime SET last_tick=?, lease_until=?
    WHERE id=1 AND mode='fly' AND checkpoint IS NOT NULL AND (last_tick IS NULL OR last_tick<?)
      AND lease_until<=? AND COALESCE(json_extract(checkpoint,'$.run.tick'),
        unixepoch(json_extract(checkpoint,'$.updatedAt')) * 1000) < ?
    RETURNING checkpoint`).bind(tick, leaseUntil, tick, now, tick).first<{ checkpoint: string }>();
  // D1 contains validated JSON. Avoid decoding and re-encoding the entire
  // checkpoint just to place it inside the claim response.
  return row ? new Response(`{"leaseUntil":${leaseUntil},"checkpoint":${row.checkpoint}}`, { headers: jsonHeaders }) : empty(204);
}

export async function release(db: DB, { tick, leaseUntil }: Lease) {
  const row = await db.prepare(`UPDATE monitor_runtime SET lease_until=0 WHERE ${owner} RETURNING id`).bind(tick, leaseUntil, Date.now()).first();
  return empty(row ? 204 : 409);
}

function notification(e: StoredEvent) {
  const [competition, season] = e.scope.split('/');
  const { stale, overdue, freshness, poll, error } = e.observation;
  return { eventId: e.id, incidentId: e.incidentId, competition, season, status: e.status,
    occurredAt: e.occurredAt, runUrl: e.runUrl, count: e.count, stale, overdue, freshness, poll, error };
}

// Every send is bound to the persisted FIFO reservation and its contents. A
// later event cannot pass one whose receiver receipt is still outstanding.
export async function reservedEvent(db: DB, { tick, leaseUntil }: Lease, event: Fields) {
  if (Date.now() + sendReserveMs >= leaseUntil) return false;
  const row = await db.prepare(`SELECT json_extract(checkpoint,'$.pending[' || r.key || ']') AS queued
    FROM monitor_runtime, json_each(checkpoint,'$.reserved') r
    WHERE ${owner} AND ${currentCheckpoint} AND json_extract(checkpoint,'$.phase')='pending'
      AND r.value=? AND NOT EXISTS (
        SELECT 1 FROM json_each(checkpoint,'$.reserved') earlier
        LEFT JOIN alert_event a ON a.event_id=earlier.value AND a.emailed_at IS NOT NULL
        WHERE earlier.key<r.key AND a.event_id IS NULL)`).bind(tick, leaseUntil, Date.now() + sendReserveMs, FLY_APP, String(event.eventId))
    .first<{ queued: string }>();
  if (!row || Date.now() + sendReserveMs >= leaseUntil) return false;
  const stored = notification(JSON.parse(row.queued));
  return Object.keys(event).every(k => event[k] === (stored as Fields)[k]);
}

export function heartbeatGuard({ tick, leaseUntil }: Lease) {
  return { query: `SELECT 1 FROM monitor_runtime WHERE ${owner} AND ${currentCheckpoint} AND ${settled}`,
    args: [tick, leaseUntil, Date.now(), FLY_APP] };
}

function validCheckpoint(value: unknown, phase: string, tick: number): value is Checkpoint {
  if (!object(value) || value.version !== 3 || value.origin !== reader ||
      !object(value.run) || Object.keys(value.run).length !== 2 || value.run.fly !== FLY_APP || value.run.tick !== tick ||
      value.phase !== phase || !iso(value.updatedAt) || Date.parse(value.updatedAt) < tick || Date.parse(value.updatedAt) > Date.now() + 5_000 ||
      typeof value.epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.epoch) ||
      typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !object(value.signals) || !object(value.incidents) || typeof value.dataIncident !== 'boolean' ||
      !Array.isArray(value.pending) || value.pending.length > 128 || !Array.isArray(value.reserved) || value.reserved.length > 16 ||
      !Array.isArray(value.delivered) || value.delivered.length > 32) return false;
  const cp = value as unknown as Checkpoint;
  const end = cp.sequence - cp.pending.length;
  return end >= 0 && cp.pending.every((e, i) => object(e) && e.id === `${cp.epoch}:${end + i + 1}` && typeof e.scope === 'string' &&
    object(e.observation) && isEvent(notification(e), true)) &&
    cp.delivered.length === Math.min(32, end) && cp.delivered.every((r, i) => object(r) &&
      r.id === `${cp.epoch}:${end - cp.delivered.length + i + 1}` && iso(r.acknowledgedAt) && r.acknowledgedAt <= cp.updatedAt) &&
    cp.reserved.every((id, i) => id === cp.pending[i]?.id && cp.pending[i]?.attempts > 0) &&
    (!cp.reserved.length || phase === 'pending') && (cp.monitorFailure === null ? !cp.pending.length :
      ['queue-full','delivery-pending','delivery-exhausted','delivery-failed'].includes(cp.monitorFailure));
}

// Fly validates the complete policy envelope. Here the store enforces the
// transitions affecting ownership, the delivery queue and acknowledgment.
export async function saveCheckpoint(db: DB, lease: Lease, phase: 'pending' | 'final', value: unknown) {
  if (!validCheckpoint(value, phase, lease.tick)) return empty(400);
  const raw = JSON.stringify(value);
  if (raw.length > MAX_CHECKPOINT || (raw.length > MAX_CHECKPOINT / 3 && new TextEncoder().encode(raw).length > MAX_CHECKPOINT)) return empty(413);
  const args = [lease.tick, lease.leaseUntil, Date.now()];
  if (phase === 'pending') {
    // A crash can leave the previous slot in pending phase. Its queue must
    // survive re-observation, with only the retry counters and backoff mutable.
    const row = await db.prepare(`UPDATE monitor_runtime SET checkpoint=incoming.value FROM (SELECT ? AS value) incoming
      WHERE ${owner} AND COALESCE(json_extract(checkpoint,'$.run.tick'),-1)<last_tick
      AND json_extract(checkpoint,'$.epoch')=? AND json_extract(checkpoint,'$.origin')=?
      AND json_extract(checkpoint,'$.sequence')-json_array_length(checkpoint,'$.pending')=?
      AND json_extract(checkpoint,'$.delivered')=json_extract(incoming.value,'$.delivered')
      AND NOT EXISTS (SELECT 1 FROM json_each(incoming.value,'$.pending') added
        WHERE added.key>=json_array_length(checkpoint,'$.pending') AND json_extract(added.value,'$.runUrl') IS NOT ?)
      AND NOT EXISTS (SELECT 1 FROM json_each(checkpoint,'$.pending') old
        WHERE json_remove(old.value,'$.attempts','$.nextAttemptAt') IS NOT
          json_remove(json_extract(incoming.value,'$.pending[' || old.key || ']'),'$.attempts','$.nextAttemptAt'))
      RETURNING id`).bind(raw, ...args, value.epoch, reader, value.sequence - value.pending.length, FLY_RUN_URL).first();
    return empty(row ? 204 : 409);
  }
  const row = await db.prepare(`SELECT json_array_length(checkpoint,'$.pending') AS queued,
    (SELECT json_group_array(json(e.value) ORDER BY e.key) FROM json_each(checkpoint,'$.pending') e
      WHERE e.key < json_array_length(checkpoint,'$.reserved')) AS reserved,
    json_extract(checkpoint,'$.delivered') AS delivered, json_extract(checkpoint,'$.monitorFailure') AS failure,
    json_extract(checkpoint,'$.updatedAt') AS updated FROM monitor_runtime
    WHERE ${owner} AND ${currentCheckpoint} AND json_extract(checkpoint,'$.phase')='pending'`)
    .bind(...args, FLY_APP).first<{ queued: number; reserved: string; delivered: string; failure: string | null; updated: string }>();
  if (!row) return empty(409);
  const reserved: StoredEvent[] = JSON.parse(row.reserved);
  const delivered: Receipt[] = JSON.parse(row.delivered);
  const count = row.queued - value.pending.length;
  if (count < 0 || count > reserved.length || value.updatedAt < row.updated ||
      (row.failure === 'queue-full' && count === reserved.length && value.monitorFailure !== 'queue-full') ||
      (count < reserved.length && value.monitorFailure !== 'delivery-failed')) return empty(409);

  const acknowledged = reserved.slice(0, count);
  const carried = delivered.slice(Math.max(0, delivered.length + count - 32));
  if (value.delivered.length !== carried.length + count ||
      carried.some((r, i) => r.id !== value.delivered[i].id || r.acknowledgedAt !== value.delivered[i].acknowledgedAt) ||
      acknowledged.some((e, i) => value.delivered[carried.length + i].id !== e.id)) return empty(409);
  if (count) {
    const expected = acknowledged.map(e => [e.id, eventPayload(notification(e))]);
    const receipts = await db.prepare(`SELECT COUNT(*) AS n FROM json_each(?) expected
      JOIN alert_event ON event_id=json_extract(expected.value,'$[0]') AND payload=json_extract(expected.value,'$[1]')
      WHERE emailed_at IS NOT NULL`).bind(JSON.stringify(expected)).first<{ n: number }>();
    if (receipts?.n !== count) return empty(409);
  }
  // A final write may only remove the acknowledged prefix and record receipts.
  // The SQL comparison keeps signal/incident maps in D1. CAS also fences a
  // duplicate final arriving during the receipt lookup.
  const mutable = "'$.updatedAt','$.phase','$.monitorFailure','$.pending','$.reserved','$.delivered'";
  const saved = await db.prepare(`UPDATE monitor_runtime SET checkpoint=incoming.value FROM (SELECT ? AS value) incoming
    WHERE ${owner} AND ${currentCheckpoint} AND json_extract(checkpoint,'$.phase')='pending'
    AND json_remove(checkpoint,${mutable})=json_remove(incoming.value,${mutable})
    AND NOT EXISTS (SELECT 1 FROM json_each(incoming.value,'$.pending') next
      WHERE next.value IS NOT json_extract(checkpoint,'$.pending[' || (next.key + CAST(? AS INTEGER)) || ']'))
    RETURNING id`)
    .bind(raw, lease.tick, lease.leaseUntil, Date.now(), FLY_APP, count).first();
  return empty(saved ? 204 : 409);
}
