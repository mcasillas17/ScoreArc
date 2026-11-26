import { afterEach, expect, it, vi } from 'vitest';
import { downloadFlyCheckpoint } from './match-freshness-receiver.mjs';
import { rewrapFlyCheckpoint } from './match-freshness-checkpoint.mjs';
import { newSignal } from './match-freshness-policy.mjs';

const time = Date.UTC(2026, 10, 26, 12);
const epoch = '12345678-1234-4234-8234-123456789abc';
const scope = { competition: 'liga-mx', season: '2026-apertura' };
const key = 'liga-mx/2026-apertura';
const run = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml', ref: 'refs/heads/main', id: 801, number: 701, attempt: 1, sha: 'a'.repeat(40) };
const options = { baseURL: 'https://reader.example', scopes: [scope], now: time + 5000, run };
const final = { version: 3, epoch, origin: options.baseURL, run: { fly: 'scorearc-observability', tick: time }, sequence: 1, updatedAt: new Date(time).toISOString(), phase: 'final',
  incidents: { [key]: epoch + ':1' }, pending: [], delivered: [{ id: epoch + ':1', acknowledgedAt: new Date(time).toISOString() }], signals: { [key]: newSignal() }, reserved: [], dataIncident: true, monitorFailure: null };
const webhook = 'https://receiver.example/events/' + 't'.repeat(40);
const env = { MATCH_FRESHNESS_DELIVERY_ENABLED: 'true', RESTORE_FROM_FLY: 'true', INITIALIZE_STATE: 'false',
  RECOVERY_RUN_ID: '', RECOVERY_ARTIFACT_ID: '', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'mcasillas17/ScoreArc/.github/workflows/match-freshness.yml@refs/heads/main', MATCH_FRESHNESS_WEBHOOK_URL: webhook };
afterEach(() => vi.restoreAllMocks());

it('reads only the drained checkpoint in a bounded POST and preserves open incident state verbatim', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json(final));
  const previous = await downloadFlyCheckpoint(env, options, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe(webhook.replace('/events/', '/checkpoint/'));
  expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(init?.signal).toBe(timeout.mock.results[0].value);
  expect(rewrapFlyCheckpoint(previous, options)).toEqual({ ...final, run, phase: 'pending' });
  expect(previous).toEqual(final);
});

it('rejects conflicting inputs, wrong workflow and unsupported webhook URLs before a request', async () => {
  const send = vi.fn();
  for (const invalid of [{ INITIALIZE_STATE: 'true' }, { RECOVERY_RUN_ID: '1' }, { RECOVERY_ARTIFACT_ID: '2' }, { MATCH_FRESHNESS_DELIVERY_ENABLED: 'false' },
    { RESTORE_FROM_FLY: 'false' }, { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_WORKFLOW_REF: 'other' },
    ...['http://localhost/events/t', 'https://receiver.example/heartbeat/secret', webhook + '?x=1', webhook + '/extra'].map(url => ({ MATCH_FRESHNESS_WEBHOOK_URL: url }))]) {
    await expect(downloadFlyCheckpoint({ ...env, ...invalid }, options, send)).rejects.toThrow();
  }
  for (const invalid of [{ attempt: 2 }, { ref: 'refs/heads/Main' }, { workflow: 'other' }]) {
    await expect(downloadFlyCheckpoint(env, { ...options, run: { ...run, ...invalid } }, send)).rejects.toThrow();
  }
  expect(send).not.toHaveBeenCalled();
});

it('rejects redirects, oversized streams and stale or unusable checkpoint types', async () => {
  for (const response of [new Response(null, { status: 302 }), new Response(null, { status: 409 }), new Response('x'.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) {
    await expect(downloadFlyCheckpoint(env, options, async () => response)).rejects.toThrow();
  }
  for (const bad of [{ run }, { run: { ...final.run, fly: 'other' } }, { phase: 'pending' }, { monitorFailure: 'queue-full' }, { pending: [{}] }, { reserved: [epoch + ':1'] },
    { origin: 'https://wrong.example' }, { incidents: {} }, { delivered: [] }]) {
    expect(() => rewrapFlyCheckpoint({ ...final, ...bad }, options)).toThrow();
  }
});
