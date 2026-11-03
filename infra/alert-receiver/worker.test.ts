import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as monitor from '../../scripts/match-freshness-monitor.mjs';
import worker, { type Env } from './worker';

const MAX_EVENTS_PER_DAY = 300;
const ctx = { waitUntil: vi.fn() };
const TOKEN = 't'.repeat(40);
const URL_OK = `http://127.0.0.1/events/${TOKEN}`;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true });
});

// The real migration on real SQLite; D1 is SQLite behind this same small surface.
async function database() {
  const failing = { statement: '' };
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('./migrations/0001_alert_event.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    failing,
    prepare: (sql: string) => ({
      bind: (...args: (string | number)[]) => ({
        first: async <T>() => {
          if (failing.statement && sql.startsWith(failing.statement)) throw new Error(`d1 down ${TOKEN}`);
          return (sqlite.prepare(sql).get(...args) ?? null) as T | null;
        },
        run: async () => {
          if (failing.statement && sql.startsWith(failing.statement)) throw new Error(`d1 down ${TOKEN}`);
          sqlite.prepare(sql).run(...args);
        },
      }),
    }),
  };
}
async function setup() {
  const db = await database();
  const send = vi.fn(async (_message: { to: string; subject: string; text: string; html: string }) => ({ messageId: 'm' }));
  const env: Env = { DB: db, EMAIL: { send }, RECEIVER_TOKEN: TOKEN, ALERT_RECIPIENT: 'owner@example.test' };
  return { db, send, env };
}
const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: '11111111-1111-4111-8111-111111111111:1', incidentId: '11111111-1111-4111-8111-111111111111:1',
  competition: 'liga-mx', season: '2026-apertura', status: 'OPEN', occurredAt: '2026-11-01T12:00:00.000Z',
  runUrl: 'https://github.com/mcasillas17/ScoreArc/actions/runs/123', count: 4,
  freshness: 'stale', poll: 'ok', stale: 2, overdue: 1, error: null, ...overrides,
});
function post(body: unknown, { url = URL_OK, key }: { url?: string; key?: string } = {}) {
  const parsed = body as { eventId?: string };
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key ?? parsed.eventId ?? '' },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const emailed = (db: Awaited<ReturnType<typeof database>>) => db.sqlite.prepare('SELECT event_id, emailed_at FROM alert_event ORDER BY rowid').all() as { event_id: string; emailed_at: string | null }[];

