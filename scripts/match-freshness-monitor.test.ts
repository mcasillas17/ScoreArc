import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type RequestListener } from 'node:http';
import * as monitor from './match-freshness-monitor.mjs';

const dirs: string[] = [];
const servers: Server[] = [];
const scopeFor = (competition: string) => ({ competition, season: '2026' });
const scopes = [scopeFor('world-cup')];
const run = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml', ref: 'refs/heads/main', id: 100, number: 10, attempt: 1, sha: 'a'.repeat(40) };
const time = Date.parse('2026-10-04T12:00:00Z');
const fresh = { ok: true, count: 1, context: '', observation: { freshness: 'fresh', poll: 'ok', stale: 0, overdue: 0, error: null } };
const stale = { ...fresh, ok: false, observation: { ...fresh.observation, freshness: 'stale', stale: 1 } };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true });
});
async function options() {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-test-')); dirs.push(dir);
  return { enabled: true, deliveryEnabled: true, baseURL: 'https://reader.example', scopes, stateFile: join(dir, 'state.json'), run, now: time, initialize: true, check: async () => stale };
}
async function state(path: string) { return JSON.parse(await readFile(path, 'utf8')); }
async function endpoint(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  return `http://127.0.0.1:${address.port}/notify`;
}
async function prepareNext(o: Awaited<ReturnType<typeof options>>, result = stale, advance = 300000) {
  const previous = (await state(o.stateFile)).run;
  o.run = { ...previous, id: previous.id + 1, number: previous.number + 1 };
  o.initialize = false; o.now += advance; o.check = async () => result;
  return monitor.prepareMonitor({ ...o, restoredRun: previous });
}

