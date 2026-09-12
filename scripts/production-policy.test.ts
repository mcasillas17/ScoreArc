import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const production = ci.split('\n  production:\n')[1];

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
  it('binds ordinary CI matrix jobs to isolated environments and non-replacing service queues', () => {
    const workflow = production;
    expect(existsSync('.github/workflows/deploy-production.yml')).toBe(false);
    expect(workflow).not.toMatch(/^\s+uses: \.\/\.github\/workflows\//m);
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('needs: test');
    expect(workflow).toContain("needs.test.result == 'success'");
    expect(workflow).toContain("github.repository == 'mcasillas17/ScoreArc'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("(github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
    expect(workflow).toContain('service: [reader, ingester, frontend]');
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('group: deploy-${{ matrix.service }}');
    expect(workflow).toContain('queue: max');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('name: production-${{ matrix.service }}');
    expect(workflow).toContain('deployment: false');
    expect(workflow).toContain('RELEASE_SERVICE: ${{ matrix.service }}');
    expect(workflow).toContain("RELEASE_SELECTION: ${{ inputs.release || 'changed' }}");
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(/secrets:|inherit|continue-on-error|inputs\.service|ref: (main|\$\{\{.*head)/);
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
    const workflow = production;
    const flyStep = workflow.split(/^      - /m).find(block => block.includes('id: fly\n'));
    expect(flyStep).toBeDefined();
    expect(flyStep?.split('\n').map(line => line.trim()).filter(line => line.startsWith('flyctl deploy '))).toEqual([
      'flyctl deploy backend --config reader/fly.toml --dockerfile reader/Dockerfile --remote-only',
      'flyctl deploy backend --config ingester/fly.toml --dockerfile ingester/Dockerfile --remote-only --ha=false',
    ]);
  });
  it('selects only the matching provider credential and keeps secrets out of command arguments and outputs', () => {
    const fly = "${{ matrix.service == 'reader' && secrets.FLY_API_TOKEN_READER || matrix.service == 'ingester' && secrets.FLY_API_TOKEN_INGESTER || '' }}";
    const vercel = "${{ matrix.service == 'frontend' && secrets.VERCEL_TOKEN || '' }}";
    const secretLines = production.split('\n').filter(line => line.includes('secrets.'));
    expect(secretLines.length).toBeGreaterThan(0);
    for (const line of secretLines) {
      expect([`FLY_API_TOKEN: ${fly}`, `VERCEL_TOKEN: ${vercel}`]).toContain(line.trim());
    }
    for (const name of ['VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
      const lines = production.split('\n').filter(line => line.includes(`vars.${name}`));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.trim()).toBe(
        `${name}: \${{ matrix.service == 'frontend' && vars.${name} || '' }}`,
      );
    }
    expect(production).not.toMatch(/--token|echo.*TOKEN|TOKEN.*GITHUB_(OUTPUT|ENV)|actions\/upload-artifact/);
  });
  it('retains preparation, credential failure, ledger, revalidation and staged promotion in order', () => {
    const steps = production.split(/^      - /m);
    const indexOf = (text: string) => steps.findIndex(step => step.includes(text));
    const sequence = [
      'production-release.mjs prepare', 'name: Require deployment credentials',
      'production-release.mjs begin', 'id: precheck', 'id: fly',
      'id: stage', 'id: promote_gate', 'id: promote\n', 'production-release.mjs finish',
    ].map(indexOf);
    expect(sequence.every(index => index >= 0)).toBe(true);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    expect(steps[indexOf('id: stage')]).toContain('vercel deploy --yes --prod --skip-domain');
    expect(steps[indexOf('id: stage')]).toContain('steps.precheck.outputs.current');
    expect(steps[indexOf('id: promote_gate')]).toContain("steps.stage.outcome == 'success'");
    expect(steps[indexOf('id: promote_gate')]).toContain('production-release.mjs assert');
    expect(steps[indexOf('id: promote\n')]).toContain('steps.promote_gate.outputs.current');
    expect(steps[indexOf('id: promote\n')]).toContain('--yes --timeout 10m');
    expect(steps[indexOf('id: promote\n')]).toContain('production-release.mjs confirm-vercel');
    expect(steps[indexOf('production-release.mjs finish')]).toContain("always() && steps.begin.outputs.id != ''");
  });
  it.each(['reader', 'ingester', 'frontend'])('fails %s explicitly before publication when required credentials are absent', service => {
    const step = production.split(/^      - /m).find(block => block.startsWith('name: Require deployment credentials\n'));
    expect(step).toBeDefined();
    expect(step).toContain("if: steps.plan.outputs.deploy == 'true'");
    const shell = step!.split('run: |\n')[1].split('\n').map(line => line.trimStart()).join('\n');
    const values: NodeJS.ProcessEnv = {
      NODE_ENV: 'test', RELEASE_SERVICE: service, FLY_API_TOKEN: 'synthetic-fly',
      VERCEL_TOKEN: 'synthetic-vercel', VERCEL_ORG_ID: 'synthetic-org', VERCEL_PROJECT_ID: 'synthetic-project',
    };
    expect(spawnSync('/bin/bash', ['-e', '-c', shell], { env: values }).status).toBe(0);
    for (const key of service === 'frontend'
      ? ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'] : ['FLY_API_TOKEN']) {
      const result = spawnSync('/bin/bash', ['-e', '-c', shell], {
        env: { ...values, [key]: '' }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('no deployment occurred');
      expect(result.stdout + result.stderr).not.toContain('synthetic-');
    }
  });
  it('turns off Vercel Git production deployment, not preview builds', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(config.git.deploymentEnabled).toEqual({ main: false });
    expect(config.ignoreCommand).toBe('node scripts/production-preview.mjs');
  });
});
