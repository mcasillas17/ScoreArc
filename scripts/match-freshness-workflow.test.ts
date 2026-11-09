import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const yaml = createRequire(import.meta.url)('js-yaml');
const document = () => readFile('.github/workflows/match-freshness.yml', 'utf8').then(s => yaml.load(s));
describe('opt-in durable match workflow', () => {
  it('gates the whole job before checks, downloads, secrets and delivery', async () => {
    const workflow = await document();
    // Dispatch only: the receiver's cron dispatches every five minutes (November 8, 2026).
    // GitHub's schedule is gone, so it cannot double the accepted cadence.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    // The receiver dispatches with no inputs, so this must fall back to false: never initialize history.
    expect(workflow.jobs.check.steps.find((s: any) => s.id === 'select').env.INITIALIZE_STATE).toBe('${{ inputs.initialize_state || false }}');
    expect(workflow.on.workflow_dispatch.inputs.initialize_state.default).toBe(false);
    expect(workflow.jobs.check.if).toContain("vars.MATCH_FRESHNESS_ENABLED == 'true'");
    expect(workflow.jobs.check.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.concurrency).toEqual({ group: 'match-freshness-watchdog', 'cancel-in-progress': false });
    expect(workflow.jobs.check['timeout-minutes']).toBe(10);
  });
  it('requires successful pending upload before delivery, retains both immutable checkpoints, and fails explicitly', async () => {
    const workflow = await document(); const steps = workflow.jobs.check.steps;
    const step = (id: string) => steps.find((s: any) => s.id === id);
    expect(step('prepare').name).toBe('Prepare pending state');
    expect(step('deliver').if).toContain("steps.pending.outcome == 'success'");
    expect(step('deliver').if).toContain("vars.MATCH_FRESHNESS_DELIVERY_ENABLED == 'true'");
    expect(step('deliver').env.PENDING_ARTIFACT_ID).toBe('${{ steps.pending.outputs.artifact-id }}');
    expect(step('restore').with['artifact-ids']).toBe('${{ steps.select.outputs.artifact_id }}');
    expect(step('restore').with['run-id']).toBe('${{ steps.select.outputs.run_id }}');
    for (const id of ['pending', 'final']) {
      const upload = step(id);
      expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
      expect(upload.with['if-no-files-found']).toBe('error'); expect(upload.with['retention-days']).toBe(90);
      expect(upload['continue-on-error']).toBeUndefined(); expect(upload.with.path).toBe('watchdog-state/state.json');
    }
    expect(step('pending').with.name).toBe('match-freshness-pending');
    expect(step('final').with.name).toBe('match-freshness-state');
    expect(step('final').if).toContain("steps.deliver.outputs.state_written == 'true'");
    expect(step('result').if).toContain('always()');
    // The heartbeat needs the same secret as delivery; a missing line would fail silently.
    for (const id of ['deliver', 'result']) expect(step(id).env.MATCH_FRESHNESS_WEBHOOK_URL).toBe('${{ secrets.MATCH_FRESHNESS_WEBHOOK_URL }}');
    expect(step('result').env.CHECKPOINT_COMMITTED).toBe("${{ steps.pending.outcome == 'success' && steps.final.outcome == 'success' }}");
    expect(steps.filter((s: any) => s.uses).every((s: any) => /@[0-9a-f]{40}$/.test(s.uses))).toBe(true);
    expect(steps.findIndex((s: any) => s.id === 'pending')).toBeLessThan(steps.findIndex((s: any) => s.id === 'deliver'));
  });
  it.each([undefined, 'false', 'TRUE'].flatMap(enabled => ['select','prepare','deliver','result'].map(phase => ({ enabled, phase }))))(
    'disabled $phase CLI (enabled=$enabled) performs no filesystem or network work with invalid production config', async ({ enabled, phase }) => {
    const env = { ...process.env, MATCH_FRESHNESS_ENABLED: enabled, MATCH_FRESHNESS_DELIVERY_ENABLED: 'true',
      GITHUB_TOKEN: '', GITHUB_REF: 'invalid', MATCH_FRESHNESS_WEBHOOK_URL: 'invalid' };
    if (enabled === undefined) delete env.MATCH_FRESHNESS_ENABLED;
    const result = await new Promise<{code: number; stdout: string}>(resolve => {
      execFile(process.execPath, ['scripts/match-freshness-monitor.mjs', phase], { env },
        (error, stdout) => resolve({ code: error ? 1 : 0, stdout }));
    });
    expect(result).toEqual({ code: 0, stdout: 'Match monitor disabled; no checks or delivery.\n' });
  });
});

