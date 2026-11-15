import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as monitor from '../../scripts/match-freshness-monitor.mjs';
import worker, { type Env } from './worker';

const MAX_EVENTS_PER_DAY = 300;
const ctx = { waitUntil: vi.fn() };
const TOKEN = 't'.repeat(40);
const DISPATCH_TOKEN = 'g'.repeat(40);
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
  const migrations = new URL('./migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).sort()) sqlite.exec(await readFile(new URL(file, migrations), 'utf8'));
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
  const env: Env = { DB: db, EMAIL: { send }, RECEIVER_TOKEN: TOKEN, ALERT_RECIPIENT: 'owner@example.test', GITHUB_DISPATCH_TOKEN: DISPATCH_TOKEN };
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

describe('monitor heartbeat', () => {
  const HEARTBEAT = `http://127.0.0.1/heartbeat/${TOKEN}`;
  const beat = (env: Env, url = HEARTBEAT) => worker.fetch(new Request(url, { method: 'POST' }), env, ctx);
  const check = (env: Env) => worker.scheduled({}, env);
  const row = (db: Awaited<ReturnType<typeof database>>) => db.sqlite.prepare('SELECT last_at, alerted_at FROM monitor_heartbeat').all();
  const at = (iso: string) => vi.useFakeTimers({ now: Date.parse(iso), toFake: ['Date'] });
  // The cron also dispatches the workflow; no test reaches GitHub.
  let github: ReturnType<typeof vi.fn>;
  beforeEach(() => { github = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal('fetch', github); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('is wired to a 5-minute cron, which the 60-to-65-minute alert timing assumes', async () => {
    const config = await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toMatch(/"crons":\s*\["\*\/5 \* \* \* \*"\]/);
    expect(typeof worker.scheduled).toBe('function');
  });
  it('dispatches one monitor run on main every cron run', async () => {
    const { env } = await setup();
    await check(env); await check(env);
    expect(github).toHaveBeenCalledTimes(2);
    const [url, init] = github.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/mcasillas17/ScoreArc/actions/workflows/match-freshness.yml/dispatches');
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('manual'); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe('{"ref":"main"}');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'scorearc-alert-receiver' });
  });
  it("accepts GitHub's current 200-with-run-details answer without logging a rejection", async () => {
    const { send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    github.mockResolvedValue(new Response(JSON.stringify({ workflow_run_id: 1 }), { status: 200 }));
    at('2026-11-01T12:00:00Z'); await beat(env);
    at('2026-11-01T12:05:00Z'); await check(env);
    expect(github).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each([
    ['a redirected dispatch', (env: Env) => { github.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://example.test/' } })); return env; }, 'dispatch rejected'],
    ['a missing token', (env: Env) => ({ ...env, GITHUB_DISPATCH_TOKEN: '' }), 'dispatch token missing'],
    ['a rejected dispatch', (env: Env) => { github.mockResolvedValue(new Response(`bad ${DISPATCH_TOKEN}`, { status: 401 })); return env; }, 'dispatch rejected'],
    ['a dispatch that throws', (env: Env) => { github.mockRejectedValue(new Error(`net ${DISPATCH_TOKEN} ${TOKEN}`)); return env; }, 'dispatch failed'],
  ])('%s logs no secret and the not-running check still alerts', async (_name, breakIt, line) => {
    const { send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    at('2026-11-01T12:00:00Z'); await beat(env);
    const broken = breakIt(env);
    at('2026-11-01T13:05:00Z'); await check(broken);
    expect(send.mock.calls.map(([m]) => m.subject)).toEqual(['[ScoreArc] Monitor not running']);
    expect(JSON.stringify(log.mock.calls)).toContain(line);
    expect(JSON.stringify(log.mock.calls)).not.toContain(DISPATCH_TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
  it('stays silent until the first heartbeat arms it', async () => {
    const { send, env } = await setup();
    at('2026-11-01T12:00:00Z'); await check(env);
    at('2026-11-09T12:00:00Z'); await check(env);
    expect(send).not.toHaveBeenCalled();
  });
  it('records a heartbeat with 204 and no email', async () => {
    const { db, send, env } = await setup();
    at('2026-11-01T12:00:00Z');
    const response = await beat(env);
    expect(response.status).toBe(204); expect(await response.text()).toBe('');
    expect(row(db)).toEqual([{ last_at: '2026-11-01T12:00:00.000Z', alerted_at: null }]);
    expect(send).not.toHaveBeenCalled();
  });
  it('alerts once after 60 minutes without a heartbeat, then once on recovery', async () => {
    const { db, send, env } = await setup();
    at('2026-11-01T12:00:00Z'); await beat(env);
    at('2026-11-01T13:00:00Z'); await check(env);
    expect(send).not.toHaveBeenCalled();
    at('2026-11-01T13:00:01Z'); await check(env);
    at('2026-11-01T14:00:00Z'); await check(env);
    expect(send).toHaveBeenCalledOnce();
    const down = send.mock.calls[0][0];
    expect(down.to).toBe('owner@example.test'); expect(down.subject).toBe('[ScoreArc] Monitor not running');
    expect(down.text).toContain('has not completed a monitor run since 2026-11-01T12:00:00.000Z'); expect(down.text).toContain('actions/workflows/match-freshness.yml');
    at('2026-11-01T14:05:00Z'); expect((await beat(env)).status).toBe(204);
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0].subject).toBe('[ScoreArc] Monitor recovered');
    await beat(env); expect(send).toHaveBeenCalledTimes(2);
    expect(row(db)).toEqual([{ last_at: '2026-11-01T14:05:00.000Z', alerted_at: null }]);
  });
  it('retries a failed down alert on the next check, and a failed recovery on the next heartbeat', async () => {
    const { send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    at('2026-11-01T12:00:00Z'); await beat(env);
    send.mockRejectedValueOnce(Object.assign(new Error(`provider said ${TOKEN}`), { code: 'E_DELIVERY_FAILED' }));
    at('2026-11-01T13:15:00Z'); await check(env);
    at('2026-11-01T13:30:00Z'); await check(env);
    expect(send.mock.calls.map(([m]) => m.subject)).toEqual(['[ScoreArc] Monitor not running', '[ScoreArc] Monitor not running']);
    send.mockRejectedValueOnce(new Error('down'));
    at('2026-11-01T13:35:00Z'); expect((await beat(env)).status).toBe(503);
    at('2026-11-01T13:40:00Z'); expect((await beat(env)).status).toBe(204);
    expect(send.mock.calls.slice(2).map(([m]) => m.subject)).toEqual(['[ScoreArc] Monitor recovered', '[ScoreArc] Monitor recovered']);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
  it('repeats an email whose record failed instead of losing it: at least once', async () => {
    const { db, send, env } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    at('2026-11-01T12:00:00Z'); await beat(env);
    db.failing.statement = 'UPDATE';
    at('2026-11-01T13:15:00Z'); await check(env);
    db.failing.statement = '';
    at('2026-11-01T13:30:00Z'); await check(env);
    db.failing.statement = 'UPDATE';
    at('2026-11-01T13:35:00Z'); expect((await beat(env)).status).toBe(503);
    db.failing.statement = '';
    at('2026-11-01T13:40:00Z'); expect((await beat(env)).status).toBe(204);
    expect(send.mock.calls.map(([m]) => m.subject)).toEqual(['[ScoreArc] Monitor not running', '[ScoreArc] Monitor not running', '[ScoreArc] Monitor recovered', '[ScoreArc] Monitor recovered']);
    expect(row(db)).toEqual([{ last_at: '2026-11-01T13:40:00.000Z', alerted_at: null }]);
  });
  it('fails closed on weak configuration for both the route and the check', async () => {
    const { db, send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const broken of [{ RECEIVER_TOKEN: 'short' }, { ALERT_RECIPIENT: '' }]) {
      const url = `http://127.0.0.1/heartbeat/${broken.RECEIVER_TOKEN ?? TOKEN}`;
      expect((await beat({ ...env, ...broken }, url)).status).toBe(500);
    }
    expect(row(db)).toEqual([]);
    at('2026-11-01T12:00:00Z'); await beat(env);
    at('2026-11-01T14:00:00Z'); await check({ ...env, ALERT_RECIPIENT: '' });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).toContain('configuration incomplete');
  });
  it('a failing check sends nothing and logs no secret', async () => {
    const { db, send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    at('2026-11-01T12:00:00Z'); await beat(env);
    db.failing.statement = 'SELECT';
    at('2026-11-01T14:00:00Z'); await check(env);
    expect(send).not.toHaveBeenCalled();
    expect(github).toHaveBeenCalledOnce(); // the dispatch is independent of the check
    expect(JSON.stringify(log.mock.calls)).toContain('heartbeat check');
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
  it.each(['send', 'record'])('a recovery whose %s failed still lets the next outage alert', async failing => {
    const { db, send, env } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    at('2026-11-01T12:00:00Z'); await beat(env);
    at('2026-11-01T13:15:00Z'); await check(env);
    if (failing === 'send') send.mockRejectedValueOnce(new Error('down')); else db.failing.statement = 'UPDATE';
    at('2026-11-01T13:20:00Z'); expect((await beat(env)).status).toBe(503);
    db.failing.statement = '';
    at('2026-11-01T14:30:00Z'); await check(env);
    expect(send.mock.calls.map(([m]) => m.subject).filter(s => s.endsWith('not running'))).toHaveLength(2);
    at('2026-11-01T14:45:00Z'); await check(env);
    expect(send.mock.calls.map(([m]) => m.subject).filter(s => s.endsWith('not running'))).toHaveLength(2);
  });
  it('a heartbeat landing during the down email gets its recovery from the next heartbeat', async () => {
    const { db, send, env } = await setup();
    at('2026-11-01T12:00:00Z'); await beat(env);
    send.mockImplementationOnce(async () => {
      db.sqlite.exec("UPDATE monitor_heartbeat SET last_at = '2026-11-01T13:15:00.500Z'");
      return { messageId: 'm' };
    });
    at('2026-11-01T13:15:00Z'); await check(env);
    at('2026-11-01T13:20:00Z'); await beat(env);
    expect(send.mock.calls.map(([m]) => m.subject)).toEqual(['[ScoreArc] Monitor not running', '[ScoreArc] Monitor recovered']);
  });
  it('a silence after a heartbeat that landed during the down email is a new outage', async () => {
    const { db, send, env } = await setup();
    at('2026-11-01T12:00:00Z'); await beat(env);
    send.mockImplementationOnce(async () => {
      db.sqlite.exec("UPDATE monitor_heartbeat SET last_at = '2026-11-01T13:15:00.500Z'");
      return { messageId: 'm' };
    });
    at('2026-11-01T13:15:00Z'); await check(env);
    at('2026-11-01T14:20:00Z'); await check(env);
    expect(send.mock.calls.map(([m]) => m.subject)).toEqual(['[ScoreArc] Monitor not running', '[ScoreArc] Monitor not running']);
  });
  it('writes at most once a minute', async () => {
    const { db, env } = await setup();
    at('2026-11-01T12:00:00Z'); await beat(env);
    at('2026-11-01T12:00:59Z'); expect((await beat(env)).status).toBe(204);
    expect(row(db)).toEqual([{ last_at: '2026-11-01T12:00:00.000Z', alerted_at: null }]);
    at('2026-11-01T12:01:01Z'); await beat(env);
    expect(row(db)).toEqual([{ last_at: '2026-11-01T12:01:01.000Z', alerted_at: null }]);
  });
  it('is paused by deleting the row and re-armed by the next heartbeat', async () => {
    const { db, send, env } = await setup();
    at('2026-11-01T12:00:00Z'); await beat(env);
    db.sqlite.exec('DELETE FROM monitor_heartbeat');
    at('2026-11-02T12:00:00Z'); await check(env);
    expect(send).not.toHaveBeenCalled();
    await beat(env); expect(row(db)).toHaveLength(1);
  });
  it('shares the token gate: wrong token 404, wrong method 405, nothing recorded', async () => {
    const { db, send, env } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await beat(env, `http://127.0.0.1/heartbeat/${'x'.repeat(40)}`)).status).toBe(404);
    expect((await beat(env, `${HEARTBEAT}/extra`)).status).toBe(404);
    expect(log).not.toHaveBeenCalled();
    expect((await worker.fetch(new Request(HEARTBEAT), env, ctx)).status).toBe(405);
    expect(row(db)).toEqual([]); expect(send).not.toHaveBeenCalled();
  });
  it('the real monitor heartbeat sender reaches the receiver', async () => {
    const { db, env } = await setup();
    await monitor.sendHeartbeat({ webhookURL: URL_OK, fetchImpl: (input, init) => worker.fetch(new Request(input, init), env, ctx) });
    expect(row(db)).toHaveLength(1);
  });
});
