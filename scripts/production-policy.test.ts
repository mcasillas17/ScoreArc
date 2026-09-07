import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertReleaseContext, assertVercelProject, planRelease, releaseStatus } from './production-policy.mjs';

const sha = 'a'.repeat(40);
const older = 'b'.repeat(40);
const context = {
  repository: 'mcasillas17/ScoreArc', eventName: 'push', ref: 'refs/heads/main',
  sha, workflowRef: 'mcasillas17/ScoreArc/.github/workflows/ci.yml@refs/heads/main',
  runId: 42, runAttempt: 1,
};
const run = {
  id: 42, run_attempt: 1, event: 'push', head_branch: 'main', head_sha: sha,
  path: '.github/workflows/ci.yml', status: 'in_progress', conclusion: null,
  repository: { full_name: context.repository },
  head_repository: { full_name: context.repository },
};
const testJob = {
  name: 'test', run_id: 42, run_attempt: 1, head_sha: sha,
  status: 'completed', conclusion: 'success',
};
const plan = {
  service: 'reader', sha, mainSha: sha, baseSha: older,
  paths: ['backend/reader/main.go'], manual: 'changed',
};

describe('production eligibility', () => {
  it.each([
    { check: 'contextRepository', candidate: { ...context, repository: 'UNTRUSTED_VALUE_DO_NOT_LOG' }, metadata: run },
    { check: 'contextRef', candidate: { ...context, ref: 'UNTRUSTED_VALUE_DO_NOT_LOG' }, metadata: run },
    { check: 'contextEvent', candidate: { ...context, eventName: 'pull_request' }, metadata: { ...run, event: 'pull_request' } },
    { check: 'workflowRef', candidate: { ...context, workflowRef: 'UNTRUSTED_VALUE_DO_NOT_LOG' }, metadata: run },
    { check: 'runRepository', candidate: context, metadata: { ...run, repository: { full_name: 'UNTRUSTED_VALUE_DO_NOT_LOG' } } },
    { check: 'headRepository', candidate: context, metadata: { ...run, head_repository: { full_name: 'UNTRUSTED_VALUE_DO_NOT_LOG' } } },
    { check: 'runId', candidate: context, metadata: { ...run, id: 43 } },
    { check: 'runAttempt', candidate: context, metadata: { ...run, run_attempt: 2 } },
    { check: 'runEvent', candidate: context, metadata: { ...run, event: 'UNTRUSTED_VALUE_DO_NOT_LOG' } },
    { check: 'runBranch', candidate: context, metadata: { ...run, head_branch: 'UNTRUSTED_VALUE_DO_NOT_LOG' } },
    { check: 'runSha', candidate: context, metadata: { ...run, head_sha: older } },
    { check: 'runWorkflow', candidate: context, metadata: { ...run, path: 'UNTRUSTED_VALUE_DO_NOT_LOG' } },
    { check: 'runStatus', candidate: context, metadata: { ...run, status: 'queued' } },
    { check: 'runConclusion', candidate: context, metadata: { ...run, conclusion: 'cancelled' } },
  ])('identifies $check rejection using only a constant label', ({ check, candidate, metadata }) => {
    expect(() => assertReleaseContext(candidate, metadata, [testJob])).toThrowError(new Error(
      `Release requires this repository's active main CI run and exact tested SHA; failed checks: ${check}`,
    ));
  });
  it.each(['queued', 'waiting', 'pending', 'requested', 'completed'])('still rejects %s run state with a successful exact-SHA test', status => {
    expect(() => assertReleaseContext(context, { ...run, status }, [testJob])).toThrowError(new Error(
      "Release requires this repository's active main CI run and exact tested SHA; failed checks: runStatus",
    ));
  });
  it('reports every failed check without accepting a cancelled, wrong-attempt or wrong-SHA run', () => {
    expect(() => assertReleaseContext(context, {
      ...run, run_attempt: 2, head_sha: older, status: 'completed', conclusion: 'cancelled',
    }, [testJob])).toThrowError(new Error(
      "Release requires this repository's active main CI run and exact tested SHA; failed checks: runAttempt, runSha, runStatus, runConclusion",
    ));
  });
  it('binds successful CI to this exact main SHA and run attempt', () => {
    expect(() => assertReleaseContext(context, run, [testJob])).not.toThrow();
    expect(() => assertReleaseContext(context, { ...run, head_sha: older }, [testJob])).toThrow();
    expect(() => assertReleaseContext(context, run, [{ ...testJob, head_sha: older }])).toThrow();
    expect(() => assertReleaseContext(context, run, [{ ...testJob, run_attempt: 2 }])).toThrow();
  });
  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', null])('rejects %s test conclusions', conclusion => {
    expect(() => assertReleaseContext(context, run, [{ ...testJob, conclusion }])).toThrow();
  });
  it('rejects missing, duplicate and unfinished test jobs', () => {
    for (const jobs of [[], [testJob, testJob], [{ ...testJob, status: 'in_progress' }]]) {
      expect(() => assertReleaseContext(context, run, jobs)).toThrow();
    }
  });
  it('rejects PRs, forks, feature branches and other callers', () => {
    for (const change of [
      { repository: 'attacker/ScoreArc' }, { eventName: 'pull_request' },
      { eventName: 'workflow_run' }, { ref: 'refs/heads/feature' },
      { workflowRef: 'mcasillas17/ScoreArc/.github/workflows/other.yml@refs/heads/main' },
    ]) expect(() => assertReleaseContext({ ...context, ...change }, run, [testJob])).toThrow();
    for (const change of [
      { head_repository: { full_name: 'attacker/ScoreArc' } },
      { repository: { full_name: 'attacker/ScoreArc' } },
      { event: 'pull_request' }, { head_branch: 'feature' },
      { path: '.github/workflows/other.yml' }, { conclusion: 'cancelled' },
    ]) expect(() => assertReleaseContext(context, { ...run, ...change }, [testJob])).toThrow();
  });
  it('allows main dispatch only after its own successful CI', () => {
    const manualContext = { ...context, eventName: 'workflow_dispatch' };
    const manualRun = { ...run, event: 'workflow_dispatch' };
    expect(() => assertReleaseContext(manualContext, manualRun, [testJob])).not.toThrow();
    expect(() => assertReleaseContext(manualContext, manualRun, [])).toThrow();
  });
});

