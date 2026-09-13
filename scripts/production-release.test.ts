import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changedPaths, deployedBase, deploymentRequest, githubClient, paginate, validateVercel, confirmVercelPublication, promoteVercelPublication } from './production-release.mjs';
import { previewBuildRequired } from './production-preview.mjs';

const sha = 'a'.repeat(40);
const actionsCreator = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const release = {
  id: 10, sha, task: 'scorearc-release', environment: 'production-reader',
  payload: { version: 1, service: 'reader' }, performed_via_github_app: { id: 15368 },
  creator: actionsCreator,
};

describe('actual deployment ledger', () => {
  it('uses only the newest managed actual success, not an environment job success', async () => {
    const api = vi.fn(async (path: string) => path.includes('/statuses')
      ? [{ state: 'success', creator: actionsCreator }] : [release]);
    expect(await deployedBase(api, 'reader')).toBe(sha);
    expect(api.mock.calls[0][0]).toContain('task=scorearc-release');
    expect(api.mock.calls[0][0]).toContain('environment=production-reader');
  });
  it.each(['failure', 'pending', 'in_progress', 'error'])('blocks after %s (remote effects may still be running)', async state => {
    const api = vi.fn(async (path: string) => path.includes('/statuses') ? [{ state }] : [release]);
    await expect(deployedBase(api, 'reader')).rejects.toThrow('reconcile');
  });
  it('permits recovery only after explicit operator acknowledgement, still requiring full CI', async () => {
    const api = vi.fn(async (path: string) => path.includes('/statuses') ? [{ state: 'inactive' }] : [release]);
    expect(await deployedBase(api, 'reader')).toBeNull();
  });
  it('bounds ledger reads and does not require a nonexistent legacy test commit status', async () => {
    const api = vi.fn(async (path: string) => path.includes('/statuses') ? [{ state: 'success', creator: actionsCreator }] : [release]);
    await deployedBase(api, 'reader');
    expect(api.mock.calls[0][0]).toContain('per_page=1');
    expect(deploymentRequest('reader', sha, 42, 1)).toMatchObject({
      ref: sha, auto_merge: false, required_contexts: [],
      payload: { runId: 42, runAttempt: 1 },
    });
  });
  it('bootstraps only when the ledger is genuinely empty', async () => {
    expect(await deployedBase(vi.fn(async () => []), 'reader')).toBeNull();
    await expect(deployedBase(vi.fn(async () => { throw new Error('HTTP 403'); }), 'reader')).rejects.toThrow('403');
  });
  it('rejects malformed ledger identities and statuses', async () => {
    await expect(deployedBase(vi.fn(async () => [{ ...release, performed_via_github_app: null, creator: null }]), 'reader')).rejects.toThrow();
    const api = vi.fn(async (path: string) => path.includes('/statuses') ? {} : [release]);
    await expect(deployedBase(api, 'reader')).rejects.toThrow();
  });
  it('paginates rather than silently dropping releases/jobs beyond the first page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const api = vi.fn(async (path: string) => ({ jobs: path.endsWith('page=1') ? firstPage : [{ id: 100 }] }));
    expect(await paginate(api, 'actions/runs/42/attempts/1/jobs', 'jobs')).toHaveLength(101);
  });
  it('never turns an API failure into an empty release history', async () => {
    const api = githubClient('test-token', vi.fn(async () => new Response('{}', { status: 403 })));
    await expect(api('deployments')).rejects.toThrow('HTTP 403');
    expect(() => githubClient('')).toThrow('GH_TOKEN');
  });
  it.each([null, undefined])('recognizes real Actions deployment records with %s optional app metadata', async app => {
    const api = vi.fn(async (path: string) => path.includes('/statuses')
      ? [{ state: 'success', creator: actionsCreator }]
      : [{ ...release, performed_via_github_app: app }]);
    await expect(deployedBase(api, 'reader')).resolves.toBe(sha);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it.each([
    null, { ...actionsCreator, id: 1 }, { ...actionsCreator, login: 'other-bot' },
    { ...actionsCreator, type: 'User' },
  ])('rejects a non-Actions ledger creator even if the app ID is supplied: %j', async creator => {
    const api = vi.fn(async (path: string) => path.includes('/statuses')
      ? [{ state: 'success', creator: actionsCreator }] : [{ ...release, creator }]);
    await expect(deployedBase(api, 'reader')).rejects.toThrow('Unrecognized');
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('rejects conflicting app identity rather than ignoring it', async () => {
    const api = vi.fn(async () => [{ ...release, performed_via_github_app: { id: 1 } }]);
    await expect(deployedBase(api, 'reader')).rejects.toThrow('Unrecognized');
  });
  it('never accepts a manually authored success as provider publication proof', async () => {
    const api = vi.fn(async (path: string) => path.includes('/statuses')
      ? [{ state: 'success', creator: { id: 1, login: 'operator', type: 'User' } }] : [release]);
    await expect(deployedBase(api, 'reader')).rejects.toThrow('Unrecognized');
  });
  it('retains unresolved and operator-inactive semantics for real Actions records', async () => {
    for (const state of ['failure', 'pending', 'in_progress', 'error']) {
      const api = vi.fn(async (path: string) => path.includes('/statuses') ? [{ state, creator: actionsCreator }]
        : [{ ...release, performed_via_github_app: null }]);
      await expect(deployedBase(api, 'reader')).rejects.toThrow('unresolved');
    }
    const api = vi.fn(async (path: string) => path.includes('/statuses')
      ? [{ state: 'inactive', creator: { id: 1, login: 'operator', type: 'User' } }]
      : [{ ...release, performed_via_github_app: null }]);
    await expect(deployedBase(api, 'reader')).resolves.toBeNull();
  });
});

describe('immutable git range', () => {
  let directory: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it('covers multi-commit pushes, deletions and both sides of a rename', () => {
    directory = mkdtempSync(join(tmpdir(), 'scorearc-release-test-'));
    vi.stubEnv('GIT_DIR', join(directory, '.git'));
    vi.stubEnv('GIT_WORK_TREE', directory);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Release test');
    mkdirSync(join(directory, 'backend/reader'), { recursive: true });
    writeFileSync(join(directory, 'backend/reader/old.go'), 'before');
    git('add', '.'); git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(directory, 'backend/ingester'), { recursive: true });
    renameSync(join(directory, 'backend/reader/old.go'), join(directory, 'backend/ingester/new.go'));
    git('add', '.'); git('commit', '--quiet', '-m', 'service change');
    writeFileSync(join(directory, 'README.md'), 'docs-only tip');
    git('add', '.'); git('commit', '--quiet', '-m', 'docs');
    const tip = git('rev-parse', 'HEAD');
    expect(changedPaths(base, tip).sort()).toEqual(['README.md', 'backend/ingester/new.go', 'backend/reader/old.go']);
    expect(() => changedPaths(tip, base)).toThrow();
    expect(() => changedPaths('main', tip)).toThrow();
  });
});

describe('credential and Vercel boundaries', () => {
  const env = {
    VERCEL_TOKEN: 'test', VERCEL_PROJECT_ID: 'prj_test', VERCEL_ORG_ID: 'team_test',
    GITHUB_SHA: sha, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
  };
  it('fails before network access if deployment credentials are missing', async () => {
    const fetcher = vi.fn();
    await expect(validateVercel({}, fetcher)).rejects.toThrow('no deployment occurred');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed on inaccessible Vercel settings', async () => {
    await expect(validateVercel({
      VERCEL_TOKEN: 'test', VERCEL_PROJECT_ID: 'prj_test', VERCEL_ORG_ID: 'team_test',
    }, vi.fn(async () => new Response('{}', { status: 403 })))).rejects.toThrow('HTTP 403');
  });
  it('confirms exact staged deployment and actual production domain after promotion', async () => {
    const deployment = {
      id: 'dpl_test', projectId: 'prj_test', readyState: 'READY', target: 'production',
      aliasAssigned: true, aliasError: null, meta: { scorearcCommitSha: sha, scorearcRunId: '42', scorearcRunAttempt: '1' },
    };
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/aliases/')
        ? { deploymentId: 'dpl_test', projectId: 'prj_test' } : deployment,
    )));
    await expect(confirmVercelPublication(env, 'https://test.vercel.app', fetcher)).resolves.toBeUndefined();
    for (const change of [{ aliasAssigned: false }, { readyState: 'QUEUED' }, { meta: { scorearcCommitSha: 'b'.repeat(40) } }]) {
      await expect(confirmVercelPublication(env, 'https://test.vercel.app',
        vi.fn(async () => new Response(JSON.stringify({ ...deployment, ...change }))), async () => {})).rejects.toThrow();
    }
  });
  it('does not label another deployment on the production domain a success', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/aliases/') ? { deploymentId: 'dpl_other', projectId: 'prj_test' } : {
        id: 'dpl_test', projectId: 'prj_test', readyState: 'READY', target: 'production',
        aliasAssigned: true, aliasError: null, meta: { scorearcCommitSha: sha, scorearcRunId: '42', scorearcRunAttempt: '1' },
      },
    )));
    await expect(confirmVercelPublication(env, 'https://test.vercel.app', fetcher, async () => {})).rejects.toThrow();
  });
  it('allows bounded alias propagation without releasing the service lock', async () => {
    let attempts = 0;
    const pause = vi.fn(async () => {});
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/aliases/')) return new Response(JSON.stringify({ deploymentId: 'dpl_test', projectId: 'prj_test' }));
      attempts++;
      return new Response(JSON.stringify({
        id: 'dpl_test', projectId: 'prj_test', readyState: 'READY', target: 'production',
        aliasAssigned: attempts === 3, aliasError: null, meta: { scorearcCommitSha: sha, scorearcRunId: '42', scorearcRunAttempt: '1' },
      }));
    });
    await expect(confirmVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).resolves.toBeUndefined();
    expect(pause).toHaveBeenCalledTimes(2);
  });
});

