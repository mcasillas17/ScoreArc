import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const yaml = createRequire(import.meta.url)('js-yaml');
const document = () => readFile('.github/workflows/match-freshness.yml', 'utf8').then(s => yaml.load(s));
describe('opt-in durable match workflow', () => {
  it('gates the whole job before checks, downloads, secrets and delivery', async () => {
    const workflow = await document();
    expect(workflow.on.schedule).toBeUndefined();
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
      expect(upload.uses).toBe('actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f');
      expect(upload.with['if-no-files-found']).toBe('error'); expect(upload.with['retention-days']).toBe(90);
      expect(upload['continue-on-error']).toBeUndefined(); expect(upload.with.path).toBe('watchdog-state/state.json');
    }
    expect(step('pending').with.name).toBe('match-freshness-pending');
    expect(step('final').with.name).toBe('match-freshness-state');
    expect(step('final').if).toContain("steps.deliver.outputs.state_written == 'true'");
    expect(step('result').if).toContain('always()');
    expect(steps.filter((s: any) => s.uses).every((s: any) => /@[0-9a-f]{40}$/.test(s.uses))).toBe(true);
    expect(steps.findIndex((s: any) => s.id === 'pending')).toBeLessThan(steps.findIndex((s: any) => s.id === 'deliver'));
  });
  it.each(['select','prepare','deliver','result'])('disabled %s CLI performs no filesystem or network work with invalid production config', async phase => {
    const result = await new Promise<{code: number; stdout: string}>(resolve => {
      execFile(process.execPath, ['scripts/match-freshness-monitor.mjs', phase], { env: {
        ...process.env, MATCH_FRESHNESS_ENABLED: 'false', MATCH_FRESHNESS_DELIVERY_ENABLED: 'true',
        GITHUB_TOKEN: '', GITHUB_REF: 'invalid', MATCH_FRESHNESS_WEBHOOK_URL: 'invalid',
      } }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout }));
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
      (_all, id, output, outcome, variable) => JSON.stringify(id ? steps[id]?.outputs[output] ?? '' : outcome ? steps[outcome]?.outcome ?? '' : variable ? vars[variable] ?? '' : ref));
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
  const webhookURL = await local(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); notifications.push(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ eventId: payload.eventId }));
  });
  async function run({ enabled = true, failUpload = '', initialize = false } = {}) {
    now += 600000;
    const id = history.length + 100;
    const iso = new Date(now).toISOString();
    const current = { id, run_number: id, run_attempt: 1, workflow_id: 7, path: '.github/workflows/match-freshness.yml', head_branch: 'main', head_sha: 'a'.repeat(40),
      event: 'workflow_dispatch', status: 'in_progress', conclusion: null, repository: { id: 1, full_name: 'mcasillas17/ScoreArc' }, head_repository: { id: 1, full_name: 'mcasillas17/ScoreArc' }, created_at: new Date(now-60000).toISOString(), updated_at: iso };
    const vars = { MATCH_FRESHNESS_ENABLED: String(enabled), MATCH_FRESHNESS_DELIVERY_ENABLED: 'true' };
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
    if (!condition(workflow.jobs.check.if, steps, vars, 'refs/heads/main')) return { steps, github, id };
    const dir = await mkdtemp(join(tmpdir(), 'monitor-workflow-')); dirs.push(dir);
    const workDir = join(dir, 'watchdog-state'); const output = join(dir, 'output');
    const env = { ...vars, NODE_ENV: 'test' as const, GITHUB_REPOSITORY: current.repository.full_name, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: current.head_sha,
      GITHUB_RUN_ID: String(id), GITHUB_RUN_NUMBER: String(id), GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: output,
      INITIALIZE_STATE: String(initialize), MATCH_FRESHNESS_WEBHOOK_URL: webhookURL, PENDING_ARTIFACT_ID: '' };
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
  return { run, artifacts, notifications, checks: () => checks, healthy: () => { healthy = true; } };
}
describe('enabled workflow artifact boundaries', () => {
  it('executes checks and delivery only after successful pending upload, preserving failed incident runs', async () => {
    const h = await harness();
    const disabled = await h.run({ enabled: false }); expect(disabled.github).not.toHaveBeenCalled(); expect(h.checks()).toBe(0);
    const first = await h.run({ initialize: true });
    expect(first.steps.prepare.outcome).toBe('success'); expect(first.steps.pending.outcome).toBe('success');
    expect(first.steps.deliver.outcome).toBe('success'); expect(first.steps.final.outcome).toBe('success');
    expect(first.steps.result.outcome).toBe('failure'); expect(h.notifications).toHaveLength(10);
    const continued = await h.run(); expect(continued.steps.restore.outcome).toBe('success'); expect(h.notifications).toHaveLength(10);
    h.healthy(); const recovered = await h.run(); expect(recovered.steps.result.outcome).toBe('success');
    expect(h.notifications.slice(10).every(e => e.status === 'RESOLVED')).toBe(true);
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
