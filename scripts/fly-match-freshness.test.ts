import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeOnce, receiverRPC, runFlyTick, runSchedule } from './fly-match-freshness.mjs';
import { currentScopes } from './match-freshness-reader.mjs';
import { newSignal } from './match-freshness-policy.mjs';

const tick = Date.parse('2026-11-26T12:00:00Z');
const interval = 300_000;
const leaseUntil = tick + 4 * interval;
const scope = { competition: 'liga-mx', season: '2026-apertura' };
const key = 'liga-mx/2026-apertura';
const baseURL = 'https://scorearc-reader.fly.dev';
const receiver = 'https://scorearc-alert-receiver.miguel-4fc.workers.dev';
const token = 'x'.repeat(48);
const epoch = '12345678-1234-4234-8234-123456789abc';
const github = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml', ref: 'refs/heads/main', id: 100, number: 10, attempt: 1, sha: 'a'.repeat(40) };
const seed = () => ({ version: 3, origin: baseURL, epoch, run: github, sequence: 0, updatedAt: new Date(tick - interval).toISOString(), phase: 'final',
  incidents: { [key]: null }, signals: { [key]: newSignal() }, pending: [], delivered: [], reserved: [], dataIncident: false, monitorFailure: null });
const failed = { ok: false, count: null, context: 'error=timeout', observation: { freshness: null, poll: null, stale: null, overdue: null, error: 'timeout' } };
const json = (value: unknown) => Response.json(value);
const empty = () => new Response(null, { status: 204 });
function setup(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw Error('Unexpected request');
    return response;
  });
  const check = vi.fn(async () => failed);
  const rpc = receiverRPC(token, fetchImpl);
  return { options: { rpc, check, clock: () => tick, scopes: [scope] }, fetchImpl, check };
}
function sent(fetchImpl: ReturnType<typeof setup>['fetchImpl']) {
  return fetchImpl.mock.calls.map(([url, init]) => ({ op: String(url).replace(receiver + '/fly/', ''), body: JSON.parse(String(init?.body)) }));
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Fly match monitor', () => {
  it('takes no action without a claim', async () => {
    const { options, fetchImpl, check } = setup([empty()]);
    await expect(runFlyTick(tick, options)).resolves.toMatchObject({ status: 'skipped' });
    expect(check).not.toHaveBeenCalled();
    expect(sent(fetchImpl)).toEqual([{ op: 'claim', body: { tick } }]);
  });
  it('retries one early-boundary claim when the receiver clock is still in the previous slot', async () => {
    vi.useFakeTimers({ now: tick });
    const { options, fetchImpl, check } = setup([new Response(null, { status: 409 }), empty()]);
    const run = runFlyTick(tick, { ...options, clock: Date.now });
    const outcome = expect(run).resolves.toMatchObject({ status: 'skipped', tick });
    await vi.advanceTimersByTimeAsync(2_000);
    await outcome;
    expect(sent(fetchImpl).map(c => c.op)).toEqual(['claim', 'claim']);
    expect(check).not.toHaveBeenCalled();
  });
  it('observes only under a lease and durably reserves, acknowledges, finalizes and then heartbeats', async () => {
    const id = epoch + ':1';
    const { options, fetchImpl, check } = setup([json({ checkpoint: seed(), leaseUntil }), empty(), json({ eventId: id }), empty(), empty(), empty()]);
    await expect(runFlyTick(tick, options)).resolves.toMatchObject({ status: 'observed', tick, scopes: 1, errors: 1, open: 1, pending: 0 });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ ...scope, baseURL }));
    const calls = sent(fetchImpl);
    expect(calls.map(c => c.op)).toEqual(['claim', 'pending', 'event', 'final', 'heartbeat', 'release']);
    expect(calls.slice(1).map(c => [c.body.tick, c.body.leaseUntil])).toEqual(Array(5).fill([tick, leaseUntil]));
    expect(calls[1].body.checkpoint).toMatchObject({ phase: 'pending', reserved: [id], run: { fly: 'scorearc-observability', tick } });
    expect(calls[2].body.event).toMatchObject({ status: 'OPEN', eventId: id });
    expect(calls[3].body.checkpoint).toMatchObject({ phase: 'final', pending: [], delivered: [{ id }] });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('releases without sending if the pending write fails', async () => {
    const { options, fetchImpl } = setup([json({ checkpoint: seed(), leaseUntil }), new Response(null, { status: 409 }), empty()]);
    await expect(runFlyTick(tick, options)).rejects.toThrow();
    expect(sent(fetchImpl).map(c => c.op)).toEqual(['claim', 'pending', 'release']);
  });
  it('keeps the event queued and withholds heartbeat on an incorrect receipt', async () => {
    const { options, fetchImpl } = setup([json({ checkpoint: seed(), leaseUntil }), empty(), json({ eventId: epoch + ':9' }), empty(), empty()]);
    await expect(runFlyTick(tick, options)).resolves.toMatchObject({ monitorFailure: 'delivery-failed', pending: 1 });
    const calls = sent(fetchImpl);
    expect(calls.map(c => c.op)).toEqual(['claim', 'pending', 'event', 'final', 'release']);
    expect(calls[3].body.checkpoint.pending[0]).toMatchObject({ id: epoch + ':1', attempts: 1 });
  });
  it('withholds heartbeat after a lost final write', async () => {
    const { options, fetchImpl } = setup([json({ checkpoint: seed(), leaseUntil }), empty(), json({ eventId: epoch + ':1' }), new Response(null, { status: 503 }), empty()]);
    await expect(runFlyTick(tick, options)).rejects.toThrow();
    expect(sent(fetchImpl).map(c => c.op)).toEqual(['claim', 'pending', 'event', 'final', 'release']);
  });
  it('rejects invalid or oversized claim responses before polling', async () => {
    for (const response of [new Response(null, { status: 302 }), json({ checkpoint: {}, leaseUntil: 'wrong' }), json({ checkpoint: { x: 'x'.repeat(270_000) }, leaseUntil })]) {
      const { options, check } = setup([response]);
      await expect(runFlyTick(tick, options)).rejects.toThrow();
      expect(check).not.toHaveBeenCalled();
    }
  });
  it('aborts a stalled receiver within its deadline and masks transport details', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(token)), { once: true });
    }));
    const call = receiverRPC(token, fetchImpl)('claim', { tick });
    const failure = expect(call).rejects.toThrow('receiver-claim-timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('stops between reads when Fly shuts down, leaving the previous checkpoint intact', async () => {
    const { options, fetchImpl } = setup([json({ checkpoint: seed(), leaseUntil }), empty()]);
    const controller = new AbortController();
    await expect(runFlyTick(tick, { ...options, signal: controller.signal, check: async () => { controller.abort(); return failed; } })).rejects.toThrow();
    expect(sent(fetchImpl).map(c => c.op)).toEqual(['claim', 'release']);
  });
  it('runs all registered checks once for observe and reports policy, error and resource counts', async () => {
    const network = vi.fn().mockRejectedValue(new Error('Only the injected reader should run'));
    vi.stubGlobal('fetch', network);
    const check = vi.fn(async () => failed);
    const registry = await readFile(new URL('../backend/config/competitions.json', import.meta.url), 'utf8');
    const editions = currentScopes(JSON.parse(registry));
    expect(await observeOnce({ check })).toMatchObject({ status: 'observe', scopes: editions.length, open: editions.length, errors: editions.length,
      durationMs: expect.any(Number), peakRssMiB: expect.any(Number) });
    expect(check.mock.calls).toEqual(editions.map(scope => [expect.objectContaining({ ...scope, baseURL })]));
    expect(network).not.toHaveBeenCalled();
  });
});

describe('Fly UTC timer', () => {
  it('starts in the current slot, recovers from errors on the boundary, serializes overruns and stops on signal', async () => {
    vi.useFakeTimers({ now: tick + 1234 });
    const controller = new AbortController();
    let finish!: () => void;
    const runTick = vi.fn().mockRejectedValueOnce(Error('secret in error'))
      .mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ status: 'observed' }); }))
      .mockImplementationOnce(async () => { controller.abort(); return { status: 'observed' }; });
    const log = vi.fn();
    const done = runSchedule({ runTick, signal: controller.signal, log });
    await vi.advanceTimersByTimeAsync(interval - 1235);
    expect(runTick.mock.calls.map(c => c[0])).toEqual([tick]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runTick.mock.calls.map(c => c[0])).toEqual([tick, tick + interval]);
    await vi.advanceTimersByTimeAsync(2 * interval + 800);
    expect(runTick).toHaveBeenCalledTimes(2);
    finish();
    await done;
    expect(runTick.mock.calls.map(c => c[0])).toEqual([tick, tick + interval, tick + 3 * interval]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});
