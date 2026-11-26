import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { newSignal } from './match-freshness-policy.mjs';
import { cutover, queryReceiver, readArchive } from './cutover-match-freshness.mjs';

const repository = 'mcasillas17/ScoreArc';
const workflow = '.github/workflows/match-freshness.yml';
const repoId = 1284736122;
const workflowId = 362264580;
const root = `/repos/${repository}/actions`;
const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = 'liga-mx/2026';
const sha = 'a'.repeat(40);
const created = '2026-11-26T08:00:00Z';
const recorded = '2026-11-26T08:00:15.001Z';
const published = '2026-11-26T08:00:16Z';
const finished = '2026-11-26T08:00:18Z';
const now = Date.parse(finished) + 300_000;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function harness() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(readFileSync('infra/alert-receiver/migrations/0003_native_monitor.sql', 'utf8'));
  db.exec("UPDATE monitor_runtime SET mode='draining' WHERE id=1");
  const run = { id: 100, run_number: 10, run_attempt: 1, workflow_id: workflowId, path: workflow, head_branch: 'main',
    head_sha: sha, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: created, updated_at: finished,
    repository: { id: repoId, full_name: repository }, head_repository: { id: repoId, full_name: repository } };
  const artifact = { id: 300, name: 'match-freshness-state', size_in_bytes: 123, digest: `sha256:${'c'.repeat(64)}`,
    expired: false, created_at: published, updated_at: published, expires_at: '2027-02-01T00:00:00Z',
    workflow_run: { id: 100, repository_id: repoId, head_repository_id: repoId, head_sha: sha, head_branch: 'main' } };
  const artifacts = [{ ...artifact, id: 200, name: 'match-freshness-pending' }, artifact];
  const steps = ['Prepare pending state', 'Commit pending checkpoint before any send', 'Deliver reserved transitions',
    'Commit acknowledged checkpoint', 'Report data and monitor status separately'].map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const metadata = { state: 'disabled_manually', path: workflow, id: workflowId };
  const github = vi.fn(async (path: string) => {
    if (path.endsWith('/workflows/match-freshness.yml')) return metadata;
    if (path.includes('?status=')) return { total_count: 0, workflow_runs: [] };
    if (path.includes('/runs?branch=main')) return { total_count: 1, workflow_runs: [run] };
    if (path === `${root}/runs/100/artifacts?per_page=10`) return { total_count: artifacts.length, artifacts };
    if (path === `${root}/runs/100/attempts/1/jobs?per_page=10`) return { total_count: 1, jobs: [{ name: 'check',
      run_id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, steps }] };
    throw Error('unexpected GET');
  });
  const checkpoint = { version: 3, origin: 'https://scorearc-reader.fly.dev', epoch,
    run: { repository, workflow, ref: 'refs/heads/main', id: 100, number: 10, attempt: 1, sha },
    sequence: 1, updatedAt: recorded, phase: 'final', incidents: { [key]: `${epoch}:1` },
    pending: [], delivered: [{ id: `${epoch}:1`, acknowledgedAt: published }], reserved: [], dataIncident: true,
    monitorFailure: null, signals: { [key]: { ...newSignal(), prior: 'full', waiting: { full: created } } } };
  const query = vi.fn(async (sql: string, params: string[] = []) => [{ success: true, results: db.prepare(sql).all(...params) }]);
  const deps = { github, query, info: async () => ({ uuid: '31dcc498-699d-42ff-a051-f10e1534d0b5', name: 'scorearc-alert-receiver' }),
    download: vi.fn(async () => structuredClone(checkpoint)), scopes: [{ competition: 'liga-mx', season: '2026' }], clock: () => now };
  const row = () => db.prepare('SELECT mode, checkpoint FROM monitor_runtime WHERE id=1').get()!;
  return { deps, row, run, artifact, artifacts, checkpoint, steps, metadata, db };
}

it('checks read-only and only activates the exact observed final once, preserving the open incident and receipt', async () => {
  const h = harness();
  await expect(cutover(['check'], h.deps)).resolves.toMatchObject({ runId: 100, artifactId: 300 });
  expect(h.row()).toEqual({ mode: 'draining', checkpoint: null });
  await cutover(['apply', '100', '300'], h.deps);
  expect(h.row().mode).toBe('cloudflare');
  expect(JSON.parse(String(h.row().checkpoint))).toEqual(h.checkpoint);
  expect(h.deps.query).toHaveBeenCalledWith(expect.stringContaining('checkpoint=?'), [JSON.stringify(h.checkpoint)]);
  await expect(cutover(['apply', '100', '300'], h.deps)).rejects.toThrow();
});

it.each(['other workflow', 'running', 'failed', 'rerun', 'fork', 'expired', 'duplicate final', 'pending only',
  'skipped delivery', 'later receipt', 'old state', 'wrong run', 'pending state', 'wrong scope', 'failure', 'wrong id', 'already seeded'])(
  'refuses a handoff for %s without changing the row', async reason => {
    const h = harness();
    switch (reason) {
      case 'other workflow': h.metadata.id++; break;
      case 'running': h.run.status = 'in_progress'; break;
      case 'failed': h.run.conclusion = 'failure'; break;
      case 'rerun': h.run.run_attempt++; break;
      case 'fork': h.run.head_repository.id++; break;
      case 'expired': h.artifact.expired = true; break;
      case 'duplicate final': h.artifacts.push({ ...h.artifact }); break;
      case 'pending only': h.artifacts.pop(); break;
      case 'skipped delivery': h.steps[2].conclusion = 'skipped'; break;
      case 'later receipt': h.checkpoint.delivered[0].acknowledgedAt = finished; break;
      case 'old state': h.checkpoint.updatedAt = '2026-11-25T00:00:00Z'; break;
      case 'wrong run': h.checkpoint.run.id--; break;
      case 'pending state': h.checkpoint.phase = 'pending'; break;
      case 'wrong scope': h.deps.scopes[0].season = '2025'; break;
      case 'failure': Object.assign(h.checkpoint, { monitorFailure: 'delivery-failed' }); break;
      case 'wrong id': h.artifact.id++; break;
      case 'already seeded': h.db.exec("UPDATE monitor_runtime SET checkpoint='existing'"); break;
    }
    const before = h.row();
    await expect(cutover(['apply', '100', '300'], h.deps)).rejects.toThrow();
    expect(h.row()).toEqual(before);
  });

