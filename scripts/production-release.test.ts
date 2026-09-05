import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changedPaths, deployedBase, deploymentRequest, githubClient, paginate, validateVercel, confirmVercelPublication } from './production-release.mjs';
import { previewBuildRequired } from './production-preview.mjs';

const sha = 'a'.repeat(40);
const release = {
  id: 10, sha, task: 'scorearc-release', environment: 'production-reader',
  payload: { version: 1, service: 'reader' }, performed_via_github_app: { id: 15368 },
};

describe('actual deployment ledger', () => {
  it('uses only the newest managed actual success, not an environment job success', async () => {
    const api = vi.fn(async (path: string) => path.includes('/statuses')
      ? [{ state: 'success' }] : [release]);
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
    const api = vi.fn(async (path: string) => path.includes('/statuses') ? [{ state: 'success' }] : [release]);
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
    await expect(deployedBase(vi.fn(async () => [{ ...release, performed_via_github_app: null }]), 'reader')).rejects.toThrow();
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
    GITHUB_SHA: sha,
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
      aliasAssigned: true, aliasError: null, meta: { scorearcCommitSha: sha },
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
        aliasAssigned: true, aliasError: null, meta: { scorearcCommitSha: sha },
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
        aliasAssigned: attempts === 3, aliasError: null, meta: { scorearcCommitSha: sha },
      }));
    });
    await expect(confirmVercelPublication(env, 'https://test.vercel.app', fetcher, pause)).resolves.toBeUndefined();
    expect(pause).toHaveBeenCalledTimes(2);
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