describe('release selection', () => {
  it('does not wedge later releases for a superseded or failed inert staged build', () => {
    expect(releaseStatus({ precheckCurrent: 'false' })).toBe('inactive');
    expect(releaseStatus({ stage: 'success', promoteCurrent: 'false', promote: 'skipped' })).toBe('inactive');
    expect(releaseStatus({ stage: 'failure', promote: 'skipped' })).toBe('inactive');
    expect(releaseStatus({ stage: 'success', promoteCurrent: 'true', promote: 'failure' })).toBe('failure');
    expect(releaseStatus({ promote: 'cancelled' })).toBe('failure');
    expect(releaseStatus({ fly: 'success' })).toBe('success');
    expect(releaseStatus({ fly: 'skipped', stage: 'skipped', promote: 'skipped' })).toBe('inactive');
    expect(releaseStatus({ fly: 'skipped', stage: 'success', promote: 'skipped' })).toBe('inactive');
    expect(releaseStatus({ fly: 'skipped', stage: 'cancelled', promote: 'skipped' })).toBe('failure');
    expect(releaseStatus({ fly: 'failure', stage: 'skipped', promote: 'skipped' })).toBe('failure');
    expect(releaseStatus({})).toBe('failure');
  });
  it('skips old CI without substituting the newer main SHA', () => {
    expect(planRelease({ ...plan, mainSha: older })).toEqual({
      deploy: false, reason: 'stale-main', sha,
    });
  });
  it.each([
    ['backend/reader/main.go', [true, false, false]],
    ['backend/ingester/main.go', [false, true, false]],
    ['backend/shared/model/types.go', [true, true, false]],
    ['backend/config/competitions.json', [true, true, false]],
    ['backend/go.mod', [true, true, false]],
    ['backend/go.sum', [true, true, false]],
    ['backend/.dockerignore', [true, true, false]],
    ['backend/migrations/0022_team_colours.up.sql', [true, true, false]],
    ['.github/workflows/ci.yml', [true, true, true]],
    ['.github/workflows/deploy-production.yml', [true, true, true]],
    ['scripts/production-policy.mjs', [true, true, true]],
    ['src/app/page.tsx', [false, false, true]],
    ['package-lock.json', [false, false, true]],
    ['vercel.json', [false, false, true]],
    ['docs/backend/SETUP.md', [false, false, false]],
    ['README.md', [false, false, false]],
    ['backend/reader/README.md', [false, false, false]],
    ['infra/README.md', [false, false, false]],
  ])('%s selects intended services', (path, expected) => {
    expect(['reader', 'ingester', 'frontend'].map(service =>
      planRelease({ ...plan, service, paths: [path] }).deploy)).toEqual(expected);
  });
  it('includes cumulative service changes even when the newest commit is docs-only', () => {
    expect(planRelease({ ...plan, paths: ['backend/reader/main.go', 'docs/CURRENT_STATE.md'] }).deploy).toBe(true);
  });
  it('does not treat a missing/uncertain deployed baseline as a path skip', () => {
    expect(planRelease({ ...plan, baseSha: null, paths: [] }).deploy).toBe(true);
  });
  it('skips identical already-deployed content unless explicitly dispatched', () => {
    expect(planRelease({ ...plan, baseSha: sha, paths: [] }).deploy).toBe(false);
    expect(planRelease({ ...plan, baseSha: sha, paths: [], manual: 'reader' }).deploy).toBe(true);
    expect(planRelease({ ...plan, manual: 'frontend' }).deploy).toBe(false);
  });
  it('rejects arbitrary rollback SHAs and unknown manual modes', () => {
    expect(() => planRelease({ ...plan, manual: older })).toThrow();
    expect(() => planRelease({ ...plan, service: 'unknown' })).toThrow();
  });
});

