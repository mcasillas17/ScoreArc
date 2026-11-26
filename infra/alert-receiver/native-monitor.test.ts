import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { newSignal } from '../../scripts/match-freshness-policy.mjs';
import { currentScopes } from '../../scripts/match-freshness-reader.mjs';
import registry from '../../backend/config/competitions.json';
import { getMonitorMode, runNativeTick } from './native-monitor.mjs';

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function database() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  const migrations = new URL('./migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const db = { prepare(query: string) {
    const statement = sql.prepare(query);
    return { bind(...args: SQLInputValue[]) { return {
      first: async () => statement.get(...args) ?? null,
    }; } };
  } };
  return { db, sql };
}

it('migrates existing receivers with GitHub as the sole producer', () => {
  const { sql } = database();
  expect(sql.prepare('SELECT * FROM monitor_runtime').all()).toEqual([
    { id: 1, mode: 'github', checkpoint: null, last_tick: null, lease_until: 0 },
  ]);
});

const first = Date.UTC(2026, 10, 25, 12);
const interval = 5 * 60_000;
const baseURL = 'https://scorearc-reader.fly.dev';
const scopes = [{ competition: 'liga-mx', season: '2026-apertura' }];
const key = 'liga-mx/2026-apertura';
const epoch = '11111111-1111-4111-8111-111111111111';
const github = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml',
  ref: 'refs/heads/main', id: 100, number: 1, attempt: 1, sha: '1'.repeat(40) };
const healthy = { ok: true, count: 0, observation: { freshness: 'empty', poll: 'ok', stale: 0, overdue: 0, error: null } };
const outage = { ok: false, count: null, observation: { freshness: null, poll: null, stale: null, overdue: null, error: 'http-503' } };

function live(updated = first - interval) {
  const { db, sql } = database();
  const checkpoint = { version: 3, origin: baseURL, epoch, run: github, sequence: 0, updatedAt: new Date(updated).toISOString(),
    phase: 'final', incidents: { [key]: null }, signals: { [key]: newSignal() },
    pending: [], delivered: [], reserved: [], dataIncident: false, monitorFailure: null };
  sql.prepare("UPDATE monitor_runtime SET mode = 'cloudflare', checkpoint = ? WHERE id = 1").run(JSON.stringify(checkpoint));
  const runtime = () => sql.prepare('SELECT checkpoint, last_tick, lease_until FROM monitor_runtime WHERE id = 1').get()!;
  const state = () => JSON.parse(String(runtime().checkpoint));
  const check = vi.fn<() => Promise<typeof healthy | typeof outage>>().mockResolvedValue(healthy);
  const send = vi.fn(async (_event: { eventId: string }) => {});
  const heartbeat = vi.fn(async () => {});
  let wall = first;
  const clock = () => wall;
  const tick = (scheduledTime = first, at = scheduledTime) => {
    wall = at;
    return runNativeTick({ db, scheduledTime, clock, scopes, check, send, heartbeat });
  };
  return { db, sql, runtime, state, send, heartbeat, check, tick };
}

it('validates the selected mode and makes no native checks in GitHub or drain mode', async () => {
  const { db, sql, check, tick, heartbeat, send } = live();
  sql.exec('UPDATE monitor_runtime SET checkpoint = NULL');
  for (const mode of ['github', 'draining']) {
    sql.prepare('UPDATE monitor_runtime SET mode = ?').run(mode);
    expect(await getMonitorMode(db)).toBe(mode);
    await tick();
    expect(sql.prepare('SELECT last_tick, lease_until FROM monitor_runtime').get()).toEqual({ last_tick: null, lease_until: 0 });
  }
  sql.exec("PRAGMA ignore_check_constraints=ON; UPDATE monitor_runtime SET mode = 'other'");
  await expect(getMonitorMode(db)).rejects.toThrow(/mode/i);
  sql.exec('DELETE FROM monitor_runtime');
  await expect(getMonitorMode(db)).rejects.toThrow(/mode/i);
  expect(check).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled();
});

