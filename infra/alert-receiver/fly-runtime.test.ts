import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { FLY_APP, FLY_RUN_URL, TICK_MS } from '../../scripts/match-freshness-fly.mjs';
import worker from './worker';

const token = 'f'.repeat(40);
const legacyToken = 'g'.repeat(40);
const tick = Date.UTC(2026, 10, 25, 12);
const epoch = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `${epoch}:${n}`;
const at = (time = tick) => new Date(time).toISOString();
const ctx = { waitUntil: vi.fn() };
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  vi.useFakeTimers({ now: tick + 1_000, toFake: ['Date'] });
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  const migrations = new URL('./migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const db = { prepare(query: string) { return { bind(...args: SQLInputValue[]) { return {
    first: async <T>() => (sql.prepare(query).get(...args) ?? null) as T | null,
    run: async () => { sql.prepare(query).run(...args); },
  }; } }; } };
  const email = vi.fn(async () => ({}));
  const env = { DB: db, EMAIL: { send: email }, RECEIVER_TOKEN: legacyToken, FLY_MONITOR_TOKEN: token, ALERT_RECIPIENT: 'owner@example.test' };
  const post = (op: string, body: object, overrides: RequestInit = {}, protocol = 'https') =>
    worker.fetch(new Request(`${protocol}://monitor.example/fly/${op}`, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...overrides }), env, ctx);
  const seed = { version: 3, run: { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml',
    ref: 'refs/heads/main', id: 12, number: 12, attempt: 1, sha: 'f'.repeat(40) }, epoch, origin: 'https://scorearc-reader.fly.dev',
    phase: 'final', sequence: 0, updatedAt: at(tick - TICK_MS), pending: [], delivered: [], reserved: [],
    monitorFailure: null, dataIncident: false, signals: {}, incidents: {} };
  const activate = () => sql.prepare("UPDATE monitor_runtime SET mode='fly', checkpoint=?").run(JSON.stringify(seed));
  const claim = async (slot = tick) => {
    const r = await post('claim', { tick: slot });
    expect(r.status).toBe(200);
    const result = await r.json() as { checkpoint: object; leaseUntil: number };
    return { tick: slot, leaseUntil: result.leaseUntil };
  };
  const pending = (n = 1, slot = tick) => {
    const queue = Array.from({ length: n }, (_, i) => ({ id: id(i + 1), scope: `liga-mx/season-${i}`, status: 'OPEN',
      incidentId: id(i + 1), occurredAt: at(slot), runUrl: FLY_RUN_URL, count: 3,
      observation: { stale: 1, overdue: 0, error: null, poll: 'ok', freshness: 'stale' },
      attempts: 1, nextAttemptAt: at(slot + TICK_MS) }));
    return { ...seed, run: { fly: FLY_APP, tick: slot }, phase: 'pending', sequence: n, updatedAt: at(slot), dataIncident: n > 0,
      pending: queue, reserved: queue.map(e => e.id), monitorFailure: n ? 'delivery-pending' : null };
  };
  const event = (i = 0) => {
    const e = pending(i + 1).pending[i];
    return { eventId: e.id, incidentId: e.incidentId, competition: 'liga-mx', season: `season-${i}`, status: e.status,
      occurredAt: e.occurredAt, runUrl: e.runUrl, count: e.count, ...e.observation };
  };
  const final = (n = 1, slot = tick) => ({ ...pending(n, slot), phase: 'final', reserved: [], pending: [],
    delivered: Array.from({ length: n }, (_, i) => ({ id: id(i + 1), acknowledgedAt: at(slot) })), monitorFailure: null });
  const read = () => JSON.parse(String(sql.prepare('SELECT checkpoint FROM monitor_runtime').get()?.checkpoint));
  const exported = (secret = legacyToken) => worker.fetch(new Request(`https://receiver.example/checkpoint/${secret}`, { method: 'POST' }), env, ctx);
  return { sql, post, email, env, seed, activate, claim, pending, final, event, read, exported };
}

