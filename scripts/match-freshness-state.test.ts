import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubJSON, selectState } from './match-freshness-state.mjs';

const now = Date.parse('2026-10-04T12:00:00Z');
const run = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml', ref: 'refs/heads/main', id: 100, number: 10, attempt: 1, sha: 'a'.repeat(40) };
const root = '/repos/mcasillas17/ScoreArc/actions';
const workflowPath = `${root}/workflows/match-freshness.yml`;
function prior(number = 9) {
  return { id: 90 + number, run_number: number, run_attempt: 1, workflow_id: 7, path: run.workflow, head_branch: 'main', head_sha: 'a'.repeat(40), event: 'workflow_dispatch', status: 'completed', conclusion: 'failure', repository: { id: 1, full_name: run.repository }, head_repository: { id: 1, full_name: run.repository }, created_at: `2026-10-04T10:${String(number).padStart(2, '0')}:00Z`, updated_at: '2026-10-04T11:00:00Z' };
}
function artifact(source = prior(), name = 'match-freshness-state') {
  return { id: 400, name, expired: false, size_in_bytes: 1024, created_at: '2026-10-04T10:30:00Z', updated_at: '2026-10-04T10:30:00Z', expires_at: '2027-01-01T00:00:00Z', workflow_run: { id: source.id, repository_id: 1, head_repository_id: 1, head_branch: 'main', head_sha: source.head_sha } };
}
function api(runs = [prior()]) {
  const responses: Record<string, unknown> = {
    [workflowPath]: { id: 7, path: run.workflow, state: 'active' },
    [`${root}/runs/100`]: { ...prior(10), id: 100, status: 'in_progress', conclusion: null, created_at: '2026-10-04T11:30:00Z', updated_at: '2026-10-04T11:30:00Z' },
    [`${root}/workflows/7/runs?branch=main&per_page=20&page=1`]: { total_count: runs.length, workflow_runs: runs },
  };
  for (const source of runs) {
    responses[`${root}/runs/${source.id}/artifacts?per_page=10`] = { total_count: 1, artifacts: [artifact(source)] };
    responses[`${root}/runs/${source.id}/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: source.id, run_attempt: 1, status: 'completed', conclusion: 'failure', steps: [{ name: 'Prepare pending state', status: 'completed', conclusion: 'success' }, { name: 'Commit acknowledged checkpoint', status: 'completed', conclusion: 'skipped' }] }] };
  }
  const github = vi.fn(async (path: string) => {
    if (!(path in responses)) throw new Error(`Unexpected API path ${path}`);
    return structuredClone(responses[path]);
  });
  return { github, responses };
}
function noArtifacts(responses: Record<string, unknown>, source = prior()) {
  responses[`${root}/runs/${source.id}/artifacts?per_page=10`] = { total_count: 0, artifacts: [] };
}

describe('trusted state selection', () => {
  it('restores an explicitly reviewed final checkpoint without scanning newer history', async () => {
    const source = prior(8);
    const selected = { ...artifact(source), id: 402 };
    const { github, responses } = api([]);
    responses[`${root}/runs/${source.id}`] = source;
    responses[`${root}/runs/${source.id}/artifacts?per_page=10`] = { total_count: 1, artifacts: [selected] };
    expect(await selectState({ github, run, now, recovery: { runId: source.id, artifactId: selected.id } })).toEqual({
      run: { ...run, id: source.id, number: source.run_number },
      artifactId: selected.id,
      artifactName: 'match-freshness-state',
    });
    expect(github.mock.calls.some(([path]) => path.includes('/workflows/7/runs?'))).toBe(false);
  });
  it.each([
    [{ runId: 98 }, /recovery/i],
    [{ runId: 98, artifactId: 0 }, /recovery/i],
    [{ runId: 100, artifactId: 402 }, /prior|recovery/i],
  ])('rejects invalid explicit recovery input %j', async (recovery, message) => {
    const { github } = api([]);
    await expect(selectState({ github, run, now, recovery })).rejects.toThrow(message);
  });
  it.each([
    { name: 'match-freshness-pending' },
    { expired: true },
    { workflow_run: { ...artifact(prior(8)).workflow_run, id: 97 } },
  ])('rejects an invalid explicit recovery artifact %j', async (change) => {
    const source = prior(8);
    const selected = { ...artifact(source), id: 402, ...change };
    const { github, responses } = api([]);
    responses[`${root}/runs/${source.id}`] = source;
    responses[`${root}/runs/${source.id}/artifacts?per_page=10`] = { total_count: 1, artifacts: [selected] };
    await expect(selectState({ github, run, now, recovery: { runId: source.id, artifactId: 402 } })).rejects.toThrow(/artifact|checkpoint|recovery/i);
  });
  it('does not combine explicit recovery with initialization', async () => {
    const { github } = api([]);
    await expect(selectState({ github, run, now, initialize: true, recovery: { runId: 98, artifactId: 402 } })).rejects.toThrow(/initial|recovery/i);
  });
  it('accepts explicit recovery only from a dispatch run', async () => {
    const source = prior(8);
    const selected = { ...artifact(source), id: 402 };
    const { github, responses } = api([]);
    responses[`${root}/runs/100`] = { ...prior(10), id: 100, event: 'schedule', status: 'in_progress', conclusion: null,
      created_at: '2026-10-04T11:30:00Z', updated_at: '2026-10-04T11:30:00Z' };
    responses[`${root}/runs/${source.id}`] = source;
    responses[`${root}/runs/${source.id}/artifacts?per_page=10`] = { total_count: 1, artifacts: [selected] };
    await expect(selectState({ github, run, now, recovery: { runId: source.id, artifactId: selected.id } })).rejects.toThrow(/dispatch|recovery/i);
  });
  it('restores final state from the newest failed run and normalizes provenance', async () => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 2, artifacts: [artifact(prior(), 'match-freshness-pending'), { ...artifact(), id: 401 }] };
    expect(await selectState({ github, run, now })).toEqual({ run: { ...run, id: 99, number: 9 }, artifactId: 401, artifactName: 'match-freshness-state' });
  });
  it('restores pending when final upload never happened', async () => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 1, artifacts: [artifact(prior(), 'match-freshness-pending')] };
    expect((await selectState({ github, run, now }))?.artifactName).toBe('match-freshness-pending');
  });
  it.each(['success', 'neutral', null])('rejects missing final after acknowledged upload outcome %s', async (conclusion) => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 1, artifacts: [artifact(prior(), 'match-freshness-pending')] };
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, status: 'completed', steps: [{ name: 'Commit acknowledged checkpoint', status: 'completed', conclusion }] }] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/acknowledged|final/i);
  });
  it.each(['skipped', 'failure'])('restores pending only with proven unsuccessful final upload %s', async (conclusion) => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 1, artifacts: [artifact(prior(), 'match-freshness-pending')] };
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, status: 'completed', steps: [{ name: 'Commit acknowledged checkpoint', status: 'completed', conclusion }] }] };
    expect(await selectState({ github, run, now })).toEqual({ run: { ...run, id: 99, number: 9 }, artifactId: 400, artifactName: 'match-freshness-pending' });
  });
  it.each([
    { total_count: 0, jobs: [] },
    { total_count: 11, jobs: [] },
    { total_count: 1, jobs: [{ id: 1, run_id: 99, status: 'completed', steps: [] }] },
    { total_count: 1, jobs: [{ id: 1, run_id: 98, status: 'completed', steps: [{ name: 'Commit acknowledged checkpoint', status: 'completed', conclusion: 'failure' }] }] },
    { total_count: 1, jobs: [{ id: 1, run_id: 99, status: 'completed', steps: [{ name: 'Commit acknowledged checkpoint', status: 'completed', conclusion: 'failure' }, { name: 'Commit acknowledged checkpoint', status: 'completed', conclusion: 'skipped' }] }] },
  ])('rejects pending fallback with ambiguous or untrusted job history %j', async (jobs) => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 1, artifacts: [artifact(prior(), 'match-freshness-pending')] };
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = jobs;
    await expect(selectState({ github, run, now })).rejects.toThrow();
  });
  // An empty job list is allowed only to prove a cancelled run never started; a cancelled run
  // that left a pending checkpoint still needs its commit step to prove the final upload status.
  it('rejects pending fallback for a cancelled run with no jobs', async () => {
    const { github, responses } = api([{ ...prior(), conclusion: 'cancelled' }]);
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 1, artifacts: [artifact(prior(), 'match-freshness-pending')] };
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 0, jobs: [] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/final checkpoint/i);
  });
  it('rejects final state created before the pending checkpoint', async () => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 2, artifacts: [{ ...artifact(prior(), 'match-freshness-pending'), created_at: '2026-10-04T10:45:00Z', updated_at: '2026-10-04T10:45:00Z' }, { ...artifact(), id: 401 }] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/order|chronolog/i);
  });
  it.each([
    { repository: { id: 1, full_name: 'attacker/fork' } }, { head_repository: { id: 2, full_name: run.repository } },
    { path: '.github/workflows/other.yml' }, { workflow_id: 8 }, { head_branch: 'feature' }, { event: 'pull_request' },
    { head_sha: 'bad' }, { run_attempt: 2 }, { run_number: 11 }, { status: 'in_progress' },
    { created_at: '2026-10-04T11:45:00Z' }, { updated_at: '2026-10-04T13:00:00Z' },
  ])('rejects untrusted or future prior metadata %j', async (change) => {
    const { github } = api([{ ...prior(), ...change }]);
    await expect(selectState({ github, run, now })).rejects.toThrow();
  });
  it('accepts a completed predecessor when the current run was queued before its completion', async () => {
    const { github, responses } = api();
    responses[`${root}/runs/100`] = { ...prior(10), id: 100, status: 'in_progress', created_at: '2026-10-04T10:10:00Z', updated_at: '2026-10-04T11:30:00Z' };
    expect((await selectState({ github, run, now }))?.run.id).toBe(99);
  });
  it('accepts the current run in GitHub listings without restoring it', async () => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 2, workflow_runs: [responses[`${root}/runs/100`], prior()] };
    expect((await selectState({ github, run, now }))?.run.id).toBe(99);
  });
  it('does not initialize if GitHub listing fails', async () => {
    await expect(selectState({ github: async () => { throw new Error('unavailable'); }, run, initialize: true, now })).rejects.toThrow('unavailable');
  });
  it('fails when the final checkpoint expired even if pending remains available', async () => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 2, artifacts: [{ ...artifact(), expired: true }, { ...artifact(prior(), 'match-freshness-pending'), id: 401 }] };
    await expect(selectState({ github, run, now })).rejects.toThrow();
  });
  it('rejects initialization when durable state already exists', async () => {
    const { github } = api();
    await expect(selectState({ github, run, initialize: true, now })).rejects.toThrow(/initializ/i);
  });
  // GitHub lists a job skipped by its `if` as completed/skipped with no steps (this repo's CI
  // push run 42461773808, job migration-notice); a wholly skipped run could also list no jobs.
  it.each([
    { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'skipped', steps: [] }] },
    { total_count: 0, jobs: [] },
  ])('skips a disabled (skipped) run and preserves earlier state: %j', async (jobs) => {
    const { github, responses } = api([{ ...prior(), conclusion: 'skipped' }, prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = jobs;
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  it('permits explicit initialization after proven disabled runs', async () => {
    const { github, responses } = api(); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'skipped', steps: [] }] };
    expect(await selectState({ github, run, initialize: true, now })).toBeNull();
  });
  it.each(['@main', '@refs/heads/main'])('normalizes GitHub workflow paths qualified by the main ref %s', async (suffix) => {
    const { github } = api([{ ...prior(), path: run.workflow + suffix }]);
    expect((await selectState({ github, run, now }))?.run.workflow).toBe('.github/workflows/match-freshness.yml');
  });
  it('accepts attempt-specific job metadata without the optional run_attempt field', async () => {
    const { github, responses } = api(); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, status: 'completed', conclusion: 'skipped', steps: [] }] };
    expect(await selectState({ github, run, initialize: true, now })).toBeNull();
  });
  it('rejects reruns before API access', async () => {
    const { github } = api();
    await expect(selectState({ github, run: { ...run, attempt: 2 }, now })).rejects.toThrow();
    expect(github).not.toHaveBeenCalled();
  });
  it('rejects mismatched workflow lookup and current SHA', async () => {
    const first = api(); first.responses[workflowPath] = { id: 7, path: 'other' };
    await expect(selectState({ github: first.github, run, now })).rejects.toThrow();
    const second = api(); second.responses[`${root}/runs/100`] = { ...prior(10), id: 100, head_sha: 'b'.repeat(40) };
    await expect(selectState({ github: second.github, run, now })).rejects.toThrow();
  });
  it.each([
    { expired: true }, { expires_at: '2026-10-01T00:00:00Z' }, { size_in_bytes: 262145 }, { id: -1 },
    { workflow_run: { ...artifact().workflow_run, id: 98 } }, { workflow_run: { ...artifact().workflow_run, repository_id: 2 } },
    { workflow_run: { ...artifact().workflow_run, head_sha: 'b'.repeat(40) } }, { created_at: '2026-10-03T00:00:00Z' },
  ])('does not roll back past an invalid newest artifact %j', async (change) => {
    const { github, responses } = api([prior(), prior(8)]);
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 1, artifacts: [{ ...artifact(), ...change }] };
    await expect(selectState({ github, run, now })).rejects.toThrow();
    expect(github.mock.calls.some(([path]) => path.includes('/runs/98/'))).toBe(false);
  });
  it('rejects duplicate final artifacts', async () => {
    const { github, responses } = api();
    responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 2, artifacts: [artifact(), { ...artifact(), id: 401 }] };
    await expect(selectState({ github, run, now })).rejects.toThrow();
  });
  it('treats preparation without upload as a barrier even during explicit initialization', async () => {
    const { github, responses } = api([prior(), prior(8)]); noArtifacts(responses);
    await expect(selectState({ github, run, initialize: true, now })).rejects.toThrow(/checkpoint|prepar/i);
  });
  it('skips only preparation proven skipped and preserves earlier state', async () => {
    const { github, responses } = api([prior(), prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'failure', steps: [{ name: 'Prepare pending state', status: 'completed', conclusion: 'skipped' }] }] };
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  // The concurrency group cancels a waiting run when a newer one queues. On GitHub such a run is
  // conclusion 'cancelled' with no jobs (seen on this repo's deploy runs, 2026-08-31), or with
  // jobs that never ran a step. It never prepared state, so it must not block selection.
  it.each([
    ['no jobs', { total_count: 0, jobs: [] }],
    ['jobs without steps', { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'cancelled', steps: [] }] }],
  ])('skips a run cancelled before it started (%s) and preserves earlier state', async (_label, jobs) => {
    const { github, responses } = api([{ ...prior(), conclusion: 'cancelled' }, prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = jobs;
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  it('skips a startup failure with no jobs and preserves earlier state', async () => {
    const { github, responses } = api([{ ...prior(), conclusion: 'startup_failure' }, prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 0, jobs: [] };
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  it.each([
    [{ name: 'Run actions/checkout', status: 'completed', conclusion: 'success' }],
    [{ name: 'Prepare pending state', status: 'completed', conclusion: 'cancelled' }],
    [{ name: 'Prepare pending state', status: 'completed', conclusion: 'success' }],
    [{ name: 'Prepare pending state', status: 'completed', conclusion: 'failure' }],
  ])('keeps a cancelled run that started as a barrier: %j', async (step) => {
    const { github, responses } = api([{ ...prior(), conclusion: 'cancelled' }, prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'cancelled', steps: [step] }] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/checkpoint|prepar/i);
  });
  // Runs start every five minutes (the receiver's dispatch, or a manual one), so a newer
  // run can already be listed while this one selects. The concurrency group keeps it
  // waiting, or cancels it before it starts, so it cannot hold state.
  const newer = (change: object) => ({ ...prior(10), id: 101, run_number: 11, created_at: '2026-10-04T11:35:00Z', updated_at: '2026-10-04T11:35:00Z', ...change });
  it.each([
    { status: 'queued', conclusion: null }, { status: 'pending', conclusion: null }, { status: 'waiting', conclusion: null },
    { status: 'completed', conclusion: 'cancelled' }, { status: 'completed', conclusion: 'startup_failure' },
  ])('passes over a newer run that never started (%j)', async (change) => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 3, workflow_runs: [newer(change), responses[`${root}/runs/100`], prior()] };
    if (change.status === 'completed') responses[`${root}/runs/101/attempts/1/jobs?per_page=10`] = { total_count: 0, jobs: [] };
    expect((await selectState({ github, run, now }))?.run.id).toBe(99);
    expect(github).not.toHaveBeenCalledWith(`${root}/runs/101/artifacts?per_page=10`);
    // A cancelled newer run is proven never started from its jobs, not assumed.
    if (change.status === 'completed') expect(github).toHaveBeenCalledWith(`${root}/runs/101/attempts/1/jobs?per_page=10`);
  });
  it('passes over a newer cancelled run whose job lists only runner bookkeeping', async () => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 3, workflow_runs: [newer({ status: 'completed', conclusion: 'cancelled' }), responses[`${root}/runs/100`], prior()] };
    responses[`${root}/runs/101/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 2, run_id: 101, run_attempt: 1, status: 'completed', conclusion: 'cancelled', steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Complete job', status: 'completed', conclusion: 'success' }] }] };
    expect((await selectState({ github, run, now }))?.run.id).toBe(99);
  });
  it('rejects a newer cancelled run whose job ran a step', async () => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 3, workflow_runs: [newer({ status: 'completed', conclusion: 'cancelled' }), responses[`${root}/runs/100`], prior()] };
    responses[`${root}/runs/101/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 2, run_id: 101, run_attempt: 1, status: 'completed', conclusion: 'cancelled', steps: [{ name: 'Prepare pending state', status: 'completed', conclusion: 'success' }] }] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/started|nonmonotonic|prepar/i);
  });
  // The empty step list is the proof, whatever the conclusion: a hosted job that never
  // acquired a runner ends as a failure with no steps.
  it.each([
    [[{ name: 'Set up job', status: 'completed', conclusion: 'failure' }]],
    [[{ name: 'Set up job', status: 'completed', conclusion: 'failure' }, { name: 'Complete job', status: 'completed', conclusion: 'success' }]],
  ])('skips a job that failed in GitHub setup before any workflow step: %j', async (steps) => {
    const { github, responses } = api([prior(), prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'failure', steps }] };
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  // GitHub's recorded shape for a job cancelled or timed out mid-run (seen on this repo's CI run
  // 40282541137): the running step is 'cancelled' and every later step 'skipped'.
  it('skips a run cancelled during select, whose Prepare is recorded as skipped', async () => {
    const { github, responses } = api([{ ...prior(), conclusion: 'cancelled' }, prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'cancelled', steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success' },
      { name: 'Select newest trusted checkpoint, including failed runs', status: 'completed', conclusion: 'cancelled' },
      { name: 'Restore selected checkpoint', status: 'completed', conclusion: 'skipped' },
      { name: 'Prepare pending state', status: 'completed', conclusion: 'skipped' },
    ] }] };
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  it('still blocks a failed job that ran a workflow step without preparing', async () => {
    const { github, responses } = api([prior(), prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'failure', steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run actions/checkout', status: 'completed', conclusion: 'failure' }] }] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/checkpoint|prepar/i);
  });
  it('skips a failed job that never ran a step and preserves earlier state', async () => {
    const { github, responses } = api([prior(), prior(8)]); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: 1, run_id: 99, run_attempt: 1, status: 'completed', conclusion: 'failure', steps: [] }] };
    expect((await selectState({ github, run, now }))?.run.number).toBe(8);
  });
  // The usual listing while a run is active: N+2 waiting, N+1 cancelled by it, N current.
  it('passes over a waiting and a cancelled newer run together', async () => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 4, workflow_runs: [newer({ id: 102, run_number: 12, status: 'queued', conclusion: null, created_at: '2026-10-04T11:40:00Z', updated_at: '2026-10-04T11:40:00Z' }), newer({ status: 'completed', conclusion: 'cancelled' }), responses[`${root}/runs/100`], prior()] };
    responses[`${root}/runs/101/attempts/1/jobs?per_page=10`] = { total_count: 0, jobs: [] };
    expect((await selectState({ github, run, now }))?.run.id).toBe(99);
  });
  it.each([
    [{ id: 101, run_number: 12 }, 'repeated id'], [{ id: 102, run_number: 11 }, 'repeated run number'],
  ])('rejects newer runs that are not strictly ordered (%j, %s)', async (first) => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 4, workflow_runs: [newer({ ...first, status: 'queued', conclusion: null }), newer({ status: 'queued', conclusion: null }), responses[`${root}/runs/100`], prior()] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/nonmonotonic/i);
  });
  it.each([
    { run_attempt: 2 }, { event: 'pull_request' }, { head_branch: 'feature' }, { workflow_id: 8 },
    { repository: { id: 2, full_name: 'attacker/fork' } }, { head_sha: 'bad' },
  ])('rejects a newer run with untrusted provenance %j', async (change) => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 3, workflow_runs: [newer({ status: 'queued', conclusion: null, ...change }), responses[`${root}/runs/100`], prior()] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/provenance/i);
  });
  it('passes over a newer run queued after this process read the clock', async () => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 3, workflow_runs: [newer({ status: 'queued', conclusion: null, created_at: '2026-10-04T12:01:00Z', updated_at: '2026-10-04T12:01:00Z' }), responses[`${root}/runs/100`], prior()] };
    expect((await selectState({ github, run, now }))?.run.id).toBe(99);
  });
  it.each([
    { status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' },
    { status: 'queued', conclusion: null, id: 98 }, { status: 'queued', conclusion: null, created_at: '2026-10-04T11:00:00Z' },
  ])('rejects a newer run that could have run or is out of order (%j)', async (change) => {
    const { github, responses } = api();
    responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=1`] = { total_count: 3, workflow_runs: [newer(change), responses[`${root}/runs/100`], prior()] };
    await expect(selectState({ github, run, now })).rejects.toThrow(/nonmonotonic/i);
  });
  it('does not interpret unknown or unavailable job history as initialization', async () => {
    const { github, responses } = api(); noArtifacts(responses);
    responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 0, jobs: [] };
    await expect(selectState({ github, run, initialize: true, now })).rejects.toThrow();
  });
  it('requires explicit initialization after complete empty enumeration', async () => {
    const { github } = api([]);
    await expect(selectState({ github, run, now })).rejects.toThrow();
    expect(await selectState({ github, run, initialize: true, now })).toBeNull();
  });
  it('rejects truncated artifact and job lists', async () => {
    const first = api(); first.responses[`${root}/runs/99/artifacts?per_page=10`] = { total_count: 11, artifacts: [artifact()] };
    await expect(selectState({ github: first.github, run, now })).rejects.toThrow();
    const second = api(); noArtifacts(second.responses); second.responses[`${root}/runs/99/attempts/1/jobs?per_page=10`] = { total_count: 11, jobs: [] };
    await expect(selectState({ github: second.github, run, now })).rejects.toThrow();
  });
  it('rejects nonmonotonic run listing before selecting state', async () => {
    const { github } = api([prior(8), prior(9)]);
    await expect(selectState({ github, run, now })).rejects.toThrow();
  });
  it('fails closed at the three-page budget instead of initializing', async () => {
    const { github, responses } = api([]);
    for (let page = 1; page <= 3; page++) {
      const runs = Array.from({ length: 20 }, (_, i) => ({ ...prior(), id: 999 - (page - 1) * 20 - i, run_number: 99 - (page - 1) * 20 - i }));
      responses[`${root}/workflows/7/runs?branch=main&per_page=20&page=${page}`] = { total_count: 61, workflow_runs: runs };
      for (const source of runs) {
        noArtifacts(responses, source);
        responses[`${root}/runs/${source.id}/attempts/1/jobs?per_page=10`] = { total_count: 1, jobs: [{ id: source.id, run_id: source.id, run_attempt: 1, status: 'completed', conclusion: 'skipped', steps: [] }] };
      }
    }
    responses[`${root}/runs/1000`] = { ...prior(), id: 1000, run_number: 100, created_at: '2026-10-04T11:30:00Z', updated_at: '2026-10-04T11:30:00Z' };
    await expect(selectState({ github, run: { ...run, id: 1000, number: 100 }, initialize: true, now })).rejects.toThrow(/bound|budget|history/i);
    expect(github.mock.calls.filter(([path]) => path.includes('/workflows/7/runs'))).toHaveLength(3);
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded GitHub JSON transport', () => {
  it('uses only fixed GitHub origin and rejects redirects', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetch);
    expect(await githubJSON('secret')('/repos/mcasillas17/ScoreArc/actions/workflows/match-freshness.yml')).toEqual({ ok: true });
    expect(fetch.mock.calls[0]).toEqual(['https://api.github.com/repos/mcasillas17/ScoreArc/actions/workflows/match-freshness.yml', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer secret' }) })]);
    await expect(githubJSON('secret')('//attacker.example/path')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized bodies even without content-length', async () => {
    vi.stubGlobal('fetch', async () => new Response(' '.repeat(1024 * 1024 + 1)));
    await expect(githubJSON('secret')('/test')).rejects.toThrow(/size|large|limit/i);
  });
  it('bounds an indefinitely stalled body independently of fetch abort support', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start() {} })));
    const outcome = githubJSON('secret')('/test').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10001);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/time|deadline/i) }));
  });
  it('does not expose token or upstream body on failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('secret upstream detail', { status: 500 }));
    await expect(githubJSON('secret')('/test')).rejects.toThrow(/^GitHub API request failed/);
  });
});