it('accepts a drained native checkpoint while rejecting structurally impossible ownership rows', async () => {
  const { db, sql, tick, runtime } = live();
  await tick();
  const committed = runtime();
  sql.exec("UPDATE monitor_runtime SET mode='draining'");
  expect(await getMonitorMode(db)).toBe('draining');
  await tick(first + interval);
  expect(runtime()).toEqual(committed);
  sql.exec('UPDATE monitor_runtime SET lease_until=1');
  await expect(getMonitorMode(db)).rejects.toThrow(/mode/i);
  sql.exec("UPDATE monitor_runtime SET mode='cloudflare', lease_until=0, checkpoint=NULL");
  await expect(getMonitorMode(db)).rejects.toThrow(/mode/i);
});

it.each([null, '{', '{}'])('refuses to start native history from an absent or corrupt import (%s)', async raw => {
  const { sql, check, send, heartbeat, tick } = live();
  sql.prepare('UPDATE monitor_runtime SET checkpoint = ?').run(raw);
  await expect(tick()).rejects.toThrow();
  expect(check).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled();
  expect(sql.prepare('SELECT checkpoint FROM monitor_runtime').get()?.checkpoint).toBe(raw);
});

it('begins only after the imported GitHub observation slot, even for a delayed cron invocation', async () => {
  const { tick, state, check, heartbeat } = live(first + 45_000);
  await tick(first, first + interval + 1000);
  expect(state().run).toEqual(github); expect(check).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled();
  await tick(first + interval, first + interval + 2000);
  expect(check).toHaveBeenCalledOnce(); expect(heartbeat).toHaveBeenCalledOnce();
});

it('checks each monitored edition on the reader with the production registry and scope checker', async () => {
  const { db, send, heartbeat, state } = live();
  const fetchReader = vi.fn(async (_url: URL | string) => new Response('[]', { headers: {
    'Content-Type': 'application/json', 'X-ScoreArc-Freshness': 'empty', 'X-ScoreArc-Poll-Status': 'ok',
    'X-ScoreArc-Observed-At': new Date(first).toISOString(), 'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0',
  } }));
  vi.stubGlobal('fetch', fetchReader);
  await runNativeTick({ db, scheduledTime: first, clock: () => first, send, heartbeat });
  const editions = currentScopes(registry);
  expect(fetchReader.mock.calls.map(([url]) => String(url))).toEqual(editions.map(({ competition, season }) =>
    `${baseURL}/v1/competitions/${competition}/${season}/matches?scope=season&detail=summary`));
  expect(Object.keys(state().incidents).sort()).toEqual(editions.map(scope => `${scope.competition}/${scope.season}`).sort());
  expect(send).not.toHaveBeenCalled(); expect(heartbeat).toHaveBeenCalledOnce();
});

it('reserves the event before sending and persists its receipt before reporting a completed tick', async () => {
  const { tick, check, send, heartbeat, runtime, state } = live();
  check.mockResolvedValue(outage);
  send.mockImplementation(async event => {
    expect(state()).toMatchObject({ phase: 'pending', reserved: [event.eventId], pending: [{ id: event.eventId, attempts: 1 }] });
  });
  heartbeat.mockImplementation(async () => {
    expect(runtime().lease_until).toBeGreaterThan(first + 15 * 60_000);
    expect(state()).toMatchObject({ phase: 'final', delivered: [{ id: `${epoch}:1` }], pending: [], monitorFailure: null });
  });
  await tick();
  expect(send).toHaveBeenCalledOnce(); expect(heartbeat).toHaveBeenCalledOnce();
  expect(state()).toMatchObject({ run: { worker: 'scorearc-alert-receiver', tick: first }, dataIncident: true });
  expect(runtime().lease_until).toBe(0);
  await tick(first + 2000); // same five-minute slot
  await tick(first - interval, first + 3000);
  expect(check).toHaveBeenCalledOnce(); expect(heartbeat).toHaveBeenCalledOnce();
});