describe('alert receiver protocol', () => {
  it('exports only its handler, because workerd refuses to start on any other export', async () => {
    expect(Object.keys(await import('./worker'))).toEqual(['default']);
  });
  it('saves and emails an event, then acknowledges with exactly its id', async () => {
    const { db, send, env } = await setup();
    const response = await worker.fetch(post(event()), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ eventId: event().eventId });
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0][0];
    expect(message.to).toBe('owner@example.test');
    expect(message.subject).toContain('OPEN'); expect(message.subject).toContain('liga-mx');
    expect(message.text).toContain(event().runUrl); expect(message.text).toContain(event().eventId);
    expect(message.html).toContain('liga-mx');
    expect(emailed(db)[0].emailed_at).not.toBeNull();
  });
  it('replays an acknowledged id without a second email', async () => {
    const { send, env } = await setup();
    await worker.fetch(post(event()), env, ctx);
    const replay = await worker.fetch(post(event()), env, ctx);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ eventId: event().eventId });
    expect(send).toHaveBeenCalledOnce();
  });
  it('withholds acknowledgment while email fails and sends once it recovers', async () => {
    const { db, send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    send.mockRejectedValueOnce(Object.assign(new Error(`provider said ${TOKEN}`), { code: 'E_DELIVERY_FAILED' }));
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: `bad ${TOKEN}` }));
    for (let i = 0; i < 2; i++) expect((await worker.fetch(post(event()), env, ctx)).status).toBe(503);
    expect(emailed(db)).toEqual([{ event_id: event().eventId, emailed_at: null }]);
    expect((await worker.fetch(post(event()), env, ctx)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('E_DELIVERY_FAILED');
    expect(logged).not.toContain(TOKEN); expect(logged).not.toContain('owner@example.test');
  });
  it.each(['SELECT', 'INSERT'])('sends nothing when the database fails on %s, before the email', async statement => {
    const { db, send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.failing.statement = statement;
    expect((await worker.fetch(post(event()), env, ctx)).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    db.failing.statement = '';
    expect(emailed(db)).toEqual([]);
  });
  it('fails safely when the database breaks after the email went out', async () => {
    const { db, send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.failing.statement = 'UPDATE';
    expect((await worker.fetch(post(event()), env, ctx)).status).toBe(503);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    db.failing.statement = '';
    expect((await worker.fetch(post(event()), env, ctx)).status).toBe(200);
    // The documented at-least-once duplicate: same id, never a lost alert.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].text).toBe(send.mock.calls[0][0].text);
  });
  it('rejects the same id with different content instead of acknowledging it', async () => {
    const { send, env } = await setup();
    await worker.fetch(post(event()), env, ctx);
    expect((await worker.fetch(post(event({ count: 5 })), env, ctx)).status).toBe(409);
    expect(send).toHaveBeenCalledOnce();
  });
  it('hides itself from a wrong token and fails closed on weak configuration', async () => {
    const { db, send, env } = await setup();
    for (const url of ['http://127.0.0.1/', 'http://127.0.0.1/events/', `http://127.0.0.1/events/${'x'.repeat(40)}`, `${URL_OK}/extra`]) {
      expect((await worker.fetch(post(event(), { url }), env, ctx)).status).toBe(404);
    }
    expect((await worker.fetch(new Request(URL_OK), env, ctx)).status).toBe(405);
    for (const broken of [{ RECEIVER_TOKEN: 'short' }, { RECEIVER_TOKEN: '' }, { ALERT_RECIPIENT: '' }]) {
      const response = await worker.fetch(post(event(), { url: `http://127.0.0.1/events/${broken.RECEIVER_TOKEN ?? TOKEN}` }), { ...env, ...broken }, ctx);
      expect(response.status).toBe(500); expect(await response.text()).toBe('');
    }
    expect(send).not.toHaveBeenCalled(); expect(emailed(db)).toEqual([]);
  });
  it.each([
    ['unknown key', event({ extra: 1 })],
    ['missing key', (({ count: _count, ...rest }) => rest)(event())],
    ['status', event({ status: 'MAYBE' })],
    ['header injection in competition', event({ competition: 'liga\r\nBcc: x@example.test' })],
    ['markup in season', event({ season: '<b>2026</b>' })],
    ['foreign run link', event({ runUrl: 'https://evil.example/actions/runs/1' })],
    ['event id shape', event({ eventId: 'nope' })],
    ['count bound', event({ count: 5001 })],
    ['free-form error', event({ error: 'secret dependency message' })],
    ['not an object', '[]'],
    ['malformed JSON', '{'],
  ])('rejects invalid input: %s', async (_name, body) => {
    const { db, send, env } = await setup();
    const key = typeof body === 'string' ? event().eventId : undefined;
    expect((await worker.fetch(post(body, { key }), env, ctx)).status).toBe(400);
    expect(send).not.toHaveBeenCalled(); expect(emailed(db)).toEqual([]);
  });
  it('rejects a mismatched idempotency key, wrong type and oversized body', async () => {
    const { send, env } = await setup();
    expect((await worker.fetch(post(event(), { key: 'other' }), env, ctx)).status).toBe(400);
    const text = new Request(URL_OK, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': event().eventId }, body: JSON.stringify(event()) });
    expect((await worker.fetch(text, env, ctx)).status).toBe(415);
    expect((await worker.fetch(post(' '.repeat(5000), { key: event().eventId }), env, ctx)).status).toBe(413);
    const declared = new Request(URL_OK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '5000', 'Idempotency-Key': event().eventId }, body: JSON.stringify(event()) });
    expect((await worker.fetch(declared, env, ctx)).status).toBe(413);
    const noBody = new Request(URL_OK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event().eventId } });
    expect((await worker.fetch(noBody, env, ctx)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses changed content on a retry of an event it has not emailed yet', async () => {
    const { db, send, env } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    send.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'E_DELIVERY_FAILED' }));
    await worker.fetch(post(event()), env, ctx);
    expect((await worker.fetch(post(event({ count: 5 })), env, ctx)).status).toBe(409);
    expect(send).toHaveBeenCalledOnce();
    expect(emailed(db)[0].emailed_at).toBeNull();
  });
  it('logs an authenticated rejection by status alone, and stays silent on a wrong token', async () => {
    const { env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.fetch(post(event(), { url: 'http://127.0.0.1/events/wrong' }), env, ctx);
    expect(log).not.toHaveBeenCalled();
    await worker.fetch(post(event({ count: 5001 })), env, ctx);
    expect(log.mock.calls).toEqual([['alert-receiver: rejected', 400]]);
  });
  it('compares content, not key order, so a reordered retry is still the same event', async () => {
    const { send, env } = await setup();
    await worker.fetch(post(event()), env, ctx);
    const reordered = Object.fromEntries(Object.entries(event()).reverse());
    const replay = await worker.fetch(post(reordered), env, ctx);
    expect(replay.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });
  it('finishes recording a slow send after the sender has given up', async () => {
    const { db, send, env } = await setup();
    let finishSend = () => {};
    send.mockImplementationOnce(() => new Promise(resolve => { finishSend = () => resolve({ messageId: 'm' }); }));
    const kept: Promise<unknown>[] = [];
    void worker.fetch(post(event()), env, { waitUntil: work => { kept.push(work); } });
    expect(kept).toHaveLength(1); // kept alive whether or not the sender stays connected
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    finishSend();
    await kept[0];
    expect(emailed(db)[0].emailed_at).not.toBeNull();
    expect((await worker.fetch(post(event()), env, ctx)).status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });
  describe('daily cap', () => {
    const next = event({ eventId: '11111111-1111-4111-8111-111111111111:9999', incidentId: '11111111-1111-4111-8111-111111111111:9999' });
    const fill = (db: Awaited<ReturnType<typeof database>>, rows: number, at = new Date().toISOString()) => {
      const insert = db.sqlite.prepare('INSERT INTO alert_event(event_id, payload, accepted_at, emailed_at) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < rows; i++) insert.run(`filler:${at}:${i}`, '{}', at, at);
    };
    it('refuses a new event at the cap without writing, but acknowledges what was already sent', async () => {
      const { db, send, env } = await setup();
      await worker.fetch(post(event()), env, ctx);
      fill(db, MAX_EVENTS_PER_DAY - 1);
      expect((await worker.fetch(post(next), env, ctx)).status).toBe(503);
      expect(emailed(db)).toHaveLength(MAX_EVENTS_PER_DAY);
      expect((await worker.fetch(post(event()), env, ctx)).status).toBe(200);
      expect(send).toHaveBeenCalledOnce();
    });
    it('admits the last event under the cap', async () => {
      const { db, send, env } = await setup();
      fill(db, MAX_EVENTS_PER_DAY - 1);
      expect((await worker.fetch(post(next), env, ctx)).status).toBe(200);
      expect(send).toHaveBeenCalledOnce();
    });
    it('rolls: rows older than a day no longer count', async () => {
      const { db, send, env } = await setup();
      fill(db, MAX_EVENTS_PER_DAY, new Date(Date.now() - 25 * 3600_000).toISOString());
      expect((await worker.fetch(post(next), env, ctx)).status).toBe(200);
      expect(send).toHaveBeenCalledOnce();
    });
    it('still delivers an accepted event whose first send failed, even at the cap', async () => {
      const { db, send, env } = await setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      send.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'E_DELIVERY_FAILED' }));
      fill(db, MAX_EVENTS_PER_DAY - 1);
      expect((await worker.fetch(post(next), env, ctx)).status).toBe(503);
      expect((await worker.fetch(post(next), env, ctx)).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});

// The real sender state machine against the real receiver: no acknowledgment shortcut.
describe('real monitor sender against the receiver', () => {
  const scopes = [{ competition: 'liga-mx', season: '2026-apertura' }];
  const baseRun = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml', ref: 'refs/heads/main', id: 100, number: 10, attempt: 1, sha: 'a'.repeat(40) };
  const fresh = { ok: true, count: 1, context: '', observation: { freshness: 'fresh', poll: 'ok', stale: 0, overdue: 0, error: null } };
  const stale = { ...fresh, ok: false, observation: { ...fresh.observation, freshness: 'stale', stale: 1 } };
  async function sender(env: Env) {
    const dir = await mkdtemp(join(tmpdir(), 'alert-receiver-')); dirs.push(dir);
    let run = baseRun; let now = Date.parse('2026-11-01T12:00:00Z'); let first = true;
    const stateFile = join(dir, 'state.json');
    const common = () => ({ enabled: true, deliveryEnabled: true, baseURL: 'https://reader.example', scopes, stateFile, run, now });
    return {
      stateFile,
      async prepare(result: typeof fresh | ReturnType<typeof failed>) {
        const restoredRun = run;
        if (!first) { run = { ...run, id: run.id + 1, number: run.number + 1 }; now += 7 * 3600_000; }
        const initialize = first; first = false;
        return monitor.prepareMonitor({ ...common(), initialize, restoredRun, check: async () => result });
      },
      deliver(fetchImpl: typeof fetch = (input, init) => worker.fetch(new Request(input, init), env, ctx), timeoutMs?: number) {
        return monitor.deliverMonitor({ ...common(), webhookURL: URL_OK, pendingArtifactId: 1, fetchImpl, timeoutMs });
      },
    };
  }
  const failed = (error: string) => ({ ok: false, count: null, context: '', observation: { freshness: null, poll: null, stale: null, overdue: null, error } });
  const subjects = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([m]) => (m as { subject: string }).subject.split(' ')[1].replace(':', ''));

  it('delivers OPEN, stays quiet on repeated failure, then RESOLVED and recurrence in order', async () => {
    const { db, send, env } = await setup();
    const s = await sender(env);
    await s.prepare(fresh); await s.deliver();
    await s.prepare(stale); expect((await s.deliver()).pending).toBe(0);
    await s.prepare(stale); expect((await s.deliver()).pending).toBe(0);
    await s.prepare(fresh); expect((await s.deliver()).exitCode).toBe(0);
    await s.prepare(stale); expect((await s.deliver()).pending).toBe(0);
    expect(subjects(send)).toEqual(['OPEN', 'RESOLVED', 'OPEN']);
    const ids = emailed(db).map(row => Number(row.event_id.split(':')[1]));
    expect(ids).toEqual([1, 2, 3]);
  });
  it.each([
    ['unavailable', 'partial', 'dormant', 1],
    ['unavailable', 'failed', 'empty', 0],
    ['stale', 'unknown', 'dormant', 0],
  ])('accepts every observation the sender can emit: %s/%s then %s', async (freshness, poll, healthy, count) => {
    const { send, env } = await setup();
    const s = await sender(env);
    await s.prepare(fresh); await s.deliver();
    const open = { ok: false, count: 1, context: '', observation: { freshness, poll, stale: freshness === 'stale' ? 1 : 0, overdue: 0, error: null } };
    await s.prepare(open as typeof fresh); expect((await s.deliver()).pending).toBe(0);
    const resolved = { ok: true, count, context: '', observation: { freshness: healthy, poll: 'ok', stale: 0, overdue: 0, error: null } };
    await s.prepare(resolved as typeof fresh); expect((await s.deliver()).exitCode).toBe(0);
    expect(subjects(send)).toEqual(['OPEN', 'RESOLVED']);
  });
  it('holds RESOLVED behind an OPEN the receiver could not email, then delivers both in order', async () => {
    const { db, send, env } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await sender(env);
    await s.prepare(fresh); await s.deliver();
    send.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'E_DELIVERY_FAILED' }));
    await s.prepare(stale); expect((await s.deliver()).monitorFailure).toBe('delivery-failed');
    await s.prepare(fresh); expect((await s.deliver()).pending).toBe(0);
    expect(subjects(send)).toEqual(['OPEN', 'OPEN', 'RESOLVED']);
    expect(emailed(db).map(row => Number(row.event_id.split(':')[1]))).toEqual([1, 2]);
    expect(emailed(db).every(row => row.emailed_at !== null)).toBe(true);
  });
  it.each(['http-500', 'content-type', 'response-size', 'body', 'json', 'body-contract', 'counts-contract', 'headers-contract', 'request', 'timeout'])(
    'accepts a reader-outage OPEN and its RESOLVED: %s', async error => {
    const { send, env } = await setup();
    const s = await sender(env);
    await s.prepare(fresh); await s.deliver();
    await s.prepare(failed(error)); expect((await s.deliver()).pending).toBe(0);
    const body = (send.mock.calls[0][0] as { text: string }).text;
    expect(body).toContain(`Check error: ${error}`); expect(body).toContain('Freshness: unknown');
    await s.prepare(fresh); expect((await s.deliver()).exitCode).toBe(0);
    expect(subjects(send)).toEqual(['OPEN', 'RESOLVED']);
  });
  it('keeps the same id through timeout and wrong acknowledgments, emailing once', async () => {
    const { db, send, env } = await setup();
    const s = await sender(env);
    await s.prepare(fresh); await s.deliver();
    await s.prepare(stale);
    const keys: (string | null)[] = [];
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      keys.push(new Headers(init?.headers).get('idempotency-key'));
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect((await s.deliver(hang, 5)).monitorFailure).toBe('delivery-failed');
    expect(send).not.toHaveBeenCalled();
    await s.prepare(stale);
    // Receiver accepted and emailed, but the sender sees a wrong acknowledgment.
    const wrong: typeof fetch = async (input, init) => {
      keys.push(new Headers(init?.headers).get('idempotency-key'));
      await worker.fetch(new Request(input, init), env, ctx);
      return new Response(JSON.stringify({ eventId: 'other' }), { headers: { 'Content-Type': 'application/json' } });
    };
    expect((await s.deliver(wrong)).monitorFailure).toBe('delivery-failed');
    expect(send).toHaveBeenCalledOnce();
    await s.prepare(stale);
    expect((await s.deliver()).pending).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(emailed(db)).toHaveLength(1);
    expect(keys).toEqual([emailed(db)[0].event_id, emailed(db)[0].event_id]);
  });
  it('survives receiver acceptance followed by a sender crash without a second email', async () => {
    const { send, env } = await setup();
    const s = await sender(env);
    await s.prepare(fresh); await s.deliver();
    await s.prepare(stale);
    const pendingCheckpoint = `${s.stateFile}.pending`;
    await copyFile(s.stateFile, pendingCheckpoint);
    expect((await s.deliver()).pending).toBe(0);
    await copyFile(pendingCheckpoint, s.stateFile); // final checkpoint lost
    expect((await s.deliver()).pending).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });
});