describe('durable match monitor', () => {
  it('is disabled before filesystem, production checks or sends', async () => {
    const check = vi.fn(); const fetchImpl = vi.fn();
    expect(await monitor.prepareMonitor({ enabled: false, check })).toEqual({ disabled: true });
    expect(await monitor.deliverMonitor({ enabled: false, deliveryEnabled: true, fetchImpl })).toEqual({ disabled: true });
    expect(await monitor.deliverMonitor({ enabled: true, deliveryEnabled: false, fetchImpl })).toEqual({ disabled: true });
    expect(check).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('preserves pending OPEN through recovery and orders recurrence with stable identifiers', async () => {
    const o = await options(); o.check = async () => fresh;
    await monitor.prepareMonitor(o); expect((await state(o.stateFile)).pending).toEqual([]);
    await prepareNext(o); const open = (await state(o.stateFile)).pending[0];
    await prepareNext(o); expect((await state(o.stateFile)).pending.map((e: any) => e.id)).toEqual([open.id]);
    await prepareNext(o, fresh); const recovered = (await state(o.stateFile)).pending;
    expect(recovered.map((e: any) => e.status)).toEqual(['OPEN', 'RESOLVED']);
    expect(recovered[1].incidentId).toBe(open.incidentId);
    await prepareNext(o); const events = (await state(o.stateFile)).pending;
    expect(events.map((e: any) => e.status)).toEqual(['OPEN', 'RESOLVED', 'OPEN']);
    expect(events[2].incidentId).not.toBe(open.incidentId);
  });
  it('rejects missing, corrupt, incompatible, wrong-origin/scope and rollback state before checks', async () => {
    const o = await options(); const check = vi.fn(async () => fresh);
    await expect(monitor.prepareMonitor({ ...o, initialize: false, check })).rejects.toThrow(/state/i);
    await monitor.prepareMonitor(o); const good = await state(o.stateFile);
    for (const bad of [{ ...good, version: 1 }, { ...good, origin: 'https://other.example' }, { ...good, incidents: {} }, { ...good, sequence: -1 }, { ...good, pending: [{ ...good.pending[0], error: 'secret' }] }]) {
      await writeFile(o.stateFile, JSON.stringify(bad));
      await expect(monitor.prepareMonitor({ ...o, initialize: false, restoredRun: good.run, run: { ...run, id: 101, number: 11 }, check })).rejects.toThrow(/state/i);
    }
    await writeFile(o.stateFile, JSON.stringify(good));
    await expect(monitor.prepareMonitor({ ...o, initialize: false, restoredRun: run, check })).rejects.toThrow(/order/i);
    expect(check).not.toHaveBeenCalled();
  });
  it('opens no incident for valid T16.2 nulls through the real checker, but does for malformed ones', async () => {
    const scorer = { teamId: null, player: 'Player', minute: "4'", penalty: false, shootout: false, ownGoal: null, athleteId: null };
    let scorers: object[] = [scorer];
    const reader = await endpoint((_req, res) => res.writeHead(200, {
      'Content-Type': 'application/json', 'X-ScoreArc-Freshness': 'fresh', 'X-ScoreArc-Observed-At': '2026-10-04T11:59:00Z',
      'X-ScoreArc-Poll-Status': 'ok', 'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0',
    }).end(JSON.stringify([{
      id: '018f0000-0000-7000-8000-000000000001', kickoff: '2026-10-04T11:00:00Z', state: 'live', minute: "4'",
      statusDetail: "4'", statusName: 'STATUS_IN_PROGRESS', home: { id: 'arg', name: 'Argentina', abbr: 'ARG', crestUrl: null },
      away: { id: 'fra', name: 'France', abbr: 'FRA', crestUrl: null }, homeScore: 1, awayScore: 0, winnerId: null, note: null,
      scorers, cards: [{ teamId: null, player: 'Player', minute: "5'", type: 'yellow' }],
      shootout: null, shootoutDetail: null, stats: null, winProbability: null,
    }])));
    const o = { ...(await options()), baseURL: new URL(reader).origin, check: undefined };
    await monitor.prepareMonitor(o);
    expect(await state(o.stateFile)).toMatchObject({ pending: [], dataIncident: false, incidents: { 'world-cup/2026': null } });

    scorers = [{ ...scorer, ownGoal: 'unknown' }];
    const previous = (await state(o.stateFile)).run;
    await monitor.prepareMonitor({ ...o, initialize: false, restoredRun: previous, now: time + 300000, run: { ...previous, id: previous.id + 1, number: previous.number + 1 } });
    const { pending, dataIncident } = await state(o.stateFile);
    expect(dataIncident).toBe(true);
    expect(pending).toMatchObject([{ status: 'OPEN', observation: { error: 'body-contract' } }]);
  });
  it('rejects concurrent preparation and leaves the completed state usable', async () => {
    const o = await options(); let release!: () => void;
    const waiting = new Promise<void>(r => { release = r; });
    const first = monitor.prepareMonitor({ ...o, check: async () => { await waiting; return stale; } });
    await vi.waitFor(async () => { await readFile(o.stateFile + '.lock/owner'); });
    await expect(monitor.prepareMonitor(o)).rejects.toThrow(/lock/i);
    release(); await first; expect((await state(o.stateFile)).pending).toHaveLength(1);
  });
  it.each([
    { status: 'RESOLVED', observation: { freshness: 'stale', poll: 'failed', stale: 0, overdue: 1, error: null } },
    { status: 'RESOLVED', observation: { freshness: null, poll: null, stale: null, overdue: null, error: 'request' } },
    { status: 'RESOLVED', observation: { freshness: 'empty', poll: 'ok', stale: 0, overdue: 0, error: null } },
    { status: 'OPEN', observation: { freshness: 'fresh', poll: 'ok', stale: 0, overdue: 0, error: null } },
  ])('rejects contradictory restored events before send', async mutation => {
    const o = await options(); await monitor.prepareMonitor(o);
    const s = await state(o.stateFile); Object.assign(s.pending[0], mutation);
    await writeFile(o.stateFile, JSON.stringify(s)); const fetchImpl = vi.fn();
    await expect(monitor.deliverMonitor({ ...o, webhookURL: 'https://notify.example', pendingArtifactId: 1, fetchImpl })).rejects.toThrow(/state/i);
    expect(fetchImpl).not.toHaveBeenCalled(); expect(await state(o.stateFile)).toEqual(s);
  });
  it('rejects incident/event ordering corruption and final-phase reservations', async () => {
    const o = await options(); await monitor.prepareMonitor(o); const good = await state(o.stateFile);
    for (const mutation of [
      { incidents: { 'world-cup/2026': null }, dataIncident: false },
      { phase: 'final' },
      { pending: [{ ...good.pending[0], nextAttemptAt: '2099-01-01T00:00:00Z' }] },
    ]) {
      const invalid = { ...good, ...mutation };
      expect(() => monitor.validateState(invalid, o)).toThrow(/state/i);
    }
  });
  it.each(['missing-tail', 'interior-gap', 'acknowledged-ahead'])('rejects %s corruption before checks or sends', async mutation => {
    const o = await options();
    o.scopes = [scopeFor('world-cup'), scopeFor('liga-mx'), scopeFor('laliga')];
    await monitor.prepareMonitor(o); const bad = await state(o.stateFile); bad.reserved = [];
    if (mutation === 'interior-gap') bad.pending.splice(1, 1);
    else {
      const removed = bad.pending.pop();
      if (mutation === 'acknowledged-ahead') bad.delivered.push({ id: removed.id, acknowledgedAt: bad.updatedAt });
    }
    await writeFile(o.stateFile, JSON.stringify(bad));
    const check = vi.fn(); const fetchImpl = vi.fn();
    await expect(monitor.prepareMonitor({ ...o, initialize: false, restoredRun: o.run, run: { ...o.run, id: 101, number: 11 }, check })).rejects.toThrow(/state/i);
    await expect(monitor.deliverMonitor({ ...o, webhookURL: 'https://notify.example', pendingArtifactId: 1, fetchImpl })).rejects.toThrow(/state/i);
    expect(check).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); expect(await state(o.stateFile)).toEqual(bad);
  });
  it('retains legitimate dormant recovery with failed off-season poll', async () => {
    const o = await options(); await monitor.prepareMonitor(o);
    await prepareNext(o, { ...fresh, count: 0, observation: { freshness: 'dormant', poll: 'failed', stale: 0, overdue: 0, error: null } });
    expect((await state(o.stateFile)).pending.map((e: any) => e.status)).toEqual(['OPEN','RESOLVED']);
  });
  it('requires uploaded pending checkpoint before external delivery', async () => {
    const o = await options(); await monitor.prepareMonitor(o); const fetchImpl = vi.fn();
    await expect(monitor.deliverMonitor({ ...o, webhookURL: 'https://notify.example', fetchImpl })).rejects.toThrow(/checkpoint/i);
    expect(fetchImpl).not.toHaveBeenCalled(); expect((await state(o.stateFile)).pending).toHaveLength(1);
  });
  it('retries a successful-but-uncheckpointed acknowledgment with the same ID', async () => {
    const o = await options(); await monitor.prepareMonitor(o);
    const saved = await readFile(o.stateFile, 'utf8'); const received: any[] = [];
    const webhookURL = await endpoint(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body); received.push(payload);
      expect(req.headers['idempotency-key']).toBe(payload.eventId);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ eventId: payload.eventId }));
    });
    await monitor.deliverMonitor({ ...o, webhookURL, pendingArtifactId: 1 });
    expect((await state(o.stateFile)).pending).toEqual([]);
    // Simulated failed final upload: next runner receives only pre-send checkpoint.
    await writeFile(o.stateFile, saved); await prepareNext(o);
    await monitor.deliverMonitor({ ...o, webhookURL, pendingArtifactId: 2 });
    expect(received).toHaveLength(2); expect(received[1]).toEqual(received[0]);
    expect(Object.keys(received[0]).sort()).toEqual(['competition','count','error','eventId','freshness','incidentId','occurredAt','overdue','poll','runUrl','season','stale','status'].sort());
  });
  it.each([429, 500, 204, 302])('retains retryable state for HTTP %s without logging raw errors', async status => {
    const o = await options(); await monitor.prepareMonitor(o);
    const webhookURL = await endpoint((_req, res) => res.writeHead(status, { Location: 'https://secret.example', 'Retry-After': '999999' }).end('credential-secret'));
    const result = await monitor.deliverMonitor({ ...o, webhookURL, pendingArtifactId: 1 });
    expect(result.exitCode).toBe(2); expect(JSON.stringify(result)).not.toContain('credential-secret');
    const s = await state(o.stateFile); expect(s.pending).toHaveLength(1); expect(s.pending[0].attempts).toBe(1);
    expect(Date.parse(s.pending[0].nextAttemptAt) - o.now).toBe(300000);
  });
  it('bounds timeout and rejects ambiguous success acknowledgment', async () => {
    for (const mode of ['timeout','ambiguous']) {
      const o = await options(); await monitor.prepareMonitor(o);
      const webhookURL = await endpoint((_req, res) => { if (mode === 'ambiguous') res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"eventId":"wrong"}'); });
      const result = await monitor.deliverMonitor({ ...o, webhookURL, pendingArtifactId: 1, timeoutMs: 25 });
      expect(result.exitCode).toBe(2); expect((await state(o.stateFile)).pending).toHaveLength(1);
    }
  });
  it('reserves attempts before sending, obeys persistent backoff and exhausts at 20', async () => {
    const o = await options(); await monitor.prepareMonitor(o);
    for (let i = 1; i < 20; i++) await prepareNext(o, stale, 21600000);
    const exhausted = await state(o.stateFile); expect(exhausted.pending[0].attempts).toBe(20);
    await prepareNext(o, stale, 21600000);
    const s = await state(o.stateFile); expect(s.pending[0].attempts).toBe(20); expect(s.reserved).toEqual([]); expect(s.monitorFailure).toBe('delivery-exhausted');
  });
  it('backpressure keeps bounded queue and drains it without interpreting skipped checks as recovery', async () => {
    const o = await options(); o.deliveryEnabled = false; await monitor.prepareMonitor(o);
    for (let i = 1; i < 131; i++) await prepareNext(o, i % 2 ? fresh : stale);
    const saved = await state(o.stateFile); expect(saved.pending.length).toBeLessThanOrEqual(128);
    expect(saved.monitorFailure).toBe('queue-full');
    const check = vi.fn(async () => fresh);
    await monitor.prepareMonitor({ ...o, check, initialize: false, restoredRun: saved.run, run: { ...saved.run, id: saved.run.id + 1, number: saved.run.number + 1 } });
    expect(check).not.toHaveBeenCalled();
    expect((await state(o.stateFile)).pending.length).toBe(saved.pending.length);
    const blocked = await state(o.stateFile);
    o.deliveryEnabled = true;
    await monitor.prepareMonitor({ ...o, check, initialize: false, restoredRun: blocked.run, run: { ...blocked.run, id: blocked.run.id + 1, number: blocked.run.number + 1 } });
    const prepared = await state(o.stateFile);
    const webhookURL = await endpoint(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ eventId: JSON.parse(raw).eventId }));
    });
    await monitor.deliverMonitor({ ...o, run: prepared.run, webhookURL, pendingArtifactId: 1 });
    expect((await state(o.stateFile)).pending.length).toBe(saved.pending.length - 10);
    expect(check).not.toHaveBeenCalled();

  });
});
