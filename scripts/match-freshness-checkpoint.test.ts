import { describe, expect, it, vi } from 'vitest';
import { finishCheckpoint, prepareCheckpoint, validateCheckpoint, FLY_RUN_URL } from './match-freshness-checkpoint.mjs';
import { validateState } from './match-freshness-monitor.mjs';

const now = Date.parse('2026-11-26T12:00:00Z');
const period = 300_000;
const epoch = '12345678-1234-4234-8234-123456789abc';
const scope = { competition: 'liga-mx', season: '2026-apertura' };
const scopeId = 'liga-mx/2026-apertura';
const github = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml', ref: 'refs/heads/main', id: 100, number: 10, attempt: 1, sha: 'a'.repeat(40) };
const config = { baseURL: 'https://reader.example', scopes: [scope], now };
const fly = (tick: number) => ({ fly: 'scorearc-observability', tick });
const at = (time: number) => new Date(time).toISOString();
const fresh = { ok: true, count: 10, observation: { freshness: 'fresh', poll: 'ok', stale: 0, overdue: 0, error: null } };
const stale = { ok: false, count: 10, observation: { freshness: 'stale', poll: 'failed', stale: 1, overdue: 0, error: null } };
const signal = () => ({ waiting: { full: at(now - period) }, legacyFull: false, prior: 'full', bursts: { full: [now - period] }, dormant: false, quietUntil: 0 });
const seed = () => ({ version: 3, origin: config.baseURL, epoch, run: github, sequence: 1, updatedAt: at(now - period), phase: 'final',
  incidents: { [scopeId]: `${epoch}:1` }, signals: { [scopeId]: signal() }, pending: [], delivered: [{ id: `${epoch}:1`, acknowledgedAt: at(now - period) }], reserved: [], dataIncident: true, monitorFailure: null });
const options = (tick: number, result = fresh) => ({ ...config, run: fly(tick), now: tick, deliveryEnabled: true, check: async () => result });

describe('Fly freshness checkpoints', () => {
  it('links a native observation to Fly monitoring', () => {
    expect(FLY_RUN_URL).toBe('https://fly.io/apps/scorearc-observability/monitoring');
  });
  it('imports an acknowledged GitHub incident and retains its signal until new full-poll evidence resolves it', async () => {
    const imported = seed();
    const continued = await prepareCheckpoint(imported, options(now));
    expect(continued).toMatchObject({ phase: 'pending', run: fly(now), sequence: 1, incidents: imported.incidents, signals: imported.signals, delivered: imported.delivered, pending: [], reserved: [] });
    const next = now + period;
    const pending = await prepareCheckpoint(continued, { ...options(next), check: async () => ({ ...fresh, pollEvidence: { full: { outcome: 'ok', missing: 0, at: at(next) } } }) });
    const send = vi.fn().mockResolvedValue(undefined);
    const final = await finishCheckpoint(pending, { now: next, send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 'RESOLVED', runUrl: FLY_RUN_URL, incidentId: `${epoch}:1`, eventId: `${epoch}:2` }));
    expect(final).toMatchObject({ phase: 'final', sequence: 2, dataIncident: false, pending: [], reserved: [], delivered: [imported.delivered[0], { id: `${epoch}:2`, acknowledgedAt: at(next) }] });
    expect(imported).toEqual(seed());
    expect(pending.reserved).toEqual([`${epoch}:2`]);
    expect(() => validateState(final, { ...config, now: next, run: github })).toThrow();
  });
  it('retries imported queued events before native events with unchanged IDs and GitHub links', async () => {
    const original = { ...seed(), pending: [{ id: `${epoch}:1`, incidentId: `${epoch}:1`, scope: scopeId, status: 'OPEN', occurredAt: at(now - period),
      runUrl: 'https://github.com/mcasillas17/ScoreArc/actions/runs/100', count: 10, observation: stale.observation, attempts: 1, nextAttemptAt: at(now) }], delivered: [], monitorFailure: 'delivery-failed' };
    const recovery = { ...fresh, pollEvidence: { full: { outcome: 'ok', missing: 0, at: at(now) } } };
    const pending = await prepareCheckpoint(original, options(now, recovery));
    const send = vi.fn().mockRejectedValueOnce(Error('unacknowledged')).mockResolvedValue(undefined);
    const failed = await finishCheckpoint(pending, { now, send });
    expect(failed).toMatchObject({ monitorFailure: 'delivery-failed', reserved: [], pending: [{ attempts: 2 }, { attempts: 1 }] });
    expect(send).toHaveBeenCalledTimes(1);
    const next = now + period;
    const early = await prepareCheckpoint(failed, options(next, recovery));
    expect(early.reserved).toEqual([]);
    // Simulate a persisted pending reservation after a lost final write: FIFO retries stay idempotent.
    const retry = await prepareCheckpoint(pending, options(next + period, recovery));
    const final = await finishCheckpoint(retry, { now: next + period, send });
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls.map(([n]) => [n.status, n.runUrl])).toEqual([['OPEN', original.pending[0].runUrl], ['OPEN', original.pending[0].runUrl], ['RESOLVED', FLY_RUN_URL]]);
    expect(final).toMatchObject({ pending: [], monitorFailure: null });
  });
  it('rejects missing history, untrusted imports, duplicate or obsolete ticks before observing', async () => {
    const check = vi.fn(async () => fresh);
    const o = { ...options(now), check };
    const native = await prepareCheckpoint(seed(), options(now));
    for (const invalid of [null, { ...seed(), version: 2 }, { ...seed(), phase: 'pending' }, { ...seed(), run: { ...github, ref: 'refs/heads/feature' } }, { ...seed(), delivered: [] }, native]) {
      await expect(prepareCheckpoint(invalid, o)).rejects.toThrow();
    }
    for (const run of [fly(now + 1), fly(now + period), fly(now - period), { worker: 'scorearc-alert-receiver', tick: now }, { ...fly(now), fly: 'other' }, { ...fly(now), id: 11 }]) {
      await expect(prepareCheckpoint(seed(), { ...o, run })).rejects.toThrow();
    }
    expect(check).not.toHaveBeenCalled();
  });
  it('restricts queued links to their trusted runtime and refuses malformed native reservations before sending', async () => {
    const pending = await prepareCheckpoint(seed(), { ...options(now), check: async () => ({ ...fresh, pollEvidence: { full: { outcome: 'ok', missing: 0, at: at(now) } } }) });
    for (const runUrl of [FLY_RUN_URL + '?other', 'https://example.com/']) {
      expect(() => validateCheckpoint({ ...pending, pending: [{ ...pending.pending[0], runUrl }] }, config)).toThrow();
    }
    expect(() => validateState({ ...pending, run: github }, { ...config, run: github })).toThrow();
    const send = vi.fn();
    await expect(finishCheckpoint({ ...pending, phase: 'final' }, { now, send })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