// Execute the actual exported CLI phases and parsed job conditions. Only GitHub
// metadata/artifact actions are mocked; reader and receiver are loopback servers.
import { afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener, type Server } from 'node:http';
import * as monitor from './match-freshness-monitor.mjs';
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true });
});
async function local(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  return `http://127.0.0.1:${address.port}`;
}
function condition(expression: string | undefined, steps: Record<string, any>, vars: Record<string, string>, ref: string) {
  const success = Object.values(steps).every(s => s.outcome !== 'failure');
  if (!expression) return success;
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('success()', String(success)).replaceAll('always()', 'true')
    .replace(/steps\.([\w]+)\.outputs\.([\w]+)|steps\.([\w]+)\.outcome|vars\.([\w]+)|github\.ref/g,
      // GitHub compares strings case-insensitively; this workflow's literals are lowercase.
      (_all, id, output, outcome, variable) => JSON.stringify(id ? steps[id]?.outputs[output] ?? '' : outcome ? steps[outcome]?.outcome ?? '' : variable ? (vars[variable] ?? '').toLowerCase() : ref));
  // Test-only evaluation of this repository's parsed workflow expressions.
  return Boolean(Function(`"use strict"; return (${source});`)());
}
async function harness() {
  const workflow = await document(); const artifacts = new Map<number, any[]>(); const history: any[] = [];
  const jobs = new Map<number, any[]>(); const notifications: any[] = [];
  let now = Date.parse('2026-10-04T12:00:00Z'); let nextArtifact = 1000; let checks = 0; let healthy = false;
  const baseURL = await local((_req, res) => {
    checks++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-ScoreArc-Freshness': healthy ? 'empty' : 'unavailable',
      'X-ScoreArc-Poll-Status': healthy ? 'ok' : 'failed', 'X-ScoreArc-Observed-At': '2026-10-04T12:00:00Z',
      'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0' }).end('[]');
  });
  const heartbeats: string[] = []; let receiverDown = false; let heartbeatDown = false;
  const webhookURL = `${await local(async (req, res) => {
    // Every heartbeat attempt is recorded, even refused ones, so "none" means none sent.
    if (req.url?.startsWith('/heartbeat/')) { heartbeats.push(req.url); return res.writeHead(heartbeatDown ? 503 : 204).end(); }
    if (receiverDown) return res.writeHead(503).end();
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); notifications.push(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ eventId: payload.eventId }));
  })}/events/${'t'.repeat(40)}`;
  async function run({ enabled = 'true', deliveryEnabled = 'true', failUpload = '', initialize = false, event = 'workflow_dispatch', checkpointCommitted = '', ref = 'refs/heads/main' } = {}) {
    now += 600000;
    const id = history.length + 100;
    const iso = new Date(now).toISOString();
    const current = { id, run_number: id, run_attempt: 1, workflow_id: 7, path: '.github/workflows/match-freshness.yml', head_branch: 'main', head_sha: 'a'.repeat(40),
      event, status: 'in_progress', conclusion: null, repository: { id: 1, full_name: 'mcasillas17/ScoreArc' }, head_repository: { id: 1, full_name: 'mcasillas17/ScoreArc' }, created_at: new Date(now-60000).toISOString(), updated_at: iso };
    const vars = { MATCH_FRESHNESS_ENABLED: enabled, MATCH_FRESHNESS_DELIVERY_ENABLED: deliveryEnabled };
    const steps: Record<string, any> = {};
    const github = vi.fn(async (path: string) => {
      const root = '/repos/mcasillas17/ScoreArc/actions';
      if (path === `${root}/workflows/match-freshness.yml`) return { id: 7, path: current.path };
      if (path === `${root}/runs/${id}`) return current;
      if (path.includes('/workflows/7/runs?')) return { total_count: history.length+1, workflow_runs: [current, ...history.toReversed()] };
      const prior = /\/runs\/(\d+)\/(artifacts|attempts\/1\/jobs)/.exec(path);
      if (!prior) throw new Error('Unexpected GitHub request');
      const values = prior[2] === 'artifacts' ? artifacts.get(+prior[1]) ?? [] : jobs.get(+prior[1]) ?? [];
      return { total_count: values.length, [prior[2] === 'artifacts' ? 'artifacts' : 'jobs']: values };
    });
    if (!condition(workflow.jobs.check.if, steps, vars, ref)) return { steps, github, id };
    const dir = await mkdtemp(join(tmpdir(), 'monitor-workflow-')); dirs.push(dir);
    const workDir = join(dir, 'watchdog-state'); const output = join(dir, 'output');
    const env = { ...vars, NODE_ENV: 'test' as const, GITHUB_REPOSITORY: current.repository.full_name, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: current.head_sha,
      GITHUB_RUN_ID: String(id), GITHUB_RUN_NUMBER: String(id), GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output,
      INITIALIZE_STATE: String(initialize), MATCH_FRESHNESS_WEBHOOK_URL: webhookURL, PENDING_ARTIFACT_ID: '', CHECKPOINT_COMMITTED: '' };
    const executed: any[] = [];
    for (const step of workflow.jobs.check.steps) {
      if (!step.id) continue;
      const entry = steps[step.id] = { outcome: 'skipped', outputs: {} as Record<string, string> };
      if (condition(step.if, steps, vars, env.GITHUB_REF)) {
        try {
          await writeFile(output, '');
          if (step.run) {
            const phase = step.run.split(' ').at(-1);
            env.PENDING_ARTIFACT_ID = steps.pending?.outputs['artifact-id'] ?? '';
            if (step.env?.CHECKPOINT_COMMITTED) env.CHECKPOINT_COMMITTED = checkpointCommitted || String(condition(step.env.CHECKPOINT_COMMITTED, steps, vars, env.GITHUB_REF));
            const result = await monitor.runPhase({ phase, env, workDir, now, baseURL, github });
            if (result.exitCode) throw new Error('Phase failed');
            entry.outputs = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').filter(Boolean).map(line => line.split('=')));
          } else if (step.uses.startsWith('actions/download-artifact@')) {
            const artifactId = Number(steps.select.outputs.artifact_id);
            const artifact = [...artifacts.values()].flat().find(a => a.id === artifactId);
            if (!artifact) throw new Error('No artifact');
            await mkdir(workDir, { recursive: true }); await writeFile(join(workDir, 'state.json'), artifact.bytes);
          } else if (step.uses.startsWith('actions/upload-artifact@')) {
            if (step.id === failUpload) throw new Error('Synthetic upload failure');
            const bytes = await readFile(join(workDir, 'state.json'), 'utf8'); const artifactId = nextArtifact++;
            artifacts.set(id, [...artifacts.get(id) ?? [], { id: artifactId, name: step.with.name, bytes, expired: false, size_in_bytes: Buffer.byteLength(bytes),
              created_at: iso, updated_at: iso, expires_at: '2027-01-01T00:00:00Z', workflow_run: { id, repository_id: 1, head_repository_id: 1, head_branch: 'main', head_sha: current.head_sha } }]);
            entry.outputs['artifact-id'] = String(artifactId);
          }
          entry.outcome = 'success';
        } catch { entry.outcome = 'failure'; }
      }
      executed.push({ name: step.name, status: 'completed', conclusion: entry.outcome });
    }
    jobs.set(id, [{ id, run_id: id, status: 'completed', conclusion: 'failure', steps: executed }]);
    history.push({ ...current, status: 'completed', conclusion: 'failure' });
    return { steps, github, id };
  }
  return { run, artifacts, notifications, heartbeats, checks: () => checks, healthy: () => { healthy = true; }, unhealthy: () => { healthy = false; }, receiverDown: (down: boolean) => { receiverDown = down; }, heartbeatDown: (down: boolean) => { heartbeatDown = down; } };
}
describe('enabled workflow artifact boundaries', () => {
  it('a manual dispatch from another branch makes no reader, GitHub or receiver requests', async () => {
    const h = await harness(); const other = await h.run({ ref: 'refs/heads/feature' });
    expect(other.steps).toEqual({}); expect(other.github).not.toHaveBeenCalled();
    expect(h.checks()).toBe(0); expect(h.notifications).toEqual([]); expect(h.artifacts.size).toBe(0);
  });
  it.each(['', 'false'])('disabled job (enabled=%s) makes no reader, GitHub or receiver requests', async enabled => {
    const h = await harness(); const disabled = await h.run({ enabled });
    expect(disabled.steps).toEqual({}); expect(disabled.github).not.toHaveBeenCalled();
    expect(h.checks()).toBe(0); expect(h.notifications).toEqual([]); expect(h.artifacts.size).toBe(0); expect(h.heartbeats).toEqual([]);
  });
  it.each(['', 'false'])('delivery gate (%s) retains unreserved events for a later enabled run', async deliveryEnabled => {
    const h = await harness(); const first = await h.run({ initialize: true, deliveryEnabled });
    expect(h.checks()).toBe(10); expect(h.notifications).toEqual([]);
    expect(first.steps.pending.outcome).toBe('success'); expect(first.steps.deliver.outcome).toBe('skipped');
    expect(first.steps.final.outcome).toBe('skipped'); expect(first.steps.result.outcome).toBe('failure');
    const pending = JSON.parse(h.artifacts.get(first.id)![0].bytes);
    expect(pending).toMatchObject({ reserved: [], pending: Array.from({ length: 10 }, () => ({ attempts: 0 })) });
    const next = await h.run(); expect(next.steps.restore.outcome).toBe('success');
    expect(next.steps.final.outcome).toBe('success'); expect(h.notifications).toHaveLength(10);
  });
  it('executes checks and delivery only after successful pending upload, preserving failed incident runs', async () => {
    const h = await harness();
    const first = await h.run({ initialize: true });
    expect(first.steps.prepare.outcome).toBe('success'); expect(first.steps.pending.outcome).toBe('success');
    expect(first.steps.deliver.outcome).toBe('success'); expect(first.steps.final.outcome).toBe('success');
    expect(first.steps.result.outcome).toBe('failure'); expect(h.notifications).toHaveLength(10);
    const continued = await h.run(); expect(continued.steps.restore.outcome).toBe('success'); expect(h.notifications).toHaveLength(10);
    h.healthy(); const recovered = await h.run(); expect(recovered.steps.result.outcome).toBe('success');
    expect(h.notifications.slice(10).every(e => e.status === 'RESOLVED')).toBe(true);
  });
  // The job gate lets 'TRUE' start a job whose CLI does nothing; its Prepare step must be
  // skipped so the run is not mistaken for a lost preparation by the next real run.
  it("a job started by 'TRUE' prepares nothing and does not block the next run", async () => {
    const h = await harness(); await h.run({ initialize: true }); h.heartbeats.length = 0;
    const upper = await h.run({ enabled: 'TRUE' });
    expect(upper.steps.select.outcome).toBe('success'); expect(upper.steps.prepare.outcome).toBe('skipped');
    expect(h.artifacts.has(upper.id)).toBe(false);
    // Documented consequence: no heartbeat, so an armed not-running check emails.
    expect(upper.steps.result.outcome).toBe('skipped'); expect(h.heartbeats).toEqual([]);
    const next = await h.run();
    expect(next.steps.restore.outcome).toBe('success'); expect(next.steps.prepare.outcome).toBe('success');
  });
  it('failed pending upload prohibits sends and blocks silent rollback on next run', async () => {
    const h = await harness(); const first = await h.run({ initialize: true, failUpload: 'pending' });
    expect(first.steps.prepare.outputs.state_written).toBe('true'); expect(first.steps.pending.outcome).toBe('failure');
    expect(first.steps.deliver.outcome).toBe('skipped'); expect(h.notifications).toEqual([]);
    const next = await h.run(); expect(next.steps.select.outcome).toBe('failure'); expect(next.steps.prepare.outcome).toBe('skipped');
  });
  it('failed final upload restores pending and retries stable IDs after backoff', async () => {
    const h = await harness(); const first = await h.run({ initialize: true, failUpload: 'final' });
    expect(first.steps.final.outcome).toBe('failure'); expect(h.notifications).toHaveLength(10);
    const original = structuredClone(h.notifications);
    const next = await h.run(); expect(next.steps.restore.outcome).toBe('success'); expect(next.steps.final.outcome).toBe('success');
    expect(h.notifications.slice(10)).toEqual(original);
  });
});