describe('Vercel publication gate', () => {
  const project = {
    id: 'prj_test', accountId: 'team_test', autoAssignCustomDomains: false,
    link: { type: 'github', org: 'mcasillas17', repo: 'ScoreArc', productionBranch: 'main', deployHooks: [] },
  };
  it('requires live auto-publication disabled and the exact project', () => {
    expect(() => assertVercelProject(project, 'prj_test', 'team_test')).not.toThrow();
    expect(() => assertVercelProject({ ...project, autoAssignCustomDomains: true }, 'prj_test', 'team_test')).toThrow();
    expect(() => assertVercelProject(project, 'prj_other', 'team_test')).toThrow();
    expect(() => assertVercelProject({ ...project, link: { ...project.link, deployHooks: [{}] } }, 'prj_test', 'team_test')).toThrow();
  });
});

describe('workflow wiring', () => {
  it('retains the required test name and gates every production caller on its success', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('  test:');
    expect(ci).not.toMatch(/  test:\n\s+if:/);
    expect(ci).not.toContain('branches-ignore');
    expect(ci).toContain('needs: test');
    expect(ci).toContain("needs.test.result == 'success'");
    expect(ci).toContain("github.ref == 'refs/heads/main'");
    for (const command of ['npm test', 'npx tsc --noEmit', 'npm run lint', 'npm run build', 'go test -race ./...', 'go vet ./...', 'Verify database migration rollback']) {
      expect(ci).toContain(command);
    }
  });
  it('removes independently triggerable Fly workflows', () => {
    expect(existsSync('.github/workflows/deploy-reader.yml')).toBe(false);
    expect(existsSync('.github/workflows/deploy-ingester.yml')).toBe(false);
  });
  it('uses only same-commit CI calls, immutable actions, and non-replacing production queues', () => {
    const workflow = readFileSync('.github/workflows/deploy-production.yml', 'utf8');
    expect(workflow).toContain('  workflow_call:');
    expect(workflow).not.toMatch(/^\s+(push|workflow_run|workflow_dispatch|pull_request):/m);
    expect(workflow).toContain('queue: max');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('name: production-${{ inputs.service }}');
    expect(workflow).toContain('deployment: false');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).not.toMatch(/^    env:\n      GH_TOKEN:/m);
    expect(workflow).toContain('id: promote_gate');
    for (const id of ['fly', 'stage', 'promote']) {
      const step = workflow.split(/^      - /m).find(block => block.includes(`id: ${id}\n`));
      expect(step).toBeDefined();
      expect(step).not.toContain('GH_TOKEN:');
    }
    for (const action of workflow.matchAll(/uses: ([\w/-]+)@([^\s]+)/g)) {
      expect(action[2]).toMatch(/^[a-f0-9]{40}$/);
    }
  });
  it('preserves Fly build contexts and singleton ingester deployment', () => {
    const workflow = readFileSync('.github/workflows/deploy-production.yml', 'utf8');
    const flyStep = workflow.split(/^      - /m).find(block => block.includes('id: fly\n'));
    expect(flyStep).toBeDefined();
    expect(flyStep?.split('\n').map(line => line.trim()).filter(line => line.startsWith('flyctl deploy '))).toEqual([
      'flyctl deploy backend --config reader/fly.toml --dockerfile reader/Dockerfile --remote-only',
      'flyctl deploy backend --config ingester/fly.toml --dockerfile ingester/Dockerfile --remote-only --ha=false',
    ]);
  });
  it('turns off Vercel Git production deployment, not preview builds', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(config.git.deploymentEnabled).toEqual({ main: false });
    expect(config.ignoreCommand).toBe('node scripts/production-preview.mjs');
  });
});