it('installs in GitHub mode, never creates state on behalf of Fly, and fences claims to the current slot', async () => {
  const s = setup();
  expect(s.sql.prepare('SELECT * FROM monitor_runtime').get()).toEqual({ id: 1, mode: 'github', checkpoint: null, lease_until: 0, last_tick: null });
  for (const mode of ['github','draining']) {
    s.sql.prepare('UPDATE monitor_runtime SET mode=?').run(mode);
    expect((await s.post('claim', { tick })).status).toBe(204);
  }
  s.activate();
  expect((await s.post('claim', { tick: tick + TICK_MS })).status).toBe(409);
  s.sql.prepare('UPDATE monitor_runtime SET checkpoint=?').run(JSON.stringify({ ...s.seed, updatedAt: at(tick + 150) }));
  expect((await s.post('claim', { tick })).status).toBe(204);
  s.activate();
  const [r1, r2] = await Promise.all([s.post('claim', { tick }), s.post('claim', { tick })]);
  expect([r1.status, r2.status].sort()).toEqual([200, 204]);
  const body = await (r1.status === 200 ? r1 : r2).json();
  expect(body).toEqual({ checkpoint: s.seed, leaseUntil: Date.now() + 20 * 60_000 });
});

it('requires HTTPS, the dedicated strong bearer secret, supported actions and bounded JSON', async () => {
  const s = setup(); s.activate();
  for (const candidate of ['', legacyToken, 'x'.repeat(40)]) {
    expect((await s.post('claim', { tick }, { headers: { Authorization: `Bearer ${candidate}` } })).status).toBe(404);
  }
  expect((await s.post('claim', { tick }, {}, 'http')).status).toBe(404);
  expect((await s.post('sql', { tick })).status).toBe(404);
  expect((await s.post('claim', { tick }, { body: null, method: 'GET' })).status).toBe(405);
  expect((await s.post('claim', { tick }, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(415);
  expect((await s.post('claim', { tick, sql: 'delete' })).status).toBe(400);
  expect((await s.post('pending', { checkpoint: 'a'.repeat(257 * 1024) })).status).toBe(413);
  for (const candidate of ['', legacyToken, 'short']) {
    s.env.FLY_MONITOR_TOKEN = candidate;
    expect((await s.post('claim', { tick })).status).toBe(404);
  }
  expect(s.email).not.toHaveBeenCalled();
});

it('requires a stored matching FIFO reservation and receiver email receipt before final and heartbeat', async () => {
  const s = setup(); s.activate();
  const lease = await s.claim();
  const write = (phase: string, checkpoint: object) => s.post(phase, { ...lease, checkpoint });
  const send = (event: object) => s.post('event', { ...lease, event });
  expect((await s.post('heartbeat', lease)).status).toBe(409);
  expect((await write('final', s.final(2))).status).toBe(409);
  expect((await send(s.event())).status).toBe(409);
  for (const override of [{ origin: 'https://example.com' }, { run: { fly: 'other', tick } }, { run: { fly: FLY_APP, tick: tick - TICK_MS } },
    { reserved: [id(2)] }, { updatedAt: 'invalid' }]) {
    expect((await write('pending', { ...s.pending(2), ...override })).status).toBe(400);
  }
  expect((await write('pending', s.pending(2))).status).toBe(204);
  expect((await write('pending', s.pending(0))).status).toBe(409);
  expect((await write('final', s.final(2))).status).toBe(409);
  expect((await send({ ...s.event(), runUrl: 'https://example.com' })).status).toBe(400);
  expect((await send({ ...s.event(), count: 2 })).status).toBe(409);
  expect((await send(s.event(1))).status).toBe(409);
  expect(s.email).not.toHaveBeenCalled();
  expect(await (await send(s.event())).json()).toEqual({ eventId: id(1) });
  expect((await send(s.event())).status).toBe(200);
  expect(s.email).toHaveBeenCalledTimes(1);
  expect((await write('final', s.final(2))).status).toBe(409);
  expect((await s.post('heartbeat', lease)).status).toBe(409);
  expect((await send(s.event(1))).status).toBe(200);
  expect(await (await write('final', { ...s.final(2), signals: { mutated: true } })).status).toBe(409);
  expect((await write('final', s.final(2))).status).toBe(204);
  expect((await write('final', s.final(2))).status).toBe(409);
  expect((await s.exported()).status).toBe(409);
  expect((await s.post('heartbeat', lease)).status).toBe(204);
  vi.setSystemTime(tick + 65_000);
  expect((await s.post('heartbeat', lease)).status).toBe(204);
  expect(s.sql.prepare('SELECT last_at FROM monitor_heartbeat').get()?.last_at).toBe(at(tick));
  expect((await s.post('release', lease)).status).toBe(204);
  expect((await s.post('release', lease)).status).toBe(409);
  expect((await s.post('heartbeat', lease)).status).toBe(409);
  s.sql.exec("UPDATE monitor_runtime SET mode='draining'");
  expect((await s.exported(token)).status).toBe(404);
  expect(await (await s.exported()).json()).toEqual(s.final(2));
});

it('retains failed delivery and refuses stale owners even across a crashed producer and late final', async () => {
  const s = setup(); s.activate();
  const lease = await s.claim();
  const pending = s.pending(1);
  expect((await s.post('pending', { ...lease, checkpoint: pending })).status).toBe(204);
  s.email.mockRejectedValueOnce(new Error('no mail'));
  expect((await s.post('event', { ...lease, event: s.event() })).status).toBe(503);
  const failed = { ...pending, phase: 'final', reserved: [], monitorFailure: 'delivery-failed' };
  expect((await s.post('final', { ...lease, checkpoint: failed })).status).toBe(204);
  expect((await s.post('final', { ...lease, checkpoint: s.final() })).status).toBe(409);
  expect((await s.post('heartbeat', lease)).status).toBe(409);
  vi.setSystemTime(tick + TICK_MS);
  expect((await s.post('claim', { tick: tick + TICK_MS })).status).toBe(204);
  const next = tick + 5 * TICK_MS;
  vi.setSystemTime(next + 1000);
  const successor = await s.claim(next);
  expect((await s.post('release', lease)).status).toBe(409);
  expect((await s.post('heartbeat', lease)).status).toBe(409);
  expect((await s.post('event', { ...lease, event: s.event() })).status).toBe(409);
  expect((await s.post('pending', { ...successor, checkpoint: s.pending(0, next) })).status).toBe(409);
  expect(s.read()).toEqual(failed);
  const retry = { ...pending, run: { fly: FLY_APP, tick: next }, updatedAt: at(next),
    pending: [{ ...pending.pending[0], attempts: 2, nextAttemptAt: at(next + 2 * TICK_MS) }] };
  expect((await s.post('pending', { ...successor, checkpoint: retry })).status).toBe(204);
  expect((await s.post('event', { ...successor, event: s.event() })).status).toBe(200);
  expect((await s.post('final', { ...successor, checkpoint: s.final(1, next) })).status).toBe(204);
  expect((await s.post('heartbeat', successor)).status).toBe(204);
  expect(s.email).toHaveBeenCalledTimes(2);
});

it('does not mask a queue-full final or a lost receipt and fences delivery near lease expiry', async () => {
  const s = setup(); s.activate();
  const lease = await s.claim();
  const pending = { ...s.pending(), monitorFailure: 'queue-full' };
  expect((await s.post('pending', { ...lease, checkpoint: pending })).status).toBe(204);
  vi.setSystemTime(lease.leaseUntil - 20_000);
  expect((await s.post('event', { ...lease, event: s.event() })).status).toBe(409);
  expect(s.email).not.toHaveBeenCalled();
  vi.setSystemTime(tick + 2_000);
  expect((await s.post('event', { ...lease, event: s.event() })).status).toBe(200);
  expect((await s.post('final', { ...lease, checkpoint: s.final() })).status).toBe(409);
  expect((await s.post('final', { ...lease, checkpoint: { ...s.final(), monitorFailure: 'queue-full' } })).status).toBe(204);
  expect((await s.post('heartbeat', lease)).status).toBe(409);
});

it('recovers a crashed pending write from the next slot without re-emailing the acknowledged event', async () => {
  const s = setup(); s.activate();
  const first = await s.claim();
  const previous = s.pending();
  expect((await s.post('pending', { ...first, checkpoint: previous })).status).toBe(204);
  expect((await s.post('event', { ...first, event: s.event() })).status).toBe(200);
  // Simulate process death before final/release. D1 retains the reservation.
  const next = tick + 5 * TICK_MS;
  vi.setSystemTime(next + 1000);
  const r = await s.post('claim', { tick: next });
  expect(r.status).toBe(200);
  const claimed = await r.json() as { checkpoint: object; leaseUntil: number };
  expect(claimed.checkpoint).toEqual(previous);
  const successor = { tick: next, leaseUntil: claimed.leaseUntil };
  const retry = { ...previous, run: { fly: FLY_APP, tick: next }, updatedAt: at(next),
    pending: [{ ...previous.pending[0], attempts: 2, nextAttemptAt: at(next + 2 * TICK_MS) }] };
  expect((await s.post('pending', { ...successor, checkpoint: retry })).status).toBe(204);
  expect((await s.post('event', { ...successor, event: s.event() })).status).toBe(200);
  expect(s.email).toHaveBeenCalledOnce();
  const payload = String(s.sql.prepare('SELECT payload FROM alert_event').get()?.payload);
  s.sql.exec("UPDATE alert_event SET payload='[]'");
  expect((await s.post('final', { ...successor, checkpoint: s.final(1, next) })).status).toBe(409);
  expect((await s.post('heartbeat', successor)).status).toBe(409);
  s.sql.prepare('UPDATE alert_event SET payload=?').run(payload);
  expect((await s.post('final', { ...successor, checkpoint: s.final(1, next) })).status).toBe(204);
  expect((await s.post('heartbeat', successor)).status).toBe(204);
});

it('refuses an oversized checkpoint even when its transport wrapper fits', async () => {
  const s = setup(); s.activate();
  const lease = await s.claim();
  const cp = { ...s.pending(0), signals: { note: '' } };
  cp.signals.note = 'x'.repeat(256 * 1024 + 1 - JSON.stringify(cp).length);
  expect((await s.post('pending', { ...lease, checkpoint: cp })).status).toBe(413);
  cp.signals.note = cp.signals.note.slice(1);
  expect((await s.post('pending', { ...lease, checkpoint: cp })).status).toBe(204);
});

it('takes a real Fly reader failure and recovery through HTTP, SQLite receipts and the heartbeat', async () => {
  const { receiverRPC, runFlyTick } = await import('../../scripts/fly-match-freshness.mjs');
  const { newSignal } = await import('../../scripts/match-freshness-policy.mjs');
  const s = setup();
  const scope = { competition: 'liga-mx', season: '2026-apertura' };
  const key = scope.competition + '/' + scope.season;
  s.sql.prepare("UPDATE monitor_runtime SET mode='fly', checkpoint=?").run(JSON.stringify({
    ...s.seed, incidents: { [key]: null }, signals: { [key]: newSignal() },
  }));
  const rpc = receiverRPC(token, async (url, init) => worker.fetch(new Request(url, init), s.env, ctx));
  const publicReader = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json([], { headers: {
      'X-ScoreArc-Freshness': 'empty', 'X-ScoreArc-Poll-Status': 'ok', 'X-ScoreArc-Observed-At': at(tick + TICK_MS),
      'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0',
    } }));
  const options = { rpc, scopes: [scope] };
  await expect(runFlyTick(tick, options)).resolves.toMatchObject({ open: 1, pending: 0, errors: 1 });
  vi.setSystemTime(tick + TICK_MS);
  await expect(runFlyTick(tick + TICK_MS, options)).resolves.toMatchObject({ open: 0, pending: 0, errors: 0 });
  expect(s.read()).toMatchObject({ phase: 'final', sequence: 2, incidents: { [key]: null }, delivered: [{ id: id(1) }, { id: id(2) }] });
  expect(s.email).toHaveBeenCalledTimes(2);
  expect(s.sql.prepare('SELECT event_id FROM alert_event WHERE emailed_at IS NOT NULL ORDER BY event_id').all()).toEqual([
    { event_id: id(1) }, { event_id: id(2) },
  ]);
  expect(s.sql.prepare('SELECT last_at FROM monitor_heartbeat').get()?.last_at).toBe(at(tick + TICK_MS));
  expect(s.sql.prepare('SELECT lease_until FROM monitor_runtime').get()?.lease_until).toBe(0);
  expect(publicReader.mock.calls.map(([url]) => url)).toEqual(Array(2).fill(
    s.seed.origin + '/v1/competitions/' + key + '/matches?scope=season&detail=summary',
  ));
});