it('retains the pending reservation across a crashed final write and honors its backoff and event ID', async () => {
  const { sql, tick, state, check, send, heartbeat } = live();
  check.mockResolvedValue(outage);
  sql.exec(`CREATE TRIGGER crash_final BEFORE UPDATE OF checkpoint ON monitor_runtime
    WHEN json_extract(NEW.checkpoint, '$.phase') = 'final' BEGIN SELECT RAISE(ABORT, 'disk error'); END`);
  await expect(tick(first, first + 1000)).rejects.toThrow();
  expect(send).toHaveBeenCalledOnce(); expect(heartbeat).not.toHaveBeenCalled();
  expect(state()).toMatchObject({ phase: 'pending', reserved: [`${epoch}:1`], pending: [{ id: `${epoch}:1`, attempts: 1 }] });
  sql.exec('DROP TRIGGER crash_final');
  await tick(first + interval); // 1s short of the reservation's retry time
  expect(send).toHaveBeenCalledOnce(); expect(heartbeat).not.toHaveBeenCalled();
  expect(state()).toMatchObject({ phase: 'final', pending: [{ attempts: 1 }], monitorFailure: 'delivery-pending' });
  await tick(first + 2 * interval);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]); expect(heartbeat).toHaveBeenCalledOnce();
  expect(state()).toMatchObject({ phase: 'final', sequence: 1, pending: [], delivered: [{ id: `${epoch}:1` }] });
});

it('does not deliver or beat when the pending checkpoint write fails', async () => {
  const { sql, tick, state, check, send, heartbeat } = live();
  check.mockResolvedValue(outage);
  sql.exec(`CREATE TRIGGER crash_pending BEFORE UPDATE OF checkpoint ON monitor_runtime
    WHEN json_extract(NEW.checkpoint, '$.phase') = 'pending' BEGIN SELECT RAISE(ABORT, 'disk error'); END`);
  await expect(tick()).rejects.toThrow();
  expect(state().run).toEqual(github); expect(send).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled();
});

it('continues observing recoveries while failed events wait for a FIFO retry', async () => {
  const { tick, state, check, send, heartbeat } = live();
  check.mockResolvedValueOnce(outage);
  send.mockRejectedValueOnce(new Error('provider unavailable'));
  await tick(first, first + 2000);
  expect(state().monitorFailure).toBe('delivery-failed');
  await tick(first + interval);
  expect(state().pending.map((event: { status: string }) => event.status)).toEqual(['OPEN', 'RESOLVED']);
  expect(send).toHaveBeenCalledOnce(); expect(heartbeat).not.toHaveBeenCalled();
  await tick(first + 2 * interval);
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual([`${epoch}:1`, `${epoch}:1`, `${epoch}:2`]);
  expect(state().incidents[key]).toBeNull(); expect(heartbeat).toHaveBeenCalledOnce();
});

it('allows one producer through delivery, including duplicated and overlapping cron triggers', async () => {
  const { check, send, heartbeat, tick } = live();
  check.mockResolvedValue(outage);
  const delivering = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  send.mockImplementationOnce(async () => { delivering.resolve(); await ack.promise; });
  const firstRun = tick();
  await delivering.promise;
  await Promise.all([tick(), tick(first + interval)]);
  expect(send).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce(); expect(heartbeat).not.toHaveBeenCalled();
  ack.resolve();
  await firstRun;
  expect(heartbeat).toHaveBeenCalledOnce();
});

it('fences an expired writer even if its observations finish after a successor has committed', async () => {
  const { check, send, heartbeat, tick, runtime, state } = live();
  const observing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  check.mockImplementationOnce(async () => { observing.resolve(); await resume.promise; return outage; });
  const stale = tick();
  await observing.promise;
  const next = Math.ceil(Number(runtime().lease_until) / interval) * interval;
  expect(next).toBeGreaterThan(first + 15 * 60_000);
  await tick(next);
  resume.resolve();
  await expect(stale).rejects.toThrow(/lease/i);
  expect(send).not.toHaveBeenCalled(); expect(heartbeat).toHaveBeenCalledOnce();
  expect(state()).toMatchObject({ phase: 'final', sequence: 0, run: { tick: next } });
  expect(runtime()).toMatchObject({ lease_until: 0, last_tick: next });
});