describe('heartbeat', () => {
  it('pings after dispatched and scheduled runs that delivered, including data incidents', async () => {
    const h = await harness();
    // The receiver's cron dispatches the regular runs, so a dispatched run counts.
    const dispatched = await h.run({ initialize: true }); expect(dispatched.steps.result.outcome).toBe('failure');
    expect(h.heartbeats).toEqual([`/heartbeat/${'t'.repeat(40)}`]);
    // A scheduled run from before November 8 still pings, and the next run selects its checkpoint.
    const incident = await h.run({ event: 'schedule' }); expect(incident.steps.result.outcome).toBe('failure');
    expect(h.heartbeats).toHaveLength(2);
    const next = await h.run(); expect(next.steps.restore.outcome).toBe('success'); expect(next.steps.prepare.outcome).toBe('success');
    expect(next.steps.select.outputs.run_id).toBe(String(incident.id));
    expect(h.heartbeats).toHaveLength(3);
  });
  it('sends nothing when delivery is off or delivery failed', async () => {
    const h = await harness(); h.healthy();
    // Healthy, so the run exits 0 and only the missing final checkpoint blocks the ping.
    const off = await h.run({ initialize: true, deliveryEnabled: 'false' });
    expect(off.steps.result.outcome).toBe('success'); expect(off.steps.final.outcome).toBe('skipped'); expect(h.heartbeats).toEqual([]);
    // The CLI enforces delivery-only heartbeats on its own, even if the workflow claimed commit.
    await h.run({ deliveryEnabled: 'false', checkpointCommitted: 'true' }); expect(h.heartbeats).toEqual([]);
    h.unhealthy();
    h.receiverDown(true); const failed = await h.run();
    expect(failed.steps.deliver.outcome).toBe('success'); expect(h.heartbeats).toEqual([]);
    h.receiverDown(false); await h.run(); expect(h.heartbeats).toHaveLength(1);
  });
  it.each(['pending', 'final'])('sends nothing after a failed %s checkpoint upload', async failUpload => {
    const h = await harness(); h.healthy();
    await h.run({ initialize: true, failUpload });
    expect(h.heartbeats).toEqual([]);
  });
  it('a failed ping leaves the run result unchanged', async () => {
    const h = await harness(); h.healthy(); h.heartbeatDown(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await h.run({ initialize: true });
    expect(run.steps.final.outcome).toBe('success'); expect(run.steps.result.outcome).toBe('success');
    expect(h.heartbeats).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).toContain('heartbeat not acknowledged');
    expect(JSON.stringify(log.mock.calls)).not.toContain('t'.repeat(40));
  });
  it('heartbeat sender refuses a webhook it cannot map, and needs 204', async () => {
    const ok = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(null, { status: 204 }));
    await monitor.sendHeartbeat({ webhookURL: 'https://r.example/events/abc', fetchImpl: ok });
    expect(String(ok.mock.calls[0][0])).toBe('https://r.example/heartbeat/abc');
    for (const webhookURL of ['https://r.example/', 'https://r.example/events/abc?x=1', 'http://r.example/events/abc', 'https://r.example/events/a/b']) {
      await expect(monitor.sendHeartbeat({ webhookURL, fetchImpl: ok })).rejects.toThrow('Invalid webhook configuration');
    }
    await expect(monitor.sendHeartbeat({ webhookURL: 'https://r.example/events/abc', fetchImpl: async () => new Response('{}', { status: 200 }) })).rejects.toThrow();
  });
});
