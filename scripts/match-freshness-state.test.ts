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