it('detects an older in-flight run and a workflow re-enabled during download', async () => {
  const h = harness();
  const github = h.deps.github.getMockImplementation()!;
  h.deps.github.mockImplementation(path => path.includes('status=waiting')
    ? Promise.resolve({ total_count: 1, workflow_runs: [h.run] }) : github(path));
  await expect(cutover(['apply', '100', '300'], h.deps)).rejects.toThrow();
  expect(h.deps.download).not.toHaveBeenCalled();
  h.deps.github.mockImplementation(github);
  h.deps.download.mockImplementation(async () => { h.metadata.state = 'active'; return h.checkpoint; });
  await expect(cutover(['apply', '100', '300'], h.deps)).rejects.toThrow();
  expect(h.row().mode).toBe('draining');
});

it('loses the import race without overwriting another checkpoint', async () => {
  const h = harness();
  h.deps.download.mockImplementation(async () => {
    h.db.exec("UPDATE monitor_runtime SET checkpoint='winner', mode='cloudflare'");
    return h.checkpoint;
  });
  await expect(cutover(['apply', '100', '300'], h.deps)).rejects.toThrow();
  expect(h.row()).toEqual({ mode: 'cloudflare', checkpoint: 'winner' });
});

it('pins the receiver UUID and the observed workflow run ID', async () => {
  const h = harness();
  const info = async () => ({ name: 'scorearc-alert-receiver', uuid: 'other-db' });
  await expect(cutover(['apply', '100', '300'], { ...h.deps, info })).rejects.toThrow(/database/);
  expect(h.deps.query).not.toHaveBeenCalled();
  await expect(cutover(['apply', '99', '300'], h.deps)).rejects.toThrow(/IDs/);
  expect(h.row().mode).toBe('draining');
});

it('does not import a fully formed final with a retryable pending event', async () => {
  const h = harness();
  Object.assign(h.checkpoint, { sequence: 2, dataIncident: false, incidents: { [key]: null }, pending: [{
    id: `${epoch}:2`, incidentId: `${epoch}:1`, scope: key, status: 'RESOLVED', occurredAt: recorded,
    runUrl: 'https://github.com/mcasillas17/ScoreArc/actions/runs/100', count: 1, attempts: 1, nextAttemptAt: recorded,
    observation: { freshness: 'fresh', poll: 'ok', stale: 0, overdue: 0, error: null },
  }] });
  await expect(cutover(['apply', '100', '300'], h.deps)).rejects.toThrow(/fully acknowledged/);
  expect(h.row().mode).toBe('draining');
});

it.each(['good', 'digest mismatch', 'additional member', 'enlarged body'])('verifies and reads the exact bounded archive (%s)', async reason => {
  const dir = mkdtempSync(join(tmpdir(), 'scorearc-cutover-test-'));
  try {
    const payload = { value: reason === 'enlarged body' ? 'x'.repeat(300_000) : 'test' };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(payload));
    const files = ['state.json'];
    if (reason === 'additional member') {
      writeFileSync(join(dir, 'extra.json'), '{}');
      files.push('extra.json');
    }
    const archive = execFileSync('zip', ['-q', '-', ...files], { cwd: dir });
    const hash = createHash('sha256').update(archive).digest('hex');
    const metadata = { size_in_bytes: archive.length, digest: 'sha256:' + (reason === 'digest mismatch' ? '0'.repeat(64) : hash) };
    const binary = async (cmd: string, args: string[], maxBuffer: number) => execFileSync(cmd, args, { maxBuffer });
    const read = readArchive(archive, metadata, dir, binary);
    if (reason === 'good') await expect(read).resolves.toEqual(payload);
    else await expect(read).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true }); }
});

it('sends a bound parameter to the pinned D1 endpoint and rejects redirects or provider errors', async () => {
  const creds = { type: 'api_token', token: 'fake-operator-token' };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true,
    result: [{ success: true, results: [{ id: 1 }] }] }));
  const params = ["an operator's value"];
  await expect(queryReceiver('SELECT ? AS id', params, creds, fetchImpl)).resolves.toEqual([{ success: true, results: [{ id: 1 }] }]);
  const [endpoint, request] = fetchImpl.mock.calls[0];
  expect(endpoint).toBe('https://api.cloudflare.com/client/v4/accounts/4fcb63110aa75522b2636c923eeff468/d1/database/31dcc498-699d-42ff-a051-f10e1534d0b5/query');
  expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fake-operator-token' } });
  expect(JSON.parse(String(request?.body))).toEqual({ sql: 'SELECT ? AS id', params });
  fetchImpl.mockResolvedValueOnce(new Response('sensitive provider detail', { status: 401 }));
  await expect(queryReceiver('SELECT 1', [], creds, fetchImpl)).rejects.toThrow('D1 query failed');
});