describe('project-scoped Vercel promotion', () => {
  const env = {
    VERCEL_TOKEN: 'synthetic-project-token', VERCEL_PROJECT_ID: 'prj_test', VERCEL_ORG_ID: 'team_test',
    GITHUB_SHA: sha, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
  };
  const project = { id: 'prj_test', accountId: 'team_test', autoAssignCustomDomains: false };
  const deployment = {
    id: 'dpl_test', projectId: 'prj_test', readyState: 'READY', target: 'production',
    aliasAssigned: true, aliasError: null,
    meta: { scorearcCommitSha: sha, scorearcRunId: '42', scorearcRunAttempt: '1' },
  };
  const job = { type: 'promote', toDeploymentId: 'dpl_test', requestedAt: 100, jobStatus: 'succeeded' };
  const pause = async () => {};
  function provider({
    status = 201, candidate = deployment, settings = project, jobs = [job],
    alias = { projectId: 'prj_test', deploymentId: 'dpl_test' },
  }: {
    status?: number; candidate?: Record<string, unknown>; settings?: typeof project;
    jobs?: typeof job[]; alias?: { projectId: string; deploymentId: string };
  } = {}) {
    let posted = false;
    let polls = 0;
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.vercel.com' || /\/(user|teams)(\/|$)/.test(url.pathname)) {
        return new Response('{}', { status: 403 });
      }
      if (init?.method === 'POST') {
        posted = true;
        return new Response(null, { status, headers: { Location: 'https://untrusted.invalid/do-not-follow' } });
      }
      if (url.pathname === '/v9/projects/prj_test') return Response.json({
        ...settings,
        lastAliasRequest: posted && url.searchParams.get('rollbackInfo') === 'true'
          ? jobs[Math.min(polls++, jobs.length - 1)] : null,
      });
      if (url.pathname === '/v13/deployments/test.vercel.app' || url.pathname === '/v13/deployments/dpl_test') {
        return Response.json(candidate);
      }
      if (url.pathname === '/v4/aliases/www.scorearc.futbol') return Response.json(alias);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
  }
  it.each([201, 202])('confirms exact production publication after bodyless HTTP %s without account lookups', async status => {
    const fetcher = provider({ status, jobs: [
      { ...job, toDeploymentId: 'dpl_previous' },
      { ...job, jobStatus: 'pending' }, { ...job, jobStatus: 'in-progress' }, job,
    ] });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app\n', fetcher, pause)).resolves.toBeUndefined();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toBe('https://api.vercel.com/v10/projects/prj_test/promote/dpl_test?teamId=team_test');
    expect(posts[0][1]?.body).toBe('{}');
    for (const [input, init] of fetcher.mock.calls) {
      expect(new URL(String(input)).origin).toBe('https://api.vercel.com');
      expect(String(input)).not.toMatch(/\/user|\/teams|synthetic-project-token/);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-project-token' });
    }
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/v4/aliases/www.scorearc.futbol'))).toBe(true);
  });
  it('requests promotion metadata on preflight and every poll while retaining team scope', async () => {
    const fetcher = provider({ jobs: [{ ...job, jobStatus: 'in-progress' }, job] });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).resolves.toBeUndefined();
    const projectReads = fetcher.mock.calls.map(([input]) => new URL(String(input)))
      .filter(url => url.pathname === '/v9/projects/prj_test');
    expect(projectReads).toHaveLength(3);
    for (const url of projectReads) {
      expect(url.searchParams.getAll('rollbackInfo')).toEqual(['true']);
      expect(url.searchParams.getAll('teamId')).toEqual(['team_test']);
    }
  });
  it.each([
    { projectId: 'prj_other' }, { id: '../../user' }, { id: 'https://untrusted.invalid/' },
    { readyState: 'BUILDING' }, { readyState: 'ERROR' }, { target: 'preview' },
    { aliasError: { message: 'synthetic-project-token' } },
    { meta: { ...deployment.meta, scorearcCommitSha: 'b'.repeat(40) } },
    { meta: { ...deployment.meta, scorearcRunId: '43' } },
    { meta: { ...deployment.meta, scorearcRunAttempt: '2' } },
  ])('rejects mismatched/unready staged deployment before mutation: %j', async change => {
    const fetcher = provider({ candidate: { ...deployment, ...change } });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each(['http://test.vercel.app', 'https://test.vercel.app.attacker.invalid', 'https://user@test.vercel.app',
    'https://test.vercel.app/path', 'https://test.vercel.app?x=1', 'https://test.vercel.app/#x',
    'https://test.vercel.app:443', 'https://test.vercel.app\\@attacker.invalid', 'https://test.vercel.app\nhttps://other.vercel.app',
  ])('rejects invalid staged URL without network access: %s', async url => {
    const fetcher = provider();
    await expect(promoteVercelPublication(env, url, fetcher, pause)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { VERCEL_TOKEN: '' }, { VERCEL_PROJECT_ID: '../user' }, { VERCEL_ORG_ID: 'team_test?redirect=evil' },
    { VERCEL_TOKEN: 'synthetic\nproject-token' }, { VERCEL_TOKEN: 'synthetic\u0100project-token' },
    { GITHUB_SHA: 'main' }, { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '0' },
  ])('rejects malformed environment identifiers before requests: %j', async change => {
    const fetcher = provider();
    await expect(promoteVercelPublication({ ...env, ...change }, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rechecks matching project ownership and disabled automatic assignment before promotion', async () => {
    const fetcher = provider({ settings: { ...project, autoAssignCustomDomains: true } });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each(['failed', 'skipped', 'unexpected'])('fails explicitly for %s promotion jobs', async jobStatus => {
    const fetcher = provider({ jobs: [{ ...job, jobStatus }] });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow(/promotion/i);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it.each([200, 204, 301, 400, 401, 403, 404, 409, 410, 422, 429, 500])('does not retry or accept promotion HTTP %s', async status => {
    const fetcher = provider({ status });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('does not retry a POST whose response timed out after possible acceptance', async () => {
    const base = provider();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw new DOMException('Request timed out', 'TimeoutError');
      return base(input, init);
    });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it.each([
    { ...job, jobStatus: 'pending' }, { ...job, jobStatus: 'in-progress' },
    { ...job, toDeploymentId: 'dpl_other' }, { ...job, type: 'rollback' },
  ])('bounds polling without resubmitting a queued/unrelated promotion: %j', async pending => {
    const fetcher = provider({ status: 202, jobs: [pending] });
    const wait = vi.fn(pause);
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, wait)).rejects.toThrow(/timed out|deadline/i);
    expect(wait.mock.calls.length).toBeLessThanOrEqual(120);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('requires a new promotion record, not a previous successful job for the same deployment', async () => {
    const base = provider();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/v9/projects/prj_test') return Response.json({ ...project, lastAliasRequest: job });
      return base(input, init);
    });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow(/timed out|deadline/i);
  });
  it('does not overwrite an already pending project publication', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...project, lastAliasRequest: { ...job, jobStatus: 'pending' } }));
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow(/pending|unresolved/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not confuse successful job completion with the production domain moving', async () => {
    const fetcher = provider({ alias: { projectId: 'prj_test', deploymentId: 'dpl_other' } });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow(/domain/i);
  });
  it('pins confirmation to the resolved immutable deployment ID', async () => {
    const base = provider();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/v13/deployments/dpl_test') return Response.json({ ...deployment, id: 'dpl_other' });
      return base(input, init);
    });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow();
  });
  it('surfaces polling API errors without echoing provider error bodies', async () => {
    const base = provider();
    let projectReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/v9/projects/prj_test' && ++projectReads > 1) {
        return new Response('synthetic-project-token', { status: 403 });
      }
      return base(input, init);
    });
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).rejects.toThrow('HTTP 403');
  });
  it('applies the ten-minute deadline to requests as well as polling waits', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms =>
      ms === 600_000 ? deadline.signal : new AbortController().signal);
    const fetcher = provider({ jobs: [{ ...job, jobStatus: 'pending' }] });
    try {
      await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, async () => {
        deadline.abort(new DOMException('Promotion deadline exceeded', 'TimeoutError'));
      })).rejects.toThrow('deadline');
      expect(timeout).toHaveBeenCalledWith(600_000);
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally {
      timeout.mockRestore();
    }
  });
  it('rejects malformed metadata without logging the response body', async () => {
    const fetcher = vi.fn(async () => new Response('synthetic-project-token'));
    await expect(promoteVercelPublication(env, 'https://test.vercel.app', fetcher, pause))
      .rejects.toThrowError(new Error('Vercel metadata is not valid JSON; release remains unresolved'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('preview-only ignored build', () => {
  it('uses immutable last-success and candidate SHAs', () => {
    const diff = vi.fn(() => ['README.md', 'backend/reader/main.go']);
    expect(previewBuildRequired({
      VERCEL_GIT_PREVIOUS_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: sha,
    }, diff)).toBe(false);
    expect(diff).toHaveBeenCalledWith('b'.repeat(40), sha);
  });
  it('builds changed frontend and the bootstrap preview rather than claiming a skip', () => {
    expect(previewBuildRequired({}, vi.fn())).toBe(true);
    expect(previewBuildRequired({
      VERCEL_GIT_PREVIOUS_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: sha,
    }, () => ['src/app/page.tsx'])).toBe(true);
  });
  it('never skips the staged production upload', () => {
    expect(previewBuildRequired({
      VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: sha, VERCEL_GIT_COMMIT_SHA: sha,
    }, () => [])).toBe(true);
  });
  it('builds conservatively with a clear diagnostic when the preview clone lacks its base', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(previewBuildRequired({
        VERCEL_GIT_PREVIOUS_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: sha,
      }, () => { throw Object.assign(new Error('git missing base'), { status: 128 }); })).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cannot prove unchanged'));
    } finally {
      warning.mockRestore();
    }
  });
});
